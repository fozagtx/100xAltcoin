import { nearestSample, type Snapshot } from "./market.js";
import type { Quote, Sample } from "./types.js";

const DAY = 86_400_000;

/** One signal's contribution to the composite score. */
export interface Component {
  score: number;
  detail?: Record<string, number>;
}

export interface SignalSet {
  turnover: Component;
  new_listing: Component;
  rank_climb: Component;
  sector_heat: Component;
}

/** One scored asset. */
export interface Gem {
  quote: Quote;
  /** 0..100 composite. */
  score: number;
  confidence: "low" | "medium" | "high";
  signals: SignalSet;
  riskFlags: string[];
  /** Up to four plain-English reasons, strongest first. */
  why: string[];
  /** The asset's tags among the hot sectors (at most 3). */
  hotSectors: string[];
  turnover: number;
}

export interface ScoreOptions {
  now?: number;
  /** Excludes assets already too big to be early; default 50M. */
  maxMarketCap?: number;
  /** Excludes dust; default 1M. */
  minMarketCap?: number;
  /** Excludes dead markets; default 100k. */
  minVolume24h?: number;
  /** Only new listings; 0 = any age. */
  listedWithinDays?: number;
  excludeTags?: string[];
}

const DEFAULT_EXCLUDED = [
  "stablecoin",
  "asset-backed-stablecoin",
  "fiat-stablecoin",
  "wrapped-tokens",
  "tokenized-stock",
  "tokenized-gold",
  "etf",
];

const W_TURNOVER = 0.3;
const W_NEW_LISTING = 0.2;
const W_RANK_CLIMB = 0.3;
const W_SECTOR_HEAT = 0.2;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp;

function withDefaults(o: ScoreOptions) {
  return {
    now: o.now ?? Date.now(),
    // Unset takes the default; an explicit 0 means "no bound" (as in /v1/screen).
    maxMarketCap: o.maxMarketCap === undefined ? 50e6 : o.maxMarketCap > 0 ? o.maxMarketCap : Infinity,
    minMarketCap: o.minMarketCap === undefined ? 1e6 : Math.max(0, o.minMarketCap),
    minVolume24h: o.minVolume24h === undefined ? 100e3 : Math.max(0, o.minVolume24h),
    listedWithinDays: o.listedWithinDays ?? 0,
    excludeTags: o.excludeTags ?? DEFAULT_EXCLUDED,
  };
}

/** Whether q passes the gem eligibility filters. */
export function eligible(q: Quote, opts: ScoreOptions = {}): boolean {
  const o = withDefaults(opts);
  if (q.marketCap < o.minMarketCap || q.marketCap > o.maxMarketCap) return false;
  if (q.volume24h < o.minVolume24h) return false;
  if (o.listedWithinDays > 0 && (!q.dateAdded || o.now - q.dateAdded > o.listedWithinDays * DAY)) return false;
  const excluded = new Set(o.excludeTags.map((t) => t.toLowerCase()));
  return !q.tags.some((t) => excluded.has(t.toLowerCase()));
}

/** Scores one asset from its quote, history and the snapshot's sector index. */
export function score(q: Quote, hist: Sample[], sec: Sectors | null, historyHours: number, opts: ScoreOptions = {}): Gem {
  const o = withDefaults(opts);
  const turnover = q.marketCap > 0 ? q.volume24h / q.marketCap : 0;
  const t = turnoverScore(turnover, hist, o.now);
  const n = newListingScore(q, o.now);
  const climb = rankClimbScore(q, hist, o.now);
  const [heat, hotSectors] = sectorScore(q, sec);

  const flags: string[] = [];
  let total = W_TURNOVER + W_NEW_LISTING + W_SECTOR_HEAT;
  let composite = W_TURNOVER * t.score + W_NEW_LISTING * n.score + W_SECTOR_HEAT * heat.score;
  if (climb.ok) {
    composite += W_RANK_CLIMB * climb.c.score;
    total += W_RANK_CLIMB;
  } else {
    flags.push("insufficient_history");
  }
  let s = composite / total;
  const confidence = historyHours < 24 ? "low" : historyHours < 72 ? "medium" : "high";

  if (q.change24hPct > 100 || q.change7dPct > 300) {
    flags.push("already_pumped");
    s *= 0.6;
  }
  if (q.volume24h < 250e3) flags.push("thin_volume");
  if (q.marketCap < 5e6) flags.push("micro_cap");
  if (q.dateAdded && o.now - q.dateAdded < 7 * DAY) flags.push("new_and_unproven");
  if (q.rank === 0) flags.push("unranked");

  const gem: Gem = {
    quote: q,
    score: round(s, 1),
    confidence,
    signals: { turnover: t, new_listing: n, rank_climb: climb.c, sector_heat: heat },
    riskFlags: flags,
    why: [],
    hotSectors,
    turnover,
  };
  gem.why = why(q, gem);
  return gem;
}

/**
 * Rates volume/mcap on a 0.05..2 log band; with 12+ samples older than 24h,
 * blends in how far it runs above the asset's own baseline.
 */
function turnoverScore(t: number, hist: Sample[], now: number): Component {
  const c: Component = { score: 0, detail: { turnover: round(t, 4) } };
  if (t <= 0) return c;
  const base = clamp01((Math.log10(t) - Math.log10(0.05)) / (Math.log10(2) - Math.log10(0.05))) * 100;
  const older = hist.filter((s) => now - s.at >= DAY && s.marketCap > 0).map((s) => s.volume24h / s.marketCap);
  if (older.length < 12) {
    c.score = round(base, 2);
    return c;
  }
  const baseline = median(older);
  if (baseline <= 0) {
    c.score = round(base, 2);
    return c;
  }
  const surge = t / baseline;
  c.score = round(0.5 * base + 0.5 * clamp01((surge - 1) / 4) * 100, 2);
  c.detail!.baseline_turnover = round(baseline, 4);
  c.detail!.surge = round(surge, 2);
  return c;
}

/** Listed today scores 100; 90 days or older scores 0. */
function newListingScore(q: Quote, now: number): Component {
  if (!q.dateAdded) return { score: 0 };
  const ageDays = Math.max(0, (now - q.dateAdded) / DAY);
  return { score: round(clamp01(1 - ageDays / 90) * 100, 2), detail: { age_days: round(ageDays, 1) } };
}

/** Rank gains over 24h (60%) and 7d (40%); ok is false without usable history. */
function rankClimbScore(q: Quote, hist: Sample[], now: number): { c: Component; ok: boolean } {
  const detail: Record<string, number> = {};
  const s24 = nearestSample(hist, now, DAY);
  const s7d = nearestSample(hist, now, 7 * DAY);
  let pct24 = 0;
  let pct7d = 0;
  if (s24 && s24.rank > 0 && q.rank > 0) {
    pct24 = (s24.rank - q.rank) / s24.rank;
    detail.rank_24h_ago = s24.rank;
    detail.rank_change_24h = s24.rank - q.rank;
  }
  if (s7d && s7d.rank > 0 && q.rank > 0) {
    pct7d = (s7d.rank - q.rank) / s7d.rank;
    detail.rank_7d_ago = s7d.rank;
    detail.rank_change_7d = s7d.rank - q.rank;
  }
  let sc: number;
  if (s24 && s7d) sc = (0.6 * clamp01(pct24 / 0.3) + 0.4 * clamp01(pct7d / 0.5)) * 100;
  else if (s24) sc = clamp01(pct24 / 0.3) * 100;
  else if (s7d) sc = clamp01(pct7d / 0.5) * 100;
  else return { c: { score: 0, detail }, ok: false };
  detail.rank_now = q.rank;
  return { c: { score: round(sc, 2), detail }, ok: true };
}

/** The hottest sector heat among the asset's tags, and its hot tags (heat >= 60). */
function sectorScore(q: Quote, sec: Sectors | null): [Component, string[]] {
  if (!sec) return [{ score: 0 }, []];
  let best = 0;
  let bestMedian = 0;
  const hot: string[] = [];
  for (const tag of q.tags) {
    const s = sec.get(tag);
    if (!s) continue;
    if (s.heat > best) [best, bestMedian] = [s.heat, s.medianChange24hPct];
    if (s.heat >= 60) hot.push(tag);
  }
  hot.sort((a, b) => sec.get(b)!.heat - sec.get(a)!.heat || a.localeCompare(b));
  return [{ score: round(best, 2), detail: { sector_heat: round(best, 2), sector_median_24h: round(bestMedian, 2) } }, hot.slice(0, 3)];
}

/** Up to four reasons; a component earns one when it scores at least 40. */
function why(q: Quote, g: Gem): string[] {
  const rs: { score: number; text: string }[] = [];
  const t = g.signals.turnover;
  if (t.score >= 40) {
    const surge = t.detail?.surge ?? 0;
    rs.push({
      score: t.score,
      text: surge > 0
        ? `Turnover ${g.turnover.toFixed(2)} is ${surge.toFixed(1)}x its 7-day baseline`
        : `Turnover ${g.turnover.toFixed(2)} (volume vs market cap)`,
    });
  }
  const c = g.signals.rank_climb;
  if (c.score >= 40 && q.rank > 0) {
    const then = c.detail?.rank_24h_ago ?? c.detail?.rank_7d_ago;
    const window = c.detail?.rank_24h_ago ? "24h" : "7d";
    if (then) {
      rs.push({ score: c.score, text: `Climbed ${Math.round(((then - q.rank) / then) * 100)}% in rank over ${window} (#${then} -> #${q.rank})` });
    }
  }
  const n = g.signals.new_listing;
  if (n.score >= 40) rs.push({ score: n.score, text: `Listed ${Math.round(n.detail?.age_days ?? 0)} days ago` });
  const h = g.signals.sector_heat;
  if (h.score >= 40 && g.hotSectors.length) {
    rs.push({ score: h.score, text: `Sector ${g.hotSectors[0]} is hot (median +${Math.round(h.detail?.sector_median_24h ?? 0)}% 24h)` });
  }
  return rs.sort((a, b) => b.score - a.score).slice(0, 4).map((r) => r.text);
}

/** Scores every eligible asset, highest first (ties: smaller cap, then id). */
export function rank(
  snap: Snapshot,
  hist: (id: number) => Sample[],
  sec: Sectors | null,
  historyHours: number,
  opts: ScoreOptions = {},
): Gem[] {
  const gems = snap.byRank.filter((q) => eligible(q, opts)).map((q) => score(q, hist(q.id), sec, historyHours, opts));
  return gems.sort((a, b) => b.score - a.score || a.quote.marketCap - b.quote.marketCap || a.quote.id - b.quote.id);
}

/** One tag's aggregate stats across the snapshot. */
export interface Sector {
  tag: string;
  members: number;
  medianChange24hPct: number;
  medianChange7dPct: number;
  totalVolume24h: number;
  totalMarketCap: number;
  /** 0..100: the median member's 24h change, scaled to +15%. */
  heat: number;
  /** Top three members by 24h change (with enough volume). */
  leaders: number[];
}

// Tags too generic (consensus, wrapping, VC portfolios) to mean anything as a sector.
const NOISE_TAGS = new Set([
  "mineable", "pow", "pos", "dpos", "hybrid-pow-pos", "hybrid-pos-pow",
  "stablecoin", "asset-backed-stablecoin", "fiat-stablecoin", "wrapped-tokens",
]);

/** Per-snapshot tag index used by the sector-heat signal. */
export class Sectors {
  private readonly byTag = new Map<string, Sector>();

  constructor(snap: Snapshot, minMembers = 5, minVolume = 100_000) {
    const groups = new Map<string, Quote[]>();
    for (const q of snap.byRank) {
      for (const t of q.tags) {
        if (NOISE_TAGS.has(t) || t.endsWith("-portfolio")) continue;
        (groups.get(t) ?? groups.set(t, []).get(t)!).push(q);
      }
    }
    for (const [tag, members] of groups) {
      if (members.length < minMembers) continue;
      const med24 = median(members.map((q) => q.change24hPct));
      const leaders = members
        .filter((q) => q.volume24h >= minVolume)
        .sort((a, b) => b.change24hPct - a.change24hPct || a.id - b.id)
        .slice(0, 3)
        .map((q) => q.id);
      this.byTag.set(tag, {
        tag,
        members: members.length,
        medianChange24hPct: med24,
        medianChange7dPct: median(members.map((q) => q.change7dPct)),
        totalVolume24h: members.reduce((s, q) => s + q.volume24h, 0),
        totalMarketCap: members.reduce((s, q) => s + q.marketCap, 0),
        heat: clamp01(med24 / 15) * 100,
        leaders,
      });
    }
  }

  get(tag: string): Sector | undefined {
    return this.byTag.get(tag);
  }

  /** Every sector by the given key, descending (ties by tag). */
  sorted(by: "heat" | "change_24h_pct" | "change_7d_pct" | "volume_24h" | "market_cap" = "heat"): Sector[] {
    const key: Record<string, (s: Sector) => number> = {
      heat: (s) => s.heat,
      change_24h_pct: (s) => s.medianChange24hPct,
      change_7d_pct: (s) => s.medianChange7dPct,
      volume_24h: (s) => s.totalVolume24h,
      market_cap: (s) => s.totalMarketCap,
    };
    const k = key[by] ?? key.heat;
    return [...this.byTag.values()].sort((a, b) => k(b) - k(a) || a.tag.localeCompare(b.tag));
  }
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const ys = [...xs].sort((a, b) => a - b);
  const n = ys.length;
  return n % 2 ? ys[(n - 1) / 2] : (ys[n / 2 - 1] + ys[n / 2]) / 2;
}
