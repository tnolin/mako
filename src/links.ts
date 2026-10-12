import { createServer, type Server } from "node:http"
import { logAction } from "./actions"
import type { Sql } from "./db"
import type { ChatType } from "./delivery/recipients"
import type { Logger } from "./log"

const PATH = /^\/t\/(0x[0-9a-fA-F]{40})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const BOT_UA =
  /bot|crawler|spider|preview|facebookexternalhit|telegrambot|twitterbot|discordbot|slackbot|whatsapp/i

/**
 * GET /t/<CA>?d=<delivery uuid> → 302 to the launchpad with the referral code. The response never
 * waits on the database; the click is logged afterwards. IPs and user agents are never stored.
 */
export function createLinkServer(deps: {
  target: (ca: string) => string
  onClick: (ca: string, deliveryId: string | null) => Promise<void>
  log: Logger
}): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const m = req.method === "GET" ? PATH.exec(url.pathname) : null
    if (!m) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found")
      return
    }
    const ca = m[1]!.toLowerCase()
    res.writeHead(302, { location: deps.target(ca), "cache-control": "no-store" }).end()
    if (BOT_UA.test(req.headers["user-agent"] ?? "")) return
    const d = url.searchParams.get("d")
    deps
      .onClick(ca, d && UUID.test(d) ? d : null)
      .catch((err) => deps.log("warn", "trade click not logged", { error: String(err) }))
  })
}

/** Records a Trade click with the delivery's alert kind and chat type. Clicks from token cards have no delivery. */
export async function logTradeClick(
  sql: Sql,
  ca: string,
  deliveryId: string | null,
): Promise<void> {
  const [d] = deliveryId
    ? await sql<{ alert: string; chat_type: ChatType; chat_id: string }[]>`
        select alert, chat_type, chat_id::text from bot.deliveries where id = ${deliveryId}`
    : []
  await logAction(sql, {
    chatType: d?.chat_type ?? "private",
    chatId: d?.chat_id ?? null,
    action: "trade_click",
    token: ca,
    params: { d: deliveryId, kind: d?.alert ?? null },
  })
}
