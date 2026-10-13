import type { Bot } from "grammy"
import { logAction } from "../actions"
import { show } from "../platforms/telegram/ui"
import { ALERT_PATTERN, type AlertKind, allOff } from "../settings"
import { openChatSettings } from "./alerts"
import type { BotDeps } from "./deps"
import { MENU_TEXT, menuKb } from "./main"
import { sendTokenCard } from "./token"
import { ensureUser, findUser, NO_USER, saveUserSettings } from "./users"
import { watchToken } from "./watchlist"
import { sendWelcome, welcomeKb, welcomeText } from "./welcome"

/** Analytics source for /start: a kind letter for our own links, a plain campaign tag, never free text or ids. */
export function startSource(payload: string): string {
  if (!payload) return "none"
  const kind = /^([wts])_/.exec(payload)?.[1]
  if (kind) return kind
  // A bare address or chat id is an identifier, not a campaign tag.
  if (/^0x[0-9a-fA-F]{40}$/.test(payload) || /^-?\d+$/.test(payload)) return "other"
  return /^[A-Za-z0-9_-]{1,64}$/.test(payload) ? payload : "other"
}

export function registerStart(bot: Bot, deps: BotDeps): void {
  const pm = bot.chatType("private")
  pm.command("start", async (ctx) => {
    const payload = ctx.match.trim()
    const { user, created } = await ensureUser(deps.sql, ctx.from.id)
    await logAction(deps.sql, {
      chatType: "private",
      action: "start",
      params: { source: startSource(payload) },
    })
    if (payload.startsWith("w_")) await watchToken(ctx, deps, payload.slice(2))
    else if (payload.startsWith("t_")) await sendTokenCard(ctx, deps, payload.slice(2))
    else if (payload.startsWith("s_")) await openChatSettings(ctx, deps, payload.slice(2))
    if (created) {
      await sendWelcome(ctx, user.settings)
    } else if (!/^[wts]_/.test(payload)) {
      await show(ctx, MENU_TEXT, menuKb())
    }
  })
  pm.callbackQuery(new RegExp(`^ob:(${ALERT_PATTERN})$`), async (ctx) => {
    const user = await findUser(deps.sql, ctx.from.id)
    if (!user) return show(ctx, NO_USER)
    const a = ctx.match[1] as AlertKind
    user.settings.alerts[a].on = !user.settings.alerts[a].on
    await saveUserSettings(deps.sql, user.id, user.settings)
    await show(ctx, welcomeText(), welcomeKb(user.settings))
  })
  pm.callbackQuery("ob:off", async (ctx) => {
    const user = await findUser(deps.sql, ctx.from.id)
    if (!user) return show(ctx, NO_USER)
    const s = allOff(user.settings)
    await saveUserSettings(deps.sql, user.id, s)
    await logAction(deps.sql, {
      chatType: "private",
      action: "preset",
      params: { choice: "all_off" },
    })
    await show(ctx, welcomeText(), welcomeKb(s))
  })
  pm.callbackQuery("ob:done", async (ctx) => {
    await logAction(deps.sql, { chatType: "private", action: "preset", params: { choice: "done" } })
    await show(ctx, MENU_TEXT, menuKb())
  })
}
