import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { NOT_ADMIN } from "../src/menus/alerts"
import { createBot } from "../src/platforms/telegram/bot"
import { setButtonColours } from "../src/platforms/telegram/ui"
import type { Prices } from "../src/prices"
import { basicPreset, type Settings } from "../src/settings"
import { addChat, addUser, subscribe } from "./helpers/bot"
import { resetDb } from "./helpers/db"
import { testImages } from "./helpers/images"
import { BOT_INFO, harness, type Payload } from "./helpers/tg"

const prices: Prices = { usd: () => 2500, symbol: () => "ETH" }
const G = { id: -1001, type: "supergroup" as const, title: "Alpha" }
let sql: Sql
let h: ReturnType<typeof harness>

beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  h = harness(
    createBot({
      token: "1:t",
      botInfo: BOT_INFO,
      sql,
      prices,
      log: () => {},
      report: vi.fn(),
      linksBase: "https://go.makobot.xyz",
      images: testImages().images,
    }),
  )
})
afterEach(() => setButtonColours(true))
afterAll(() => sql.end())

type Btn = { text: string; callback_data?: string; url?: string; style?: string }
const rows = (p: Payload | undefined): Btn[][] => p?.reply_markup?.inline_keyboard ?? []
const labels = (p: Payload | undefined) => rows(p).map((r) => r.map((b) => b.text))
const screen = () => h.last("editMessageText")!
const find = (p: Payload | undefined, text: string): Btn =>
  rows(p)
    .flat()
    .find((b) => b.text === text)!
const userSettings = async () =>
  (await sql<{ settings: Settings }[]>`select settings from bot.users`)[0]!.settings
const chatSettings = async (id: number) =>
  (await sql<{ settings: Settings }[]>`select settings from bot.chats where chat_id = ${id}`)[0]!
    .settings
const nonAdmin = () =>
  h.on("getChatMember", (p) => ({
    status: "member",
    user: { id: p.user_id, is_bot: false, first_name: "A" },
  }))

const TOKEN_TEXT = [
  "<b>Token alerts</b>",
  "Customize what kind of alerts you receive for tokens.",
  "",
  "<b>Alert Types</b>",
  "NEW TOKEN - newly detected tokens created.",
  "BONDING - When a token passes your set threshold.",
  "PUMPING - When a token's curve jumps 15%+ in 10 min.",
  "BONDED - A token that has bonded/graduated.",
  "DEV SELL - When the creator sells any amount of their own token.",
  "BIG BUY/SELL - one trade worth 5%+ of the token's bond target.",
].join("\n")

const ALL_BODY = [
  "When turned on: Every collection that passes MAKO's quality checks.",
  "When turned off: Only receive alerts on NFTs you watch.",
  "",
  "<b>Alert Types</b>",
  "UPCOMING MINT - When a new mint is scheduled.",
  "MINT STARTING - A mint stage has opened (other than Team's).",
  "MINT LIVE - A mint without any mint stages goes live.",
  "MINTED - When a collection's total mints has passed your designated threshold (eg. 50% = 50/100 mints).",
  "SOLD OUT - When a collection completely mints out.",
  "NEW COLLECTION - A new Chimera collection is detected.",
  "BIG SALE - When an NFT sells for 0.1 ETH or more.",
]
const WATCHED_BODY = [
  "UNDER FLOOR - an item lists 20%+ under floor.",
  "RARE LISTING - a top 10% item lists near floor.",
  "FLOOR MOVE - the floor moves 20%+ in 24h.",
  "SWEEP - one wallet buys 5+ items in 10 min.",
  "SOLD - an item sells for 0.05 ETH or more.",
  "REMINDERS - a message 15 min before each mint stage.",
]

describe("My alerts", () => {
  it("shows the approved text and the counts", async () => {
    const me = await addUser(sql, 100)
    await subscribe(sql, me, "watch", "0xa1")
    await subscribe(sql, me, "watch", "0xa2")
    await subscribe(sql, me, "mute", "0xa3")
    await sql`insert into bot.nft_watches (user_id, contract) values (${me}, '0xc1')`
    await sql`insert into bot.collection_mutes (user_id, contract) values (${me}, '0xc2'), (${me}, '0xc3'), (${me}, '0xc4')`
    await h.tap("al:u")
    expect(screen().text).toBe(
      [
        "<b>My alerts</b>",
        "Choose which alerts you want me to send you.",
        "",
        "Tokens and NFTs you watch always send alerts, even if that alert type is turned off here.",
        "Muted tokens and NFTs never send alerts.",
      ].join("\n"),
    )
    expect(labels(screen())).toEqual([
      ["Token alerts", "NFT alerts"],
      ["Watched tokens (2)", "Watched NFTs (1)"],
      ["Muted tokens (1)", "Muted NFTs (3)"],
      ["Menu"],
    ])
    expect(
      rows(screen())
        .flat()
        .map((b) => b.callback_data),
    ).toEqual(["al:u:tk", "al:u:na", "wl", "nwl", "mu", "nml", "m"])
  })
})

describe("token alerts", () => {
  it("text is exact, and BIG BUY/SELL follows the chosen percentage", async () => {
    await addUser(sql, 100)
    await h.tap("al:u:tk")
    expect(screen().text).toBe(TOKEN_TEXT)
    await h.tap("al:u:p:big")
    await h.tap("al:u:p:big:2")
    expect((await userSettings()).alerts.big.pctBps).toBe(1000)
    await h.tap("al:u:tk")
    expect(screen().text).toContain(
      "BIG BUY/SELL - one trade worth 10%+ of the token's bond target.",
    )
    expect(labels(screen()).flat()).toContain("BIG BUY/SELL at: 10%")
  })

  it("has the approved rows", async () => {
    await addUser(sql, 100)
    await h.tap("al:u:tk")
    expect(labels(screen())).toEqual([
      ["NEW TOKEN", "Show Image"],
      ["BONDING", "Show Image"],
      ["PUMPING", "Show Image"],
      ["BONDED", "Show Image"],
      ["DEV SELL", "Show Image"],
      ["BIG BUY/SELL", "Show Image"],
      ["BONDING at: 80%, 90%"],
      ["BIG BUY/SELL at: 5%"],
      ["Reset to default"],
      ["Back"],
    ])
    expect(find(screen(), "Back").callback_data).toBe("al:u")
  })

  it("the alert and Image buttons toggle independently, and show green when on", async () => {
    await addUser(sql, 100)
    await h.tap("al:u:tk")
    const first = rows(screen())[0]!
    expect(first.map((b) => b.style)).toEqual(["success", "success"])
    await h.tap("al:u:pumping:on")
    let s = (await userSettings()).alerts.pumping
    expect(s).toMatchObject({ on: false, image: true })
    await h.tap("al:u:pumping:img")
    s = (await userSettings()).alerts.pumping
    expect(s).toMatchObject({ on: false, image: false })
    const pumping = rows(screen())[2]!
    expect(pumping.map((b) => b.style)).toEqual([undefined, undefined])
  })

  it("the BONDING picker is multi-select with the chosen marks green", async () => {
    await addUser(sql, 100)
    await h.tap("al:u:p:bonding")
    expect(labels(screen())).toEqual([["50%", "80%", "90%"], ["Back"]])
    expect(rows(screen())[0]!.map((b) => b.style)).toEqual([undefined, "success", "success"])
    await h.tap("al:u:p:bonding:0")
    expect((await userSettings()).alerts.bonding.marks).toEqual([5000, 8000, 9000])
    await h.tap("al:u:p:bonding:1")
    expect((await userSettings()).alerts.bonding.marks).toEqual([5000, 9000])
    expect(find(screen(), "Back").callback_data).toBe("al:u:tk")
  })
})

describe("NFT alerts", () => {
  it("All collections text is exact and the DM defaults are all on", async () => {
    await addUser(sql, 100)
    await h.tap("al:u:na")
    expect(screen().text).toBe(["<b>NFT alerts · All collections</b>", ...ALL_BODY].join("\n"))
    expect(labels(screen())).toEqual([
      ["UPCOMING MINT", "Show Image"],
      ["MINT STARTING", "Show Image"],
      ["MINT LIVE", "Show Image"],
      ["MINTED", "Show Image"],
      ["SOLD OUT", "Show Image"],
      ["NEW COLLECTION", "Show Image"],
      ["BIG SALE", "Show Image"],
      ["MINTED at: 50%", "BIG SALE: 0.1 ETH"],
      ["Reset to default"],
      ["Watched only", "Back"],
    ])
    expect(
      rows(screen())
        .slice(0, 7)
        .flat()
        .every((b) => b.style === "success"),
    ).toBe(true)
    expect(find(screen(), "Watched only").callback_data).toBe("al:u:nw")
    expect(find(screen(), "Back").callback_data).toBe("al:u")
  })

  it("Watched only text is exact; REMINDERS has no image button; SOLD is off at 0.05 ETH", async () => {
    await addUser(sql, 100)
    await h.tap("al:u:nw")
    expect(screen().text).toBe(
      [
        "<b>NFT alerts · Watched only</b>",
        "These alerts are only for NFTs you added to your watchlist.",
        "",
        ...WATCHED_BODY,
      ].join("\n"),
    )
    expect(labels(screen())).toEqual([
      ["UNDER FLOOR", "Show Image"],
      ["RARE LISTING", "Show Image"],
      ["FLOOR MOVE", "Show Image"],
      ["SWEEP", "Show Image"],
      ["SOLD", "Show Image"],
      ["REMINDERS"],
      ["UNDER FLOOR: 20%", "RARE: top 10%"],
      ["FLOOR MOVE: 20%", "SWEEP: 5 items"],
      ["SOLD at: 0.05 ETH"],
      ["Reset to default"],
      ["All collections", "Back"],
    ])
    expect(rows(screen())[4]!.map((b) => b.style)).toEqual([undefined, "success"])
    expect(rows(screen())[5]![0]!.style).toBe("success")
    expect(find(screen(), "All collections").callback_data).toBe("al:u:na")
  })

  it("the SOLD line reads at any price when the minimum is any", async () => {
    await addUser(sql, 100)
    await h.tap("al:u:p:sale")
    expect(labels(screen())).toEqual([
      ["any", "0.01 ETH", "0.05 ETH"],
      ["0.1 ETH", "0.5 ETH", "1 ETH"],
      ["Back"],
    ])
    await h.tap("al:u:p:sale:0")
    await h.tap("al:u:nw")
    expect(screen().text).toContain("SOLD - an item sells at any price.")
    expect(labels(screen()).flat()).toContain("SOLD at: any")
  })

  it("threshold labels follow the settings", async () => {
    await addUser(sql, 100)
    await h.tap("al:u:p:minted:2")
    await h.tap("al:u:p:bigsale:3")
    await h.tap("al:u:p:under:0")
    await h.tap("al:u:p:rare:0")
    await h.tap("al:u:p:floor:2")
    await h.tap("al:u:p:sweep:1")
    await h.tap("al:u:na")
    expect(labels(screen())).toContainEqual(["MINTED at: 50%, 75%", "BIG SALE: 0.5 ETH"])
    await h.tap("al:u:nw")
    expect(labels(screen())).toContainEqual(["UNDER FLOOR: 10%", "RARE: top 1%"])
    expect(labels(screen())).toContainEqual(["FLOOR MOVE: 30%", "SWEEP: 10 items"])
    expect(screen().text).toContain("UNDER FLOOR - an item lists 10%+ under floor.")
    expect(screen().text).toContain("RARE LISTING - a top 1% item lists near floor.")
  })

  it("MINTED marks are multi-select and BIG SALE single-select, with Back to the screen", async () => {
    await addUser(sql, 100)
    await h.tap("al:u:p:minted")
    expect(labels(screen())).toEqual([["25%", "50%", "75%"], ["Back"]])
    expect(find(screen(), "Back").callback_data).toBe("al:u:na")
    await h.tap("al:u:p:bigsale")
    expect(labels(screen())).toEqual([["0.05 ETH", "0.1 ETH", "0.25 ETH"], ["0.5 ETH"], ["Back"]])
    expect(find(screen(), "0.1 ETH").style).toBe("success")
  })
})

describe("Reset to default", () => {
  it("restores one screen and leaves the others", async () => {
    await addUser(sql, 100)
    await h.tap("al:u:new:on")
    await h.tap("al:u:upcoming:on")
    await h.tap("al:u:p:under:0")
    await h.tap("al:u:reset:na")
    const s = await userSettings()
    expect(s.alerts.upcoming.on).toBe(true)
    expect(s.alerts.new.on).toBe(false)
    expect(s.alerts.under.pctBps).toBe(1000)
    await h.tap("al:u:reset:nw")
    expect((await userSettings()).alerts.under.pctBps).toBe(2000)
    await h.tap("al:u:reset:tk")
    expect((await userSettings()).alerts.new.on).toBe(true)
    expect(await userSettings()).toEqual(basicPreset("private"))
    expect(screen().text).toContain("Token alerts")
  })

  it("keeps a chat's topic routes", async () => {
    await addChat(sql, G.id, "supergroup", {
      ...basicPreset("supergroup"),
      thread: 5,
      routes: { new: 9 },
      pausedRoutes: ["bonded"],
    })
    await h.tap(`al:${G.id}:new:on`)
    await h.tap(`al:${G.id}:reset:tk`)
    const s = await chatSettings(G.id)
    expect(s.alerts.new.on).toBe(true)
    expect(s.thread).toBe(5)
    expect(s.routes).toEqual({ new: 9 })
    expect(s.pausedRoutes).toEqual(["bonded"])
  })
})

describe("a group's settings in the DM", () => {
  it("has Token alerts, NFT alerts, Watched tokens and Watched NFTs above Pause, Remove MAKO and Back", async () => {
    await addChat(sql, G.id, "supergroup")
    await h.tap(`gc:${G.id}`)
    expect(labels(screen())).toEqual([
      ["Token alerts", "NFT alerts"],
      ["Watched tokens", "Watched NFTs"],
      ["Pause", "Remove MAKO"],
      ["Back"],
    ])
    expect(
      rows(screen())
        .flat()
        .map((b) => b.callback_data),
    ).toEqual([
      `al:${G.id}:tk`,
      `al:${G.id}:na`,
      `gl:${G.id}:t`,
      `gl:${G.id}:n`,
      `gc:${G.id}:pause`,
      `gc:${G.id}:remove`,
      "gc",
    ])
  })

  it("titles the screens with the chat name and goes Back to the group's settings", async () => {
    await addChat(sql, G.id, "supergroup")
    await h.tap(`al:${G.id}:tk`)
    expect(screen().text.split("\n")[0]).toBe("<b>Token alerts for Test Group</b>")
    expect(find(screen(), "Back").callback_data).toBe(`al:${G.id}`)
    await h.tap(`al:${G.id}:na`)
    expect(screen().text.split("\n").slice(0, 2)).toEqual([
      "<b>NFT alerts for Test Group</b>",
      "All collections",
    ])
    await h.tap(`al:${G.id}:nw`)
    expect(screen().text.split("\n").slice(0, 2)).toEqual([
      "<b>NFT alerts for Test Group</b>",
      "Watched only",
    ])
    expect(find(screen(), "All collections").callback_data).toBe(`al:${G.id}:na`)
  })

  it("NFT alerts default off in a group and need an admin", async () => {
    await addChat(sql, G.id, "supergroup")
    await h.tap(`al:${G.id}:na`)
    // The alert switch (first button of each row) is off; Show Image keeps its own default.
    expect(
      rows(screen())
        .slice(0, 7)
        .map((r) => r[0]!.style),
    ).toEqual(Array(7).fill(undefined))
    nonAdmin()
    for (const data of [
      `al:${G.id}:na`,
      `al:${G.id}:upcoming:on`,
      `al:${G.id}:p:minted:0`,
      `al:${G.id}:reset:nw`,
      `al:${G.id}`,
    ]) {
      await h.tap(data)
      expect(h.last("answerCallbackQuery")).toMatchObject({ text: NOT_ADMIN, show_alert: true })
    }
    expect((await chatSettings(G.id)).alerts.upcoming.on).toBe(false)
  })
})

describe("colour fallback and label lengths", () => {
  it("BUTTON_COLOURS=0 adds on/off text and dots, and nothing else changes", async () => {
    setButtonColours(false)
    await addUser(sql, 100)
    await h.tap("al:u:tk")
    expect(labels(screen())[0]).toEqual(["NEW TOKEN: on", "Show Image: on"])
    await h.tap("al:u:p:bonding")
    expect(labels(screen())[0]).toEqual(["50%", "· 80%", "· 90%"])
  })

  it("every settings label fits", async () => {
    // About 20 characters with 2 buttons per row, 13 with 3, 30 full width (design/alert-formats.md).
    const limit = (n: number) => (n >= 3 ? 13 : n === 2 ? 20 : 30)
    await addUser(sql, 100)
    for (const data of [
      "al:u",
      "al:u:tk",
      "al:u:na",
      "al:u:nw",
      "al:u:p:bonding",
      "al:u:p:big",
      "al:u:p:minted",
      "al:u:p:bigsale",
      "al:u:p:under",
      "al:u:p:rare",
      "al:u:p:floor",
      "al:u:p:sweep",
      "al:u:p:sale",
    ]) {
      await h.tap(data)
      for (const r of rows(screen()))
        for (const b of r)
          expect([...b.text].length, `${data}: ${b.text}`).toBeLessThanOrEqual(limit(r.length))
    }
  })
})
