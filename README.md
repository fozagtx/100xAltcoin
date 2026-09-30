# 100xAltcoin

Pay-per-call altcoin discovery for AI agents, built on **x402 on Algorand**.
100xAltcoin watches the CoinMarketCap top 3000, keeps its own hourly rank
history, and scores every small cap on four transparent signals (turnover,
rank climb, listing age, sector heat) to surface coins with 100x potential
before they move. Each call is paid in USDC on Algorand. There's no API key and no signup.

Built for the [Algorand Global x402 Challenge](https://algorand.co/global-x402-challenge)
as a **Composite** entry: six paid endpoints, one `payTo` address.
**Market data for information only, not financial advice.**

## Endpoints

| Endpoint | Price | Returns |
| --- | --- | --- |
| `GET /v1/gems` | $0.02 | Top 100x candidates: 0–100 score, signal breakdown, reasons, risk flags |
| `GET /v1/screen` | $0.01 | Screened universe; defaults to top turnover under $50M market cap |
| `GET /v1/climbers` | $0.01 | Biggest CMC rank climbers (or fallers) over 24h |
| `GET /v1/sectors` | $0.01 | Hottest sectors with leaders; `?sector=` for one sector's members |
| `GET /v1/asset` | $0.01 | One coin in detail: score, signals, risk flags, rank history |
| `GET /v1/digest` | $0.03 | Top gems + climbers + hot sectors in one call |
| `GET /v1/status` | free | Health, data age, history depth, prices, payment settings |
| `GET /v1/openapi.json` | free | Every parameter, price and response |
| `GET /.well-known/x402`, `/llms.txt` | free | Machine-readable service descriptions for agents |
| `GET /` | free | Docs page |

Every paid endpoint returns **HTTP 402** when called without payment, even with
no parameters, so crawlers and the Bazaar can always price it. Every parameter
has a default, so a bare paid call also returns useful data.

Main parameters (all listed in `/v1/openapi.json`):

- **`/v1/gems`:** `max_market_cap` (50M), `min_market_cap` (1M), `min_volume` (100k), `listed_within_days`, `sector`, `include_pumped`, `limit`
- **`/v1/screen`:**
  - market cap and volume: `min/max_market_cap`, `min/max_volume`, `min_turnover`
  - price change: `min/max_change_{1h,24h,7d}_pct`
  - other: `tag`, `listed_within_days`, `sort`, `order`, `limit`
- **`/v1/climbers`:** `direction` (`up`/`down`), `min_volume`, `max_market_cap`, `limit`
- **`/v1/sectors`:** `sort`, `min_members`, `sector` (matched loosely, so `AI Big Data` = `ai-big-data`), `limit`
- **`/v1/asset`:** `asset` = CMC id, symbol, slug or name (default `ETH`)
- **`/v1/digest`:** `gems`, `climbers`, `sectors` (section sizes)

## x402 on Algorand

| | |
| --- | --- |
| Protocol | x402 v2, `exact` scheme, official `@x402/hono` + `@x402/avm` |
| Facilitator | GoPlausible, `https://facilitator.goplausible.xyz` |
| Network | Algorand MainNet (`ALGORAND_MAINNET_CAIP2`), USDC ASA `31566704` |
| Challenge tag | `extra.tag = "x402-global-challenge"` on every payment option |
| Discovery | Bazaar extension from `@x402/extensions` (as in the GoPlausible docs) registered once, a declared discovery extension and a concrete description on every route, plus the optional `x402-merchant` identity (name, website, logo, categories) |
| Entry type | Composite: six routes, one `payTo`, one domain, so they roll up to one merchant on the leaderboard |

**Network id.** The config uses the SDK constants the challenge guide names.
At startup the server reads GoPlausible's `/supported` list and uses the
Algorand id exactly as the facilitator advertises it (short SDK form or full
genesis-hash form; both name the same chain), so route validation can't fail
on a formatting mismatch. `/v1/status` shows the id in use.

**Bazaar metadata.** The Bazaar enriches the merchant page from your domain,
so the service serves:
- page metadata: title, description, Open Graph tags and the logo (`/logo.svg`)
- agent and discovery files: `/.well-known/x402`, `/.well-known/agent-card.json`, `/llms.txt`
- `/openapi.json`, `/robots.txt` and `/sitemap.xml`

Route descriptions say concretely what the caller gets, and they are plain
ASCII, because the AVM paywall page base64-encodes them with `btoa`.

**Paid calls that fail are not charged.** If a paid call fails (bad parameter,
unknown coin, data not loaded yet, or climbers before 24h of history), the
handler answers 4xx/5xx and the x402 middleware skips settlement. Your USDC
never moves. If GoPlausible itself can't be reached, paid routes answer 503
`facilitator_unavailable` and retry on the next request.

## Run it

```sh
npm install
npm test
```

**Local, no keys, no payments:**

```sh
npm run fake-cmc                                  # fake CoinMarketCap on :8181
CMC_BASE_URL=http://localhost:8181 X402_ENABLED=false npm run dev
curl 'localhost:3000/v1/gems?limit=5'
```

MainNet is the default network. Payments need a public HTTPS URL, so they run on your
deployment (see the checklist below), not on localhost.

## Challenge checklist (submissions close September 30, 2026)

Official guide: [The Global x402 Challenge is live](https://algorand.co/blog/the-x402-global-challenge-is-live-how-to-build-submit-your-entry).

1. **Receiving wallet:** create a MainNet account in a wallet app (Pera, Defly or Lute), keep
   its recovery phrase offline, and opt it in to USDC (ASA 31566704; needs about 0.2 ALGO).
   Its public address is your `PAY_TO_ADDRESS`.
2. **Deploy.** On Render, go to New → Blueprint and pick this repo;
   `render.yaml` sets MainNet, the GoPlausible facilitator and a disk
   for the history file. Enter `CMC_API_KEY` and `PAY_TO_ADDRESS` when prompted.
   - `PAY_TO_ADDRESS` must be a MainNet account you control, opted in to USDC (ASA 31566704).
     It's the public address only, never the recovery phrase.
   - **Keep the same `PAY_TO_ADDRESS` for the whole competition**; the leaderboard is keyed by it.
   - **Use one domain.** `PUBLIC_URL` defaults to Render's `https://<name>.onrender.com`. If
     you add a custom domain, set `PUBLIC_URL` to it and use only that one; a merchant account
     must not span domains.
3. **Check the live 402:** `npm run check -- https://<your-host>` must pass on every endpoint
   (MainNet, ASA 31566704, `x402-global-challenge` tag, Bazaar extension, fee payer present).
4. **Make real MainNet payments** from a different wallet holding a little USDC (and the
   small ALGO minimum balance; network fees are sponsored by the facilitator). Each route is
   cataloged by its own first settled payment, so pay every route once (about $0.08):
   `AVM_MNEMONIC="..." npm run pay -- --all https://<your-host>`
   (one route: `npm run pay -- https://<your-host>/v1/gems`). `/v1/climbers` answers 503,
   without charging, until the service has 24h of history; run it again after a day.
   Confirm the paid response and that the USDC landed:
   `npm run wallet -- balance <PAY_TO_ADDRESS>`.
5. **Confirm the listing** (global hackathon filter ON): after that first settlement the
   endpoints appear in the
   [Bazaar resource catalog](https://facilitator.goplausible.xyz/dashboard/leaderboards?cat=resources),
   your [merchant entry](https://facilitator.goplausible.xyz/dashboard/leaderboards?cat=merchants)
   and the [leaderboard](https://facilitator.goplausible.xyz/dashboard/leaderboards). The raw
   catalogs are at `/discovery/resources` and `/discovery/merchants` on the facilitator.
6. **Submit** the entry through the [challenge form](https://fjtqz.share-eu1.hsforms.com/2VnFVCiF_Sg26XP85Jxz_bA),
   then submit the public GitHub repo to
   [Electric Capital](https://github.com/electric-capital/open-dev-data)
   ([video walkthrough](https://www.youtube.com/watch?v=Csua5h2DNRg)).
7. **Drive usage through October.** The leaderboard is measured over an unannounced window in
   October on real on-chain usage; the top 50 are reviewed and 10 finalists present at Devcon 8.

## How the score works

The composite is a weighted sum. When rank history is missing, it is renormalized over the other signals.

| Signal | Weight | What it measures |
| --- | --- | --- |
| turnover | 0.30 | `volume_24h / market_cap` on a 0.05–2 log band, blended with a surge vs. the coin's 7-day baseline |
| rank_climb | 0.30 | CMC rank gains over 24h (60%) and 7d (40%), from the service's own hourly history |
| new_listing | 0.20 | listing recency, linear decay to 0 at 90 days |
| sector_heat | 0.20 | hottest tag the coin carries; heat = the sector's median 24h change scaled to +15% |

**Risk flags:**
- `already_pumped`: score ×0.6, and hidden from gems unless `include_pumped=true`
- `thin_volume`, `micro_cap`, `new_and_unproven`, `insufficient_history`, `unranked`

**Confidence** follows history depth: under 24h is `low`, under 72h is `medium`, 72h or more is `high`.

The only CoinMarketCap call is `/v1/cryptocurrency/listings/latest`, which every
plan includes (free too), plus the credit-free `/v1/key/info`. The `startup`
preset uses about 2.1k credits/day; `PRESET=free` fits the 10k/month Basic plan.
History is saved to `HISTORY_FILE` every 30 minutes and on shutdown, so
climbers keep working across restarts. `HISTORY_DAYS` (1–7, default 7) sets how
much is kept; a full 7 days takes roughly 300 MB of memory, so `render.yaml` uses
4 to fit the smallest Render plan (the 7-day part of the rank-climb signal needs
the full 7). `/v1/status` warns (`credit_warning`) if the chosen preset needs more
CoinMarketCap credits than your plan allows.

## Layout

- **`src/server.ts`:** entry point.
- **`src/app.ts`:** Hono routes, envelope, errors, docs, OpenAPI.
- **`src/x402.ts`:** payment middleware (GoPlausible, AVM exact scheme, Bazaar, challenge tag).
- **`src/endpoints.ts`:** endpoint table, parameter validation, Bazaar schemas.
- **`src/discover.ts`:** gems, screen, climbers, sectors, asset, digest.
- **`src/signals.ts`:** scoring and sectors.
- **`src/market.ts`:** tiered CMC poller, snapshot, hourly history.
- **`src/cmc.ts`:** CoinMarketCap client.
- **`src/history-file.ts`:** history persistence.
- **`src/config.ts`:** environment config.
- **`scripts/fake-cmc.ts`:** local fake CoinMarketCap.
- **`scripts/pay.ts`:** pay-and-call client.
- **`scripts/check.ts`:** challenge checks against a live URL.
- **`scripts/wallet.ts`:** wallet helpers (new, opt in, balance).
