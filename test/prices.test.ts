import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { createPrices, NATIVE, parseKraken, parseXstocks } from "../src/prices"

const fixture = (f: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/prices/${f}`, import.meta.url), "utf8"))
const NVDAX = "0xa8ddb5cd96b5222afe198316e9a57caa642850d5"

describe("parsers", () => {
  it("reads the ETH/USD last trade from Kraken", () => {
    expect(parseKraken(fixture("kraken-ethusd.json"))).toBeGreaterThan(100)
    expect(parseKraken({ error: ["EQuery:Unknown asset pair"], result: {} })).toBeNull()
  })

  it("reads wrapper prices and symbols from InkyPump, keyed by lowercase wrapper", () => {
    const m = parseXstocks(fixture("inkypump-quote-assets.json"))
    expect(m.size).toBe(11)
    expect(m.get(NVDAX)?.symbol).toBe("NVDAx")
    expect(m.get(NVDAX)?.usd).toBeGreaterThan(1)
    const nulls = parseXstocks({
      assets: [{ wrapperAddress: "0xAB", symbol: "ABx", valuation: null }],
    })
    expect(nulls.get("0xab")).toEqual({ usd: null, symbol: "ABx" })
  })

  it("never turns a missing, empty or zero price into NaN or 0", () => {
    for (const wrapperPriceUsd of [undefined, null, "", "0", "abc"]) {
      const m = parseXstocks({
        assets: [{ wrapperAddress: "0xab", symbol: "ABx", valuation: { wrapperPriceUsd } }],
      })
      expect(m.get("0xab")?.usd).toBeNull()
    }
    for (const bad of [undefined, null, "", "0", "abc", "-1"]) {
      expect(parseKraken({ result: { XETHZUSD: { c: [bad] } } })).toBeNull()
    }
    expect(parseKraken(null)).toBeNull()
    expect(parseXstocks(null).size).toBe(0)
  })
})

describe("createPrices", () => {
  function setup(responses: Record<string, unknown>) {
    let t = 0
    const report = vi.fn()
    const fetchFn = vi.fn(async (url: string | URL) => {
      const key = String(url).includes("kraken") ? "kraken" : "inky"
      const body = responses[key]
      if (body instanceof Error) throw body
      return new Response(JSON.stringify(body))
    })
    const prices = createPrices({
      fetch: fetchFn as unknown as typeof fetch,
      now: () => t,
      log: () => {},
      report,
    })
    return { prices, report, advance: (ms: number) => (t += ms) }
  }

  it("serves nothing before the first fetch, so cards show quote amounts only", () => {
    const { prices } = setup({})
    expect(prices.usd(NATIVE)).toBeNull()
    expect(prices.usd(NVDAX)).toBeNull()
    expect(prices.symbol(NATIVE)).toBe("ETH")
    expect(prices.symbol(NVDAX)).toBe("NVDAx")
    expect(prices.symbol("0x0000000000000000000000000000000000000abc")).toBe("xStock")
  })

  it("serves null, not NaN or 0, when a price is null or a feed returns nothing usable", async () => {
    const { prices } = setup({
      kraken: { error: ["EQuery:Unknown asset pair"], result: {} },
      inky: { assets: [{ wrapperAddress: NVDAX, symbol: "NVDAx", valuation: null }] },
    })
    await prices.refresh()
    expect(prices.usd(NATIVE)).toBeNull()
    expect(prices.usd(NVDAX)).toBeNull()
    expect(prices.symbol(NVDAX)).toBe("NVDAx")
  })

  it("serves fresh prices and drops them when stale", async () => {
    const { prices, advance } = setup({
      kraken: { error: [], result: { XETHZUSD: { c: ["2500.5", "1"] } } },
      inky: {
        assets: [
          { wrapperAddress: NVDAX, symbol: "NVDAx", valuation: { wrapperPriceUsd: "229.75" } },
        ],
      },
    })
    await prices.refresh()
    expect(prices.usd(NATIVE)).toBe(2500.5)
    expect(prices.usd(NVDAX)).toBe(229.75)
    advance(11 * 60_000)
    expect(prices.usd(NATIVE)).toBeNull()
    expect(prices.usd(NVDAX)).toBe(229.75)
    advance(20 * 60_000)
    expect(prices.usd(NVDAX)).toBeNull()
  })

  it("keeps the last value on a failed fetch and reports once per 30-minute outage", async () => {
    const r = {
      kraken: { error: [], result: { XETHZUSD: { c: ["2500", "1"] } } } as unknown,
      inky: {
        assets: [
          { wrapperAddress: NVDAX, symbol: "NVDAx", valuation: { wrapperPriceUsd: "229.75" } },
        ],
      } as unknown,
    }
    const { prices, report, advance } = setup(r)
    await prices.refresh()
    r.kraken = new Error("network down")
    advance(5 * 60_000)
    await prices.refresh()
    expect(prices.usd(NATIVE)).toBe(2500) // last value kept while still fresh
    advance(6 * 60_000)
    await prices.refresh() // stale from here: the outage clock starts
    advance(30 * 60_000)
    await prices.refresh() // unusable for 30 minutes: one report
    await prices.refresh()
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[0]).toMatch(/ETH\/USD price unavailable/)
  })

  it("treats a zero-asset xStock response as a failure: keeps the old map and reports the outage", async () => {
    const r = {
      kraken: { error: [], result: { XETHZUSD: { c: ["2500", "1"] } } } as unknown,
      inky: {
        assets: [
          { wrapperAddress: NVDAX, symbol: "NVDAx", valuation: { wrapperPriceUsd: "229.75" } },
        ],
      } as unknown,
    }
    const { prices, report, advance } = setup(r)
    await prices.refresh()
    r.inky = { assets: [] }
    advance(20 * 60_000)
    await prices.refresh()
    expect(prices.usd(NVDAX)).toBe(229.75) // previous map kept while still fresh
    expect(prices.symbol(NVDAX)).toBe("NVDAx")
    advance(11 * 60_000)
    await prices.refresh() // stale from here: the outage clock starts
    expect(prices.usd(NVDAX)).toBeNull()
    advance(30 * 60_000)
    await prices.refresh()
    await prices.refresh()
    const xsReports = report.mock.calls.filter((c) =>
      /xStock\/USD price unavailable/.test(String(c[0])),
    )
    expect(xsReports).toHaveLength(1)
  })
})
