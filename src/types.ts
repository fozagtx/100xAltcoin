/** Flattened latest market data for one asset, priced in USD. Immutable once published. */
export interface Quote {
  id: number;
  symbol: string;
  name: string;
  slug: string;
  /** CMC rank; 0 when CMC reports none. */
  rank: number;
  price: number;
  marketCap: number;
  volume24h: number;
  change1hPct: number;
  change24hPct: number;
  change7dPct: number;
  circulatingSupply: number;
  totalSupply: number;
  /** null when uncapped or unknown. */
  maxSupply: number | null;
  platform: string;
  /** CMC listing date, ms since epoch; 0 when unknown. */
  dateAdded: number;
  tags: string[];
  /** CMC's own last_updated, ms since epoch. */
  lastUpdated: number;
  /** When this service received the quote from CMC, ms since epoch. */
  fetchedAt: number;
}

/** One point of an asset's hourly history. */
export interface Sample {
  at: number;
  rank: number;
  price: number;
  marketCap: number;
  volume24h: number;
}

/** Plan and usage information from CMC's /v1/key/info. */
export interface KeyUsage {
  creditLimitMonthly: number;
  creditsUsedToday: number;
  creditsUsedMonth: number;
  fetchedAt: number;
}

/** The poller's view of its own health. */
export interface MarketStatus {
  lastPollAt: number;
  lastSuccessAt: number;
  lastError: string;
  cacheSize: number;
  topN: number;
  pollIntervalMs: number;
  creditsUsedToday: number;
  creditsUsedMonth: number;
  creditLimitMonthly: number;
  upstreamCalls: number;
  upstreamErrors: number;
  historyAssets: number;
  historyHours: number;
  projectedCreditsPerDay: number;
}
