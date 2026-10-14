export const DEFAULT_RPC = "https://rpc-qnd.inkonchain.com"

const MISSING_STATE =
  /missing trie node|header not found|historical state|state (is )?(not available|unavailable|pruned|discarded)|unknown block|block not found/i

/** True when a node no longer has state for the requested block (pruned nodes keep ~128 blocks). */
export function isMissingState(message: string): boolean {
  return MISSING_STATE.test(message)
}

export type BalanceOf = (token: string, holder: string, blockTag: string) => Promise<bigint>

/** Read-only `eth_call balanceOf` for DEV SELL's dev holds. 5 s timeout. */
export function rpcBalanceOf(url: string = DEFAULT_RPC, fetchFn: typeof fetch = fetch): BalanceOf {
  return async (token, holder, blockTag) => {
    const data = `0x70a08231${holder.slice(2).toLowerCase().padStart(64, "0")}`
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: token, data }, blockTag],
      }),
      signal: AbortSignal.timeout(5000),
    })
    const j = (await res.json()) as { result?: string; error?: { message?: string } }
    if (j.error) throw new Error(j.error.message ?? "rpc error")
    if (j.result === undefined) throw new Error(`empty eth_call result (HTTP ${res.status})`)
    return j.result === "0x" ? 0n : BigInt(j.result)
  }
}

export type HoldsReq = { token: string; holder: string; block: string; totalSupply: string }
export type DevHolds = { pct: number; now: boolean } | null

type Attempt = { ok: bigint } | { missing: true } | { failed: true }

/**
 * Sell block first. On missing state, `latest` (marked `now`). Any other error is retried once on the
 * same tag. Returns null when no read succeeds, and the card omits the line.
 */
export async function readDevHolds(balanceOf: BalanceOf, r: HoldsReq): Promise<DevHolds> {
  const pct = (b: bigint) => Number((b * 1_000_000n) / BigInt(r.totalSupply)) / 10_000
  const attempt = async (tag: string): Promise<Attempt> => {
    try {
      return { ok: await balanceOf(r.token, r.holder, tag) }
    } catch (err) {
      return isMissingState(err instanceof Error ? err.message : String(err))
        ? { missing: true }
        : { failed: true }
    }
  }
  const tag = `0x${BigInt(r.block).toString(16)}`
  let a = await attempt(tag)
  if ("failed" in a) a = await attempt(tag)
  if ("ok" in a) return { pct: pct(a.ok), now: false }
  if (!("missing" in a)) return null
  let b = await attempt("latest")
  if (!("ok" in b)) b = await attempt("latest")
  return "ok" in b ? { pct: pct(b.ok), now: true } : null
}
