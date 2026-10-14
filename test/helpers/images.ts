import { vi } from "vitest"
import { createImages, type ImageCache } from "../../src/platforms/telegram/images"

export function memoryCache(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial))
  const cache: ImageCache = {
    get: vi.fn(async (t: string) => rows.get(t) ?? null),
    put: vi.fn(async (t: string, f: string) => {
      if (!rows.has(t)) rows.set(t, f)
    }),
    forget: vi.fn(async (t: string) => {
      rows.delete(t)
    }),
  }
  return { rows, cache }
}

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

/** A wsrv.nl answer: 200 with an image body unless overridden. */
export const imageResponse = (
  o: {
    status?: number
    type?: string
    body?: Uint8Array<ArrayBuffer>
    headers?: Record<string, string>
  } = {},
) =>
  new Response(new Blob([o.body ?? JPEG]), {
    status: o.status ?? 200,
    headers: { "content-type": o.type ?? "image/jpeg", ...o.headers },
  })

export const okFetch = () => vi.fn(async (_url: unknown, _init?: unknown) => imageResponse())

/** What sendPhoto returns: sizes ascending, as Telegram does. */
export const photoResult = (largest = "BIG") => ({
  message_id: 1,
  photo: [
    { file_id: "small", width: 90, height: 90 },
    { file_id: largest, width: 640, height: 640 },
  ],
})

/** Real image logic over an in-memory cache and a fake wsrv.nl; no network. */
export function testImages(fetchFn: typeof fetch = okFetch() as unknown as typeof fetch) {
  const { rows, cache } = memoryCache()
  return { rows, fetchFn, images: createImages({ fetch: fetchFn, cache, log: () => {} }) }
}
