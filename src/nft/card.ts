import type { NftCollectionEvent } from "@ink-indexer/events"
import { clean, safeUrl, usd } from "../format"
import type { AlertKind, TokenAlert } from "../settings"
import { NFTX_LOCKER, safeSlug } from "./nftx"
import type { CollectionState } from "./state"

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
  marketplace: "OpenSea" | "Chimera" | "NFTX"
  /**
   * Where View and Buy go. A card queued before NFTX support has no `link` and reads as OpenSea.
   */
  link: "opensea" | "nftx"
  /** The collection's name in NFTX's URLs, validated; null when there is none. */
  nftxSlug: string | null
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
  /** Adds a Remind me button to a card that is not UPCOMING (AUCTION LIVE). */
  remind?: true
}

/** 0x12ab…cd34 */
export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`

/** A trade's wallet: the Locker is the NFTX pool, anyone else a shortened address. */
export const walletText = (a: string): string =>
  a.toLowerCase() === NFTX_LOCKER ? "NFTX pool" : shortAddr(a)

/**
 * A collection's name: the OpenSea name, else the token name from its NFTX open, else the short address.
 * A collection NFTX trades can have no OpenSea page, so its name comes from the pool's token.
 */
export const stateName = (st: CollectionState | null | undefined, contract: string): string =>
  clean(st?.col?.name, 64) || clean(st?.nftxLaunch?.tokenName, 64) || shortAddr(contract)

/** Dollars: cents under $10, the usual money style above. */
export const usdText = (n: number): string => (n < 10 ? `$${n.toFixed(2)}` : usd(n))

/** Three significant digits, trailing zeros trimmed: 0.00025, 0.0112, 0.427, 3.5. */
export function ethNumber(wei: bigint): string {
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

/** X, Website and Discord links from creator-set values: http(s) only, an X handle becomes its x.com page. */
export function collectionLinks(
  l: { twitter: string | null; website: string | null; discord: string | null } | undefined,
): NftAlertCard["links"] {
  const links: NftAlertCard["links"] = []
  const x = xUrl(l?.twitter)
  const site = safeUrl(l?.website)
  const discord = safeUrl(l?.discord)
  if (x) links.push({ label: "X", url: x })
  if (site) links.push({ label: "Website", url: site })
  if (discord) links.push({ label: "Discord", url: discord })
  return links
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
    /** `"nftx"` labels the card NFTX and sends View and Buy to NFTX. */
    market?: "nftx"
    nftxSlug?: string | null
    remind?: true
  },
): NftAlertCard {
  const contract = col?.contract ?? opts.contract ?? ""
  const item = opts.tokenId !== undefined && opts.imageUrl ? opts.imageUrl : null
  const links = collectionLinks(col?.links)
  return {
    alert,
    title,
    name: clean(col?.name, 64) || shortAddr(contract),
    verified: col?.safelist === "verified",
    marketplace:
      opts.market === "nftx"
        ? "NFTX"
        : alert === "launch" && col?.launchpad === "chimera"
          ? "Chimera"
          : "OpenSea",
    link: opts.market === "nftx" ? "nftx" : "opensea",
    nftxSlug: opts.market === "nftx" ? safeSlug(opts.nftxSlug) : null,
    rows,
    contract,
    extra: opts.extra ?? [],
    tokenId: opts.tokenId ?? null,
    slug: col?.slug ?? null,
    imageUrl: item ?? col?.imageUrl ?? null,
    imageKey: item ? `nft:${contract}:${opts.tokenId}` : `nft:${contract}`,
    links,
    ...(opts.remind ? { remind: true as const } : {}),
  }
}

/** 11x, 1.3x: one number over another, a whole number from 10, else one decimal. */
export function multiple(over: bigint, under: bigint): string {
  const x = Number((over * 100n) / under) / 100
  return `${x >= 10 ? Math.round(x) : Number(x.toFixed(1))}x`
}
