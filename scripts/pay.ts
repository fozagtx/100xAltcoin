/**
 * Calls a paid 100xAltcoin endpoint and pays for it in USDC on Algorand
 * with x402, using the official @x402 client packages.
 *
 *   AVM_MNEMONIC="25 words ..." npm run pay -- https://your-host/v1/gems?limit=5
 *   AVM_MNEMONIC="25 words ..." npm run pay -- --all https://your-host
 *
 * --all pays each paid route once (about $0.08 in total). The Bazaar catalogs
 * a route on its own first settled payment, so every route you want listed
 * needs one. /v1/climbers answers 503 (and is not charged) until the service
 * has 24h of history; run it again later.
 *
 * Use this to make the MainNet payments the Global x402 Challenge requires.
 * The payer account must be opted in to USDC (ASA 31566704) and hold enough
 * of it. Before signing, the quoted price is checked against MAX_USD
 * (default 0.10); the SDK re-checks every re-quote against the same limit.
 *
 * Optional: ALGOD_URL and ALGOD_TOKEN point the client at your own Algorand
 * node instead of the public AlgoNode endpoint.
 */
import "dotenv/config";
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import algosdk from "algosdk";

const args = process.argv.slice(2);
const all = args.includes("--all");
const target = args.find((a) => !a.startsWith("--"));
const mnemonic = process.env.AVM_MNEMONIC?.trim();
const maxUsd = Number(process.env.MAX_USD || "0.10");
if (!target || !mnemonic) {
  console.error('usage: AVM_MNEMONIC="25 words" npm run pay -- [--all] <paid endpoint URL, or site URL with --all>');
  process.exit(1);
}
if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
  console.error(`MAX_USD=${process.env.MAX_USD} is not a positive number (write it like 0.10)`);
  process.exit(1);
}

const account = algosdk.mnemonicToSecretKey(mnemonic);
const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
const algod = process.env.ALGOD_URL ? { algodUrl: process.env.ALGOD_URL, algodToken: process.env.ALGOD_TOKEN ?? "" } : undefined;
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "algorand:*", client: new ExactAvmScheme(signer, algod) }],
  spendControls: { maxAmountPerPayment: `$${maxUsd}` },
});

/** Pays for one URL and prints the result; returns false when the call did not succeed. */
async function payOnce(url: string): Promise<boolean> {
  // 1. Ask without paying, to see the price.
  const quote = await fetch(url);
  if (quote.status !== 402) {
    console.log(`HTTP ${quote.status} (no payment requested)`);
    console.log(await quote.text());
    return quote.ok;
  }
  const required = JSON.parse(Buffer.from(quote.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8"));
  const option = required.accepts?.[0];
  if (!option) throw new Error("PAYMENT-REQUIRED lists no payment option");
  const usd = Number(option.amount) / 1e6; // USDC has 6 decimals
  console.log(`price: ${usd} USDC (ASA ${option.asset}) on ${option.network}, payTo ${option.payTo}, tag ${option.extra?.tag ?? "-"}`);
  if (usd > maxUsd) throw new Error(`quoted ${usd} USDC is over MAX_USD=${maxUsd}`);

  // 2. Pay and call.
  console.log(`payer: ${signer.address}`);
  const res = await pay(url);
  console.log(`HTTP ${res.status}`);
  const receipt = res.headers.get("PAYMENT-RESPONSE");
  if (receipt) console.log("settlement:", Buffer.from(receipt, "base64").toString("utf8"));
  if (res.status === 402) {
    // The payment was rejected (not opted in, too little USDC, ...): the reason is in the re-issued 402.
    const again = res.headers.get("PAYMENT-REQUIRED");
    const reason = again ? JSON.parse(Buffer.from(again, "base64").toString("utf8")).error : "no reason given";
    console.error(`payment rejected: ${reason}`);
  }
  const body = await res.text();
  console.log(body.length > 4000 ? body.slice(0, 4000) + "..." : body);
  return res.ok;
}

if (!all) {
  process.exit((await payOnce(target)) ? 0 : 1);
}

// --all: one payment per paid route.
const base = target.replace(/\/+$/, "");
const routes = ["/v1/gems?limit=5", "/v1/screen?limit=5", "/v1/sectors?limit=5", "/v1/asset?asset=ETH", "/v1/digest", "/v1/climbers?limit=5"];
const results: { route: string; ok: boolean; error?: string }[] = [];
for (const route of routes) {
  console.log(`\n=== ${route} ===`);
  try {
    results.push({ route, ok: await payOnce(base + route) });
  } catch (err) {
    console.error(`failed: ${(err as Error).message}`);
    results.push({ route, ok: false, error: (err as Error).message });
  }
}
console.log("\n=== summary ===");
for (const r of results) console.log(`${r.ok ? "paid  " : "FAILED"} ${r.route}${r.error ? `  (${r.error})` : ""}`);
const failed = results.filter((r) => !r.ok && !r.route.startsWith("/v1/climbers"));
if (results.some((r) => !r.ok && r.route.startsWith("/v1/climbers"))) {
  console.log("note: /v1/climbers needs 24h of service history; you were not charged. Run it again later.");
}
process.exit(failed.length ? 1 : 0);
