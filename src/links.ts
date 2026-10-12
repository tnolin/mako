import { createServer, type Server } from "node:http"
import { logAction } from "./actions"
import type { Sql } from "./db"
import type { ChatType } from "./delivery/recipients"
import type { Logger } from "./log"

const PATH = /^\/t\/(0x[0-9a-fA-F]{40})$/
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
 * GET /t/<CA>?d=<delivery uuid> → 302 to the launchpad with the referral code. The response never
 * waits on the database; the click is logged afterwards. IPs and user agents are never stored.
 */
export function createLinkServer(deps: {
  target: (ca: string) => string
  onClick: (ca: string, deliveryId: string | null) => Promise<void>
  log: Logger
}): Server {
  return createServer((req, res) => {
    const url = parseTarget(req.url)
    const m = req.method === "GET" && url ? PATH.exec(url.pathname) : null
    if (!url || !m) {
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
    // A missing delivery row defaults to private: the safe choice, since it stores no chat id.
    chatType: d?.chat_type ?? "private",
    chatId: d?.chat_id ?? null,
    action: "trade_click",
    token: ca,
    // The delivery id joins back to chat_id, so keep it only for group-like chats (never private).
    params: { d: d && d.chat_type !== "private" ? deliveryId : null, kind: d?.alert ?? null },
  })
}
