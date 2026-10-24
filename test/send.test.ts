import { GrammyError, InputFile } from "grammy"
import { expect, it, vi } from "vitest"
import type { Card } from "../src/cards/card"
import { createImages } from "../src/platforms/telegram/images"
import { renderNewTokens } from "../src/platforms/telegram/render"
import { createSend, type PendingRow } from "../src/platforms/telegram/send"
import { imageResponse, memoryCache, okFetch, photoResult } from "./helpers/images"

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
  imageUrl: "https://ipfs.io/ipfs/x?a=1&b=2",
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
const tgError = (description: string, method = "sendPhoto") =>
  new GrammyError("x", { ok: false, error_code: 400, description }, method, {})
const media = tgError("Bad Request: failed to get HTTP URL content")
function api() {
  return {
    sendMessage: vi.fn(async () => ({}) as never),
    sendPhoto: vi.fn(async () => photoResult() as never),
  }
}
function setup(cached: Record<string, string> = {}, fetchFn = okFetch()) {
  let clock = 1_000_000
  const { rows, cache } = memoryCache(cached)
  const images = createImages({ fetch: fetchFn, cache, log: () => {}, now: () => clock })
  const opts = { linksBase: "https://go.makobot.xyz", botUsername: "makoinkbot", images }
  return { rows, cache, fetchFn, opts, advance: (ms: number) => (clock += ms) }
}
type Call = [number, unknown, Record<string, unknown>]
const photoCall = (a: ReturnType<typeof api>, i = 0) => a.sendPhoto.mock.calls[i] as unknown as Call
const textCall = (a: ReturnType<typeof api>, i = 0) =>
  a.sendMessage.mock.calls[i] as unknown as Call

it("sends a cached file_id as a photo with the alert as caption, in the topic, without fetching", async () => {
  const a = api()
  const s = setup({ [card.token]: "CACHED" })
  expect(await createSend(a, s.opts)(row())).toEqual({ ok: true })
  const [chat, photo, o] = photoCall(a)
  expect(chat).toBe(-1001)
  expect(photo).toBe("CACHED")
  expect(o).toMatchObject({ parse_mode: "HTML", message_thread_id: 7 })
  expect(o.caption).toContain("<b>NEW TOKEN</b>")
  expect(o.reply_markup).toMatchObject({
    inline_keyboard: [[{ text: "Trade" }, { text: "Watch" }]],
  })
  expect(a.sendMessage).not.toHaveBeenCalled()
  expect(s.fetchFn).not.toHaveBeenCalled()
})

it("fetches the padded image once, uploads it and stores the largest file_id", async () => {
  const a = api()
  const s = setup()
  expect(await createSend(a, s.opts)(row())).toEqual({ ok: true })
  expect(s.fetchFn).toHaveBeenCalledOnce()
  const [url, init] = s.fetchFn.mock.calls[0] as unknown as [string, { signal: AbortSignal }]
  expect(url).toBe(
    `https://wsrv.nl/?url=${encodeURIComponent(card.imageUrl!)}&w=640&h=640&fit=contain&cbg=1a2236&output=jpg`,
  )
  expect(init.signal).toBeInstanceOf(AbortSignal)
  const [, photo] = photoCall(a)
  expect(photo).toBeInstanceOf(InputFile)
  expect(s.rows.get(card.token)).toBe("BIG")
  // The second alert for the token reuses the stored id.
  await createSend(a, s.opts)(row())
  expect(s.fetchFn).toHaveBeenCalledOnce()
  expect(photoCall(a, 1)[1]).toBe("BIG")
})

it("never fetches anything but a wsrv.nl URL, whatever the creator's URL says", async () => {
  const s = setup()
  const hostile = [
    "https://169.254.169.254/latest/meta-data",
    "https://localhost:8080/x",
    "https://evil.example/a.jpg?x=https://wsrv.nl/",
  ]
  for (const [i, imageUrl] of hostile.entries()) {
    const token = `0x${String(i).padStart(40, "0")}`
    await createSend(
      api(),
      s.opts,
    )(row({ token, card: { type: "card", card: { ...card, token, imageUrl }, image: true } }))
  }
  expect(s.fetchFn).toHaveBeenCalledTimes(3)
  for (const [url] of s.fetchFn.mock.calls as unknown as [string][]) {
    expect(url.startsWith("https://wsrv.nl/?url=")).toBe(true)
    expect(new URL(url).hostname).toBe("wsrv.nl")
  }
})

it("sends text with the preview disabled and does not fetch again for an hour after a failed fetch", async () => {
  const a = api()
  const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => imageResponse({ status: 404 }))
  const s = setup({}, fetchFn)
  expect(await createSend(a, s.opts)(row())).toEqual({ ok: true })
  expect(a.sendPhoto).not.toHaveBeenCalled()
  expect(textCall(a)[2]).toMatchObject({
    parse_mode: "HTML",
    message_thread_id: 7,
    link_preview_options: { is_disabled: true },
  })
  s.advance(59 * 60 * 1000)
  await createSend(a, s.opts)(row())
  expect(fetchFn).toHaveBeenCalledOnce()
  expect(a.sendMessage).toHaveBeenCalledTimes(2)
  s.advance(2 * 60 * 1000)
  await createSend(a, s.opts)(row())
  expect(fetchFn).toHaveBeenCalledTimes(2)
})

it("falls back to text when the fetch throws", async () => {
  const a = api()
  const s = setup(
    {},
    vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
  )
  expect(await createSend(a, s.opts)(row())).toEqual({ ok: true })
  expect(a.sendMessage).toHaveBeenCalledOnce()
})

it("deletes a cached file_id Telegram rejects and sends the alert as text", async () => {
  const a = api()
  a.sendPhoto.mockRejectedValueOnce(
    tgError("Bad Request: wrong file identifier/HTTP URL specified"),
  )
  const s = setup({ [card.token]: "STALE" })
  expect(await createSend(a, s.opts)(row())).toEqual({ ok: true })
  expect(s.rows.has(card.token)).toBe(false)
  expect(a.sendMessage).toHaveBeenCalledOnce()
  // The next alert re-uploads and stores a fresh id.
  await createSend(a, s.opts)(row())
  expect(s.fetchFn).toHaveBeenCalledOnce()
  expect(s.rows.get(card.token)).toBe("BIG")
})

it("falls back to text on a media error after uploading, and stores nothing", async () => {
  const a = api()
  a.sendPhoto.mockRejectedValueOnce(media)
  const s = setup()
  expect(await createSend(a, s.opts)(row())).toEqual({ ok: true })
  expect(a.sendMessage).toHaveBeenCalledOnce()
  expect(s.rows.size).toBe(0)
})

it("falls back to text, keeping the cached id, when the chat allows text but not photos", async () => {
  const a = api()
  a.sendPhoto.mockRejectedValueOnce(
    tgError("Bad Request: not enough rights to send photos to the chat"),
  )
  const s = setup({ [card.token]: "CACHED" })
  expect(await createSend(a, s.opts)(row())).toEqual({ ok: true })
  expect(a.sendMessage).toHaveBeenCalledOnce()
  expect(s.rows.get(card.token)).toBe("CACHED")
})

it("reports other photo failures instead of sending text", async () => {
  const a = api()
  a.sendPhoto.mockRejectedValueOnce(tgError("Forbidden: bot was blocked by the user"))
  expect(await createSend(a, setup().opts)(row())).toMatchObject({ ok: false, kind: "blocked" })
  expect(a.sendMessage).not.toHaveBeenCalled()
})

it("still reports success when the cache write fails after the photo went out", async () => {
  const a = api()
  const s = setup()
  vi.mocked(s.cache.put).mockRejectedValueOnce(new Error("db down"))
  expect(await createSend(a, s.opts)(row())).toEqual({ ok: true })
})

it("sends text when the caption would pass 1,024 characters", async () => {
  const a = api()
  const s = setup({ [card.token]: "CACHED" })
  const long = { ...card, rows: [["note", "x".repeat(1100)]] as Card["rows"] }
  expect(
    await createSend(a, s.opts)(row({ card: { type: "card", card: long, image: true } })),
  ).toEqual({ ok: true })
  expect(a.sendPhoto).not.toHaveBeenCalled()
  expect(a.sendMessage).toHaveBeenCalledOnce()
  expect(s.fetchFn).not.toHaveBeenCalled()
})

it.each([
  ["the alert's image setting is off", { image: false, imageUrl: card.imageUrl }],
  ["the token has no image", { image: true, imageUrl: null }],
  ["the image is not https", { image: true, imageUrl: "http://ipfs.io/x.jpg" }],
])("sends text with the preview disabled when %s", async (_n, o) => {
  const a = api()
  const s = setup({ [card.token]: "CACHED" })
  const c = { ...card, imageUrl: o.imageUrl }
  await createSend(a, s.opts)(row({ card: { type: "card", card: c, image: o.image } }))
  expect(a.sendPhoto).not.toHaveBeenCalled()
  expect(s.cache.get).not.toHaveBeenCalled()
  expect(s.fetchFn).not.toHaveBeenCalled()
  expect(textCall(a)[2]).toMatchObject({ link_preview_options: { is_disabled: true } })
})

it("sends text payloads with their buttons", async () => {
  const a = api()
  await createSend(
    a,
    setup().opts,
  )(
    row({
      chat_type: "private",
      thread_id: null,
      card: { type: "text", html: "hi", buttons: [[{ text: "My alerts", data: "al:u" }]] },
    }),
  )
  expect(textCall(a)[2]).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "My alerts", callback_data: "al:u" }]] },
    link_preview_options: { is_disabled: true },
  })
})

it("returns a classified failure instead of throwing", async () => {
  const a = api()
  a.sendMessage.mockRejectedValueOnce(
    tgError("Forbidden: bot was blocked by the user", "sendMessage"),
  )
  const r = row({ card: { type: "card", card, image: false } })
  expect(await createSend(a, setup().opts)(r)).toMatchObject({ ok: false, kind: "blocked" })
})

it("sends a NEW TOKENS card as text, rendered with the bot username, without a preview or photo", async () => {
  const a = api()
  const payload = {
    type: "newtokens" as const,
    launchpad: "InkyPump",
    entries: [{ token: card.token, name: "Goblo", ticker: "GOBLO" }],
  }
  expect(await createSend(a, setup().opts)(row({ card: payload }))).toEqual({ ok: true })
  expect(a.sendPhoto).not.toHaveBeenCalled()
  const [chat, text, o] = textCall(a)
  expect(chat).toBe(-1001)
  expect(text).toBe(renderNewTokens(payload, "makoinkbot"))
  expect(o).toMatchObject({ parse_mode: "HTML", link_preview_options: { is_disabled: true } })
})

const nftCard = {
  alert: "minted",
  title: "MINTED 50%",
  name: "Ink Hornet",
  verified: false,
  marketplace: "OpenSea",
  rows: [["minted", "1,111 / 2,222 in 4h 2m"]],
  contract: "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b",
  extra: [],
  tokenId: null,
  slug: "ink-hornet",
  imageUrl: "https://i.example/c.png",
  imageKey: "nft:0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b",
  links: [],
} as const
const nftRow = (over: Partial<PendingRow> = {}): PendingRow =>
  row({
    alert: "minted",
    token: nftCard.contract,
    card: {
      type: "nftalert",
      card: { ...nftCard, rows: [...nftCard.rows.map((r) => [...r])] } as never,
      image: true,
    },
    ...over,
  })

it("nftalert uses the nft image key and the NFT keyboard", async () => {
  const a = api()
  const s = setup({ [nftCard.imageKey]: "NFTFILE" })
  expect(await createSend(a, s.opts)(nftRow())).toEqual({ ok: true })
  const [, photo, o] = photoCall(a)
  expect(photo).toBe("NFTFILE")
  expect(o.caption).toContain("<b>MINTED 50%</b>")
  expect(JSON.stringify(o.reply_markup)).toContain(
    `https://go.makobot.xyz/n/c/ink-hornet?d=${nftRow().id}`,
  )
  expect(s.fetchFn).not.toHaveBeenCalled()
})

it("nftalert uploads the padded image once and stores it under the nft key", async () => {
  const a = api()
  const s = setup()
  await createSend(a, s.opts)(nftRow())
  expect(s.rows.get(nftCard.imageKey)).toBe("BIG")
})

it("an nftalert with the image switch off goes as text", async () => {
  const a = api()
  const s = setup()
  const r = nftRow()
  await createSend(
    a,
    s.opts,
  )({ ...r, card: { ...(r.card as { type: "nftalert" }), image: false } as never })
  expect(a.sendPhoto).not.toHaveBeenCalled()
  expect(textCall(a)[1]).toContain("<b>MINTED 50%</b>")
})

it("an nftalert caption over 1,024 characters goes as text", async () => {
  const a = api()
  const s = setup({ [nftCard.imageKey]: "NFTFILE" })
  const r = nftRow()
  const long = { ...(r.card as { card: object }).card, rows: [["minted", "x".repeat(1100)]] }
  await createSend(
    a,
    s.opts,
  )({ ...r, card: { type: "nftalert", card: long, image: true } as never })
  expect(a.sendPhoto).not.toHaveBeenCalled()
  expect(a.sendMessage).toHaveBeenCalledTimes(1)
})

it("opens a DM alert with the buttons in the state the user already set", async () => {
  const a = api()
  const s = setup({ [card.token]: "CACHED" })
  const viewer = {
    token: vi.fn(async () => ({ watching: true, muted: false })),
    nft: vi.fn(async () => ({ watching: false, muted: false, reminded: false })),
  }
  await createSend(a, { ...s.opts, viewer })(row({ chat_id: "100", chat_type: "private" }))
  expect(viewer.token).toHaveBeenCalledWith(100, card.token)
  expect(photoCall(a)[2]!.reply_markup).toMatchObject({
    inline_keyboard: [
      [
        { text: "Trade" },
        { text: "Watching", callback_data: `w:${card.token}`, style: "success" },
        { text: "Mute", callback_data: `m:${card.token}` },
      ],
    ],
  })
})

it("sends the alert with inactive buttons when the state lookup fails, and never asks for a group", async () => {
  const a = api()
  const s = setup({ [card.token]: "CACHED" })
  const viewer = {
    token: vi.fn(async () => {
      throw new Error("db down")
    }),
    nft: vi.fn(),
  }
  expect(
    await createSend(a, { ...s.opts, viewer })(row({ chat_id: "100", chat_type: "private" })),
  ).toEqual({ ok: true })
  expect(photoCall(a)[2]!.reply_markup).toMatchObject({
    inline_keyboard: [[{ text: "Trade" }, { text: "Watch" }, { text: "Mute" }]],
  })
  await createSend(a, { ...s.opts, viewer })(row())
  expect(viewer.token).toHaveBeenCalledTimes(1)
})
