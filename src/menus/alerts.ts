import type { Bot, Context } from "grammy"
import type postgres from "postgres"
import { logAction } from "../actions"
import type { ChatType } from "../delivery/recipients"
import { escapeHtml } from "../format"
import { btn, isAdmin, type Kb, show } from "../platforms/telegram/ui"
import {
  ALERT_LABEL,
  ALERTS,
  type AlertKind,
  BIG_STEPS,
  basicPreset,
  MARKS,
  type Mark,
  readSettings,
  type Settings,
} from "../settings"
import type { BotDeps } from "./deps"
import { ensureUser, findUser, NO_USER, saveUserSettings } from "./users"

export const NOT_ADMIN = "Only admins of that chat can change its settings."
type Scope =
  | { kind: "user"; id: "u"; settings: Settings; save(s: Settings): Promise<void>; muted: number }
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
    const user = fresh
      ? (await ensureUser(deps.sql, ctx.from!.id)).user
      : await findUser(deps.sql, ctx.from!.id)
    if (!user) {
      await show(ctx, NO_USER)
      return null
    }
    const [m] = await deps.sql<{ n: number }[]>`
      select count(*)::int as n from bot.subscriptions where user_id = ${user.id} and kind = 'mute'`
    return {
      kind: "user",
      id: "u",
      settings: user.settings,
      save: (s) => saveUserSettings(deps.sql, user.id, s),
      muted: m?.n ?? 0,
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
    settings: readSettings(c.settings),
    active: c.active,
    paused: c.paused_reason,
    // shortcut: saves the whole settings JSON (read-modify-write), so a concurrent sender write to
    // pausedRoutes can be overwritten; upgrade to a targeted jsonb_set update if that bites.
    save: async (s) => {
      await deps.sql`update bot.chats set settings = ${deps.sql.json(s as unknown as postgres.JSONValue)} where chat_id = ${id}`
    },
  }
}

const pct = (bps: number) => `${bps / 100}%`
const where = (thread: number | null | undefined) =>
  thread == null ? "General" : `topic ${thread}`

async function render(ctx: Context, sc: Scope): Promise<void> {
  const s = sc.settings
  const title =
    sc.kind === "user"
      ? "<b>My alerts</b>"
      : `<b>Alerts for ${escapeHtml(
          await ctx.api
            .getChat(Number(sc.id))
            .then((c) => ("title" in c && c.title) || "this chat")
            .catch(() => "this chat"),
        )}</b>`
  const lines = [title]
  if (sc.kind === "chat") {
    if (!sc.active) lines.push(`Paused${sc.paused ? ` (${sc.paused})` : ""}.`)
    // Channels have no topics.
    if (sc.chatType !== "channel") {
      lines.push(`Posts to ${where(s.thread)}.`)
      for (const a of ALERTS) {
        if (s.routes?.[a] !== undefined) lines.push(`${ALERT_LABEL[a]} → topic ${s.routes[a]}`)
      }
      for (const a of s.pausedRoutes ?? []) {
        lines.push(`${ALERT_LABEL[a]} paused: its topic is closed`)
      }
    }
  }
  const kb: Kb = ALERTS.map((a) => [
    btn(`${ALERT_LABEL[a]} ${s.alerts[a].on ? "on" : "off"}`, `al:${sc.id}:${a}:on`),
    btn(`image ${s.alerts[a].image ? "on" : "off"}`, `al:${sc.id}:${a}:img`),
  ])
  kb.push([
    btn(`BONDING at ${s.alerts.bonding.marks.map(pct).join(" ") || "none"}`, `al:${sc.id}:mk`),
    btn(`BIG at ${pct(s.alerts.big.pctBps)}`, `al:${sc.id}:big`),
  ])
  if (sc.kind === "user") kb.push([btn(`Muted tokens (${sc.muted})`, "mu")])
  kb.push([btn("Reset to basic preset", `al:${sc.id}:reset`)])
  if (sc.kind === "chat") {
    const row = []
    // Resume also clears alerts paused because their topic broke.
    if (!sc.active || s.pausedRoutes?.length) row.push(btn("Resume", `gc:${sc.id}:resume`))
    if (sc.active) row.push(btn("Pause", `gc:${sc.id}:pause`))
    row.push(btn("Remove MAKO", `gc:${sc.id}:remove`))
    kb.push(row)
  }
  kb.push([btn("Back", sc.kind === "user" ? "m" : "gc")])
  await show(ctx, lines.join("\n"), kb)
}

export async function alertsScreen(
  ctx: Context,
  deps: BotDeps,
  id: string,
  fresh = false,
): Promise<void> {
  const sc = await scopeFor(ctx, deps, id, fresh)
  if (sc) await render(ctx, sc)
}

export const openChatSettings = (ctx: Context, deps: BotDeps, chatId: string) =>
  alertsScreen(ctx, deps, chatId)

const marksScreen = (ctx: Context, sc: Scope) =>
  show(ctx, "<b>BONDING marks</b>\nAlert when a curve passes:", [
    MARKS.map((x) =>
      btn(
        `${sc.settings.alerts.bonding.marks.includes(x) ? "✓" : "·"} ${pct(x)}`,
        `al:${sc.id}:mk:${x}`,
      ),
    ),
    [btn("Back", `al:${sc.id}`)],
  ])

export function registerAlerts(bot: Bot, deps: BotDeps): void {
  const pm = bot.chatType("private")
  pm.command("alerts", (ctx) => alertsScreen(ctx, deps, "u", true))
  pm.callbackQuery(/^al:([^:]+)$/, (ctx) => alertsScreen(ctx, deps, ctx.match[1]!))
  pm.callbackQuery(
    /^al:([^:]+):(new|bonding|pumping|bonded|devsell|big):(on|img)$/,
    async (ctx) => {
      const sc = await scopeFor(ctx, deps, ctx.match[1]!)
      if (!sc) return
      const t = sc.settings.alerts[ctx.match[2] as AlertKind]
      if (ctx.match[3] === "on") t.on = !t.on
      else t.image = !t.image
      await sc.save(sc.settings)
      await render(ctx, sc)
    },
  )
  pm.callbackQuery(/^al:([^:]+):mk$/, async (ctx) => {
    const sc = await scopeFor(ctx, deps, ctx.match[1]!)
    if (sc) await marksScreen(ctx, sc)
  })
  pm.callbackQuery(/^al:([^:]+):mk:(5000|8000|9000)$/, async (ctx) => {
    const sc = await scopeFor(ctx, deps, ctx.match[1]!)
    if (!sc) return
    const m = Number(ctx.match[2]) as Mark
    const b = sc.settings.alerts.bonding
    b.marks = MARKS.filter((x) => (x === m ? !b.marks.includes(m) : b.marks.includes(x)))
    await sc.save(sc.settings)
    await marksScreen(ctx, sc)
  })
  pm.callbackQuery(/^al:([^:]+):big$/, async (ctx) => {
    const sc = await scopeFor(ctx, deps, ctx.match[1]!)
    if (!sc) return
    const g = sc.settings.alerts.big
    g.pctBps = BIG_STEPS[(BIG_STEPS.indexOf(g.pctBps) + 1) % BIG_STEPS.length]!
    await sc.save(sc.settings)
    await render(ctx, sc)
  })
  pm.callbackQuery(/^al:([^:]+):reset$/, async (ctx) => {
    const sc = await scopeFor(ctx, deps, ctx.match[1]!)
    if (!sc) return
    const s = basicPreset()
    if (sc.kind === "chat") {
      // Routing is not an alert preference, so a reset keeps it.
      s.thread = sc.settings.thread
      s.routes = sc.settings.routes
      s.pausedRoutes = sc.settings.pausedRoutes
    }
    sc.settings = s
    await sc.save(s)
    await logAction(deps.sql, {
      chatType: sc.kind === "user" ? "private" : sc.chatType,
      chatId: sc.kind === "user" ? null : sc.id,
      action: "preset",
      params: { choice: "reset" },
    })
    await render(ctx, sc)
  })
}
