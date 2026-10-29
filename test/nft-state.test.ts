import type { NftCollectionEvent } from "@ink-indexer/events"
import { afterAll, beforeEach, expect, inject, it } from "vitest"
import type { Sql } from "../src/db"
import type { Row } from "../src/history"
import { floorAt, latestNft, nftSince, salesByBuyer, salesSince } from "../src/nft/history"
import { parseOpenSeaLink } from "../src/nft/match"
import { loadNftState } from "../src/nft/state"
import { insertEvents, resetDb } from "./helpers/db"
import {
  addr,
  nftCollection,
  nftDrop,
  nftLaunch,
  nftMint,
  nftSale,
  nftStats,
  T0,
} from "./helpers/events"

let sql: Sql
beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
})
afterAll(() => sql.end())

const C1 = addr(0xc0)
const C2 = addr(0xc2)
const row = <T>(id: string, p: T): Row<T> => ({ id, p })

it("rebuilds state only up to the cursor, so later snapshots are still detected once", async () => {
  const [a, b] = await insertEvents(sql, [
    nftCollection({ verdict: "pending" }),
    nftCollection({ verdict: "real" }),
  ])
  const state = await loadNftState(sql, a!)
  expect(state.get(C1)?.col?.verdict).toBe("pending")
  const [newer] = await sql<{ p: NftCollectionEvent }[]>`
    select payload as p from indexer.events where id = ${b!}`
  const prev = state.apply(row(b!, newer!.p))
  expect(prev).toMatchObject({ type: "nft.collection", verdict: "pending" })
  expect(state.get(C1)?.col?.verdict).toBe("real")
})

it("apply returns the previous snapshot, and null for the first and for other event types", () => {
  return loadNftState(sql, "0").then((state) => {
    expect(state.apply(row("1", nftCollection({ name: "A" })))).toBeNull()
    expect(state.apply(row("2", nftCollection({ name: "B" })))).toMatchObject({ name: "A" })
    expect(state.apply(row("3", nftSale()))).toBeNull()
    expect(state.get(C1)?.col?.name).toBe("B")
  })
})

it("apply returns the previous drop for an nft.drop event", () => {
  return loadNftState(sql, "0").then((state) => {
    expect(state.apply(row("1", nftDrop({ maxSupply: "100" })))).toBeNull()
    expect(state.apply(row("2", nftDrop({ maxSupply: "200" })))).toMatchObject({
      type: "nft.drop",
      maxSupply: "100",
    })
  })
})

it("loads the latest event of each kind per collection", async () => {
  const ids = await insertEvents(sql, [
    nftCollection({ name: "Old" }),
    nftCollection({ name: "New" }),
    nftDrop({ maxSupply: "1" }),
    nftDrop({ maxSupply: "2" }),
    nftMint({ kind: "stage_start", stageIndex: 0 }),
    nftMint({ kind: "progress", markBps: 2500, stageIndex: 0 }),
    nftMint({ kind: "stage_start", stageIndex: 1, stageLabel: "Public" }),
    nftMint({ kind: "sold_out", stageIndex: 1 }),
    nftStats({ owners: 1 }),
    nftStats({ owners: 2 }),
    nftLaunch({ contract: C2 }),
    nftSale(),
  ])
  const s = (await loadNftState(sql, ids.at(-1)!)).get(C1)!
  expect(s.col?.name).toBe("New")
  expect(s.drop?.maxSupply).toBe("2")
  expect(s.lastStage?.stageLabel).toBe("Public")
  expect(s.lastMark?.markBps).toBe(2500)
  expect(s.soldOut?.kind).toBe("sold_out")
  expect(s.stats?.owners).toBe(2)
  const launched = (await loadNftState(sql, ids.at(-1)!)).get(C2)!
  expect(launched.launch?.tokenSymbol).toBe("BLOOP")
  expect(launched.col).toBeNull()
})

it("finds collections by address, OpenSea link, slug and name, real ones first", async () => {
  const wired = (o: Partial<NftCollectionEvent>) =>
    nftCollection({ name: "WIRED", slug: "wired", ...o })
  const copy = addr(0xc3)
  const ids = await insertEvents(sql, [
    nftCollection(),
    wired({ contract: addr(0xc4), safelist: "verified" }),
    wired({ contract: copy, slug: "wired-2", verdict: "filtered" }),
    wired({ contract: addr(0xc5), slug: "wired-3", verdict: "pending" }),
    nftStats({ contract: addr(0xc4), owners: 212, sales24h: 4 }),
    nftStats({ contract: copy, owners: 900, sales24h: 90 }),
  ])
  const state = await loadNftState(sql, ids.at(-1)!)
  expect(state.search(C1).map((s) => s.col?.contract)).toEqual([C1])
  expect(state.search(C1.toUpperCase().replace("0X", "0x")).map((s) => s.col?.contract)).toEqual([
    C1,
  ])
  expect(
    state.search("https://opensea.io/collection/ink-hornet/overview").map((s) => s.col?.slug),
  ).toEqual(["ink-hornet"])
  expect(state.search(`https://opensea.io/item/ink/${C1}/12`).map((s) => s.col?.contract)).toEqual([
    C1,
  ])
  expect(state.search("ink-hornet").map((s) => s.col?.slug)).toEqual(["ink-hornet"])
  expect(state.search("ink hornet").map((s) => s.col?.slug)).toEqual(["ink-hornet"])
  expect(state.search("hornet").map((s) => s.col?.slug)).toEqual(["ink-hornet"])
  // Copies with more owners and sales still rank behind the real one.
  expect(state.search("wired").map((s) => s.col?.contract)).toEqual([addr(0xc4), copy, addr(0xc5)])
  expect(state.search("wired", 2)).toHaveLength(2)
  expect(state.search("zzzz")).toEqual([])
})

it("lists collections minting now and upcoming ones without Team stages", async () => {
  const team = {
    type: "signed_presale",
    label: "Team",
    priceWei: "0",
    startTime: T0 + 100,
    endTime: T0 + 200,
    maxPerWallet: null,
    allowlistCount: 50,
  }
  const ids = await insertEvents(sql, [
    nftCollection(),
    nftDrop(),
    nftCollection({ contract: C2, slug: "c2", name: "C2" }),
    nftDrop({ contract: C2, stages: [team] }),
    nftMint({ contract: addr(0xc6) }),
  ])
  const state = await loadNftState(sql, ids.at(-1)!)
  expect(state.upcoming(T0, 7 * 86400).map((s) => s.col?.contract)).toEqual([C1])
  expect(state.upcoming(T0 + 3601, 7 * 86400).map((s) => s.col?.contract)).toEqual([C1])
  expect(state.upcoming(T0, 60)).toEqual([])
  expect(state.live().map((s) => s.lastStage?.contract)).toEqual([addr(0xc6)])
})

it("leaves a sold-out collection out of upcoming", async () => {
  const ids = await insertEvents(sql, [
    nftCollection(),
    nftDrop(),
    nftMint({ kind: "sold_out", minted: "2222", maxSupply: "2222" }),
  ])
  const state = await loadNftState(sql, ids.at(-1)!)
  expect(state.upcoming(T0, 7 * 86400)).toEqual([])
})

it("parses OpenSea collection, item and assets links", () => {
  expect(parseOpenSeaLink("https://opensea.io/collection/ink-hornet")).toEqual({
    slug: "ink-hornet",
  })
  expect(parseOpenSeaLink("opensea.io/collection/ink-hornet/activity?x=1")).toEqual({
    slug: "ink-hornet",
  })
  expect(
    parseOpenSeaLink(`https://opensea.io/item/ink/${C1.toUpperCase().replace("0X", "0x")}/1485`),
  ).toEqual({
    contract: C1,
    tokenId: "1485",
  })
  expect(parseOpenSeaLink(`https://opensea.io/assets/ink/${C1}/7`)).toEqual({
    contract: C1,
    tokenId: "7",
  })
  expect(parseOpenSeaLink(`https://opensea.io/assets/ethereum/${C1}/7`)).toBeNull()
  expect(parseOpenSeaLink("https://example.com/collection/x")).toBeNull()
  expect(parseOpenSeaLink("hello")).toBeNull()
})

it("reads history by collection: latest, since, buyer sweeps, floor at a time and sales totals", async () => {
  const ids = await insertEvents(sql, [
    nftStats({ floorWei: "100", blockTimestamp: T0 }),
    nftStats({ floorWei: "200", blockTimestamp: T0 + 100 }),
    nftSale({ buyer: addr(0xb1), blockTimestamp: T0 + 10, priceWei: "5" }),
    nftSale({ buyer: addr(0xb1), blockTimestamp: T0 + 20, priceWei: "7" }),
    nftSale({ buyer: addr(0xb2), blockTimestamp: T0 + 30, priceWei: "11" }),
    nftSale({ contract: C2, buyer: addr(0xb1), blockTimestamp: T0 + 40 }),
  ])
  const last = ids.at(-1)!
  expect((await latestNft(sql, "nft.stats", C1))?.p.floorWei).toBe("200")
  expect(await latestNft(sql, "nft.drop", C1)).toBeNull()
  expect((await latestNft(sql, "nft.stats", C1, ids[0]))?.p.floorWei).toBe("100")
  expect((await nftSince(sql, "nft.sale", C1, T0 + 15, 10)).map((r) => r.p.priceWei)).toEqual([
    "11",
    "7",
  ])
  expect((await salesByBuyer(sql, C1, addr(0xb1), T0, last)).map((r) => r.p.priceWei)).toEqual([
    "5",
    "7",
  ])
  expect(await salesByBuyer(sql, C1, addr(0xb1), T0 + 15, last)).toHaveLength(1)
  expect((await floorAt(sql, C1, T0 + 50))?.p.floorWei).toBe("100")
  expect((await floorAt(sql, C1, T0 + 100))?.p.floorWei).toBe("200")
  expect(await floorAt(sql, C1, T0 - 1)).toBeNull()
  expect(await salesSince(sql, C1, T0)).toEqual({ count: 3, sumWei: 23n })
  expect(await salesSince(sql, C1, T0 + 25)).toEqual({ count: 1, sumWei: 11n })
  expect(await salesSince(sql, C2, T0 + 50)).toEqual({ count: 0, sumWei: 0n })
})

it("per-collection reads use events_type_entity_id", async () => {
  await insertEvents(sql, [nftStats(), nftSale(), nftCollection()])
  await sql`
    insert into indexer.events (type, entity, payload, block, block_hash, tx_hash, log_index, confirmed)
    select 'launchpad.trade', '0xfill' || g, '{}', g, '0x00', '0xfill' || g, 0, true from generate_series(1, 3000) g`
  await sql`analyze indexer.events`
  const used = async (c: Sql) => {
    await c`select pg_stat_force_next_flush()`
    const [r] = await c<{ n: string }[]>`
      select coalesce(sum(idx_scan), 0)::text as n from pg_stat_user_indexes where indexrelname = 'events_type_entity_id'`
    return Number(r!.n)
  }
  const reads: [string, (c: Sql) => Promise<unknown>][] = [
    ["latestNft", (c) => latestNft(c, "nft.stats", C1)],
    ["nftSince", (c) => nftSince(c, "nft.sale", C1, 0, 5)],
    ["salesByBuyer", (c) => salesByBuyer(c, C1, addr(0xb1), 0, "999999")],
    ["floorAt", (c) => floorAt(c, C1, T0)],
    ["salesSince", (c) => salesSince(c, C1, 0)],
  ]
  const c = (await sql.reserve()) as unknown as Sql & { release(): void }
  try {
    await c`set enable_seqscan = off`
    for (const [name, read] of reads) {
      const before = await used(c)
      await read(c)
      expect((await used(c)) - before, name).toBeGreaterThan(0)
    }
  } finally {
    c.release()
  }
})
