import type { Bot, Context } from "grammy"
import type { InlineKeyboardButton } from "grammy/types"
import { logAction } from "../actions"
import { clean, escapeHtml } from "../format"
import { launchesOf, launchOf } from "../history"
import { classify } from "../platforms/telegram/errors"
import { btn, findAddress, isAdmin, type Kb, show, stateBtn } from "../platforms/telegram/ui"
import { chatKind, chatTitle, NOT_ADMIN } from "./alerts"
import { chatCode } from "./chat-code"
import { dm, NOT_FOUND, popup, WATCH_LIMIT, WATCH_USAGE } from "./copy"
import type { BotDeps } from "./deps"
import { ensureUser, findUser, NO_USER, type User } from "./users"
import { sendWelcome } from "./welcome"

export const WATCH_CAP = 50

const WATCHED_INTRO =
  "These are all the tokens you are currently watching. If you no longer wish to receive alerts for these, simply click Remove next to each token."
const WATCHED_EMPTY =
  "You're not watching anything yet. Tap Watch on any alert or card to add it here."
const MUTED_INTRO = "I won't send you any alerts about these. Tap Unmute to undo."
const MUTED_EMPTY = "You haven't muted anything."

type Kind = "watch" | "mute"

const cutName = (s: string) => {
  const c = [...s]
  return c.length > 18 ? `${c.slice(0, 17).join("")}…` : s
}
const tickerOf = async (deps: BotDeps, ca: string) =>
  `$${clean((await launchOf(deps.sql, ca))?.p.ticker, 32) || "?"}`

async function has(deps: BotDeps, user: User, kind: Kind, ca: string): Promise<boolean> {
  const r = await deps.sql`
    select 1 from bot.subscriptions where user_id = ${user.id} and kind = ${kind} and target = ${ca}`
  return r.length > 0
}

async function remove(deps: BotDeps, user: User, kind: Kind, ca: string): Promise<boolean> {
  const r = await deps.sql`
    delete from bot.subscriptions where user_id = ${user.id} and kind = ${kind} and target = ${ca} returning 1`
  return r.length > 0
}

/** Watches a token. A token is watched, muted or neither, so this removes the user's mute. */
async function addWatch(
  deps: BotDeps,
  user: User,
  ca: string,
): Promise<"added" | "exists" | "limit"> {
  if (await has(deps, user, "watch", ca)) return "exists"
  const [n] = await deps.sql<{ n: number }[]>`
    select count(*)::int as n from bot.subscriptions where user_id = ${user.id} and kind = 'watch'`
  if ((n?.n ?? 0) >= WATCH_CAP) return "limit"
  await remove(deps, user, "mute", ca)
  await deps.sql`insert into bot.subscriptions (user_id, kind, target) values (${user.id}, 'watch', ${ca}) on conflict do nothing`
  await logAction(deps.sql, { chatType: "private", action: "watch", token: ca })
  return "added"
}

const dmKb = (ca: string): Kb => [
  [stateBtn({ on: true, off: "Watch", onText: "Watching" }, `w:${ca}`), btn("My alerts", "al:u")],
]

/** Watches a token from /watch or a w_ deep link. Replies with the DM message. */
export async function watchToken(ctx: Context, deps: BotDeps, raw: string): Promise<void> {
  const ca = findAddress(raw)
  if (!ca || !ctx.from) {
    await ctx.reply(WATCH_USAGE)
    return
  }
  const l = await launchOf(deps.sql, ca)
  if (!l) {
    await ctx.reply(NOT_FOUND)
    return
  }
  // A typed command or message is a fresh user action, so it may create the user.
  const { user, created } = await ensureUser(deps.sql, ctx.from.id)
  const r = await addWatch(deps, user, ca)
  if (r === "limit") {
    await ctx.reply(WATCH_LIMIT)
    return
  }
  const name = `$${clean(l.p.ticker, 32)}`
  await ctx.reply(r === "added" ? dm.watching(name, "token") : dm.alreadyWatching(name), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: dmKb(ca) },
  })
  // Action first, then the welcome card, as /start does for deep links.
  if (created) await sendWelcome(ctx, user.settings)
}

/**
 * An admin's /watch in a group: the chat watches the token, up to WATCH_CAP, counted apart from collections.
 * shortcut: the cap is checked before the insert without a lock, so two commands at once can pass 50 by one.
 */
export async function watchTokenForChat(ctx: Context, deps: BotDeps, ca: string): Promise<void> {
  const chatId = String(ctx.chat!.id)
  const name = await tickerOf(deps, ca)
  const reply = (text: string) =>
    ctx.reply(text, {
      parse_mode: "HTML",
      message_thread_id:
        ctx.msg && "is_topic_message" in ctx.msg && ctx.msg.is_topic_message
          ? ctx.msg.message_thread_id
          : undefined,
    })
  const [have] = await deps.sql`
    select 1 from bot.chat_token_watches where chat_id = ${chatId} and target = ${ca}`
  if (have) return void (await reply(dm.alreadyWatching(name)))
  const [n] = await deps.sql<{ n: number }[]>`
    select count(*)::int as n from bot.chat_token_watches where chat_id = ${chatId}`
  if ((n?.n ?? 0) >= WATCH_CAP) return void (await reply(WATCH_LIMIT))
  await deps.sql`insert into bot.chat_token_watches (chat_id, target) values (${chatId}, ${ca}) on conflict do nothing`
  await logAction(deps.sql, {
    chatType: await chatKind(deps.sql, chatId),
    chatId,
    action: "watch",
    token: ca,
  })
  await reply(dm.groupWatching(name))
}

/** A group's Watched tokens, shown in an admin's DM (never in the group). Live admin check on every tap. */
async function groupTokensScreen(
  ctx: Context,
  deps: BotDeps,
  chatId: string,
  remove?: string,
): Promise<void> {
  if (!(await isAdmin(ctx.api, chatId, ctx.from!.id))) {
    await ctx.answerCallbackQuery({ text: NOT_ADMIN, show_alert: true }).catch(() => {})
    return
  }
  if (remove) {
    const gone = await deps.sql`
      delete from bot.chat_token_watches where chat_id = ${chatId} and target = ${remove} returning 1`
    if (gone.length > 0)
      await logAction(deps.sql, {
        chatType: await chatKind(deps.sql, chatId),
        chatId,
        action: "unwatch",
        token: remove,
      })
    await ctx
      .answerCallbackQuery({ text: popup.stop(await tickerOf(deps, remove)) })
      .catch(() => {})
  }
  const rows = await deps.sql<{ target: string }[]>`
    select target from bot.chat_token_watches where chat_id = ${chatId} order by created_at, target`
  const meta = await launchesOf(
    deps.sql,
    rows.map((r) => r.target),
  )
  const label = (t: string) => `$${clean(meta.get(t)?.ticker, 32) || "?"}`
  const title = `<b>Watched tokens for ${escapeHtml(await chatTitle(ctx, chatId))}</b>`
  const back = [btn("Back", `al:${chatId}`)]
  if (rows.length === 0) return show(ctx, `${title}\n${WATCHED_EMPTY}`, [back])
  await show(ctx, `${title}\n${WATCHED_INTRO}`, [
    ...rows.map((r) => [
      btn(cutName(label(r.target)), `t:${r.target}:y${chatCode(chatId)}`),
      btn("Remove", `gl:${chatId}:t:${r.target}`),
    ]),
    back,
  ])
}

/** Redraws the Watch and Mute buttons of the tapped message from the user's state. */
async function restyle(ctx: Context, ca: string, watching: boolean, muted: boolean): Promise<void> {
  const kb = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard
  if (!kb) return
  const next = kb.map((row) =>
    row.map((b): InlineKeyboardButton => {
      if (!("callback_data" in b)) return b
      if (b.callback_data === `w:${ca}`)
        return stateBtn({ on: watching, off: "Watch", onText: "Watching" }, b.callback_data)
      if (b.callback_data === `m:${ca}`)
        return stateBtn({ on: muted, off: "Mute", onText: "Muted" }, b.callback_data)
      return b
    }),
  )
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: next } }).catch((err) => {
    if (classify(err).kind !== "not_modified") throw err
  })
}

async function listScreen(ctx: Context, deps: BotDeps, user: User, kind: Kind): Promise<void> {
  const rows = await deps.sql<{ target: string }[]>`
    select target from bot.subscriptions where user_id = ${user.id} and kind = ${kind} order by created_at`
  const meta = await launchesOf(
    deps.sql,
    rows.map((r) => r.target),
  )
  const label = (t: string) => `$${clean(meta.get(t)?.ticker, 32) || "?"}`
  const [title, intro, empty] =
    kind === "watch"
      ? ["Watched tokens", WATCHED_INTRO, WATCHED_EMPTY]
      : ["Muted tokens", MUTED_INTRO, MUTED_EMPTY]
  const back = [btn("Back", "al:u")]
  if (rows.length === 0) return show(ctx, `<b>${title}</b>\n${empty}`, [back])
  await show(ctx, `<b>${title}</b>\n${intro}`, [
    ...rows.map((r) => [
      btn(cutName(label(r.target)), `t:${r.target}:${kind === "watch" ? "wl" : "mu"}`),
      kind === "watch" ? btn("Remove", `wl:rm:${r.target}`) : btn("Unmute", `um:${r.target}`),
    ]),
    back,
  ])
}

type Tap = Context & { match: string | RegExpMatchArray }
const addressOf = (ctx: Tap) => (ctx.match as RegExpMatchArray)[1]!

export function registerWatchlist(bot: Bot, deps: BotDeps): void {
  const pm = bot.chatType("private")
  // Taps on buttons never create a user: after Delete my data an old button must not bring the row back.
  const listTap =
    (kind: Kind, change?: (user: User, ca: string) => Promise<string>) => async (ctx: Tap) => {
      const user = await findUser(deps.sql, ctx.from!.id)
      if (!user) return show(ctx, NO_USER)
      if (change) {
        const text = await change(user, addressOf(ctx))
        await ctx.answerCallbackQuery({ text }).catch(() => {})
      }
      await listScreen(ctx, deps, user, kind)
    }
  pm.callbackQuery(/^gl:(-?\d+):t$/, (ctx) => groupTokensScreen(ctx, deps, ctx.match[1]!))
  pm.callbackQuery(/^gl:(-?\d+):t:(0x[0-9a-f]{40})$/, (ctx) =>
    groupTokensScreen(ctx, deps, ctx.match[1]!, ctx.match[2]),
  )
  pm.callbackQuery("wl", listTap("watch"))
  pm.callbackQuery("mu", listTap("mute"))
  pm.callbackQuery(
    /^wl:rm:(0x[0-9a-f]{40})$/,
    listTap("watch", async (user, ca) => {
      if (await remove(deps, user, "watch", ca))
        await logAction(deps.sql, { chatType: "private", action: "unwatch", token: ca })
      return popup.stop(await tickerOf(deps, ca))
    }),
  )
  pm.callbackQuery(
    /^um:(0x[0-9a-f]{40})$/,
    listTap("mute", async (user, ca) => {
      if (await remove(deps, user, "mute", ca))
        await logAction(deps.sql, { chatType: "private", action: "unmute", token: ca })
      return popup.unmute(await tickerOf(deps, ca))
    }),
  )
  // The tapped message is an alert or a card, so a missing user is answered without editing it.
  const flip = (kind: Kind) => async (ctx: Tap) => {
    const user = await findUser(deps.sql, ctx.from!.id)
    if (!user) return void (await ctx.answerCallbackQuery({ text: NO_USER, show_alert: true }))
    const ca = addressOf(ctx)
    const name = await tickerOf(deps, ca)
    let text: string
    if (kind === "watch") {
      if (await remove(deps, user, "watch", ca)) {
        await logAction(deps.sql, { chatType: "private", action: "unwatch", token: ca })
        text = popup.stop(name)
      } else {
        const r = await addWatch(deps, user, ca)
        if (r === "limit") return void (await ctx.answerCallbackQuery({ text: WATCH_LIMIT }))
        text = popup.watch(name)
      }
    } else if (await remove(deps, user, "mute", ca)) {
      await logAction(deps.sql, { chatType: "private", action: "unmute", token: ca })
      text = popup.unmute(name)
    } else {
      const wasWatching = await remove(deps, user, "watch", ca)
      await deps.sql`insert into bot.subscriptions (user_id, kind, target) values (${user.id}, 'mute', ${ca}) on conflict do nothing`
      await logAction(deps.sql, { chatType: "private", action: "mute", token: ca })
      text = wasWatching ? popup.muteUnwatched(name) : popup.mute(name)
    }
    await ctx.answerCallbackQuery({ text }).catch(() => {})
    await restyle(ctx, ca, await has(deps, user, "watch", ca), await has(deps, user, "mute", ca))
  }
  pm.callbackQuery(/^w:(0x[0-9a-f]{40})$/, flip("watch"))
  pm.callbackQuery(/^m:(0x[0-9a-f]{40})$/, flip("mute"))
}
