import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

import { CHALLENGE_TAG, type Config, type PaidEndpoint } from "./config.js";
import {
  AssetNotFoundError,
  Engine,
  HISTORY_MIN_HOURS,
  SectorNotFoundError,
  type MarketView,
  type Result,
} from "./discover.js";
import { ENDPOINTS, ParamError, paramSchema, parseParams, type Endpoint, type Parsed } from "./endpoints.js";
import type { Snapshot } from "./market.js";
import { DISCOVERY_TAGS, SERVICE_NAME } from "./x402.js";

const DISCLAIMER = "Market data for information only, not financial advice.";

export interface AppMarket extends MarketView {
  ready(): boolean;
  snapshot(): Snapshot;
}

export interface AppOptions {
  config: Config;
  market: AppMarket;
  /** x402 payment middleware; omitted when payments are disabled (local dev). */
  payment?: MiddlewareHandler;
  now?: () => number;
  version?: string;
}

class ApiError extends Error {
  constructor(
    readonly status: 400 | 404 | 500 | 503,
    readonly code: string,
    message: string,
    readonly nextStep: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

export function createApp(opts: AppOptions): Hono {
  const { config: cfg, market } = opts;
  const now = opts.now ?? Date.now;
  const engine = new Engine(market, now);
  const started = now();
  let requests = 0;
  const app = new Hono();

  app.use("*", async (c, next) => {
    requests++;
    await next();
  });
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "OPTIONS"],
      allowHeaders: ["PAYMENT-SIGNATURE", "X-PAYMENT", "Content-Type", "Accept"],
      exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE", "Retry-After"],
      maxAge: 86400,
    }),
  );

  // ---- free routes ----
  app.get("/", (c) => c.html(docsPage(cfg, opts.payment !== undefined, opts.version ?? "dev")));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/v1/status", (c) => status(c));
  app.get("/v1/openapi.json", (c) => c.json(openApi(cfg, opts.version ?? "dev")));
  app.get("/.well-known/x402", (c) => c.json(x402Manifest(cfg)));
  app.get("/llms.txt", (c) => c.text(llmsTxt(cfg)));

  // ---- paid routes: every unpaid call gets 402 from the x402 middleware ----
  if (opts.payment) app.use("/v1/*", opts.payment);

  const handlers: Record<PaidEndpoint, (p: Parsed) => Result<unknown>> = {
    gems: (p) =>
      engine.gems({
        maxMarketCap: p.max_market_cap as number,
        minMarketCap: p.min_market_cap as number,
        minVolume: p.min_volume as number,
        listedWithinDays: p.listed_within_days as number,
        sector: (p.sector as string) ?? "",
        includePumped: p.include_pumped as boolean,
        limit: p.limit as number,
      }),
    screen: (p) => {
      if (p.max_market_cap !== undefined && p.min_market_cap !== undefined && (p.max_market_cap as number) > 0 && (p.max_market_cap as number) < (p.min_market_cap as number)) {
        throw new ParamError("max_market_cap", "max_market_cap is below min_market_cap.");
      }
      const tags = ((p.tag as string) ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      if (tags.length > 10) throw new ParamError("tag", "tag takes at most 10 tags.");
      const sort = p.sort as Parameters<Engine["screen"]>[0]["sort"];
      return engine.screen({
        minMarketCap: p.min_market_cap as number | undefined,
        maxMarketCap: p.max_market_cap as number,
        minVolume: p.min_volume as number | undefined,
        maxVolume: p.max_volume as number | undefined,
        minTurnover: p.min_turnover as number | undefined,
        minChange1h: p.min_change_1h_pct as number | undefined,
        maxChange1h: p.max_change_1h_pct as number | undefined,
        minChange24h: p.min_change_24h_pct as number | undefined,
        maxChange24h: p.max_change_24h_pct as number | undefined,
        minChange7d: p.min_change_7d_pct as number | undefined,
        maxChange7d: p.max_change_7d_pct as number | undefined,
        tags,
        listedWithinDays: p.listed_within_days as number,
        excludeStablecoins: p.exclude_stablecoins as boolean,
        sort,
        order: ((p.order as string) || (sort === "rank" ? "asc" : "desc")) as "asc" | "desc",
        limit: p.limit as number,
      });
    },
    climbers: (p) => {
      const h = market.historyHours();
      if (h < HISTORY_MIN_HOURS) {
        const wait = HISTORY_MIN_HOURS - h;
        throw new ApiError(503, "insufficient_history",
          `Rank climbers compare today's CMC rank with the rank 24 h ago; the service has ${h} h of history so far.`,
          `Retry in about ${wait} h (GET /v1/status shows climbers_available). You have not been charged.`,
          { retry_after_seconds: wait * 3600 });
      }
      return engine.climbers({
        down: p.direction === "down",
        minVolume: p.min_volume as number,
        maxMarketCap: p.max_market_cap as number,
        limit: p.limit as number,
      });
    },
    sectors: (p) =>
      p.sector
        ? engine.sectorDetail(p.sector as string, p.limit as number)
        : engine.sectorList({ sort: p.sort as "heat", minMembers: p.min_members as number, limit: p.limit as number }),
    asset: (p) => engine.asset(p.asset as string),
    digest: (p) => engine.digest({ gems: p.gems as number, climbers: p.climbers as number, sectors: p.sectors as number }),
  };

  for (const ep of ENDPOINTS) {
    app.get(ep.path, (c) => {
      try {
        const params = parseParams(ep, new URL(c.req.url).searchParams);
        requireFreshData();
        const res = handlers[ep.name](params);
        return envelope(c, res);
      } catch (err) {
        return errorResponse(c, err, ep);
      }
    });
  }

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "No endpoint at this path.", next_step: `Use one of ${ENDPOINTS.map((e) => e.path).join(", ")}; GET /v1/openapi.json describes them all.` } }, 404),
  );
  app.onError((err, c) => {
    console.error(JSON.stringify({ level: "error", msg: "unhandled", err: String(err) }));
    return c.json({ error: { code: "internal_error", message: "The server hit an unexpected error.", next_step: "Retry the request; you have not been charged." } }, 500);
  });

  /** Paid answers need loaded, fresh data; failures are 503 and never settled. */
  function requireFreshData() {
    if (!market.ready()) {
      throw new ApiError(503, "upstream_unavailable", "Market data is not loaded yet: the first CoinMarketCap poll has not finished.",
        "Retry in 30 seconds. You have not been charged.", { retry_after_seconds: 30 });
    }
    const age = now() - market.snapshot().oldestFetch();
    if (age > cfg.maxStaleMs) {
      throw new ApiError(503, "upstream_unavailable", `CoinMarketCap data has not refreshed for ${Math.round(age / 1000)} s.`,
        "Retry in 60 seconds. You have not been charged.", { retry_after_seconds: 60 });
    }
  }

  function envelope(c: Context, res: Result<unknown>) {
    const age = Math.max(0, Math.floor((now() - res.asOf) / 1000));
    const warnings = [...res.warnings];
    if (age * 1000 > cfg.staleAfterMs) {
      warnings.push({ code: "stale_data", message: `Data is ${age} s old, past the ${Math.round(cfg.staleAfterMs / 1000)} s freshness limit.` });
    }
    return c.json({
      as_of: iso(res.asOf),
      age_seconds: age,
      source: "coinmarketcap",
      note: DISCLAIMER,
      ...(res.historyHours !== undefined ? { history_hours: res.historyHours } : {}),
      data: res.data,
      ...(warnings.length ? { warnings } : {}),
    }, 200, { "Cache-Control": "no-store" });
  }

  function errorResponse(c: Context, err: unknown, ep: Endpoint) {
    let e: ApiError;
    if (err instanceof ApiError) e = err;
    else if (err instanceof ParamError) {
      e = new ApiError(400, "invalid_parameter", err.message, `Fix ${err.param} and retry; GET /v1/openapi.json lists every parameter. You have not been charged.`,
        { param: err.param, ...(err.allowed ? { allowed_values: err.allowed } : {}) });
    } else if (err instanceof AssetNotFoundError) {
      e = new ApiError(404, "asset_not_found", `No tracked coin matches "${err.query.slice(0, 60)}".`,
        "Retry with a CMC id, symbol, slug or name from suggestions; only coins in the tracked top N are covered. You have not been charged.",
        { param: "asset", suggestions: err.suggestions });
    } else if (err instanceof SectorNotFoundError) {
      e = new ApiError(404, "sector_not_found", `Sector "${err.tag.slice(0, 60)}" is not tracked.`,
        `Retry with a tracked sector, e.g. one of the hottest now: ${err.hottest.join(", ")}. You have not been charged.`, { param: "sector" });
    } else {
      console.error(JSON.stringify({ level: "error", msg: "handler failed", path: ep.path, err: String(err) }));
      e = new ApiError(500, "internal_error", "The server hit an unexpected error.", "Retry the request; you have not been charged.");
    }
    const retry = e.extra.retry_after_seconds;
    if (typeof retry === "number") c.header("Retry-After", String(retry));
    c.header("Cache-Control", "no-store");
    return c.json({ error: { code: e.code, message: e.message, next_step: e.nextStep, ...e.extra } }, e.status);
  }

  function status(c: Context) {
    const st = market.status();
    const ready = market.ready();
    const age = ready ? Math.floor((now() - market.snapshot().oldestFetch()) / 1000) : null;
    let state = "ok";
    let code: 200 | 503 = 200;
    if (!ready) [state, code] = ["starting", 503];
    else if (age! * 1000 > cfg.maxStaleMs) [state, code] = ["down", 503];
    else if (age! * 1000 > cfg.staleAfterMs) state = "degraded";
    return c.json({
      status: state,
      service: SERVICE_NAME,
      version: opts.version ?? "dev",
      preset: cfg.preset,
      uptime_seconds: Math.floor((now() - started) / 1000),
      last_poll_at: st.lastPollAt ? iso(st.lastPollAt) : null,
      last_success_at: st.lastSuccessAt ? iso(st.lastSuccessAt) : null,
      last_error: st.lastError,
      data_age_seconds: age,
      cache_size: st.cacheSize,
      top_n: st.topN,
      poll_interval_seconds: Math.round(st.pollIntervalMs / 1000),
      history_assets: st.historyAssets,
      history_hours: st.historyHours,
      climbers_available: st.historyHours >= HISTORY_MIN_HOURS,
      credits_used_today: st.creditsUsedToday,
      credits_used_month: st.creditsUsedMonth,
      credit_limit_monthly: st.creditLimitMonthly,
      projected_credits_per_day: st.projectedCreditsPerDay,
      upstream_calls: st.upstreamCalls,
      upstream_errors: st.upstreamErrors,
      requests_total: requests,
      payments: {
        enabled: opts.payment !== undefined,
        network: cfg.x402.network,
        network_name: `Algorand ${cfg.x402.networkName}`,
        asset: `USDC (ASA ${cfg.x402.usdcAssetId})`,
        pay_to: cfg.x402.payTo,
        facilitator: cfg.x402.facilitatorUrl,
        tag: CHALLENGE_TAG,
      },
      prices: Object.fromEntries(ENDPOINTS.map((e) => [e.path, cfg.x402.prices[e.name]])),
    }, code, { "Cache-Control": "no-store" });
  }

  return app;
}

function x402Manifest(cfg: Config) {
  const base = cfg.publicUrl;
  return {
    name: SERVICE_NAME,
    description: "Pay-per-call altcoin discovery: find small caps with 100x potential before they move.",
    x402Version: 2,
    network: cfg.x402.network,
    asset: cfg.x402.usdcAssetId,
    payTo: cfg.x402.payTo,
    facilitator: cfg.x402.facilitatorUrl,
    tags: [...DISCOVERY_TAGS, CHALLENGE_TAG],
    resources: ENDPOINTS.map((e) => ({
      resource: `${base}${e.path}`,
      method: "GET",
      price: cfg.x402.prices[e.name],
      description: e.description,
      example: e.exampleInput,
    })),
  };
}

function llmsTxt(cfg: Config) {
  const lines = [
    `# ${SERVICE_NAME}`,
    "",
    "> Pay-per-call altcoin discovery for AI agents on Algorand x402. Finds small-cap coins with 100x potential before they move, scored on turnover, rank climb, listing age and sector heat from CoinMarketCap data.",
    "",
    `Payment: x402 v2, exact scheme, USDC (ASA ${cfg.x402.usdcAssetId}) on ${cfg.x402.network}. Unpaid calls return 402 with a PAYMENT-REQUIRED header. Errors are never charged.`,
    "",
    "## Endpoints",
    ...ENDPOINTS.map((e) => `- GET ${cfg.publicUrl}${e.path} (${cfg.x402.prices[e.name]}): ${e.description}`),
    `- GET ${cfg.publicUrl}/v1/status (free): health, data freshness and prices`,
    `- GET ${cfg.publicUrl}/v1/openapi.json (free): full parameter reference`,
  ];
  return lines.join("\n") + "\n";
}

function openApi(cfg: Config, version: string) {
  const errRef = (d: string) => ({ description: d, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
  const paths: Record<string, unknown> = {};
  for (const ep of ENDPOINTS) {
    const price = cfg.x402.prices[ep.name];
    paths[ep.path] = {
      get: {
        operationId: ep.name,
        summary: ep.description,
        description: `${ep.description} Costs ${price} in USDC on Algorand per call via x402. Errors are never charged.`,
        "x-payment": { protocol: "x402", x402Version: 2, scheme: "exact", price, network: cfg.x402.network, asset: cfg.x402.usdcAssetId },
        parameters: ep.params.map((p) => ({ name: p.name, in: "query", required: !!p.required, description: p.description, schema: paramSchema(p), ...(p.example !== undefined ? { example: p.example } : {}) })),
        responses: {
          200: { description: "Success; the PAYMENT-RESPONSE header carries the settlement receipt.", content: { "application/json": { example: ep.exampleOutput } } },
          400: errRef("Invalid or unknown parameter. Not charged."),
          402: { description: "Payment required. The base64 PAYMENT-REQUIRED header lists the USDC amount, asset, network and payTo." },
          404: errRef("Coin or sector not found. Not charged."),
          503: errRef("Data not ready, stale, or not enough history for climbers. Not charged."),
        },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: {
      title: SERVICE_NAME,
      version,
      description: "Pay-per-call altcoin discovery for AI agents on Algorand x402. Market data for information only, not financial advice.",
    },
    ...(cfg.publicUrl ? { servers: [{ url: cfg.publicUrl }] } : {}),
    paths,
    components: {
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "next_step"],
              properties: { code: { type: "string" }, message: { type: "string" }, next_step: { type: "string" } },
            },
          },
        },
      },
    },
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function docsPage(cfg: Config, paid: boolean, version: string) {
  const base = cfg.publicUrl || "https://your-host";
  const rows = ENDPOINTS.map((e) =>
    `<tr><td><code>GET ${esc(e.path)}</code></td><td class="price">${esc(cfg.x402.prices[e.name])}${paid ? "" : " (off)"}</td><td class="muted">${esc(e.telegram)}</td><td>${esc(e.description)}</td></tr>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>100xAltcoin</title>
<style>
:root { --bg:#fbfbf9; --fg:#1d1d1b; --muted:#6b6b66; --line:#e3e2dc; --card:#fff; --accent:#0b6b4f; --code:#f1f0ea; }
@media (prefers-color-scheme: dark) { :root { --bg:#121311; --fg:#ecebe6; --muted:#9a9a93; --line:#2a2b28; --card:#1a1b19; --accent:#4fc79c; --code:#20211f; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width: 940px; margin: 0 auto; padding: 40px 16px 64px; }
h1 { font-size: 2rem; margin: 0 0 4px; letter-spacing: -0.02em; }
h2 { font-size: 1.15rem; margin: 36px 0 12px; }
p.lead { color: var(--muted); margin: 0 0 24px; max-width: 72ch; }
.wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 0.94rem; }
th { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
tr:last-child td { border-bottom: 0; }
td.price { color: var(--accent); font-weight: 600; white-space: nowrap; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.86rem; }
code { background: var(--code); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--code); padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
.muted { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>100xAltcoin</h1>
<p class="lead">Pay-per-call altcoin discovery for AI agents. Every call scores the CoinMarketCap top ${cfg.topN} on turnover, rank climb, listing age and sector heat to surface small caps before they move. Paid per call in USDC on Algorand ${esc(cfg.x402.networkName)} with x402: no API key, no signup.</p>
<h2>Endpoints</h2>
<div class="wrap"><table>
<thead><tr><th>Endpoint</th><th>Price</th><th>Telegram equivalent</th><th>Returns</th></tr></thead>
<tbody>
${rows}
<tr><td><code>GET /v1/status</code></td><td class="price">free</td><td class="muted">/status</td><td>Health, data age, history depth, prices and payment settings.</td></tr>
<tr><td><code>GET /v1/openapi.json</code></td><td class="price">free</td><td></td><td>Every parameter, price and response.</td></tr>
</tbody></table></div>
<h2>How paying works</h2>
<p>Call a paid endpoint without payment and you get <code>402</code> with a base64 <code>PAYMENT-REQUIRED</code> header: the USDC amount (ASA ${esc(cfg.x402.usdcAssetId)}), network and recipient. Sign that USDC transfer and retry with <code>PAYMENT-SIGNATURE</code>; the GoPlausible facilitator verifies and settles it on Algorand. Only successful answers are settled, so errors are never charged.</p>
<pre>import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";

const signer = toClientAvmSigner(process.env.AVM_PRIVATE_KEY); // base64 64-byte key
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "algorand:*", client: new ExactAvmScheme(signer) }],
});
const res = await pay("${esc(base)}/v1/gems?limit=5");
console.log(await res.json());</pre>
<p class="muted">Or from this repo: <code>npm run pay -- ${esc(base)}/v1/gems</code> with <code>AVM_MNEMONIC</code> set.</p>
<p class="muted">Version ${esc(version)}. Market data for information only, not financial advice.</p>
</main>
</body>
</html>`;
}
