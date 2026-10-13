import type { LaunchEvent } from "@ink-indexer/events"
import type { Card } from "../cards/card"
import { clean, safeUrl } from "../format"
import { type LaunchpadKey, launchpadOf } from "../launchpads"
import type { AlertKind } from "../settings"

export function makeCard(
  alert: AlertKind,
  title: string,
  l: LaunchEvent,
  rows: Card["rows"],
  links: Card["links"] = [],
): Card {
  const ticker = clean(l.ticker, 32) || "?"
  const img = safeUrl(l.imageUrl)
  return {
    alert,
    title,
    ticker,
    name: clean(l.name, 64) || ticker,
    launchpad: launchpadOf(l.launchpad).name,
    launchpadKey: l.launchpad as LaunchpadKey,
    rows,
    links,
    token: l.token,
    imageUrl: img?.startsWith("https:") ? img : null,
  }
}

export function creatorLinks(l: LaunchEvent): Card["links"] {
  const out: Card["links"] = []
  const x = safeUrl(l.links.twitter)
  const tg = safeUrl(l.links.telegram)
  const web = safeUrl(l.links.website)
  if (x) out.push({ label: "X", url: x })
  if (tg) out.push({ label: "Telegram", url: tg })
  if (web) out.push({ label: "Website", url: web })
  return out
}
