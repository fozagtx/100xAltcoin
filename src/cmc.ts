import type { KeyUsage, Quote } from "./types.js";

/**
 * The CoinMarketCap calls Alt402 makes. Only /listings/latest (on every
 * CMC plan, including the free Basic tier) and the credit-free /key/info are
 * used; every discovery signal is built from listings/latest.
 */
export interface Upstream {
  /** Assets ranked [start, start+limit) by market cap (start is 1-based). */
  listingsLatest(start: number, limit: number, signal?: AbortSignal): Promise<{ quotes: Quote[]; credits: number }>;
  keyInfo(signal?: AbortSignal): Promise<KeyUsage>;
}

export class CmcError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: number,
    readonly endpoint: string,
  ) {
    super(message);
  }
}

const LISTINGS_AUX = "cmc_rank,date_added,tags,circulating_supply,total_supply,max_supply,platform";

/** Rate-limited CMC Pro API client. */
export class CmcClient implements Upstream {
  // Token bucket: refills at requestsPerMinute, bursts up to a sixth of it.
  private tokens: number;
  private readonly burst: number;
  private readonly perMs: number;
  private last = Date.now();

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    requestsPerMinute = 25,
  ) {
    this.burst = Math.max(1, Math.floor(requestsPerMinute / 6));
    this.tokens = this.burst;
    this.perMs = requestsPerMinute / 60_000;
  }

  async listingsLatest(start: number, limit: number, signal?: AbortSignal) {
    const body = await this.get(
      "/v1/cryptocurrency/listings/latest",
      { start: String(start), limit: String(limit), convert: "USD", aux: LISTINGS_AUX },
      signal,
    );
    const now = Date.now();
    const quotes = ((body.data as CmcAsset[]) ?? []).map((a) => toQuote(a, now));
    return { quotes, credits: Number(body.status?.credit_count ?? 0) };
  }

  async keyInfo(signal?: AbortSignal): Promise<KeyUsage> {
    const body = await this.get("/v1/key/info", {}, signal);
    const d = body.data ?? {};
    return {
      creditLimitMonthly: Number(d.plan?.credit_limit_monthly ?? 0),
      creditsUsedToday: Number(d.usage?.current_day?.credits_used ?? 0),
      creditsUsedMonth: Number(d.usage?.current_month?.credits_used ?? 0),
      fetchedAt: Date.now(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async get(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<any> {
    await this.throttle(signal);
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "X-CMC_PRO_API_KEY": this.apiKey, Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new CmcError(`cmc ${path}: ${(err as Error).message}`, 0, 0, path);
    }
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new CmcError(`cmc ${path}: http ${res.status}: bad json`, res.status, 0, path);
    }
    const code = Number(body?.status?.error_code ?? 0);
    if (!res.ok || code !== 0) {
      const msg = body?.status?.error_message || res.statusText;
      throw new CmcError(`cmc ${path}: http ${res.status} code ${code}: ${msg}`, res.status, code, path);
    }
    return body;
  }

  /** Waits for a token so calls stay under the per-minute limit. */
  private async throttle(signal?: AbortSignal) {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
    this.tokens -= 1; // may go negative: later callers queue behind
    if (this.tokens < 0) await sleep(-this.tokens / this.perMs, signal);
  }
}

interface CmcAsset {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  cmc_rank: number | null;
  circulating_supply: number | null;
  total_supply: number | null;
  max_supply: number | null;
  date_added: string | null;
  tags: string[] | null;
  platform: { name: string } | null;
  quote: Record<
    string,
    {
      price: number | null;
      volume_24h: number | null;
      market_cap: number | null;
      percent_change_1h: number | null;
      percent_change_24h: number | null;
      percent_change_7d: number | null;
      last_updated: string | null;
    }
  >;
}

const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const time = (v: string | null | undefined) => (v ? Date.parse(v) || 0 : 0);

export function toQuote(a: CmcAsset, fetchedAt: number): Quote {
  const usd = a.quote?.USD ?? ({} as CmcAsset["quote"][string]);
  return {
    id: a.id,
    symbol: String(a.symbol ?? ""),
    name: String(a.name ?? ""),
    slug: String(a.slug ?? ""),
    rank: num(a.cmc_rank),
    price: num(usd.price),
    marketCap: num(usd.market_cap),
    volume24h: num(usd.volume_24h),
    change1hPct: num(usd.percent_change_1h),
    change24hPct: num(usd.percent_change_24h),
    change7dPct: num(usd.percent_change_7d),
    circulatingSupply: num(a.circulating_supply),
    totalSupply: num(a.total_supply),
    maxSupply: typeof a.max_supply === "number" && Number.isFinite(a.max_supply) ? a.max_supply : null,
    platform: a.platform?.name ?? "",
    dateAdded: time(a.date_added),
    tags: Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : [],
    lastUpdated: time(usd.last_updated),
    fetchedAt,
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
