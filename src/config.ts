import { isValidAlgorandAddress, USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } from "@x402/avm";

// GoPlausible advertises the full genesis-hash CAIP-2 ids; the SDK's exported
// constants are truncated and are not accepted during /supported sync.
export const ALGORAND_MAINNET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=" as const;
export const ALGORAND_TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" as const;
export type AlgorandNetwork = typeof ALGORAND_MAINNET | typeof ALGORAND_TESTNET;

/** Required on every payment option for Global x402 Challenge attribution. */
export const CHALLENGE_TAG = "x402-global-challenge";
export const DEFAULT_FACILITATOR_URL = "https://facilitator.goplausible.xyz";

/** Paid endpoints and their default USD prices. */
export const PAID_ENDPOINTS = {
  gems: "$0.02",
  screen: "$0.01",
  climbers: "$0.01",
  sectors: "$0.01",
  asset: "$0.01",
  digest: "$0.03",
} as const;
export type PaidEndpoint = keyof typeof PAID_ENDPOINTS;

export interface Config {
  port: number;
  cmcApiKey: string;
  cmcBaseUrl: string;
  cmcRpm: number;
  preset: string;
  topN: number;
  fastN: number;
  pageSize: number;
  pollIntervalMs: number;
  slowIntervalMs: number;
  staleAfterMs: number;
  maxStaleMs: number;
  historyFile: string;
  historySaveEveryMs: number;
  publicUrl: string;
  x402: {
    enabled: boolean;
    networkName: "mainnet" | "testnet";
    network: AlgorandNetwork;
    usdcAssetId: string;
    payTo: string;
    facilitatorUrl: string;
    prices: Record<PaidEndpoint, string>;
  };
}

const presets: Record<string, { topN: number; fastN: number; poll: number; slow: number }> = {
  // free fits CMC's 10k-credit Basic plan (~190 credits/day).
  free: { topN: 1000, fastN: 200, poll: 15 * 60_000, slow: 60 * 60_000 },
  startup: { topN: 3000, fastN: 200, poll: 2 * 60_000, slow: 15 * 60_000 },
  standard: { topN: 5000, fastN: 500, poll: 60_000, slow: 10 * 60_000 },
};

export const DEFAULT_CMC_BASE_URL = "https://pro-api.coinmarketcap.com";

/** Projected daily CMC credit burn: one credit per 200 assets per listings call. */
export function projectedCreditsPerDay(c: Pick<Config, "topN" | "fastN" | "pollIntervalMs" | "slowIntervalMs">): number {
  const day = 86_400_000;
  const fast = Math.ceil(c.fastN / 200) * Math.floor(day / c.pollIntervalMs);
  const slow = Math.ceil((c.topN - c.fastN) / 200) * Math.floor(day / c.slowIntervalMs);
  return fast + slow;
}

/** Builds the config from environment variables; throws listing every problem. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const errs: string[] = [];
  const str = (name: string, def = "") => env[name]?.trim() || def;
  const int = (name: string, def: number, lo: number, hi: number) => {
    const v = str(name);
    if (!v) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      errs.push(`${name}=${JSON.stringify(v)}: want an integer in [${lo}, ${hi}]`);
      return def;
    }
    return n;
  };
  const dur = (name: string, def: number, minMs: number) => {
    const v = str(name);
    if (!v) return def;
    const ms = parseDuration(v);
    if (ms === null || ms < minMs) {
      errs.push(`${name}=${JSON.stringify(v)}: want a duration like 90s, 15m or 1h (at least ${minMs / 1000}s)`);
      return def;
    }
    return ms;
  };
  const bool = (name: string, def: boolean) => {
    const v = str(name).toLowerCase();
    if (!v) return def;
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
    errs.push(`${name}=${JSON.stringify(v)}: use true or false`);
    return def;
  };

  const presetName = str("PRESET", "startup").toLowerCase();
  let pr = presets[presetName];
  if (!pr) {
    errs.push(`PRESET=${JSON.stringify(presetName)}: want free, startup or standard`);
    pr = presets.startup;
  }
  const topN = int("TOP_N", pr.topN, 1, 10_000);
  const pollIntervalMs = dur("POLL_INTERVAL", pr.poll, 10_000);
  const slowIntervalMs = dur("SLOW_INTERVAL", pr.slow, 10_000);
  // Freshness is judged by when each page last came back from CMC, so the
  // limits follow the slow tier's schedule.
  const staleAfterMs = dur("STALE_AFTER", slowIntervalMs + 2 * pollIntervalMs, 1000);
  const maxStaleMs = dur("MAX_STALE", Math.max(3 * slowIntervalMs, 30 * 60_000), 1000);
  if (maxStaleMs < staleAfterMs) errs.push("MAX_STALE must be >= STALE_AFTER");

  const cmcBaseUrl = str("CMC_BASE_URL", DEFAULT_CMC_BASE_URL).replace(/\/+$/, "");
  const cmcApiKey = str("CMC_API_KEY");
  if (!cmcApiKey && cmcBaseUrl === DEFAULT_CMC_BASE_URL) {
    errs.push("CMC_API_KEY is required (or point CMC_BASE_URL at the fake CMC for local dev)");
  }

  const networkName = str("ALGORAND_NETWORK", "testnet").toLowerCase();
  if (networkName !== "mainnet" && networkName !== "testnet") {
    errs.push(`ALGORAND_NETWORK=${JSON.stringify(networkName)}: want mainnet or testnet`);
  }
  const mainnet = networkName === "mainnet";
  const enabled = bool("X402_ENABLED", true);
  const payTo = str("PAY_TO_ADDRESS");
  if (enabled && !isValidAlgorandAddress(payTo)) {
    errs.push(`PAY_TO_ADDRESS=${JSON.stringify(payTo)}: want the 58-character Algorand address that receives USDC`);
  }
  const publicUrl = str("PUBLIC_URL", str("RENDER_EXTERNAL_URL")).replace(/\/+$/, "");
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) errs.push(`PUBLIC_URL=${JSON.stringify(publicUrl)}: want an absolute URL`);
  if (enabled && mainnet && !publicUrl.startsWith("https://")) {
    errs.push("PUBLIC_URL must be the public https:// URL of this service on MainNet (Bazaar catalogs it)");
  }

  const prices = {} as Record<PaidEndpoint, string>;
  for (const [name, def] of Object.entries(PAID_ENDPOINTS) as [PaidEndpoint, string][]) {
    const key = `PRICE_${name.toUpperCase()}`;
    const v = str(key, def);
    if (!/^\$(0|[1-9]\d*)(\.\d{1,6})?$/.test(v) || Number(v.slice(1)) <= 0) {
      errs.push(`${key}=${JSON.stringify(v)}: want a positive USD amount like "$0.01"`);
      prices[name] = def;
    } else {
      prices[name] = v;
    }
  }

  const cfg: Config = {
    port: int("PORT", 3000, 1, 65535),
    cmcApiKey,
    cmcBaseUrl,
    cmcRpm: int("CMC_RPM", 25, 1, 10_000),
    preset: presetName,
    topN,
    fastN: Math.min(int("FAST_N", pr.fastN, 1, 10_000), topN),
    pageSize: int("PAGE_SIZE", 1000, 1, 5000),
    pollIntervalMs,
    slowIntervalMs,
    staleAfterMs,
    maxStaleMs,
    historyFile: str("HISTORY_FILE"),
    historySaveEveryMs: dur("HISTORY_SAVE_EVERY", 10 * 60_000, 10_000),
    publicUrl,
    x402: {
      enabled,
      networkName: mainnet ? "mainnet" : "testnet",
      network: mainnet ? ALGORAND_MAINNET : ALGORAND_TESTNET,
      usdcAssetId: mainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID,
      payTo,
      facilitatorUrl: str("FACILITATOR_URL", DEFAULT_FACILITATOR_URL).replace(/\/+$/, ""),
      prices,
    },
  };
  if (errs.length) throw new Error("config:\n  " + errs.join("\n  "));
  return cfg;
}

/** Parses "90s", "15m", "1h", "500ms" or bare seconds. */
export function parseDuration(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"]!;
  return Math.round(n * unit);
}
