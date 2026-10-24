import type { Api, Context } from "grammy"
import type { InlineKeyboardButton } from "grammy/types"
import { classify } from "./errors"

export type Kb = InlineKeyboardButton[][]
export const btn = (text: string, data: string): InlineKeyboardButton => ({
  text,
  callback_data: data,
})

/** Bot API button style for an active state. Every screen goes through the helpers below, never `style`. */
export const btnOn = (text: string, data: string): InlineKeyboardButton => ({
  text,
  callback_data: data,
  style: "success",
})

// BUTTON_COLOURS=0 is the fallback if a supported Telegram client shows no button colours: one flag, set
// at startup, for everyone. Toggles then read `: on`/`: off` and chosen values get a `· ` prefix.
let colours = true
export function setButtonColours(on: boolean): void {
  colours = on
}
type StateOpts = { textState: boolean }
const textState = (o?: StateOpts) => o?.textState ?? !colours

/** An alert switch: green when on, plain (grey) when off. */
export function toggleBtn(
  label: string,
  on: boolean,
  data: string,
  opts?: StateOpts,
): InlineKeyboardButton {
  const text = textState(opts) ? `${label}: ${on ? "on" : "off"}` : label
  return on ? btnOn(text, data) : btn(text, data)
}

/** Watch / Watching, Mute / Muted, Remind me / Reminder set. The state word is the label, so no fallback. */
export function stateBtn(
  s: { on: boolean; off: string; onText: string },
  data: string,
): InlineKeyboardButton {
  return s.on ? btnOn(s.onText, data) : btn(s.off, data)
}

/** A chosen value (the active window, a threshold, a selected mark): green, or `· ` in the fallback. */
export function chosenBtn(
  label: string,
  chosen: boolean,
  data: string,
  opts?: StateOpts,
): InlineKeyboardButton {
  if (!chosen) return btn(label, data)
  return btnOn(textState(opts) ? `· ${label}` : label, data)
}

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

/**
 * Ends every menu and list message. Telegram sizes a message and its buttons to the widest line, so a line
 * of blank Braille characters (U+2800, which Telegram does not trim) gives every screen the same full width.
 */
export const FULL_WIDTH = `\n${"\u2800".repeat(40)}`

/**
 * Shows a screen: edits the tapped message, or replies in the same topic. Identical edits count as success.
 * A screen with buttons gets the full-width line.
 */
export async function show(ctx: Context, text: string, kb: Kb = []): Promise<void> {
  const html = kb.length > 0 ? text + FULL_WIDTH : text
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
