/**
 * Local stand-in for the two CoinMarketCap calls Alt402 makes
 * (/v1/cryptocurrency/listings/latest and /v1/key/info). It serves a
 * deterministic universe of ~3500 assets whose prices, volumes and ranks
 * drift with wall-clock time, including a few "runners", so scores, sectors
 * and (after 24h) climbers are non-trivial without an API key.
 *
 *   npm run fake-cmc            # listens on :8181 (FAKE_CMC_PORT to change)
 */
import { createServer } from "node:http";

const N = 3500;
const START = Date.now();
const TAGS = [
  "ai-big-data", "memes", "defi", "gaming", "real-world-assets", "layer-1", "layer-2", "depin",
  "solana-ecosystem", "ethereum-ecosystem", "bnb-chain-ecosystem", "base-ecosystem", "privacy",
  "account-abstraction", "zero-knowledge-proofs", "oracles", "storage", "social-money", "stablecoin",
];
const PLATFORMS = ["Ethereum", "Solana", "BNB Smart Chain (BEP20)", "Base", ""];

// Mulberry32: small deterministic PRNG.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Coin {
  id: number;
  symbol: string;
  name: string;
  slug: string;
  supply: number;
  basePrice: number;
  baseVolume: number;
  phase: number;
  runRate: number; // per hour growth for runners, else 0
  tags: string[];
  platform: string;
  dateAdded: number;
  stable: boolean;
}

const r = rng(0x100a);
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const coins: Coin[] = [];
const used = new Set<string>();
for (let i = 0; i < N; i++) {
  let symbol = "";
  do {
    symbol = Array.from({ length: 3 + Math.floor(r() * 3) }, () => letters[Math.floor(r() * 26)]).join("");
  } while (used.has(symbol));
  used.add(symbol);
  // Market caps from ~$2T down to ~$100k, log-spaced with noise.
  const mcap = 2e12 * Math.pow(10, -(i / N) * 7.3) * (0.7 + 0.6 * r());
  const basePrice = Math.pow(10, -4 + r() * 6);
  const tags = TAGS.filter(() => r() < 0.12).slice(0, 4);
  const stable = tags.includes("stablecoin");
  coins.push({
    id: 1000 + i * 7,
    symbol,
    name: `${symbol[0]}${symbol.slice(1).toLowerCase()} ${["Protocol", "Network", "AI", "Chain", "Finance", "Labs", "Inu"][Math.floor(r() * 7)]}`,
    slug: `${symbol.toLowerCase()}-${i}`,
    supply: mcap / basePrice,
    basePrice: stable ? 1 : basePrice,
    baseVolume: mcap * Math.pow(10, -2.5 + r() * 2.8),
    phase: r() * Math.PI * 2,
    runRate: r() < 0.01 ? 0.01 + r() * 0.03 : 0,
    tags,
    platform: PLATFORMS[Math.floor(r() * PLATFORMS.length)],
    dateAdded: START - Math.floor(Math.pow(r(), 3) * 3 * 365) * 86_400_000 - Math.floor(r() * 86_400_000),
    stable,
  });
}
coins[0] = { ...coins[0], id: 1, symbol: "BTC", name: "Bitcoin", slug: "bitcoin", tags: ["mineable", "pow"], platform: "", stable: false };
coins[1] = { ...coins[1], id: 1027, symbol: "ETH", name: "Ethereum", slug: "ethereum", tags: ["pos", "smart-contracts"], platform: "", stable: false };

function priceAt(c: Coin, t: number): number {
  if (c.stable) return 1 + 0.0005 * Math.sin(t / 60_000 + c.phase);
  const hours = (t - START) / 3_600_000;
  const wave = 0.08 * Math.sin(t / 3_600_000 / 5 + c.phase) + 0.12 * Math.sin(t / 86_400_000 * 0.9 + c.phase * 2);
  const run = c.runRate ? Math.min(1e4, Math.exp(c.runRate * Math.max(0, hours))) : 1;
  return c.basePrice * (1 + wave) * run;
}

function listing(t: number) {
  const rows = coins.map((c) => {
    const price = priceAt(c, t);
    const vol = c.baseVolume * (0.7 + 0.3 * Math.sin(t / 1_800_000 + c.phase * 3)) * (c.runRate ? 3 : 1);
    return { c, price, mcap: price * c.supply, vol };
  });
  rows.sort((a, b) => b.mcap - a.mcap);
  return rows.map((x, i) => {
    const pct = (ago: number) => (x.price / priceAt(x.c, t - ago) - 1) * 100;
    return {
      id: x.c.id,
      name: x.c.name,
      symbol: x.c.symbol,
      slug: x.c.slug,
      cmc_rank: i + 1,
      circulating_supply: x.c.supply,
      total_supply: x.c.supply * 1.2,
      max_supply: x.c.stable ? null : x.c.supply * 2,
      date_added: new Date(x.c.dateAdded).toISOString(),
      tags: x.c.tags,
      platform: x.c.platform ? { id: 1, name: x.c.platform, symbol: "X", slug: x.c.platform.toLowerCase() } : null,
      quote: {
        USD: {
          price: x.price,
          volume_24h: x.vol,
          market_cap: x.mcap,
          percent_change_1h: pct(3_600_000),
          percent_change_24h: pct(86_400_000),
          percent_change_7d: pct(7 * 86_400_000),
          last_updated: new Date(t).toISOString(),
        },
      },
    };
  });
}

const status = (credits: number) => ({ timestamp: new Date().toISOString(), error_code: 0, error_message: null, elapsed: 1, credit_count: credits });

const port = Number(process.env.FAKE_CMC_PORT ?? 8181);
createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/v1/cryptocurrency/listings/latest") {
    const start = Math.max(1, Number(url.searchParams.get("start") ?? 1));
    const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 100));
    const data = listing(Date.now()).slice(start - 1, start - 1 + limit);
    res.end(JSON.stringify({ status: status(Math.ceil(data.length / 200)), data }));
  } else if (url.pathname === "/v1/key/info") {
    res.end(JSON.stringify({
      status: status(0),
      data: { plan: { credit_limit_monthly: 110000 }, usage: { current_day: { credits_used: 42 }, current_month: { credits_used: 1234 } } },
    }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ status: { error_code: 404, error_message: "not found" } }));
  }
}).listen(port, () => console.log(`fake CMC listening on :${port} with ${N} assets`));
