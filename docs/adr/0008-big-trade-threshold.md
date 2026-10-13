# 0008. BIG BUY/SELL threshold relative to the target raise

Date: 2026-10-12
Status: Accepted

## Context

Measured on all InkyPump V2 curve trades to 2026-10-10:
- Non-dev ETH trades: median 0.02 ETH, p90 0.10 ETH, p99 about 0.25 ETH, and the largest 0.65 ETH.
- Targets range from 1 to 5 ETH, plus xStocks-quoted launches.
- As a share of target: p50 0.9%, p90 3.8%, p95 5.8%, p99 10.1%.

## Decision

- BIG fires when one trade is at least 5% of the launch's target raise. Users and groups can choose 2.5%, 5% or 10%.
- Trades in the launch transaction never count. A creator's sell is a DEV SELL, not a BIG SELL.

## Consequences

- About 6 alerts a day across all tokens in busy weeks.
- No currency conversion is needed for xStocks pairs.
