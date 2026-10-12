import { GrammyError } from "grammy"
import { expect, it, vi } from "vitest"
import type { Card } from "../src/cards/card"
import { createSend, type PendingRow } from "../src/platforms/telegram/send"

const card: Card = {
  alert: "new",
  title: "NEW TOKEN",
  ticker: "TIDE",
  name: "Tide",
  launchpad: "InkyPump",
  launchpadKey: "inkypump",
  rows: [["pair", "TIDE/ETH"]],
  links: [],
  token: "0x7a3f2c91e0b4d58a6f12c3e9b07d4a8e5f61c21e",
  imageUrl: "https://images.inkypump.com/original/x.jpg",
}
const row = (over: Partial<PendingRow> = {}): PendingRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  chat_id: "-1001",
  chat_type: "supergroup",
  thread_id: 7,
  alert: "new",
  token: card.token,
  card: { type: "card", card, image: true },
  attempts: 0,
  ...over,
})
const media = new GrammyError(
  "x",
  { ok: false, error_code: 400, description: "Bad Request: failed to get HTTP URL content" },
  "sendPhoto",
  {},
)
function api() {
  return {
    sendMessage: vi.fn(async () => ({}) as never),
    sendPhoto: vi.fn(async () => ({}) as never),
  }
}
const opts = { linksBase: "https://go.makobot.xyz", botUsername: "makoinkbot" }

it("sends launchpad images as a large link preview above the text, in the topic", async () => {
  const a = api()
  expect(await createSend(a, opts)(row())).toEqual({ ok: true })
  const [chat, , o] = a.sendMessage.mock.calls[0] as unknown as [
    number,
    string,
    Record<string, unknown>,
  ]
  expect(chat).toBe(-1001)
  expect(o).toMatchObject({
    parse_mode: "HTML",
    message_thread_id: 7,
    link_preview_options: { url: card.imageUrl, show_above_text: true },
  })
  expect(o.link_preview_options).not.toHaveProperty("prefer_small_media")
})

it("uses sendPhoto for other hosts and falls back to text on a media error", async () => {
  const a = api()
  a.sendPhoto.mockRejectedValueOnce(media)
  const r = row({
    card: { type: "card", card: { ...card, imageUrl: "https://ipfs.io/ipfs/x" }, image: true },
  })
  expect(await createSend(a, opts)(r)).toEqual({ ok: true })
  expect(a.sendPhoto).toHaveBeenCalledOnce()
  expect((a.sendMessage.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({
    link_preview_options: { is_disabled: true },
  })
})

it("falls back to text when the chat allows text but not photos", async () => {
  const a = api()
  a.sendPhoto.mockRejectedValueOnce(
    new GrammyError(
      "x",
      {
        ok: false,
        error_code: 400,
        description: "Bad Request: not enough rights to send photos to the chat",
      },
      "sendPhoto",
      {},
    ),
  )
  const r = row({
    card: { type: "card", card: { ...card, imageUrl: "https://ipfs.io/ipfs/x" }, image: true },
  })
  expect(await createSend(a, opts)(r)).toEqual({ ok: true })
  expect(a.sendMessage).toHaveBeenCalledOnce()
})

it("disables previews when images are off", async () => {
  const a = api()
  await createSend(a, opts)(row({ card: { type: "card", card, image: false } }))
  expect((a.sendMessage.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({
    link_preview_options: { is_disabled: true },
  })
})

it("sends text payloads with their buttons", async () => {
  const a = api()
  await createSend(
    a,
    opts,
  )(
    row({
      chat_type: "private",
      thread_id: null,
      card: { type: "text", html: "hi", buttons: [[{ text: "My alerts", data: "al:u" }]] },
    }),
  )
  expect((a.sendMessage.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "My alerts", callback_data: "al:u" }]] },
  })
})

it("returns a classified failure instead of throwing", async () => {
  const a = api()
  a.sendMessage.mockRejectedValueOnce(
    new GrammyError(
      "x",
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
      "sendMessage",
      {},
    ),
  )
  expect(await createSend(a, opts)(row())).toMatchObject({ ok: false, kind: "blocked" })
})
