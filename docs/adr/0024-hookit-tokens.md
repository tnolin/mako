# 0024. Hookit tokens

Date: 2026-11-07
Status: Accepted

## Context

Hookit tokens launch with Uniswap v4 hooks that change how their pool behaves. Some trade in a pool from the moment they launch, with no bonding curve. Some have several pools, each against a different quote currency. A pool's range can be narrower than the full price range, so a pool's liquidity can be more or less than twice its quote side, and counting twice the quote side read too high for a young pool that holds only one side. The rules written for curve launchpads, where a token has one pool that exists only after it bonds, need to cover these cases.

## Decision

- **Hooks row.** Every Hookit card shows a `hooks` row: NEW TOKEN, `/t` and the PUMPING, BIG BUY/SELL, DEV SELL, BONDING, BONDED and MCAP TARGET alerts. A Classic (bonding curve) token shows `Classic`. A Master token lists the modules its hook runs, from the launch event's `hookModules`, or `Master` when there are none. The value is cut at 31 characters, dropping whole module names from the end and adding ` +N` for the number dropped. A token with a custom hook shows `custom` and the hook's shortened address.
- **Tokens that start in a pool.** A token with no bonding curve gets NEW TOKEN without a `bonds at` row and `/t` with an age instead of a bonded time. It never gets BONDING or BONDED. Its pool alerts (PUMPING, BIG BUY/SELL, DEV SELL, MCAP TARGET) apply from launch.
- **Deepest pool.** For a token with more than one pool, the market cap, ATH, `/t`, PUMPING, MCAP TARGET and the price a `/watch` target is set against come from the pool with the most USD liquidity, taken from each pool's latest swap. Pools without a USD price are skipped. When no pool has a price, the pool of the latest swap is used. PUMPING and MCAP TARGET fire only from that pool, so a swap in a shallower pool does not move them.
- **Volume across pools.** Trading volume is summed in USD per swap. A swap in a quote with no USD price is left out of a USD total, so amounts in different currencies are never added together.
- **Big trades stay per pool.** BIG BUY and BIG SELL measure each swap against its own pool.
- **Liquidity row.** The `liquidity` row adds the quote side and the token side of the pool at the swap's price, using the swap's `tokenLiquidity`. When an event has no `tokenLiquidity`, it uses 2 x the quote side. For a full-range pool both sides are equal, so cards for other launchpads do not change.
- **Custom hooks.** A custom hook can do anything with a trade, so a token whose launch uses one is kept out of every feed and out of the Hot now, Near bonding and Recently bonded lists. Chats that watch the token still get its alerts. In a launch flood the token counts toward the flood but is left out of the grouped NEW TOKEN card.
- **Dev pnl.** The `dev pnl` row is left out when the dev's fills span more than one quote currency, because a total across currencies has no single unit.

## Consequences

- A token with many hook modules shows only the first few in the row, followed by the number left out.
- A multi-pair token's alerts follow its deepest pool, so a move in a shallower pool is not reported until that pool becomes the deepest.
- Hookit tokens whose quote has no USD price keep working for NEW TOKEN, `/t` and watches, but the USD-gated alerts do not fire for them, as in ADR 0023.
