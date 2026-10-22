import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { loadNftState, type NftState } from "../src/nft/state"
import { watch } from "../src/nft/watches"
import { createBot } from "../src/platforms/telegram/bot"
import type { Prices } from "../src/prices"
import { addUser } from "./helpers/bot"
import { insertEvents, resetDb } from "./helpers/db"
import { addr, nftCollection, nftDrop, nftMint, nftSale, nftStats, T0 } from "./helpers/events"
import { testImages } from "./helpers/images"
import { BOT_INFO, harness, type Payload } from "./helpers/tg"

const NOW = T0 + 40 * 86400
const H = 3600
const D = 86400
const prices: Prices = { usd: () => 2500, symbol: () => "ETH" }
const C = addr(0xc0)
const eth = (n: number) => String(BigInt(Math.round(n * 1e9)) * 10n ** 9n)
let sql: Sql
let h: ReturnType<typeof harness>
let img: ReturnType<typeof testImages>
let state: NftState

const kbOf = (p: Payload | undefined) =>
  (p?.reply_markup?.inline_keyboard ?? []) as {
    text: string
    url?: string
    callback_data?: string
    style?: string
  }[][]
const texts = (p: Payload | undefined) => kbOf(p).map((r) => r.map((b) => b.text))

async function boot(events: Parameters<typeof insertEvents>[1]) {
  const ids = await insertEvents(sql, events)
  state = await loadNftState(sql, ids.at(-1) ?? "0")
}
function mkBot() {
  h = harness(
    createBot({
      token: "1:test",
      botInfo: BOT_INFO,
      sql,
      prices,
      log: () => {},
      report: vi.fn(),
      linksBase: "https://go.makobot.xyz",
      images: img.images,
      nft: () => state,
      now: () => NOW,
    }),
  )
}
beforeEach(async () => {
  img = testImages()
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
})
afterAll(() => sql.end())

/** Ink Hornet: sold out in 3d 13h, 13 sales (0.0176 ETH) in 24h, floor down 8% on the day. */
function hornet() {
  const start = NOW - 5 * D
  return [
    nftCollection({ creator: { address: addr(0xaa), username: "INKHornetDEV", verified: false } }),
    nftStats({
      floorWei: eth(0.00174),
      blockTimestamp: NOW - D - 600,
      owners: 700,
      listedCount: 100,
    }),
    nftMint({
      kind: "sold_out",
      blockTimestamp: start + 3 * D + 13 * H,
      mintStartTs: start,
      minted: "2222",
    }),
    // Oldest first, like the chain: the newest sale has the highest id.
    nftSale({ tokenId: "5", priceWei: eth(0.5), blockTimestamp: NOW - 3 * D }),
    nftSale({ tokenId: "902", priceWei: eth(0.0008), blockTimestamp: NOW - 13 * H }),
    ...Array.from({ length: 12 }, (_, k) => 11 - k).map((i) =>
      nftSale({
        tokenId: String(1485 - i),
        priceWei: eth(0.0014),
        blockTimestamp: NOW - 600 - i * H,
      }),
    ),
    nftStats({
      floorWei: eth(0.0016),
      blockTimestamp: NOW - 60,
      owners: 731,
      listedCount: 184,
      listedCapped: false,
    }),
  ]
}

describe("collection card", () => {
  it("opens from /nft by slug with the approved rows, as a photo with the card as caption", async () => {
    await boot(hornet())
    mkBot()
    await h.text("/nft ink-hornet")
    const m = h.last("sendPhoto")!
    expect(m.caption).toBe(
      [
        "<b>Ink Hornet · OpenSea</b>",
        "",
        "<code>floor    0.0016 ETH ($4.00) (−8% 24h)</code>",
        "<code>volume   0.0176 ETH ($44) (24h)</code>",
        "<code>sales    13 (24h)</code>",
        "<code>supply   2,222</code>",
        "<code>holders  731</code>",
        "<code>listed   184 (8.3%)</code>",
        "<code>creator  INKHornetDEV</code>",
        "<code>mint     sold out in 3d 13h</code>",
        "",
        `CA   <code>${C}</code>`,
        '<a href="https://x.com/InkHornet">X</a> · <a href="https://hornet.example/">Website</a>',
      ].join("\n"),
    )
    expect(texts(m)).toEqual([
      ["1h", "24h", "7d", "30d"],
      ["Watch", "Recent sales", "View"],
    ])
    const kb = kbOf(m)
    expect(kb[0]!.map((b) => b.style)).toEqual([undefined, "success", undefined, undefined])
    expect(kb[0]!.map((b) => b.callback_data)).toEqual(
      [1, 2, 3, 4].map((i) => `nw:${C}:${["1h", "24h", "7d", "30d"][i - 1]}`),
    )
    expect(kb[1]![0]).toEqual({ text: "Watch", callback_data: `nwa:${C}` })
    expect(kb[1]![1]).toEqual({ text: "Recent sales", callback_data: `nr:${C}:1` })
    expect(kb[1]![2]).toEqual({ text: "View", url: "https://go.makobot.xyz/n/c/ink-hornet" })
    expect(m.caption).not.toMatch(/junk/i)
  })

  it("takes a window on the command and from the buttons, switching volume, sales and the floor change", async () => {
    await boot(hornet())
    mkBot()
    await h.text("/nft ink-hornet 7d")
    const cap = h.last("sendPhoto")!.caption as string
    expect(cap).toContain("<code>volume   0.518 ETH ($1.3K) (7d)</code>")
    expect(cap).toContain("<code>sales    14 (7d)</code>")
    expect(cap).toContain("(7d)")
    h.clear()
    await h.tap(`nw:${C}:1h`, { photo: true })
    const e = h.last("editMessageCaption")!
    expect(e.caption).toContain("<code>volume   0.0014 ETH ($3.50) (1h)</code>")
    expect(e.caption).toContain("<code>sales    1 (1h)</code>")
    expect(e.caption).not.toContain("24h)")
    expect(kbOf(e)[0]!.map((b) => b.style)).toEqual(["success", undefined, undefined, undefined])
  })

  it("reads WIRED ✓ · Chimera on a Chimera collection and has the same buttons", async () => {
    await boot([
      nftCollection({ name: "WIRED", slug: "wired", safelist: "verified", launchpad: "chimera" }),
      nftStats({ owners: 212 }),
    ])
    mkBot()
    await h.text("/nft wired")
    const m = h.last("sendPhoto")!
    expect((m.caption as string).split("\n")[0]).toBe("<b>WIRED ✓ · Chimera</b>")
    expect(texts(m)[1]).toEqual(["Watch", "Recent sales", "View"])
    expect(JSON.stringify(m.reply_markup)).not.toMatch(/Chimera|chimeras/i)
  })

  it("shows Watching, green, for a collection the viewer already watches", async () => {
    await boot(hornet())
    mkBot()
    const u = await addUser(sql, 100)
    await watch(sql, { userId: u }, C)
    await h.text("/nft ink-hornet")
    const watchBtn = kbOf(h.last("sendPhoto"))[1]![0]!
    expect(watchBtn).toEqual({ text: "Watching", callback_data: `nws:${C}`, style: "success" })
  })

  it("gives a group a deep link for Watch", async () => {
    await boot(hornet())
    mkBot()
    await h.text("/nft ink-hornet", { chat: { id: -1001, type: "supergroup" } })
    const kb = kbOf(h.last("sendPhoto"))
    expect(kb[1]![0]).toEqual({ text: "Watch", url: `https://t.me/makoinkbot?start=wn_${C}` })
  })

  it("lists recent sales 10 to a page, pages with Newer and Older, and Back returns to the card", async () => {
    await boot(hornet())
    mkBot()
    await h.tap(`nr:${C}:1`, { photo: true })
    const p1 = h.last("editMessageCaption")!
    const lines = (p1.caption as string).split("\n")
    expect(lines[0]).toBe("<b>Recent sales · Ink Hornet</b>")
    expect(lines.filter((l) => l.startsWith("<code>#"))).toHaveLength(10)
    expect(lines[2]).toBe("<code>#1485   0.0014 ETH   10m</code>".replace("10m", "10m ago"))
    expect(lines.at(-1)).toBe("page 1 of 2")
    expect(texts(p1)).toEqual([["Older ›"], ["Back", "OpenSea"]])
    expect(kbOf(p1)[0]![0]!.callback_data).toBe(`nr:${C}:2`)
    expect(kbOf(p1)[1]![1]).toEqual({
      text: "OpenSea",
      url: "https://go.makobot.xyz/n/s/ink-hornet",
    })
    h.clear()
    await h.tap(`nr:${C}:2`, { photo: true })
    const p2 = h.last("editMessageCaption")!
    expect((p2.caption as string).split("\n").filter((l) => l.startsWith("<code>#"))).toHaveLength(
      4,
    )
    expect(texts(p2)).toEqual([["‹ Newer"], ["Back", "OpenSea"]])
    h.clear()
    await h.tap(kbOf(p2)[1]![0]!.callback_data!, { photo: true })
    expect(h.last("editMessageCaption")!.caption).toContain("<b>Ink Hornet · OpenSea</b>")
  })
})

describe("finding a collection", () => {
  it("opens the card when a known contract is pasted", async () => {
    await boot(hornet())
    mkBot()
    await h.text(C.toUpperCase().replace("0X", "0x"))
    expect(h.last("sendPhoto")!.caption).toContain("<b>Ink Hornet · OpenSea</b>")
    expect(h.last("sendMessage")).toBeUndefined()
  })

  it("opens the card when an OpenSea collection link is pasted", async () => {
    await boot(hornet())
    mkBot()
    await h.text("https://opensea.io/collection/ink-hornet")
    expect(h.last("sendPhoto")!.caption).toContain("<b>Ink Hornet · OpenSea</b>")
  })

  it("opens a bare slug in a DM and ignores it in a group", async () => {
    await boot(hornet())
    mkBot()
    await h.text("ink-hornet")
    expect(h.last("sendPhoto")!.caption).toContain("Ink Hornet")
    h.clear()
    await h.text("ink-hornet", { chat: { id: -1001, type: "supergroup" } })
    expect(h.calls).toEqual([])
  })

  it("keeps the unknown-address answer for an address that is no token and no collection", async () => {
    await boot(hornet())
    mkBot()
    await h.text(addr(0x77))
    expect(h.last("sendMessage")!.text).toMatch(/^Not a token on/)
  })

  it("asks for 3 characters, and has no word for a name nothing matches", async () => {
    await boot(hornet())
    mkBot()
    await h.text("/nft ab")
    expect(h.last("sendMessage")!.text).toBe("Send at least 3 characters")
    await h.text("/nft zzzzzz")
    expect(h.last("sendMessage")!.text).toMatch(/COPY NEEDED/)
  })

  it("gives a pick list of full-width buttons when several collections match", async () => {
    await boot([
      nftCollection({ contract: addr(0xc1), name: "WIRED", slug: "wired-a" }),
      nftStats({ contract: addr(0xc1), owners: 212 }),
      nftCollection({ contract: addr(0xc2), name: "WIRED", slug: "wired-b" }),
      nftStats({ contract: addr(0xc2), owners: 5 }),
    ])
    mkBot()
    await h.text("/nft wired")
    const m = h.last("sendMessage")!
    expect(m.text).toBe('More than one collection matches "wired". Pick one:')
    expect(texts(m)).toEqual([
      ["WIRED · 0x0000…00c1 · 212 holders"],
      ["WIRED · 0x0000…00c2 · 5 holders"],
    ])
    expect(kbOf(m)[0]![0]!.callback_data).toBe(`nc:${addr(0xc1)}`)
    for (const row of texts(m)) expect(row[0]!.length).toBeLessThanOrEqual(34)
    h.clear()
    await h.tap(`nc:${addr(0xc1)}`)
    expect(h.last("sendPhoto")!.caption).toContain("<b>WIRED · OpenSea</b>")
  })
})

describe("lists", () => {
  const live = (
    contract: `0x${string}`,
    name: string,
    extra: Parameters<typeof nftCollection>[0] = {},
  ) => [
    nftCollection({ contract, name, slug: name.toLowerCase().replace(/ /g, "-"), ...extra }),
    nftDrop({ contract, stages: [] }),
    nftMint({
      contract,
      stageLabel: "FCFS",
      stageIndex: 2,
      minted: "1104",
      maxSupply: "2222",
      blockTimestamp: NOW - 600,
    }),
  ]

  it("Minting now lists passing collections and watched ones, never Chimera, as full-width rows with Back", async () => {
    await boot([
      ...live(addr(0xc1), "Ink Hornet"),
      ...live(addr(0xc2), "Pending One", { verdict: "pending" }),
      ...live(addr(0xc3), "Watched One", { verdict: "pending" }),
      ...live(addr(0xc4), "Chimera One", { launchpad: "chimera" }),
    ])
    mkBot()
    const u = await addUser(sql, 100)
    await watch(sql, { userId: u }, addr(0xc3))
    await h.tap("nl:m")
    const m = h.last("editMessageText")!
    expect(m.text).toBe("<b>Minting now</b>")
    expect(texts(m)).toEqual([["Ink Hornet · FCFS · 49%"], ["Watched One · FCFS · 49%"], ["Back"]])
    expect(kbOf(m)[0]![0]!.callback_data).toBe(`nc:${addr(0xc1)}:m`)
    expect(kbOf(m).at(-1)![0]!.callback_data).toBe("nfts")
    for (const row of texts(m)) expect(row[0]!.length).toBeLessThanOrEqual(30)
  })

  it("a card opened from a list ends with Back to that list", async () => {
    await boot([...live(addr(0xc1), "Ink Hornet")])
    mkBot()
    await h.tap(`nc:${addr(0xc1)}:m`)
    const kb = kbOf(h.last("sendPhoto"))
    expect(kb.at(-1)).toEqual([{ text: "Back", callback_data: "nl:m" }])
    expect(kb[0]![0]!.callback_data).toBe(`nw:${addr(0xc1)}:1h:m`)
  })

  it("Upcoming lists the next 7 days by start time", async () => {
    const stage = (label: string, at: number) => ({
      type: "allow_list",
      label,
      priceWei: "0",
      startTime: at,
      endTime: null,
      maxPerWallet: null,
      allowlistCount: 100,
    })
    await boot([
      nftCollection({ contract: addr(0xc1), name: "Later", slug: "later" }),
      nftDrop({ contract: addr(0xc1), stages: [stage("GTD", Date.UTC(2026, 10, 3, 10) / 1000)] }),
      nftCollection({ contract: addr(0xc2), name: "Sooner", slug: "sooner" }),
      nftDrop({ contract: addr(0xc2), stages: [stage("GTD", Date.UTC(2026, 10, 2, 17) / 1000)] }),
      nftCollection({ contract: addr(0xc3), name: "Too Far", slug: "too-far" }),
      nftDrop({ contract: addr(0xc3), stages: [stage("GTD", Date.UTC(2026, 10, 30, 17) / 1000)] }),
    ])
    mkBot()
    // NOW = T0 + 40 days = Nov 1 2026 (T0 is 1,790,000,000 → Sep 21 2026 + 40d).
    await h.tap("nl:u")
    const m = h.last("editMessageText")!
    expect(m.text).toBe("<b>Upcoming</b>")
    expect(texts(m)).toEqual([["Sooner · Nov 2 17:00 UTC"], ["Later · Nov 3 10:00 UTC"], ["Back"]])
  })

  it("says nothing it was not given words for when a list is empty", async () => {
    await boot(hornet())
    mkBot()
    await h.tap("nl:u")
    expect(h.last("editMessageText")!.text).toMatch(/COPY NEEDED/)
  })
})
