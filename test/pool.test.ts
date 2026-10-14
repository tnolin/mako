import { describe, expect, it, vi } from "vitest"
import { isPoolId, poolMcap, rpcSqrtPrice, STATE_VIEW } from "../src/pool"

const NATIVE = "0x0000000000000000000000000000000000000000"
const KRAK = "0x7466ddd16d27b2a4070a827468f8f930aab2201a"
const POOL = "0xabb3f59f9af7a230844bfbbbc67134420925c05d18f1a2a58336a19e74e39cfc"
// Live reading of KRAK's pool on 2026-10-14: 5.3289 ETH market cap at 1B supply.
const KRAK_SQRT = 1085330431310623941983443206493297n
const Q96 = 1n << 96n

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
    expect(await rpcSqrtPrice("https://rpc.test", f)(POOL)).toBe(KRAK_SQRT)
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe("https://rpc.test")
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.method).toBe("eth_call")
    expect(body.params).toEqual([{ to: STATE_VIEW, data: `0xc815641c${POOL.slice(2)}` }, "latest"])
  })

  it("throws on an RPC error", async () => {
    const f = rpc({ jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } })
    await expect(rpcSqrtPrice("https://rpc.test", f)(POOL)).rejects.toThrow("execution reverted")
  })

  it("throws on a short result", async () => {
    const f = rpc({ jsonrpc: "2.0", id: 1, result: "0x" })
    await expect(rpcSqrtPrice("https://rpc.test", f)(POOL)).rejects.toThrow(/short eth_call result/)
  })

  it("serves a pool from cache for 15 s, shares a concurrent call, then reads again", async () => {
    let t = 1_000_000
    const f = rpc({ jsonrpc: "2.0", id: 1, result: slot0Result(KRAK_SQRT) })
    const read = rpcSqrtPrice("https://rpc.test", f, () => t)
    const calls = () => (f as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    await Promise.all([read(POOL), read(POOL)])
    expect(calls()).toBe(1)
    t += 14_999
    expect(await read(POOL)).toBe(KRAK_SQRT)
    expect(calls()).toBe(1)
    t += 1 // 15 s after the first read
    await read(POOL)
    expect(calls()).toBe(2)
  })

  it("caches per pool id", async () => {
    const f = rpc({ jsonrpc: "2.0", id: 1, result: slot0Result(KRAK_SQRT) })
    const read = rpcSqrtPrice("https://rpc.test", f, () => 1_000_000)
    await read(POOL)
    await read(`0x${"cd".repeat(32)}`)
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it("serves a failure from cache too, so a failing node is not hammered", async () => {
    let t = 1_000_000
    const f = rpc({ jsonrpc: "2.0", id: 1, error: { message: "rate limited" } })
    const read = rpcSqrtPrice("https://rpc.test", f, () => t)
    await expect(read(POOL)).rejects.toThrow("rate limited")
    await expect(read(POOL)).rejects.toThrow("rate limited")
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    t += 15_000
    await expect(read(POOL)).rejects.toThrow("rate limited")
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it("never puts the RPC URL in an error, which the card logs", async () => {
    const urlError = vi.fn(async () => {
      throw new TypeError("Failed to parse URL from https://rpc.test/KEY123")
    }) as unknown as typeof fetch
    const err = await rpcSqrtPrice("https://rpc.test/KEY123", urlError)(POOL).catch((e) => e)
    expect(err.message).toBe("fetch failed")
    expect(String(err)).not.toContain("KEY123")
  })

  it("reports a timeout as timeout", async () => {
    const slow = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
    }) as unknown as typeof fetch
    await expect(rpcSqrtPrice("https://rpc.test", slow)(POOL)).rejects.toThrow(/^timeout$/)
  })

  it("reports a non-JSON body as a bad response", async () => {
    const html = vi.fn(
      async () => new Response("<html>502</html>", { status: 502 }),
    ) as unknown as typeof fetch
    await expect(rpcSqrtPrice("https://rpc.test", html)(POOL)).rejects.toThrow(
      /^bad response \(HTTP 502\)$/,
    )
  })

  it("refuses a malformed pool id without calling the node", async () => {
    const f = rpc({})
    await expect(rpcSqrtPrice("https://rpc.test", f)("0x1234")).rejects.toThrow("bad pool id")
    expect(f).not.toHaveBeenCalled()
  })
})
