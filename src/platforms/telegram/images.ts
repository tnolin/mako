import { type Api, InputFile } from "grammy"
import type { InlineKeyboardMarkup } from "grammy/types"
import type { Sql } from "../../db"
import type { Logger } from "../../log"
import { classify } from "./errors"

/** Telegram's caption limit; longer cards go as text. */
export const CAPTION_MAX = 1024
const FETCH_TIMEOUT_MS = 5000
const MAX_BYTES = 5 * 1024 * 1024
const FAILURE_MEMORY_MS = 60 * 60 * 1000

/** The file_id Telegram returned for each token's padded image. */
export type ImageCache = {
  get(token: string): Promise<string | null>
  put(token: string, fileId: string): Promise<void>
  forget(token: string): Promise<void>
}

export function sqlImageCache(sql: Sql): ImageCache {
  return {
    async get(token) {
      const [r] = await sql<{ file_id: string }[]>`
        select file_id from bot.token_images where token = ${token}`
      return r?.file_id ?? null
    },
    async put(token, fileId) {
      await sql`
        insert into bot.token_images (token, file_id) values (${token}, ${fileId})
        on conflict do nothing`
    },
    async forget(token) {
      await sql`delete from bot.token_images where token = ${token}`
    },
  }
}

export type CardMessage = {
  chat: number
  thread?: number
  token: string
  /** The creator-set image URL, or null when this card has no image. It is never fetched directly. */
  imageUrl: string | null
  html: string
  reply_markup: InlineKeyboardMarkup
}

export type Images = {
  /** Sends the card as a padded photo with the HTML as caption, or as text when there is no usable image. */
  send(api: Pick<Api, "sendMessage" | "sendPhoto">, m: CardMessage): Promise<void>
}

export type ImagesDeps = {
  fetch: typeof fetch
  cache: ImageCache
  log: Logger
  /** Milliseconds clock; tests move it. */
  now?: () => number
}

/** Square JPEG on the brand background, so every card has the same width whatever the creator uploaded. */
const paddedUrl = (imageUrl: string) =>
  `https://wsrv.nl/?url=${encodeURIComponent(imageUrl)}&w=640&h=640&fit=contain&cbg=1a2236&output=jpg`

export function createImages(deps: ImagesDeps): Images {
  const now = deps.now ?? Date.now
  // shortcut: failed tokens are remembered in this process for 1 hour; a restart forgets them and the
  // map grows by one entry per failing token. Upgrade path: a table with an expiry column.
  const failedUntil = new Map<string, number>()

  const recentlyFailed = (token: string): boolean => {
    const until = failedUntil.get(token)
    if (until === undefined) return false
    if (until > now()) return true
    failedUntil.delete(token)
    return false
  }

  const warnFailed = (token: string, reason: string) =>
    deps.log("warn", "image fetch failed", { token, reason })

  /** Only the wsrv.nl URL is fetched: the creator's URL is attacker-controlled. Null on any failure, logged without the URL. */
  async function fetchPadded(token: string, imageUrl: string): Promise<Uint8Array | null> {
    const fail = (reason: string) => {
      warnFailed(token, reason)
      return null
    }
    try {
      const res = await deps.fetch(paddedUrl(imageUrl), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "manual",
      })
      const type = res.headers.get("content-type")
      const reject = (reason: string) => {
        void res.body?.cancel().catch(() => {})
        return fail(reason)
      }
      if (res.status !== 200) return reject(`status ${res.status}`)
      if (!type?.startsWith("image/"))
        return reject(`content-type ${(type ?? "none").slice(0, 40)}`)
      if (Number(res.headers.get("content-length")) > MAX_BYTES) return reject("too large")
      const reader = res.body?.getReader()
      if (!reader) return fail("no body")
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_BYTES) {
          await reader.cancel()
          return fail("too large")
        }
        chunks.push(value)
      }
      return size > 0 ? Buffer.concat(chunks) : fail("empty body")
    } catch (err) {
      return fail(err instanceof Error ? err.name : "error")
    }
  }

  async function remember(
    token: string,
    photo: { file_id: string; width?: number; height?: number }[] | undefined,
  ) {
    if (!photo?.length) return
    const area = (p: { width?: number; height?: number }) => (p.width ?? 0) * (p.height ?? 0)
    const best = photo.reduce((a, b) => (area(b) >= area(a) ? b : a))
    // The alert is already sent; a failed cache write only costs one more upload.
    await deps.cache
      .put(token, best.file_id)
      .catch((err) => deps.log("warn", "image cache write failed", { error: String(err) }))
  }

  const photoOpts = (m: CardMessage) => ({
    parse_mode: "HTML" as const,
    message_thread_id: m.thread,
    caption: m.html,
    reply_markup: m.reply_markup,
  })

  /** Sends a stored file_id. A stale id is forgotten; media and rights failures return false (text). */
  async function sendCached(
    api: Pick<Api, "sendPhoto">,
    m: CardMessage,
    fileId: string,
  ): Promise<boolean> {
    try {
      await api.sendPhoto(m.chat, fileId, photoOpts(m))
      return true
    } catch (err) {
      const kind = classify(err).kind
      if (kind === "media") {
        // The stored id no longer works; the next alert uploads a fresh one.
        await deps.cache
          .forget(m.token)
          .catch((e) => deps.log("warn", "image cache delete failed", { error: String(e) }))
      } else if (kind !== "rights") throw err
      return false
    }
  }

  /** Uploads fetched bytes and stores the file_id. A media rejection is remembered like a failed fetch. */
  async function upload(
    api: Pick<Api, "sendPhoto">,
    m: CardMessage,
    bytes: Uint8Array,
  ): Promise<boolean> {
    try {
      const sent = await api.sendPhoto(m.chat, new InputFile(bytes, "image.jpg"), photoOpts(m))
      await remember(m.token, sent.photo)
      return true
    } catch (err) {
      // A chat may allow text but not media, so rights falls back too; the text send decides.
      const kind = classify(err).kind
      if (kind === "media") failedUntil.set(m.token, now() + FAILURE_MEMORY_MS)
      else if (kind !== "rights") throw err
      return false
    }
  }

  async function cachedId(token: string): Promise<string | null> {
    // A cache that cannot be read is a miss: the alert still goes out.
    return deps.cache.get(token).catch((err) => {
      deps.log("warn", "image cache read failed", { error: String(err) })
      return null
    })
  }

  // The sender delivers to several chats at once, so a token's first alert fans out. One fetch+upload per
  // token is in flight; the other sends wait for it, then use the stored file_id (or the bytes).
  const inFlight = new Map<string, Promise<Uint8Array | null>>()

  /** True when the photo went out. A media or rights failure returns false so the caller sends text. */
  async function sendPhoto(api: Pick<Api, "sendPhoto">, m: CardMessage): Promise<boolean> {
    const cached = await cachedId(m.token)
    if (cached) return sendCached(api, m, cached)
    const pending = inFlight.get(m.token)
    if (pending) {
      const bytes = await pending
      const stored = await cachedId(m.token)
      if (stored) return sendCached(api, m, stored)
      if (!bytes || recentlyFailed(m.token)) return false
      return upload(api, m, bytes)
    }
    if (recentlyFailed(m.token)) return false
    let fetched: Uint8Array | null = null
    let settle!: (b: Uint8Array | null) => void
    inFlight.set(
      m.token,
      new Promise((r) => {
        settle = r
      }),
    )
    try {
      fetched = await fetchPadded(m.token, m.imageUrl!)
      if (!fetched) {
        failedUntil.set(m.token, now() + FAILURE_MEMORY_MS)
        return false
      }
      return await upload(api, m, fetched)
    } finally {
      inFlight.delete(m.token)
      settle(fetched)
    }
  }

  return {
    async send(api, m) {
      if (m.imageUrl?.startsWith("https://") && m.html.length <= CAPTION_MAX) {
        if (await sendPhoto(api, m)) return
      }
      await api.sendMessage(m.chat, m.html, {
        parse_mode: "HTML",
        message_thread_id: m.thread,
        reply_markup: m.reply_markup,
        link_preview_options: { is_disabled: true },
      })
    },
  }
}
