import { describe, expect, it, vi } from "vitest"
import { type BalanceOf, isMissingState, readDevHolds, rpcBalanceOf } from "../src/rpc"

const REQ = { token: "0xd1", holder: "0xc1", block: "57889269", totalSupply: String(10n ** 27n) }
const BAL = 68n * 10n ** 24n // 6.8% of supply

describe("isMissingState", () => {
  it.each([
    "missing trie node 1a2b (path )",
    "header not found",
    "historical state 0xabc is not available",
    "state is not available",
    "required historical state unavailable",
    "state pruned",
    "unknown block",
    "block not found",
  ])("matches %s", (m) => expect(isMissingState(m)).toBe(true))

  it.each(["execution reverted", "rate limited", "Internal error", "timeout"])("rejects %s", (m) =>
    expect(isMissingState(m)).toBe(false),
  )
})

describe("readDevHolds", () => {
  function stub(script: Record<string, (string | bigint)[]>) {
    const calls: string[] = []
    const fn: BalanceOf = async (_t, _h, tag) => {
      calls.push(tag)
      const next = script[tag === "latest" ? "latest" : "block"]?.shift()
      if (typeof next === "bigint") return next
      throw new Error(next ?? "no response")
    }
    return { fn, calls }
  }

  it("reads at the sell block", async () => {
    const { fn, calls } = stub({ block: [BAL] })
    expect(await readDevHolds(fn, REQ)).toEqual({ pct: 6.8, now: false })
    expect(calls).toEqual(["0x37351f5"])
  })

  it.each(["missing trie node abc", "header not found"])(
    "falls back to latest on '%s' and marks it (now)",
    async (msg) => {
      const { fn, calls } = stub({ block: [msg], latest: [BAL] })
      expect(await readDevHolds(fn, REQ)).toEqual({ pct: 6.8, now: true })
      expect(calls).toEqual(["0x37351f5", "latest"])
    },
  )

  it("retries a revert once at the sell block, never calls latest, then omits", async () => {
    const { fn, calls } = stub({ block: ["execution reverted", "execution reverted"] })
    expect(await readDevHolds(fn, REQ)).toBeNull()
    expect(calls).toEqual(["0x37351f5", "0x37351f5"])
  })

  it("omits the line when both the sell block and latest fail", async () => {
    const { fn, calls } = stub({ block: ["missing trie node"], latest: ["timeout", "timeout"] })
    expect(await readDevHolds(fn, REQ)).toBeNull()
    expect(calls).toEqual(["0x37351f5", "latest", "latest"])
  })
})

describe("rpcBalanceOf", () => {
  it("sends eth_call balanceOf at a block tag and parses the result", async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${BAL.toString(16)}` })),
    )
    const bal = await rpcBalanceOf("https://rpc.example", f as unknown as typeof fetch)(
      "0xd1",
      "0xc1",
      "latest",
    )
    expect(bal).toBe(BAL)
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.method).toBe("eth_call")
    expect(body.params[0].data).toBe(`0x70a08231${"c1".padStart(64, "0")}`)
    expect(body.params[1]).toBe("latest")
  })

  it("throws the JSON-RPC error message", async () => {
    const f = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "missing trie node x" },
        }),
      )
    await expect(
      rpcBalanceOf("u", f as unknown as typeof fetch)("0xd1", "0xc1", "0x1"),
    ).rejects.toThrow("missing trie node x")
  })
})
