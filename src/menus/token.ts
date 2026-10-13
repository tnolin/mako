import type { Bot, Context } from "grammy"
import { valueText } from "../cards/money"
import { age, bar, buysSells, clean, count, escapeHtml } from "../format"
import { bondOf, launchOf, tradesOf } from "../history"
import { launchpadOf, unknownTokenText } from "../launchpads"
import { classify } from "../platforms/telegram/errors"
import { renderRows, tradeUrl } from "../platforms/telegram/render"
import { btn, findAddress, type Kb, link, show, threadOf } from "../platforms/telegram/ui"
import { creatorLinks, makeCard } from "../rules/card"
import { devCounts, windowStats } from "../rules/stats"
import type { BotDeps } from "./deps"
import { WATCH_PROMPT, watchToken } from "./watchlist"

export const LOOKUP_PROMPT = "Send a token address."

export async function tokenCard(
  deps: BotDeps,
  ca: string,
): Promise<{ html: string; imageUrl: string | null } | null> {
  const { sql, prices } = deps
  const l = await launchOf(sql, ca)
  if (!l) return null
  const [trades, b] = await Promise.all([tradesOf(sql, ca), bondOf(sql, ca)])
  const now = Math.floor(Date.now() / 1000)
  const last = trades.at(-1)
  const q = l.p.quoteAsset
  const dev = devCounts(trades, l.p.creator, last?.id ?? l.id)
  const rows: [string, string][] = []
  if (b) {
    const w = windowStats(trades, 0, b.id)
    rows.push(["curve", bar(10_000)])
    if (last) rows.push(["mcap at bond", valueText(last.p.marketCap, q, prices)])
    rows.push(["volume", valueText(w.volume, q, prices)], ["trades", count(w.buys + w.sells)])
  } else {
    const w = windowStats(trades, now - 3600, last?.id ?? l.id)
    rows.push(["curve", bar(last?.p.soldBps ?? 0)])
    if (last) rows.push(["mcap", valueText(last.p.marketCap, q, prices)])
    rows.push(
      ["volume", `${valueText(w.volume, q, prices)} (1h)`],
      ["trades", `${buysSells(w.buys, w.sells)} (1h)`],
    )
  }
  rows.push(["age", age(now - l.p.blockTimestamp)], ["dev", buysSells(dev.buys, dev.sells)])
  const card = makeCard("new", "", l.p, rows, creatorLinks(l.p))
  const desc = clean(l.p.description, 200)
  const lines = [
    `<b>$${escapeHtml(card.ticker)} · ${escapeHtml(card.name)}</b>`,
    `${escapeHtml(launchpadOf(l.p.launchpad).name)} · ${b ? "bonded" : "curve"}`,
    ...renderRows(rows),
    ...(desc ? [escapeHtml(desc)] : []),
    `CA   <code>${ca}</code>`,
  ]
  if (card.links.length > 0) {
    lines.push(card.links.map((x) => `<a href="${escapeHtml(x.url)}">${x.label}</a>`).join(" · "))
  }
  return { html: lines.join("\n"), imageUrl: card.imageUrl }
}

async function isWatching(deps: BotDeps, tg: number, ca: string): Promise<boolean> {
  const r = await deps.sql`
    select 1 from bot.subscriptions s join bot.users u on u.id = s.user_id
    where u.platform_user_id = ${tg} and s.kind = 'watch' and s.target = ${ca}`
  return r.length > 0
}

/** The card for a token, or null after telling the user it is not one. Buttons depend on the chat. */
async function loadCard(ctx: Context, deps: BotDeps, raw: string) {
  const ca = findAddress(raw)
  if (!ca) {
    await show(ctx, "Send a token address (0x…).")
    return null
  }
  const card = await tokenCard(deps, ca)
  if (!card) {
    await show(ctx, escapeHtml(unknownTokenText()))
    return null
  }
  const dm = ctx.chat?.type === "private"
  const watching = dm && ctx.from ? await isWatching(deps, ctx.from.id, ca) : false
  const kb: Kb = [
    [
      link("Trade", tradeUrl(deps.linksBase, ca)),
      dm
        ? btn(watching ? "Watching" : "Watch", `w:${ca}`)
        : link("Watch", `https://t.me/${ctx.me.username}?start=w_${ca}`),
    ],
    [btn("Refresh", `tr:${ca}`), link("Explorer", `https://explorer.inkonchain.com/token/${ca}`)],
  ]
  return { ca, ...card, kb }
}

/** Sends the card as a new message: a padded photo with the card as caption, or text. */
export async function sendTokenCard(ctx: Context, deps: BotDeps, raw: string): Promise<void> {
  const card = await loadCard(ctx, deps, raw)
  if (!card) return
  await deps.images.send(ctx.api, {
    chat: ctx.chat!.id,
    thread: threadOf(ctx),
    token: card.ca,
    imageUrl: card.imageUrl,
    html: card.html,
    reply_markup: { inline_keyboard: card.kb },
  })
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {})
}

/** Refresh edits the tapped card in place: the caption of a photo, the text of a text card. */
async function refreshTokenCard(ctx: Context, deps: BotDeps, raw: string): Promise<void> {
  const card = await loadCard(ctx, deps, raw)
  if (!card) return
  const reply_markup = { inline_keyboard: card.kb }
  const tapped = ctx.callbackQuery?.message
  try {
    if (tapped && "photo" in tapped && tapped.photo) {
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
  bot.callbackQuery(/^t:(0x[0-9a-f]{40})$/, (ctx) => sendTokenCard(ctx, deps, ctx.match[1]!))
  bot.callbackQuery(/^tr:(0x[0-9a-f]{40})$/, (ctx) => refreshTokenCard(ctx, deps, ctx.match[1]!))
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
    if (prompt === LOOKUP_PROMPT || findAddress(ctx.msg.text))
      return sendTokenCard(ctx, deps, ctx.msg.text)
    return next()
  })
}
