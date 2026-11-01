# 0023. Pool state views and quote decimals

Date: 2026-11-01
Status: Accepted

## Context

Graduated tokens trade in Uniswap v4 pools held by more than one PoolManager: Uniswap's and Calamari's. Each PoolManager has its own StateView, and a token's pool can move to a new pool id after it graduates. Quote currencies are no longer all 18 decimals: USDC, USDG and USD₮0 have 6, kBTC and uniBTC have 8.

## Decision

- **StateView by PoolManager.** `/t` reads a bonded token's market cap from the StateView that belongs to the pool's PoolManager (`STATE_VIEWS` in `src/pool.ts`). A pool whose PoolManager is not in the table gets no live market cap and no node call; the card shows the market cap at the token's last bonding-curve trade instead. The price cache is keyed by PoolManager and pool id.
- **The pool a token trades in now.** `/t` reads the pool of the token's latest swap, and the bond's pool until it has one, so a token whose pool moved shows the market cap of the pool it trades in.
- **Raw quote units.** A pool price is a ratio of base units, so the market cap comes out in the quote's own base units whatever its decimals.
- **Quote symbols and decimals from a table.** `QUOTE_ASSETS` in `src/quotes.ts` lists the symbol and decimals of each quote currency a Tsunami token can launch against. Amounts are converted with the quote's decimals; a quote missing from the table is read as 18 decimals and shown as a short address.
- **Symbol order.** Native ETH, then the symbol InkyPump's list gives a wrapper, then the built-in InkyPump wrapper symbols, then `QUOTE_ASSETS`, then a short address.
- **USD prices.** ETH and WETH use the ETH/USD price and its freshness rule. USDG, USDC and USD₮0 are fixed at $1. InkyPump's `w…x` wrappers use InkyPump's price. kBTC, uniBTC, SolvBTC and the other stock tokens have no USD price, so their cards show quote amounts and the USD-gated alerts (pool BIG BUY/SELL, MCAP TARGET, the PUMPING feed minimum) do not fire for them.

## Consequences

- A quote currency added after the table was written shows 18 decimals and its address until it is added to the table.
- This replaces the 18-decimal assumption in ADR 0022.
- Adding a PoolManager means adding its StateView to `STATE_VIEWS`.
