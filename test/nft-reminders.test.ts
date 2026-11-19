import type { NftDropStage } from "@ink-indexer/events"
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest"
import type { Sql } from "../src/db"
import type { NftAlertCard } from "../src/nft/card"
import { queueReminders, startReminders } from "../src/nft/reminders"
import { createNftState, type NftState } from "../src/nft/state"
import { muteCollection, remind, unremind, watch } from "../src/nft/watches"
import type { Prices } from "../src/prices"
import { NATIVE } from "../src/prices"
import { basicPreset } from "../src/settings"
import { addChat, addUser, listDeliveries } from "./helpers/bot"
import { resetDb } from "./helpers/db"
import { addr, nftCollection, nftDrop, nftMint } from "./helpers/events"
import { loadNftx } from "./helpers/fixtures"

const C = addr(0xc0)
const START = Date.UTC(2026, 8, 6, 13) / 1000
const stage = (label: string, o: Partial<NftDropStage> = {}): NftDropStage => ({
  type: "signed_presale",
  label,
  priceWei: String(25n * 10n ** 13n),
  startTime: START,
  endTime: null,
  maxPerWallet: 4,
  allowlistCount: 2152,
  ...o,
})
let sql: Sql
let state: NftState
beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  state = createNftState()
  state.apply({
    id: "1",
    p: nftCollection({ links: { twitter: "x", website: "https://w.example", discord: null } }),
  })
  state.apply({
    id: "2",
    p: nftDrop({ stages: [stage("Team", { allowlistCount: 3 }), stage("FCFS")] }),
  })
})
afterAll(() => sql.end())

const cards = async () => (await listDeliveries(sql)).filter((r) => r.alert === "reminder")
const ago15 = START - 15 * 60

describe("MINT REMINDER scheduler", () => {
  it("queues a reminder 15 minutes before a stage for a reminder user and a watcher, with the reminder rows", async () => {
    const a = await addUser(sql, 101)
    const b = await addUser(sql, 102)
    await remind(sql, a, C)
    await watch(sql, { userId: b }, C)
    state.apply({
      id: "3",
      p: nftMint({
        kind: "progress",
        markBps: 5000,
        stageIndex: 1,
        minted: "1104",
        maxSupply: "2222",
      }),
    })
    await queueReminders({ sql, nft: () => state, now: () => ago15 })
    const rows = await cards()
    expect(rows.map((r) => r.chat_id).sort()).toEqual(["101", "102"])
    const r = rows[0]!
    expect(r).toMatchObject({
      chat_type: "private",
      alert: "reminder",
      dedupe_key: `reminder:${C}:${START}`,
      priority: 2,
      status: "pending",
    })
    const p = r.card as unknown as {
      type: string
      image: boolean
      card: { title: string; rows: string[][]; links: unknown[]; contract: string }
    }
    expect(p.type).toBe("nftalert")
    expect(p.image).toBe(true)
    expect(p.card.title).toBe("MINT REMINDER · FCFS")
    expect(p.card.rows).toEqual([
      ["starts", "13:00 UTC (in 15m)"],
      ["price", "0.00025 ETH"],
      ["limit", "4 per wallet"],
      ["minted", "1,104 / 2,222 (49%)"],
    ])
    expect(p.card.links).toEqual([])
    expect(p.card.contract).toBe(C)
  })

  it("queues nothing for a collection that has sold out", async () => {
    const a = await addUser(sql, 101)
    await remind(sql, a, C)
    state.apply({ id: "3", p: nftMint({ kind: "sold_out", minted: "2222", maxSupply: "2222" }) })
    await queueReminders({ sql, nft: () => state, now: () => ago15 })
    expect(await cards()).toEqual([])
  })

  it("leaves minted out before the mint has started, and limit out when there is none", async () => {
    state.apply({ id: "3", p: nftDrop({ stages: [stage("FCFS", { maxPerWallet: null })] }) })
    await remind(sql, await addUser(sql, 101), C)
    await queueReminders({ sql, nft: () => state, now: () => ago15 })
    const p = (await cards())[0]!.card as unknown as { card: { rows: string[][] } }
    expect(p.card.rows.map((r) => r[0])).toEqual(["starts", "price"])
  })

  it("sends nothing for a Team stage", async () => {
    await remind(sql, await addUser(sql, 101), C)
    await queueReminders({ sql, nft: () => state, now: () => START - 15 * 60 })
    expect((await cards()).map((r) => r.dedupe_key)).toEqual([`reminder:${C}:${START}`])
    state.apply({ id: "3", p: nftDrop({ stages: [stage("Team", { allowlistCount: 3 })] }) })
    await sql`delete from bot.deliveries`
    await queueReminders({ sql, nft: () => state, now: () => START - 15 * 60 })
    expect(await cards()).toEqual([])
  })

  it("only fires from 14 to 16 minutes ahead", async () => {
    await remind(sql, await addUser(sql, 101), C)
    for (const min of [17, 13, 5]) {
      await queueReminders({ sql, nft: () => state, now: () => START - min * 60 })
      expect(await cards(), `${min}m`).toEqual([])
    }
    await queueReminders({ sql, nft: () => state, now: () => START - 16 * 60 })
    expect(await cards()).toHaveLength(1)
    await sql`delete from bot.deliveries`
    await queueReminders({ sql, nft: () => state, now: () => START - 14 * 60 })
    expect(await cards()).toHaveLength(1)
  })

  it("skips a muted user, a blocked user and groups", async () => {
    const muted = await addUser(sql, 101)
    const blocked = await addUser(sql, 102)
    await remind(sql, muted, C)
    await muteCollection(sql, { userId: muted }, C)
    await remind(sql, blocked, C)
    await sql`update bot.users set blocked_at = now() where id = ${blocked}`
    await addChat(sql, -1001, "supergroup")
    await watch(sql, { chatId: "-1001" }, C)
    await queueReminders({ sql, nft: () => state, now: () => ago15 })
    expect(await cards()).toEqual([])
  })

  it("gives a watcher reminders only while REMINDERS is on and the watch has reminders on", async () => {
    const off = basicPreset("private")
    off.alerts.reminder.on = false
    const a = await addUser(sql, 101, off)
    const b = await addUser(sql, 102)
    const c = await addUser(sql, 103)
    for (const u of [a, b, c]) await watch(sql, { userId: u }, C)
    await unremind(sql, c, C) // Reminder set removed on a watched collection: the watch stays, reminders stop.
    await queueReminders({ sql, nft: () => state, now: () => ago15 })
    expect((await cards()).map((r) => r.chat_id)).toEqual(["102"])
    // An explicit Remind me works with REMINDERS off and with reminders stopped on the watch.
    await remind(sql, a, C)
    await remind(sql, c, C)
    await queueReminders({ sql, nft: () => state, now: () => ago15 })
    expect((await cards()).map((r) => r.chat_id).sort()).toEqual(["101", "102", "103"])
    await sql`select 1 from bot.nft_watches where user_id = ${c} and not reminders_off`.then((r) =>
      expect(r).toHaveLength(1),
    )
  })

  it("does not double-send when the drop's stage list changes order in the same window", async () => {
    await remind(sql, await addUser(sql, 101), C)
    await queueReminders({ sql, nft: () => state, now: () => START - 15 * 60 })
    state.apply({
      id: "3",
      p: nftDrop({
        stages: [
          stage("Team", { allowlistCount: 3 }),
          stage("GTD", { startTime: START + 3600 }),
          stage("FCFS"),
        ],
      }),
    })
    await queueReminders({ sql, nft: () => state, now: () => START - 15 * 60 + 30 })
    expect(await cards()).toHaveLength(1)
  })

  it("does not double-send when a restart lands in the same window", async () => {
    await remind(sql, await addUser(sql, 101), C)
    await queueReminders({ sql, nft: () => state, now: () => START - 15 * 60 })
    await queueReminders({ sql, nft: () => state, now: () => START - 15 * 60 + 30 })
    await queueReminders({ sql, nft: () => state, now: () => START - 14 * 60 - 30 })
    expect(await cards()).toHaveLength(1)
  })

  it("does nothing while the NFT state is not loaded, and the scheduler starts and stops", async () => {
    await remind(sql, await addUser(sql, 101), C)
    await queueReminders({ sql, nft: () => undefined, now: () => ago15 })
    expect(await cards()).toEqual([])
    const stop = startReminders({
      sql,
      nft: () => state,
      now: () => ago15,
      log: () => {},
      everyMs: 20,
    })
    await new Promise((r) => setTimeout(r, 100))
    stop()
    expect(await cards()).toHaveLength(1)
  })
})

describe("AUCTION ENDING SOON scheduler", () => {
  const fx = loadNftx()
  const LD = fx.lilDudes.collection.contract
  const A = fx.inktrons
  const ENDS = A.created.endsAt
  const hourBefore = ENDS - 3600
  const prices: Prices = { usd: (q) => (q === NATIVE ? 2400 : null), symbol: () => "ETH" }
  const ending = async () =>
    (await listDeliveries(sql)).filter((r) => r.dedupe_key.endsWith(":ending"))
  let st: NftState
  beforeEach(() => {
    st = createNftState()
    st.apply({ id: "1", p: fx.lilDudes.collection })
    st.apply({ id: "2", p: A.live })
  })
  const queue = (now: number, p: Prices | null = prices) =>
    queueReminders({ sql, nft: () => st, now: () => now, prices: p ?? undefined })

  it("queues AUCTION ENDING SOON an hour before the end for a Remind me user and a watcher", async () => {
    const a = await addUser(sql, 101)
    const b = await addUser(sql, 102)
    await remind(sql, a, LD)
    await watch(sql, { userId: b }, LD)
    await queue(hourBefore)
    const rows = await ending()
    expect(rows.map((r) => r.chat_id).sort()).toEqual(["101", "102"])
    expect(rows[0]).toMatchObject({
      chat_type: "private",
      alert: "reminder",
      dedupe_key: `auction:${A.created.auction}:ending`,
      priority: 2,
      status: "pending",
    })
    const p = rows[0]!.card as unknown as { type: string; image: boolean; card: NftAlertCard }
    expect(p).toMatchObject({ type: "nftalert", image: true })
    expect(p.card).toMatchObject({
      title: "AUCTION ENDING SOON",
      marketplace: "NFTX",
      link: "nftx",
      links: [],
      contract: LD,
    })
    expect(p.card.remind).toBeUndefined()
    expect(p.card.rows).toEqual([
      ["ends", "13:00 UTC (in 1h)"],
      ["min bid", "0.0001 ETH ($0.24)"],
      ["bidders", "0"],
      ["raised", "0 ETH ($0.00)"],
    ])
  })

  it("shows ETH only without a fresh price", async () => {
    await remind(sql, await addUser(sql, 101), LD)
    await queue(hourBefore, { usd: () => null, symbol: () => "ETH" })
    const p = (await ending())[0]!.card as unknown as { card: NftAlertCard }
    expect(p.card.rows[1]).toEqual(["min bid", "0.0001 ETH"])
    await sql`delete from bot.deliveries`
    await queue(hourBefore, null)
    expect((await ending())[0]!.card).toMatchObject({
      card: {
        rows: [
          ["ends", expect.any(String)],
          ["min bid", "0.0001 ETH"],
          ["bidders", "0"],
          ["raised", "0 ETH"],
        ],
      },
    })
  })

  it("skips a muted user, a blocked user, groups and a user with REMINDERS off who only watches", async () => {
    const muted = await addUser(sql, 101)
    const blocked = await addUser(sql, 102)
    const off = basicPreset("private")
    off.alerts.reminder.on = false
    const quiet = await addUser(sql, 103, off)
    await remind(sql, muted, LD)
    await muteCollection(sql, { userId: muted }, LD)
    await remind(sql, blocked, LD)
    await sql`update bot.users set blocked_at = now() where id = ${blocked}`
    await watch(sql, { userId: quiet }, LD)
    await addChat(sql, -1001, "supergroup")
    await watch(sql, { chatId: "-1001" }, LD)
    await queue(hourBefore)
    expect(await ending()).toEqual([])
  })

  it("fires only from 59 to 61 minutes ahead", async () => {
    await remind(sql, await addUser(sql, 101), LD)
    for (const min of [62, 58, 30]) {
      await queue(ENDS - min * 60)
      expect(await ending(), `${min}m`).toEqual([])
    }
    await queue(ENDS - 61 * 60)
    expect(await ending()).toHaveLength(1)
    await sql`delete from bot.deliveries`
    await queue(ENDS - 59 * 60)
    expect(await ending()).toHaveLength(1)
  })

  it("sends once when the end moves inside the window", async () => {
    await remind(sql, await addUser(sql, 101), LD)
    await queue(hourBefore)
    st.apply({ id: "3", p: { ...A.live, endsAt: ENDS + 30, blockNumber: "999999999" } })
    await queue(hourBefore + 30)
    expect(await ending()).toHaveLength(1)
  })

  it("sends nothing once the auction ended, for a collection that is not real, or for an auction under 2 hours", async () => {
    await remind(sql, await addUser(sql, 101), LD)
    st.apply({ id: "3", p: A.ended })
    await queue(hourBefore)
    expect(await ending()).toEqual([])
    const unverified = createNftState()
    unverified.apply({ id: "1", p: { ...fx.lilDudes.collection, verdict: "pending" } as never })
    unverified.apply({ id: "2", p: A.live })
    st = unverified
    await queue(hourBefore)
    expect(await ending()).toEqual([])
    const short = createNftState()
    short.apply({ id: "1", p: fx.lilDudes.collection })
    short.apply({ id: "2", p: { ...A.live, startsAt: ENDS - 3600 - 600, endsAt: ENDS } })
    st = short
    await queue(hourBefore)
    expect(await ending()).toEqual([])
  })

  it("names a mint reminder for a collection NFTX trades without an OpenSea page as NFTX", async () => {
    const nftxOnly = createNftState()
    const slugless = { ...fx.lilDudes.collection, slug: null }
    nftxOnly.apply({ id: "1", p: slugless })
    nftxOnly.apply({ id: "2", p: nftDrop({ contract: LD, stages: [stage("FCFS")] }) })
    nftxOnly.apply({ id: "3", p: A.live })
    await remind(sql, await addUser(sql, 101), LD)
    await queueReminders({ sql, nft: () => nftxOnly, now: () => ago15, prices })
    const r = (await cards())[0]!.card as unknown as { card: NftAlertCard }
    expect(r.card).toMatchObject({ marketplace: "NFTX", link: "nftx" })
  })
})
