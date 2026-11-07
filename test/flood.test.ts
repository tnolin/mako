import { describe, expect, it } from "vitest"
import {
  FLOOD_LAUNCHES,
  FLOOD_WINDOW_S,
  floodRows,
  floodStarts,
  type LaunchMark,
} from "../src/delivery/flood"
import { addr, launch } from "./helpers/events"

const seq = (
  n: number,
  o: { from?: number; ts0?: number; gap?: number; lp?: string } = {},
): LaunchMark[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String((o.from ?? 1) + i),
    launchpad: o.lp ?? "inkypump",
    ts: (o.ts0 ?? 1_000) + i * (o.gap ?? 1),
  }))

describe("floodStarts", () => {
  it("has no flood at exactly 10 launches in 5 minutes", () => {
    expect(floodStarts(seq(FLOOD_LAUNCHES)).size).toBe(0)
  })

  it("starts a flood at the 11th launch and keeps its start id", () => {
    const m = floodStarts(seq(15))
    expect([...m.keys()]).toEqual(["11", "12", "13", "14", "15"])
    expect(new Set(m.values())).toEqual(new Set(["11"]))
  })

  it("counts only launches inside the 5-minute window", () => {
    // 11 launches 31 s apart span 310 s, so no launch ever sees more than 10 in 300 s.
    expect(floodStarts(seq(11, { gap: 31 })).size).toBe(0)
  })

  it("ends when the count drops to 10 or fewer, and a later flood gets a new start", () => {
    const first = seq(12) // flood at 11, 12
    const later = seq(12, { from: 13, ts0: 1_000 + FLOOD_WINDOW_S + 100 }) // window cleared, flood again at the 11th
    const m = floodStarts([...first, ...later])
    expect(m.get("11")).toBe("11")
    expect(m.has("13")).toBe(false) // first launch after the gap: count 1
    expect(m.get("23")).toBe("23")
    expect(m.get("24")).toBe("23")
  })

  it("keeps launchpads apart", () => {
    const busy = seq(12, { lp: "inkypump" })
    const quiet = seq(3, { from: 100, lp: "other" })
    const m = floodStarts([...busy, ...quiet])
    expect(m.has("100") || m.has("101") || m.has("102")).toBe(false)
    expect(m.get("12")).toBe("11")
  })

  it("orders same-second launches by id", () => {
    const m = floodStarts(seq(12, { gap: 0 }))
    expect(m.has("10")).toBe(false)
    expect(m.get("11")).toBe("11")
  })
})

describe("floodRows", () => {
  it("names ink.fun in the flood notice and the minute card", () => {
    const flooded = Array.from({ length: 2 }, (_, i) => ({
      id: String(i + 1),
      writtenTs: 1_000,
      p: launch({ launchpad: "inkfun", token: addr(0x100 + i), blockTimestamp: 1_000 + i }),
    }))
    const rows = floodRows(
      flooded,
      new Map([
        ["1", "1"],
        ["2", "1"],
      ]),
      [{ chatId: "501", chatType: "private", threadId: null }],
    )
    expect(rows.map((r) => r.payload)).toEqual([
      expect.objectContaining({
        type: "text",
        html: expect.stringContaining("launching on ink.fun at once"),
      }),
      expect.objectContaining({ type: "newtokens", launchpad: "ink.fun" }),
    ])
  })

  it("leaves a custom-hook launch out of the minute card but still counts it in the flood (synthetic)", () => {
    const mk = (i: number, customHook: boolean) => ({
      id: String(i + 1),
      writtenTs: 1_000,
      p: launch({
        launchpad: "hookit",
        token: addr(0x200 + i),
        ticker: `T${i}`,
        customHook,
        blockTimestamp: 1_000 + i,
      }),
    })
    const flooded = [mk(0, false), mk(1, true), mk(2, false)]
    const starts = new Map(flooded.map((l) => [l.id, "1"]))
    const rows = floodRows(flooded, starts, [
      { chatId: "501", chatType: "private", threadId: null },
    ])
    const card = rows.find((r) => r.payload.type === "newtokens")!.payload as {
      entries: { ticker: string }[]
    }
    expect(card.entries.map((e) => e.ticker)).toEqual(["T0", "T2"])
    // One notice for the flood, however many of its launches are listed.
    expect(rows.filter((r) => r.payload.type === "text")).toHaveLength(1)
  })

  it("sends no minute card when every flooded launch has a custom hook (synthetic)", () => {
    const flooded = [0, 1].map((i) => ({
      id: String(i + 1),
      writtenTs: 1_000,
      p: launch({
        launchpad: "hookit",
        token: addr(0x300 + i),
        customHook: true,
        blockTimestamp: 1_000 + i,
      }),
    }))
    const rows = floodRows(
      flooded,
      new Map([
        ["1", "1"],
        ["2", "1"],
      ]),
      [{ chatId: "501", chatType: "private", threadId: null }],
    )
    expect(rows.map((r) => r.payload.type)).toEqual(["text"])
  })
})
