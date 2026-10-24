import { GrammyError, InputFile } from "grammy"
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { createImages, sqlImageCache } from "../src/platforms/telegram/images"
import { resetDb } from "./helpers/db"
import { imageResponse, memoryCache, okFetch, photoResult } from "./helpers/images"

const URL_ = "https://ipfs.io/ipfs/x"
const msg = {
  chat: 1,
  imageKey: "0xaa",
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
  const log = vi.fn()
  const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => res())
  const images = createImages({ fetch: fetchFn, cache: memoryCache().cache, log })
  await images.send(a, msg)
  return Object.assign(a, { log })
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
])(
  "sends text and logs one warning without the URL when wsrv.nl answers with %s",
  async (_n, res) => {
    const a = await sendWith(res)
    expect(a.sendPhoto).not.toHaveBeenCalled()
    expect(a.sendMessage).toHaveBeenCalledOnce()
    expect(a.log).toHaveBeenCalledOnce()
    const [level, , fields] = a.log.mock.calls[0]!
    expect(level).toBe("warn")
    expect(fields).toMatchObject({ token: "0xaa", reason: expect.any(String) })
    expect(JSON.stringify(a.log.mock.calls)).not.toMatch(/ipfs|wsrv|evil/)
  },
)

it.each([
  ["a non-200 status", () => imageResponse({ status: 503 }), "status 503"],
  ["a wrong type", () => imageResponse({ type: "text/html" }), "content-type text/html"],
  ["a timeout", () => Promise.reject(new DOMException("t", "TimeoutError")), "TimeoutError"],
  [
    "an oversize body",
    () => imageResponse({ body: new Uint8Array(5 * 1024 * 1024 + 1) }),
    "too large",
  ],
])("names the reason for %s in the warning", async (_n, res, reason) => {
  const a = await sendWith(res)
  expect((a.log.mock.calls[0]![2] as { reason: string }).reason).toContain(reason)
})

it("cancels the body of a rejected response without reading it", async () => {
  const cancel = vi.fn()
  const body = new ReadableStream({ cancel })
  await sendWith(() => new Response(body, { status: 404 }))
  expect(cancel).toHaveBeenCalled()
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

const deferred = <T>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const other = { ...msg, chat: 2 }

it("shares one fetch and one upload between concurrent first alerts for a token", async () => {
  const a = api()
  const gate = deferred<Response>()
  const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => gate.promise)
  const { cache, rows } = memoryCache()
  const images = createImages({ fetch: fetchFn, cache, log: () => {} })
  const sends = Array.from({ length: 5 }, (_, i) => images.send(a, { ...msg, chat: i + 1 }))
  await new Promise((r) => setTimeout(r, 10))
  gate.resolve(imageResponse())
  await Promise.all(sends)
  expect(fetchFn).toHaveBeenCalledOnce()
  const photos = a.sendPhoto.mock.calls as unknown as [number, unknown][]
  expect(photos).toHaveLength(5)
  expect(photos.filter(([, p]) => typeof p !== "string")).toHaveLength(1)
  expect(photos.filter(([, p]) => p === "BIG")).toHaveLength(4)
  expect(rows.get("0xaa")).toBe("BIG")
  expect(a.sendMessage).not.toHaveBeenCalled()
})

it("sends text when the image is slow, and the next send uploads the bytes that arrived later", async () => {
  const a = api()
  const gate = deferred<Response>()
  const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => gate.promise)
  const { cache, rows } = memoryCache()
  const images = createImages({ fetch: fetchFn, cache, log: () => {}, waitMs: 20 })
  await images.send(a, msg)
  expect(a.sendMessage).toHaveBeenCalledOnce()
  expect(a.sendPhoto).not.toHaveBeenCalled()
  // The fetch goes on after the first send gave up on it.
  gate.resolve(imageResponse())
  await new Promise((r) => setTimeout(r, 10))
  await images.send(a, other)
  expect(fetchFn).toHaveBeenCalledOnce()
  expect((a.sendPhoto.mock.calls[0] as unknown as [number, unknown])[1]).toBeInstanceOf(InputFile)
  expect(rows.get("0xaa")).toBe("BIG")
  await images.send(a, msg)
  expect((a.sendPhoto.mock.calls[1] as unknown as [number, unknown])[1]).toBe("BIG")
})

it("remembers an image that failed after the send stopped waiting, and does not fetch it again", async () => {
  const a = api()
  const gate = deferred<Response>()
  const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => gate.promise)
  const images = createImages({
    fetch: fetchFn,
    cache: memoryCache().cache,
    log: () => {},
    waitMs: 20,
  })
  await images.send(a, msg)
  gate.resolve(imageResponse({ status: 500 }))
  await new Promise((r) => setTimeout(r, 10))
  await images.send(a, other)
  expect(fetchFn).toHaveBeenCalledOnce()
  expect(a.sendPhoto).not.toHaveBeenCalled()
  expect(a.sendMessage).toHaveBeenCalledTimes(2)
})

it("lets a waiting alert upload the fetched bytes when the first chat rejected the photo", async () => {
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
  const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => imageResponse())
  const images = createImages({ fetch: fetchFn, cache: memoryCache().cache, log: () => {} })
  await Promise.all([images.send(a, msg), images.send(a, other)])
  expect(fetchFn).toHaveBeenCalledOnce()
  expect(a.sendPhoto).toHaveBeenCalledTimes(2)
  expect(a.sendMessage).toHaveBeenCalledOnce()
  expect((a.sendPhoto.mock.calls[1] as unknown as [number, unknown])[1]).toBeInstanceOf(InputFile)
})

it("sends all concurrent alerts as text after one failed fetch", async () => {
  const a = api()
  const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => imageResponse({ status: 500 }))
  const images = createImages({ fetch: fetchFn, cache: memoryCache().cache, log: () => {} })
  await Promise.all([
    images.send(a, msg),
    images.send(a, other),
    images.send(a, { ...msg, chat: 3 }),
  ])
  expect(fetchFn).toHaveBeenCalledOnce()
  expect(a.sendMessage).toHaveBeenCalledTimes(3)
})

it("clears the shared attempt when the first send throws, so a later alert can fetch again", async () => {
  const a = api()
  a.sendPhoto.mockRejectedValueOnce(
    new GrammyError(
      "x",
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
      "sendPhoto",
      {},
    ),
  )
  const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => imageResponse())
  const images = createImages({ fetch: fetchFn, cache: memoryCache().cache, log: () => {} })
  await expect(images.send(a, msg)).rejects.toThrow()
  await images.send(a, other)
  expect(fetchFn).toHaveBeenCalledTimes(2)
  expect(a.sendPhoto).toHaveBeenCalledTimes(2)
})

it("remembers a media rejection of a fresh upload for the hour, so the next alert does not refetch", async () => {
  const a = api()
  a.sendPhoto.mockRejectedValueOnce(
    new GrammyError(
      "x",
      { ok: false, error_code: 400, description: "Bad Request: IMAGE_PROCESS_FAILED" },
      "sendPhoto",
      {},
    ),
  )
  const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => imageResponse())
  const images = createImages({ fetch: fetchFn, cache: memoryCache().cache, log: () => {} })
  await images.send(a, msg)
  await images.send(a, other)
  expect(fetchFn).toHaveBeenCalledOnce()
  expect(a.sendPhoto).toHaveBeenCalledOnce()
  expect(a.sendMessage).toHaveBeenCalledTimes(2)
})

it("treats a cache read failure as a miss and logs a warning", async () => {
  const a = api()
  const log = vi.fn()
  const { cache } = memoryCache()
  vi.mocked(cache.get).mockRejectedValueOnce(new Error("db down"))
  const images = createImages({ fetch: okFetch(), cache, log })
  await images.send(a, msg)
  expect(a.sendPhoto).toHaveBeenCalledOnce()
  expect(log).toHaveBeenCalledWith("warn", "image cache read failed", expect.anything())
})
