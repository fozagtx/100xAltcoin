/**
 * Checks a running 100xAltcoin deployment against the Global x402 Challenge
 * requirements without paying anything:
 *
 *   npm run check -- https://your-service.onrender.com
 *
 * For every paid endpoint it calls without payment and verifies the 402, the
 * decoded PAYMENT-REQUIRED header (network, USDC asset, payTo, challenge tag,
 * resource URL) and the Bazaar discovery extension. Exits non-zero on failure.
 */
import { normalizeAlgorandNetwork } from "@x402/avm";

import { ALGORAND_MAINNET, ALGORAND_TESTNET, CHALLENGE_TAG } from "../src/config.js";
import { ENDPOINTS } from "../src/endpoints.js";

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
const USDC: Record<string, string> = { [ALGORAND_MAINNET]: "31566704", [ALGORAND_TESTNET]: "10458941" };
// Short (SDK) and full genesis-hash ids name the same chain.
const chain = (n: string) => {
  try {
    return normalizeAlgorandNetwork(n);
  } catch {
    return n;
  }
};

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

console.log(`Checking ${base}\n`);
const status = await fetch(`${base}/v1/status`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
console.log("status:");
check(status.status === "ok" || status.status === "degraded", "service is up and has market data", `status=${status.status ?? status.error}`);
check(status.payments?.enabled === true, "payments are enabled");
console.log(`  info  history_hours=${status.history_hours} climbers_available=${status.climbers_available} cache_size=${status.cache_size}\n`);

let network = "";
for (const ep of ENDPOINTS) {
  console.log(`GET ${ep.path}`);
  const res = await fetch(base + ep.path);
  check(res.status === 402, "unpaid call returns 402", `got ${res.status}`);
  const header = res.headers.get("PAYMENT-REQUIRED");
  check(!!header, "PAYMENT-REQUIRED header present");
  if (!header) continue;
  const req = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const opt = req.accepts?.[0] ?? {};
  network = chain(opt.network ?? "");
  check(req.x402Version === 2, "x402 version 2");
  check(opt.scheme === "exact", "exact scheme");
  check(network === ALGORAND_MAINNET || network === ALGORAND_TESTNET, "Algorand network", `${network === ALGORAND_MAINNET ? "MainNet" : network === ALGORAND_TESTNET ? "TestNet" : "?"} ${opt.network}`);
  check(opt.asset === USDC[network], "USDC asset", `ASA ${opt.asset}`);
  check(/^[A-Z2-7]{58}$/.test(opt.payTo ?? ""), "payTo is an Algorand address", opt.payTo);
  check(opt.extra?.tag === CHALLENGE_TAG, `extra.tag = ${CHALLENGE_TAG}`);
  check(!!opt.extra?.feePayer, "facilitator fee payer present (GoPlausible synced)");
  check(!!req.extensions?.bazaar?.info, "Bazaar discovery extension");
  check(String(req.resource?.url ?? "").startsWith(base + ep.path), "resource URL points at this host", req.resource?.url);
  check(/^[\x20-\x7e]*$/.test(req.resource?.description ?? ""), "description is ASCII (paywall page safe)");
  console.log(`  info  price ${Number(opt.amount) / 1e6} USDC\n`);
}

if (network === ALGORAND_TESTNET) console.log("Note: this deployment is on TestNet; the challenge counts MainNet payments only.\n");
console.log(failures ? `${failures} check(s) failed.` : "All checks passed. Next: make one real paid call with `npm run pay -- <url>`.");
process.exit(failures ? 1 : 0);
