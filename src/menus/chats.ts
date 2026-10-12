import type { Bot, Context } from "grammy"
import type { ChatAdministratorRights, ChatMember } from "grammy/types"
import type postgres from "postgres"
import { logAction } from "../actions"
import { escapeHtml } from "../format"
import { btn, isAdmin, type Kb, link, show, sleep } from "../platforms/telegram/ui"
import {
  ALERT_LABEL,
  ALERTS,
  type AlertKind,
  basicPreset,
  readSettings,
  type Settings,
} from "../settings"
import { openChatSettings } from "./alerts"
import type { BotDeps } from "./deps"
import { ensureUser, findUser, NO_USER } from "./users"

export const SETUP_LINE = "Run /setup in the topic where MAKO should post alerts."
export const GUIDE = [
  "<b>Set up MAKO in a group</b>",
  "1. Run /setup in the topic where alerts should go (or in the chat if it has no topics).",
  "2. Optional: run /route in other topics to send chosen alerts there.",
  "3. Tap Open settings to choose feeds, thresholds and images in your DM with MAKO.",
].join("\n")
export const CHANNEL_REQUEST_ID = 1

const json = (s: Settings) => s as unknown as postgres.JSONValue
const guideKb = (): Kb => [[btn("How to set up", "setup:guide")]]
const rights = (extra: { can_promote_members?: boolean }): ChatAdministratorRights => ({
  is_anonymous: false,
  can_manage_chat: false,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_send_welcome_messages: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_post_messages: true,
  ...extra,
})

async function chatSettings(deps: BotDeps, chatId: number | string): Promise<Settings | null> {
  const [c] = await deps.sql<
    { settings: unknown }[]
  >`select settings from bot.chats where chat_id = ${chatId} and removed_at is null`
  return c ? readSettings(c.settings) : null
}

/** Creates the chat row (inactive, preset) or revives it. Never deactivates an active row. */
async function upsertChat(
  deps: BotDeps,
  chatId: number,
  kind: string,
  owner: string | null,
): Promise<void> {
  await deps.sql`
    insert into bot.chats (chat_id, kind, owner, settings, active)
    values (${chatId}, ${kind}, ${owner}, ${deps.sql.json(json(basicPreset()))}, false)
    on conflict (platform, chat_id) do update set removed_at = null, kind = excluded.kind`
}

async function markRemoved(deps: BotDeps, chatId: number | string): Promise<void> {
  await deps.sql`update bot.chats set removed_at = now(), active = false where chat_id = ${chatId}`
  await deps.sql`
    update bot.deliveries set status = 'skipped', summarized = true where chat_id = ${chatId} and status = 'pending'`
}

const postsOk = (m: ChatMember | null, channel: boolean) =>
  !!m &&
  (channel
    ? m.status === "administrator" && m.can_post_messages === true
    : m.status === "administrator" || m.status === "member" || m.status === "creator")

async function linkChannel(
  ctx: Context,
  deps: BotDeps,
  chatId: number,
  title: string | undefined,
): Promise<void> {
  let ok = false
  for (let i = 0; i < 6 && !ok; i++) {
    ok = postsOk(await ctx.api.getChatMember(chatId, ctx.me.id).catch(() => null), true)
    if (!ok && i < 5) await sleep(deps.channelRetryMs ?? 1000)
  }
  if (!ok || !(await isAdmin(ctx.api, chatId, ctx.from!.id))) {
    await ctx.reply("MAKO couldn't get posting rights in that channel.", {
      reply_markup: { inline_keyboard: [[btn("Try again", "gc:addch")]] },
    })
    return
  }
  const { user } = await ensureUser(deps.sql, ctx.from!.id)
  await deps.sql`
    insert into bot.chats (chat_id, kind, setup_by, settings, active)
    values (${chatId}, 'channel', ${user.id}, ${deps.sql.json(json(basicPreset()))}, true)
    on conflict (platform, chat_id) do update
      set active = true, removed_at = null, paused_reason = null, setup_by = excluded.setup_by, kind = 'channel'`
  await logAction(deps.sql, { chatType: "channel", chatId, action: "setup" })
  // The title is used for this reply only and never stored.
  await ctx.reply(`MAKO will post alerts in ${escapeHtml(title ?? "your channel")}.`, {
    parse_mode: "HTML",
    reply_markup: { remove_keyboard: true },
  })
}

function routeKb(s: Settings, thread: number): Kb {
  return ALERTS.map((a) => [
    btn(`${s.routes?.[a] === thread ? "✓" : "·"} ${ALERT_LABEL[a]}`, `rt:${a}`),
  ])
}

export function registerChats(bot: Bot, deps: BotDeps): void {
  bot.on("my_chat_member", async (ctx) => {
    const { chat, old_chat_member: o, new_chat_member: n, from } = ctx.myChatMember
    if (chat.type === "private") return
    const inside = (s: string) => s === "member" || s === "administrator" || s === "creator"
    if (inside(n.status) && !inside(o.status)) {
      await upsertChat(deps, chat.id, chat.type, (await findUser(deps.sql, from.id))?.id ?? null)
      if (chat.type !== "channel") {
        await ctx.api.sendMessage(chat.id, SETUP_LINE, {
          reply_markup: { inline_keyboard: guideKb() },
        })
      }
    } else if (!inside(n.status) && inside(o.status)) {
      await markRemoved(deps, chat.id)
    }
  })
  bot.callbackQuery("setup:guide", (ctx) => show(ctx, GUIDE))

  const groups = bot.chatType(["group", "supergroup"])
  groups.command("start", (ctx) =>
    ctx.reply(SETUP_LINE, { reply_markup: { inline_keyboard: guideKb() } }),
  )
  groups.on("message:migrate_to_chat_id", async (ctx) => {
    const from = ctx.chat.id
    const to = ctx.msg.migrate_to_chat_id
    await deps.sql.begin(async (tx) => {
      const [taken] = await tx`select 1 from bot.chats where chat_id = ${to}`
      if (!taken) {
        await tx`update bot.chats set chat_id = ${to}, kind = 'supergroup' where chat_id = ${from}`
        return
      }
      // The supergroup's own join event can arrive first: carry the old row's setup over and drop it.
      await tx`
        update bot.chats n set settings = o.settings, active = o.active, paused_reason = o.paused_reason,
          owner = coalesce(n.owner, o.owner), setup_by = coalesce(o.setup_by, n.setup_by),
          removed_at = null, kind = 'supergroup'
        from bot.chats o where o.chat_id = ${from} and n.chat_id = ${to}`
      await tx`delete from bot.chats where chat_id = ${from}`
    })
  })
  groups.command("setup", async (ctx) => {
    const thread = ctx.msg.is_topic_message ? (ctx.msg.message_thread_id ?? null) : null
    const reply = (text: string, kb?: Kb) =>
      ctx.reply(text, {
        message_thread_id: thread ?? undefined,
        reply_markup: kb ? { inline_keyboard: kb } : undefined,
      })
    if (!(await isAdmin(ctx.api, ctx.chat.id, ctx.from.id))) {
      await reply("Only group admins can run /setup.")
      return
    }
    await upsertChat(deps, ctx.chat.id, ctx.chat.type, null)
    const s = (await chatSettings(deps, ctx.chat.id)) ?? basicPreset()
    s.thread = thread
    s.pausedRoutes = []
    const setupBy = (await findUser(deps.sql, ctx.from.id))?.id ?? null
    await deps.sql`
      update bot.chats set settings = ${deps.sql.json(json(s))}, active = true, paused_reason = null,
        setup_by = coalesce(${setupBy}::bigint, setup_by)
      where chat_id = ${ctx.chat.id}`
    await logAction(deps.sql, { chatType: ctx.chat.type, chatId: ctx.chat.id, action: "setup" })
    await reply(
      `MAKO will post alerts here.${setupBy ? "" : " Start a chat with MAKO to get settings and admin notices."}`,
      [[link("Open settings", `https://t.me/${ctx.me.username}?start=s_${ctx.chat.id}`)]],
    )
  })
  groups.command("route", async (ctx) => {
    const thread = ctx.msg.is_topic_message ? ctx.msg.message_thread_id : undefined
    if (!(await isAdmin(ctx.api, ctx.chat.id, ctx.from.id))) {
      await ctx.reply("Only group admins can run /route.", { message_thread_id: thread })
      return
    }
    const s = await chatSettings(deps, ctx.chat.id)
    if (!s) {
      await ctx.reply(SETUP_LINE, {
        message_thread_id: thread,
        reply_markup: { inline_keyboard: guideKb() },
      })
      return
    }
    if (thread === undefined) {
      await ctx.reply("Run /route inside the topic that should get those alerts.")
      return
    }
    await ctx.reply("Post these alerts in this topic:", {
      message_thread_id: thread,
      reply_markup: { inline_keyboard: routeKb(s, thread) },
    })
  })
  groups.callbackQuery(/^rt:(new|bonding|pumping|bonded|devsell|big)$/, async (ctx) => {
    const m = ctx.callbackQuery.message
    const thread =
      m && "is_topic_message" in m && m.is_topic_message ? m.message_thread_id : undefined
    if (!(await isAdmin(ctx.api, ctx.chat.id, ctx.from.id))) {
      await ctx.answerCallbackQuery({
        text: "Only group admins can change routing.",
        show_alert: true,
      })
      return
    }
    const s = await chatSettings(deps, ctx.chat.id)
    if (!s || thread === undefined) return void (await ctx.answerCallbackQuery())
    const a = ctx.match[1] as AlertKind
    const on = s.routes?.[a] !== thread
    s.routes = { ...s.routes }
    if (on) s.routes[a] = thread
    else delete s.routes[a]
    s.pausedRoutes = (s.pausedRoutes ?? []).filter((x) => x !== a)
    await deps.sql`update bot.chats set settings = ${deps.sql.json(json(s))} where chat_id = ${ctx.chat.id}`
    await logAction(deps.sql, {
      chatType: ctx.chat.type,
      chatId: ctx.chat.id,
      action: "route",
      params: { alert: a, on },
    })
    await ctx
      .editMessageReplyMarkup({ reply_markup: { inline_keyboard: routeKb(s, thread) } })
      .catch(() => {})
    await ctx.answerCallbackQuery()
  })

  const pm = bot.chatType("private")
  pm.callbackQuery("gc", async (ctx) => {
    // A button tap never creates a user.
    const user = await findUser(deps.sql, ctx.from.id)
    if (!user) return show(ctx, NO_USER)
    // shortcut: lists chats this user added or set up, checked live. Other admins reach a chat's settings
    // through /setup's Open settings link; a full scan would call getChatMember on every chat.
    const rows = await deps.sql<{ chat_id: string }[]>`
      select chat_id::text from bot.chats
      where removed_at is null and (owner = ${user.id} or setup_by = ${user.id}) order by created_at`
    const mine: Kb = []
    for (const r of rows) {
      if (!(await isAdmin(ctx.api, r.chat_id, ctx.from.id))) continue
      const title = await ctx.api
        .getChat(Number(r.chat_id))
        .then((c) => ("title" in c && c.title) || r.chat_id)
        .catch(() => r.chat_id)
      mine.push([btn(title, `gc:${r.chat_id}`)])
    }
    const text = mine.length
      ? "<b>Groups & channels</b>\nTap a chat to change its alerts."
      : "<b>Groups & channels</b>\nMAKO isn't set up in any of your groups or channels yet."
    await show(ctx, text, [
      ...mine,
      [
        link(
          "Add to a group",
          `https://t.me/${ctx.me.username}?startgroup=setup&admin=post_messages+manage_topics`,
        ),
      ],
      [btn("Add a channel", "gc:addch")],
      [btn("Menu", "m")],
    ])
  })
  pm.callbackQuery("gc:addch", async (ctx) => {
    await ctx.answerCallbackQuery()
    await ctx.reply(
      "Tap the button below and pick a channel. MAKO joins it as an admin that can post.",
      {
        reply_markup: {
          resize_keyboard: true,
          one_time_keyboard: true,
          keyboard: [
            [
              {
                text: "Pick a channel",
                request_chat: {
                  request_id: CHANNEL_REQUEST_ID,
                  chat_is_channel: true,
                  user_administrator_rights: rights({ can_promote_members: true }),
                  bot_administrator_rights: rights({}),
                  request_title: true,
                },
              },
            ],
          ],
        },
      },
    )
  })
  pm.on("message:chat_shared", async (ctx) => {
    const s = ctx.msg.chat_shared
    if (s.request_id === CHANNEL_REQUEST_ID) await linkChannel(ctx, deps, s.chat_id, s.title)
  })
  pm.callbackQuery(/^gc:(-?\d+)$/, (ctx) => openChatSettings(ctx, deps, ctx.match[1]!))
  pm.callbackQuery(/^gc:(-?\d+):(pause|resume|remove)$/, async (ctx) => {
    const chatId = ctx.match[1]!
    if (!(await isAdmin(ctx.api, chatId, ctx.from.id))) {
      await ctx.answerCallbackQuery({
        text: "Only admins of that chat can change its settings.",
        show_alert: true,
      })
      return
    }
    const action = ctx.match[2]
    const [c] = await deps.sql<{ kind: string; settings: unknown }[]>`
      select kind, settings from bot.chats where chat_id = ${chatId} and removed_at is null`
    if (!c)
      return show(ctx, "MAKO isn't in that chat any more.", [[btn("Groups & channels", "gc")]])
    if (action === "pause") {
      await deps.sql`update bot.chats set active = false, paused_reason = 'paused' where chat_id = ${chatId}`
    } else if (action === "resume") {
      const me = await ctx.api.getChatMember(Number(chatId), ctx.me.id).catch(() => null)
      if (!postsOk(me, c.kind === "channel")) {
        await ctx.answerCallbackQuery({
          text: "MAKO can't post there yet. Give it permission to post, then try again.",
          show_alert: true,
        })
        return
      }
      const s = readSettings(c.settings)
      s.pausedRoutes = []
      await deps.sql`
        update bot.chats set active = true, paused_reason = null, settings = ${deps.sql.json(json(s))} where chat_id = ${chatId}`
    } else {
      await ctx.api.leaveChat(Number(chatId)).catch(() => {})
      await markRemoved(deps, chatId)
      await show(ctx, "MAKO left that chat.", [[btn("Groups & channels", "gc")]])
      return
    }
    await openChatSettings(ctx, deps, chatId)
  })
}
