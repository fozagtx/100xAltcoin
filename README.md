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
| MainNet | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=`, USDC ASA `31566704` |
| TestNet | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`, USDC ASA `10458941` |
| Challenge tag | `extra.tag = "x402-global-challenge"` on every payment option |
| Discovery | Bazaar extension (input example, input schema, output example) on every paid route |

The network ids are the full genesis-hash form GoPlausible advertises; the
SDK's exported constants are truncated, so they are hard-coded in `src/config.ts`.
Route descriptions are plain ASCII, because the AVM paywall page base64-encodes
them with `btoa` and fails on characters like em dashes.

**Paid calls that fail are not charged.** If a paid call fails (bad parameter,
unknown coin, data not loaded yet, or climbers before 24h of history), the
handler answers 4xx/5xx and the x402 middleware skips settlement. Your USDC
never moves.

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

**TestNet payments:** copy `.env.example` to `.env`, then set `CMC_API_KEY`,
`PAY_TO_ADDRESS` and `ALGORAND_NETWORK=testnet`.

```sh
npm run dev
curl -i localhost:3000/v1/gems                    # 402 + PAYMENT-REQUIRED
AVM_MNEMONIC="..." npm run pay -- 'http://localhost:3000/v1/gems?limit=5'
```

The payer wallet must be opted in to TestNet USDC (ASA 10458941) and hold some.

## Challenge checklist (deadline: September 30, 2026)

1. **Test on TestNet** as above.
2. **Deploy to MainNet.** On Render, go to New → Blueprint and pick this repo; `render.yaml` sets
   `ALGORAND_NETWORK=mainnet`, the GoPlausible facilitator and a disk for the history
   file. Enter `CMC_API_KEY` and `PAY_TO_ADDRESS` when prompted. `PAY_TO_ADDRESS` must be
   opted in to MainNet USDC (ASA 31566704). `PUBLIC_URL` defaults to Render's
   `https://<name>.onrender.com`.
3. **Check the 402:** `curl -i https://<your-host>/v1/gems` should return 402, and the
   decoded `PAYMENT-REQUIRED` should show the MainNet network, asset `31566704` and
   `extra.tag: "x402-global-challenge"`.
4. **Make a real MainNet payment:** `AVM_MNEMONIC="..." npm run pay -- https://<your-host>/v1/gems`.
   Confirm the USDC arrived at `PAY_TO_ADDRESS`. The first settlement catalogs the
   endpoint in the Bazaar.
5. **Confirm the listing:** the endpoint should appear in the GoPlausible Bazaar and on the leaderboard.
6. **Submit** the GitHub repo through the challenge submission form (Electric Capital).

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
History is saved to `HISTORY_FILE` every 10 minutes and on shutdown, so
climbers keep working across restarts.

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
