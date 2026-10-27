import type { Bot, Context } from "grammy"
import type { ChatAdministratorRights, ChatMember, Message } from "grammy/types"
import type postgres from "postgres"
import { logAction } from "../actions"
import { moveChat } from "../chat-move"
import { escapeHtml } from "../format"
import { btn, chosenBtn, isAdmin, type Kb, link, show, sleep } from "../platforms/telegram/ui"
import {
  ALERT_LABEL,
  ALERT_PATTERN,
  ALERTS,
  type AlertKind,
  basicPreset,
  type ChatType,
  readSettings,
  type Settings,
} from "../settings"
import { NOT_ADMIN, openChatSettings } from "./alerts"
import type { BotDeps } from "./deps"
import { ensureUser, findUser, NO_USER } from "./users"
import { sendWelcome } from "./welcome"

export const SETUP_LINE = "Run /setup in the topic where MAKO should post alerts."
export const GUIDE = [
  "<b>Set up MAKO in a group</b>",
  "",
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
    { kind: ChatType; settings: unknown }[]
  >`select kind, settings from bot.chats where chat_id = ${chatId} and removed_at is null`
  return c ? readSettings(c.settings, c.kind) : null
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
    values (${chatId}, ${kind}, ${owner}, ${deps.sql.json(json(basicPreset(kind as ChatType)))}, false)
    on conflict (platform, chat_id) do update set removed_at = null, kind = excluded.kind`
}

async function dropPending(deps: BotDeps, chatId: number | string): Promise<void> {
  await deps.sql`
    update bot.deliveries set status = 'skipped', summarized = true where chat_id = ${chatId} and status = 'pending'`
}

async function markRemoved(deps: BotDeps, chatId: number | string): Promise<void> {
  await deps.sql`update bot.chats set removed_at = now(), active = false where chat_id = ${chatId}`
  await dropPending(deps, chatId)
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
  const { user, created } = await ensureUser(deps.sql, ctx.from!.id)
  await deps.sql`
    insert into bot.chats (chat_id, kind, setup_by, settings, active)
    values (${chatId}, 'channel', ${user.id}, ${deps.sql.json(json(basicPreset("channel")))}, true)
    on conflict (platform, chat_id) do update
      set active = true, removed_at = null, paused_reason = null, setup_by = excluded.setup_by, kind = 'channel'`
  await logAction(deps.sql, { chatType: "channel", chatId, action: "setup" })
  // The title is used for this reply only and never stored.
  await ctx.reply(`MAKO will post alerts in ${escapeHtml(title ?? "your channel")}.`, {
    parse_mode: "HTML",
    reply_markup: { remove_keyboard: true },
  })
  // Action first, then the welcome card, as /start does for deep links.
  if (created) await sendWelcome(ctx, user.settings)
}

const setupText = (hasSettings: boolean) =>
  `MAKO will post alerts here.${hasSettings ? "" : " Start a chat with MAKO to get settings and admin notices."}`
const setupKb = (bot: string, chatId: number): Kb => [
  [link("Open settings", `https://t.me/${bot}?start=s_${chatId}`)],
]

/**
 * A topic's name. Telegram attaches the topic's creation message to a message in a topic, unless the
 * message replies to another one. Undefined outside a topic or when it isn't attached.
 */
const topicNameOf = (m: Message | undefined): string | undefined =>
  m?.is_topic_message ? m.reply_to_message?.forum_topic_created?.name : undefined

/** Stores one topic's name in the chat's settings, without rewriting the rest of them. */
async function saveTopicName(deps: BotDeps, chatId: number, thread: number, name: string) {
  await deps.sql`
    update bot.chats
    set settings = jsonb_set(settings, '{topicNames}',
      coalesce(settings->'topicNames', '{}') || jsonb_build_object(${String(thread)}::text, ${name}::text))
    where chat_id = ${chatId}`
}

// MINT REMINDER goes to DMs only, so it has no route.
const ROUTED = ALERTS.filter((a) => a !== "reminder")

function routeKb(s: Settings, thread: number): Kb {
  return ROUTED.map((a) => [chosenBtn(ALERT_LABEL[a], s.routes?.[a] === thread, `rt:${a}`)])
}

export function registerChats(bot: Bot, deps: BotDeps): void {
  bot.on("my_chat_member", async (ctx) => {
    const { chat, old_chat_member: o, new_chat_member: n, from } = ctx.myChatMember
    if (chat.type === "private") return
    // A restricted bot that is still a member stays in the chat; only is_member: false means it left.
    const inside = (m: ChatMember) =>
      m.status === "member" ||
      m.status === "administrator" ||
      m.status === "creator" ||
      (m.status === "restricted" && m.is_member)
    if (inside(n) && !inside(o)) {
      await upsertChat(deps, chat.id, chat.type, (await findUser(deps.sql, from.id))?.id ?? null)
      if (chat.type !== "channel") {
        await ctx.api.sendMessage(chat.id, SETUP_LINE, {
          reply_markup: { inline_keyboard: guideKb() },
        })
      }
    } else if (!inside(n) && inside(o)) {
      await markRemoved(deps, chat.id)
    }
  })
  bot.callbackQuery("setup:guide", (ctx) => show(ctx, GUIDE))

  const groups = bot.chatType(["group", "supergroup"])
  groups.command("start", (ctx) =>
    ctx.reply(SETUP_LINE, { reply_markup: { inline_keyboard: guideKb() } }),
  )
  // A rename of a topic MAKO posts in: the default topic, a routed one or one already named.
  groups.on("message:forum_topic_edited", async (ctx) => {
    const name = ctx.msg.forum_topic_edited.name
    const thread = ctx.msg.message_thread_id
    if (!name || thread === undefined) return
    const s = await chatSettings(deps, ctx.chat.id)
    const used =
      s &&
      (s.thread === thread ||
        Object.values(s.routes ?? {}).includes(thread) ||
        s.topicNames?.[thread] !== undefined)
    if (used) await saveTopicName(deps, ctx.chat.id, thread, name)
  })
  groups.on("message:migrate_to_chat_id", async (ctx) => {
    const from = ctx.chat.id
    const to = ctx.msg.migrate_to_chat_id
    await deps.sql.begin((tx) => moveChat(tx, from, to))
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
    const s = (await chatSettings(deps, ctx.chat.id)) ?? basicPreset(ctx.chat.type as ChatType)
    s.thread = thread
    s.pausedRoutes = []
    const name = topicNameOf(ctx.msg)
    if (thread !== null && name) s.topicNames = { ...s.topicNames, [thread]: name }
    const setupBy = (await findUser(deps.sql, ctx.from.id))?.id ?? null
    // shortcut: writes the whole settings JSON (read-modify-write); a concurrent sender write to
    // pausedRoutes can be overwritten. Upgrade to a targeted jsonb_set update.
    await deps.sql`
      update bot.chats set settings = ${deps.sql.json(json(s))}, active = true, paused_reason = null,
        setup_by = coalesce(${setupBy}::bigint, setup_by)
      where chat_id = ${ctx.chat.id}`
    await logAction(deps.sql, { chatType: ctx.chat.type, chatId: ctx.chat.id, action: "setup" })
    await reply(setupText(!!setupBy), setupKb(ctx.me.username, ctx.chat.id))
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
    const name = topicNameOf(ctx.msg)
    if (name) await saveTopicName(deps, ctx.chat.id, thread, name)
    const known = name ?? s.topicNames?.[thread]
    await ctx.reply(`Post these alerts in ${known ? escapeHtml(known) : "this topic"}:`, {
      parse_mode: "HTML",
      message_thread_id: thread,
      reply_markup: { inline_keyboard: routeKb(s, thread) },
    })
  })
  groups.callbackQuery(new RegExp(`^rt:(${ALERT_PATTERN})$`), async (ctx) => {
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
    if (on) {
      s.routes[a] = thread
      s.alerts[a].on = true
    } else delete s.routes[a]
    s.pausedRoutes = (s.pausedRoutes ?? []).filter((x) => x !== a)
    // shortcut: writes the whole settings JSON (read-modify-write); a concurrent sender write to
    // pausedRoutes can be overwritten. Upgrade to a targeted jsonb_set update.
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
    await ctx.answerCallbackQuery(
      on
        ? {
            text: `${ALERT_LABEL[a]} is on and posts in ${s.topicNames?.[thread] ?? "this topic"}.`,
          }
        : {},
    )
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
      [btn("Add to a channel", "gc:addch")],
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
        text: NOT_ADMIN,
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
      await dropPending(deps, chatId)
    } else if (action === "resume") {
      const me = await ctx.api.getChatMember(Number(chatId), ctx.me.id).catch(() => null)
      if (!postsOk(me, c.kind === "channel")) {
        await ctx.answerCallbackQuery({
          text: "MAKO can't post there yet. Give it permission to post, then try again.",
          show_alert: true,
        })
        return
      }
      const s = readSettings(c.settings, c.kind as ChatType)
      s.pausedRoutes = []
      // shortcut: writes the whole settings JSON (read-modify-write); a concurrent sender write to
      // pausedRoutes can be overwritten. Upgrade to a targeted jsonb_set update.
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
