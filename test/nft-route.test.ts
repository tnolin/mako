import { afterAll, beforeEach, describe, expect, inject, it } from "vitest"
import type { Sql } from "../src/db"
import { type Audience, loadAudience, route } from "../src/delivery/recipients"
import type { NftAlertCard } from "../src/nft/card"
import type { Candidate } from "../src/rules/index"
import { type AlertKind, basicPreset, type Settings } from "../src/settings"
import { addChat, addUser } from "./helpers/bot"
import { resetDb } from "./helpers/db"
import { addr, T0 } from "./helpers/events"

const C = addr(0xc0)
const wei = (n: number) => BigInt(Math.round(n * 1e9)) * 10n ** 9n
let seq = 0

const nftCard = (alert: string): NftAlertCard =>
  ({
    alert,
    title: alert,
    name: "X",
    contract: C,
    rows: [],
    extra: [],
    links: [],
  }) as unknown as NftAlertCard
function cand(alert: AlertKind, o: Partial<Candidate> = {}): Candidate {
  const id = String(++seq)
  return {
    alert,
    eventId: id,
    target: C,
    dedupeKey: `${alert}:${id}`,
    priority: 3,
    eventTs: T0,
    card: nftCard(alert),
    feedEligible: true,
    ...o,
  }
}
const dm = (id: string, mod: (s: Settings) => void = () => {}) => {
  const settings = basicPreset("private")
  mod(settings)
  return { userId: id, chatId: `10${id}`, settings }
}
const grp = (chatId: string, mod: (s: Settings) => void = () => {}) => {
  const settings = basicPreset("supergroup")
  mod(settings)
  return { chatId, chatType: "supergroup" as const, settings }
}
function audience(o: Partial<Audience> = {}): Audience {
  return {
    users: [],
    chats: [],
    watch: new Map(),
    mute: new Map(),
    lastPump: new Map(),
    watches: new Map(),
    nftMutes: new Map(),
    listingSent: new Map(),
    lastFloor: new Map(),
    ...o,
  }
}
const who = (ds: ReturnType<typeof route>) => ds.map((d) => `${d.chatId}:${d.alert}`).sort()
const watching = (users: string[] = [], chats: string[] = []) =>
  new Map([[C, { users: new Set(users), chats: new Set(chats) }]])

describe("NFT routing", () => {
  it("a watcher gets All collections alerts with the toggle off; the feed needs a passing collection", () => {
    const off = dm("1", (s) => {
      s.alerts.minted.on = false
    })
    const feed = dm("2")
    const aud = audience({ users: [off, feed], watches: watching(["1"]) })
    const c = cand("minted", { markBps: 5000, feedEligible: false })
    expect(who(route([c], aud))).toEqual(["101:minted"])
    const real = cand("minted", { markBps: 5000, feedEligible: true })
    expect(who(route([real], aud))).toEqual(["101:minted", "102:minted"])
  })

  it("keeps the watcher's thresholds: a mark the watcher did not choose does not reach it", () => {
    const aud = audience({ users: [dm("1")], watches: watching(["1"]) })
    expect(route([cand("minted", { markBps: 2500 })], aud)).toEqual([])
    expect(route([cand("minted", { markBps: 5000 })], aud)).toHaveLength(1)
  })

  it("Watched only alerts never reach a chat that does not watch the collection, even a real one", () => {
    const aud = audience({ users: [dm("1")], chats: [grp("-5")] })
    for (const [kind, extra] of [
      ["under", { discountBps: 2500 }],
      ["rare", { rankBps: 50 }],
      ["floor", { floorBps: 2500, floorDir: "down" as const }],
      ["sweep", { sweepItems: 7 }],
      ["sale", { salePriceWei: wei(1) }],
    ] as const) {
      expect(route([cand(kind, { ...extra, feedEligible: true })], aud), kind).toEqual([])
    }
  })

  it("Watched only alerts reach a watcher at its thresholds, and a toggle that is off blocks them", () => {
    const u = dm("1", (s) => {
      s.alerts.sale.on = true
      s.alerts.sweep.on = false
    })
    const aud = audience({ users: [u], watches: watching(["1"]) })
    expect(who(route([cand("under", { discountBps: 2000 })], aud))).toEqual(["101:under"])
    expect(route([cand("under", { discountBps: 1999 })], aud)).toEqual([])
    expect(route([cand("rare", { rankBps: 1000 })], aud)).toHaveLength(1)
    expect(route([cand("rare", { rankBps: 1001 })], aud)).toEqual([])
    expect(route([cand("floor", { floorBps: 2000, floorDir: "up" })], aud)).toHaveLength(1)
    expect(route([cand("floor", { floorBps: 1999, floorDir: "up" })], aud)).toEqual([])
    expect(route([cand("sweep", { sweepItems: 9 })], aud)).toEqual([])
  })

  it("SOLD uses the one global minimum, and is off by default", () => {
    const on = dm("1", (s) => {
      s.alerts.sale.on = true
    })
    const aud = audience({ users: [on, dm("2")], watches: watching(["1", "2"]) })
    expect(route([cand("sale", { salePriceWei: wei(0.049) })], aud)).toEqual([])
    expect(who(route([cand("sale", { salePriceWei: wei(0.05) })], aud))).toEqual(["101:sale"])
    on.settings.alerts.sale.minWei = "0"
    expect(route([cand("sale", { salePriceWei: 1n })], aud)).toHaveLength(1)
  })

  it("BIG SALE follows the chat's own minimum, for the feed and for watchers", () => {
    const low = dm("1", (s) => {
      s.alerts.bigsale.minWei = String(wei(0.05))
    })
    const aud = audience({ users: [low, dm("2")], watches: watching(["2"]) })
    expect(who(route([cand("bigsale", { salePriceWei: wei(0.06) })], aud))).toEqual(["101:bigsale"])
    expect(who(route([cand("bigsale", { salePriceWei: wei(0.1) })], aud))).toEqual([
      "101:bigsale",
      "102:bigsale",
    ])
  })

  it("BIG SALE beats SOLD for a watcher that qualifies for both", () => {
    const u = dm("1", (s) => {
      s.alerts.sale.on = true
    })
    const aud = audience({ users: [u], watches: watching(["1"]) })
    const sale = cand("sale", { eventId: "9", salePriceWei: wei(0.2), priority: 5 })
    const big = cand("bigsale", { eventId: "9", salePriceWei: wei(0.2), priority: 3 })
    expect(who(route([sale, big], aud))).toEqual(["101:bigsale"])
    const small = cand("bigsale", { eventId: "9", salePriceWei: wei(0.2), priority: 3 })
    u.settings.alerts.bigsale.minWei = String(wei(0.5))
    expect(who(route([sale, small], aud))).toEqual(["101:sale"])
  })

  it("RARE beats UNDER FLOOR for a chat that accepts both, and UNDER FLOOR serves a chat whose rare threshold rejects", () => {
    const strict = dm("2", (s) => {
      s.alerts.rare.topBps = 100
    })
    const aud = audience({ users: [dm("1"), strict], watches: watching(["1", "2"]) })
    const rare = cand("rare", { eventId: "7", rankBps: 500, priority: 2, dedupeKey: "list:k" })
    const under = cand("under", {
      eventId: "7",
      discountBps: 2500,
      priority: 3,
      dedupeKey: "list:k",
    })
    expect(who(route([rare, under], aud))).toEqual(["101:rare", "102:under"])
  })

  it("a muted collection gets nothing, watched or not", () => {
    const aud = audience({
      users: [dm("1"), dm("2")],
      chats: [
        grp("-5", (s) => {
          s.alerts.minted.on = true
        }),
      ],
      watches: watching(["1"], ["-5"]),
      nftMutes: new Map([[C, { users: new Set(["1", "2"]), chats: new Set(["-5"]) }]]),
    })
    expect(route([cand("minted", { markBps: 5000 }), cand("soldout")], aud)).toEqual([])
  })

  it("a group watches and receives at the group's thresholds, with the group's topic", () => {
    const g = grp("-5", (s) => {
      s.alerts.under.pctBps = 3000
      s.routes = { under: 77 }
      s.thread = 5
    })
    const aud = audience({ chats: [g], watches: watching([], ["-5"]) })
    expect(route([cand("under", { discountBps: 2500 })], aud)).toEqual([])
    const [d] = route([cand("under", { discountBps: 3000 })], aud)
    expect(d).toMatchObject({
      chatId: "-5",
      chatType: "supergroup",
      threadId: 77,
      alert: "under",
      token: C,
    })
    expect(d!.payload.type).toBe("nftalert")
    const feed = audience({ chats: [grp("-5")] })
    expect(route([cand("soldout")], feed)).toEqual([])
    const on = grp("-5", (s) => {
      s.alerts.soldout.on = true
    })
    expect(route([cand("soldout")], audience({ chats: [on] }))).toHaveLength(1)
    on.settings.pausedRoutes = ["soldout"]
    expect(route([cand("soldout")], audience({ chats: [on] }))).toEqual([])
  })

  it("a watcher with the feed on gets one delivery per event", () => {
    const aud = audience({ users: [dm("1")], watches: watching(["1"]) })
    expect(route([cand("soldout")], aud)).toHaveLength(1)
  })

  it("carries the image setting per kind", () => {
    const u = dm("1", (s) => {
      s.alerts.soldout.image = false
    })
    const aud = audience({ users: [u] })
    const [d] = route([cand("soldout")], aud)
    expect(d!.payload).toMatchObject({ type: "nftalert", image: false })
  })

  it("does not route MINT REMINDER (the scheduler does)", () => {
    const aud = audience({ users: [dm("1")], watches: watching(["1"]) })
    expect(route([cand("reminder")], aud)).toEqual([])
  })

  it("does not mix token and NFT state: a token mute does not mute a collection", () => {
    const aud = audience({ users: [dm("1")], mute: new Map([[C, new Set(["1"])]]) })
    expect(route([cand("soldout")], aud)).toHaveLength(1)
  })

  it("skips the 4th UNDER FLOOR or RARE alert for a collection in an hour, counting the batch", () => {
    const aud = audience({ users: [dm("1")], watches: watching(["1"]) })
    const batch = [1, 2, 3, 4].map((i) =>
      cand(i % 2 ? "under" : "rare", { discountBps: 2500, rankBps: 50, eventTs: T0 + i * 60 }),
    )
    expect(route(batch, aud)).toHaveLength(3)
    // Earlier rows in the hour count; a candidate's own earlier row does not.
    const earlier = audience({
      users: [dm("1")],
      watches: watching(["1"]),
      listingSent: new Map([
        [`101:${C}`, [1, 2, 3].map((i) => ({ ts: T0 - i * 600, key: `k${i}` }))],
      ]),
    })
    expect(route([cand("under", { discountBps: 2500, dedupeKey: "new" })], earlier)).toEqual([])
    expect(route([cand("under", { discountBps: 2500, dedupeKey: "k2" })], earlier)).toHaveLength(1)
    const old = audience({
      users: [dm("1")],
      watches: watching(["1"]),
      listingSent: new Map([
        [`101:${C}`, [1, 2, 3].map((i) => ({ ts: T0 - 3600 - i, key: `k${i}` }))],
      ]),
    })
    expect(route([cand("under", { discountBps: 2500 })], old)).toHaveLength(1)
    // Another collection has its own cap.
    const other = cand("under", { discountBps: 2500, target: addr(0xc9) })
    expect(route([other], earlier)).toBeDefined()
  })

  it("holds back a FLOOR alert for 6 hours per collection and direction", () => {
    const sent = (dir: string, ago: number) =>
      new Map([[`101:${C}:${dir}`, [{ ts: T0 - ago, key: "old" }]]])
    const base = { users: [dm("1")], watches: watching(["1"]) }
    const down = (key = "n") => cand("floor", { floorBps: 2500, floorDir: "down", dedupeKey: key })
    expect(route([down()], audience({ ...base, lastFloor: sent("down", 5 * 3600) }))).toEqual([])
    expect(
      route([down()], audience({ ...base, lastFloor: sent("down", 6 * 3600 + 1) })),
    ).toHaveLength(1)
    expect(route([down()], audience({ ...base, lastFloor: sent("up", 3600) }))).toHaveLength(1)
    expect(route([down("old")], audience({ ...base, lastFloor: sent("down", 600) }))).toHaveLength(
      1,
    )
    // Two moves in one batch: the second is held back.
    const two = [down("a"), { ...down("b"), eventId: "x2", eventTs: T0 + 60 }]
    expect(route(two, audience(base))).toHaveLength(1)
  })
})

describe("loadAudience for NFTs", () => {
  let sql: Sql
  beforeEach(async () => {
    await sql?.end()
    sql = await resetDb(inject("databaseUrl"))
  })
  afterAll(() => sql.end())

  it("loads watches, mutes, the listing cap and the floor cooldown for the batch's contracts", async () => {
    const u1 = await addUser(sql, 101)
    const u2 = await addUser(sql, 102)
    await addChat(sql, -5, "supergroup")
    await sql`insert into bot.nft_watches (user_id, chat_id, contract) values
      (${u1}, null, ${C}), (null, -5, ${C}), (${u1}, null, ${addr(0xc9)})`
    await sql`insert into bot.collection_mutes (user_id, chat_id, contract) values (${u2}, null, ${C})`
    const row = (chat: number, alert: string, key: string, agoS: number) =>
      sql`insert into bot.deliveries (chat_id, chat_type, alert, token, dedupe_key, priority, event_ts, card, status)
        values (${chat}, 'supergroup', ${alert}, ${C}, ${key}, 3, to_timestamp(${T0 - agoS}), '{}', 'sent')`
    await row(-5, "under", "list:a", 100)
    await row(-5, "rare", "list:b", 200)
    await row(-5, "under", "list:old", 9 * 3600)
    await row(-5, "floor", `floor:${C}:down:1`, 3600)
    const aud = await loadAudience(sql, [C], T0)
    expect(aud.watches.get(C)).toEqual({ users: new Set([u1]), chats: new Set(["-5"]) })
    expect(aud.watches.has(addr(0xc9))).toBe(false)
    expect(aud.nftMutes.get(C)).toEqual({ users: new Set([u2]), chats: new Set() })
    expect(
      aud.listingSent
        .get(`-5:${C}`)
        ?.map((p) => p.key)
        .sort(),
    ).toEqual(["list:a", "list:b"])
    expect(aud.lastFloor.get(`-5:${C}:down`)).toEqual([{ ts: T0 - 3600, key: `floor:${C}:down:1` }])
  })
})
