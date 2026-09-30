/**
 * MainNet wallet helpers (uses the public AlgoNode endpoint).
 *
 *   npm run wallet -- new                  create a new account (prints address + mnemonic)
 *   npm run wallet -- balance [address]    ALGO and USDC balance (default: AVM_MNEMONIC's account)
 *   npm run wallet -- optin                opt AVM_MNEMONIC's account in to USDC (needs ~0.2 ALGO)
 *
 * Receiving USDC requires an opt-in, so PAY_TO_ADDRESS must be opted in
 * before the first payment. A wallet app (Pera, Defly, Lute) is the safer
 * place to keep a wallet that holds real funds.
 */
import "dotenv/config";
import { USDC_MAINNET_ASA_ID } from "@x402/avm";
import algosdk from "algosdk";

const usdc = BigInt(USDC_MAINNET_ASA_ID);
const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
const label = "MainNet";

function account() {
  const m = process.env.AVM_MNEMONIC?.trim();
  if (!m) throw new Error('set AVM_MNEMONIC="25 words" (npm run wallet -- new creates one)');
  return algosdk.mnemonicToSecretKey(m);
}

async function balance(address: string) {
  const info = await algod.accountInformation(address).do();
  const holding = info.assets?.find((a) => a.assetId === usdc);
  console.log(`${label} ${address}`);
  console.log(`  ALGO: ${Number(info.amount) / 1e6}`);
  console.log(`  USDC (ASA ${usdc}): ${holding ? Number(holding.amount) / 1e6 : "not opted in"}`);
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "new": {
    const acct = algosdk.generateAccount();
    console.log(`address:  ${acct.addr.toString()}`);
    console.log(`mnemonic: ${algosdk.secretKeyToMnemonic(acct.sk)}`);
    console.log("\nKeep the mnemonic secret and offline. Fund the account with a little ALGO, then run `npm run wallet -- optin`.");
    break;
  }
  case "balance":
    await balance(arg ?? account().addr.toString());
    break;
  case "optin": {
    const acct = account();
    const suggestedParams = await algod.getTransactionParams().do();
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: acct.addr,
      receiver: acct.addr,
      amount: 0,
      assetIndex: usdc,
      suggestedParams,
    });
    const { txid } = await algod.sendRawTransaction(txn.signTxn(acct.sk)).do();
    await algosdk.waitForConfirmation(algod, txid, 8);
    console.log(`opted in to USDC (ASA ${usdc}) on ${label}: ${txid}`);
    await balance(acct.addr.toString());
    break;
  }
  default:
    console.log("usage: npm run wallet -- new | balance [address] | optin");
    process.exit(1);
}
