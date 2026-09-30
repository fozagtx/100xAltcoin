/**
 * Calls one paid 100xAltcoin endpoint and pays for it in USDC on Algorand
 * with x402, using the official @x402 client packages.
 *
 *   AVM_MNEMONIC="25 words ..." npm run pay -- https://your-host/v1/gems?limit=5
 *
 * Use this to make the MainNet payment the Global x402 Challenge requires.
 * The payer account must be opted in to USDC (ASA 31566704 on MainNet,
 * 10458941 on TestNet) and hold enough of it. Before signing, the quoted
 * price is checked against MAX_USD (default 0.10).
 */
import "dotenv/config";
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import algosdk from "algosdk";

const url = process.argv[2];
const mnemonic = process.env.AVM_MNEMONIC?.trim();
const maxUsd = Number(process.env.MAX_USD ?? "0.10");
if (!url || !mnemonic) {
  console.error('usage: AVM_MNEMONIC="25 words" npm run pay -- <paid endpoint URL>');
  process.exit(1);
}

// 1. Ask without paying, to see the price.
const quote = await fetch(url);
if (quote.status !== 402) {
  console.log(`HTTP ${quote.status} (no payment requested)`);
  console.log(await quote.text());
  process.exit(0);
}
const required = JSON.parse(Buffer.from(quote.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8"));
const option = required.accepts?.[0];
if (!option) throw new Error("PAYMENT-REQUIRED lists no payment option");
const usd = Number(option.amount) / 1e6; // USDC has 6 decimals
console.log(`price: ${usd} USDC (ASA ${option.asset}) on ${option.network}, payTo ${option.payTo}, tag ${option.extra?.tag ?? "-"}`);
if (usd > maxUsd) throw new Error(`quoted ${usd} USDC is over MAX_USD=${maxUsd}`);

// 2. Pay and call.
const account = algosdk.mnemonicToSecretKey(mnemonic);
const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));
console.log(`payer: ${signer.address}`);
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "algorand:*", client: new ExactAvmScheme(signer) }],
});
const res = await pay(url);
console.log(`HTTP ${res.status}`);
const receipt = res.headers.get("PAYMENT-RESPONSE");
if (receipt) console.log("settlement:", Buffer.from(receipt, "base64").toString("utf8"));
console.log(JSON.stringify(await res.json(), null, 2).slice(0, 4000));
