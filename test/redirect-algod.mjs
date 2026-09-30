// Node preload (--import) used by test/e2e-avm.test.ts when it runs the REAL
// scripts/pay.ts as a child process.
//
// pay.ts (correctly) passes no algod config, so the SDK's client scheme talks
// to the AlgoNode free tier: https://mainnet-api.algonode.cloud and
// https://testnet-api.algonode.cloud (no token). The sandbox cannot reach
// those hosts, so this wrapper rewrites ONLY requests to those two hosts to
// the local mock algod, keeping path, query, method, headers and body.
// Everything else (the API under test) passes through untouched.
const routes = {
  "mainnet-api.algonode.cloud": process.env.MOCK_ALGOD_MAINNET,
  "testnet-api.algonode.cloud": process.env.MOCK_ALGOD_TESTNET,
};
const realFetch = globalThis.fetch;

globalThis.fetch = async function redirectedFetch(input, init) {
  const asUrl = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  const target = routes[asUrl.hostname];
  if (!target) return realFetch(input, init);
  if (process.env.MOCK_ALGOD_LOG) console.error(`[redirect-algod] ${asUrl.origin}${asUrl.pathname} -> ${target}`);
  const to = new URL(asUrl.pathname + asUrl.search, target);
  if (typeof input === "string" || input instanceof URL) return realFetch(to, init);
  return realFetch(new Request(to, input), init);
};
