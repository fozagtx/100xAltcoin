import type { Snapshot } from "./market.js";
import { eligible, rank, score, Sectors, type Gem, type SignalSet } from "./signals.js";
import type { MarketStatus, Quote, Sample } from "./types.js";

const DAY = 86_400_000;
/** History depth below which rank climb and turnover surge are unavailable. */
export const HISTORY_MIN_HOURS = 24;

/** The market-data side the engine reads; Market implements it. */
export interface MarketView {
  snapshot(): Snapshot;
  historyOf(id: number): Sample[];
  rankAt(id: number, agoMs: number): Sample | undefined;
  historyHours(): number;
  status(): MarketStatus;
}

export interface Warning {
  code: string;
  message: string;
  query?: string;
  chosen_id?: number;
  candidates?: Candidate[];
}

export interface Candidate {
  id: number;
  symbol: string;
  name: string;
  slug: string;
  rank?: number;
}

/** Base asset object returned by every list endpoint. */
export interface Item {
  id: number;
  symbol: string;
  name: string;
  rank?: number;
  price: number;
  market_cap: number;
  volume_24h: number;
  turnover: number;
  change_1h_pct: number;
  change_24h_pct: number;
  change_7d_pct: number;
  date_added: string | null;
  tags: string[];
  last_updated: string;
}

export interface GemItem extends Item {
  score: number;
  confidence: string;
  signals: SignalSet;
  risk_flags: string[];
  why: string[];
  hot_sectors: string[];
}

export interface ClimberItem extends Item {
  rank_then: number;
  rank_change: number;
  rank_change_pct: number;
}

export interface SectorOut {
  tag: string;
  members: number;
  median_change_24h_pct: number;
  median_change_7d_pct: number;
  total_volume_24h: number;
  total_market_cap: number;
  heat: number;
  leaders: { id: number; symbol: string; name: string; change_24h_pct: number }[];
}

export interface AssetItem extends GemItem {
  slug: string;
  circulating_supply: number;
  total_supply: number;
  max_supply: number | null;
  platform?: string;
  eligible_for_gems: boolean;
  rank_history: { at: string; rank: number }[];
}

export interface Result<T> {
  data: T;
  asOf: number;
  historyHours?: number;
  warnings: Warning[];
}

export class AssetNotFoundError extends Error {
  constructor(
    readonly query: string,
    readonly suggestions: Candidate[],
  ) {
    super(`no tracked asset matches ${JSON.stringify(query)}`);
  }
}

export class SectorNotFoundError extends Error {
  constructor(
    readonly tag: string,
    readonly hottest: string[],
  ) {
    super(`sector ${JSON.stringify(tag)} not found`);
  }
}

const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const fin = (x: number) => (Number.isFinite(x) ? x : 0);

export function itemOf(q: Quote): Item {
  const item: Item = {
    id: q.id,
    symbol: q.symbol,
    name: q.name,
    price: fin(q.price),
    market_cap: fin(q.marketCap),
    volume_24h: fin(q.volume24h),
    turnover: q.marketCap > 0 ? fin(Math.round((q.volume24h / q.marketCap) * 10_000) / 10_000) : 0,
    change_1h_pct: fin(q.change1hPct),
    change_24h_pct: fin(q.change24hPct),
    change_7d_pct: fin(q.change7dPct),
    date_added: q.dateAdded ? iso(q.dateAdded) : null,
    tags: q.tags.slice(0, 10),
    last_updated: iso(q.lastUpdated || q.fetchedAt),
  };
  if (q.rank > 0) item.rank = q.rank;
  return item;
}

function gemItemOf(g: Gem): GemItem {
  return {
    ...itemOf(g.quote),
    score: g.score,
    confidence: g.confidence,
    signals: g.signals,
    risk_flags: g.riskFlags,
    why: g.why,
    hot_sectors: g.hotSectors,
  };
}

/** Turns a user-typed sector name into CMC's tag slug form. */
export function normalizeTag(s: string): string {
  return s.trim().replace(/_/g, " ").toLowerCase().split(/\s+/).filter(Boolean).join("-");
}

const hasTag = (q: Quote, tag: string) => q.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
const STABLE_TAGS = new Set(["stablecoin", "asset-backed-stablecoin", "fiat-stablecoin", "wrapped-tokens"]);

export interface GemsParams {
  maxMarketCap: number;
  minMarketCap: number;
  minVolume: number;
  listedWithinDays: number;
  sector: string;
  includePumped: boolean;
  limit: number;
}

export interface ScreenParams {
  minMarketCap?: number;
  maxMarketCap: number;
  minVolume?: number;
  maxVolume?: number;
  minTurnover?: number;
  minChange1h?: number;
  maxChange1h?: number;
  minChange24h?: number;
  maxChange24h?: number;
  minChange7d?: number;
  maxChange7d?: number;
  tags: string[];
  listedWithinDays: number;
  excludeStablecoins: boolean;
  sort: "turnover" | "change_1h_pct" | "change_24h_pct" | "change_7d_pct" | "volume_24h" | "market_cap" | "rank";
  order: "asc" | "desc";
  limit: number;
}

/** Answers discovery queries over the market's snapshot and history. */
export class Engine {
  private secCache: { snap: Snapshot; minMembers: number; sec: Sectors } | null = null;

  constructor(
    private readonly market: MarketView,
    private readonly now: () => number = Date.now,
  ) {}

  private sectors(snap: Snapshot, minMembers = 5): Sectors {
    const c = this.secCache;
    if (c && c.snap === snap && c.minMembers === minMembers) return c.sec;
    const sec = new Sectors(snap, minMembers);
    this.secCache = { snap, minMembers, sec };
    return sec;
  }

  private historyWarnings(): Warning[] {
    const h = this.market.historyHours();
    if (h >= HISTORY_MIN_HOURS) return [];
    return [{
      code: "insufficient_history",
      message: `Rank-climb and turnover-surge signals need ${HISTORY_MIN_HOURS} h of history; the service has ${h} h so far, so scores lean on turnover, listing age and sector heat.`,
    }];
  }

  gems(p: GemsParams): Result<GemItem[]> {
    const snap = this.market.snapshot();
    const hours = this.market.historyHours();
    const sector = normalizeTag(p.sector);
    const all = rank(snap, (id) => this.market.historyOf(id), this.sectors(snap), hours, {
      now: this.now(),
      maxMarketCap: p.maxMarketCap,
      minMarketCap: p.minMarketCap,
      minVolume24h: p.minVolume,
      listedWithinDays: p.listedWithinDays,
    });
    const items: GemItem[] = [];
    for (const g of all) {
      if (sector && !hasTag(g.quote, sector)) continue;
      if (!p.includePumped && g.riskFlags.includes("already_pumped")) continue;
      items.push(gemItemOf(g));
      if (items.length >= p.limit) break;
    }
    return { data: items, asOf: snap.oldestFetch(), historyHours: hours, warnings: this.historyWarnings() };
  }

  screen(p: ScreenParams): Result<Item[]> {
    const snap = this.market.snapshot();
    const cutoff = this.now() - p.listedWithinDays * DAY;
    const tags = p.tags.map(normalizeTag).filter(Boolean);
    const within = (v: number, lo?: number, hi?: number) => (lo === undefined || v >= lo) && (hi === undefined || v <= hi);
    const out = snap.byRank
      .filter((q) => {
        const turnover = q.marketCap > 0 ? q.volume24h / q.marketCap : 0;
        return (
          within(q.marketCap, p.minMarketCap ?? 0, p.maxMarketCap > 0 ? p.maxMarketCap : undefined) &&
          within(q.volume24h, p.minVolume ?? 0, p.maxVolume) &&
          turnover >= (p.minTurnover ?? 0) &&
          within(q.change1hPct, p.minChange1h, p.maxChange1h) &&
          within(q.change24hPct, p.minChange24h, p.maxChange24h) &&
          within(q.change7dPct, p.minChange7d, p.maxChange7d) &&
          (!tags.length || tags.some((t) => hasTag(q, t))) &&
          (p.listedWithinDays <= 0 || (q.dateAdded > 0 && q.dateAdded >= cutoff)) &&
          (!p.excludeStablecoins || !q.tags.some((t) => STABLE_TAGS.has(t.toLowerCase())))
        );
      })
      .map(itemOf);
    const key = (i: Item): number => (p.sort === "rank" ? (i.rank ?? Number.MAX_VALUE) : (i[p.sort] as number));
    out.sort((a, b) => (key(a) === key(b) ? a.id - b.id : p.order === "asc" ? key(a) - key(b) : key(b) - key(a)));
    return { data: out.slice(0, p.limit), asOf: snap.oldestFetch(), warnings: [] };
  }

  /** Biggest CMC rank moves over the last 24h, from retained history. */
  climbers(p: { down: boolean; minVolume: number; maxMarketCap: number; limit: number }): Result<ClimberItem[]> {
    const snap = this.market.snapshot();
    const out: ClimberItem[] = [];
    for (const q of snap.byRank) {
      if (q.rank <= 0 || q.volume24h < p.minVolume) continue;
      if (p.maxMarketCap > 0 && q.marketCap > p.maxMarketCap) continue;
      const then = this.market.rankAt(q.id, DAY);
      if (!then || then.rank <= 0) continue;
      const change = then.rank - q.rank;
      if (p.down ? change >= 0 : change <= 0) continue;
      out.push({ ...itemOf(q), rank_then: then.rank, rank_change: change, rank_change_pct: Math.round((change / then.rank) * 10_000) / 100 });
    }
    const dir = p.down ? 1 : -1;
    out.sort((a, b) => dir * (a.rank_change_pct - b.rank_change_pct) || dir * (a.rank_change - b.rank_change) || a.id - b.id);
    return { data: out.slice(0, p.limit), asOf: snap.oldestFetch(), historyHours: this.market.historyHours(), warnings: this.historyWarnings() };
  }

  sectorList(p: { sort: Parameters<Sectors["sorted"]>[0]; minMembers: number; limit: number }): Result<SectorOut[]> {
    const snap = this.market.snapshot();
    const sec = this.sectors(snap, p.minMembers);
    return { data: sec.sorted(p.sort).slice(0, p.limit).map((s) => this.sectorOut(snap, s.tag, sec)), asOf: snap.oldestFetch(), warnings: [] };
  }

  /** One sector and its members by 24h change; the name is matched loosely. */
  sectorDetail(name: string, limit: number, minMembers = 5): Result<{ sector: SectorOut; members: Item[] }> {
    const snap = this.market.snapshot();
    const sec = this.sectors(snap, minMembers);
    const tag = normalizeTag(name);
    if (!sec.get(tag)) throw new SectorNotFoundError(name, sec.sorted("heat").slice(0, 5).map((s) => s.tag));
    const members = snap.byRank
      .filter((q) => hasTag(q, tag))
      .sort((a, b) => b.change24hPct - a.change24hPct || a.id - b.id)
      .slice(0, limit)
      .map(itemOf);
    return { data: { sector: this.sectorOut(snap, tag, sec), members }, asOf: snap.oldestFetch(), warnings: [] };
  }

  private sectorOut(snap: Snapshot, tag: string, sec: Sectors): SectorOut {
    const s = sec.get(tag)!;
    return {
      tag: s.tag,
      members: s.members,
      median_change_24h_pct: fin(s.medianChange24hPct),
      median_change_7d_pct: fin(s.medianChange7dPct),
      total_volume_24h: fin(s.totalVolume24h),
      total_market_cap: fin(s.totalMarketCap),
      heat: fin(s.heat),
      leaders: s.leaders.flatMap((id) => {
        const q = snap.byId.get(id);
        return q ? [{ id: q.id, symbol: q.symbol, name: q.name, change_24h_pct: fin(q.change24hPct) }] : [];
      }),
    };
  }

  /**
   * One tracked asset by CMC id, slug, symbol or name, scored in full. Never
   * calls CMC: assets outside the tracked top N are not found, with suggestions.
   */
  asset(query: string): Result<AssetItem> {
    const snap = this.market.snapshot();
    const { hit, alts } = lookup(snap, query);
    if (!hit) throw new AssetNotFoundError(query, suggest(snap, query, 5));
    const warnings: Warning[] = [];
    if (alts.length) {
      warnings.push({
        code: "symbol_resolved_by_rank",
        message: `${JSON.stringify(query)} matches ${alts.length + 1} tracked assets; returned ${hit.name} (id ${hit.id}), the best ranked. Pass an id from candidates to get another.`,
        query,
        chosen_id: hit.id,
        candidates: alts.slice(0, 10).map(candidate),
      });
    }
    const hours = this.market.historyHours();
    const hist = this.market.historyOf(hit.id);
    const g = score(hit, hist, this.sectors(snap), hours, { now: this.now() });
    const step = Math.max(1, hist.length / 48);
    const points: { at: string; rank: number }[] = [];
    for (let f = hist.length - 1; f >= 0 && points.length < 48; f -= step) {
      const s = hist[Math.floor(f)];
      points.unshift({ at: iso(s.at), rank: s.rank });
    }
    const data: AssetItem = {
      ...gemItemOf(g),
      slug: hit.slug,
      circulating_supply: fin(hit.circulatingSupply),
      total_supply: fin(hit.totalSupply),
      max_supply: hit.maxSupply,
      eligible_for_gems: eligible(hit, { now: this.now() }),
      rank_history: points,
    };
    if (hit.platform) data.platform = hit.platform;
    return { data, asOf: hit.fetchedAt || hit.lastUpdated, historyHours: hours, warnings: [...warnings, ...this.historyWarnings()] };
  }

  /** The daily digest in one call: top gems, 24h climbers, hottest sectors. */
  digest(p: { gems: number; climbers: number; sectors: number }) {
    const gems = this.gems({ maxMarketCap: 50e6, minMarketCap: 1e6, minVolume: 100e3, listedWithinDays: 0, sector: "", includePumped: false, limit: p.gems });
    const climbers = this.climbers({ down: false, minVolume: 100e3, maxMarketCap: 0, limit: p.climbers });
    const sectors = this.sectorList({ sort: "heat", minMembers: 5, limit: p.sectors });
    return {
      data: { top_gems: gems.data, climbers: climbers.data, hot_sectors: sectors.data },
      asOf: gems.asOf,
      historyHours: gems.historyHours,
      warnings: gems.warnings,
    };
  }
}

const candidate = (q: Quote): Candidate => ({ id: q.id, symbol: q.symbol, name: q.name, slug: q.slug, ...(q.rank > 0 ? { rank: q.rank } : {}) });

/** Numeric id first, then exact slug, symbol and name (case-insensitive); best ranked wins. */
export function lookup(snap: Snapshot, query: string): { hit?: Quote; alts: Quote[] } {
  const qy = query.trim();
  if (!qy) return { alts: [] };
  if (/^\d+$/.test(qy)) {
    const q = snap.byId.get(Number(qy));
    if (q) return { hit: q, alts: [] };
  }
  const lq = qy.toLowerCase();
  for (const field of ["slug", "symbol", "name"] as const) {
    const hits = snap.byRank.filter((q) => q[field].toLowerCase() === lq);
    if (hits.length) return { hit: hits[0], alts: hits.slice(1) };
  }
  return { alts: [] };
}

function suggest(snap: Snapshot, query: string, n: number): Candidate[] {
  const lq = query.trim().toLowerCase();
  if (!lq) return [];
  return snap.byRank
    .filter((q) => q.symbol.toLowerCase().includes(lq) || q.name.toLowerCase().includes(lq))
    .slice(0, n)
    .map(candidate);
}
