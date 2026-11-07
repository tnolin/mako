import { describe, expect, it, vi } from "vitest"
import type { Row } from "../src/history"
import {
  deepestPool,
  isPoolId,
  poolMcap,
  rpcSqrtPrice,
  STATE_VIEW,
  swapLiquidity,
  UNISWAP_V4_POOL_MANAGER,
} from "../src/pool"
import type { Prices } from "../src/prices"
import { loadTsunami } from "./helpers/fixtures"
import {
  HMU_SPLIT_WAMZNX,
  HMU_SPLIT_WNVDAX,
  INKY_USDG_SELL,
  INKY_WMSTRX_BUY,
  WMSTRX,
  WNVDAX,
} from "./helpers/hookit"

const NATIVE = "0x0000000000000000000000000000000000000000"
const KRAK = "0x7466ddd16d27b2a4070a827468f8f930aab2201a"
const POOL = "0xabb3f59f9af7a230844bfbbbc67134420925c05d18f1a2a58336a19e74e39cfc"
// Live reading of KRAK's pool on 2026-10-14: 5.3289 ETH market cap at 1B supply.
const KRAK_SQRT = 1085330431310623941983443206493297n
const Q96 = 1n << 96n
const CALAMARI_POOL_MANAGER = "0x6e4723a612831afb9f5b2a5ae22723c37aab9560"
const CALAMARI_STATE_VIEW = "0x9bf3f07e41e05d658248467760c745e278ef6211"
const USDC = "0x2d270e6886d130d724215a266106e6832161eaed"
const UNI = UNISWAP_V4_POOL_MANAGER

const word = (n: bigint) => n.toString(16).padStart(64, "0")
const slot0Result = (sqrt: bigint) => `0x${word(sqrt)}${word(190510n)}${word(0n)}${word(10000n)}`
const rpc = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe("poolMcap", () => {
  it("matches the live KRAK reading (token is currency1 of an ETH pool)", () => {
    expect(poolMcap(KRAK_SQRT, KRAK, NATIVE, String(10n ** 27n))).toBe(5328870998753306917n)
  })

  it("inverts the other way when the token is currency0", () => {
    const sqrt = Q96 * 2n // currency1 per currency0 = 4
    const low = "0x0000000000000000000000000000000000000001"
    const high = "0xffffffffffffffffffffffffffffffffffffffff"
    expect(poolMcap(sqrt, low, high, 100n)).toBe(400n) // token0: 4 quote per token
    expect(poolMcap(sqrt, high, low, 100n)).toBe(25n) // token1: 1/4 quote per token
  })

  it("has no price for an uninitialized pool", () => {
    expect(poolMcap(0n, KRAK, NATIVE, String(10n ** 27n))).toBeNull()
  })
})

describe("poolMcap against recorded Calamari pools", () => {
  const supply = String(10n ** 27n)

  it("values the USDC graduate's pool in USDC base units, as the indexer did", () => {
    // USDC (6 decimals) is currency0 and the token currency1; the recorded swap left 2,490,887 base units.
    const { launch, swap, slot0SqrtPriceX96 } = loadTsunami().usdc
    expect(poolMcap(BigInt(slot0SqrtPriceX96), launch.token, USDC, supply)).toBe(
      BigInt(swap.marketCap),
    )
  })

  it("values an ETH-quoted Calamari pool as the indexer did", () => {
    const { launch, swap, slot0SqrtPriceX96 } = loadTsunami().gm
    expect(poolMcap(BigInt(slot0SqrtPriceX96), launch.token, NATIVE, supply)).toBe(
      BigInt(swap.marketCap),
    )
  })
})

describe("isPoolId", () => {
  it.each([POOL, POOL.toUpperCase().replace("0X", "0x")])("accepts %s", (id) =>
    expect(isPoolId(id.toLowerCase())).toBe(true),
  )
  it.each(["", "0x", "0x1234", `${POOL}00`, POOL.replace("0x", ""), `0x${"g".repeat(64)}`])(
    "rejects %s",
    (id) => expect(isPoolId(id)).toBe(false),
  )
})

describe("rpcSqrtPrice", () => {
  it("calls StateView.getSlot0(poolId) at latest and returns sqrtPriceX96", async () => {
    const f = rpc({ jsonrpc: "2.0", id: 1, result: slot0Result(KRAK_SQRT) })
    expect(await rpcSqrtPrice("https://rpc.test", f)(UNI, POOL)).toBe(KRAK_SQRT)
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe("https://rpc.test")
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.method).toBe("eth_call")
    expect(body.params).toEqual([{ to: STATE_VIEW, data: `0xc815641c${POOL.slice(2)}` }, "latest"])
  })

  it("reads a Calamari pool through Calamari's StateView", async () => {
    const f = rpc({ jsonrpc: "2.0", id: 1, result: slot0Result(KRAK_SQRT) })
    await rpcSqrtPrice("https://rpc.test", f)(CALAMARI_POOL_MANAGER, POOL)
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(JSON.parse((init as RequestInit).body as string).params[0].to).toBe(CALAMARI_STATE_VIEW)
  })

  it("rejects an unknown pool manager without a call", async () => {
    const f = rpc({ jsonrpc: "2.0", id: 1, result: slot0Result(KRAK_SQRT) })
    await expect(
      rpcSqrtPrice("https://rpc.test", f)("0x0000000000000000000000000000000000000001", POOL),
    ).rejects.toThrow("unknown pool manager")
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it("caches per pool manager as well as per pool id", async () => {
    const f = rpc({ jsonrpc: "2.0", id: 1, result: slot0Result(KRAK_SQRT) })
    const read = rpcSqrtPrice("https://rpc.test", f, () => 1_000_000)
    await read(UNI, POOL)
    await read(CALAMARI_POOL_MANAGER, POOL)
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it("throws on an RPC error", async () => {
    const f = rpc({ jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } })
    await expect(rpcSqrtPrice("https://rpc.test", f)(UNI, POOL)).rejects.toThrow(
      "execution reverted",
    )
  })

  it("throws on a short result", async () => {
    const f = rpc({ jsonrpc: "2.0", id: 1, result: "0x" })
    await expect(rpcSqrtPrice("https://rpc.test", f)(UNI, POOL)).rejects.toThrow(
      /short eth_call result/,
    )
  })

  it("serves a pool from cache for 15 s, shares a concurrent call, then reads again", async () => {
    let t = 1_000_000
    const f = rpc({ jsonrpc: "2.0", id: 1, result: slot0Result(KRAK_SQRT) })
    const read = rpcSqrtPrice("https://rpc.test", f, () => t)
    const calls = () => (f as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    await Promise.all([read(UNI, POOL), read(UNI, POOL)])
    expect(calls()).toBe(1)
    t += 14_999
    expect(await read(UNI, POOL)).toBe(KRAK_SQRT)
    expect(calls()).toBe(1)
    t += 1 // 15 s after the first read
    await read(UNI, POOL)
    expect(calls()).toBe(2)
  })

  it("caches per pool id", async () => {
    const f = rpc({ jsonrpc: "2.0", id: 1, result: slot0Result(KRAK_SQRT) })
    const read = rpcSqrtPrice("https://rpc.test", f, () => 1_000_000)
    await read(UNI, POOL)
    await read(UNI, `0x${"cd".repeat(32)}`)
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it("serves a failure from cache too, so a failing node is not hammered", async () => {
    let t = 1_000_000
    const f = rpc({ jsonrpc: "2.0", id: 1, error: { message: "rate limited" } })
    const read = rpcSqrtPrice("https://rpc.test", f, () => t)
    await expect(read(UNI, POOL)).rejects.toThrow("rate limited")
    await expect(read(UNI, POOL)).rejects.toThrow("rate limited")
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    t += 15_000
    await expect(read(UNI, POOL)).rejects.toThrow("rate limited")
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it("never puts the RPC URL in an error, which the card logs", async () => {
    const urlError = vi.fn(async () => {
      throw new TypeError("Failed to parse URL from https://rpc.test/KEY123")
    }) as unknown as typeof fetch
    const err = await rpcSqrtPrice("https://rpc.test/KEY123", urlError)(UNI, POOL).catch((e) => e)
    expect(err.message).toBe("fetch failed")
    expect(String(err)).not.toContain("KEY123")
  })

  it("reports a timeout as timeout", async () => {
    const slow = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
    }) as unknown as typeof fetch
    await expect(rpcSqrtPrice("https://rpc.test", slow)(UNI, POOL)).rejects.toThrow(/^timeout$/)
  })

  it("reports a non-JSON body as a bad response", async () => {
    const html = vi.fn(
      async () => new Response("<html>502</html>", { status: 502 }),
    ) as unknown as typeof fetch
    await expect(rpcSqrtPrice("https://rpc.test", html)(UNI, POOL)).rejects.toThrow(
      /^bad response \(HTTP 502\)$/,
    )
  })

  it("refuses a malformed pool id without calling the node", async () => {
    const f = rpc({})
    await expect(rpcSqrtPrice("https://rpc.test", f)(UNI, "0x1234")).rejects.toThrow("bad pool id")
    expect(f).not.toHaveBeenCalled()
  })
})

describe("swapLiquidity", () => {
  it("adds the token side at the swap's price in the quote's own units (INKY's USDG pool)", () => {
    // 1.381632 USDG of quote plus 499.8M tokens at $5.03 per billion: $2,516.095105.
    expect(swapLiquidity(INKY_USDG_SELL)).toBe(2_516_095_105n)
  })

  it("adds the token side of INKY's wMSTRx pool", () => {
    expect(swapLiquidity(INKY_WMSTRX_BUY)).toBe(8_913_171_826_344_832_598n)
  })

  it("is twice the quote side when the swap has no token side (synthetic)", () => {
    const { tokenLiquidity: _, ...old } = INKY_WMSTRX_BUY
    expect(swapLiquidity(old)).toBe(2n * BigInt(INKY_WMSTRX_BUY.quoteLiquidity))
  })

  it("is twice the quote side when the supply is unknown (synthetic)", () => {
    expect(swapLiquidity({ ...INKY_WMSTRX_BUY, supply: "0" })).toBe(
      2n * BigInt(INKY_WMSTRX_BUY.quoteLiquidity),
    )
  })
})

describe("deepestPool", () => {
  const usd: Record<string, number> = {
    [WNVDAX]: 206.98,
    [WMSTRX]: 133.94,
    [INKY_USDG_SELL.quoteAsset]: 1,
  }
  const prices: Prices = { usd: (q) => usd[q] ?? null, symbol: (q) => q }
  const row = (id: string, p: Row<typeof INKY_USDG_SELL>["p"]) => ({ id, p })

  it("compares pools in USD, not in raw quote units", () => {
    // wMSTRx's raw 8.9e18 dwarfs USDG's 2.5e9, but the USDG pool holds $2,516 against $1,194.
    const pools = [row("1", INKY_WMSTRX_BUY), row("2", INKY_USDG_SELL)]
    expect(deepestPool(pools, prices)?.id).toBe("2")
    expect(deepestPool([...pools].reverse(), prices)?.id).toBe("2")
  })

  it("leaves out a pool whose quote has no price, however large it is (HMU's wAMZNx, scaled up: synthetic)", () => {
    const big = {
      ...HMU_SPLIT_WAMZNX,
      quoteLiquidity: String(10n ** 24n),
      tokenLiquidity: undefined,
    }
    const pools = [row("1", HMU_SPLIT_WNVDAX), row("2", big)]
    expect(deepestPool(pools, prices)?.id).toBe("1")
  })

  it("prefers an empty priced pool to a newer unpriced one (synthetic)", () => {
    const empty = { ...HMU_SPLIT_WNVDAX, quoteLiquidity: "0", tokenLiquidity: "0" }
    const pools = [row("1", empty), row("2", HMU_SPLIT_WAMZNX)]
    expect(deepestPool(pools, prices)?.id).toBe("1")
  })

  it("takes the pool of the latest swap when no pool has a price", () => {
    const pools = [
      row("7", HMU_SPLIT_WAMZNX),
      row("9", { ...HMU_SPLIT_WAMZNX, poolId: `0x${"1".repeat(64)}` }),
      row("8", HMU_SPLIT_WAMZNX),
    ]
    expect(deepestPool(pools, { usd: () => null, symbol: (q) => q })?.id).toBe("9")
  })

  it("is null without swaps", () => {
    expect(deepestPool([], prices)).toBeNull()
  })

  it("takes the later swap when two pools are equally deep (synthetic)", () => {
    const pools = [
      row("3", HMU_SPLIT_WNVDAX),
      row("4", { ...HMU_SPLIT_WNVDAX, poolId: `0x${"2".repeat(64)}` }),
    ]
    expect(deepestPool(pools, prices)?.id).toBe("4")
  })
})
