import type { PaidEndpoint } from "./config.js";

/** One query parameter: drives validation, Bazaar input schema and OpenAPI. */
export interface Param {
  name: string;
  type: "integer" | "number" | "string" | "boolean" | "enum";
  description: string;
  default?: string | number | boolean;
  enum?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  required?: boolean;
  example?: string | number | boolean;
}

export interface Endpoint {
  name: PaidEndpoint;
  path: string;
  /** Plain ASCII only: the AVM paywall page base64-encodes it with btoa. */
  description: string;
  telegram: string;
  params: Param[];
  /** Example query for Bazaar (what a crawler or agent can call). */
  exampleInput: Record<string, string | number | boolean>;
  exampleOutput: unknown;
}

const limit = (def: number, max = 50): Param => ({
  name: "limit", type: "integer", default: def, min: 1, max, description: "Maximum number of rows returned.",
});

// Example outputs use numbers from the live Telegram bot output.
export const ENDPOINTS: Endpoint[] = [
  {
    name: "gems",
    path: "/v1/gems",
    telegram: "/gems and New gem alerts",
    description:
      "Early altcoin candidates with 100x potential: small caps scored 0-100 on turnover, rank climb, listing age and sector heat, with reasons and risk flags. CoinMarketCap data.",
    params: [
      { name: "max_market_cap", type: "number", default: 50_000_000, min: 0, description: "Largest market cap in USD still considered early." },
      { name: "min_market_cap", type: "number", default: 1_000_000, min: 0, description: "Smallest market cap in USD; filters out dust." },
      { name: "min_volume", type: "number", default: 100_000, min: 0, description: "Minimum 24h volume in USD." },
      { name: "listed_within_days", type: "integer", default: 0, min: 0, max: 365, description: "Only assets listed on CMC within this many days; 0 means any age." },
      { name: "sector", type: "string", maxLength: 60, description: "Only assets carrying this CMC tag, e.g. ai-big-data.", example: "ai-big-data" },
      { name: "include_pumped", type: "boolean", default: false, description: "Keep assets already up more than 100% in 24h or 300% in 7d." },
      limit(10),
    ],
    exampleInput: { limit: 5 },
    exampleOutput: {
      data: [{
        symbol: "AGRIPPA", name: "Agrippa", market_cap: 3500000, volume_24h: 2000000, turnover: 0.57, change_24h_pct: -13.8,
        score: 55, confidence: "low", why: ["Listed 7 days ago", "Turnover 0.57 (volume vs market cap)"],
        risk_flags: ["insufficient_history", "micro_cap", "new_and_unproven"],
      }],
    },
  },
  {
    name: "screen",
    path: "/v1/screen",
    telegram: "/screen",
    description:
      "Screen the CoinMarketCap top N by market cap, volume, turnover, price change, tags and listing age. Defaults to the highest turnover coins under 50M USD market cap.",
    params: [
      { name: "min_market_cap", type: "number", description: "Minimum market cap in USD." },
      { name: "max_market_cap", type: "number", default: 50_000_000, min: 0, description: "Maximum market cap in USD; 0 means no cap." },
      { name: "min_volume", type: "number", description: "Minimum 24h volume in USD." },
      { name: "max_volume", type: "number", description: "Maximum 24h volume in USD." },
      { name: "min_turnover", type: "number", description: "Minimum turnover (24h volume divided by market cap)." },
      { name: "min_change_1h_pct", type: "number", description: "Minimum 1h price change in percent." },
      { name: "max_change_1h_pct", type: "number", description: "Maximum 1h price change in percent." },
      { name: "min_change_24h_pct", type: "number", description: "Minimum 24h price change in percent." },
      { name: "max_change_24h_pct", type: "number", description: "Maximum 24h price change in percent." },
      { name: "min_change_7d_pct", type: "number", description: "Minimum 7d price change in percent." },
      { name: "max_change_7d_pct", type: "number", description: "Maximum 7d price change in percent." },
      { name: "tag", type: "string", maxLength: 300, description: "Comma list of CMC tags; an asset matches if it carries any of them.", example: "memes,solana-ecosystem" },
      { name: "listed_within_days", type: "integer", default: 0, min: 0, max: 365, description: "Only assets listed within this many days; 0 means any age." },
      { name: "exclude_stablecoins", type: "boolean", default: true, description: "Drop stablecoins and wrapped tokens." },
      { name: "sort", type: "enum", default: "turnover", enum: ["turnover", "change_1h_pct", "change_24h_pct", "change_7d_pct", "volume_24h", "market_cap", "rank"], description: "Sort key." },
      { name: "order", type: "enum", enum: ["asc", "desc"], description: "Sort order; desc by default, asc for rank." },
      limit(10),
    ],
    exampleInput: { limit: 10 },
    exampleOutput: {
      data: [
        { symbol: "QUQ", market_cap: 1600000, volume_24h: 119000000, turnover: 73.96, change_24h_pct: 0.0 },
        { symbol: "AEON", market_cap: 12600000, volume_24h: 441500000, turnover: 35.02, change_24h_pct: 0.7 },
      ],
    },
  },
  {
    name: "climbers",
    path: "/v1/climbers",
    telegram: "Rank climber alerts",
    description:
      "Biggest CoinMarketCap rank climbers over the last 24 hours, from the service's own hourly rank history. Set direction=down for the biggest fallers.",
    params: [
      { name: "direction", type: "enum", default: "up", enum: ["up", "down"], description: "up for climbers, down for fallers." },
      { name: "min_volume", type: "number", default: 100_000, min: 0, description: "Minimum 24h volume in USD." },
      { name: "max_market_cap", type: "number", default: 0, min: 0, description: "Maximum market cap in USD; 0 means no cap." },
      limit(10),
    ],
    exampleInput: { direction: "up", limit: 10 },
    exampleOutput: {
      data: [{ symbol: "KSM", name: "Kusama", rank: 197, rank_then: 265, rank_change: 68, rank_change_pct: 25.66, market_cap: 98400000, volume_24h: 23200000, change_24h_pct: 11.9 }],
    },
  },
  {
    name: "sectors",
    path: "/v1/sectors",
    telegram: "/sectors and /sector <tag>",
    description:
      "Hottest crypto sectors (CoinMarketCap tags) ranked by heat, the median 24h move of their members, with the leading coins. Pass sector= for one sector's members.",
    params: [
      { name: "sort", type: "enum", default: "heat", enum: ["heat", "change_24h_pct", "change_7d_pct", "volume_24h", "market_cap"], description: "Sort key for the sector list." },
      { name: "min_members", type: "integer", default: 5, min: 2, max: 200, description: "Smallest sector size listed." },
      { name: "sector", type: "string", maxLength: 60, description: "Return this sector's members instead of the list; matched loosely (AI Big Data = ai-big-data).", example: "account-abstraction" },
      limit(10),
    ],
    exampleInput: { limit: 5 },
    exampleOutput: {
      data: [{ tag: "account-abstraction", heat: 20, median_change_24h_pct: 3.0, leaders: [{ symbol: "PHA" }, { symbol: "NEAR" }, { symbol: "ADX" }] }],
    },
  },
  {
    name: "asset",
    path: "/v1/asset",
    telegram: "/asset <query>",
    description:
      "One tracked coin in detail by symbol, slug, name or CMC id: 100x score, signal breakdown, risk flags and hourly rank history.",
    params: [
      { name: "asset", type: "string", default: "ETH", maxLength: 100, description: "CMC id, symbol, slug or name of a coin in the tracked top N (default ETH, so a bare call still returns a result).", example: "MOVR" },
    ],
    exampleInput: { asset: "MOVR" },
    exampleOutput: {
      data: {
        symbol: "MOVR", name: "Moonriver", rank: 663, market_cap: 22400000, volume_24h: 118700000, turnover: 5.29, change_24h_pct: 76.4,
        score: 52, confidence: "low", why: ["Turnover 5.29 (volume vs market cap)", "Climbed 22% in rank over 24h (#846 -> #663)"],
      },
    },
  },
  {
    name: "digest",
    path: "/v1/digest",
    telegram: "Daily digest",
    description: "The daily altcoin digest in one call: top 100x candidates, 24h rank climbers and the hottest sectors.",
    params: [
      { name: "gems", type: "integer", default: 5, min: 1, max: 20, description: "Number of top gems." },
      { name: "climbers", type: "integer", default: 3, min: 1, max: 20, description: "Number of rank climbers (empty until 24h of history exist)." },
      { name: "sectors", type: "integer", default: 3, min: 1, max: 20, description: "Number of hot sectors." },
    ],
    exampleInput: { gems: 5 },
    exampleOutput: {
      data: {
        top_gems: [{ symbol: "PAID", score: 67, market_cap: 10500000, change_24h_pct: -15.4 }],
        climbers: [{ symbol: "KSM", rank_then: 265, rank: 197 }],
        hot_sectors: [{ tag: "account-abstraction", heat: 20 }],
      },
    },
  },
];

/** A validated query: parsed values by parameter name. */
export type Parsed = Record<string, string | number | boolean | undefined>;

export class ParamError extends Error {
  constructor(
    readonly param: string,
    message: string,
    readonly allowed?: string[],
  ) {
    super(message);
  }
}

/** Validates a query string against the endpoint's parameters; unknown names are rejected. */
export function parseParams(ep: Endpoint, query: URLSearchParams): Parsed {
  const known = new Map(ep.params.map((p) => [p.name, p]));
  for (const name of new Set(query.keys())) {
    if (!known.has(name)) {
      throw new ParamError(name.slice(0, 40), `Unknown parameter "${name.slice(0, 40)}". ${ep.path} accepts only: ${[...known.keys()].join(", ")}.`, [...known.keys()]);
    }
    if (query.getAll(name).length > 1) throw new ParamError(name, `Parameter ${name} was given more than once.`);
  }
  const out: Parsed = {};
  for (const p of ep.params) {
    const raw = query.get(p.name)?.trim() ?? "";
    if (!raw) {
      if (p.required) throw new ParamError(p.name, `Parameter ${p.name} is required.`);
      out[p.name] = p.default;
      continue;
    }
    if (raw.length > (p.maxLength ?? 30)) throw new ParamError(p.name, `Parameter ${p.name} is too long.`);
    switch (p.type) {
      case "integer":
      case "number": {
        const n = Number(raw);
        const bad = !Number.isFinite(n) || (p.type === "integer" && !Number.isInteger(n)) ||
          (p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max);
        if (bad) {
          const range = p.max !== undefined ? ` from ${p.min} to ${p.max}` : p.min !== undefined ? ` of at least ${p.min}` : "";
          throw new ParamError(p.name, `${p.name} must be ${p.type === "integer" ? "a whole number" : "a number"}${range}; got "${raw.slice(0, 30)}".`);
        }
        out[p.name] = n;
        break;
      }
      case "boolean": {
        const v = raw.toLowerCase();
        if (!["true", "false", "1", "0", "yes", "no"].includes(v)) throw new ParamError(p.name, `${p.name} must be true or false; got "${raw.slice(0, 30)}".`);
        out[p.name] = ["true", "1", "yes"].includes(v);
        break;
      }
      case "enum": {
        const v = raw.toLowerCase();
        if (!p.enum!.includes(v)) throw new ParamError(p.name, `${p.name} must be one of ${p.enum!.join(", ")}; got "${raw.slice(0, 30)}".`, p.enum);
        out[p.name] = v;
        break;
      }
      default:
        out[p.name] = raw;
    }
  }
  return out;
}

/** JSON Schema of an endpoint's query parameters (for Bazaar and OpenAPI). */
export function paramSchema(p: Param): Record<string, unknown> {
  const s: Record<string, unknown> = { description: p.description };
  if (p.type === "enum") Object.assign(s, { type: "string", enum: p.enum });
  else s.type = p.type;
  if (p.min !== undefined) s.minimum = p.min;
  if (p.max !== undefined) s.maximum = p.max;
  if (p.maxLength !== undefined) s.maxLength = p.maxLength;
  if (p.default !== undefined) s.default = p.default;
  return s;
}
