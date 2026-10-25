import type { Bot, Context } from "grammy"
import type postgres from "postgres"
import { logAction } from "../actions"
import type { ChatType } from "../delivery/recipients"
import { clean, escapeHtml } from "../format"
import {
  BIGSALE_STEPS,
  ethTrim,
  FLOOR_STEPS,
  NFT_MARKS,
  RARE_STEPS,
  SALE_STEPS,
  SWEEP_STEPS,
  UNDER_STEPS,
} from "../nft/policy"
import { btn, chosenBtn, isAdmin, type Kb, show, toggleBtn } from "../platforms/telegram/ui"
import {
  ALERT_DESC,
  ALERT_LABEL,
  ALERTS,
  type AlertKind,
  BIG_STEPS,
  MARKS,
  NFT_ALL_ALERTS,
  NFT_WATCHED_ALERTS,
  readSettings,
  resetScreen,
  SETTINGS_LABEL,
  type Settings,
  TOKEN_ALERTS,
  topicLabel,
} from "../settings"
import type { BotDeps } from "./deps"
import { ensureUser, findUser, NO_USER, saveUserSettings } from "./users"
import { sendWelcome } from "./welcome"

export const NOT_ADMIN = "Only admins of that chat can change its settings."

type Scope =
  | {
      kind: "user"
      id: "u"
      userId: string
      settings: Settings
      save(s: Settings): Promise<void>
      /** True when this typed command just created the user. */
      created: boolean
    }
  | {
      kind: "chat"
      id: string
      chatType: Exclude<ChatType, "private">
      settings: Settings
      save(s: Settings): Promise<void>
      active: boolean
      paused: string | null
    }

/**
 * Loads the settings being edited. Chats need a live admin check every time.
 * Only a typed command (`fresh`) may create the user; a button tap never does.
 */
async function scopeFor(
  ctx: Context,
  deps: BotDeps,
  id: string,
  fresh = false,
): Promise<Scope | null> {
  if (id === "u") {
    const found = fresh
      ? await ensureUser(deps.sql, ctx.from!.id)
      : { user: await findUser(deps.sql, ctx.from!.id), created: false }
    const user = found.user
    if (!user) {
      await show(ctx, NO_USER)
      return null
    }
    return {
      kind: "user",
      id: "u",
      userId: user.id,
      settings: user.settings,
      save: (s) => saveUserSettings(deps.sql, user.id, s),
      created: found.created,
    }
  }
  if (!(await isAdmin(ctx.api, id, ctx.from!.id))) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: NOT_ADMIN, show_alert: true })
    else await ctx.reply(NOT_ADMIN)
    return null
  }
  const [c] = await deps.sql<
    {
      kind: Exclude<ChatType, "private">
      settings: unknown
      active: boolean
      paused_reason: string | null
    }[]
  >`select kind, settings, active, paused_reason from bot.chats where chat_id = ${id} and removed_at is null`
  if (!c) {
    await show(ctx, "MAKO isn't in that chat any more.")
    return null
  }
  return {
    kind: "chat",
    id,
    chatType: c.kind,
    settings: readSettings(c.settings, c.kind),
    active: c.active,
    paused: c.paused_reason,
    // shortcut: saves the whole settings JSON (read-modify-write), so a concurrent sender write to
    // pausedRoutes can be overwritten; upgrade to a targeted jsonb_set update if that bites.
    save: async (s) => {
      await deps.sql`update bot.chats set settings = ${deps.sql.json(s as unknown as postgres.JSONValue)} where chat_id = ${id}`
    },
  }
}

/** The chat's title from the Bot API at render time. It is never stored. */
export const chatTitle = (ctx: Context, chatId: string | number): Promise<string> =>
  ctx.api
    .getChat(Number(chatId))
    .then((c) => clean("title" in c ? c.title : undefined, 64) || "this chat")
    .catch(() => "this chat")

/** The chat's type for the action log; a chat MAKO has no row for logs as a supergroup. */
export async function chatKind(sql: BotDeps["sql"], chatId: string): Promise<ChatType> {
  const [c] = await sql<{ kind: ChatType }[]>`select kind from bot.chats where chat_id = ${chatId}`
  return c?.kind ?? "supergroup"
}

const pct = (bps: number) => `${bps / 100}%`

type Screen = "tk" | "na" | "nw"
const KINDS: Record<Screen, readonly AlertKind[]> = {
  tk: TOKEN_ALERTS,
  na: NFT_ALL_ALERTS,
  nw: NFT_WATCHED_ALERTS,
}
const SCREEN_OF = (k: AlertKind): Screen =>
  (TOKEN_ALERTS as readonly string[]).includes(k)
    ? "tk"
    : (NFT_ALL_ALERTS as readonly string[]).includes(k)
      ? "na"
      : "nw"
const SCREEN_PATTERN = "tk|na|nw"
const RESET_SCREEN = { tk: "token", na: "nft_all", nw: "nft_watched" } as const

type Value = number | string
/** A threshold: its choices, its label on the screen and how it is read and written. */
type Picker = {
  values: readonly Value[]
  /** A button in the picker. */
  label(v: Value): string
  /** The button on the alert screen. */
  button(s: Settings): string
  multi?: boolean
  get(s: Settings): Value[]
  set(s: Settings, v: Value[]): void
}
const eth = (w: Value) => `${ethTrim(String(w))} ETH`
const marks = (v: Value[]) => v.map((m) => pct(Number(m))).join(", ") || "none"
const PICKERS: Record<string, Picker> = {
  bonding: {
    values: MARKS,
    label: (v) => pct(Number(v)),
    button: (s) => `BONDING at: ${marks(s.alerts.bonding.marks)}`,
    multi: true,
    get: (s) => s.alerts.bonding.marks,
    set: (s, v) => {
      s.alerts.bonding.marks = MARKS.filter((m) => v.includes(m))
    },
  },
  big: {
    values: BIG_STEPS,
    label: (v) => pct(Number(v)),
    button: (s) => `BIG BUY/SELL at: ${pct(s.alerts.big.pctBps)}`,
    get: (s) => [s.alerts.big.pctBps],
    set: (s, [v]) => {
      s.alerts.big.pctBps = v as (typeof BIG_STEPS)[number]
    },
  },
  minted: {
    values: NFT_MARKS,
    label: (v) => pct(Number(v)),
    button: (s) => `MINTED ${marks(s.alerts.minted.marks)}`,
    multi: true,
    get: (s) => s.alerts.minted.marks,
    set: (s, v) => {
      s.alerts.minted.marks = NFT_MARKS.filter((m) => v.includes(m))
    },
  },
  bigsale: {
    values: BIGSALE_STEPS,
    label: eth,
    button: (s) => `BIG SALE: ${eth(s.alerts.bigsale.minWei)}`,
    get: (s) => [s.alerts.bigsale.minWei],
    set: (s, [v]) => {
      s.alerts.bigsale.minWei = String(v)
    },
  },
  under: {
    values: UNDER_STEPS,
    label: (v) => pct(Number(v)),
    button: (s) => `UNDER FLOOR: ${pct(s.alerts.under.pctBps)}`,
    get: (s) => [s.alerts.under.pctBps],
    set: (s, [v]) => {
      s.alerts.under.pctBps = v as (typeof UNDER_STEPS)[number]
    },
  },
  rare: {
    values: RARE_STEPS,
    label: (v) => `top ${pct(Number(v))}`,
    button: (s) => `RARE: top ${pct(s.alerts.rare.topBps)}`,
    get: (s) => [s.alerts.rare.topBps],
    set: (s, [v]) => {
      s.alerts.rare.topBps = v as (typeof RARE_STEPS)[number]
    },
  },
  floor: {
    values: FLOOR_STEPS,
    label: (v) => pct(Number(v)),
    button: (s) => `FLOOR MOVE: ${pct(s.alerts.floor.pctBps)}`,
    get: (s) => [s.alerts.floor.pctBps],
    set: (s, [v]) => {
      s.alerts.floor.pctBps = v as (typeof FLOOR_STEPS)[number]
    },
  },
  sweep: {
    values: SWEEP_STEPS,
    label: (v) => `${v} items`,
    button: (s) => `SWEEP: ${s.alerts.sweep.items} items`,
    get: (s) => [s.alerts.sweep.items],
    set: (s, [v]) => {
      s.alerts.sweep.items = v as (typeof SWEEP_STEPS)[number]
    },
  },
  sale: {
    values: SALE_STEPS,
    label: (v) => (v === "0" ? "any" : eth(v)),
    button: (s) => `SOLD at: ${s.alerts.sale.minWei === "0" ? "any" : eth(s.alerts.sale.minWei)}`,
    get: (s) => [s.alerts.sale.minWei],
    set: (s, [v]) => {
      s.alerts.sale.minWei = String(v)
    },
  },
}
const PICKER_PATTERN = Object.keys(PICKERS).join("|")
/** One line on each picker screen. */
const PICKER_TEXT: Record<string, string> = {
  bonding: "<b>BONDING marks</b>\nAlert when a curve passes:",
  big: "BIG BUY/SELL - Sends when a single trade is worth the designated % of the token's bond target.",
  minted: "MINTED - Sends when a collection's mint progress crosses the following %:",
  bigsale: "BIG SALE - Sends when an NFT sells for at least:",
  under: "UNDER FLOOR - Sends when an NFT is listed at least this % under the current floor price:",
  rare: "RARE LISTING - Sends when an NFT is listed near floor price with a rarity in the designated % range:",
  floor: "FLOOR MOVE - Sends when the floor price moves this much in 24h:",
  sweep: "SWEEP - Sends when one wallet buys this many NFTs within 10 mins:",
  sale: "SOLD - Sends when an item on your watchlist sells for at least this amount:",
}
const pickerText = (kind: string): string =>
  kind === "bonding" ? PICKER_TEXT.bonding! : escapeHtml(PICKER_TEXT[kind]!)

const toggleRow = (s: Settings, id: string, a: AlertKind): ReturnType<typeof btn>[] => {
  const row = [
    toggleBtn(
      a === "reminder" ? SETTINGS_LABEL[a] : ALERT_LABEL[a],
      s.alerts[a].on,
      `al:${id}:${a}:on`,
    ),
  ]
  if (a !== "reminder")
    row.push(
      toggleBtn(
        "Show Image",
        s.alerts[a as Exclude<AlertKind, "reminder">].image,
        `al:${id}:${a}:img`,
      ),
    )
  return row
}

const backTo = (sc: Scope) => (sc.kind === "user" ? "al:u" : `al:${sc.id}`)

async function screenText(ctx: Context, sc: Scope, screen: Screen): Promise<string> {
  const s = sc.settings
  const desc = (kinds: readonly AlertKind[]) => kinds.map((k) => ALERT_DESC(k, s))
  const name = sc.kind === "chat" ? escapeHtml(await chatTitle(ctx, sc.id)) : ""
  if (screen === "tk") {
    return [
      sc.kind === "user" ? "<b>Token alerts</b>" : `<b>Token alerts for ${name}</b>`,
      "Customize what kind of alerts you receive for tokens.",
      "",
      "<b>Alert Types</b>",
      ...desc(TOKEN_ALERTS),
    ].join("\n")
  }
  const head = (which: string) =>
    sc.kind === "user" ? [`<b>NFT alerts · ${which}</b>`] : [`<b>NFT alerts for ${name}</b>`, which]
  if (screen === "na") {
    return [
      ...head("All collections"),
      "When turned on: Every collection that passes MAKO's quality checks.",
      "When turned off: Only receive alerts on NFTs you watch.",
      "",
      "<b>Alert Types</b>",
      ...desc(NFT_ALL_ALERTS),
    ].join("\n")
  }
  return [
    ...head("Watched Alerts"),
    "These alerts are only for NFTs you added to your watchlist.",
    "",
    ...desc(NFT_WATCHED_ALERTS),
  ].join("\n")
}

async function renderScreen(ctx: Context, sc: Scope, screen: Screen): Promise<void> {
  const s = sc.settings
  const id = sc.id
  const kb: Kb = KINDS[screen].map((a) => toggleRow(s, id, a))
  const open = (k: string) => btn(PICKERS[k]!.button(s), `al:${id}:p:${k}`)
  if (screen === "tk") {
    kb.push([open("bonding")], [open("big")])
  } else if (screen === "na") {
    kb.push([open("minted"), open("bigsale")])
  } else {
    kb.push([open("under"), open("rare")], [open("floor"), open("sweep")], [open("sale")])
  }
  const reset = btn("Reset to default", `al:${id}:reset:${screen}`)
  if (screen === "tk") kb.push([reset], [btn("Back", backTo(sc))])
  else if (screen === "na")
    kb.push([btn("Watched Alerts", `al:${id}:nw`)], [reset, btn("Back", backTo(sc))])
  else kb.push([reset], [btn("All collections", `al:${id}:na`), btn("Back", backTo(sc))])
  await show(ctx, await screenText(ctx, sc, screen), kb)
}

async function renderPicker(ctx: Context, sc: Scope, kind: string): Promise<void> {
  const p = PICKERS[kind]!
  const now = p.get(sc.settings)
  const buttons = p.values.map((v, i) =>
    chosenBtn(p.label(v), now.includes(v), `al:${sc.id}:p:${kind}:${i}`),
  )
  const kb: Kb = []
  for (let i = 0; i < buttons.length; i += 3) kb.push(buttons.slice(i, i + 3))
  kb.push([btn("Back", `al:${sc.id}:${SCREEN_OF(kind as AlertKind)}`)])
  await show(ctx, pickerText(kind), kb)
}
/** My alerts for a user, or the group's settings screen in the DM for a chat. */
async function renderHub(ctx: Context, deps: BotDeps, sc: Scope): Promise<void> {
  if (sc.kind === "user") {
    const [n] = await deps.sql<{ wt: number; wn: number; mt: number; mn: number }[]>`
      select
        (select count(*)::int from bot.subscriptions where user_id = ${sc.userId} and kind = 'watch') as wt,
        (select count(*)::int from bot.nft_watches where user_id = ${sc.userId}) as wn,
        (select count(*)::int from bot.subscriptions where user_id = ${sc.userId} and kind = 'mute') as mt,
        (select count(*)::int from bot.collection_mutes where user_id = ${sc.userId}) as mn`
    await show(
      ctx,
      [
        "<b>My alerts</b>",
        "Choose which alerts you want me to send you.",
        "",
        "Tokens and NFTs you watch always send alerts, even if that alert type is turned off here.",
        "Muted tokens and NFTs never send alerts.",
      ].join("\n"),
      [
        [btn("Token alerts", "al:u:tk"), btn("NFT alerts", "al:u:na")],
        [btn(`Watched tokens (${n!.wt})`, "wl"), btn(`Watched NFTs (${n!.wn})`, "nwl")],
        [btn(`Muted tokens (${n!.mt})`, "mu"), btn(`Muted NFTs (${n!.mn})`, "nml")],
        [btn("Menu", "m")],
      ],
    )
    return
  }
  const s = sc.settings
  // The title and status lines are the group screen's existing text.
  const lines = [`<b>Alerts for ${escapeHtml(await chatTitle(ctx, sc.id))}</b>`]
  if (!sc.active)
    lines.push(`Paused${sc.paused && sc.paused !== "paused" ? ` (${sc.paused})` : ""}.`)
  const blocks = [lines.join("\n")]
  // Channels have no topics.
  if (sc.chatType !== "channel") {
    const topic = (t: number | null | undefined) => escapeHtml(topicLabel(s, t))
    blocks.push(
      `Default topic: ${topic(s.thread)}\nAny alerts not set to a specific topic will appear here.`,
    )
    const paused = s.pausedRoutes ?? []
    for (const [title, kinds] of [
      ["Token Alerts", TOKEN_ALERTS],
      ["NFT Alerts", [...NFT_ALL_ALERTS, ...NFT_WATCHED_ALERTS]],
    ] as const) {
      const routed = kinds
        .filter((a) => s.routes?.[a] !== undefined && !paused.includes(a))
        .map((a) => `${ALERT_LABEL[a]} → ${topic(s.routes![a])}`)
      const stopped = kinds
        .filter((a) => paused.includes(a))
        .map((a) => `${ALERT_LABEL[a]} paused: its topic is closed`)
      if (routed.length + stopped.length > 0)
        blocks.push([`<u>${title}</u>`, ...routed, ...stopped].join("\n"))
    }
  }
  const row = []
  // Resume also clears alerts paused because their topic broke.
  if (!sc.active || s.pausedRoutes?.length) row.push(btn("Resume", `gc:${sc.id}:resume`))
  if (sc.active) row.push(btn("Pause", `gc:${sc.id}:pause`))
  row.push(btn("Remove MAKO", `gc:${sc.id}:remove`))
  await show(ctx, blocks.join("\n\n"), [
    [btn("Token alerts", `al:${sc.id}:tk`), btn("NFT alerts", `al:${sc.id}:na`)],
    [btn("Watched tokens", `gl:${sc.id}:t`), btn("Watched NFTs", `gl:${sc.id}:n`)],
    row,
    [btn("Back", "gc")],
  ])
}

export async function alertsScreen(
  ctx: Context,
  deps: BotDeps,
  id: string,
  fresh = false,
): Promise<void> {
  const sc = await scopeFor(ctx, deps, id, fresh)
  if (!sc) return
  await renderHub(ctx, deps, sc)
  // Action first, then the welcome card, as /start does for deep links.
  if (sc.kind === "user" && sc.created) await sendWelcome(ctx, sc.settings)
}

export const openChatSettings = (ctx: Context, deps: BotDeps, chatId: string) =>
  alertsScreen(ctx, deps, chatId)

export function registerAlerts(bot: Bot, deps: BotDeps): void {
  const pm = bot.chatType("private")
  pm.command("alerts", (ctx) => alertsScreen(ctx, deps, "u", true))
  pm.callbackQuery(/^al:([^:]+)$/, (ctx) => alertsScreen(ctx, deps, ctx.match[1]!))
  pm.callbackQuery(new RegExp(`^al:([^:]+):(${SCREEN_PATTERN})$`), async (ctx) => {
    const sc = await scopeFor(ctx, deps, ctx.match[1]!)
    if (sc) await renderScreen(ctx, sc, ctx.match[2] as Screen)
  })
  pm.callbackQuery(new RegExp(`^al:([^:]+):(${ALERTS.join("|")}):(on|img)$`), async (ctx) => {
    const sc = await scopeFor(ctx, deps, ctx.match[1]!)
    if (!sc) return
    const a = ctx.match[2] as AlertKind
    const t = sc.settings.alerts[a]
    if (ctx.match[3] === "on" || a === "reminder") t.on = !t.on
    else (t as { image: boolean }).image = !(t as { image: boolean }).image
    await sc.save(sc.settings)
    await renderScreen(ctx, sc, SCREEN_OF(a))
  })
  pm.callbackQuery(new RegExp(`^al:([^:]+):p:(${PICKER_PATTERN})$`), async (ctx) => {
    const sc = await scopeFor(ctx, deps, ctx.match[1]!)
    if (sc) await renderPicker(ctx, sc, ctx.match[2]!)
  })
  pm.callbackQuery(new RegExp(`^al:([^:]+):p:(${PICKER_PATTERN}):([0-9])$`), async (ctx) => {
    const sc = await scopeFor(ctx, deps, ctx.match[1]!)
    if (!sc) return
    const kind = ctx.match[2]!
    const p = PICKERS[kind]!
    const v = p.values[Number(ctx.match[3])]
    if (v === undefined) return void (await ctx.answerCallbackQuery().catch(() => {}))
    const now = p.get(sc.settings)
    p.set(sc.settings, p.multi ? (now.includes(v) ? now.filter((x) => x !== v) : [...now, v]) : [v])
    await sc.save(sc.settings)
    await renderPicker(ctx, sc, kind)
  })
  pm.callbackQuery(new RegExp(`^al:([^:]+):reset:(${SCREEN_PATTERN})$`), async (ctx) => {
    const sc = await scopeFor(ctx, deps, ctx.match[1]!)
    if (!sc) return
    const screen = ctx.match[2] as Screen
    const chatType = sc.kind === "user" ? "private" : sc.chatType
    // Only this screen's alerts change: routing is not an alert preference, so a reset keeps it.
    sc.settings = resetScreen(sc.settings, RESET_SCREEN[screen], chatType)
    await sc.save(sc.settings)
    await logAction(deps.sql, {
      chatType,
      chatId: sc.kind === "user" ? null : sc.id,
      action: "preset",
      params: { choice: "reset" },
    })
    await renderScreen(ctx, sc, screen)
  })
}
