import type { NftState } from "./state"

/** Lowercase letters and digits only. */
export const normalise = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")

const OPENSEA_LINK =
  /(?:^|\/\/)(?:www\.)?opensea\.io\/(?:(collection)\/([a-z0-9-]{1,100})|(?:item|assets)\/ink\/(0x[0-9a-fA-F]{40})\/([0-9]{1,78}))(?:[/?#]|$)/i

/** An OpenSea collection link (a slug) or an Ink item link (`item` or the older `assets`), else null. */
export function parseOpenSeaLink(
  text: string,
): { slug: string } | { contract: string; tokenId: string } | null {
  const m = OPENSEA_LINK.exec(text.trim())
  if (!m) return null
  if (m[1]) return { slug: m[2]!.toLowerCase() }
  return { contract: m[3]!.toLowerCase(), tokenId: m[4]! }
}

export const WINDOWS = ["1h", "24h", "7d", "30d"] as const
export type Window = (typeof WINDOWS)[number]
export const WINDOW_S: Record<Window, number> = {
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
}

export type Match =
  | { kind: "one"; contract: string }
  | { kind: "pick"; contracts: string[] }
  | { kind: "none" }
  | { kind: "short" }

/**
 * The closest-match rule. An address or OpenSea link finds that collection or nothing. A name under 3
 * letters or digits is `short`. Otherwise the best tier decides: an exact slug opens straight away, as does
 * the only `real` collection in the best tier; else a pick list of up to 8, best first.
 */
export function matchCollection(state: NftState, q: string): Match {
  const exact = /0x[0-9a-fA-F]{40}/.test(q) || parseOpenSeaLink(q) !== null
  if (!exact && normalise(q).length < 3) return { kind: "short" }
  const ms = state.matches(q)
  if (ms.length === 0) return { kind: "none" }
  const top = ms.filter((m) => m.tier === ms[0]!.tier)
  const reals = top.filter((m) => m.state.col?.verdict === "real")
  const only = ms[0]!.tier === 1 ? top[0] : reals.length === 1 ? reals[0] : undefined
  const contract = (m: (typeof ms)[number]) => (m.state.col?.contract ?? m.state.launch?.contract)!
  if (only) return { kind: "one", contract: contract(only) }
  return { kind: "pick", contracts: ms.slice(0, 8).map(contract) }
}

/**
 * `/nft <collection> [window]` or `/nft <collection> <id>`. A trailing 1h/24h/7d/30d is a window. A trailing
 * number is an item id only when the words before it name one collection; otherwise the whole text is the
 * collection query.
 */
export function parseNftQuery(
  state: NftState,
  text: string,
): { contract: Match; tokenId: string | null; window: Window | null } {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const last = words.at(-1)?.toLowerCase() ?? ""
  if (words.length >= 2 && (WINDOWS as readonly string[]).includes(last)) {
    return {
      contract: matchCollection(state, words.slice(0, -1).join(" ")),
      tokenId: null,
      window: last as Window,
    }
  }
  if (words.length >= 2 && /^[0-9]{1,78}$/.test(last)) {
    const head = matchCollection(state, words.slice(0, -1).join(" "))
    if (head.kind === "one") return { contract: head, tokenId: last, window: null }
  }
  return { contract: matchCollection(state, words.join(" ")), tokenId: null, window: null }
}
