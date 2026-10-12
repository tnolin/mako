import { expect, it } from "vitest"
import { pnlText, quoteText, valueText } from "../src/cards/money"
import type { Prices } from "../src/prices"

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
