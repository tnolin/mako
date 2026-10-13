import { afterAll, beforeAll, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { createImages, sqlImageCache } from "../src/platforms/telegram/images"
import { resetDb } from "./helpers/db"
import { imageResponse, memoryCache, photoResult } from "./helpers/images"

const URL_ = "https://ipfs.io/ipfs/x"
const msg = {
  chat: 1,
  token: "0xaa",
  imageUrl: URL_,
  html: "hi",
  reply_markup: { inline_keyboard: [] },
}
const api = () => ({
  sendMessage: vi.fn(async () => ({}) as never),
  sendPhoto: vi.fn(async () => photoResult() as never),
})

async function sendWith(res: () => Response | Promise<Response>) {
  const a = api()
  const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => res())
  const images = createImages({ fetch: fetchFn, cache: memoryCache().cache, log: () => {} })
  await images.send(a, msg)
  return a
}

it("uploads a good image", async () => {
  const a = await sendWith(() => imageResponse())
  expect(a.sendPhoto).toHaveBeenCalledOnce()
  expect(a.sendMessage).not.toHaveBeenCalled()
})

it.each([
  ["a non-200 status", () => imageResponse({ status: 503 })],
  [
    "a redirect",
    () => imageResponse({ status: 302, headers: { location: "https://evil.example/" } }),
  ],
  ["a non-image content type", () => imageResponse({ type: "text/html" })],
  [
    "a declared size over 5 MB",
    () => imageResponse({ headers: { "content-length": String(5 * 1024 * 1024 + 1) } }),
  ],
  ["a streamed body over 5 MB", () => imageResponse({ body: new Uint8Array(5 * 1024 * 1024 + 1) })],
  ["an empty body", () => imageResponse({ body: new Uint8Array() })],
  ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
  ["a timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
])("sends text when wsrv.nl answers with %s", async (_n, res) => {
  const a = await sendWith(res)
  expect(a.sendPhoto).not.toHaveBeenCalled()
  expect(a.sendMessage).toHaveBeenCalledOnce()
})

it("accepts a body of exactly 5 MB", async () => {
  const a = await sendWith(() => imageResponse({ body: new Uint8Array(5 * 1024 * 1024) }))
  expect(a.sendPhoto).toHaveBeenCalledOnce()
})

it("uploads the fetched bytes under image.jpg", async () => {
  const a = await sendWith(() => imageResponse())
  const file = (a.sendPhoto.mock.calls[0] as unknown as [number, { filename?: string }])[1]
  expect(file.filename).toBe("image.jpg")
})

let sql: Sql
beforeAll(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterAll(() => sql.end())

it("keeps the first file_id per token in bot.token_images and forgets on request", async () => {
  const cache = sqlImageCache(sql)
  expect(await cache.get("0xaa")).toBeNull()
  await cache.put("0xaa", "F1")
  await cache.put("0xaa", "F2")
  expect(await cache.get("0xaa")).toBe("F1")
  await cache.forget("0xaa")
  expect(await cache.get("0xaa")).toBeNull()
})
