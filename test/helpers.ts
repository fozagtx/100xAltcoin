import algosdk from "algosdk";

import { loadConfig, type Config } from "../src/config.js";
import { Snapshot } from "../src/market.js";
import type { MarketStatus, Quote, Sample } from "../src/types.js";

export const NOW = Date.parse("2026-09-30T12:00:00Z");
export const HOUR = 3_600_000;
export const PAY_TO = algosdk.generateAccount().addr.toString();

export function quote(id: number, symbol: string, rank: number, mcap: number, vol: number, c24: number, tags: string[] = []): Quote {
  return {
    id, symbol, name: `${symbol} Token`, slug: symbol.toLowerCase(), rank,
    price: 1.5, marketCap: mcap, volume24h: vol, change1hPct: 0, change24hPct: c24, change7dPct: 2 * c24,
    circulatingSupply: mcap / 1.5, totalSupply: mcap / 1.5, maxSupply: null, platform: "",
    dateAdded: NOW - 10 * 24 * HOUR, tags, lastUpdated: NOW - 60_000, fetchedAt: NOW - 60_000,
  };
}

/** An in-memory market over a fixed snapshot and history. */
export class StubMarket {
  snap: Snapshot;
  hist = new Map<number, Sample[]>();
  hours = 0;

  constructor(quotes: Quote[]) {
    this.snap = new Snapshot(quotes, NOW);
  }
  snapshot() {
    return this.snap;
  }
  ready() {
    return this.snap.size > 0;
  }
  historyOf(id: number) {
    return this.hist.get(id) ?? [];
  }
  rankAt(id: number, agoMs: number) {
    return this.historyOf(id).find((s) => Math.abs(s.at - (NOW - agoMs)) < HOUR);
  }
  historyHours() {
    return this.hours;
  }
  status(): MarketStatus {
    return {
      lastPollAt: NOW, lastSuccessAt: NOW, lastError: "", cacheSize: this.snap.size, topN: 3000, pollIntervalMs: 120_000,
      creditsUsedToday: 0, creditsUsedMonth: 0, creditLimitMonthly: 0, upstreamCalls: 0, upstreamErrors: 0,
      historyAssets: this.hist.size, historyHours: this.hours, projectedCreditsPerDay: 0,
    };
  }
}

export function stubMarket(): StubMarket {
  const qs = [1, 2, 3, 4, 5, 6].map((i) => quote(i, `GEM${String.fromCharCode(65 + i)}`, 600 + i, 5e6 * i, 4e6, i, ["depin"]));
  qs.push(quote(100, "BIG", 5, 90e9, 3e9, 1, ["layer-1"]));
  qs.push(quote(1027, "ETH", 2, 400e9, 20e9, 1, ["pos"]));
  return new StubMarket(qs);
}

export function testConfig(extra: Record<string, string> = {}): Config {
  return loadConfig({
    CMC_API_KEY: "test",
    ALGORAND_NETWORK: "mainnet",
    PAY_TO_ADDRESS: PAY_TO,
    PUBLIC_URL: "https://100xaltcoin.example.com",
    ...extra,
  });
}
