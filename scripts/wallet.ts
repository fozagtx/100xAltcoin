/**
 * Wallet helpers for testing payments (uses the public AlgoNode endpoints).
 *
 *   npm run wallet -- new                  create a throwaway account (prints address + mnemonic)
 *   npm run wallet -- balance [address]    ALGO and USDC balance (default: AVM_MNEMONIC's account)
 *   npm run wallet -- optin                opt AVM_MNEMONIC's account in to USDC (needs ~0.2 ALGO)
 *
 * ALGORAND_NETWORK=testnet|mainnet picks the network (default testnet).
 * Receiving USDC requires an opt-in, so both the payer and PAY_TO_ADDRESS
 * must be opted in.
 */
import "dotenv/config";
import { USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } from "@x402/avm";
import algosdk from "algosdk";

const mainnet = (process.env.ALGORAND_NETWORK ?? "testnet").trim().toLowerCase() === "mainnet";
const usdc = BigInt(mainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID);
const algod = new algosdk.Algodv2("", mainnet ? "https://mainnet-api.algonode.cloud" : "https://testnet-api.algonode.cloud", "");
const label = mainnet ? "MainNet" : "TestNet";

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
    console.log("\nKeep the mnemonic secret. Fund it with ALGO, then run `npm run wallet -- optin`.");
    if (!mainnet) console.log("TestNet ALGO: https://bank.testnet.algorand.network  TestNet USDC: https://faucet.circle.com (Algorand Testnet)");
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
