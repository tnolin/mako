import type { Bot, Context } from "grammy"
import { LAUNCHPADS } from "../launchpads"
import { btn, COMMUNITY_URL, type Kb, link, show } from "../platforms/telegram/ui"
import { ALERT_HELP, ALERT_LABEL, TOKEN_ALERTS } from "../settings"
import type { BotDeps } from "./deps"
import { deleteUserData } from "./users"

export const MENU_TEXT = "<b>MAKO</b> · real-time alerts for Ink memecoins"

export function menuKb(linksBase: string): Kb {
  return [
    [btn("Look up token", "look"), btn("Hot now", "l:hot")],
    [btn("Near bonding", "l:near"), btn("Recently bonded", "l:bonded")],
    [btn("My watchlist", "wl"), btn("My alerts", "al:u")],
    [btn("Settings", "st"), btn("Help", "h")],
    [link(`Trade on ${LAUNCHPADS.inkypump.name}`, `${linksBase}/inkypump`)],
  ]
}

export const HELP = {
  index:
    "<b>Help</b>\nMAKO posts alerts for Ink memecoins in your DM, your groups and your channels.\nPercentages in alerts are shares of total supply.",
  alerts: [
    "<b>Alerts</b>",
    ...TOKEN_ALERTS.map((a) => `<b>${ALERT_LABEL[a]}</b>: ${ALERT_HELP[a]}`),
    "",
    "Tokens you watch send every alert except NEW TOKEN to your DM, even for feeds you turned off.",
  ].join("\n"),
  group: [
    "<b>Group setup</b>",
    "1. Add MAKO to the group (Settings → Groups & channels → Add to a group).",
    "2. Run /setup in the topic where alerts should go.",
    "3. Optional: run /route in other topics to send chosen alerts there.",
    "4. Tap Open settings to pick feeds, thresholds and images in your DM with MAKO.",
  ].join("\n"),
  watch: [
    "<b>Watchlist</b>",
    "Tap Watch on an alert or token card, or send /watch followed by an address.",
    "Watched tokens send you every alert except NEW TOKEN. Mute stops all alerts for a token.",
  ].join("\n"),
  privacy: [
    "<b>Privacy</b>",
    "MAKO stores your Telegram user id, your alert settings, your watchlist and mutes, and the alerts queued for you (kept 90 days).",
    "It does not store your name, username or messages.",
    "Settings → Delete my data removes all of it. Server backups are deleted after 14 days.",
  ].join("\n"),
}

// The main menu is a DM screen: its button does nothing in a group, so groups don't get it.
const helpKb = (dm: boolean): Kb => [
  [btn("Alerts explained", "h:alerts"), btn("Group setup", "h:group")],
  [btn("Watchlist", "h:watch"), btn("Privacy", "h:privacy")],
  [link("Community", COMMUNITY_URL), ...(dm ? [btn("Menu", "m")] : [])],
]
const back = (dm: boolean): Kb => [[btn("Help", "h"), ...(dm ? [btn("Menu", "m")] : [])]]
const isDm = (ctx: Context) => ctx.chat?.type === "private"

const DELETE_CONFIRM =
  "<b>Delete my data</b>\nThis removes your settings, watchlist, mutes and the alerts queued for you. Server backups are deleted after 14 days. This can't be undone."

export function registerMain(bot: Bot, deps: BotDeps): void {
  const pm = bot.chatType("private")
  pm.command("menu", (ctx) => show(ctx, MENU_TEXT, menuKb(deps.linksBase)))
  pm.callbackQuery("m", (ctx) => show(ctx, MENU_TEXT, menuKb(deps.linksBase)))
  bot.command("help", (ctx) => show(ctx, HELP.index, helpKb(isDm(ctx))))
  bot.callbackQuery("h", (ctx) => show(ctx, HELP.index, helpKb(isDm(ctx))))
  bot.callbackQuery(/^h:(alerts|group|watch|privacy)$/, (ctx) =>
    show(ctx, HELP[ctx.match[1] as keyof typeof HELP], back(isDm(ctx))),
  )
  pm.callbackQuery("st", (ctx) =>
    show(ctx, "<b>Settings</b>", [
      [btn("Groups & channels", "gc"), btn("Delete my data", "dd")],
      [btn("Menu", "m")],
    ]),
  )
  const confirm = (): Kb => [[btn("Yes, delete", "dd:yes"), btn("Cancel", "st")]]
  pm.command("deletedata", (ctx) => show(ctx, DELETE_CONFIRM, confirm()))
  pm.callbackQuery("dd", (ctx) => show(ctx, DELETE_CONFIRM, confirm()))
  pm.callbackQuery("dd:yes", async (ctx) => {
    await deleteUserData(deps.sql, ctx.from.id)
    await show(ctx, "Your data is deleted. Send /start to use MAKO again.")
  })
}
