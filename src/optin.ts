/**
 * Whether an Algorand account holds (is opted in to) an asset, asked of an
 * algod node. true = opted in, false = not opted in (or the account does not
 * exist yet), null = could not tell (node unreachable or rate limited).
 *
 * Used at boot to catch the quietest way to earn nothing: a PAY_TO_ADDRESS that
 * is not opted in to USDC makes every settlement fail while the service
 * itself looks healthy.
 */
export async function isOptedIn(algodUrl: string, address: string, assetId: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${algodUrl.replace(/\/+$/, "")}/v2/accounts/${address}/assets/${assetId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}
