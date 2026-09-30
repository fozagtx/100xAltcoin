# 100xAltcoin

Pay-per-call altcoin discovery for AI agents, paid with [x402](https://x402.org).
It watches the CoinMarketCap top N, keeps its own hourly rank history, and
scores every small cap on four transparent signals (turnover, rank climb,
listing age, sector heat) to surface candidates before they move. Each call
costs a few cents in USDC on Base: no API key, no signup, no subscription.

It is the HTTP/x402 version of the [CoinStack](https://github.com/fozagtx/coinstack)
Telegram bot, rebuilt on the parts of it that proved to work.
**Market data for information only, not financial advice.**

## Endpoints

| Endpoint | Price | Telegram command it replaces | Returns |
| --- | --- | --- | --- |
| `GET /v1/gems` | $0.02 | `/gems`, "New gem" alerts | Top-scored candidates: 0–100 score, signal breakdown, reasons, risk flags |
| `GET /v1/screen` | $0.01 | `/screen` | Filtered universe; defaults to top turnover under $50M |
| `GET /v1/climbers` | $0.01 | `/climbers`, "Rank climber" alerts | Biggest CMC rank climbers (or fallers) over 24h |
| `GET /v1/sectors` | $0.01 | `/sectors`, `/sector <tag>` | Sectors ranked by heat with leaders; `?sector=` for members |
| `GET /v1/asset` | $0.01 | `/asset <query>` | One tracked asset: score, signals, risk flags, rank history |
| `GET /v1/digest` | $0.03 | Daily digest | Top gems + climbers + hot sectors in one call |
| `GET /v1/status` | free | `/status` | Health, data age, history depth, credit use, prices, payment status |
| `GET /v1/openapi.json` | free | | OpenAPI 3.0 with every parameter and price |
| `GET /` | free | | Docs page |

Prices are configurable (`PRICE_*`). Every parameter is in `/v1/openapi.json`;
the most useful ones:

- `/v1/gems`: `max_market_cap` (50M), `min_market_cap` (1M), `min_volume` (100k),
  `listed_within_days`, `sector`, `include_pumped`, `limit` (10, max 50)
- `/v1/screen`: `min/max_market_cap`, `min/max_volume`, `min_turnover`,
  `min/max_change_{1h,24h,7d}_pct`, `tag` (comma list), `sort`, `order`, `limit`
- `/v1/climbers`: `direction` (`up`/`down`), `min_volume`, `max_market_cap`, `limit`
- `/v1/sectors`: `sort`, `min_members`, `sector` (matched loosely: `AI Big Data` = `ai-big-data`), `limit`
- `/v1/asset`: `asset` = CMC id, symbol, slug or name
- `/v1/digest`: `gems`, `climbers`, `sectors` (section sizes)

### What was removed, and why

The Telegram output showed gems, screen, rank-climber alerts, hot sectors and
the digest working. Everything else was dropped or rebuilt on that same data:

| Removed | Why |
| --- | --- |
| `/new` (new listings) | Needs CMC `/v1/cryptocurrency/listings/new`, which is only on the Startup plan and up; no "New listing" alert appears anywhere in the bot's output. |
| `/climbers 7d` | Needs 7 days of unbroken history; restarts kept wiping it. Only the 24h window is offered. |
| `/resolve` and lookups outside the top N | Needed CMC `/map`, `/quotes/latest` and `/info`. `/v1/asset` now reads only the tracked snapshot. |

The service now makes exactly one kind of CMC call,
`/v1/cryptocurrency/listings/latest` (available on every plan, free included),
plus the credit-free `/v1/key/info`.

Two CoinStack problems are also fixed:

- **Freshness.** CoinStack's HTTP API judged staleness by the oldest CMC
  `last_updated` across ~3000 assets, so one dormant token could turn every
  endpoint into a 503 while the Telegram bot (which never checked) kept
  working. Freshness is now measured from when each page last came back from CMC.
- **History across restarts.** The rank history behind climbers and the
  rank-climb signal lived in memory, so after every restart the digest said
  "Climbers: not enough history yet". It is now saved to `HISTORY_FILE`
  every 10 minutes and on shutdown.

## How paying works

```
GET /v1/gems                        -> 402, PAYMENT-REQUIRED: <base64 {amount, asset: USDC, network, payTo}>
GET /v1/gems + PAYMENT-SIGNATURE    -> facilitator verifies -> handler runs -> facilitator settles
                                    -> 200, PAYMENT-RESPONSE: <base64 {transaction, network, payer}>
```

- x402 v2, `exact` scheme, USDC via EIP-3009 (the payer signs; the facilitator pays gas).
- **You are never charged for an error.** Bad parameters, stale data and
  missing history are refused *before* payment is requested, and a handler
  error (e.g. unknown asset) is verified but never settled.
- Until the facilitator has been reached, paid routes answer
  `503 payments_unavailable` rather than asking for a payment nobody can verify.
- CORS is open, and the payment headers are exposed, so browser agents work too.

Any x402 v2 client can pay. TypeScript:

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
});
const res = await pay("https://your-host/v1/gems?limit=5");
console.log(await res.json());
```

Go (bundled): `PAYER_PRIVATE_KEY=0x... go run ./cmd/payclient -url https://your-host/v1/gems`
checks the price against `-max` (default $0.10), pays and prints the settlement.

## Quickstart

### Local, no keys, no payments

```sh
go run ./cmd/fakecmc                      # fake CoinMarketCap on :8181
CMC_BASE_URL=http://localhost:8181 X402_ENABLED=false go run ./cmd/100xaltcoin
curl 'localhost:8080/v1/gems?limit=5'
curl localhost:8080/v1/status
```

### With payments on Base Sepolia (testnet)

```sh
cp .env.example .env    # set CMC_API_KEY and X402_PAY_TO (your address)
go run ./cmd/100xaltcoin
curl -i 'localhost:8080/v1/gems'          # 402 + PAYMENT-REQUIRED
PAYER_PRIVATE_KEY=0x... go run ./cmd/payclient -url 'http://localhost:8080/v1/gems?limit=5'
```

The payer needs Base Sepolia USDC from <https://faucet.circle.com>.

### Going live on Base mainnet

Set `X402_NETWORK=eip155:8453` and point `X402_FACILITATOR_URL` at a
facilitator that settles on Base mainnet (the default `x402.org` facilitator
is for testnet). If it needs a static token, put it in `X402_FACILITATOR_AUTH`
(sent as the `Authorization` header). `/v1/status` shows whether the
facilitator sync succeeded.

## How the score works

Composite = weighted sum, renormalized when rank history is missing:

| Signal | Weight | What it measures |
| --- | --- | --- |
| turnover | 0.30 | `volume_24h / market_cap` on a 0.05–2 log band, blended with a surge term vs. the asset's own 7-day baseline |
| rank_climb | 0.30 | rank gains over 24h (60%) and 7d (40%), from the service's own hourly history |
| new_listing | 0.20 | listing recency, linear decay to 0 at 90 days |
| sector_heat | 0.20 | hottest tag the asset carries; heat = sector median 24h change scaled to +15% |

Risk flags: `already_pumped` (score ×0.6, hidden from gems unless
`include_pumped=true`), `thin_volume`, `micro_cap`, `new_and_unproven`,
`insufficient_history`, `unranked`. Confidence is `low`/`medium`/`high` from
history depth (<24h / <72h / ≥72h). The score ranks candidates for review; it
does not predict outcomes.

## Configuration

All settings are environment variables; `.env.example` documents each one.

| Variable | Default | Notes |
| --- | --- | --- |
| `CMC_API_KEY` | | required (unless `CMC_BASE_URL` points at fakecmc) |
| `PRESET` | `startup` | `free` (top 1000, ~190 credits/day), `startup` (top 3000, ~2.1k/day), `standard` (top 5000, ~7.6k/day) |
| `X402_PAY_TO` | | your USDC receiving address; required when payments are on |
| `X402_NETWORK` | `eip155:84532` | Base Sepolia; `eip155:8453` for Base |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | |
| `X402_ENABLED` | `true` | `false` serves everything free (local dev) |
| `PRICE_GEMS` … `PRICE_DIGEST` | $0.01–$0.03 | USD, up to 6 decimals |
| `HISTORY_FILE` | `/data/history.json.gz` in Docker | empty = memory only |
| `PUBLIC_URL` | `RENDER_EXTERNAL_URL` | base of the x402 resource URLs |

## Deploy

```sh
docker build -t 100xaltcoin .
docker run -p 8080:8080 -v $PWD/data:/data -e CMC_API_KEY=... -e X402_PAY_TO=0x... 100xaltcoin
```

**Render:** `render.yaml` is a Blueprint (New → Blueprint → this repo). It
creates the Docker web service with a 1 GB disk at `/data` for the history
file, and prompts for `CMC_API_KEY` and `X402_PAY_TO`. Use a paid instance;
the free tier sleeps, which stops polling.

## Layout

- `cmd/100xaltcoin` — the service; `cmd/fakecmc` — local fake CMC;
  `cmd/payclient` — pay-and-call test client.
- `internal/cmc` — rate-limited CMC client (listings/latest, key/info).
- `internal/market` — tiered poller, snapshot, hourly history ring.
- `internal/signals` — scoring; `internal/discover` — gems, screen,
  climbers, sectors, asset, digest.
- `internal/paywall` — x402 middleware (official `x402-foundation/x402/go` SDK)
  with facilitator retry and no-charge-on-error.
- `internal/api` — HTTP routes, pre-payment validation, OpenAPI, docs page.
- `internal/histfile` — history persistence; `internal/config` — env config.

```sh
go test ./...
```
