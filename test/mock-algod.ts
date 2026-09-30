/**
 * A tiny in-memory Algorand node (algod) for end-to-end tests.
 *
 * It speaks just enough of the algod REST API for the REAL @x402/avm client
 * scheme (ExactAvmScheme from "@x402/avm/exact/client") and the REAL
 * facilitator scheme (ExactAvmScheme from "@x402/avm/exact/facilitator", via
 * toFacilitatorAvmSigner) to run unmodified against it:
 *
 *   GET  /v2/transactions/params      client: suggested params (genesis id/hash, min fee, round)
 *   POST /v2/transactions/simulate    facilitator verify: msgpack in, msgpack out
 *   POST /v2/transactions             facilitator settle: raw concatenated signed txns, JSON {txId} out
 *   GET  /v2/status                   facilitator settle: waitForConfirmation
 *   GET  /v2/transactions/pending/ID  facilitator settle: waitForConfirmation (msgpack)
 *   GET  /v2/accounts/ADDR[/assets/N] not called by the SDK today; here for completeness
 *
 * Unlike a rubber stamp it keeps a small ledger and applies real rules to a
 * group before it accepts a simulate or a send: ed25519 signatures, genesis
 * hash/id of the chosen network, validity window, group id, pooled min fee,
 * ASA opt-in (sender AND receiver), ASA balance, ALGO balance/min balance and
 * "already in ledger" replay protection. Anything it does not implement
 * answers 404 and is recorded in `unexpected`, so a test can prove the SDK
 * only touched endpoints we model.
 */
import { createPublicKey, verify as edVerify } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import algosdk from "algosdk";

export type NetName = "mainnet" | "testnet";

export const NETWORKS: Record<NetName, { genesisId: string; genesisHash: string; usdc: bigint; caipShort: string; caipFull: string }> = {
  mainnet: {
    genesisId: "mainnet-v1.0",
    genesisHash: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    usdc: 31566704n,
    caipShort: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k",
    caipFull: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
  },
  testnet: {
    genesisId: "testnet-v1.0",
    genesisHash: "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
    usdc: 10458941n,
    caipShort: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
    caipFull: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
  },
};

const MIN_FEE = 1000n;
const BASE_MIN_BALANCE = 100_000n;
const PER_ASSET_MIN_BALANCE = 100_000n;
const MAX_GROUP = 16;
const MAX_VALIDITY = 1000n;
const CONSENSUS = "https://github.com/algorandfoundation/specs/tree/a0fe3e2e3d8f7e4b3e6d3d3e1f0f4c2d0b8c5a44";

export interface AccountState {
  algo: bigint;
  /** asset id -> balance; presence of the key means "opted in". */
  assets: Map<bigint, bigint>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

type Verdict = { ok: true; commit: () => void; ids: string[] } | { ok: false; message: string; failedAt: number };

/** Returns the end offset of the msgpack value that starts at `i` (used to split concatenated signed txns). */
export function msgpackEnd(b: Uint8Array, i = 0): number {
  const u16 = (o: number) => (b[o] << 8) | b[o + 1];
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const t = b[i++];
  if (t === undefined) throw new Error("truncated msgpack");
  if (t <= 0x7f || t >= 0xe0) return i;
  if (t >= 0x80 && t <= 0x8f) {
    for (let n = (t & 0x0f) * 2; n > 0; n--) i = msgpackEnd(b, i);
    return i;
  }
  if (t >= 0x90 && t <= 0x9f) {
    for (let n = t & 0x0f; n > 0; n--) i = msgpackEnd(b, i);
    return i;
  }
  if (t >= 0xa0 && t <= 0xbf) return i + (t & 0x1f);
  switch (t) {
    case 0xc0: case 0xc2: case 0xc3: return i;
    case 0xc4: case 0xd9: return i + 1 + b[i];
    case 0xc5: case 0xda: return i + 2 + u16(i);
    case 0xc6: case 0xdb: return i + 4 + u32(i);
    case 0xc7: return i + 2 + b[i];
    case 0xc8: return i + 3 + u16(i);
    case 0xc9: return i + 5 + u32(i);
    case 0xca: return i + 4;
    case 0xcb: return i + 8;
    case 0xcc: case 0xd0: return i + 1;
    case 0xcd: case 0xd1: return i + 2;
    case 0xce: case 0xd2: return i + 4;
    case 0xcf: case 0xd3: return i + 8;
    case 0xd4: return i + 2;
    case 0xd5: return i + 3;
    case 0xd6: return i + 5;
    case 0xd7: return i + 9;
    case 0xd8: return i + 17;
    case 0xdc: case 0xdd: {
      let n = t === 0xdc ? u16(i) : u32(i);
      i += t === 0xdc ? 2 : 4;
      for (; n > 0; n--) i = msgpackEnd(b, i);
      return i;
    }
    case 0xde: case 0xdf: {
      let n = t === 0xde ? u16(i) : u32(i);
      i += t === 0xde ? 2 : 4;
      for (n *= 2; n > 0; n--) i = msgpackEnd(b, i);
      return i;
    }
    default:
      throw new Error(`bad msgpack type 0x${t.toString(16)}`);
  }
}

/** Splits `POST /v2/transactions` bodies (concatenated msgpack signed txns). */
export function splitSignedTxns(body: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < body.length; ) {
    const end = msgpackEnd(body, i);
    out.push(body.subarray(i, end));
    i = end;
  }
  return out;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function ed25519Verify(msg: Uint8Array, sig: Uint8Array, pub: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pub)]), format: "der", type: "spki" });
    return edVerify(null, msg, key, sig);
  } catch {
    return false;
  }
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

export class MockAlgod {
  readonly net: (typeof NETWORKS)[NetName];
  readonly accounts = new Map<string, AccountState>();
  lastRound = 40_000_000n;
  /** Every HTTP request received, in order. */
  readonly requests: RecordedRequest[] = [];
  /** Requests to endpoints this mock does not model (answered 404). */
  readonly unexpected: string[] = [];
  /** Signed groups accepted by POST /v2/transactions. */
  readonly sent: algosdk.SignedTransaction[][] = [];
  /** Simulated groups with their verdicts. */
  readonly simulations: { ok: boolean; message?: string }[] = [];
  /** Confirmed txid -> signed txn (wire object) for /pending/{txid}. */
  private readonly confirmed = new Map<string, Record<string, unknown>>();
  private server!: http.Server;
  url = "";

  constructor(readonly network: NetName) {
    this.net = NETWORKS[network];
  }

  static async start(network: NetName): Promise<MockAlgod> {
    const m = new MockAlgod(network);
    m.server = http.createServer((req, res) => void m.handle(req, res));
    await new Promise<void>((resolve) => m.server.listen(0, "127.0.0.1", resolve));
    m.url = `http://127.0.0.1:${(m.server.address() as AddressInfo).port}`;
    return m;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Creates or tops up an account. `assets` are opted-in ASA balances (0n = opted in, empty). */
  fund(addr: string, opts: { algo?: bigint; assets?: Record<string, bigint> }): AccountState {
    const acct = this.accounts.get(addr) ?? { algo: 0n, assets: new Map<bigint, bigint>() };
    acct.algo += opts.algo ?? 0n;
    for (const [id, amt] of Object.entries(opts.assets ?? {})) acct.assets.set(BigInt(id), (acct.assets.get(BigInt(id)) ?? 0n) + amt);
    this.accounts.set(addr, acct);
    return acct;
  }

  algoOf(addr: string): bigint {
    return this.accounts.get(addr)?.algo ?? 0n;
  }
  assetOf(addr: string, id: bigint = this.net.usdc): bigint | undefined {
    return this.accounts.get(addr)?.assets.get(id);
  }

  /** Paths (method + path with ids masked) that were requested, deduplicated. */
  endpointsHit(): string[] {
    const mask = (p: string) => p.replace(/\/pending\/[A-Z2-7]+$/, "/pending/{txid}").replace(/\/accounts\/[A-Z2-7]{58}/, "/accounts/{addr}");
    return [...new Set(this.requests.map((r) => `${r.method} ${mask(r.path)}`))].sort();
  }

  // ---------------------------------------------------------------- ledger rules

  /** Applies algod's group checks to a scratch copy of the ledger. */
  private evaluate(stxns: algosdk.SignedTransaction[]): Verdict {
    const fail = (message: string, failedAt = 0): Verdict => ({ ok: false, message, failedAt });
    if (stxns.length === 0) return fail("empty transaction group");
    if (stxns.length > MAX_GROUP) return fail(`transaction group size ${stxns.length} exceeds ${MAX_GROUP}`);
    const ids = stxns.map((s) => s.txn.txID());

    // Stateless checks, per transaction.
    for (const [i, s] of stxns.entries()) {
      const t = s.txn;
      const id = ids[i];
      if (this.confirmed.has(id)) return fail(`transaction already in ledger: ${id}`, i);
      if (b64(t.genesisHash ?? new Uint8Array()) !== this.net.genesisHash) {
        return fail(`transaction ${id}: genesis hash ${b64(t.genesisHash ?? new Uint8Array())} does not match this network (${this.net.genesisId})`, i);
      }
      if (t.genesisID && t.genesisID !== this.net.genesisId) {
        return fail(`transaction ${id}: genesis id ${t.genesisID} does not match this network (${this.net.genesisId})`, i);
      }
      const round = this.lastRound + 1n;
      if (round < t.firstValid || round > t.lastValid) {
        return fail(`transaction ${id}: txn dead: round ${round} outside of ${t.firstValid}--${t.lastValid}`, i);
      }
      if (t.lastValid - t.firstValid > MAX_VALIDITY) return fail(`transaction ${id}: window too large`, i);
      if (!s.sig && !s.msig && !s.lsig) return fail(`transaction ${id}: signedtxn has no sig`, i);
      if (s.sig) {
        const signer = s.sgnr ?? t.sender;
        if (!ed25519Verify(t.bytesToSign(), s.sig, signer.publicKey)) return fail(`transaction ${id}: signature validation failed`, i);
      }
    }

    // Group id: every member carries the hash of the group (or it is a lone txn).
    if (stxns.length > 1) {
      const bare = stxns.map((s) => {
        const c = algosdk.decodeUnsignedTransaction(algosdk.encodeUnsignedTransaction(s.txn));
        c.group = undefined;
        return c;
      });
      const want = b64(algosdk.computeGroupID(bare));
      for (const [i, s] of stxns.entries()) {
        if (!s.txn.group || b64(s.txn.group) !== want) return fail("transactionGroup: inconsistent group values", i);
      }
    } else if (stxns[0].txn.group) {
      return fail("transactionGroup: group of one with a group id", 0);
    }

    // Pooled fee: the group must pay at least MIN_FEE per member in total.
    const totalFee = stxns.reduce((n, s) => n + s.txn.fee, 0n);
    if (totalFee < MIN_FEE * BigInt(stxns.length)) {
      return fail(`transaction ${ids[0]}: pooled fee ${totalFee} below threshold ${MIN_FEE * BigInt(stxns.length)}`, 0);
    }

    // Stateful checks against a scratch copy of the touched accounts.
    const scratch = new Map<string, AccountState>();
    const get = (addr: string): AccountState | undefined => {
      let a = scratch.get(addr);
      if (!a) {
        const real = this.accounts.get(addr);
        if (!real) return undefined;
        a = { algo: real.algo, assets: new Map(real.assets) };
        scratch.set(addr, a);
      }
      return a;
    };
    const touched = new Set<string>();
    for (const [i, s] of stxns.entries()) {
      const t = s.txn;
      const sender = t.sender.toString();
      const from = get(sender);
      if (!from) return fail(`transaction ${ids[i]}: account ${sender} does not exist`, i);
      touched.add(sender);
      if (from.algo < t.fee) return fail(`transaction ${ids[i]}: overspend (account ${sender}, tried to spend {${t.fee}})`, i);
      from.algo -= t.fee;
      if (t.type === "pay" && t.payment) {
        const to = t.payment.receiver.toString();
        if (t.payment.closeRemainderTo) return fail(`transaction ${ids[i]}: closeRemainderTo not modelled`, i);
        if (from.algo < t.payment.amount) return fail(`transaction ${ids[i]}: overspend (account ${sender}, tried to spend {${t.payment.amount}})`, i);
        from.algo -= t.payment.amount;
        const dest = get(to) ?? (scratch.set(to, { algo: 0n, assets: new Map() }), scratch.get(to)!);
        dest.algo += t.payment.amount;
        touched.add(to);
      } else if (t.type === "axfer" && t.assetTransfer) {
        const x = t.assetTransfer;
        const to = x.receiver.toString();
        if (x.closeRemainderTo || x.assetSender) return fail(`transaction ${ids[i]}: clawback/close not modelled`, i);
        const have = from.assets.get(x.assetIndex);
        if (have === undefined) return fail(`transaction ${ids[i]}: asset ${x.assetIndex} missing from ${sender}`, i);
        if (have < x.amount) return fail(`transaction ${ids[i]}: underflow on subtracting ${x.amount} from sender amount ${have}`, i);
        from.assets.set(x.assetIndex, have - x.amount);
        const dest = get(to);
        if (!dest || dest.assets.get(x.assetIndex) === undefined) {
          return fail(`transaction ${ids[i]}: receiver error: must optin, asset ${x.assetIndex} missing from ${to}`, i);
        }
        dest.assets.set(x.assetIndex, dest.assets.get(x.assetIndex)! + x.amount);
        touched.add(to);
      } else {
        return fail(`transaction ${ids[i]}: type ${t.type} not modelled by the mock`, i);
      }
      if (t.rekeyTo) return fail(`transaction ${ids[i]}: rekey not modelled`, i);
    }
    for (const addr of touched) {
      const a = scratch.get(addr)!;
      const min = BASE_MIN_BALANCE + PER_ASSET_MIN_BALANCE * BigInt(a.assets.size);
      if (a.algo < min) return fail(`account ${addr} balance ${a.algo} below min ${min} (${a.assets.size} assets)`, 0);
    }
    return {
      ok: true,
      ids,
      commit: () => {
        for (const [addr, a] of scratch) this.accounts.set(addr, a);
      },
    };
  }

  // ---------------------------------------------------------------- HTTP

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";
    this.requests.push({ method, path: url.pathname, headers: req.headers });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = new Uint8Array(Buffer.concat(chunks));
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const msgpack = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/msgpack" });
      res.end(Buffer.from(algosdk.msgpackRawEncode(obj as Record<string, unknown>)));
    };
    try {
      const p = url.pathname;
      let m: RegExpExecArray | null;
      if (method === "GET" && p === "/v2/transactions/params") {
        // Real nodes answer fee: 0 (per-byte fee) and min-fee: 1000.
        return json(200, {
          "consensus-version": CONSENSUS,
          fee: 0,
          "genesis-hash": this.net.genesisHash,
          "genesis-id": this.net.genesisId,
          "last-round": Number(this.lastRound),
          "min-fee": Number(MIN_FEE),
        });
      }
      if (method === "GET" && (p === "/health" || p === "/ready")) return json(200, {});
      if (method === "GET" && p === "/versions") {
        return json(200, { genesis_id: this.net.genesisId, genesis_hash_b64: this.net.genesisHash, build: {}, versions: ["v2"] });
      }
      if (method === "GET" && (p === "/v2/status" || (m = /^\/v2\/status\/wait-for-block-after\/\d+$/.exec(p)))) {
        return json(200, {
          "catchup-time": 0,
          "last-round": Number(this.lastRound),
          "last-version": CONSENSUS,
          "next-version": CONSENSUS,
          "next-version-round": Number(this.lastRound) + 1,
          "next-version-supported": true,
          "stopped-at-unsupported-round": false,
          "time-since-last-round": 1_000_000_000,
        });
      }
      if (method === "POST" && p === "/v2/transactions/simulate") {
        const reqModel = algosdk.decodeMsgpack(body, algosdk.modelsv2.SimulateRequest);
        const group = reqModel.txnGroups[0]?.txns ?? [];
        const verdict = this.evaluate(group);
        this.simulations.push(verdict.ok ? { ok: true } : { ok: false, message: verdict.message });
        const results = group.map((s) => ({ "txn-result": { "pool-error": "", txn: algosdk.msgpackRawDecode(algosdk.encodeMsgpack(s)) } }));
        return msgpack(200, {
          version: 2,
          "last-round": Number(this.lastRound),
          "txn-groups": [
            verdict.ok
              ? { "txn-results": results }
              : { "txn-results": results, "failure-message": verdict.message, "failed-at": [verdict.failedAt] },
          ],
        });
      }
      if (method === "POST" && p === "/v2/transactions") {
        const group = splitSignedTxns(body).map((raw) => algosdk.decodeSignedTransaction(raw));
        const verdict = this.evaluate(group);
        if (!verdict.ok) return json(400, { message: `TransactionPool.Remember: ${verdict.message}` });
        verdict.commit();
        this.lastRound += 1n;
        this.sent.push(group);
        group.forEach((s, i) => this.confirmed.set(verdict.ids[i], algosdk.msgpackRawDecode(algosdk.encodeMsgpack(s)) as Record<string, unknown>));
        return json(200, { txId: verdict.ids[0] });
      }
      if (method === "GET" && (m = /^\/v2\/transactions\/pending\/([A-Z2-7]+)$/.exec(p))) {
        const txn = this.confirmed.get(m[1]);
        if (!txn) return json(404, { message: "Transaction not found" });
        return msgpack(200, { "confirmed-round": Number(this.lastRound), "pool-error": "", txn });
      }
      if (method === "GET" && (m = /^\/v2\/accounts\/([A-Z2-7]{58})(?:\/assets\/(\d+))?$/.exec(p))) {
        const acct = this.accounts.get(m[1]);
        if (!acct) return json(404, { message: "account not found" });
        const assets = [...acct.assets].map(([id, amount]) => ({ "asset-id": Number(id), amount: Number(amount), "is-frozen": false }));
        if (m[2]) {
          const a = assets.find((x) => x["asset-id"] === Number(m![2]));
          return a ? json(200, { "asset-holding": a, round: Number(this.lastRound) }) : json(404, { message: "asset holding not found" });
        }
        const min = Number(BASE_MIN_BALANCE + PER_ASSET_MIN_BALANCE * BigInt(acct.assets.size));
        return json(200, {
          address: m[1], amount: Number(acct.algo), "amount-without-pending-rewards": Number(acct.algo), "min-balance": min,
          "pending-rewards": 0, rewards: 0, round: Number(this.lastRound), status: "Offline", assets,
          "total-apps-opted-in": 0, "total-assets-opted-in": assets.length, "total-created-apps": 0, "total-created-assets": 0,
        });
      }
      this.unexpected.push(`${method} ${p}`);
      return json(404, { message: `mock-algod: ${method} ${p} is not modelled` });
    } catch (err) {
      this.unexpected.push(`${method} ${url.pathname} -> ${String(err)}`);
      return json(400, { message: `mock-algod: ${String(err)}` });
    }
  }
}
