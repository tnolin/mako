import type { Bot, Context } from "grammy"
import { clean, escapeHtml } from "../format"
import { LAUNCHPADS } from "../launchpads"
import { btn, COMMUNITY_URL, type Kb, link, show } from "../platforms/telegram/ui"
import {
  ALERT_DESC,
  type AlertKind,
  basicPreset,
  NFT_ALL_ALERTS,
  NFT_WATCHED_ALERTS,
  TOKEN_ALERTS,
} from "../settings"
import type { BotDeps } from "./deps"
import { deleteUserData } from "./users"

/** The bot profile's About (short description) and description. Neither names a launchpad. */
export const SHORT_ABOUT =
  "The only bot for real-time alerts of memecoins and NFTs on Ink. Open source. Join the community: @MakoOnInk"
export const ABOUT = [
  "I send real-time alerts for memecoins and NFTs on Ink: new launches, bonding, mints, rare listings and whale buys.",
  "",
  "Customize your alerts for the NFTs and tokens you care about with support for groups and channels.",
  "",
  "Open-source project. Join the community: @MakoOnInk",
].join("\n")

const WATCH_COMMAND = {
  command: "watch",
  description: "Watch a token or NFT: /watch <address or name>",
}
/** The command menus. */
export const PRIVATE_COMMANDS = [
  { command: "start", description: "Start MAKO" },
  { command: "menu", description: "Main menu" },
  { command: "t", description: "Look up a token: /t <address>" },
  { command: "nft", description: "Look up an NFT collection: /nft <name or address>" },
  WATCH_COMMAND,
  { command: "alerts", description: "My alerts" },
  { command: "help", description: "Help" },
  { command: "deletedata", description: "Delete my data" },
]
export const GROUP_COMMANDS = [
  { command: "t", description: "Look up a token: /t <address>" },
  WATCH_COMMAND,
  { command: "setup", description: "Post MAKO alerts in this topic" },
  { command: "route", description: "Send chosen alerts to this topic" },
  { command: "help", description: "Help" },
]

/** The greeting uses the first name from the incoming update only: it is never stored or logged. */
export function menuText(firstName?: string): string {
  const name = clean(firstName, 32)
  return [
    `Hey ${name ? escapeHtml(name) : "there"}!`,
    "MAKO sends real-time alerts for tokens and NFTs on Ink, to your DMs, groups and channels.",
    "",
    "Tokens: new launches, bonding, pumps, dev sells and big trades.",
    "NFTs: upcoming mints, mint progress, sell-outs, under-floor and rare listings, and big sales.",
    "",
    "Paste any token or collection address, or an OpenSea link, to look it up.",
  ].join("\n")
}

export function menuKb(botUsername: string): Kb {
  return [
    [
      link(
        "Add to group or channel",
        `https://t.me/${botUsername}?startgroup=setup&admin=post_messages+manage_topics`,
      ),
    ],
    [btn("Tokens", "tk"), btn("NFTs", "nfts")],
    [btn("My alerts", "al:u"), btn("Settings", "st")],
    [btn("Help", "h"), link("Community", COMMUNITY_URL)],
  ]
}

/** The main menu, for the person who sent the update. */
export const showMenu = (ctx: Context) =>
  show(ctx, menuText(ctx.from?.first_name), menuKb(ctx.me.username))

// The main menu is a DM screen: its button does nothing in a group, so groups don't get it.
const menuRow = (dm: boolean) => (dm ? [btn("Menu", "m")] : [])

const tokensText = (linksBase: string): string =>
  [
    "<b>Tokens</b>",
    "Alerts and lists for tokens launched on Ink.",
    `Supported: ${Object.entries(LAUNCHPADS)
      .map(([key, l]) => `<a href="${linksBase}/${key}">${escapeHtml(l.name)}</a>`)
      .join(", ")}`,
    "",
    "/t &lt;address&gt; look up a token",
    "/watch &lt;address&gt; watch a token",
  ].join("\n")

const nftsText = (linksBase: string): string =>
  [
    "<b>NFTs</b>",
    "Alerts and lists for NFT collections on Ink.",
    `Supported: <a href="${linksBase}/p/opensea">OpenSea</a>, <a href="${linksBase}/p/chimera">Chimera</a>`,
    "",
    "/nft &lt;collection&gt; [1h|24h|7d|30d]",
    "/nft &lt;collection&gt; &lt;id&gt; look up one NFT",
  ].join("\n")

const b = (s: string) => `<b>${escapeHtml(s)}</b>`
// The Help lines are the alert-screen lines at the default thresholds.
const defaults = basicPreset("private")
const lines = (kinds: readonly AlertKind[]) => kinds.map((k) => escapeHtml(ALERT_DESC(k, defaults)))

export const HELP = {
  index:
    "<b>Help</b>\nMAKO posts alerts for Ink tokens and NFTs in your DM, your groups and your channels.",
  alerts: [
    b("Alerts explained"),
    b("Token alerts"),
    ...lines(TOKEN_ALERTS),
    "Percentages in token alerts are a share of the token's total supply.",
    b("NFT alerts"),
    ...lines(NFT_ALL_ALERTS),
    b("Watched NFTs only"),
    ...lines(NFT_WATCHED_ALERTS),
  ].join("\n"),
  watched: [
    b("Watched & Muted"),
    `${b("Watching")}: I'll send you every alert type for tokens or NFTs that you add to your watchlist, even for the alerts turned off. This also includes mint reminders 15 minutes before each mint stage.`,
    "",
    `${b("Muted")}: I won't send you any alerts on tokens or NFTs that you mute. If it is on your watchlist, it is removed automatically.`,
    "",
    `${b("Remind me")}: These alerts are only for an NFT's upcoming mint stages. Select 'Remind me' if you want to get notifications 15 min before each mint stage without adding the collection to your Watchlist.`,
  ].join("\n"),
  group: [
    b("Group setup"),
    "1. Tap Add to group or channel in the menu, and make MAKO an admin so it can post in topics.",
    "2. In the topic where alerts should go, send /setup. Every alert posts there by default.",
    "3. Want different alerts in different topics? Send /route in another topic and pick which alerts go there.",
    "4. Tap Open settings to choose alerts, thresholds and images. NFT alerts are off in groups until an admin turns them on.",
    "",
    b("Tips"),
    "• Give each alert type its own topic, like New tokens, Bonding and Mints, so chat doesn't bury them.",
    "• Close alert topics so only MAKO can post there.",
    "• In busy groups, turn images off to keep alerts compact.",
    "• Use /watch for the tokens and collections your community cares about, so market alerts stay focused.",
  ].join("\n"),
  privacy: [
    b("Privacy"),
    `MAKO is an open-source project built to store as little data as possible. It does ${b("not")} store personal information like your name, username, phone number or messages. MAKO only stores your Telegram user ID, to remember your notification settings, the tokens and NFTs you watch or mute, your mint reminders, and the alerts queued for you (kept for 90 days).`,
    "",
    "You can delete your data in Settings → Delete my data. Server backups are deleted after 14 days.",
  ].join("\n"),
}

const helpKb = (dm: boolean): Kb => [
  [btn("Alerts explained", "h:alerts"), btn("Group setup", "h:group")],
  [btn("Watched & Muted", "h:watched"), btn("Privacy", "h:privacy")],
  [link("Community", COMMUNITY_URL), ...menuRow(dm)],
]
const back = (dm: boolean): Kb => [[btn("Help", "h"), ...menuRow(dm)]]
const isDm = (ctx: Context) => ctx.chat?.type === "private"

const DELETE_CONFIRM =
  "<b>Delete my data</b>\nThis removes your settings, watchlist, mutes and the alerts queued for you. Server backups are deleted after 14 days. This can't be undone."

export function registerMain(bot: Bot, deps: BotDeps): void {
  const pm = bot.chatType("private")
  pm.command("menu", showMenu)
  pm.callbackQuery("m", showMenu)
  // The list screens' Back buttons lead here, in a group too, so Menu is left out there.
  bot.callbackQuery("tk", (ctx) =>
    show(ctx, tokensText(deps.linksBase), [
      [btn("Hot now", "l:hot"), btn("Near bonding", "l:near")],
      [btn("Recently bonded", "l:bonded"), ...menuRow(isDm(ctx))],
    ]),
  )
  bot.callbackQuery("nfts", (ctx) =>
    show(ctx, nftsText(deps.linksBase), [
      [btn("Minting now", "nl:m"), btn("Upcoming", "nl:u")],
      [btn("Trending", "nl:t24"), ...menuRow(isDm(ctx))],
    ]),
  )
  bot.command("help", (ctx) => show(ctx, HELP.index, helpKb(isDm(ctx))))
  bot.callbackQuery("h", (ctx) => show(ctx, HELP.index, helpKb(isDm(ctx))))
  bot.callbackQuery(/^h:(alerts|group|watched|privacy)$/, (ctx) =>
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
