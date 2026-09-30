/**
 * End-to-end: REAL x402 client -> REAL app -> REAL facilitator-side AVM
 * verification/settlement, with only the network mocked.
 *
 *   client : @x402/fetch + @x402/avm ExactAvmScheme + toClientAvmSigner (same derivation as scripts/pay.ts)
 *   app    : createApp + createPayments (official @x402/hono middleware), over a real local HTTP port
 *   facil. : @x402/core x402Facilitator + @x402/avm/exact/facilitator ExactAvmScheme + toFacilitatorAvmSigner
 *            (either in-process or behind a local HTTP server used through the real HTTPFacilitatorClient)
 *   algod  : test/mock-algod.ts (ledger with signature/genesis/group/fee/opt-in/balance/replay rules)
 *
 * Nothing here is stubbed on the SDK side: if the SDK's client signs a bad
 * group or the facilitator's real checks reject it, these tests fail.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2, toClientAvmSigner, toFacilitatorAvmSigner } from "@x402/avm";
import { ExactAvmScheme as ClientAvmScheme } from "@x402/avm/exact/client";
import { ExactAvmScheme as FacilitatorAvmScheme } from "@x402/avm/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig, x402Client, x402HTTPClient } from "@x402/fetch";
import algosdk from "algosdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { CHALLENGE_TAG } from "../src/config.js";
import { createPayments } from "../src/x402.js";
import { NOW, stubMarket, testConfig } from "./helpers.js";
import { MockAlgod, NETWORKS, type NetName } from "./mock-algod.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const b64sk = (sk: Uint8Array) => Buffer.from(sk).toString("base64");
const decodeHeader = (h: string | null) => JSON.parse(Buffer.from(h ?? "", "base64").toString("utf8"));

interface Recorded<R> {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  result: R;
}
interface Calls {
  verify: Recorded<VerifyResponse>[];
  settle: Recorded<SettleResponse>[];
}

type Transport = "in-process" | "http";
interface Variant {
  net: NetName;
  advertise: "short" | "full";
  transport: Transport;
}

/** The real SDK facilitator scheme wrapped the way a facilitator service exposes it, recording every call. */
function recordingFacilitator(facilitator: x402Facilitator, calls: Calls): FacilitatorClient {
  const wire = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T; // what HTTP would do to it
  return {
    getSupported: async () => wire(facilitator.getSupported()) as SupportedResponse,
    verify: async (payload, requirements) => {
      const p = wire(payload);
      const r = wire(requirements);
      const result = await facilitator.verify(p, r);
      calls.verify.push({ payload: p, requirements: r, result });
      return result;
    },
    settle: async (payload, requirements) => {
      const p = wire(payload);
      const r = wire(requirements);
      const result = await facilitator.settle(p, r);
      calls.settle.push({ payload: p, requirements: r, result });
      return result;
    },
  };
}

/** GoPlausible-style HTTP facilitator (GET /supported, POST /verify, POST /settle) over the recording facilitator. */
async function startHttpFacilitator(backend: FacilitatorClient) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/supported") return send(200, await backend.getSupported());
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (req.method === "POST" && req.url === "/verify") return send(200, await backend.verify(body.paymentPayload, body.paymentRequirements));
      if (req.method === "POST" && req.url === "/settle") return send(200, await backend.settle(body.paymentPayload, body.paymentRequirements));
      return send(404, { error: "not found" });
    } catch (err) {
      return send(500, { error: String(err) });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

interface Payer {
  account: algosdk.Account;
  address: string;
  mnemonic: string;
}

async function startStack(v: Variant) {
  const net = NETWORKS[v.net];
  const usdc = net.usdc;
  const mock = await MockAlgod.start(v.net);
  const merchant = algosdk.generateAccount();
  const facilitatorAccount = algosdk.generateAccount();
  mock.fund(merchant.addr.toString(), { algo: 200_000n, assets: { [usdc.toString()]: 0n } }); // receiving USDC needs an opt-in
  mock.fund(facilitatorAccount.addr.toString(), { algo: 5_000_000n });

  const advertised = v.advertise === "short" ? net.caipShort : net.caipFull;
  const calls: Calls = { verify: [], settle: [] };
  const signer = toFacilitatorAvmSigner(b64sk(facilitatorAccount.sk), { mainnetUrl: mock.url, testnetUrl: mock.url });
  const facilitator = new x402Facilitator()
    .register(advertised as Network, new FacilitatorAvmScheme(signer))
    .registerExtension({ key: "bazaar" });
  const backend = recordingFacilitator(facilitator, calls);
  const httpFacilitator = v.transport === "http" ? await startHttpFacilitator(backend) : undefined;

  // HTTP transport goes through the production wiring (src/server.ts: createPayments(cfg) with cfg.x402.facilitatorUrl
  // -> the SDK's HTTPFacilitatorClient); the in-process transport injects the client directly.
  const cfg = testConfig({
    ALGORAND_NETWORK: v.net,
    PAY_TO_ADDRESS: merchant.addr.toString(),
    ...(httpFacilitator ? { FACILITATOR_URL: httpFacilitator.url } : {}),
  });
  const payments = httpFacilitator ? createPayments(cfg) : createPayments(cfg, backend);
  const app = createApp({ config: cfg, market: stubMarket(), payments, now: () => NOW });
  const listening = await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve({ server, port: info.port }));
  });
  const base = `http://127.0.0.1:${listening.port}`;

  return {
    v, mock, calls, base, advertised, cfg, usdc, payments,
    merchant: merchant.addr.toString(),
    facilitatorAddress: facilitatorAccount.addr.toString(),

    /** A fresh random payer, funded like a real wallet: ~1 ALGO, opted in to USDC with 1 USDC (or not opted in: usdc = null). */
    newPayer(opts: { algo?: bigint; usdc?: bigint | null } = {}): Payer {
      const account = algosdk.generateAccount();
      const address = account.addr.toString();
      const u = opts.usdc === undefined ? 1_000_000n : opts.usdc;
      mock.fund(address, { algo: opts.algo ?? 1_000_000n, assets: u === null ? {} : { [usdc.toString()]: u } });
      return { account, address, mnemonic: algosdk.secretKeyToMnemonic(account.sk) };
    },

    /**
     * The same construction as scripts/pay.ts: signer from the base64 of the
     * 64-byte secret key, scheme registered under "algorand:*", wrapped fetch.
     * `algodUrl` points the client at the mock (pay.ts itself passes no config
     * and so uses the SDK's AlgoNode default; see the pay.ts describe below).
     */
    payingFetch(payer: Payer, opts: { scheme?: (signer: ReturnType<typeof toClientAvmSigner>) => ClientAvmScheme; network?: string } = {}) {
      const signer = toClientAvmSigner(b64sk(payer.account.sk));
      const client = opts.scheme ? opts.scheme(signer) : new ClientAvmScheme(signer, { algodUrl: mock.url });
      const seen: { url: string; status: number; paymentSignature: string | null }[] = [];
      const recording: typeof fetch = async (input, init) => {
        const req = new Request(input as RequestInfo, init);
        const res = await fetch(req);
        seen.push({ url: req.url, status: res.status, paymentSignature: req.headers.get("PAYMENT-SIGNATURE") });
        return res;
      };
      const pay = wrapFetchWithPaymentFromConfig(recording, { schemes: [{ network: (opts.network ?? "algorand:*") as Network, client }] });
      return { pay, seen, signer };
    },

    async stop() {
      listening.server.close();
      (listening.server as unknown as http.Server).closeAllConnections?.();
      await httpFacilitator?.close();
      await mock.close();
    },
  };
}
type Stack = Awaited<ReturnType<typeof startStack>>;

const VARIANTS: Variant[] = [
  { net: "mainnet", advertise: "short", transport: "in-process" }, // the SDK constant ALGORAND_MAINNET_CAIP2
  { net: "mainnet", advertise: "full", transport: "in-process" }, // full genesis-hash id
  { net: "mainnet", advertise: "full", transport: "http" }, // likeliest production shape: real HTTPFacilitatorClient
  { net: "testnet", advertise: "short", transport: "in-process" },
  { net: "testnet", advertise: "full", transport: "in-process" },
];

/** Splits a base64 paymentGroup into the txns the client produced. */
function decodeClientGroup(signatureHeader: string) {
  const payload = decodeHeader(signatureHeader) as PaymentPayload & { payload: { paymentGroup: string[]; paymentIndex: number } };
  const raw = payload.payload.paymentGroup.map((g) => new Uint8Array(Buffer.from(g, "base64")));
  return { payload, raw };
}

describe.each(VARIANTS)("real client + real AVM facilitator: $net, advertised $advertise id, $transport facilitator", (variant) => {
  let s: Stack;
  const SHORT_CONSTANT = variant.net === "mainnet" ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2;

  beforeAll(async () => {
    s = await startStack(variant);
  });
  afterAll(async () => {
    await s.stop();
  });

  it("pays $0.02 for /v1/gems and gets data, a decodable receipt and a real on-ledger transfer", async () => {
    if (variant.advertise === "short") expect(s.advertised).toBe(SHORT_CONSTANT); // sanity: same as the SDK constant
    const payer = s.newPayer();
    const payerUsdcBefore = s.mock.assetOf(payer.address)!;
    const payerAlgoBefore = s.mock.algoOf(payer.address);
    const facAlgoBefore = s.mock.algoOf(s.facilitatorAddress);
    const { pay, seen, signer } = s.payingFetch(payer);
    expect(signer.address).toBe(payer.address);

    // createPayments resolved the facilitator's exact id for this chain (short SDK constant or full genesis hash).
    expect(await s.payments.ready()).toBe(s.advertised);

    // The price the unpaid 402 quotes (what scripts/pay.ts reads before paying).
    const quote = await fetch(`${s.base}/v1/gems?limit=2`);
    expect(quote.status).toBe(402);
    const required = decodeHeader(quote.headers.get("PAYMENT-REQUIRED"));
    const option = required.accepts[0];
    expect(option).toMatchObject({
      scheme: "exact",
      network: s.advertised, // exactly the facilitator's id
      amount: "20000", // $0.02 in 6-decimal USDC
      asset: s.usdc.toString(),
      payTo: s.merchant,
    });
    expect(option.extra.tag).toBe(CHALLENGE_TAG);
    expect(option.extra.feePayer).toBe(s.facilitatorAddress); // from /supported via the real scheme's getExtra

    // The paid call, through the real wrapped fetch.
    const res = await pay(`${s.base}/v1/gems?limit=2`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);

    // Two requests: the unpaid 402, then the paid retry carrying PAYMENT-SIGNATURE.
    expect(seen.map((x) => x.status)).toEqual([402, 200]);
    expect(seen[0].paymentSignature).toBeNull();
    const paymentSignature = seen[1].paymentSignature!;
    expect(paymentSignature).toBeTruthy();

    // PAYMENT-RESPONSE: present, decodes, and is the real settlement.
    const receiptHeader = res.headers.get("PAYMENT-RESPONSE");
    expect(receiptHeader).toBeTruthy();
    const receipt = decodePaymentResponseHeader(receiptHeader!);
    expect(receipt).toMatchObject({ success: true, network: s.advertised, payer: payer.address });
    expect(s.mock.sent).toHaveLength(1);
    const sent = s.mock.sent[0];
    expect(receipt.transaction).toBe(sent[1].txn.txID()); // the USDC transfer's txid

    // The real facilitator verified (simulated) and settled exactly once each; its verify accepted the group.
    expect(s.calls.verify).toHaveLength(1);
    expect(s.calls.verify[0].result).toEqual({ isValid: true, payer: payer.address });
    expect(s.calls.settle).toHaveLength(1);
    expect(s.calls.settle[0].result).toMatchObject({ success: true, payer: payer.address });
    expect(s.mock.simulations.every((x) => x.ok)).toBe(true);
    expect(s.mock.simulations.length).toBeGreaterThanOrEqual(2); // verify, and settle re-verifies

    // What the server asked the facilitator to verify: amount, asset, payTo, network and the challenge tag.
    const asked = s.calls.verify[0].requirements;
    expect(asked).toMatchObject({ scheme: "exact", network: s.advertised, amount: "20000", asset: s.usdc.toString(), payTo: s.merchant });
    expect(asked.extra).toMatchObject({ tag: CHALLENGE_TAG, feePayer: s.facilitatorAddress });
    const posted = s.calls.verify[0].payload;
    expect(posted.x402Version).toBe(2);
    expect(posted.accepted).toEqual(asked); // the client echoed the server's requirements verbatim
    expect((posted.accepted.extra as { tag?: string }).tag).toBe(CHALLENGE_TAG);

    // What the real client actually signed (decoded from the header it sent).
    const { payload, raw } = decodeClientGroup(paymentSignature);
    expect(payload.payload).toMatchObject({ paymentIndex: 1 });
    expect(raw).toHaveLength(2);
    const feeTxn = algosdk.decodeUnsignedTransaction(raw[0]); // unsigned: the facilitator signs its own fee payer txn
    expect(feeTxn.type).toBe("pay");
    expect(feeTxn.sender.toString()).toBe(s.facilitatorAddress);
    expect(feeTxn.payment!.amount).toBe(0n);
    expect(feeTxn.payment!.receiver.toString()).toBe(s.facilitatorAddress);
    expect(feeTxn.fee).toBe(2000n); // pays the whole group's min fee
    const payStxn = algosdk.decodeSignedTransaction(raw[1]);
    const axfer = payStxn.txn;
    expect(payStxn.sig).toBeDefined();
    expect(axfer.type).toBe("axfer");
    expect(axfer.sender.toString()).toBe(payer.address);
    expect(axfer.assetTransfer!.assetIndex).toBe(s.usdc);
    expect(axfer.assetTransfer!.amount).toBe(20_000n);
    expect(axfer.assetTransfer!.receiver.toString()).toBe(s.merchant);
    expect(axfer.fee).toBe(0n);
    expect(Buffer.from(axfer.genesisHash ?? []).toString("base64")).toBe(NETWORKS[variant.net].genesisHash);
    expect(axfer.genesisID).toBe(NETWORKS[variant.net].genesisId);
    expect(Buffer.from(axfer.note ?? []).toString("utf8")).toMatch(/^x402-payment-v2-\d+$/);
    // Validity window: the SDK's composer default is 10 rounds (~30 s on MainNet); the node allows up to 1000.
    expect(axfer.lastValid - axfer.firstValid).toBeGreaterThanOrEqual(5n);
    expect(axfer.lastValid - axfer.firstValid).toBeLessThanOrEqual(1000n);
    expect(Buffer.from(feeTxn.group!).toString("base64")).toBe(Buffer.from(axfer.group!).toString("base64"));
    expect(axfer.rekeyTo).toBeUndefined();

    // What landed on the (mock) chain: the fee payer's txn is now signed by the facilitator, the payer's by the payer.
    expect(sent).toHaveLength(2);
    expect(sent.every((t) => t.sig)).toBe(true);
    expect(sent[0].txn.sender.toString()).toBe(s.facilitatorAddress);
    expect(sent[1].txn.sender.toString()).toBe(payer.address);

    // Ledger effects: merchant +20000 USDC, payer -20000 USDC and pays no ALGO (gasless), facilitator paid the 2000 fee.
    expect(s.mock.assetOf(s.merchant)).toBe(20_000n);
    expect(s.mock.assetOf(payer.address)).toBe(payerUsdcBefore - 20_000n);
    expect(s.mock.algoOf(payer.address)).toBe(payerAlgoBefore);
    expect(s.mock.algoOf(s.facilitatorAddress)).toBe(facAlgoBefore - 2000n);

    // The SDK only used algod endpoints we model; none was unknown, and no API token was sent.
    expect(s.mock.unexpected).toEqual([]);
    expect(s.mock.endpointsHit()).toEqual([
      "GET /v2/status",
      "GET /v2/transactions/params",
      "GET /v2/transactions/pending/{txid}",
      "POST /v2/transactions",
      "POST /v2/transactions/simulate",
    ]);
    expect(s.mock.requests.some((r) => r.headers["x-algo-api-token"])).toBe(false);
  });

  it("does NOT settle a paid call that ends in 4xx (asset not found, bad params)", async () => {
    for (const [path, status] of [
      ["/v1/asset?asset=doesnotexist", 404],
      ["/v1/gems?limit=500", 400],
    ] as const) {
      const payer = s.newPayer();
      const before = { verify: s.calls.verify.length, settle: s.calls.settle.length, sent: s.mock.sent.length, usdc: s.mock.assetOf(payer.address) };
      const { pay, seen } = s.payingFetch(payer);
      const res = await pay(`${s.base}${path}`);
      expect(res.status, path).toBe(status);
      expect(res.headers.get("PAYMENT-RESPONSE"), path).toBeNull();
      expect(seen.map((x) => x.status), path).toEqual([402, status]);
      // The payment was really verified by the real facilitator (so it was a valid payment) ...
      expect(s.calls.verify.length - before.verify, path).toBe(1);
      expect(s.calls.verify.at(-1)!.result.isValid, path).toBe(true);
      // ... but settle was never called and nothing went on-chain, so the payer kept their USDC.
      expect(s.calls.settle.length, path).toBe(before.settle);
      expect(s.mock.sent.length, path).toBe(before.sent);
      expect(s.mock.assetOf(payer.address), path).toBe(before.usdc);
    }
  });

  it("rejects payments the real verification must reject, and never settles them", async () => {
    type Tamper = { name: string; reason: string; scheme: (signer: ReturnType<typeof toClientAvmSigner>, s: Stack) => ClientAvmScheme };
    const cheat = (mutate: (r: PaymentRequirements, s: Stack) => PaymentRequirements) => (signer: ReturnType<typeof toClientAvmSigner>, st: Stack) => {
      const inner = new ClientAvmScheme(signer, { algodUrl: st.mock.url });
      return Object.assign(inner, {
        // Sign a transfer that differs from what the server required; `accepted` still echoes the true requirements.
        createPaymentPayload: (version: number, reqs: PaymentRequirements) => ClientAvmScheme.prototype.createPaymentPayload.call(inner, version, mutate(reqs, st)),
      });
    };
    const tampers: Tamper[] = [
      { name: "underpays (1 instead of 20000)", reason: "invalid_exact_avm_amount_mismatch", scheme: cheat((r) => ({ ...r, amount: "1" })) },
      { name: "pays someone else", reason: "invalid_exact_avm_receiver_mismatch", scheme: cheat((r) => ({ ...r, payTo: algosdk.generateAccount().addr.toString() })) },
      { name: "pays the wrong ASA", reason: "invalid_exact_avm_asset_mismatch", scheme: cheat((r, st) => ({ ...r, asset: (st.usdc + 1n).toString() })) },
    ];
    for (const t of tampers) {
      const payer = s.newPayer();
      // The wrong-ASA payer needs that ASA to exist in their account, otherwise the amount/asset check still comes first anyway.
      const before = { settle: s.calls.settle.length, sent: s.mock.sent.length, merchant: s.mock.assetOf(s.merchant) };
      const { pay } = s.payingFetch(payer, { scheme: (signer) => t.scheme(signer, s) });
      const res = await pay(`${s.base}/v1/gems?limit=1`);
      expect(res.status, t.name).toBe(402);
      expect(res.headers.get("PAYMENT-RESPONSE"), t.name).toBeNull();
      expect(s.calls.verify.at(-1)!.result, t.name).toMatchObject({ isValid: false, invalidReason: t.reason });
      expect(decodeHeader(res.headers.get("PAYMENT-REQUIRED")).error, t.name).toBe(t.reason);
      expect(s.calls.settle.length, t.name).toBe(before.settle);
      expect(s.mock.sent.length, t.name).toBe(before.sent);
      expect(s.mock.assetOf(s.merchant), t.name).toBe(before.merchant);
    }
  });

  it("rejects (simulation fails) a payer who is not opted in to USDC, has too little USDC, or cannot pay the ALGO minimum", async () => {
    const cases = [
      { name: "not opted in", payer: s.newPayer({ usdc: null }), message: /missing from/ },
      { name: "balance below price", payer: s.newPayer({ usdc: 19_999n }), message: /underflow/ },
      { name: "below min balance", payer: s.newPayer({ algo: 50_000n }), message: /below min/ },
    ];
    for (const c of cases) {
      const before = { settle: s.calls.settle.length, sent: s.mock.sent.length };
      const { pay } = s.payingFetch(c.payer);
      const res = await pay(`${s.base}/v1/gems?limit=1`);
      expect(res.status, c.name).toBe(402);
      const last = s.calls.verify.at(-1)!.result;
      expect(last, c.name).toMatchObject({ isValid: false, invalidReason: "invalid_exact_avm_simulation_failed" });
      expect(last.invalidMessage, c.name).toMatch(c.message);
      // The client only learns the reason code, from the re-issued PAYMENT-REQUIRED header (the body is {}).
      expect(decodeHeader(res.headers.get("PAYMENT-REQUIRED")).error, c.name).toBe("invalid_exact_avm_simulation_failed");
      expect(s.calls.settle.length, c.name).toBe(before.settle);
      expect(s.mock.sent.length, c.name).toBe(before.sent);
    }
  });

  it("cannot be paid while payTo is not opted in to USDC (receiver error), and nothing settles", async () => {
    const receiver = s.mock.accounts.get(s.merchant)!;
    const optedIn = receiver.assets.get(s.usdc)!;
    receiver.assets.delete(s.usdc); // operational mistake: PAY_TO never opted in to the ASA
    try {
      const payer = s.newPayer();
      const before = { settle: s.calls.settle.length, sent: s.mock.sent.length };
      const res = await s.payingFetch(payer).pay(`${s.base}/v1/gems?limit=1`);
      expect(res.status).toBe(402);
      expect(s.calls.verify.at(-1)!.result).toMatchObject({ isValid: false, invalidReason: "invalid_exact_avm_simulation_failed" });
      expect(s.calls.verify.at(-1)!.result.invalidMessage).toMatch(/must optin/);
      expect(s.calls.settle.length).toBe(before.settle);
      expect(s.mock.sent.length).toBe(before.sent);
      expect(s.mock.assetOf(payer.address)).toBe(1_000_000n); // payer not charged
    } finally {
      receiver.assets.set(s.usdc, optedIn);
    }
  });

  it("rejects a group the client built against the wrong network (genesis hash mismatch)", async () => {
    const wrong = await MockAlgod.start(variant.net === "mainnet" ? "testnet" : "mainnet");
    try {
      const payer = s.newPayer();
      const before = { settle: s.calls.settle.length, sent: s.mock.sent.length };
      // The client is pointed at the other chain's node, so it signs that chain's genesis.
      const { pay } = s.payingFetch(payer, { scheme: (signer) => new ClientAvmScheme(signer, { algodUrl: wrong.url }) });
      const res = await pay(`${s.base}/v1/gems?limit=1`);
      expect(res.status).toBe(402);
      expect(s.calls.verify.at(-1)!.result.invalidMessage).toMatch(/genesis hash/);
      expect(s.calls.settle.length).toBe(before.settle);
      expect(s.mock.sent.length).toBe(before.sent);
    } finally {
      await wrong.close();
    }
  });

  it("rejects a replay of an already-settled PAYMENT-SIGNATURE (no second charge, no second delivery)", async () => {
    const payer = s.newPayer();
    const { pay, seen } = s.payingFetch(payer);
    const first = await pay(`${s.base}/v1/gems?limit=1`);
    expect(first.status).toBe(200);
    const sig = seen.find((x) => x.paymentSignature)!.paymentSignature!;
    const settledBefore = s.calls.settle.length;
    const sentBefore = s.mock.sent.length;
    const replay = await fetch(`${s.base}/v1/gems?limit=1`, { headers: { "PAYMENT-SIGNATURE": sig } });
    expect(replay.status).toBe(402);
    expect(replay.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(s.calls.verify.at(-1)!.result).toMatchObject({ isValid: false, invalidReason: "invalid_exact_avm_simulation_failed" });
    expect(s.calls.verify.at(-1)!.result.invalidMessage).toMatch(/already in ledger/);
    expect(s.calls.settle.length).toBe(settledBefore);
    expect(s.mock.sent.length).toBe(sentBefore);
  });

  it("delivers to only ONE of two simultaneous calls carrying the same PAYMENT-SIGNATURE (no double spend, no free second delivery)", async () => {
    const payer = s.newPayer();
    const signer = toClientAvmSigner(b64sk(payer.account.sk));
    const client = x402Client.fromConfig({ schemes: [{ network: "algorand:*" as Network, client: new ClientAvmScheme(signer, { algodUrl: s.mock.url }) }] });
    const http = new x402HTTPClient(client);
    const unpaid = await fetch(`${s.base}/v1/gems?limit=1`);
    const required = http.getPaymentRequiredResponse((n) => unpaid.headers.get(n), await unpaid.json());
    const header = http.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
    const before = { sent: s.mock.sent.length, merchant: s.mock.assetOf(s.merchant)! };

    const results = await Promise.all([1, 2].map(() => fetch(`${s.base}/v1/gems?limit=1`, { headers: header })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 402]);
    const loser = results.find((r) => r.status === 402)!;
    // The loser gets no data and is told why: usually "settlement failed" (PAYMENT-RESPONSE success:false, the node
    // refused the duplicate), or, if it lost the race earlier, a verification error in PAYMENT-REQUIRED.
    const receipt = loser.headers.get("PAYMENT-RESPONSE");
    if (receipt) expect(decodePaymentResponseHeader(receipt).success).toBe(false);
    else expect(decodeHeader(loser.headers.get("PAYMENT-REQUIRED")).error).toBeTruthy();
    expect(await loser.text()).not.toContain('"data"');
    expect(s.mock.sent.length - before.sent).toBe(1);
    expect(s.mock.assetOf(s.merchant)! - before.merchant).toBe(20_000n);
    expect(s.mock.assetOf(payer.address)).toBe(1_000_000n - 20_000n);
  });

  it("charges each paid endpoint its own price (screen $0.01 = 10000, digest $0.03 = 30000)", async () => {
    for (const [path, amount] of [["/v1/screen", 10_000n], ["/v1/digest", 30_000n]] as const) {
      const payer = s.newPayer();
      const merchantBefore = s.mock.assetOf(s.merchant)!;
      const { pay } = s.payingFetch(payer);
      const res = await pay(`${s.base}${path}`);
      expect(res.status, path).toBe(200);
      expect(s.mock.assetOf(s.merchant)! - merchantBefore, path).toBe(amount);
      expect(s.mock.assetOf(payer.address), path).toBe(1_000_000n - amount);
    }
  });

  it("also works when the client registers the exact network id it was quoted instead of the wildcard", async () => {
    const payer = s.newPayer();
    const { pay } = s.payingFetch(payer, { network: s.advertised });
    const res = await pay(`${s.base}/v1/gems?limit=1`);
    expect(res.status).toBe(200);
    expect(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!).network).toBe(s.advertised);
  });
});

/**
 * The REAL scripts/pay.ts, unmodified, as a child process. Its only algod
 * access is the SDK default (AlgoNode, no token); test/redirect-algod.mjs
 * re-points exactly those two AlgoNode hosts at the mock, so this also proves
 * pay.ts needs no algodUrl/algodToken configuration and sends no token.
 */
describe("scripts/pay.ts against the real stack", () => {
  const variants: Variant[] = [
    { net: "mainnet", advertise: "full", transport: "http" },
    { net: "testnet", advertise: "short", transport: "in-process" },
  ];

  async function runPay(s: Stack, url: string, env: Record<string, string>) {
    const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
    const child = spawn(tsx, ["scripts/pay.ts", url], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${path.join(ROOT, "test", "redirect-algod.mjs")}`,
        MOCK_ALGOD_MAINNET: s.mock.network === "mainnet" ? s.mock.url : "http://127.0.0.1:1",
        MOCK_ALGOD_TESTNET: s.mock.network === "testnet" ? s.mock.url : "http://127.0.0.1:1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    if (process.env.E2E_DEBUG) console.log(`--- pay.ts exit ${code}\n${stdout}${stderr ? `--- stderr\n${stderr}` : ""}`);
    return { code, stdout, stderr };
  }

  for (const v of variants) {
    describe(`${v.net}, advertised ${v.advertise} id`, () => {
      let s: Stack;
      beforeAll(async () => {
        s = await startStack(v);
      });
      afterAll(async () => {
        await s.stop();
      });

      it("prints the quote, pays with the mnemonic's account, settles on the ledger and prints the receipt", async () => {
        const payer = s.newPayer();
        const r = await runPay(s, `${s.base}/v1/gems?limit=3`, { AVM_MNEMONIC: `  ${payer.mnemonic}\n` }); // .trim() is applied
        expect(r.stderr).not.toMatch(/Error/);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain(`price: 0.02 USDC (ASA ${s.usdc}) on ${s.advertised}, payTo ${s.merchant}, tag ${CHALLENGE_TAG}`);
        expect(r.stdout).toContain(`payer: ${payer.address}`);
        expect(r.stdout).toContain("HTTP 200");
        const receipt = JSON.parse(/settlement: (\{.*\})/.exec(r.stdout)![1]);
        expect(receipt).toMatchObject({ success: true, network: s.advertised, payer: payer.address });
        expect(s.mock.sent).toHaveLength(1);
        expect(receipt.transaction).toBe(s.mock.sent[0][1].txn.txID());
        expect(s.mock.sent[0][1].txn.sender.toString()).toBe(payer.address);
        expect(s.mock.assetOf(s.merchant)).toBe(20_000n);
        expect(s.calls.settle).toHaveLength(1);
        expect(s.mock.unexpected).toEqual([]);
        // pay.ts configures no algod: the SDK default needs no token, and none was sent.
        expect(s.mock.requests.length).toBeGreaterThan(0);
        expect(s.mock.requests.some((x) => x.headers["x-algo-api-token"])).toBe(false);
      }, 60_000);

      it("reports HTTP 402 (and the payer is not charged) when the payer has no USDC opt-in", async () => {
        const payer = s.newPayer({ usdc: null });
        const before = { sent: s.mock.sent.length, settle: s.calls.settle.length };
        const r = await runPay(s, `${s.base}/v1/gems`, { AVM_MNEMONIC: payer.mnemonic });
        expect(r.stdout).toContain(`payer: ${payer.address}`);
        expect(r.stdout).toContain("HTTP 402");
        expect(r.stdout).not.toContain("settlement:");
        expect(s.mock.sent.length).toBe(before.sent);
        expect(s.calls.settle.length).toBe(before.settle);
        expect(s.calls.verify.at(-1)!.result).toMatchObject({ isValid: false, invalidReason: "invalid_exact_avm_simulation_failed" });
      }, 60_000);

      it("refuses to sign when the quote is above MAX_USD, before any algod call", async () => {
        const payer = s.newPayer();
        const requestsBefore = s.mock.requests.length;
        const r = await runPay(s, `${s.base}/v1/digest`, { AVM_MNEMONIC: payer.mnemonic, MAX_USD: "0.02" }); // digest costs 0.03
        expect(r.code).not.toBe(0);
        expect(r.stderr).toMatch(/quoted 0\.03 USDC is over MAX_USD=0\.02/);
        expect(r.stdout).toContain("price: 0.03 USDC");
        expect(s.mock.requests.length).toBe(requestsBefore);
        expect(s.mock.assetOf(payer.address)).toBe(1_000_000n);
      }, 60_000);
    });
  }
});

/**
 * pay.ts checks the price once (MAX_USD) on its own pre-flight request, but
 * the wrapped fetch then fetches a SECOND 402 and signs whatever it says.
 * What protects that second quote is the SDK's default spendControls: USDC
 * only, at most $1 per payment. pay.ts relies on this silently, so pin it.
 */
describe("the client pay.ts builds refuses a re-quote above $1 or in a non-USDC asset (SDK default spendControls)", () => {
  const quoteFetch = (amount: string, asset: string): typeof fetch => async () =>
    new Response("{}", {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({
          x402Version: 2,
          resource: { url: "http://example.test/v1/gems" },
          accepts: [{
            scheme: "exact", network: NETWORKS.mainnet.caipFull, amount, asset,
            payTo: algosdk.generateAccount().addr.toString(), maxTimeoutSeconds: 300, extra: {},
          }],
        })).toString("base64"),
      },
    });
  const client = () => new ClientAvmScheme(toClientAvmSigner(b64sk(algosdk.generateAccount().sk)), { algodUrl: "http://127.0.0.1:1" });

  it.each([
    ["$5 of USDC", "5000000", "31566704", /spendControls\.maxAmountPerPayment \(\$1/],
    ["a non-USDC ASA", "20000", "999", /only default assets/],
  ])("rejects %s before any signing or algod call", async (_name, amount, asset, message) => {
    const pay = wrapFetchWithPaymentFromConfig(quoteFetch(amount, asset), { schemes: [{ network: "algorand:*", client: client() }] });
    await expect(pay("http://example.test/v1/gems")).rejects.toThrow(message);
  });
});
