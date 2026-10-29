import { type AddressInfo, connect } from "node:net"
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { TokenLaunchpads, tradeLink } from "../src/launchpads"
import { createLinkServer, logNftClick, logTradeClick } from "../src/links"
import { resetDb } from "./helpers/db"

const CA = "0x5ab27c4e9d1f03b8a6e2c5d7f940b1a8c3d6e3c8"
const D = "3f2b8a2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b"

describe("redirect by launchpad", () => {
  it("the redirect handler makes no SQL call", async () => {
    const launchpads = new TokenLaunchpads([[CA, "inkypump"]])
    const server = createLinkServer({
      target: (ca) => tradeLink(launchpads.get(ca) ?? "inkypump", ca, { INKYPUMP_REF_CODE: "M" }),
      join: () => "https://inkypump.com/ink",
      // The click log is the only database work, and it never holds up the response.
      onClick: () => new Promise(() => {}),
      log: () => {},
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    try {
      const port = (server.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/t/${CA}`, { redirect: "manual" })
      expect(res.status).toBe(302)
      expect(res.headers.get("location")).toBe(`https://inkypump.com/ink/trade/${CA}?ref=M`)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe("redirect server", () => {
  const clicks: [string | null, string | null][] = []
  const nftClicks: [string, string | null][] = []
  let base = ""
  const server = createLinkServer({
    target: (ca) => `https://inkypump.com/ink/trade/${ca}?ref=MAKO`,
    join: () => "https://inkypump.com/ink/join/MAKO",
    onClick: async (ca, d) => {
      clicks.push([ca, d])
      throw new Error("db stub: the request path must not depend on this")
    },
    onNftClick: async (target, d) => {
      nftClicks.push([target, d])
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

  it("302s /inkypump to the referral join link and logs it as a click with no token", async () => {
    clicks.length = 0
    const res = await get("/inkypump")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://inkypump.com/ink/join/MAKO")
    await vi.waitFor(() => expect(clicks).toEqual([[null, null]]))
  })

  it.each(["/inkypump/x", "/t/0x123", "/t/javascript:alert(1)", "/", "/t/", `/x/${CA}`])(
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

  it("302s /n/c/<slug> to the OpenSea collection page and logs the click", async () => {
    nftClicks.length = 0
    const res = await get(`/n/c/ink-hornet?d=${D}`)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://opensea.io/collection/ink-hornet")
    expect(res.headers.get("cache-control")).toBe("no-store")
    await vi.waitFor(() => expect(nftClicks).toEqual([["ink-hornet", D]]))
  })

  it("302s /n/i/<ca>/<id> to the OpenSea item page, lowercasing the contract", async () => {
    nftClicks.length = 0
    const res = await get(`/n/i/${CA.toUpperCase().replace("0X", "0x")}/1485`)
    expect(res.headers.get("location")).toBe(`https://opensea.io/item/ink/${CA}/1485`)
    await vi.waitFor(() => expect(nftClicks).toEqual([[CA, null]]))
  })

  it("302s /n/s/<slug> to the collection's sales activity", async () => {
    const res = await get("/n/s/ink-hornet")
    expect(res.headers.get("location")).toBe(
      "https://opensea.io/collection/ink-hornet/activity?activityTypes=sale",
    )
  })

  it("302s /n/a/<ca> to the collection by contract", async () => {
    const res = await get(`/n/a/${CA}`)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`https://explorer.inkonchain.com/token/${CA}`)
  })

  it("302s the platform links without logging them", async () => {
    nftClicks.length = 0
    expect((await get("/p/opensea")).headers.get("location")).toBe("https://opensea.io")
    expect((await get("/p/chimera")).headers.get("location")).toBe(
      "https://www.chimeras.ink/discover",
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(nftClicks).toEqual([])
  })

  it.each([
    "/n/c/",
    "/n/c/Bad_Slug",
    `/n/c/${"a".repeat(101)}`,
    "/n/c/ink-hornet/x",
    "/n/i/0x123/1",
    `/n/i/${CA}/abc`,
    `/n/i/${CA}/${"1".repeat(79)}`,
    `/n/i/${CA}`,
    "/n/a/0x123",
    "/n/x/ink-hornet",
    "/p/other",
  ])("404s %s", async (path) => {
    expect((await get(path)).status).toBe(404)
  })

  it("does not log NFT clicks from bot user agents", async () => {
    nftClicks.length = 0
    expect((await get("/n/c/ink-hornet", "TelegramBot (like TwitterBot)")).status).toBe(302)
    await new Promise((r) => setTimeout(r, 20))
    expect(nftClicks).toEqual([])
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
    await logTradeClick(sql, null, null)
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
      {
        chat_type: "private",
        chat_id: null,
        action: "trade_click",
        token: null,
        params: { d: null, kind: "join" },
      },
    ])
  })
})

describe("logNftClick", () => {
  let sql: Sql
  beforeAll(async () => {
    sql = await resetDb(inject("databaseUrl"))
  })
  afterAll(() => sql.end())

  it("records nft_click with the alert kind and chat type, and a chat id only for groups", async () => {
    const [g] = await sql<{ id: string }[]>`
      insert into bot.deliveries (chat_id, chat_type, alert, token, dedupe_key, priority, event_ts, card)
      values (-1001, 'supergroup', 'minted', ${CA}, 'k1', 3, now(), '{}') returning id::text`
    const [p] = await sql<{ id: string }[]>`
      insert into bot.deliveries (chat_id, chat_type, alert, token, dedupe_key, priority, event_ts, card)
      values (777, 'private', 'sale', ${CA}, 'k2', 5, now(), '{}') returning id::text`
    await logNftClick(sql, CA, g!.id)
    await logNftClick(sql, "ink-hornet", p!.id)
    await logNftClick(sql, CA, null)
    expect(
      await sql`select chat_type, chat_id::text, action, token, params from bot.user_actions order by id`,
    ).toEqual([
      {
        chat_type: "supergroup",
        chat_id: "-1001",
        action: "nft_click",
        token: CA,
        params: { d: g!.id, kind: "minted" },
      },
      {
        chat_type: "private",
        chat_id: null,
        action: "nft_click",
        token: "ink-hornet",
        params: { d: null, kind: "sale" },
      },
      {
        chat_type: "private",
        chat_id: null,
        action: "nft_click",
        token: CA,
        params: { d: null, kind: null },
      },
    ])
  })
})
