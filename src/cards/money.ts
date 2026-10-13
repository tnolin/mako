import { amount, units, usd } from "../format"
import type { Prices } from "../prices"

/** "0.42 ETH ($1.1K)", or "0.42 ETH" without a price. Quote assets have 18 decimals. */
export function quoteText(
  raw: string | bigint,
  quote: string,
  prices: Prices,
  withUsd = true,
): string {
  const n = units(raw)
  const text = `${amount(n)} ${prices.symbol(quote)}`
  const p = withUsd ? prices.usd(quote) : null
  return p === null ? text : `${text} (${usd(n * p)})`
}

/** Market cap and volume: dollars when priced, otherwise the quote amount. */
export function valueText(raw: string | bigint, quote: string, prices: Prices): string {
  const n = units(raw)
  const p = prices.usd(quote)
  return p === null ? `${amount(n)} ${prices.symbol(quote)}` : usd(n * p)
}

/** "+2.40 ETH (+840%)". The percentage is realized over the cost basis of tokens sold. */
export function pnlText(realized: bigint, basis: bigint, quote: string, prices: Prices): string {
  const sign = realized < 0n ? "−" : "+"
  const abs = realized < 0n ? -realized : realized
  const text = `${sign}${amount(units(abs))} ${prices.symbol(quote)}`
  if (basis <= 0n) return text
  return `${text} (${sign}${Number((abs * 100n) / basis)}%)`
}
