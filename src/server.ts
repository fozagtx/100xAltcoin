import "dotenv/config";
import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { CmcClient } from "./cmc.js";
import { CHALLENGE_TAG, creditWarning, loadConfig, projectedCreditsPerDay } from "./config.js";
import { cleanStaleTemps, loadHistory, saveHistory } from "./history-file.js";
import { Market } from "./market.js";
import { isOptedIn } from "./optin.js";
import { readVersion } from "./version.js";
import { createPayments, type Payments } from "./x402.js";

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));

const cfg = loadConfig();
const version = readVersion();

const market = new Market(new CmcClient(cfg.cmcBaseUrl, cfg.cmcApiKey, cfg.cmcRpm), {
  topN: cfg.topN,
  fastN: cfg.fastN,
  pageSize: cfg.pageSize,
  pollIntervalMs: cfg.pollIntervalMs,
  slowIntervalMs: cfg.slowIntervalMs,
  projectedCreditsPerDay: projectedCreditsPerDay(cfg),
  historyWindowMs: cfg.historyDays * 24 * 3_600_000,
  log,
});

if (cfg.historyFile) {
  const stale = await cleanStaleTemps(cfg.historyFile);
  if (stale) log("info", "removed leftover history temp files", { count: stale });
  try {
    const st = await loadHistory(cfg.historyFile);
    if (st) {
      market.seedHistory(st.history);
      if (Date.now() - st.publishedAt < 24 * 3_600_000) market.seed(st.quotes, st.publishedAt);
      log("info", "history restored", { path: cfg.historyFile, assets: Object.keys(st.history).length, history_hours: market.historyHours() });
    }
  } catch (err) {
    log("warn", "could not load history file; starting empty", { path: cfg.historyFile, error: String(err) });
  }
} else {
  log("warn", "HISTORY_FILE not set: history is memory-only, so /v1/climbers needs 24h after every restart");
}

async function persist() {
  if (!cfg.historyFile || !market.ready()) return;
  const snap = market.snapshot();
  try {
    await saveHistory(cfg.historyFile, { savedAt: Date.now(), publishedAt: snap.publishedAt, quotes: snap.byRank, history: market.exportHistory() });
  } catch (err) {
    log("warn", "saving history failed", { path: cfg.historyFile, error: String(err) });
  }
}

let payments: Payments | undefined;
if (cfg.x402.enabled) {
  payments = createPayments(cfg);
  // Reach GoPlausible now so the first paid request is fast; retry until it answers.
  const sync = async (attempt = 1): Promise<void> => {
    try {
      const network = await payments!.ready();
      log("info", "x402 facilitator synced", { facilitator: cfg.x402.facilitatorUrl, network, pay_to: cfg.x402.payTo });
    } catch (err) {
      const wait = Math.min(300, 5 * 2 ** Math.min(attempt, 6));
      log("warn", "x402 facilitator not reachable yet", { error: String(err), retry_in_seconds: wait });
      setTimeout(() => void sync(attempt + 1), wait * 1000).unref();
    }
  };
  void sync();
} else {
  log("warn", "X402_ENABLED=false: every paid endpoint is FREE; local development only");
}

const payToStatus: { optedIn: boolean | null } = { optedIn: null };
const app = createApp({ config: cfg, market, payments, payToStatus, version });
market.start();
const saver = setInterval(() => void persist(), cfg.historySaveEveryMs);
// Once CMC has told us the plan limit, say loudly if the chosen preset can't fit in it.
function checkCredits() {
  const st = market.status();
  const warning = creditWarning(st.projectedCreditsPerDay, st.creditLimitMonthly, cfg.preset);
  if (warning) log("warn", warning, { credit_limit_monthly: st.creditLimitMonthly, projected_credits_per_day: st.projectedCreditsPerDay });
}
const creditCheck = setInterval(checkCredits, 6 * 3_600_000);
setTimeout(checkCredits, 30_000).unref();

// A payout address that is not opted in to USDC earns nothing while everything looks healthy.
let optInTimer: NodeJS.Timeout | undefined;
async function checkOptIn() {
  payToStatus.optedIn = await isOptedIn(cfg.algodUrl, cfg.x402.payTo, cfg.x402.usdcAssetId);
  if (payToStatus.optedIn === false) {
    log("error", "PAY_TO_ADDRESS is not opted in to USDC: every payment will fail to settle until it is", {
      pay_to: cfg.x402.payTo,
      usdc_asa: cfg.x402.usdcAssetId,
      fix: `opt the account in to USDC (ASA ${cfg.x402.usdcAssetId}) in your wallet app`,
    });
  } else if (payToStatus.optedIn === true) {
    log("info", "PAY_TO_ADDRESS is opted in to USDC", { pay_to: cfg.x402.payTo });
    clearInterval(optInTimer);
  }
}
if (cfg.x402.enabled) {
  setTimeout(() => void checkOptIn(), 5_000).unref();
  optInTimer = setInterval(() => void checkOptIn(), 15 * 60_000);
  optInTimer.unref();
}

const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  log("info", "Alt402 listening", {
    port: info.port,
    network: cfg.x402.network,
    network_name: cfg.x402.networkName,
    usdc_asa: cfg.x402.usdcAssetId,
    pay_to: cfg.x402.payTo,
    facilitator: cfg.x402.facilitatorUrl,
    tag: CHALLENGE_TAG,
    public_url: cfg.publicUrl,
    preset: cfg.preset,
    top_n: cfg.topN,
    projected_credits_per_day: projectedCreditsPerDay(cfg),
  });
});

// Render proxies reuse connections for longer than Node's 5 s default keep-alive.
const httpServer = server as unknown as import("node:http").Server;
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutting down", { signal });
  clearInterval(saver);
  clearInterval(creditCheck);
  clearInterval(optInTimer);
  market.stop();
  // Stop accepting connections, but let in-flight requests finish: a paid request may be
  // waiting on the facilitator to settle, and cutting it off would charge the payer for nothing.
  const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
  httpServer.closeIdleConnections();
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 25_000).unref())]);
  await persist();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
