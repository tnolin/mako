import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types"
import type { Button, Card, Payload } from "../../cards/card"
import { BATCH_SHOWN } from "../../delivery/flood"
import type { ChatType } from "../../delivery/recipients"
import { escapeHtml, safeUrl } from "../../format"
import type { NftAlertCard } from "../../nft/card"
import { btnOn, stateBtn } from "./ui"

/** Data rows: one <code> per line, labels padded to max(9, longest + 1) so values align. */
export function renderRows(rows: Card["rows"]): string[] {
  const width = Math.max(9, ...rows.map(([label]) => label.length + 1))
  return rows.map(([l, v]) => `<code>${escapeHtml(l.padEnd(width))}${escapeHtml(v)}</code>`)
}

/** Alert HTML: title line, ticker line, name line, one <code> row per line, CA, links. Every creator-written string is escaped here. */
export function renderCard(card: Card): string {
  const rows = renderRows(card.rows)
  const lines = [
    `<b>${escapeHtml(card.title)}</b>`,
    `$${escapeHtml(card.ticker)}`,
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

/** An NFT alert: bold title, `Name ✓ · OpenSea`, one <code> row per line, CA (and any token address), links. */
export function renderNftAlert(card: NftAlertCard): string {
  const addrs: [string, string][] = [["CA", card.contract], ...card.extra]
  // A lone CA keeps the token alerts' three spaces; with more addresses the labels align two columns past the longest.
  const width = card.extra.length === 0 ? 5 : Math.max(...addrs.map(([l]) => l.length)) + 2
  const lines = [
    `<b>${escapeHtml(card.title)}</b>`,
    `${escapeHtml(card.name)}${card.verified ? " ✓" : ""} · ${escapeHtml(card.marketplace)}`,
    "",
    ...renderRows(card.rows),
    "",
    ...addrs.map(([l, a]) => `${escapeHtml(l.padEnd(width))}<code>${escapeHtml(a)}</code>`),
  ]
  const links = card.links.filter((l) => safeUrl(l.url) !== null)
  if (links.length > 0) {
    lines.push(
      links.map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join(" · "),
    )
  }
  return lines.join("\n")
}

/** What the viewer already did with the collection; group keyboards ignore it. */
export type NftViewerState = { watching?: boolean; muted?: boolean; reminded?: boolean }

const ITEM_PAGE = new Set<NftAlertCard["alert"]>(["under", "rare", "sale", "bigsale"])

export function nftAlertKeyboard(
  card: NftAlertCard,
  ctx: {
    chatType: ChatType
    deliveryId?: string
    linksBase: string
    botUsername: string
    state?: NftViewerState
  },
): InlineKeyboardMarkup {
  const d = ctx.deliveryId ? `?d=${ctx.deliveryId}` : ""
  const c = card.contract
  const item = ITEM_PAGE.has(card.alert) && card.tokenId !== null
  const path = item ? `/n/i/${c}/${card.tokenId}` : card.slug ? `/n/c/${card.slug}` : `/n/a/${c}`
  const open: InlineKeyboardButton = {
    text: card.alert === "under" || card.alert === "rare" ? "Buy" : "View",
    url: `${ctx.linksBase}${path}${d}`,
  }
  const st = ctx.state ?? {}
  if (ctx.chatType === "private" && card.alert === "reminder") {
    return { inline_keyboard: [[open, btnOn("Reminder set", `nrr:${c}`)]] }
  }
  const deep = (text: string, prefix: string): InlineKeyboardButton => ({
    text,
    url: `https://t.me/${ctx.botUsername}?start=${prefix}_${c}`,
  })
  if (ctx.chatType !== "private") {
    const rows = [[open, deep("Watch", "wn")]]
    if (card.alert === "upcoming") rows.push([deep("Remind me", "rn")])
    return { inline_keyboard: rows }
  }
  const row = [
    open,
    stateBtn(
      { on: !!st.watching, off: "Watch", onText: "Watching" },
      `${st.watching ? "nws" : "nwa"}:${c}`,
    ),
    stateBtn({ on: !!st.muted, off: "Mute", onText: "Muted" }, `${st.muted ? "nmu" : "nm"}:${c}`),
  ]
  const rows = [row]
  if (card.alert === "upcoming") {
    rows.push([
      stateBtn(
        { on: !!st.reminded, off: "Remind me", onText: "Reminder set" },
        `${st.reminded ? "nrr" : "nrm"}:${c}`,
      ),
    ])
  }
  return { inline_keyboard: rows }
}

export function tradeUrl(linksBase: string, ca: string, deliveryId?: string): string {
  return `${linksBase}/t/${ca}${deliveryId ? `?d=${deliveryId}` : ""}`
}

export function alertKeyboard(
  card: Card,
  ctx: {
    chatType: ChatType
    deliveryId?: string
    linksBase: string
    botUsername: string
    state?: { watching?: boolean; muted?: boolean }
  },
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
        stateBtn(
          { on: !!ctx.state?.watching, off: "Watch", onText: "Watching" },
          `w:${card.token}`,
        ),
        stateBtn({ on: !!ctx.state?.muted, off: "Mute", onText: "Muted" }, `m:${card.token}`),
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

/** A launch-flood card: up to BATCH_SHOWN tokens, newest first, each line a link to its token card. */
export function renderNewTokens(
  p: Extract<Payload, { type: "newtokens" }>,
  botUsername: string,
): string {
  const shown = [...p.entries].reverse().slice(0, BATCH_SHOWN)
  const more = p.entries.length - shown.length
  const lines = [
    "<b>NEW TOKENS</b>",
    escapeHtml(p.launchpad),
    "",
    ...shown.map(
      (e) =>
        `<a href="https://t.me/${botUsername}?start=t_${e.token}">${escapeHtml(e.name)} · $${escapeHtml(e.ticker)}</a>`,
    ),
  ]
  if (more > 0) lines.push(`and ${more} more token${more === 1 ? "" : "s"}`)
  return lines.join("\n")
}
