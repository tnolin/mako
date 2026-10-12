import type { Bot } from "grammy"
import { logAction } from "../actions"
import { btn, type Kb, show } from "../platforms/telegram/ui"
import { ALERT_HELP, ALERT_LABEL, ALERTS, type AlertKind, allOff, type Settings } from "../settings"
import { openChatSettings } from "./alerts"
import type { BotDeps } from "./deps"
import { MENU_TEXT, menuKb } from "./main"
import { sendTokenCard } from "./token"
import { ensureUser, saveUserSettings } from "./users"
import { watchToken } from "./watchlist"

export function welcomeText(): string {
  const w = Math.max(...ALERTS.map((a) => ALERT_LABEL[a].length)) + 2
  return [
    "<b>MAKO</b> · real-time alerts for Ink memecoins",
    "",
    "Your alerts:",
    ...ALERTS.map((a) => `<code>${ALERT_LABEL[a].padEnd(w)}${ALERT_HELP[a]}</code>`),
    "",
    "Tap an alert to turn it on or off. Thresholds and images are in My alerts.",
  ].join("\n")
}

export function welcomeKb(s: Settings): Kb {
  const toggles = ALERTS.map((a) =>
    btn(`${s.alerts[a].on ? "✓" : "·"} ${ALERT_LABEL[a]}`, `ob:${a}`),
  )
  const rows: Kb = []
  for (let i = 0; i < toggles.length; i += 2) rows.push(toggles.slice(i, i + 2))
  rows.push([btn("Turn all off", "ob:off"), btn("Done → menu", "ob:done")])
  return rows
}

export function registerStart(bot: Bot, deps: BotDeps): void {
  const pm = bot.chatType("private")
  pm.command("start", async (ctx) => {
    const payload = ctx.match.trim()
    const { user, created } = await ensureUser(deps.sql, ctx.from.id)
    await logAction(deps.sql, {
      chatType: "private",
      action: "start",
      params: { source: payload || "none" },
    })
    if (payload.startsWith("w_")) await watchToken(ctx, deps, payload.slice(2))
    else if (payload.startsWith("t_")) await sendTokenCard(ctx, deps, payload.slice(2))
    else if (payload.startsWith("s_")) await openChatSettings(ctx, deps, payload.slice(2))
    if (created) {
      await ctx.reply(welcomeText(), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: welcomeKb(user.settings) },
      })
    } else if (!/^[wts]_/.test(payload)) {
      await show(ctx, MENU_TEXT, menuKb())
    }
  })
  pm.callbackQuery(/^ob:(new|bonding|pumping|bonded|devsell|big)$/, async (ctx) => {
    const { user } = await ensureUser(deps.sql, ctx.from.id)
    const a = ctx.match[1] as AlertKind
    user.settings.alerts[a].on = !user.settings.alerts[a].on
    await saveUserSettings(deps.sql, user.id, user.settings)
    await show(ctx, welcomeText(), welcomeKb(user.settings))
  })
  pm.callbackQuery("ob:off", async (ctx) => {
    const { user } = await ensureUser(deps.sql, ctx.from.id)
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
