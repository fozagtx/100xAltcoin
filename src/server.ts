import "dotenv/config";
import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { CmcClient } from "./cmc.js";
import { CHALLENGE_TAG, loadConfig, projectedCreditsPerDay } from "./config.js";
import { loadHistory, saveHistory } from "./history-file.js";
import { Market } from "./market.js";
import { createPayments, type Payments } from "./x402.js";

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));

const cfg = loadConfig();
const version = process.env.npm_package_version ?? "dev";

const market = new Market(new CmcClient(cfg.cmcBaseUrl, cfg.cmcApiKey, cfg.cmcRpm), {
  topN: cfg.topN,
  fastN: cfg.fastN,
  pageSize: cfg.pageSize,
  pollIntervalMs: cfg.pollIntervalMs,
  slowIntervalMs: cfg.slowIntervalMs,
  projectedCreditsPerDay: projectedCreditsPerDay(cfg),
  log,
});

if (cfg.historyFile) {
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

const app = createApp({ config: cfg, market, payments, version });
market.start();
const saver = setInterval(() => void persist(), cfg.historySaveEveryMs);

const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  log("info", "100xAltcoin listening", {
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

async function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  clearInterval(saver);
  market.stop();
  server.close();
  await persist();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
