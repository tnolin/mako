import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { createPrices, NATIVE, parseKraken, parseXstocks } from "../src/prices"

const fixture = (f: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/prices/${f}`, import.meta.url), "utf8"))
const NVDAX = "0xa8ddb5cd96b5222afe198316e9a57caa642850d5"
const WAMZNX = "0x910cabde3eba7fc1ce64fd14bd680b9f60fa0f90"
const USDG = "0xe343167631d89b6ffc58b88d6b7fb0228795491d"
const USDC = "0x2d270e6886d130d724215a266106e6832161eaed"
const USDT0 = "0x0200c29006150606b650577bbe7b6248f58470c1"
const WETH = "0x4200000000000000000000000000000000000006"
const KBTC = "0x73e0c0d45e048d25fc26fa3159b0aa04bfa4db98"
const UNIBTC = "0xd3c8da379d71a33bfee8875f87ac2748beb1d58d"
const SOLVBTC = "0xae4efbc7736f963982aacb17efa37fcbab924cb3"

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
    expect(prices.symbol(KBTC)).toBe("kBTC")
  })

  it("an unknown quote shows its short address", () => {
    const { prices } = setup({})
    expect(prices.symbol("0x2d270e6886d130d724215a266106e6832161aeed")).toBe("0x2d27…aeed")
  })

  it("InkyPump's wrapper symbol still wins for w…x wrappers", async () => {
    const { prices } = setup({
      kraken: { error: [], result: { XETHZUSD: { c: ["2500", "1"] } } },
      inky: {
        assets: [
          { wrapperAddress: NVDAX, symbol: "NVDAx", valuation: null },
          { wrapperAddress: WAMZNX, symbol: "AMZNx", valuation: null },
        ],
      },
    })
    expect(prices.symbol(WAMZNX)).toBe("wAMZNx")
    await prices.refresh()
    expect(prices.symbol(NVDAX)).toBe("NVDAx")
    expect(prices.symbol(WAMZNX)).toBe("AMZNx")
  })

  it("prices USDG, USDC and USD₮0 at $1 without any fetch", () => {
    const { prices } = setup({})
    for (const q of [USDG, USDC, USDT0]) expect(prices.usd(q)).toBe(1)
  })

  it("prices WETH like ETH, and drops it when ETH goes stale", async () => {
    const { prices, advance } = setup({
      kraken: { error: [], result: { XETHZUSD: { c: ["2500.5", "1"] } } },
      inky: { assets: [{ wrapperAddress: NVDAX, symbol: "NVDAx", valuation: null }] },
    })
    expect(prices.usd(WETH)).toBeNull()
    await prices.refresh()
    expect(prices.usd(WETH)).toBe(2500.5)
    advance(11 * 60_000)
    expect(prices.usd(WETH)).toBeNull()
  })

  it("has no USD price for kBTC, uniBTC or SolvBTC", async () => {
    const { prices } = setup({
      kraken: { error: [], result: { XETHZUSD: { c: ["2500.5", "1"] } } },
      inky: { assets: [{ wrapperAddress: NVDAX, symbol: "NVDAx", valuation: null }] },
    })
    await prices.refresh()
    for (const q of [KBTC, UNIBTC, SOLVBTC]) expect(prices.usd(q)).toBeNull()
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
