# 0011. Live market cap on bonded token cards

Date: 2026-10-14
Status: Accepted

## Context

The indexer does not record trades after a token bonds. A bonded token's card could only show its market cap at the moment it bonded.

## Decision

- A `/t` card for a bonded token makes one read-only `eth_call` to Uniswap v4's StateView on Ink, `getSlot0(poolId)`, with the `poolId` from the token's bond event. It uses the same RPC endpoint as the dev holds read, with a 3 s timeout.
- v4 orders a pool's currencies by address, and native ETH is always currency0. `sqrtPriceX96² / 2¹⁹²` is currency1 per currency0, so the market cap is `totalSupply × 2¹⁹² / sqrtPriceX96²` when the token is currency1 and `totalSupply × sqrtPriceX96² / 2¹⁹²` when it is currency0. Token and quote both use 18 decimals.
- Each pool's result is kept in memory for 15 seconds, and lookups at the same moment share one call.
- The card shows `bonded … ago` and a `mcap` row. If the read fails, the pool id is malformed or the pool has no price, the card shows the market cap at bond instead.
- Alerts never make this read.

## Consequences

- The bot makes a second kind of read-only RPC call, on the same endpoint as dev holds.
- A bonded `/t` lookup can take up to 3 s longer when the node is slow.
- The value is the pool's spot price. The InkyPump hook charges a fee on swaps but does not move the price.
- A pool with little liquidity can show a price that a real trade would not get.
