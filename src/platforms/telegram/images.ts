import { type Api, InputFile } from "grammy"
import type { InlineKeyboardMarkup } from "grammy/types"
import type { Sql } from "../../db"
import type { Logger } from "../../log"
import { classify } from "./errors"

/** Telegram's caption limit; longer cards go as text. */
const CAPTION_MAX = 1024
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

  /** Only the wsrv.nl URL is fetched: the creator's URL is attacker-controlled. Null on any failure. */
  async function fetchPadded(imageUrl: string): Promise<Uint8Array | null> {
    try {
      const res = await deps.fetch(paddedUrl(imageUrl), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "manual",
      })
      if (res.status !== 200 || !res.headers.get("content-type")?.startsWith("image/")) return null
      if (Number(res.headers.get("content-length")) > MAX_BYTES) return null
      const reader = res.body?.getReader()
      if (!reader) return null
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_BYTES) {
          await reader.cancel()
          return null
        }
        chunks.push(value)
      }
      return size > 0 ? Buffer.concat(chunks) : null
    } catch {
      return null
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

  /** True when the photo went out. A media or rights failure returns false so the caller sends text. */
  async function sendPhoto(api: Pick<Api, "sendPhoto">, m: CardMessage): Promise<boolean> {
    const opts = {
      parse_mode: "HTML" as const,
      message_thread_id: m.thread,
      caption: m.html,
      reply_markup: m.reply_markup,
    }
    const cached = await deps.cache.get(m.token)
    if (cached) {
      try {
        await api.sendPhoto(m.chat, cached, opts)
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
    if (recentlyFailed(m.token)) return false
    const bytes = await fetchPadded(m.imageUrl!)
    if (!bytes) {
      failedUntil.set(m.token, now() + FAILURE_MEMORY_MS)
      return false
    }
    try {
      const sent = await api.sendPhoto(m.chat, new InputFile(bytes, "image.jpg"), opts)
      await remember(m.token, sent.photo)
      return true
    } catch (err) {
      // A chat may allow text but not media, so rights falls back too; the text send decides.
      const kind = classify(err).kind
      if (kind !== "media" && kind !== "rights") throw err
      return false
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
