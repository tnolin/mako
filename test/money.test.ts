import { expect, it } from "vitest"
import { pnlText, quoteText, quoteUnits, valueText } from "../src/cards/money"
import type { Prices } from "../src/prices"
import { QUOTE_ASSETS } from "../src/quotes"
import { loadTsunami } from "./helpers/fixtures"

const NATIVE = "0x0000000000000000000000000000000000000000"
const NVDAX = "0xa8ddb5cd96b5222afe198316e9a57caa642850d5"
const priced: Prices = {
  usd: (q) => (q === NATIVE ? 2500 : 229.75),
  symbol: (q) => (q === NATIVE ? "ETH" : "NVDAx"),
}
const unpriced: Prices = { usd: () => null, symbol: priced.symbol }
const e = (n: number) => String(BigInt(Math.round(n * 1e6)) * 10n ** 12n)

it("adds dollars when a price exists", () => {
  expect(quoteText(e(0.42), NATIVE, priced)).toBe("0.42 ETH ($1.1K)")
  expect(quoteText(e(12.5), NVDAX, priced)).toBe("12.50 NVDAx ($2.9K)")
  expect(valueText(e(84.8), NATIVE, priced)).toBe("$212K")
})

it("shows quote amounts only when no price exists, never $NaN or $0", () => {
  expect(quoteText(e(0.42), NATIVE, unpriced)).toBe("0.42 ETH")
  expect(valueText(e(8.12), NATIVE, unpriced)).toBe("8.12 ETH")
  expect(valueText("0", NATIVE, unpriced)).toBe("0.00 ETH")
})

it("signs PnL and omits the percentage without a cost basis", () => {
  expect(pnlText(BigInt(e(2.4)), BigInt(e(0.2857)), NATIVE, priced)).toBe("+2.40 ETH (+840%)")
  expect(pnlText(-BigInt(e(0.5)), BigInt(e(2.5)), NATIVE, priced)).toBe("−0.50 ETH (−20%)")
  expect(pnlText(BigInt(e(1)), 0n, NATIVE, priced)).toBe("+1.00 ETH")
})

const USDC = "0x2d270e6886d130d724215a266106e6832161eaed"
const KBTC = "0x73e0c0d45e048d25fc26fa3159b0aa04bfa4db98"
const SOLVBTC = "0xae4efbc7736f963982aacb17efa37fcbab924cb3"

it("21,215 USDC base units read as 0.021215 USDC", () => {
  // The closing buy of a recorded USDC-quoted graduation.
  const { closingBuy } = loadTsunami().usdc
  expect(closingBuy.quoteAmount).toBe("21215")
  expect(quoteUnits(closingBuy.quoteAmount, USDC)).toBeCloseTo(0.021215, 9)
})

it("300,000,000 kBTC base units read as 3 kBTC (synthetic amount)", () => {
  expect(quoteUnits("300000000", KBTC)).toBe(3)
})

it("SolvBTC uses 18 decimals", () => {
  expect(quoteUnits(String(10n ** 18n), SOLVBTC)).toBe(1)
})

it("a quote with no table entry reads 18 decimals, as ETH does", () => {
  expect(quoteUnits(String(10n ** 18n), NATIVE)).toBe(1)
  expect(quoteUnits(String(10n ** 18n), `0x${"ab".repeat(20)}`)).toBe(1)
})

it("values a USDC pool's market cap in dollars at 6 decimals", () => {
  // The first swap in a recorded USDC pool: market cap 2,490,887 base units.
  const { swap } = loadTsunami().usdc
  const usdc: Prices = { usd: () => 1, symbol: () => "USDC" }
  expect(valueText(swap.marketCap, USDC, usdc)).toBe("$2")
  expect(valueText(swap.marketCap, USDC, { ...usdc, usd: () => null })).toBe("2.49 USDC")
})

it("hNVDAx3L, kHYPE and wNFLXx show their symbols", () => {
  // Read from each token contract; wNFLXx is also in the seeded xStocks list, which shows the unwrapped name.
  const symbolOf = (a: string) => QUOTE_ASSETS[a]?.symbol
  expect(symbolOf("0xc0af15b3eb4a13a47a13cc9d455ddaa353fa8271")).toBe("hNVDAx3L")
  expect(symbolOf("0xad09cd20e513e4d8cb78036f77ab9afde8555929")).toBe("kHYPE")
  expect(symbolOf("0x7d87fd6a379714194a797c0bbb8b40c30d250856")).toBe("wNFLXx")
  for (const a of [
    "0xc0af15b3eb4a13a47a13cc9d455ddaa353fa8271",
    "0xad09cd20e513e4d8cb78036f77ab9afde8555929",
    "0x7d87fd6a379714194a797c0bbb8b40c30d250856",
  ])
    expect(quoteUnits(String(10n ** 18n), a)).toBe(1)
})
