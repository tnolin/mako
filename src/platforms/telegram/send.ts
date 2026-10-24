import type { Api } from "grammy"
import type { Payload } from "../../cards/card"
import type { ChatType } from "../../delivery/recipients"
import type { Viewer } from "../../delivery/viewer"
import { classify, type Failure } from "./errors"
import type { Images } from "./images"
import {
  alertKeyboard,
  nftAlertKeyboard,
  renderCard,
  renderNewTokens,
  renderNftAlert,
  toKeyboard,
} from "./render"

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

/** Sends one delivery, as a photo with the alert as caption or as plain text. Never throws. */
export function createSend(
  api: Pick<Api, "sendMessage" | "sendPhoto">,
  opts: {
    linksBase: string
    botUsername: string
    images: Images
    /** DM alerts open with the buttons in the state the user already set. Absent: all inactive. */
    viewer?: Viewer
  },
): (row: PendingRow) => Promise<SendResult> {
  return async (row) => {
    const chat = Number(row.chat_id)
    const thread = row.thread_id ?? undefined
    try {
      const p = row.card
      if (p.type === "text") {
        await api.sendMessage(chat, p.html, {
          parse_mode: "HTML",
          message_thread_id: thread,
          link_preview_options: { is_disabled: true },
          reply_markup: p.buttons ? toKeyboard(p.buttons) : undefined,
        })
        return { ok: true }
      }
      if (p.type === "newtokens") {
        await api.sendMessage(chat, renderNewTokens(p, opts.botUsername), {
          parse_mode: "HTML",
          message_thread_id: thread,
          link_preview_options: { is_disabled: true },
        })
        return { ok: true }
      }
      // Best effort: a failed lookup sends the alert with inactive buttons.
      const mine = row.chat_type === "private" && opts.viewer ? opts.viewer : null
      if (p.type === "nftalert") {
        const state = await mine?.nft(chat, p.card.contract).catch(() => undefined)
        await opts.images.send(api, {
          chat,
          thread,
          imageKey: p.card.imageKey,
          imageUrl: p.image ? p.card.imageUrl : null,
          html: renderNftAlert(p.card),
          reply_markup: nftAlertKeyboard(p.card, {
            linksBase: opts.linksBase,
            botUsername: opts.botUsername,
            chatType: row.chat_type,
            deliveryId: row.id,
            ...(state ? { state } : {}),
          }),
        })
        return { ok: true }
      }
      const state = await mine?.token(chat, p.card.token).catch(() => undefined)
      await opts.images.send(api, {
        chat,
        thread,
        imageKey: p.card.token,
        imageUrl: p.image ? p.card.imageUrl : null,
        html: renderCard(p.card),
        reply_markup: alertKeyboard(p.card, {
          linksBase: opts.linksBase,
          botUsername: opts.botUsername,
          chatType: row.chat_type,
          deliveryId: row.id,
          ...(state ? { state } : {}),
        }),
      })
      return { ok: true }
    } catch (err) {
      return { ok: false, ...classify(err) }
    }
  }
}
