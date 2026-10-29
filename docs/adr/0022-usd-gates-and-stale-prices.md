# 0022. USD gates and stale prices

Date: 2026-10-30
Status: Accepted

## Context

Events carry amounts in their quote asset: ETH or an xStock. Three decisions now depend on a USD value: the PUMPING feed minimum, a minimum size for pool BIG BUY/SELL, and MCAP TARGET. The USD prices come from outside the indexer and can go stale (`src/prices.ts`: ETH/USD fresh for 10 minutes, xStocks for 30).

## Decision

Each gate does nothing rather than guess when its price is stale:

- **PUMPING feed minimum:** without a current price, bonded PUMPING does not reach feeds. Watchers still get it, since they skip the minimum.
- **Pool BIG BUY/SELL:** a pool trade must be worth $500 or more, since a thin pool makes small trades look large against its quote side. Without a price, no pool BIG is sent. Curve BIG is sized against the bond target and needs no price.
- **MCAP TARGET:** without a price, no target fires or clears, and no target can be set. The first fresh event past the target after the price returns fires it.

Quote amounts are converted assuming 18 decimals, which holds for every quote asset indexed today. A quote with other decimals, such as USDG, needs per-asset decimals before it gets a USD price.

## Consequences

- A price outage silences these alerts for feeds instead of sending wrong ones. Watchers keep PUMPING.
- MCAP TARGET can fire late after an outage, but not wrongly, and not twice.
