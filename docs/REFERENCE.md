# 100xAltcoin reference

The full reference for [100xAltcoin](../README.md): every endpoint and parameter, how the score is
built, where the data comes from, how payment works, configuration and operations.

- [API](#api) · [How the score works](#how-the-score-works) · [Where the data comes from](#where-the-data-comes-from)
- [Paying](#paying) · [Run it locally](#run-it-locally) · [Deploy to Render](#deploy-to-render)
- [Configuration](#configuration) · [Operations](#operations) · [Global x402 Challenge](#global-x402-challenge)
- [Limits](#limits) · [Project layout](#project-layout)

## API

| Endpoint | Price | What you get |
| --- | --- | --- |
| `GET /v1/gems` | $0.02 | Top 100x candidates: up to 50 small caps ranked by a 0–100 score, each with the signal breakdown, plain-English reasons and risk flags |
| `GET /v1/screen` | $0.01 | A screener over the tracked coins. By default the 10 highest-turnover coins under $50M market cap |
| `GET /v1/climbers` | $0.01 | The biggest CoinMarketCap rank climbers (or fallers) of the last 24 hours |
| `GET /v1/sectors` | $0.01 | Hottest sectors (CoinMarketCap tags) ranked by heat, with leaders; `?sector=` returns one sector's coins |
| `GET /v1/asset` | $0.01 | One coin in detail: price, supply, score, signals, risk flags and hourly rank history |
| `GET /v1/digest` | $0.03 | Top gems, 24h climbers and hot sectors in one call |
| `GET /v1/status` | free | Health, data age, history depth, prices, CoinMarketCap credit use, payment status |
| `GET /v1/openapi.json` | free | Every parameter, price and response, machine-readable |

Free discovery files for agents: `/openapi.json`, `/llms.txt`, `/.well-known/x402`,
`/.well-known/agent-card.json`. Prices are set by the `PRICE_*` settings.

All responses share one envelope:

```json
{
  "as_of": "2026-10-01T09:14:00Z",
  "age_seconds": 41,
  "source": "coinmarketcap",
  "note": "Market intelligence for information only, not financial advice.",
  "history_hours": 36,
  "data": [ ... ],
  "warnings": [ { "code": "insufficient_history", "message": "..." } ]
}
```

`as_of` is when the least recently refreshed data was fetched, so `age_seconds` tells you exactly how
fresh the answer is. `warnings` is present only when there is something to know (for example
`stale_data`, or `insufficient_history` while the service has under 24 hours of history).

### `/v1/gems`

Scores every eligible coin and returns the best, highest score first. Eligible means a market cap
of $1M–$50M and at least $100k of 24h volume, excluding stablecoins, wrapped tokens, tokenized
stocks and gold, and ETFs.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `max_market_cap` | 50000000 | Largest market cap (USD) still considered early; `0` means no cap |
| `min_market_cap` | 1000000 | Smallest market cap; filters out dust |
| `min_volume` | 100000 | Minimum 24h volume |
| `listed_within_days` | 0 | Only coins listed on CoinMarketCap within this many days; `0` means any age |
| `sector` | | Only coins carrying this tag, e.g. `ai-big-data` or `"Account Abstraction"` |
| `include_pumped` | false | Keep coins already up over 100% in 24h or 300% in 7d |
| `limit` | 10 | 1–50 |

Example row (trimmed):

```json
{
  "symbol": "AGRIPPA", "name": "Agrippa", "market_cap": 3500000, "volume_24h": 2000000,
  "turnover": 0.57, "change_24h_pct": -13.8,
  "score": 54.7, "confidence": "low",
  "why": ["Listed 7 days ago", "Turnover 0.57 (volume vs market cap)"],
  "risk_flags": ["insufficient_history", "micro_cap", "new_and_unproven"],
  "hot_sectors": [],
  "signals": {
    "turnover":    { "score": 66, "detail": { "turnover": 0.57 } },
    "new_listing": { "score": 92.7, "detail": { "age_days": 6.6 } },
    "rank_climb":  { "score": 0 },
    "sector_heat": { "score": 0 }
  }
}
```

### `/v1/screen`

A filter with no scoring. Parameters: `min_market_cap`, `max_market_cap` (default 50M), `min_volume`,
`max_volume`, `min_turnover`, `min_change_{1h,24h,7d}_pct`, `max_change_{1h,24h,7d}_pct`, `tag`
(comma list; matches any), `listed_within_days`, `exclude_stablecoins` (default true), `sort`
(`turnover` by default; also `change_1h_pct`, `change_24h_pct`, `change_7d_pct`, `volume_24h`,
`market_cap`, `rank`), `order`, `limit`.

### `/v1/climbers`

Compares each coin's CoinMarketCap rank now with its rank 24 hours ago, from the service's own
hourly history. Each row has `rank`, `rank_then`, `rank_change` (places) and `rank_change_pct`.
Parameters: `direction` (`up` or `down`), `min_volume` (default 100k), `max_market_cap`, `limit`.

```json
{ "symbol": "KSM", "name": "Kusama", "rank": 197, "rank_then": 265, "rank_change": 68,
  "rank_change_pct": 25.66, "market_cap": 98400000, "volume_24h": 23200000, "change_24h_pct": 11.9 }
```

Climbers needs 24 hours of history. Until the service has it, the call answers `503` and **you are
not charged** (`GET /v1/status` shows `climbers_available`).

### `/v1/sectors`

A sector is a CoinMarketCap tag. Its **heat** is the median 24h price move of its coins, scaled so
that +15% equals 100. Each row has the member count, median 24h and 7d change, total volume and
market cap, and the three leading coins. Parameters: `sort` (`heat` by default), `min_members`
(default 5), `sector` (matched loosely, so `AI Big Data` finds `ai-big-data`), `limit`.

```json
{ "tag": "account-abstraction", "heat": 20, "median_change_24h_pct": 3.0,
  "leaders": [ { "symbol": "PHA" }, { "symbol": "NEAR" }, { "symbol": "ADX" } ] }
```

### `/v1/asset`

Looks a coin up by CMC id, slug, symbol or name (case-insensitive; if several coins share a symbol
the best-ranked one is returned, with the others listed as `candidates` in a warning). It returns
the base fields, supply, platform, the score with every signal, `eligible_for_gems`, and up to 48
points of hourly `rank_history`. Only coins in the tracked top N are covered: an unknown coin
answers `404 asset_not_found` with `suggestions`, and is not charged.

### `/v1/digest`

`top_gems`, `climbers` and `hot_sectors` in one response. Parameters: `gems` (default 5),
`climbers` (3), `sectors` (3). `climbers` is empty, with an `insufficient_history` warning, until the
service has 24 hours of history.

## How the score works

The composite is a weighted sum of four signals, each scored 0–100:

| Signal | Weight | What it measures |
| --- | --- | --- |
| `turnover` | 0.30 | 24h volume divided by market cap, on a log band from 0.05 (score 0) to 2 (score 100). With enough history it is blended 50/50 with how far today runs above the coin's own baseline |
| `rank_climb` | 0.30 | CoinMarketCap rank gain over 24h (60%; a 30% gain scores 100) and over 7d (40%; a 50% gain scores 100) |
| `new_listing` | 0.20 | Listing recency: 100 when listed today, falling linearly to 0 at 90 days |
| `sector_heat` | 0.20 | The heat of the hottest sector the coin belongs to |

When a coin has no usable rank history, `rank_climb` is left out and the other weights are
renormalized, and the coin is flagged `insufficient_history`.

**Risk flags**

| Flag | Meaning |
| --- | --- |
| `already_pumped` | Up over 100% in 24h or 300% in 7d. The score is multiplied by 0.6 and the coin is hidden from gems unless `include_pumped=true` |
| `thin_volume` | Under $250k of 24h volume |
| `micro_cap` | Market cap under $5M |
| `new_and_unproven` | Listed less than 7 days ago |
| `insufficient_history` | No usable rank history yet |
| `unranked` | CoinMarketCap reports no rank |

**Confidence** reflects how much history the service has: `low` under 24h, `medium` under 72h,
`high` from 72h. `why` lists up to four plain-English reasons, strongest first.

## Where the data comes from

The service polls CoinMarketCap's `/v1/cryptocurrency/listings/latest` in the background and
answers every request from memory, so calls cost no CoinMarketCap credits. That is the only
CoinMarketCap data call it makes (it is on every plan, free included), plus the credit-free
`/v1/key/info` to track your usage.

- **Tiers:** the top coins refresh frequently and the long tail less often.
- **History:** every coin gets an hourly sample (rank, price, market cap, volume), kept for up to
  `HISTORY_DAYS` days and saved to `HISTORY_FILE`, so climbers survive restarts.
- **Presets** (`PRESET`):

  | Preset | Coins tracked | Refresh | CoinMarketCap credits |
  | --- | --- | --- | --- |
  | `free` | top 1000 | 15 min / 60 min | about 190 a day (fits the 10k-a-month Basic plan) |
  | `startup` (default) | top 3000 | 2 min / 15 min | about 2.2k a day (~67k a month) |
  | `standard` | top 5000 | 1 min / 10 min | about 7.6k a day (~237k a month) |

  Small caps mostly sit between ranks 800 and 3000, so `startup` or `standard` finds far more of
  them than `free`. `/v1/status` warns (`credit_warning`) if the preset needs more credits than your
  CoinMarketCap plan allows.
- **Freshness:** data past the stale limit gets a `stale_data` warning. Past the max-stale limit
  the paid endpoints answer `503` and nothing is charged.

## Paying

```
GET /v1/gems                     -> 402, PAYMENT-REQUIRED: <base64: amount, USDC asset, network, payTo>
GET /v1/gems + PAYMENT-SIGNATURE -> facilitator verifies -> data computed -> facilitator settles
                                 -> 200, PAYMENT-RESPONSE: <base64: transaction id, payer>
```

- x402 v2, `exact` scheme, USDC (ASA `31566704`) on Algorand MainNet, verified and settled by the
  [GoPlausible facilitator](https://facilitator.goplausible.xyz).
- The facilitator pays the network fee; the payer only needs USDC and the usual minimum Algorand
  account balance.
- **You are never charged for an error.** Bad parameters, unknown coins, stale data, missing
  history or a facilitator outage all answer 4xx/5xx and the payment is not settled. If the
  facilitator cannot be reached, paid routes answer `503` with a retry hint.
- Every error has `code`, `message` and `next_step`.

Pay from TypeScript:

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";

const signer = toClientAvmSigner(process.env.AVM_PRIVATE_KEY!); // base64 64-byte secret key
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "algorand:*", client: new ExactAvmScheme(signer) }],
});
const res = await pay("https://<your-host>/v1/gems?limit=5");
console.log(await res.json());
```

Or from this repo, which checks the price against a limit before signing:

```sh
AVM_MNEMONIC="25 words ..." npm run pay -- https://<your-host>/v1/gems?limit=5
AVM_MNEMONIC="25 words ..." npm run pay -- --all https://<your-host>   # pay every route once
```

## Run it locally

```sh
npm install
npm test
npm run fake-cmc                                                     # fake CoinMarketCap on :8181
CMC_BASE_URL=http://localhost:8181 X402_ENABLED=false npm run dev    # everything free, no keys
curl 'localhost:3000/v1/gems?limit=5'
```

Payments need a public HTTPS URL, so they run on a deployment rather than on localhost.

## Deploy to Render

1. **Receiving wallet:** create a MainNet account in a wallet app (Pera, Defly or Lute), keep its
   recovery phrase offline, and opt it in to USDC (ASA 31566704; needs about 0.2 ALGO). Its public
   address is your `PAY_TO_ADDRESS`. Never put the recovery phrase on Render.
2. **Blueprint:** in Render choose New → Blueprint and pick this repo. `render.yaml` sets MainNet,
   the GoPlausible facilitator, a 1 GB disk for the history file and the health check. Enter your
   `CMC_API_KEY` and `PAY_TO_ADDRESS` when asked.
3. **Check your plan:** `render.yaml` uses the `startup` preset. If your CoinMarketCap plan is Basic
   (10k credits a month), change `PRESET` to `free`. `HISTORY_DAYS` is 4 to fit the smallest Render
   plan; set it to 7 on a larger one.
4. **Keep it stable:** use the same `PAY_TO_ADDRESS` and one domain for as long as you run it.

Verify the live service:

```sh
npm run check -- https://<your-host>
```

This calls every paid route without paying and checks the 402: MainNet, USDC ASA, `payTo`, the
challenge tag, the Bazaar extension, the merchant identity and the schema limits.
`GET /v1/status` should show `status: "ok"`, `payments.facilitator_synced: true` and
`payments.pay_to_opted_in_usdc: true`.

## Configuration

All settings are environment variables; `.env.example` documents each one.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CMC_API_KEY` | | CoinMarketCap key (required) |
| `PAY_TO_ADDRESS` | | Algorand address that receives the USDC (required) |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL` | Public https URL of the service (required on MainNet) |
| `PRESET` | `startup` | `free`, `startup` or `standard` (see above) |
| `HISTORY_FILE` | `/data/history.json.gz` in Docker | Where history is saved; empty keeps it in memory only |
| `HISTORY_DAYS` | 7 | Days of hourly history kept (1–7); about 300 MB at 7 on 3000 coins |
| `PRICE_GEMS` … `PRICE_DIGEST` | $0.01–$0.03 | Price per call in USD |
| `FACILITATOR_URL` | GoPlausible | x402 facilitator |
| `ALGORAND_NETWORK` | `mainnet` | |
| `PORT` | 3000 | Render sets this itself |
| `TOP_N`, `FAST_N`, `POLL_INTERVAL`, `SLOW_INTERVAL` | from the preset | Override the preset schedule |
| `STALE_AFTER`, `MAX_STALE` | from the preset | When data gets a stale warning, and when paid calls are refused |
| `X402_ENABLED` | `true` | `false` serves everything free (local development only) |

## Operations

- **Restarts:** on a shutdown signal the service stops taking new requests, lets in-flight paid
  requests finish settling, saves its history and exits.
- **Boot checks:** it logs an error if `PAY_TO_ADDRESS` is not opted in to USDC and a warning if
  the preset needs more credits than the CoinMarketCap plan allows.
- **Health:** `GET /health` is for the platform; `GET /v1/status` has the detail.

## Global x402 Challenge

100xAltcoin is a **Composite** entry in the
[Algorand Global x402 Challenge](https://algorand.co/global-x402-challenge): six paid routes sharing
one `payTo` address and one domain, so their volume rolls up into one merchant on the leaderboard.
Every payment option carries `extra.tag = "x402-global-challenge"`, each route declares the Bazaar
discovery extension and a concrete description, and the optional `x402-merchant` identity sets the
merchant name, website and logo.

The submission window ran through September 30, 2026; ranking is on real on-chain usage over an
unannounced window in October. To get listed:

1. Deploy as above and confirm `npm run check` passes.
2. Pay every route once from a different funded wallet: `npm run pay -- --all https://<your-host>`
   (about $0.08). The Bazaar catalogs a route on its own first settled payment. `/v1/climbers`
   answers 503, uncharged, until the service has 24 hours of history, so pay it again after a day.
3. Confirm the USDC arrived: `npm run wallet -- balance <PAY_TO_ADDRESS>`.
4. Check the [Bazaar catalog](https://facilitator.goplausible.xyz/dashboard/leaderboards?cat=resources),
   your [merchant entry](https://facilitator.goplausible.xyz/dashboard/leaderboards?cat=merchants)
   and the [leaderboard](https://facilitator.goplausible.xyz/dashboard/leaderboards), with the
   global hackathon filter on.

## Limits

- Only coins in the tracked top N are covered; there are no lookups outside it.
- `climbers` covers 24 hours only, and needs 24 hours of service history.
- The score ranks candidates by early signals; it is not a prediction or advice.
- Data is as fresh as the preset's refresh schedule, and `as_of` always says exactly how fresh.

## Project layout

- `src/server.ts` is the entry point; `src/app.ts` holds the routes, response envelope, docs page,
  OpenAPI and discovery files; `src/x402.ts` is the payment layer.
- `src/endpoints.ts` is the endpoint table and parameter validation; `src/discover.ts` is the engine
  behind gems, screen, climbers, sectors, asset and digest; `src/signals.ts` is the scoring.
- `src/market.ts` is the tiered CoinMarketCap poller and hourly history; `src/cmc.ts` is the
  CoinMarketCap client; `src/history-file.ts` saves history; `src/config.ts` reads settings.
- `scripts/` has `pay.ts`, `check.ts`, `wallet.ts` and `fake-cmc.ts`; `test/` has the suite,
  including end-to-end payment tests with a mock Algorand node.

```sh
npm test        # unit and end-to-end tests
npm run typecheck
```
