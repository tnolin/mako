import type { BondEvent, LaunchEvent } from "@ink-indexer/events"
import type { Bot, Context } from "grammy"
import { valueText } from "../cards/money"
import { age, bar, buysSells, clean, escapeHtml } from "../format"
import { bondOf, cursorBlock, DAY_BLOCKS, launchOf, tradesOf } from "../history"
import { unknownTokenText } from "../launchpads"
import { classify } from "../platforms/telegram/errors"
import { CAPTION_MAX } from "../platforms/telegram/images"
import { renderRows, tradeUrl } from "../platforms/telegram/render"
import { btn, findAddress, type Kb, link, show, threadOf } from "../platforms/telegram/ui"
import { isPoolId, poolMcap } from "../pool"
import { creatorLinks, makeCard } from "../rules/card"
import { devCounts, windowStats } from "../rules/stats"
import { REFRESH_COOLDOWN_MS, refreshCooldown } from "./cooldown"
import type { BotDeps } from "./deps"
import { tryNftPaste } from "./nft"
import { WATCH_PROMPT, watchToken } from "./watchlist"

export const LOOKUP_PROMPT = "Send a token address."

export { REFRESH_COOLDOWN_MS, refreshCooldown }

/** Time since bonding: whole days from one day, whole hours below that, "<1h" under an hour. */
function bondedAgo(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  if (h < 1) return "<1h"
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

export type TokenCard = { html: string; imageUrl: string | null }

/** Current market cap from the token's v4 pool in raw quote units, or null when it can't be read. Never throws. */
async function liveMcap(deps: BotDeps, b: BondEvent, l: LaunchEvent): Promise<bigint | null> {
  const id = String(b.poolId ?? "").toLowerCase()
  if (!deps.readSqrtPrice || !isPoolId(id)) return null
  try {
    return poolMcap(await deps.readSqrtPrice(id), l.token, l.quoteAsset, l.totalSupply)
  } catch (err) {
    // rpcSqrtPrice throws fixed messages (or the node's own error text), never the RPC URL, which can hold a key.
    deps.log("warn", "pool price read failed", {
      token: l.token,
      reason: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    })
    return null
  }
}

export async function tokenCard(deps: BotDeps, ca: string): Promise<TokenCard | null> {
  const { sql, prices } = deps
  const l = await launchOf(sql, ca)
  if (!l) return null
  const [trades, b, cursor] = await Promise.all([
    tradesOf(sql, ca),
    bondOf(sql, ca),
    cursorBlock(sql),
  ])
  const now = Math.floor(Date.now() / 1000)
  const last = trades.at(-1)
  const q = l.p.quoteAsset
  const dev = devCounts(trades, l.p.creator, last?.id ?? l.id)
  const rows: [string, string][] = []
  if (b) {
    // We don't index post-bond trades, so a bonded token's volume and trades are its curve totals.
    const w = windowStats(trades, 0, b.id)
    const ago = `${bondedAgo(now - b.p.blockTimestamp)} ago`
    const live = await liveMcap(deps, b.p, l.p)
    if (live !== null) {
      rows.push(["bonded", ago], ["mcap", valueText(live, q, prices)])
    } else {
      const at = last ? ` at ${valueText(last.p.marketCap, q, prices)}` : ""
      rows.push(["bonded", `${ago}${at}`])
    }
    rows.push(["volume", valueText(w.volume, q, prices)], ["trades", buysSells(w.buys, w.sells)])
  } else {
    // shortcut: without an indexer cursor (an empty database) the 24h window is every trade.
    const from = cursor === null ? null : BigInt(cursor) - BigInt(DAY_BLOCKS)
    const day = trades.filter((t) => from === null || BigInt(t.p.blockNumber) >= from)
    const w = windowStats(day, 0, last?.id ?? l.id)
    rows.push(["curve", bar(last?.p.soldBps ?? 0)])
    if (last) rows.push(["mcap", valueText(last.p.marketCap, q, prices)])
    rows.push(
      ["volume", `${valueText(w.volume, q, prices)} (24h)`],
      ["trades", `${buysSells(w.buys, w.sells)} (24h)`],
    )
  }
  rows.push(["age", age(now - l.p.blockTimestamp)], ["dev", buysSells(dev.buys, dev.sells)])
  const card = makeCard("new", "", l.p, rows, creatorLinks(l.p))
  const desc = clean(l.p.description, 200)
  const lines = [
    `<b>$${escapeHtml(card.ticker)}</b>`,
    `${escapeHtml(card.name)} · ${escapeHtml(card.launchpad)}`,
    "",
    ...renderRows(rows),
    "",
    ...(desc ? [escapeHtml(desc), ""] : []),
    `CA   <code>${ca}</code>`,
  ]
  if (card.links.length > 0) {
    lines.push(card.links.map((x) => `<a href="${escapeHtml(x.url)}">${x.label}</a>`).join(" · "))
  }
  return { html: lines.join("\n"), imageUrl: card.imageUrl }
}

/** Buttons under a token card. */
export function tokenKb(
  deps: Pick<BotDeps, "linksBase">,
  ca: string,
  /** In a DM: a Watch button. Elsewhere: a deep link into the bot. */
  watch: { dm: true; watching: boolean } | { dm: false; botUsername: string },
  /** Opened from a list: a Back row to it. */
  back?: string,
): Kb {
  const kb: Kb = [
    [
      link("Trade", tradeUrl(deps.linksBase, ca)),
      watch.dm
        ? btn(watch.watching ? "Watching" : "Watch", `w:${ca}`)
        : link("Watch", `https://t.me/${watch.botUsername}?start=w_${ca}`),
    ],
    [
      btn("Refresh", `tr:${ca}${back ? `:${back}` : ""}`),
      link("Explorer", `https://explorer.inkonchain.com/token/${ca}`),
    ],
  ]
  if (back) kb.push([btn("Back", `l:${back}`)])
  return kb
}

async function isWatching(deps: BotDeps, tg: number, ca: string): Promise<boolean> {
  const r = await deps.sql`
    select 1 from bot.subscriptions s join bot.users u on u.id = s.user_id
    where u.platform_user_id = ${tg} and s.kind = 'watch' and s.target = ${ca}`
  return r.length > 0
}

/** The card for a token, or null after `missing` told the user it is not one. Buttons depend on the chat. */
async function loadCard(
  ctx: Context,
  deps: BotDeps,
  raw: string,
  missing: (text: string) => Promise<void> = (text) => show(ctx, escapeHtml(text)),
  back?: string,
) {
  const ca = findAddress(raw)
  if (!ca) {
    await show(ctx, "Send a token address (0x…).")
    return null
  }
  const card = await tokenCard(deps, ca)
  if (!card) {
    await missing(unknownTokenText())
    return null
  }
  const dm = ctx.chat?.type === "private"
  const watching = dm && ctx.from ? await isWatching(deps, ctx.from.id, ca) : false
  const kb = tokenKb(deps, ca, dm ? { dm, watching } : { dm, botUsername: ctx.me.username }, back)
  return { ca, ...card, kb }
}

/** Sends the card as a new message: a padded photo with the card as caption, or text. */
export async function sendTokenCard(
  ctx: Context,
  deps: BotDeps,
  raw: string,
  back?: string,
): Promise<void> {
  const card = await loadCard(ctx, deps, raw, undefined, back)
  if (!card) return
  // Fetching and uploading the image can take seconds; the tap is answered first.
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {})
  await deps.images.send(ctx.api, {
    chat: ctx.chat!.id,
    thread: threadOf(ctx),
    imageKey: card.ca,
    imageUrl: card.imageUrl,
    html: card.html,
    reply_markup: { inline_keyboard: card.kb },
  })
}

/** Refresh edits the tapped card in place: the caption of a photo, the text of a text card. */
async function refreshTokenCard(
  ctx: Context,
  deps: BotDeps,
  raw: string,
  back?: string,
): Promise<void> {
  const tapped = ctx.callbackQuery?.message
  const isPhoto = !!tapped && "photo" in tapped && !!tapped.photo
  // A photo cannot be edited into the "not a token" text, so that case is answered in place.
  const card = await loadCard(
    ctx,
    deps,
    raw,
    isPhoto
      ? (text) => ctx.answerCallbackQuery({ text }).then(() => {})
      : (text) => show(ctx, escapeHtml(text)),
    back,
  )
  if (!card) return
  const reply_markup = { inline_keyboard: card.kb }
  if (isPhoto && card.html.length > CAPTION_MAX) {
    // The card grew past what a caption holds: a new text message replaces the photo card.
    await deps.images.send(ctx.api, {
      chat: ctx.chat!.id,
      thread: threadOf(ctx),
      imageKey: card.ca,
      imageUrl: null,
      html: card.html,
      reply_markup,
    })
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  try {
    if (isPhoto) {
      await ctx.editMessageCaption({ caption: card.html, parse_mode: "HTML", reply_markup })
    } else {
      await ctx.editMessageText(card.html, {
        parse_mode: "HTML",
        reply_markup,
        link_preview_options: { is_disabled: true },
      })
    }
  } catch (err) {
    if (classify(err).kind !== "not_modified") throw err
  }
  await ctx.answerCallbackQuery().catch(() => {})
}

export function registerToken(bot: Bot, deps: BotDeps): void {
  bot.command("t", (ctx) => sendTokenCard(ctx, deps, ctx.match))
  bot.callbackQuery(/^t:(0x[0-9a-f]{40})(?::(hot|near|bonded))?$/, (ctx) =>
    sendTokenCard(ctx, deps, ctx.match[1]!, ctx.match[2]),
  )
  const cooldown = refreshCooldown(REFRESH_COOLDOWN_MS)
  bot.callbackQuery(/^tr:(0x[0-9a-f]{40})(?::(hot|near|bonded))?$/, async (ctx) => {
    const ca = ctx.match[1]!
    // Checked before any read: a tap inside the cooldown touches neither the database nor the node.
    const wait = cooldown(`${ctx.from.id}:${ca}`)
    if (wait > 0) {
      await ctx.answerCallbackQuery({ text: `Up to date, try again in ${wait}s` }).catch(() => {})
      return
    }
    await refreshTokenCard(ctx, deps, ca, ctx.match[2])
  })
  const pm = bot.chatType("private")
  pm.callbackQuery("look", async (ctx) => {
    await ctx.answerCallbackQuery()
    await ctx.reply(LOOKUP_PROMPT, {
      reply_markup: { force_reply: true, input_field_placeholder: "0x…" },
    })
  })
  pm.on("message:text", async (ctx, next) => {
    const r = ctx.msg.reply_to_message
    const prompt = r?.from?.id === ctx.me.id ? r.text : undefined
    if (prompt === WATCH_PROMPT) return watchToken(ctx, deps, ctx.msg.text)
    const text = ctx.msg.text
    const ca = findAddress(text)
    if (ca) {
      // A launch event match opens the token card first; else a known collection opens its card.
      if (!(await launchOf(deps.sql, ca)) && (await tryNftPaste(ctx, deps, text))) return
      return sendTokenCard(ctx, deps, text)
    }
    if (prompt === LOOKUP_PROMPT) return sendTokenCard(ctx, deps, text)
    if (await tryNftPaste(ctx, deps, text)) return
    return next()
  })
}
