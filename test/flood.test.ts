import { describe, expect, it } from "vitest"
import { FLOOD_LAUNCHES, FLOOD_WINDOW_S, floodStarts, type LaunchMark } from "../src/delivery/flood"

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
