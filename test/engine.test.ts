import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Upstream } from "../src/cmc.js";
import { ALGORAND_MAINNET_CAIP2 } from "@x402/avm";

import { creditWarning, loadConfig, parseDuration, projectedCreditsPerDay } from "../src/config.js";
import { Engine, normalizeTag } from "../src/discover.js";
import { cleanStaleTemps, loadHistory, saveHistory } from "../src/history-file.js";
import { toQuote } from "../src/cmc.js";
import { isOptedIn } from "../src/optin.js";
import { Market, Snapshot } from "../src/market.js";
import { eligible, score, Sectors } from "../src/signals.js";
import type { Quote } from "../src/types.js";
import { HOUR, NOW, PAY_TO, quote, stubMarket } from "./helpers.js";

describe("signals", () => {
  it("scores turnover, listing age and flags risk", () => {
    const q = { ...quote(1, "NEW", 800, 3e6, 3e6, 5), dateAdded: NOW - 3 * 24 * HOUR };
    const g = score(q, [], null, 0, { now: NOW });
    expect(g.signals.turnover.score).toBeGreaterThan(60);
    expect(g.signals.new_listing.score).toBeGreaterThan(90);
    expect(g.riskFlags).toEqual(expect.arrayContaining(["insufficient_history", "micro_cap", "new_and_unproven"]));
    expect(g.confidence).toBe("low");
    expect(g.why[0]).toMatch(/Listed 3 days ago|Turnover/);
  });

  it("uses 24h rank history and penalizes pumps", () => {
    const q = quote(1, "UP", 700, 20e6, 4e6, 150);
    const g = score(q, [{ at: NOW - 24 * HOUR, rank: 1000, price: 1, marketCap: 1, volume24h: 1 }], null, 30, { now: NOW });
    expect(g.signals.rank_climb.score).toBe(100);
    expect(g.riskFlags).toContain("already_pumped");
    expect(g.why.some((w) => w.includes("#1000 -> #700"))).toBe(true);
  });

  it("filters eligibility and builds sectors", () => {
    expect(eligible(quote(1, "BIG", 5, 90e9, 3e9, 1), { now: NOW })).toBe(false);
    expect(eligible(quote(2, "USDX", 900, 20e6, 5e6, 0, ["stablecoin"]), { now: NOW })).toBe(false);
    const qs = [30, 20, 10, 0, -5].map((c, i) => quote(i + 1, `S${i}`, 100 + i, 20e6, 4e6, c, ["depin"]));
    const sec = new Sectors(new Snapshot(qs, NOW), 2);
    expect(sec.get("depin")).toMatchObject({ members: 5, medianChange24hPct: 10 });
    expect(sec.get("depin")!.leaders).toEqual([1, 2, 3]);
  });
});

describe("engine", () => {
  it("looks up assets by id, slug, symbol and name, warning on duplicates", () => {
    const m = stubMarket();
    m.snap = new Snapshot([...m.snap.byRank, { ...quote(7, "GEMB", 950, 2e6, 1e6, 1), slug: "gemb-fork" }], NOW);
    const e = new Engine(m, () => NOW);
    expect(e.asset("gemb").data.id).toBe(1);
    expect(e.asset("GEMB Token").warnings[0].code).toBe("symbol_resolved_by_rank");
    expect(e.asset("7").data.id).toBe(7);
    expect(() => e.asset("zzz")).toThrow(/no tracked asset/);
  });

  it("normalizes sector names", () => {
    expect(normalizeTag("  AI Big Data ")).toBe("ai-big-data");
    expect(normalizeTag("real_world_assets")).toBe("real-world-assets");
  });
});

describe("market", () => {
  function fakeUp(n: number): Upstream & { starts: number[] } {
    const ranked: Quote[] = Array.from({ length: n }, (_, i) => quote(1000 + i, `A${i}`, i + 1, 1e9 / (i + 1), 1e6, 0));
    const up = {
      starts: [] as number[],
      listingsLatest: async (start: number, limit: number) => {
        up.starts.push(start);
        return { quotes: ranked.slice(start - 1, start - 1 + limit), credits: 1 };
      },
      keyInfo: async () => ({ creditLimitMonthly: 10000, creditsUsedToday: 5, creditsUsedMonth: 50, fetchedAt: NOW }),
    };
    return up;
  }

  it("polls tiers, publishes a snapshot and records hourly history", async () => {
    let t = NOW;
    const up = fakeUp(4);
    const m = new Market(up, { topN: 4, fastN: 2, pageSize: 2, pollIntervalMs: 60_000, slowIntervalMs: 600_000, now: () => t });
    await m.poll(true);
    expect(m.snapshot().size).toBe(4);
    expect(up.starts).toEqual([1, 3]);
    up.starts.length = 0;
    t += 60_000;
    await m.poll(false);
    expect(up.starts).toEqual([1]); // slow tier not due yet
    expect(m.historyOf(1000)).toHaveLength(1);
    t += HOUR;
    await m.poll(false);
    expect(m.historyOf(1000)).toHaveLength(2);
    expect(m.historyHours()).toBe(1);
  });

  it("round-trips history through the history file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hist-"));
    const path = join(dir, "sub", "history.json.gz");
    expect(await loadHistory(path)).toBeUndefined();
    await saveHistory(path, { savedAt: NOW, publishedAt: NOW, quotes: [quote(1, "A", 1, 1, 1, 1)], history: { 1: [{ at: NOW - HOUR, rank: 3, price: 1, marketCap: 1, volume24h: 1 }] } });
    const st = await loadHistory(path);
    expect(st!.history["1"][0].rank).toBe(3);
    const m = new Market(fakeUp(1), { topN: 1, fastN: 1, pageSize: 1, pollIntervalMs: 60_000, slowIntervalMs: 60_000, now: () => NOW });
    m.seedHistory(st!.history);
    m.seed(st!.quotes, st!.publishedAt);
    expect(m.ready()).toBe(true);
    expect(m.historyHours()).toBe(1);
  });
});

describe("config", () => {
  const base = { CMC_API_KEY: "k", PAY_TO_ADDRESS: PAY_TO, PUBLIC_URL: "https://x.example.com" };

  it("defaults to MainNet, USDC ASA 31566704 and the GoPlausible facilitator", () => {
    const c = loadConfig(base);
    expect(c.x402).toMatchObject({ networkName: "mainnet", usdcAssetId: "31566704", facilitatorUrl: "https://facilitator.goplausible.xyz" });
    expect(c.x402.network).toBe(ALGORAND_MAINNET_CAIP2);
    expect(projectedCreditsPerDay(c)).toBe(720 + 14 * 103); // slow pages refresh every 14 min, not 15
  });

  it("requires a public https URL (MainNet is the default)", () => {
    const noUrl = { CMC_API_KEY: "k", PAY_TO_ADDRESS: PAY_TO };
    expect(() => loadConfig(noUrl)).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ ...noUrl, PUBLIC_URL: "http://x.example.com" })).toThrow(/PUBLIC_URL/);
    const c = loadConfig({ ...noUrl, RENDER_EXTERNAL_URL: "https://x.onrender.com/" });
    expect(c.publicUrl).toBe("https://x.onrender.com");
  });

  it("rejects bad settings", () => {
    expect(() => loadConfig({ ...base, PAY_TO_ADDRESS: "nope" })).toThrow(/PAY_TO_ADDRESS/);
    expect(() => loadConfig({ ...base, PRICE_GEMS: "0.02" })).toThrow(/PRICE_GEMS/);
    expect(() => loadConfig({ ...base, CMC_API_KEY: undefined })).toThrow(/CMC_API_KEY/);
    expect(() => loadConfig({ ...base, ALGORAND_NETWORK: "devnet" })).toThrow(/ALGORAND_NETWORK/);
    expect(() => loadConfig({ X402_ENABLED: "false", CMC_BASE_URL: "http://localhost:8181" })).not.toThrow();
    expect(parseDuration("15m")).toBe(900_000);
    expect(projectedCreditsPerDay(loadConfig({ ...base, PRESET: "free" })) * 31).toBeLessThan(10_000);
  });
});

describe("operational guards", () => {
  it("does not serve a first poll where only some pages loaded", async () => {
    const all: Quote[] = Array.from({ length: 4 }, (_, i) => quote(1000 + i, `A${i}`, i + 1, 1e9 / (i + 1), 1e6, 0));
    let failSecondPage = true;
    const up: Upstream = {
      listingsLatest: async (start, limit) => {
        if (start === 3 && failSecondPage) throw new Error("CMC 500");
        return { quotes: all.slice(start - 1, start - 1 + limit), credits: 1 };
      },
      keyInfo: async () => ({ creditLimitMonthly: 0, creditsUsedToday: 0, creditsUsedMonth: 0, fetchedAt: NOW }),
    };
    const m = new Market(up, { topN: 4, fastN: 4, pageSize: 2, pollIntervalMs: 60_000, slowIntervalMs: 60_000, now: () => NOW });
    await m.poll(true);
    expect(m.snapshot().size).toBe(2);
    expect(m.ready()).toBe(false); // ranks 3-4 missing: paid calls answer 503 (not charged)
    failSecondPage = false;
    await m.poll(true);
    expect(m.ready()).toBe(true);
    expect(m.snapshot().size).toBe(4);
  });

  it("warns when the preset cannot fit the CMC plan", () => {
    expect(creditWarning(2162, 10_000, "startup")).toMatch(/PRESET=startup needs about 67022.*allows 10000/);
    expect(creditWarning(2162, 110_000, "startup")).toBeNull();
    expect(creditWarning(192, 10_000, "free")).toBeNull();
    expect(creditWarning(2162, 0, "startup")).toBeNull(); // plan unknown
  });

  it("keeps the history window configurable", () => {
    const base = { CMC_API_KEY: "k", PAY_TO_ADDRESS: PAY_TO, PUBLIC_URL: "https://x.example.com" };
    expect(loadConfig(base).historyDays).toBe(7);
    expect(loadConfig({ ...base, HISTORY_DAYS: "3" }).historyDays).toBe(3);
    expect(() => loadConfig({ ...base, HISTORY_DAYS: "30" })).toThrow(/HISTORY_DAYS/);
  });
});

describe("hardening", () => {
  it("lists any sector the list shows when min_members is lowered", () => {
    const qs = [1, 2, 3].map((i) => quote(i, `T${i}`, 500 + i, 20e6, 4e6, i, ["tiny"]));
    const e = new Engine(new StubMarketLike(qs), () => NOW);
    expect(() => e.sectorDetail("tiny", 10)).toThrow(/not found/); // 3 members < default 5
    expect(e.sectorDetail("tiny", 10, 2).data.members).toHaveLength(3);
  });

  it("survives malformed CoinMarketCap rows", () => {
    const row = { id: 9, name: null, symbol: "X", slug: null, cmc_rank: 5, circulating_supply: null, total_supply: null, max_supply: null, date_added: null, tags: [null, "ok", 3], platform: null, quote: { USD: { price: 1, volume_24h: 1, market_cap: 1, percent_change_1h: null, percent_change_24h: null, percent_change_7d: null, last_updated: null } } };
    const q = toQuote(row as never, NOW);
    expect(q).toMatchObject({ name: "", slug: "", tags: ["ok"] });
    const e = new Engine(new StubMarketLike([q]), () => NOW);
    expect(() => e.asset("eth")).toThrow(/no tracked asset/); // a clean not-found, not a TypeError
  });

  it("removes temp files from failed or interrupted history saves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hist-tmp-"));
    const { mkdir, readdir, writeFile } = await import("node:fs/promises");
    const target = join(dir, "history.json.gz");
    await mkdir(target); // renaming a file onto a directory fails
    await expect(saveHistory(target, { savedAt: NOW, publishedAt: NOW, quotes: [], history: {} })).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    await writeFile(join(dir, ".history-123-456.tmp"), "partial");
    expect(await cleanStaleTemps(target)).toBe(1);
    expect(await readdir(dir)).toEqual(["history.json.gz"]);
  });

  it("reports whether the payout address is opted in to USDC", async () => {
    const real = globalThis.fetch;
    const answer = (status: number) => (globalThis.fetch = (async () => new Response("{}", { status })) as typeof fetch);
    try {
      answer(200);
      expect(await isOptedIn("https://algod.example", "ADDR", "31566704")).toBe(true);
      answer(404);
      expect(await isOptedIn("https://algod.example", "ADDR", "31566704")).toBe(false);
      answer(500);
      expect(await isOptedIn("https://algod.example", "ADDR", "31566704")).toBeNull();
      globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
      expect(await isOptedIn("https://algod.example", "ADDR", "31566704")).toBeNull();
    } finally {
      globalThis.fetch = real;
    }
  });
});

/** Minimal market over a fixed quote list, for engine-only tests. */
class StubMarketLike {
  private snap: Snapshot;
  constructor(quotes: Quote[]) {
    this.snap = new Snapshot(quotes, NOW);
  }
  snapshot() { return this.snap; }
  historyOf() { return []; }
  rankAt() { return undefined; }
  historyHours() { return 0; }
  status() { return {} as never; }
}
