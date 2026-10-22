import { createServer, type Server } from "node:http"
import { logAction } from "./actions"
import type { Sql } from "./db"
import type { ChatType } from "./delivery/recipients"
import type { Logger } from "./log"

const PATH = /^\/t\/(0x[0-9a-fA-F]{40})$/
const JOIN = "/inkypump"
const NFT_COLLECTION = /^\/n\/c\/([a-z0-9-]{1,100})$/
const NFT_SALES = /^\/n\/s\/([a-z0-9-]{1,100})$/
const NFT_ITEM = /^\/n\/i\/(0x[0-9a-fA-F]{40})\/([0-9]{1,78})$/
const NFT_CONTRACT = /^\/n\/a\/(0x[0-9a-fA-F]{40})$/
const OPENSEA = "https://opensea.io"
/** The platform links on the NFTs screen (owner, 2026-10-21). They are not logged. */
const PLATFORMS: Record<string, string> = {
  "/p/opensea": OPENSEA,
  "/p/chimera": "https://www.chimeras.ink/discover",
}

/**
 * The OpenSea page for /n/* paths, with the identifier to log (a slug or a contract), or null for a path
 * that is not one. OpenSea links carry no referral code. The URL is plain; a code would go here.
 */
function nftTarget(path: string): { to: string; id: string } | null {
  let m = NFT_COLLECTION.exec(path)
  if (m) return { to: `${OPENSEA}/collection/${m[1]}`, id: m[1]! }
  m = NFT_SALES.exec(path)
  if (m) return { to: `${OPENSEA}/collection/${m[1]}/activity?activityTypes=sale`, id: m[1]! }
  m = NFT_ITEM.exec(path)
  if (m) {
    const ca = m[1]!.toLowerCase()
    return { to: `${OPENSEA}/item/ink/${ca}/${m[2]}`, id: ca }
  }
  m = NFT_CONTRACT.exec(path)
  if (m) {
    // shortcut: OpenSea's URL for a collection by contract alone could not be confirmed (its pages sit
    // behind a bot check), so NEW COLLECTION before a slug is known opens the Ink explorer's token page.
    const ca = m[1]!.toLowerCase()
    return { to: `https://explorer.inkonchain.com/token/${ca}`, id: ca }
  }
  return null
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const BOT_UA =
  /bot|crawler|spider|preview|facebookexternalhit|telegrambot|twitterbot|discordbot|slackbot|whatsapp/i

/** Request targets Node accepts (`//`, `//[`) can still be invalid URLs. Never throw on a public endpoint. */
function parseTarget(target: string | undefined): URL | null {
  try {
    return new URL(target ?? "/", "http://localhost")
  } catch {
    return null
  }
}

/**
 * GET /t/<CA>?d=<delivery uuid> → 302 to the launchpad with the referral code. GET /inkypump → 302 to
 * the launchpad's referral join page. GET /n/c/<slug>, /n/s/<slug>, /n/i/<CA>/<id> and /n/a/<CA> → 302 to
 * the OpenSea page; GET /p/opensea and /p/chimera → the platforms. The response never waits on the database; the click is logged
 * afterwards. IPs and user agents are never stored.
 */
export function createLinkServer(deps: {
  target: (ca: string) => string
  join: () => string
  onClick: (ca: string | null, deliveryId: string | null) => Promise<void>
  /** An NFT page click: the slug or contract and the delivery. */
  onNftClick?: (target: string, deliveryId: string | null) => Promise<void>
  log: Logger
}): Server {
  return createServer((req, res) => {
    const url = parseTarget(req.url)
    const m = req.method === "GET" && url ? PATH.exec(url.pathname) : null
    const join = req.method === "GET" && url?.pathname === JOIN
    const nft = req.method === "GET" && url ? nftTarget(url.pathname) : null
    const platform = req.method === "GET" && url ? PLATFORMS[url.pathname] : undefined
    if (!url || !(m || join || nft || platform)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found")
      return
    }
    const ca = m ? m[1]!.toLowerCase() : null
    const to = nft?.to ?? platform ?? (ca ? deps.target(ca) : deps.join())
    res.writeHead(302, { location: to, "cache-control": "no-store" }).end()
    if (platform || BOT_UA.test(req.headers["user-agent"] ?? "")) return
    const d = url.searchParams.get("d")
    const delivery = d && UUID.test(d) ? d : null
    const logged = nft ? deps.onNftClick?.(nft.id, delivery) : deps.onClick(ca, delivery)
    logged?.catch((err) => deps.log("warn", "click not logged", { error: String(err) }))
  })
}

/**
 * Records a Trade click with the delivery's alert kind and chat type. Clicks from token cards have no
 * delivery. A click on the launchpad referral link has no token and kind "join".
 */
export async function logTradeClick(
  sql: Sql,
  ca: string | null,
  deliveryId: string | null,
): Promise<void> {
  await logClick(sql, "trade_click", ca, deliveryId, ca ? null : "join")
}

/** Records an NFT page click (a slug or a contract) with the delivery's alert kind and chat type. */
export async function logNftClick(
  sql: Sql,
  target: string,
  deliveryId: string | null,
): Promise<void> {
  await logClick(sql, "nft_click", target, deliveryId, null)
}

async function logClick(
  sql: Sql,
  action: "trade_click" | "nft_click",
  ca: string | null,
  deliveryId: string | null,
  noDeliveryKind: string | null,
): Promise<void> {
  const [d] = deliveryId
    ? await sql<{ alert: string; chat_type: ChatType; chat_id: string }[]>`
        select alert, chat_type, chat_id::text from bot.deliveries where id = ${deliveryId}`
    : []
  await logAction(sql, {
    // A missing delivery row defaults to private: the safe choice, since it stores no chat id.
    chatType: d?.chat_type ?? "private",
    chatId: d?.chat_id ?? null,
    action,
    token: ca,
    // The delivery id joins back to chat_id, so keep it only for group-like chats (never private).
    params: {
      d: d && d.chat_type !== "private" ? deliveryId : null,
      kind: d?.alert ?? noDeliveryKind,
    },
  })
}
