import { expect, it } from "vitest"
import {
  ALERT_DESC,
  ALERT_LABEL,
  ALERT_PATTERN,
  ALERTS,
  allOff,
  basicPreset,
  LONG_WINDOW,
  NFT_ALL_ALERTS,
  NFT_WATCHED_ALERTS,
  PRIORITY,
  readSettings,
  resetScreen,
  SETTINGS_LABEL,
  TOKEN_ALERTS,
} from "../src/settings"

it("turns every token alert and image on in the basic preset", () => {
  const s = basicPreset("private")
  for (const a of TOKEN_ALERTS) expect(s.alerts[a]).toMatchObject({ on: true, image: true })
  expect(s.alerts.bonding.marks).toEqual([8000, 9000])
  expect(s.alerts.big.pctBps).toBe(500)
})

it("merges stored settings over defaults so new fields get defaults", () => {
  const s = readSettings({ alerts: { new: { on: false } }, thread: 7 }, "private")
  expect(s.alerts.new).toEqual({ on: false, image: true })
  expect(s.alerts.pumping.on).toBe(true)
  expect(s.thread).toBe(7)
  expect(readSettings(null, "private")).toEqual(basicPreset("private"))
})

it("drops invalid marks and thresholds", () => {
  const s = readSettings(
    { alerts: { bonding: { marks: [8000, 1234] }, big: { pctBps: 77 } } },
    "private",
  )
  expect(s.alerts.bonding.marks).toEqual([8000])
  expect(s.alerts.big.pctBps).toBe(500)
})

it("turns all alerts off but keeps routing", () => {
  const s = allOff({ ...basicPreset("private"), thread: 3, routes: { new: 9 } })
  for (const a of ALERTS) expect(s.alerts[a].on).toBe(false)
  expect(s.thread).toBe(3)
  expect(s.routes).toEqual({ new: 9 })
})

it("orders priorities as decided", () => {
  expect(PRIORITY).toEqual({
    notice: 0,
    devsell: 0,
    bonded: 1,
    summary: 1,
    soldout: 1,
    bonding: 2,
    mintstart: 2,
    mintlive: 2,
    reminder: 2,
    rare: 2,
    pumping: 3,
    upcoming: 3,
    minted: 3,
    under: 3,
    sweep: 3,
    bigsale: 3,
    launch: 3,
    big: 4,
    floor: 4,
    new: 5,
    sale: 5,
  })
})

it("gives the 3-minute NFT kinds no long window and the others 30 minutes", () => {
  for (const k of ["mintstart", "mintlive", "reminder", "under", "rare"])
    expect(LONG_WINDOW).not.toContain(k)
  for (const k of ["upcoming", "minted", "soldout", "launch", "floor", "sweep", "bigsale", "sale"])
    expect(LONG_WINDOW).toContain(k)
})

it("DM defaults have the seven All collections kinds on, minted at 50% and big sale at 0.1 ETH", () => {
  const s = basicPreset("private")
  for (const k of NFT_ALL_ALERTS) expect(s.alerts[k]).toMatchObject({ on: true, image: true })
  expect(s.alerts.minted.marks).toEqual([5000])
  expect(s.alerts.bigsale.minWei).toBe("100000000000000000")
})

it("group and channel defaults have the seven All collections kinds off", () => {
  for (const t of ["group", "supergroup", "channel"] as const) {
    const s = basicPreset(t)
    for (const k of NFT_ALL_ALERTS) expect(s.alerts[k].on).toBe(false)
    expect(s.alerts.minted.marks).toEqual([5000])
  }
})

it("watched-only kinds default on except sale, for DMs and groups alike", () => {
  for (const t of ["private", "supergroup"] as const) {
    const s = basicPreset(t)
    for (const k of NFT_WATCHED_ALERTS) expect(s.alerts[k].on).toBe(k !== "sale")
    expect(s.alerts.under.pctBps).toBe(2000)
    expect(s.alerts.rare.topBps).toBe(1000)
    expect(s.alerts.floor.pctBps).toBe(2000)
    expect(s.alerts.sweep.items).toBe(5)
  }
})

it("sale defaults to off with a 0.05 ETH minimum", () => {
  expect(basicPreset("private").alerts.sale).toEqual({
    on: false,
    image: true,
    minWei: "50000000000000000",
  })
})

it("reminder has no image field", () => {
  expect(basicPreset("private").alerts.reminder).toEqual({ on: true })
  const s = readSettings({ alerts: { reminder: { on: false, image: false } } }, "private")
  expect(s.alerts.reminder).toEqual({ on: false })
})

it("stored token settings without NFT keys read with the chat type defaults", () => {
  const stored = { alerts: { new: { on: false, image: true } } }
  expect(readSettings(stored, "private").alerts.upcoming.on).toBe(true)
  expect(readSettings(stored, "supergroup").alerts.upcoming.on).toBe(false)
})

it("invalid NFT thresholds fall back", () => {
  const s = readSettings(
    {
      alerts: {
        minted: { marks: [5000, 1234] },
        bigsale: { minWei: "7" },
        under: { pctBps: 5 },
        rare: { topBps: "x" },
        floor: { pctBps: 1 },
        sweep: { items: 7 },
        sale: { minWei: 5 },
      },
    },
    "private",
  )
  expect(s.alerts.minted.marks).toEqual([5000])
  expect(s.alerts.bigsale.minWei).toBe("100000000000000000")
  expect(s.alerts.under.pctBps).toBe(2000)
  expect(s.alerts.rare.topBps).toBe(1000)
  expect(s.alerts.floor.pctBps).toBe(2000)
  expect(s.alerts.sweep.items).toBe(5)
  expect(s.alerts.sale.minWei).toBe("50000000000000000")
})

it("keeps valid NFT thresholds", () => {
  const s = readSettings(
    {
      alerts: {
        minted: { marks: [2500, 7500] },
        bigsale: { minWei: "500000000000000000" },
        sale: { minWei: "0" },
        sweep: { items: 10 },
      },
    },
    "private",
  )
  expect(s.alerts.minted.marks).toEqual([2500, 7500])
  expect(s.alerts.bigsale.minWei).toBe("500000000000000000")
  expect(s.alerts.sale.minWei).toBe("0")
  expect(s.alerts.sweep.items).toBe(10)
})

it("ALERT_PATTERN matches every kind", () => {
  const re = new RegExp(`^(${ALERT_PATTERN})$`)
  for (const a of ALERTS) expect(re.test(a)).toBe(true)
  expect(re.test("junk")).toBe(false)
})

it("labels every kind, and REMINDERS names the setting", () => {
  for (const a of ALERTS) expect(ALERT_LABEL[a]).toBeTruthy()
  expect(ALERT_LABEL.reminder).toBe("MINT REMINDER")
  expect(SETTINGS_LABEL.reminder).toBe("REMINDERS")
  expect(SETTINGS_LABEL.under).toBe("UNDER FLOOR")
})

it("resetScreen restores one screen and keeps routes", () => {
  const s = basicPreset("private")
  s.thread = 4
  s.routes = { new: 9 }
  s.pausedRoutes = ["new"]
  s.alerts.new.on = false
  s.alerts.bigsale.on = false
  s.alerts.bigsale.minWei = "500000000000000000"
  s.alerts.under.pctBps = 3000
  const nft = resetScreen(s, "nft_all", "private")
  expect(nft.alerts.bigsale).toEqual(basicPreset("private").alerts.bigsale)
  expect(nft.alerts.new.on).toBe(false)
  expect(nft.alerts.under.pctBps).toBe(3000)
  expect(nft.thread).toBe(4)
  expect(nft.routes).toEqual({ new: 9 })
  expect(nft.pausedRoutes).toEqual(["new"])
  expect(resetScreen(s, "nft_watched", "private").alerts.under.pctBps).toBe(2000)
  expect(resetScreen(s, "token", "private").alerts.new.on).toBe(true)
  // The input is not changed.
  expect(s.alerts.bigsale.on).toBe(false)
})

it("ALERT_DESC follows the chosen thresholds", () => {
  const s = basicPreset("private")
  expect(ALERT_DESC("big", s)).toBe(
    "BIG BUY/SELL - one trade worth 5%+ of the token's bond target.",
  )
  s.alerts.big.pctBps = 250
  expect(ALERT_DESC("big", s)).toBe(
    "BIG BUY/SELL - one trade worth 2.5%+ of the token's bond target.",
  )
  expect(ALERT_DESC("bigsale", s)).toBe("BIG SALE - When an NFT sells for 0.1 ETH or more.")
  s.alerts.bigsale.minWei = "250000000000000000"
  expect(ALERT_DESC("bigsale", s)).toBe("BIG SALE - When an NFT sells for 0.25 ETH or more.")
  expect(ALERT_DESC("under", s)).toBe("UNDER FLOOR - an item lists 20%+ under floor.")
  s.alerts.under.pctBps = 3000
  expect(ALERT_DESC("under", s)).toBe("UNDER FLOOR - an item lists 30%+ under floor.")
  expect(ALERT_DESC("rare", s)).toBe("RARE LISTING - a top 10% item lists near floor.")
  s.alerts.rare.topBps = 100
  expect(ALERT_DESC("rare", s)).toBe("RARE LISTING - a top 1% item lists near floor.")
  expect(ALERT_DESC("floor", s)).toBe("FLOOR MOVE - the floor moves 20%+ in 24h.")
  expect(ALERT_DESC("sweep", s)).toBe("SWEEP - one wallet buys 5+ items in 10 min.")
  s.alerts.sweep.items = 10
  expect(ALERT_DESC("sweep", s)).toBe("SWEEP - one wallet buys 10+ items in 10 min.")
  expect(ALERT_DESC("sale", s)).toBe("SOLD - an item sells for 0.05 ETH or more.")
  expect(ALERT_DESC("reminder", s)).toBe("REMINDERS - a message 15 min before each mint stage.")
  expect(ALERT_DESC("mintlive", s)).toBe("MINT LIVE - A mint without any mint stages goes live.")
})

it('ALERT_DESC reads "at any price" when the SOLD minimum is any', () => {
  const s = basicPreset("private")
  s.alerts.sale.minWei = "0"
  expect(ALERT_DESC("sale", s)).toBe("SOLD - an item sells at any price.")
})
