import { afterAll, beforeEach, expect, inject, it } from "vitest"
import type { Sql } from "../src/db"
import { createHealth, type HealthEvent } from "../src/health"
import { addUser } from "./helpers/bot"
import { insertEvents, resetDb, setCursorBlock } from "./helpers/db"
import { addr, nftMint, nftSale } from "./helpers/events"

const MIN = 60
const NOW = 1_800_000_000
let sql: Sql
let events: HealthEvent[]
let now: number
let head: bigint | Error

beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  events = []
  now = NOW
  head = 1000n
  await setCursorBlock(sql, 1000)
})
afterAll(() => sql.end())

const REAL = addr(0xa1)
const JUNK = addr(0xa2)
const health = () =>
  createHealth({
    sql,
    chainHead: async () => {
      if (head instanceof Error) throw head
      return head
    },
    verdictOf: (c) => (c === REAL ? "real" : c === JUNK ? "filtered" : undefined),
    report: (e) => events.push(e),
    now: () => now,
  })
/** One fresh indexer event, written `ageS` seconds before now, with the bot caught up to it. */
let tx = 0
async function freshEvent(ageS = 0, block = 990) {
  const [id] = await insertEvents(sql, [
    nftSale({ blockNumber: String(block), txHash: `0xf${++tx}` }),
  ])
  await sql`update indexer.events set created_at = to_timestamp(${now - ageS}) where id = ${id!}`
  await sql`insert into bot.state (key, value) values ('events_cursor', ${id!})
    on conflict (key) do update set value = excluded.value`
  return id!
}
async function sentAlert(ageS: number) {
  await sql`
    insert into bot.deliveries (chat_id, chat_type, alert, dedupe_key, priority, event_ts, card, status, created_at, sent_at)
    values (1, 'private', 'new', ${`k${Math.random()}`}, 1, now(), '{}', 'sent',
      to_timestamp(${now - ageS}), to_timestamp(${now - ageS}))`
}
const titles = () => events.map((e) => `${e.level}: ${e.message.split("\n")[0]}`)

it("reports stale indexer events once per incident, then a recovered note", async () => {
  await sentAlert(MIN)
  await freshEvent(61 * MIN)
  const h = health()
  await h.tick()
  await h.tick()
  expect(titles()).toEqual(["error: Health: no new indexer events for 60 minutes"])
  expect(events[0]!.fingerprint).toEqual(["health", "events", String(NOW)])
  now += 5 * MIN
  await freshEvent(0)
  await h.tick()
  expect(titles()[1]).toBe("info: Health recovered: no new indexer events (lasted 5m)")
  expect(events[1]!.fingerprint).toEqual(["health", "events", String(NOW), "recovered"])
  expect(await sql`select key from bot.state where key like 'health:%'`).toEqual([])
})

it("keeps an open incident across a restart, without firing it again", async () => {
  await sentAlert(MIN)
  await freshEvent(61 * MIN)
  await health().tick()
  now += 5 * MIN
  await health().tick()
  expect(events).toHaveLength(1)
  await freshEvent(0)
  await health().tick()
  expect(titles()[1]).toContain("Health recovered: no new indexer events")
})

it("reports an indexer cursor more than 100 blocks behind the chain head, and skips when the head can't be read", async () => {
  await sentAlert(MIN)
  await freshEvent(0)
  head = 1100n
  const h = health()
  await h.tick()
  expect(titles()).toEqual([])
  head = 1101n
  await h.tick()
  expect(titles()).toEqual(["error: Health: indexer cursor 101 blocks behind the chain head"])
  head = new Error("rpc down")
  await h.tick()
  expect(events).toHaveLength(1)
  head = 1010n
  await h.tick()
  expect(titles()[1]).toBe(
    "info: Health recovered: indexer cursor behind the chain head (lasted 0m)",
  )
})

it("reports the bot more than 500 events behind only after 10 minutes", async () => {
  await sentAlert(MIN)
  const id = await freshEvent(0)
  await sql`update bot.state set value = ${String(Number(id) - 501)} where key = 'events_cursor'`
  const h = health()
  await h.tick()
  now += 5 * MIN
  await h.tick()
  expect(events).toEqual([])
  now += 5 * MIN
  await h.tick()
  expect(titles()).toEqual(["error: Health: bot 501 events behind the indexer for 10 minutes"])
})

it("reports 10 or more failed deliveries in the last hour", async () => {
  await sentAlert(MIN)
  await freshEvent(0)
  const fail = (n: number, ageS: number) =>
    sql`
      insert into bot.deliveries (chat_id, chat_type, alert, dedupe_key, priority, event_ts, card, status, created_at)
      select 1, 'private', 'new', 'f' || g || '-' || ${ageS}, 1, now(), '{}', 'failed', to_timestamp(${now - ageS})
      from generate_series(1, ${n}) g`
  await fail(9, 10 * MIN)
  await fail(5, 2 * 60 * MIN)
  const h = health()
  await h.tick()
  expect(events).toEqual([])
  await fail(1, MIN)
  await h.tick()
  expect(titles()).toEqual(["error: Health: 10 failed deliveries in the last hour"])
})

it("sends a quiet-day note with a summary at most once a day", async () => {
  await addUser(sql, 101)
  await freshEvent(0)
  const big = String(8n * 10n ** 16n)
  await insertEvents(sql, [
    nftSale({ contract: REAL, priceWei: big, blockNumber: "995", txHash: "0x01" }),
    nftSale({ contract: JUNK, priceWei: String(10n ** 18n), blockNumber: "996", txHash: "0x02" }),
    nftMint({ contract: REAL, blockNumber: "997", txHash: "0x03" }),
    nftMint({ contract: JUNK, blockNumber: "998", txHash: "0x04" }),
    nftMint({ contract: JUNK, blockNumber: "999", txHash: "0x05" }),
  ])
  await sql`update indexer.events set created_at = to_timestamp(${now})`
  await sentAlert(25 * 60 * MIN)
  const h = health()
  await h.tick()
  expect(titles()).toEqual(["info: Health: no alert sent in 24 hours"])
  const body = events[0]!.message
  expect(body).toContain("Events: nft.mint 3, nft.sale 3")
  expect(body).toContain("Biggest sale in a real collection: 0.08 ETH (BIG SALE minimum 0.1 ETH)")
  expect(body).toContain("Mints: 1 from real collections, 2 from filtered, 0 other")
  const later = async (s: number) => {
    now += s
    await sql`update indexer.events set created_at = to_timestamp(${now})`
    await h.tick()
  }
  await later(23 * 60 * MIN)
  expect(events).toHaveLength(1)
  await later(2 * 60 * MIN)
  expect(events).toHaveLength(2)
})

it("sends no quiet-day note while alerts go out", async () => {
  await freshEvent(0)
  await sentAlert(23 * 60 * MIN)
  await health().tick()
  expect(events).toEqual([])
})
