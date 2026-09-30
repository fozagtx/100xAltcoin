/**
 * scripts/pay.ts builds its signer as
 *     algosdk.mnemonicToSecretKey(mnemonic).sk -> base64 -> toClientAvmSigner()
 * while the official Algorand x402 demo client (x402-examples/client/fetch)
 * uses algokit's seedFromMnemonic + ed25519 wrapped-secret pubkey, concatenates
 * seed||pubkey and base64-encodes that. This proves both give the SAME key,
 * address and signatures, so pay.ts pays from the account the mnemonic names.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { seedFromMnemonic } from "@algorandfoundation/algokit-utils/algo25";
import { ed25519SigningKeyFromWrappedSecret, type WrappedEd25519Seed } from "@algorandfoundation/algokit-utils/crypto";
import { toClientAvmSigner } from "@x402/avm";
import algosdk from "algosdk";
import { describe, expect, it } from "vitest";

/** scripts/pay.ts, lines "const account = ..." and "const signer = ...", verbatim. */
function payTsSecretKey(mnemonic: string): string {
  const account = algosdk.mnemonicToSecretKey(mnemonic);
  return Buffer.from(account.sk).toString("base64");
}

/** The official demo client's getSecretKeyFromMnemonic, verbatim. */
async function demoSecretKey(mnemonic: string): Promise<string> {
  const seed = seedFromMnemonic(mnemonic);
  const seedCopy = new Uint8Array(seed);
  const wrappedSeed: WrappedEd25519Seed = {
    unwrapEd25519Seed: async () => seed,
    wrapEd25519Seed: async () => {},
  };
  const wrappedSecret = await ed25519SigningKeyFromWrappedSecret(wrappedSeed);
  return Buffer.concat([Buffer.from(seedCopy), Buffer.from(wrappedSecret.ed25519Pubkey)]).toString("base64");
}

const sp = {
  fee: 0n, flatFee: false, firstValid: 100n, lastValid: 110n, minFee: 1000n,
  genesisHash: Buffer.from("wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "base64"), genesisID: "mainnet-v1.0",
};

const accounts = [
  algosdk.generateAccount(),
  algosdk.generateAccount(),
  algosdk.generateAccount(),
  // a fixed, reproducible account: seed 00 01 02 ... 1f
  algosdk.mnemonicToSecretKey(algosdk.mnemonicFromSeed(Uint8Array.from({ length: 32 }, (_, i) => i))),
];

describe("scripts/pay.ts signer derivation == official demo client derivation", () => {
  it.each(accounts.map((a) => [a.addr.toString(), algosdk.secretKeyToMnemonic(a.sk)]))("%s: same key, address and signature", async (address, mnemonic) => {
    const payKey = payTsSecretKey(mnemonic);
    const demoKey = await demoSecretKey(mnemonic);
    expect(payKey).toBe(demoKey); // identical 64-byte seed||pubkey
    expect(Buffer.from(payKey, "base64")).toHaveLength(64);

    const paySigner = toClientAvmSigner(payKey);
    const demoSigner = toClientAvmSigner(demoKey);
    expect(paySigner.address).toBe(address);
    expect(demoSigner.address).toBe(address);

    // Same signature for the same transaction (ed25519 is deterministic), and equal to algosdk's own.
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: address, receiver: algosdk.generateAccount().addr, amount: 20_000, assetIndex: 31566704, suggestedParams: sp,
    });
    const unsigned = algosdk.encodeUnsignedTransaction(txn);
    const [a] = await paySigner.signTransactions([unsigned], [0]);
    const [b] = await demoSigner.signTransactions([unsigned], [0]);
    const reference = txn.signTxn(algosdk.mnemonicToSecretKey(mnemonic).sk);
    expect(a).not.toBeNull();
    expect(Buffer.from(a!).toString("hex")).toBe(Buffer.from(b!).toString("hex"));
    expect(Buffer.from(a!).toString("hex")).toBe(Buffer.from(reference).toString("hex"));
  });

  it("toClientAvmSigner only uses the seed half: it re-derives the public key itself", () => {
    const acct = algosdk.generateAccount();
    const seedOnlyKey = Buffer.concat([Buffer.from(acct.sk.subarray(0, 32)), Buffer.alloc(32)]).toString("base64"); // garbage pubkey half
    expect(toClientAvmSigner(seedOnlyKey).address).toBe(acct.addr.toString());
  });

  it("both reject malformed mnemonics the same way (pay.ts only trims; it does not normalise whitespace or case)", () => {
    const m = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
    const ok = (f: () => unknown) => { try { f(); return "ok"; } catch (e) { return (e as Error).message; } };
    for (const bad of [m.replace(" ", "  "), m.replace(" ", "\n"), m.toUpperCase(), `"${m}"`]) {
      expect(ok(() => algosdk.mnemonicToSecretKey(bad))).toMatch(/wordlist/);
      expect(ok(() => seedFromMnemonic(bad))).toMatch(/wordlist/);
    }
    expect(ok(() => algosdk.mnemonicToSecretKey(m.trim()))).toBe("ok");
  });

  it("pay.ts still contains exactly the derivation this test mirrors", () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/pay.ts"), "utf8");
    expect(src).toContain("const account = algosdk.mnemonicToSecretKey(mnemonic);");
    expect(src).toContain('const signer = toClientAvmSigner(Buffer.from(account.sk).toString("base64"));');
  });
});
