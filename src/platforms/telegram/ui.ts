import type { Api, Context } from "grammy"
import type { InlineKeyboardButton } from "grammy/types"
import { classify } from "./errors"

export type Kb = InlineKeyboardButton[][]
export const btn = (text: string, data: string): InlineKeyboardButton => ({
  text,
  callback_data: data,
})
export const link = (text: string, url: string): InlineKeyboardButton => ({ text, url })
export const COMMUNITY_URL = "https://t.me/MakoOnInk"

const ADDRESS = /0x[0-9a-fA-F]{40}/
/** The first EVM address in the text, lowercased: payloads are lowercase, users paste checksummed. */
export function findAddress(text: string | undefined): string | null {
  const m = text ? ADDRESS.exec(text) : null
  return m ? m[0].toLowerCase() : null
}

/** The forum topic of the message being answered (the tapped message for a button), if any. */
export function threadOf(ctx: Context): number | undefined {
  const m = ctx.callbackQuery?.message ?? ctx.msg
  return m && "is_topic_message" in m && m.is_topic_message ? m.message_thread_id : undefined
}

/** Shows a screen: edits the tapped message, or replies in the same topic. Identical edits count as success. */
export async function show(ctx: Context, html: string, kb: Kb = []): Promise<void> {
  const opts = {
    parse_mode: "HTML" as const,
    reply_markup: { inline_keyboard: kb },
    link_preview_options: { is_disabled: true },
  }
  try {
    if (ctx.callbackQuery?.message) await ctx.editMessageText(html, opts)
    else await ctx.reply(html, { ...opts, message_thread_id: threadOf(ctx) })
  } catch (err) {
    if (classify(err).kind !== "not_modified") throw err
  }
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {})
}

/** Live admin check. Stored owner/setup_by never grant permission. */
export async function isAdmin(api: Api, chatId: number | string, userId: number): Promise<boolean> {
  const m = await api.getChatMember(Number(chatId), userId).catch(() => null)
  return m?.status === "creator" || m?.status === "administrator"
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
