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
