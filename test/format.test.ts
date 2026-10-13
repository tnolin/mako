import { describe, expect, it } from "vitest"
import {
  age,
  amount,
  bar,
  bpsChange,
  buysSells,
  clean,
  compact,
  count,
  escapeHtml,
  pct1,
  safeUrl,
  units,
  usd,
} from "../src/format"

describe("numbers", () => {
  it.each([
    [950, "$950"],
    [88_000, "$88.0K"],
    [99_949, "$99.9K"],
    [212_400, "$212K"],
    [1_234_000, "$1.2M"],
    [2_500_000_000, "$2.5B"],
  ])("usd(%d) = %s", (n, s) => expect(usd(n)).toBe(s))

  it("formats quote amounts with 2 decimals, 4 below 0.01, and thousands separators", () => {
    expect(amount(0.42)).toBe("0.42")
    expect(amount(0.0049)).toBe("0.0049")
    expect(amount(1234.5)).toBe("1,234.50")
  })

  it("formats token amounts compactly", () => {
    expect(compact(12_400_000)).toBe("12.4M")
    expect(compact(1_200_000_000)).toBe("1.2B")
    expect(compact(214_000_000)).toBe("214M")
    expect(compact(950)).toBe("950")
  })

  it("converts base units", () => {
    expect(units("420000000000000000")).toBeCloseTo(0.42)
    expect(units(10n ** 27n)).toBe(1e9)
  })

  it("formats percentages and counts", () => {
    expect(pct1(4.1234)).toBe("4.1%")
    expect(count(1204)).toBe("1,204")
  })
})

describe("text pieces", () => {
  it.each([
    [45 * 60, "45m"],
    [2 * 3600 + 14 * 60, "2h 14m"],
    [3 * 86400 + 2 * 3600, "3d 2h"],
    [20, "1m"],
  ])("age(%d) = %s", (s, out) => expect(age(s)).toBe(out))

  it("pluralises buys and sells", () => {
    expect(buysSells(1, 3)).toBe("1 buy | 3 sells")
    expect(buysSells(142, 1)).toBe("142 buys | 1 sell")
  })

  it.each([
    [0, "□□□□□□□□□□ 0%"],
    [999, "□□□□□□□□□□ 9%"],
    [1000, "■□□□□□□□□□ 10%"],
    [8040, "■■■■■■■■□□ 80%"],
    [10000, "■■■■■■■■■■ 100%"],
  ])("bar(%d)", (bps, out) => expect(bar(bps)).toBe(out))

  it("formats soldBps changes with a real minus sign", () => {
    expect(bpsChange(400)).toBe("(+4%)")
    expect(bpsChange(-310)).toBe("(−3%)")
  })
})

describe("creator text", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<b>"x" & y</b>`)).toBe("&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;")
  })

  it("strips control and bidi characters, trims and cuts", () => {
    expect(clean(" a‮b\u0007c⁦ ", 64)).toBe("abc")
    expect(clean("x".repeat(70), 64)).toHaveLength(64)
    expect(clean(null, 64)).toBe("")
  })

  it("keeps only http(s) links", () => {
    expect(safeUrl("https://x.com/fin")).toBe("https://x.com/fin")
    expect(safeUrl("javascript:alert(1)")).toBeNull()
    expect(safeUrl("t.me/fin")).toBeNull()
    expect(safeUrl(null)).toBeNull()
  })
})
