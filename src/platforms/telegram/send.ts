import type { Api } from "grammy"
import type { Payload } from "../../cards/card"
import type { ChatType } from "../../delivery/recipients"
import { classify, type Failure } from "./errors"
import { alertKeyboard, imagePlan, renderCard, toKeyboard } from "./render"

export type PendingRow = {
  id: string
  chat_id: string
  chat_type: ChatType
  thread_id: number | null
  alert: string
  token: string | null
  card: Payload
  attempts: number
}

export type SendResult = { ok: true } | ({ ok: false } & Failure)

/** Sends one delivery, choosing preview, photo or plain text. Never throws. */
export function createSend(
  api: Pick<Api, "sendMessage" | "sendPhoto">,
  opts: { linksBase: string; botUsername: string },
): (row: PendingRow) => Promise<SendResult> {
  return async (row) => {
    const chat = Number(row.chat_id)
    const base = { parse_mode: "HTML" as const, message_thread_id: row.thread_id ?? undefined }
    try {
      const p = row.card
      if (p.type === "text") {
        await api.sendMessage(chat, p.html, {
          ...base,
          link_preview_options: { is_disabled: true },
          reply_markup: p.buttons ? toKeyboard(p.buttons) : undefined,
        })
        return { ok: true }
      }
      const html = renderCard(p.card)
      const reply_markup = alertKeyboard(p.card, {
        ...opts,
        chatType: row.chat_type,
        deliveryId: row.id,
      })
      const plan = imagePlan(p.card, p.image)
      if (plan === "photo" && html.length <= 1024) {
        try {
          await api.sendPhoto(chat, p.card.imageUrl!, { ...base, caption: html, reply_markup })
          return { ok: true }
        } catch (err) {
          if (classify(err).kind !== "media") throw err
        }
      }
      await api.sendMessage(chat, html, {
        ...base,
        reply_markup,
        link_preview_options:
          plan === "preview"
            ? { url: p.card.imageUrl!, show_above_text: true }
            : { is_disabled: true },
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, ...classify(err) }
    }
  }
}
