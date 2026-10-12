import { expect, it } from "vitest"
import { ALERTS, allOff, basicPreset, PRIORITY, readSettings } from "../src/settings"

it("turns every alert and image on in the basic preset", () => {
  const s = basicPreset()
  for (const a of ALERTS) expect(s.alerts[a]).toMatchObject({ on: true, image: true })
  expect(s.alerts.bonding.marks).toEqual([8000, 9000])
  expect(s.alerts.big.pctBps).toBe(500)
})

it("merges stored settings over defaults so new fields get defaults", () => {
  const s = readSettings({ alerts: { new: { on: false } }, thread: 7 })
  expect(s.alerts.new).toEqual({ on: false, image: true })
  expect(s.alerts.pumping.on).toBe(true)
  expect(s.thread).toBe(7)
  expect(readSettings(null)).toEqual(basicPreset())
})

it("drops invalid marks and thresholds", () => {
  const s = readSettings({ alerts: { bonding: { marks: [8000, 1234] }, big: { pctBps: 77 } } })
  expect(s.alerts.bonding.marks).toEqual([8000])
  expect(s.alerts.big.pctBps).toBe(500)
})

it("turns all alerts off but keeps routing", () => {
  const s = allOff({ ...basicPreset(), thread: 3, routes: { new: 9 } })
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
    bonding: 2,
    pumping: 3,
    big: 4,
    new: 5,
  })
})
