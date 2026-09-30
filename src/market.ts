import { sleep, type Upstream } from "./cmc.js";
import type { KeyUsage, MarketStatus, Quote, Sample } from "./types.js";

const HOUR = 3_600_000;

/** Immutable view of the tracked top-N assets. */
export class Snapshot {
  readonly byId: Map<number, Quote>;
  /** Ranked assets by rank ascending; unranked last by market cap. */
  readonly byRank: Quote[];

  constructor(
    quotes: Quote[],
    readonly publishedAt: number,
  ) {
    const m = new Map<number, Quote>();
    for (const q of quotes) {
      const prev = m.get(q.id);
      if (!prev || q.lastUpdated >= prev.lastUpdated) m.set(q.id, q);
    }
    this.byId = m;
    this.byRank = [...m.values()].sort((a, b) => {
      if (a.rank > 0 && b.rank > 0 && a.rank !== b.rank) return a.rank - b.rank;
      if ((a.rank > 0) !== (b.rank > 0)) return a.rank > 0 ? -1 : 1;
      if (a.marketCap !== b.marketCap) return b.marketCap - a.marketCap;
      return a.id - b.id;
    });
  }

  get size() {
    return this.byRank.length;
  }

  /**
   * When the least recently refreshed page came back from CMC. This is the
   * freshness the service reports: CMC's per-asset last_updated can lag for
   * hours on dormant tokens and would make every answer look stale.
   */
  oldestFetch(): number {
    let oldest = 0;
    for (const q of this.byRank) {
      const t = q.fetchedAt || q.lastUpdated;
      if (!oldest || t < oldest) oldest = t;
    }
    return oldest;
  }
}

export interface MarketOptions {
  topN: number;
  fastN: number;
  pageSize: number;
  pollIntervalMs: number;
  slowIntervalMs: number;
  keyInfoIntervalMs?: number;
  historyWindowMs?: number;
  historyBucketMs?: number;
  projectedCreditsPerDay?: number;
  now?: () => number;
  log?: (level: "info" | "warn", msg: string, extra?: Record<string, unknown>) => void;
}

interface Page {
  start: number;
  limit: number;
  slow: boolean;
  quotes: Quote[];
  refreshedAt: number;
}

/**
 * Keeps the top-N snapshot fresh from CMC listings/latest in two tiers
 * (ranks 1..fastN every poll, the rest every slow interval) and records an
 * hourly history sample per asset for rank-climb and turnover-surge signals.
 */
export class Market {
  private snap = new Snapshot([], 0);
  private readonly pages: Page[] = [];
  private readonly orphans = new Map<number, { q: Quote; since: number }>();
  private readonly history = new Map<number, Sample[]>();
  private readonly o: Required<MarketOptions>;
  private polling = false;
  private published = false;
  private lastPollAt = 0;
  private lastSuccessAt = 0;
  private lastError = "";
  private calls = 0;
  private errors = 0;
  private credits = { day: "", month: "", today: 0, thisMonth: 0, key: null as KeyUsage | null, sinceKey: 0 };
  private abort?: AbortController;

  constructor(
    private readonly up: Upstream,
    opts: MarketOptions,
  ) {
    this.o = {
      keyInfoIntervalMs: 5 * 60_000,
      historyWindowMs: 7 * 24 * HOUR,
      historyBucketMs: HOUR,
      projectedCreditsPerDay: 0,
      now: Date.now,
      log: () => {},
      ...opts,
    };
    const add = (from: number, to: number, slow: boolean) => {
      for (let s = from; s <= to; s += this.o.pageSize) {
        this.pages.push({ start: s, limit: Math.min(this.o.pageSize, to - s + 1), slow, quotes: [], refreshedAt: 0 });
      }
    };
    add(1, Math.min(this.o.fastN, this.o.topN), false);
    add(this.o.fastN + 1, this.o.topN, true);
  }

  snapshot(): Snapshot {
    return this.snap;
  }

  /**
   * True once every tier page has loaded at least once. A first poll where
   * only some pages succeeded is not served (and so never charged for): the
   * failed ranks would be silently missing from every answer.
   */
  ready(): boolean {
    return this.snap.size > 0 && this.pages.every((p) => p.refreshedAt > 0 || p.quotes.length > 0);
  }

  /** Starts the poll and key-info loops. */
  start() {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    void this.loop(signal, this.o.pollIntervalMs, (first) => this.poll(!!first, signal));
    void this.loop(signal, this.o.keyInfoIntervalMs, () => this.refreshKeyInfo(signal));
  }

  stop() {
    this.abort?.abort(new Error("stopped"));
  }

  private async loop(signal: AbortSignal, interval: number, fn: (first?: boolean) => Promise<unknown>) {
    let first = true;
    while (!signal.aborted) {
      const started = Date.now();
      try {
        await fn(first);
      } catch {
        // poll and refreshKeyInfo record their own errors
      }
      first = false;
      try {
        await sleep(Math.max(0, interval - (Date.now() - started)), signal);
      } catch {
        return;
      }
    }
  }

  /** Fetches the due pages and publishes a merged snapshot. */
  async poll(all = true, signal?: AbortSignal): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = this.o.now();
      const slowDue = this.o.slowIntervalMs - this.o.pollIntervalMs / 2;
      const due = this.pages.filter((p) => all || !p.slow || !p.refreshedAt || now - p.refreshedAt >= slowDue);
      const results = await Promise.allSettled(due.map((p) => this.up.listingsLatest(p.start, p.limit, signal)));
      if (signal?.aborted) return;

      const dropped: Quote[] = [];
      let failed = 0;
      let firstErr = "";
      results.forEach((r, i) => {
        const p = due[i];
        this.calls++;
        if (r.status === "rejected") {
          failed++;
          this.errors++;
          firstErr ||= `ranks ${p.start}-${p.start + p.limit - 1}: ${(r.reason as Error)?.message ?? r.reason}`;
          return;
        }
        this.addCredits(now, r.value.credits);
        dropped.push(...p.quotes);
        p.quotes = r.value.quotes.slice(0, p.limit);
        p.refreshedAt = now;
      });
      this.lastPollAt = now;
      if (failed) {
        this.lastError = `listings poll: ${failed} of ${due.length} pages failed: ${firstErr}`;
        this.o.log("warn", "listings poll failed", { error: this.lastError });
      }
      if (failed < due.length) {
        const merged = this.merge(now, dropped);
        this.snap = new Snapshot(merged, now);
        this.recordHistory(now, merged);
        this.published = true;
        if (!failed) {
          this.lastSuccessAt = now;
          this.lastError = "";
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Merges every page's latest data plus orphans (assets that left a
   * refreshed page but may have moved to one not refreshed yet).
   */
  private merge(now: number, dropped: Quote[]): Quote[] {
    const best = new Map<number, Quote>();
    let oldest = now;
    for (const p of this.pages) {
      for (const q of p.quotes) {
        const cur = best.get(q.id);
        if (!cur || q.lastUpdated > cur.lastUpdated || (q.lastUpdated === cur.lastUpdated && q.fetchedAt > cur.fetchedAt)) {
          best.set(q.id, q);
        }
      }
      if (p.refreshedAt < oldest) oldest = p.refreshedAt;
    }
    for (const q of dropped) {
      if (!best.has(q.id) && !this.orphans.has(q.id)) this.orphans.set(q.id, { q, since: now });
    }
    const ttl = 2 * Math.max(this.o.slowIntervalMs, this.o.pollIntervalMs);
    for (const [id, o] of this.orphans) {
      if (best.has(id) || oldest >= o.since || now - o.since > ttl) {
        this.orphans.delete(id);
        continue;
      }
      best.set(id, o.q);
    }
    return [...best.values()];
  }

  private recordHistory(now: number, quotes: Quote[]) {
    const cutoff = now - this.o.historyWindowMs;
    for (const q of quotes) {
      const ring = this.history.get(q.id) ?? [];
      const last = ring[ring.length - 1];
      if (last && now - last.at < this.o.historyBucketMs) continue;
      ring.push({ at: now, rank: q.rank, price: q.price, marketCap: q.marketCap, volume24h: q.volume24h });
      this.history.set(q.id, ring);
    }
    for (const [id, ring] of this.history) {
      const keep = ring.findIndex((s) => s.at >= cutoff);
      if (keep === -1) this.history.delete(id);
      else if (keep > 0) this.history.set(id, ring.slice(keep));
    }
  }

  /** The asset's retained samples, oldest first (a copy). */
  historyOf(id: number): Sample[] {
    return [...(this.history.get(id) ?? [])];
  }

  /** The sample nearest to now-ago, if within ±25% of ago (30 min minimum). */
  rankAt(id: number, agoMs: number): Sample | undefined {
    return nearestSample(this.history.get(id) ?? [], this.o.now(), agoMs);
  }

  /** Age in whole hours of the oldest retained sample. */
  historyHours(): number {
    let oldest = 0;
    for (const ring of this.history.values()) {
      if (ring.length && (!oldest || ring[0].at < oldest)) oldest = ring[0].at;
    }
    return oldest ? Math.floor((this.o.now() - oldest) / HOUR) : 0;
  }

  exportHistory(): Record<string, Sample[]> {
    const out: Record<string, Sample[]> = {};
    for (const [id, ring] of this.history) out[id] = [...ring];
    return out;
  }

  /** Loads persisted samples, deduplicated and trimmed to the window. */
  seedHistory(samples: Record<string, Sample[]>) {
    const cutoff = this.o.now() - this.o.historyWindowMs;
    for (const [key, ring] of Object.entries(samples)) {
      const id = Number(key);
      const cur = this.history.get(id) ?? [];
      const have = new Set(cur.map((s) => s.at));
      for (const s of ring) if (s.at >= cutoff && !have.has(s.at)) cur.push(s);
      if (!cur.length) continue;
      cur.sort((a, b) => a.at - b.at);
      this.history.set(id, cur);
    }
  }

  /** Publishes a restored snapshot unless a poll already published. */
  seed(quotes: Quote[], publishedAt: number) {
    if (this.published || !quotes.length) return;
    this.snap = new Snapshot(quotes, publishedAt);
    for (const q of this.snap.byRank) {
      const p = this.pages.find((p) => q.rank >= p.start && q.rank < p.start + p.limit);
      p?.quotes.push(q);
    }
  }

  async refreshKeyInfo(signal?: AbortSignal) {
    this.calls++;
    try {
      const k = await this.up.keyInfo(signal);
      this.credits.key = k;
      this.credits.sinceKey = 0;
    } catch (err) {
      this.errors++;
      if (!signal?.aborted) this.o.log("warn", "key info refresh failed", { error: (err as Error).message });
    }
  }

  private addCredits(now: number, n: number) {
    const c = this.credits;
    const d = new Date(now).toISOString();
    if (d.slice(0, 10) !== c.day) [c.day, c.today] = [d.slice(0, 10), 0];
    if (d.slice(0, 7) !== c.month) [c.month, c.thisMonth] = [d.slice(0, 7), 0];
    c.today += n;
    c.thisMonth += n;
    c.sinceKey += n;
  }

  status(): MarketStatus {
    const c = this.credits;
    let today = c.today;
    let month = c.thisMonth;
    let limit = 0;
    if (c.key) {
      limit = c.key.creditLimitMonthly;
      month = c.key.creditsUsedMonth + c.sinceKey;
      if (new Date(c.key.fetchedAt).toISOString().slice(0, 10) === new Date(this.o.now()).toISOString().slice(0, 10)) {
        today = c.key.creditsUsedToday + c.sinceKey;
      }
    }
    return {
      lastPollAt: this.lastPollAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      cacheSize: this.snap.size,
      topN: this.o.topN,
      pollIntervalMs: this.o.pollIntervalMs,
      creditsUsedToday: today,
      creditsUsedMonth: month,
      creditLimitMonthly: limit,
      upstreamCalls: this.calls,
      upstreamErrors: this.errors,
      historyAssets: this.history.size,
      historyHours: this.historyHours(),
      projectedCreditsPerDay: this.o.projectedCreditsPerDay,
    };
  }
}

/** The sample closest to now-ago when it lies within ±25% of ago (30 min minimum). */
export function nearestSample(hist: Sample[], now: number, agoMs: number): Sample | undefined {
  const target = now - agoMs;
  let best: Sample | undefined;
  let bestDist = Infinity;
  for (const s of hist) {
    const d = Math.abs(s.at - target);
    if (d < bestDist) [best, bestDist] = [s, d];
  }
  const tol = Math.max(agoMs / 4, 30 * 60_000);
  return best && bestDist <= tol ? best : undefined;
}
