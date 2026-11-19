import type { CollectionState } from "./state"

/** NFTX's Locker: the vault every NFTX collection's NFTs sit in. A trade whose buyer or seller is the Locker is against the pool. */
export const NFTX_LOCKER = "0xb4c5b5235b98114e9dc227b54e088c11680b2385"
/** NFTX's pages for Ink collections: `<base>/collections/<slug>`. */
export const NFTX_INK = "https://nftx.io/ink"
export const NFTX_HOME = "https://nftx.io/"
/** A slug is only ever used as a URL path segment, so it must stay in this alphabet and length. */
export const NFTX_SLUG_RE = /^[a-z0-9-]{1,100}$/

export const safeSlug = (s: string | null | undefined): string | null =>
  s != null && NFTX_SLUG_RE.test(s) ? s : null

/**
 * Whether NFTX trades the collection. The collection row's `launchpad` column alone is not enough: a collection
 * that launched on Chimera keeps `chimera` there after it opens on NFTX.
 */
export const onNftx = (st: CollectionState): boolean =>
  st.col?.launchpad === "nftx" ||
  st.nftxLaunch !== null ||
  st.auction !== null ||
  st.stats?.nftxFloorWei != null

/**
 * The NFTX link name for a collection: the event's own, else the state's (auction, then NFTX open, then stats).
 * The first one present is the one used; if it is not a valid slug there is none.
 */
export function nftxSlugOf(
  st: CollectionState | undefined,
  fromEvent?: string | null,
): string | null {
  const found = [
    fromEvent,
    st?.auction?.nftxSlug,
    st?.nftxLaunch?.nftxSlug,
    st?.stats?.nftxSlug,
  ].find((s) => s != null)
  return safeSlug(found)
}
