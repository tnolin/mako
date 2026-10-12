import * as Sentry from "@sentry/node"
import { GrammyError } from "grammy"

const NAMED = new Set(["user", "chat", "from", "chat_id", "user_id"])
const KEYISH = /user|chat|from/i
const NUMERIC = /^-?\d+$/

/** Drops user and chat identifiers at any depth. Other numbers (blocks, ids, amounts) stay. */
export function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (NAMED.has(k)) continue
      if (
        KEYISH.test(k) &&
        (typeof x === "number" ||
          typeof x === "bigint" ||
          (typeof x === "string" && NUMERIC.test(x)))
      )
        continue
      out[k] = scrub(x)
    }
    return out
  }
  return v
}

type Scrubbable = {
  user?: unknown
  extra?: unknown
  contexts?: unknown
  tags?: unknown
  breadcrumbs?: { data?: unknown }[]
}

export function scrubEvent<T extends Scrubbable>(e: T): T {
  delete e.user
  if (e.extra) e.extra = scrub(e.extra)
  if (e.contexts) e.contexts = scrub(e.contexts)
  if (e.tags) e.tags = scrub(e.tags)
  if (e.breadcrumbs) e.breadcrumbs = e.breadcrumbs.map((b) => ({ ...b, data: scrub(b.data) }))
  return e
}

/** Telegram errors carry the request payload (chat id, message text); report only method, code and description. */
export function plainError(err: unknown): unknown {
  return err instanceof GrammyError
    ? new Error(`${err.method}: ${err.error_code} ${err.description}`)
    : err
}

export type Reporter = {
  capture(err: unknown, extra?: Record<string, unknown>): void
  message(msg: string): void
  checkIn(status: "ok" | "error"): void
  flush(ms: number): Promise<boolean>
}

export const noopReporter: Reporter = {
  capture() {},
  message() {},
  checkIn() {},
  flush: async () => true,
}

type Sdk = Pick<
  typeof Sentry,
  "init" | "captureException" | "captureMessage" | "captureCheckIn" | "flush"
>

export function initSentry(env: Record<string, string | undefined>, sdk: Sdk = Sentry): Reporter {
  if (!env.SENTRY_DSN) return noopReporter
  sdk.init({
    dsn: env.SENTRY_DSN,
    release: env.SENTRY_RELEASE || undefined,
    environment: "production",
    // Collects no user info, cookies, headers, query params or request bodies.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      urlQueryParams: false,
      httpBodies: [],
    },
    beforeSend: (e) => scrubEvent(e),
    beforeBreadcrumb: (b) => ({ ...b, data: scrub(b.data) as Record<string, unknown> | undefined }),
  })
  return {
    capture: (err, extra) =>
      void sdk.captureException(
        plainError(err),
        extra ? { extra: scrub(extra) as Record<string, unknown> } : undefined,
      ),
    message: (msg) => void sdk.captureMessage(msg),
    checkIn: (status) =>
      void sdk.captureCheckIn(
        { monitorSlug: "ink-pipeline", status },
        {
          schedule: { type: "interval", value: 1, unit: "minute" },
          checkinMargin: 2,
          maxRuntime: 1,
        },
      ),
    flush: (ms) => sdk.flush(ms),
  }
}
