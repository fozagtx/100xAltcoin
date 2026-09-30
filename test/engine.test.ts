import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Upstream } from "../src/cmc.js";
import { loadConfig, parseDuration, projectedCreditsPerDay } from "../src/config.js";
import { Engine, normalizeTag } from "../src/discover.js";
import { loadHistory, saveHistory } from "../src/history-file.js";
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
  const base = { CMC_API_KEY: "k", PAY_TO_ADDRESS: PAY_TO };

  it("defaults to TestNet and the GoPlausible facilitator", () => {
    const c = loadConfig(base);
    expect(c.x402).toMatchObject({ networkName: "testnet", usdcAssetId: "10458941", facilitatorUrl: "https://facilitator.goplausible.xyz" });
    expect(c.x402.network).toBe("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe"); // SDK ALGORAND_TESTNET_CAIP2
    expect(projectedCreditsPerDay(c)).toBe(720 + 14 * 96);
  });

  it("uses the SDK MainNet id and requires an https public URL on MainNet", () => {
    expect(() => loadConfig({ ...base, ALGORAND_NETWORK: "mainnet" })).toThrow(/PUBLIC_URL/);
    const c = loadConfig({ ...base, ALGORAND_NETWORK: "mainnet", RENDER_EXTERNAL_URL: "https://x.onrender.com/" });
    expect(c.x402).toMatchObject({ network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k", usdcAssetId: "31566704" });
    expect(c.publicUrl).toBe("https://x.onrender.com");
  });

  it("rejects bad settings", () => {
    expect(() => loadConfig({ CMC_API_KEY: "k", PAY_TO_ADDRESS: "nope" })).toThrow(/PAY_TO_ADDRESS/);
    expect(() => loadConfig({ ...base, PRICE_GEMS: "0.02" })).toThrow(/PRICE_GEMS/);
    expect(() => loadConfig({ PAY_TO_ADDRESS: PAY_TO })).toThrow(/CMC_API_KEY/);
    expect(() => loadConfig({ X402_ENABLED: "false", CMC_BASE_URL: "http://localhost:8181" })).not.toThrow();
    expect(parseDuration("15m")).toBe(900_000);
    expect(loadConfig({ ...base, PRESET: "free" }) && projectedCreditsPerDay(loadConfig({ ...base, PRESET: "free" })) * 31).toBeLessThan(10_000);
  });
});
