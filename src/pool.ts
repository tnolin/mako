import type { SwapEvent } from "@ink-indexer/events"
import { quoteUnits } from "./cards/money"
import type { Row } from "./history"
import type { Prices } from "./prices"
import { DEFAULT_RPC } from "./rpc"

/** Uniswap v4 PoolManager on Ink, where every pool bonded before events schema version 2 lives. */
export const UNISWAP_V4_POOL_MANAGER = "0x360e68faccca8ca495c1b759fd9eee466db9fb32"
/** Uniswap v4 StateView on Ink (Uniswap's v4 deployments page, checked 2026-10-14). */
export const STATE_VIEW = "0x76fd297e2d437cd7f76d50f01afe6160f86e9990"
/** Calamari's PoolManager, which holds every graduated Tsunami pool, and its StateView. */
export const CALAMARI_POOL_MANAGER = "0x6e4723a612831afb9f5b2a5ae22723c37aab9560"
export const CALAMARI_STATE_VIEW = "0x9bf3f07e41e05d658248467760c745e278ef6211"

/** The StateView that reads each PoolManager's pools, keyed by lowercase PoolManager address. */
export const STATE_VIEWS: Record<string, string> = {
  [UNISWAP_V4_POOL_MANAGER]: STATE_VIEW,
  [CALAMARI_POOL_MANAGER]: CALAMARI_STATE_VIEW,
}

/** getSlot0(bytes32) */
const GET_SLOT0 = "0xc815641c"
const POOL_ID = /^0x[0-9a-f]{64}$/
const Q192 = 1n << 192n

export const isPoolId = (id: string): boolean => POOL_ID.test(id)

export type ReadSqrtPrice = (poolManager: string, poolId: string) => Promise<bigint>

export const POOL_PRICE_TTL_MS = 15_000

/**
 * Read-only `eth_call StateView.getSlot0(poolId)` at latest on the StateView of the pool's PoolManager; returns
 * sqrtPriceX96. 3 s timeout. Each pool's result (value or failure) is cached for 15 s, and concurrent lookups share one call.
 * shortcut: in memory and per process; expired entries are swept on every call (O(pools)).
 */
export function rpcSqrtPrice(
  url: string = DEFAULT_RPC,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): ReadSqrtPrice {
  const cache = new Map<string, { at: number; value: Promise<bigint> }>()
  const read = async (stateView: string, poolId: string): Promise<bigint> => {
    // Errors carry fixed text only: Node's fetch puts the full URL (and any provider key in it) in some messages.
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: stateView, data: `${GET_SLOT0}${poolId.slice(2)}` }, "latest"],
      }),
      signal: AbortSignal.timeout(3000),
    }).catch((err: unknown) => {
      throw new Error(
        err instanceof Error && err.name === "TimeoutError" ? "timeout" : "fetch failed",
      )
    })
    const j = (await res.json().catch(() => {
      throw new Error(`bad response (HTTP ${res.status})`)
    })) as { result?: string; error?: { message?: string } }
    if (j.error) throw new Error(j.error.message ?? "rpc error")
    if (typeof j.result !== "string" || j.result.length < 66) {
      throw new Error(`short eth_call result (HTTP ${res.status})`)
    }
    return BigInt(j.result.slice(0, 66))
  }
  return (poolManager, poolId) => {
    const stateView = STATE_VIEWS[poolManager.toLowerCase()]
    if (!stateView) return Promise.reject(new Error("unknown pool manager"))
    if (!isPoolId(poolId)) return Promise.reject(new Error("bad pool id"))
    const t = now()
    for (const [k, e] of cache) if (t - e.at >= POOL_PRICE_TTL_MS) cache.delete(k)
    const key = `${poolManager.toLowerCase()}:${poolId}`
    const hit = cache.get(key)
    if (hit) return hit.value
    const value = read(stateView, poolId)
    // Each caller handles a cached failure; this only stops an unhandled-rejection warning.
    value.catch(() => {})
    cache.set(key, { at: t, value })
    return value
  }
}

/**
 * Market cap in raw quote units from a v4 pool price. v4 orders currencies by address, so native ETH (0x0) is
 * always currency0, and sqrtPriceX96² / 2^192 is currency1 per currency0 in base units, so the result is in the
 * quote's own base units whatever its decimals (6 for USDC, 8 for kBTC, 18 for ETH). Tokens have 18 decimals.
 * Null for an uninitialized pool.
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

/**
 * A pool's liquidity at a swap, in the quote's own base units: the quote side plus the token side valued at the
 * swap's price. A swap recorded without a token side counts the quote side twice, which is what a full-range pool
 * holds.
 */
export function swapLiquidity(p: SwapEvent): bigint {
  const quote = BigInt(p.quoteLiquidity)
  const supply = BigInt(p.supply)
  if (p.tokenLiquidity == null || supply <= 0n) return 2n * quote
  // The market cap is supply × price, so this keeps the price's precision even for a 6-decimal quote, where the
  // stored price is only a few units.
  return quote + (BigInt(p.tokenLiquidity) * BigInt(p.marketCap)) / supply
}

/** The newest swap of each pool, from swaps in id order. */
export function latestPerPool(swaps: Row<SwapEvent>[]): Row<SwapEvent>[] {
  const latest = new Map<string, Row<SwapEvent>>()
  for (const s of swaps) latest.set(s.p.poolId, s)
  return [...latest.values()]
}

/**
 * The pool of a multi-pair token that holds the most, in USD, at its latest swap. `latest` has each pool's newest
 * swap. A pool whose quote has no current price is left out of the comparison; when none has one, the pool of the
 * newest swap stands.
 */
export function deepestPool(latest: Row<SwapEvent>[], prices: Prices): Row<SwapEvent> | null {
  let best: Row<SwapEvent> | null = null
  let bestUsd = 0
  let newest: Row<SwapEvent> | null = null
  for (const r of latest) {
    if (newest === null || BigInt(r.id) > BigInt(newest.id)) newest = r
    const price = prices.usd(r.p.quoteAsset)
    if (price === null) continue
    const value = quoteUnits(swapLiquidity(r.p), r.p.quoteAsset) * price
    if (best === null || value > bestUsd || (value === bestUsd && BigInt(r.id) > BigInt(best.id))) {
      best = r
      bestUsd = value
    }
  }
  return best ?? newest
}
