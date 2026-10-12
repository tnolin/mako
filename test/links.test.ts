import { type AddressInfo, connect } from "node:net"
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { createLinkServer, logTradeClick } from "../src/links"
import { resetDb } from "./helpers/db"

const CA = "0x5ab27c4e9d1f03b8a6e2c5d7f940b1a8c3d6e3c8"
const D = "3f2b8a2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b"

describe("redirect server", () => {
  const clicks: [string, string | null][] = []
  let base = ""
  const server = createLinkServer({
    target: (ca) => `https://inkypump.com/ink/trade/${ca}?ref=MAKO`,
    onClick: async (ca, d) => {
      clicks.push([ca, d])
      throw new Error("db stub: the request path must not depend on this")
    },
    log: () => {},
  })
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  )
  const get = (path: string, ua = "Mozilla/5.0") =>
    fetch(`${base}${path}`, { redirect: "manual", headers: { "user-agent": ua } })

  it("302s to the launchpad with the referral code, lowercasing the address", async () => {
    const res = await get(`/t/${CA.toUpperCase().replace("0X", "0x")}?d=${D}`)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`https://inkypump.com/ink/trade/${CA}?ref=MAKO`)
    expect(res.headers.get("cache-control")).toBe("no-store")
    await vi.waitFor(() => expect(clicks).toContainEqual([CA, D]))
  })

  it("resolves a checksummed (mixed-case) address to the lowercase token", async () => {
    clicks.length = 0
    const mixed = `0x${[...CA.slice(2)].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join("")}`
    expect(mixed).not.toBe(CA)
    const res = await get(`/t/${mixed}`)
    expect(res.headers.get("location")).toBe(`https://inkypump.com/ink/trade/${CA}?ref=MAKO`)
    await vi.waitFor(() => expect(clicks).toEqual([[CA, null]]))
  })

  it.each(["/t/0x123", "/t/javascript:alert(1)", "/", "/t/", `/x/${CA}`])(
    "404s %s",
    async (path) => {
      expect((await get(path)).status).toBe(404)
    },
  )

  it("redirects but does not log bot user agents", async () => {
    clicks.length = 0
    const res = await get(`/t/${CA}`, "TelegramBot (like TwitterBot)")
    expect(res.status).toBe(302)
    await new Promise((r) => setTimeout(r, 20))
    expect(clicks).toEqual([])
  })

  it("answers 404 to a request target that is not a valid URL and keeps serving", async () => {
    const { port } = server.address() as AddressInfo
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () =>
        sock.write("GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
      )
      let out = ""
      sock.on("data", (b) => {
        out += b
      })
      sock.on("close", () => resolve(out))
      sock.on("error", reject)
    })
    expect(raw.startsWith("HTTP/1.1 404")).toBe(true)
    expect((await get(`/t/${CA}`)).status).toBe(302)
  })

  it("drops a d that is not a uuid", async () => {
    clicks.length = 0
    await get(`/t/${CA}?d=1%27%3Bdrop`)
    await vi.waitFor(() => expect(clicks).toEqual([[CA, null]]))
  })
})

describe("logTradeClick", () => {
  let sql: Sql
  beforeAll(async () => {
    sql = await resetDb(inject("databaseUrl"))
  })
  afterAll(() => sql.end())

  it("records the alert kind and chat type, with a chat id only for groups and channels", async () => {
    const [g] = await sql<{ id: string }[]>`
      insert into bot.deliveries (chat_id, chat_type, alert, token, dedupe_key, priority, event_ts, card)
      values (-1001, 'supergroup', 'bonding', ${CA}, 'k1', 2, now(), '{}') returning id::text`
    const [p] = await sql<{ id: string }[]>`
      insert into bot.deliveries (chat_id, chat_type, alert, token, dedupe_key, priority, event_ts, card)
      values (777, 'private', 'new', ${CA}, 'k2', 5, now(), '{}') returning id::text`
    await logTradeClick(sql, CA, g!.id)
    await logTradeClick(sql, CA, p!.id)
    await logTradeClick(sql, CA, null)
    const rows =
      await sql`select chat_type, chat_id::text, action, token, params from bot.user_actions order by id`
    expect(rows).toEqual([
      {
        chat_type: "supergroup",
        chat_id: "-1001",
        action: "trade_click",
        token: CA,
        params: { d: g!.id, kind: "bonding" },
      },
      {
        chat_type: "private",
        chat_id: null,
        action: "trade_click",
        token: CA,
        params: { d: null, kind: "new" },
      },
      {
        chat_type: "private",
        chat_id: null,
        action: "trade_click",
        token: CA,
        params: { d: null, kind: null },
      },
    ])
  })
})
