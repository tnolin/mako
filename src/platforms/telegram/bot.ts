import { Bot } from "grammy"
import type { UserFromGetMe } from "grammy/types"
import { registerAlerts } from "../../menus/alerts"
import { registerChats } from "../../menus/chats"
import type { BotDeps } from "../../menus/deps"
import { registerLists } from "../../menus/lists"
import { registerMain } from "../../menus/main"
import { registerStart } from "../../menus/start"
import { registerToken } from "../../menus/token"
import { registerWatchlist } from "../../menus/watchlist"

export const KNOWN_COMMANDS = [
  "start",
  "menu",
  "t",
  "watch",
  "alerts",
  "setup",
  "route",
  "help",
  "deletedata",
]

/** The grammY bot with every screen. Long polling; the caller starts it. */
export function createBot(deps: BotDeps & { token: string; botInfo?: UserFromGetMe }): Bot {
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : undefined)
  bot.use(async (ctx, next) => {
    const cmd = ctx.msg?.text?.match(/^\/([a-z]+)/i)?.[1]?.toLowerCase()
    if (cmd && KNOWN_COMMANDS.includes(cmd)) {
      await deps.sql`
        insert into bot.commands_daily (day, command, count) values (current_date, ${cmd}, 1)
        on conflict (day, command) do update set count = bot.commands_daily.count + 1`.catch(
        () => {},
      )
    }
    await next()
  })
  registerStart(bot, deps)
  registerMain(bot, deps)
  registerLists(bot, deps)
  registerWatchlist(bot, deps)
  registerAlerts(bot, deps)
  registerChats(bot, deps)
  // Last: it catches plain text (pasted addresses and ForceReply answers).
  registerToken(bot, deps)
  bot.catch((e) => {
    deps.log("error", "bot handler failed", { error: String(e.error) })
    deps.report(e.error)
  })
  return bot
}
