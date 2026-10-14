import { DEFAULT_RPC } from "./rpc"

/** Uniswap v4 StateView on Ink (Uniswap's v4 deployments page, checked 2026-10-14). */
export const STATE_VIEW = "0x76fd297e2d437cd7f76d50f01afe6160f86e9990"
/** getSlot0(bytes32) */
const GET_SLOT0 = "0xc815641c"
const POOL_ID = /^0x[0-9a-f]{64}$/
const Q192 = 1n << 192n

export const isPoolId = (id: string): boolean => POOL_ID.test(id)

export type ReadSqrtPrice = (poolId: string) => Promise<bigint>

export const POOL_PRICE_TTL_MS = 15_000

/**
 * Read-only `eth_call StateView.getSlot0(poolId)` at latest; returns sqrtPriceX96. 3 s timeout.
 * Each pool's result (value or failure) is cached for 15 s, and concurrent lookups share one call.
 * shortcut: in memory and per process; expired entries are swept on every call (O(pools)).
 */
export function rpcSqrtPrice(
  url: string = DEFAULT_RPC,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): ReadSqrtPrice {
  const cache = new Map<string, { at: number; value: Promise<bigint> }>()
  const read = async (poolId: string): Promise<bigint> => {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: STATE_VIEW, data: `${GET_SLOT0}${poolId.slice(2)}` }, "latest"],
      }),
      signal: AbortSignal.timeout(3000),
    })
    const j = (await res.json()) as { result?: string; error?: { message?: string } }
    if (j.error) throw new Error(j.error.message ?? "rpc error")
    if (typeof j.result !== "string" || j.result.length < 66) {
      throw new Error(`short eth_call result (HTTP ${res.status})`)
    }
    return BigInt(j.result.slice(0, 66))
  }
  return (poolId) => {
    if (!isPoolId(poolId)) return Promise.reject(new Error("bad pool id"))
    const t = now()
    for (const [k, e] of cache) if (t - e.at >= POOL_PRICE_TTL_MS) cache.delete(k)
    const hit = cache.get(poolId)
    if (hit) return hit.value
    const value = read(poolId)
    // Each caller handles a cached failure; this only stops an unhandled-rejection warning.
    value.catch(() => {})
    cache.set(poolId, { at: t, value })
    return value
  }
}

/**
 * Market cap in raw quote units from a v4 pool price. v4 orders currencies by address, so native ETH (0x0) is
 * always currency0, and sqrtPriceX96² / 2^192 is currency1 per currency0. Token and quote both have 18 decimals
 * (InkyPump tokens, ETH and the xStock wrappers). Null for an uninitialized pool.
 */
export function poolMcap(
  sqrtPriceX96: bigint,
  token: string,
  quote: string,
  totalSupply: string | bigint,
): bigint | null {
  if (sqrtPriceX96 <= 0n) return null
  const p2 = sqrtPriceX96 * sqrtPriceX96
  const supply = BigInt(totalSupply)
  return BigInt(token) < BigInt(quote) ? (supply * p2) / Q192 : (supply * Q192) / p2
}
