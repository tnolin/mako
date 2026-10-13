import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types"
import type { Button, Card } from "../../cards/card"
import type { ChatType } from "../../delivery/recipients"
import { escapeHtml, safeUrl } from "../../format"
import { ALERT_SQUARE } from "../../settings"

/** Data rows: one <code> per line, labels padded to max(9, longest + 1) so values align. */
export function renderRows(rows: Card["rows"]): string[] {
  const width = Math.max(9, ...rows.map(([label]) => label.length + 1))
  return rows.map(([l, v]) => `<code>${escapeHtml(l.padEnd(width))}${escapeHtml(v)}</code>`)
}

/** Alert HTML: type line, ticker line, name line, one <code> row per line, CA, links. Every creator-written string is escaped here. */
export function renderCard(card: Card): string {
  const rows = renderRows(card.rows)
  const lines = [
    `<b>${ALERT_SQUARE[card.alert]} ${escapeHtml(card.title)}</b>`,
    `<b>$${escapeHtml(card.ticker)}</b>`,
    `${escapeHtml(card.name)} · ${escapeHtml(card.launchpad)}`,
    "",
    ...rows,
    "",
    `CA   <code>${escapeHtml(card.token)}</code>`,
  ]
  // Only http(s) links reach the message, even if a card was built without checking them.
  const links = card.links.filter((l) => safeUrl(l.url) !== null)
  if (links.length > 0) {
    lines.push(
      links.map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join(" · "),
    )
  }
  return lines.join("\n")
}

export function tradeUrl(linksBase: string, ca: string, deliveryId?: string): string {
  return `${linksBase}/t/${ca}${deliveryId ? `?d=${deliveryId}` : ""}`
}

export function alertKeyboard(
  card: Card,
  ctx: { chatType: ChatType; deliveryId?: string; linksBase: string; botUsername: string },
): InlineKeyboardMarkup {
  const trade: InlineKeyboardButton = {
    text: "Trade",
    url: tradeUrl(ctx.linksBase, card.token, ctx.deliveryId),
  }
  if (ctx.chatType !== "private") {
    return {
      inline_keyboard: [
        [trade, { text: "Watch", url: `https://t.me/${ctx.botUsername}?start=w_${card.token}` }],
      ],
    }
  }
  return {
    inline_keyboard: [
      [
        trade,
        { text: "Watch", callback_data: `w:${card.token}` },
        { text: "Mute", callback_data: `m:${card.token}` },
      ],
    ],
  }
}

export function toKeyboard(buttons: Button[][]): InlineKeyboardMarkup {
  return {
    inline_keyboard: buttons.map((row) =>
      row.map(
        (b): InlineKeyboardButton =>
          b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data ?? "noop" },
      ),
    ),
  }
}
