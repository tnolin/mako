import type { Bot } from "grammy"
import type { Update, UserFromGetMe } from "grammy/types"

export const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: "MAKO",
  username: "makoinkbot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe

type Chat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string }
// biome-ignore lint/suspicious/noExplicitAny: Telegram payloads are untyped JSON in tests
export type Payload = Record<string, any>
export type Call = { method: string; payload: Payload }
/** Return a value to answer the call, or `{ error: "description" }` to make Telegram fail it with a 400. */
type Responder = (payload: Payload) => unknown

function defaults(method: string, p: Payload): unknown {
  if (method === "sendPhoto") {
    return {
      message_id: 77,
      date: 0,
      chat: { id: p.chat_id, type: "private" },
      photo: [
        { file_id: "UPLOADED_SMALL", width: 90, height: 90 },
        { file_id: "UPLOADED", width: 640, height: 640 },
      ],
    }
  }
  if (method.startsWith("send") || method === "editMessageText") {
    return { message_id: 77, date: 0, chat: { id: p.chat_id, type: "private" }, text: p.text ?? "" }
  }
  if (method === "getChatMember") {
    return {
      status: "administrator",
      user: { id: p.user_id, is_bot: false, first_name: "A" },
      can_post_messages: true,
    }
  }
  if (method === "getChat") return { id: p.chat_id, type: "supergroup", title: "Test Group" }
  if (method === "getChatAdministrators") return []
  return true
}

export function harness(bot: Bot) {
  const calls: Call[] = []
  const responders = new Map<string, Responder>()
  bot.api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Payload
    calls.push({ method, payload: p })
    const r = responders.has(method) ? responders.get(method)!(p) : defaults(method, p)
    if (r && typeof r === "object" && "error" in r) {
      return {
        ok: false,
        error_code: 400,
        description: String((r as { error: string }).error),
      } as never
    }
    return { ok: true, result: r } as never
  })
  let updateId = 0
  let messageId = 0
  const user = (id: number, name = "U") => ({ id, is_bot: false, first_name: name })
  const privateChat = (id: number): Chat => ({ id, type: "private" })
  return {
    calls,
    on: (method: string, fn: Responder) => responders.set(method, fn),
    last: (method: string) => calls.filter((c) => c.method === method).at(-1)?.payload,
    clear: () => {
      calls.length = 0
    },
    async text(
      text: string,
      o: { from?: number; name?: string; chat?: Chat; thread?: number; replyTo?: string } = {},
    ) {
      const from = user(o.from ?? 100, o.name)
      const chat = o.chat ?? privateChat(from.id)
      const cmd = text.startsWith("/") ? text.split(" ")[0]!.length : 0
      await bot.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: ++messageId,
          date: 0,
          chat,
          from,
          text,
          ...(cmd ? { entities: [{ type: "bot_command", offset: 0, length: cmd }] } : {}),
          ...(o.thread ? { message_thread_id: o.thread, is_topic_message: true } : {}),
          ...(o.replyTo
            ? {
                reply_to_message: {
                  message_id: 1,
                  date: 0,
                  chat,
                  from: { id: BOT_INFO.id, is_bot: true, first_name: "MAKO" },
                  text: o.replyTo,
                },
              }
            : {}),
        },
      } as unknown as Update)
    },
    async tap(
      data: string,
      o: {
        from?: number
        name?: string
        chat?: Chat
        thread?: number
        keyboard?: { text: string; callback_data?: string; url?: string }[][]
        /** The tapped message is a photo with a caption, as a token card with an image is. */
        photo?: boolean
      } = {},
    ) {
      const from = user(o.from ?? 100, o.name)
      const chat = o.chat ?? privateChat(from.id)
      await bot.handleUpdate({
        update_id: ++updateId,
        callback_query: {
          id: String(updateId),
          from,
          chat_instance: "ci",
          data,
          message: {
            message_id: 50,
            date: 0,
            chat,
            ...(o.photo
              ? { photo: [{ file_id: "P", width: 640, height: 640 }], caption: "screen" }
              : { text: "screen" }),
            ...(o.thread ? { message_thread_id: o.thread, is_topic_message: true } : {}),
            ...(o.keyboard ? { reply_markup: { inline_keyboard: o.keyboard } } : {}),
          },
        },
      } as unknown as Update)
    },
    async update(u: Record<string, unknown>) {
      await bot.handleUpdate({ update_id: ++updateId, ...u } as unknown as Update)
    },
  }
}
