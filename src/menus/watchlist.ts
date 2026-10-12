import type { Bot, Context } from "grammy"
import { logAction } from "../actions"
import { clean, escapeHtml } from "../format"
import { launchesOf, launchOf } from "../history"
import { unknownTokenText } from "../launchpads"
import { classify } from "../platforms/telegram/errors"
import { btn, findAddress, type Kb, show } from "../platforms/telegram/ui"
import type { BotDeps } from "./deps"
import { ensureUser, findUser, NO_USER, type User } from "./users"

export const WATCH_PROMPT = "Send a token address to watch."
export const WATCH_CAP = 50

/** Watches a token from /watch, a prompt answer or a w_ deep link. Replies with the result. */
export async function watchToken(ctx: Context, deps: BotDeps, raw: string): Promise<void> {
  const ca = findAddress(raw)
  if (!ca || !ctx.from) {
    await ctx.reply("Send /watch followed by a token address.")
    return
  }
  const l = await launchOf(deps.sql, ca)
  if (!l) {
    await ctx.reply(unknownTokenText())
    return
  }
  // A typed command or message is a fresh user action, so it may create the user.
  const { user } = await ensureUser(deps.sql, ctx.from.id)
  const [n] = await deps.sql<{ n: number }[]>`
    select count(*)::int as n from bot.subscriptions where user_id = ${user.id} and kind = 'watch'`
  if ((n?.n ?? 0) >= WATCH_CAP) {
    await ctx.reply(
      `Your watchlist is full (${WATCH_CAP} tokens). Remove one in My watchlist first.`,
    )
    return
  }
  await deps.sql`
    insert into bot.subscriptions (user_id, kind, target) values (${user.id}, 'watch', ${ca}) on conflict do nothing`
  await logAction(deps.sql, { chatType: "private", action: "watch", token: ca })
  await ctx.reply(
    `Watching $${escapeHtml(clean(l.p.ticker, 32))}. Its alerts come here, even for feeds you turned off.`,
    { parse_mode: "HTML" },
  )
}

/** Adds or removes a subscription. Returns true when it is now on. */
async function toggle(
  deps: BotDeps,
  user: User,
  kind: "watch" | "mute",
  ca: string,
): Promise<boolean> {
  const removed = await deps.sql`
    delete from bot.subscriptions where user_id = ${user.id} and kind = ${kind} and target = ${ca} returning 1`
  if (removed.length === 0) {
    await deps.sql`insert into bot.subscriptions (user_id, kind, target) values (${user.id}, ${kind}, ${ca}) on conflict do nothing`
  }
  const on = removed.length === 0
  await logAction(deps.sql, { chatType: "private", action: on ? kind : `un${kind}`, token: ca })
  return on
}

async function relabel(ctx: Context, data: string, text: string): Promise<void> {
  const kb = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard
  if (!kb) return
  const next = kb.map((row) =>
    row.map((b) => ("callback_data" in b && b.callback_data === data ? { ...b, text } : b)),
  )
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: next } }).catch((err) => {
    if (classify(err).kind !== "not_modified") throw err
  })
}

async function listScreen(
  ctx: Context,
  deps: BotDeps,
  user: User,
  kind: "watch" | "mute",
): Promise<void> {
  const rows = await deps.sql<{ target: string }[]>`
    select target from bot.subscriptions where user_id = ${user.id} and kind = ${kind} order by created_at`
  const meta = await launchesOf(
    deps.sql,
    rows.map((r) => r.target),
  )
  const label = (t: string) => `$${clean(meta.get(t)?.ticker, 32) || "?"}`
  const kb: Kb = rows.map((r) =>
    kind === "watch"
      ? [btn(`Remove ${label(r.target)}`, `wl:rm:${r.target}`)]
      : [btn(`Unmute ${label(r.target)}`, `um:${r.target}`)],
  )
  if (kind === "watch") kb.push([btn("Add token", "wl:add")])
  kb.push([btn(kind === "watch" ? "Menu" : "My alerts", kind === "watch" ? "m" : "al:u")])
  const title = kind === "watch" ? "<b>My watchlist</b>" : "<b>Muted tokens</b>"
  const empty =
    kind === "watch" ? "No tokens yet. Tap Watch on any alert, or Add token." : "No muted tokens."
  await show(
    ctx,
    rows.length
      ? `${title}\n${rows.map((r) => escapeHtml(label(r.target))).join("\n")}`
      : `${title}\n${empty}`,
    kb,
  )
}

type Tap = Context & { match: string | RegExpMatchArray }
const addressOf = (ctx: Tap) => (ctx.match as RegExpMatchArray)[1]!

export function registerWatchlist(bot: Bot, deps: BotDeps): void {
  const pm = bot.chatType("private")
  pm.command("watch", (ctx) => watchToken(ctx, deps, ctx.match))
  // Taps on buttons never create a user: after Delete my data an old button must not bring the row back.
  const screen =
    (kind: "watch" | "mute", change?: (user: User, ca: string) => Promise<unknown>) =>
    async (ctx: Tap) => {
      const user = await findUser(deps.sql, ctx.from!.id)
      if (!user) return show(ctx, NO_USER)
      if (change) await change(user, addressOf(ctx))
      await listScreen(ctx, deps, user, kind)
    }
  pm.callbackQuery("wl", screen("watch"))
  pm.callbackQuery("mu", screen("mute"))
  pm.callbackQuery("wl:add", async (ctx) => {
    await ctx.answerCallbackQuery()
    await ctx.reply(WATCH_PROMPT, {
      reply_markup: { force_reply: true, input_field_placeholder: "0x…" },
    })
  })
  pm.callbackQuery(
    /^wl:rm:(0x[0-9a-f]{40})$/,
    screen("watch", (user, ca) => toggle(deps, user, "watch", ca)),
  )
  pm.callbackQuery(
    /^um:(0x[0-9a-f]{40})$/,
    screen("mute", (user, ca) => toggle(deps, user, "mute", ca)),
  )
  // The tapped message is an alert or a card, so a missing user is answered without editing it.
  const flip = (kind: "watch" | "mute") => async (ctx: Tap) => {
    const user = await findUser(deps.sql, ctx.from!.id)
    if (!user) return void (await ctx.answerCallbackQuery({ text: NO_USER, show_alert: true }))
    const on = await toggle(deps, user, kind, addressOf(ctx))
    const labels = kind === "watch" ? ["Watching", "Watch"] : ["Unmute", "Mute"]
    await relabel(ctx, ctx.callbackQuery!.data!, on ? labels[0]! : labels[1]!)
    const texts =
      kind === "watch"
        ? ["Added to your watchlist", "Removed from your watchlist"]
        : ["Muted", "Unmuted"]
    await ctx.answerCallbackQuery({ text: on ? texts[0]! : texts[1]! })
  }
  pm.callbackQuery(/^w:(0x[0-9a-f]{40})$/, flip("watch"))
  pm.callbackQuery(/^m:(0x[0-9a-f]{40})$/, flip("mute"))
}
