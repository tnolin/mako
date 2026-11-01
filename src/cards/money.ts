import { amount, units, usd } from "../format"
import type { Prices } from "../prices"
import { quoteDecimals } from "../quotes"

/** A quote amount in whole units of its own currency (6, 8 or 18 decimals). */
export const quoteUnits = (raw: string | bigint, quote: string): number =>
  units(raw, quoteDecimals(quote))

/** "0.42 ETH ($1.1K)", or "0.42 ETH" without a price. */
export function quoteText(
  raw: string | bigint,
  quote: string,
  prices: Prices,
  withUsd = true,
): string {
  const n = quoteUnits(raw, quote)
  const text = `${amount(n)} ${prices.symbol(quote)}`
  const p = withUsd ? prices.usd(quote) : null
  return p === null ? text : `${text} (${usd(n * p)})`
}

/** Market cap and volume: dollars when priced, otherwise the quote amount. */
export function valueText(raw: string | bigint, quote: string, prices: Prices): string {
  const n = quoteUnits(raw, quote)
  const p = prices.usd(quote)
  return p === null ? `${amount(n)} ${prices.symbol(quote)}` : usd(n * p)
}

/** "+2.40 ETH (+840%)". The percentage is realized over the cost basis of tokens sold. */
export function pnlText(realized: bigint, basis: bigint, quote: string, prices: Prices): string {
  const sign = realized < 0n ? "−" : "+"
  const abs = realized < 0n ? -realized : realized
  const text = `${sign}${amount(quoteUnits(abs, quote))} ${prices.symbol(quote)}`
  if (basis <= 0n) return text
  return `${text} (${sign}${Number((abs * 100n) / basis)}%)`
}
