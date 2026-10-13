import { GrammyError } from "grammy"
import { describe, expect, it, vi } from "vitest"
import { initSentry, noopReporter, plainError, scrub, scrubEvent } from "../src/sentry"

describe("scrubbers", () => {
  it("removes user and chat identifiers and keeps other numbers", () => {
    expect(
      scrub({
        chat_id: -1001,
        nested: {
          from: { id: 5 },
          userId: 42,
          chat: { id: 1 },
          chatType: "supergroup",
          blockNumber: "57889269",
          eventId: "991",
          amount: 5,
        },
        list: [{ user_id: "777", d: "uuid" }],
      }),
    ).toEqual({
      nested: { chatType: "supergroup", blockNumber: "57889269", eventId: "991", amount: 5 },
      list: [{ d: "uuid" }],
    })
  })

  it("scrubs a whole event, including breadcrumbs", () => {
    const e = scrubEvent({
      user: { id: "1" },
      extra: { user: 1, ok: true },
      tags: { chat: "-100", release: "v1" },
      breadcrumbs: [
        { category: "ui.click", data: { chat_id: 5, target: "/x" } },
        { category: "http", data: { url: "https://api.telegram.org/bot123:ABC/sendMessage" } },
      ],
    })
    expect(e).toEqual({
      extra: { ok: true },
      tags: { release: "v1" },
      breadcrumbs: [{ category: "ui.click", data: { target: "/x" } }],
    })
  })

  it("turns Telegram errors into plain errors without the request payload", () => {
    const err = new GrammyError(
      "x",
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
      "sendMessage",
      { chat_id: 12345, text: "private alert text" },
    )
    const p = plainError(err) as Error
    expect(p.message).toBe("sendMessage: 403 Forbidden: bot was blocked by the user")
    // JSON.stringify(Error) is "{}", so check the message and every own property directly.
    const own = Object.getOwnPropertyNames(p).map(
      (k) => (p as unknown as Record<string, unknown>)[k],
    )
    expect(JSON.stringify(own)).not.toContain("12345")
    expect(JSON.stringify(own)).not.toContain("private alert text")
    expect(p).not.toHaveProperty("payload")
  })
})

describe("initSentry", () => {
  const sdk = () => ({
    init: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    captureCheckIn: vi.fn(),
    flush: vi.fn(async () => true),
  })

  it("does nothing without a DSN", () => {
    expect(initSentry({}, sdk())).toBe(noopReporter)
  })

  it("initialises without PII and checks in to the ink-pipeline monitor", () => {
    const s = sdk()
    const r = initSentry(
      { SENTRY_DSN: "https://k@o1.ingest.sentry.io/1", SENTRY_RELEASE: "v0.1.0" },
      s,
    )
    const opts = s.init.mock.calls[0]![0]
    expect(opts).toMatchObject({
      release: "v0.1.0",
      environment: "production",
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        urlQueryParams: false,
        httpBodies: [],
      },
    })
    expect(opts.beforeSend({ user: { id: 1 }, extra: { chat_id: 2 } })).toEqual({ extra: {} })
    const crumb = (category: string, extra: Record<string, unknown>) =>
      opts.beforeBreadcrumb({ category, ...extra })
    expect(
      crumb("http", { data: { url: "https://api.telegram.org/bot123:ABC/sendMessage" } }),
    ).toBeNull()
    expect(crumb("fetch", { data: { url: "https://rpc.example/KEY123" } })).toBeNull()
    expect(crumb("console", { message: '{"msg":"notice","chatId":"-100123"}' })).toBeNull()
    expect(crumb("ui.click", { data: { chat_id: 5, ok: 1 } })).toEqual({
      category: "ui.click",
      data: { ok: 1 },
    })
    r.checkIn("error")
    expect(s.captureCheckIn).toHaveBeenCalledWith(
      { monitorSlug: "ink-pipeline", status: "error" },
      { schedule: { type: "interval", value: 1, unit: "minute" }, checkinMargin: 2, maxRuntime: 1 },
    )
  })
})
