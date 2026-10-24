import type { NftCollectionEvent } from "@ink-indexer/events"
import { clean, safeUrl, usd } from "../format"
import type { AlertKind, TokenAlert } from "../settings"

export type NftAlertKind = Exclude<AlertKind, TokenAlert>

/** Platform-neutral NFT alert (ADR 0002). Text fields are cleaned, not escaped; renderers escape. */
export type NftAlertCard = {
  alert: NftAlertKind
  /** "MINT STARTING · GTD", "MINTED 50%". */
  title: string
  /** The collection name, cleaned, at most 64 characters. */
  name: string
  /** OpenSea marks the collection verified: ` ✓` after the name. */
  verified: boolean
  marketplace: "OpenSea" | "Chimera"
  rows: [label: string, value: string][]
  /** The collection contract. */
  contract: string
  /** More tap-to-copy address lines under CA (NEW COLLECTION: the token). */
  extra: [label: string, address: string][]
  tokenId: string | null
  /** Null before OpenSea has a page for the collection. */
  slug: string | null
  imageUrl: string | null
  /** The image cache key: `nft:<contract>` for the collection image, `nft:<contract>:<id>` for an item. */
  imageKey: string
  links: { label: "X" | "Website" | "Discord"; url: string }[]
}

/** 0x12ab…cd34 */
export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Dollars: cents under $10, the usual money style above. */
export const usdText = (n: number): string => (n < 10 ? `$${n.toFixed(2)}` : usd(n))

/** Three significant digits, trailing zeros trimmed: 0.00025, 0.0112, 0.427, 3.5. */
function ethNumber(wei: bigint): string {
  const n = Number(wei) / 1e18
  if (n === 0) return "0"
  if (n >= 1000) return Math.round(n).toLocaleString("en-US")
  const s = n.toPrecision(3)
  const plain = s.includes("e") ? n.toFixed(18) : s
  return plain.includes(".") ? plain.replace(/0+$/, "").replace(/\.$/, "") : plain
}

/** `0.032 ETH ($77)`; the dollars only with a fresh ETH price (`rate`). */
export function ethText(wei: bigint, rate: number | null): string {
  const eth = `${ethNumber(wei)} ETH`
  return rate === null ? eth : `${eth} (${usdText((Number(wei) / 1e18) * rate)})`
}

/** A creator-set X handle or URL to an https link; anything else is dropped. */
function xUrl(v: string | null | undefined): string | null {
  if (!v) return null
  const handle = /^@?([A-Za-z0-9_]{1,15})$/.exec(v.trim())
  return handle ? `https://x.com/${handle[1]}` : safeUrl(v)
}

/** The `creator` row: the OpenSea username (with ✓ when verified), else the short address; null when unknown. */
export function creatorRow(col: NftCollectionEvent | null): [string, string] | null {
  const c = col?.creator
  if (!c) return null
  return [
    "creator",
    c.username ? `${clean(c.username, 32)}${c.verified ? " ✓" : ""}` : shortAddr(c.address),
  ]
}

/**
 * Builds the card around the rows a rule made. The name is cleaned and cut here, links are http(s) only,
 * and listing and sale alerts use the item image, falling back to the collection image.
 */
export function makeNftAlertCard(
  alert: NftAlertKind,
  title: string,
  col: NftCollectionEvent | null,
  rows: NftAlertCard["rows"],
  opts: {
    contract?: string
    tokenId?: string
    imageUrl?: string | null
    extra?: NftAlertCard["extra"]
  },
): NftAlertCard {
  const contract = col?.contract ?? opts.contract ?? ""
  const item = opts.tokenId !== undefined && opts.imageUrl ? opts.imageUrl : null
  const links: NftAlertCard["links"] = []
  const x = xUrl(col?.links.twitter)
  const site = safeUrl(col?.links.website)
  const discord = safeUrl(col?.links.discord)
  if (x) links.push({ label: "X", url: x })
  if (site) links.push({ label: "Website", url: site })
  if (discord) links.push({ label: "Discord", url: discord })
  return {
    alert,
    title,
    name: clean(col?.name, 64) || shortAddr(contract),
    verified: col?.safelist === "verified",
    marketplace: alert === "launch" && col?.launchpad === "chimera" ? "Chimera" : "OpenSea",
    rows,
    contract,
    extra: opts.extra ?? [],
    tokenId: opts.tokenId ?? null,
    slug: col?.slug ?? null,
    imageUrl: item ?? col?.imageUrl ?? null,
    imageKey: item ? `nft:${contract}:${opts.tokenId}` : `nft:${contract}`,
    links,
  }
}

/** 11x, 1.3x: one number over another, a whole number from 10, else one decimal. */
export function multiple(over: bigint, under: bigint): string {
  const x = Number((over * 100n) / under) / 100
  return `${x >= 10 ? Math.round(x) : Number(x.toFixed(1))}x`
}
