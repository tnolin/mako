# 0021. PUMPING after bonding

Date: 2026-10-30
Status: Accepted

## Context

PUMPING measured a token's curve: 15 points of progress in 10 minutes. After bonding a token has no curve, and its pool trades are now indexed with a market cap on every swap. A pool can move much faster than a curve, and pools of small tokens are thin.

## Decision

- **One PUMPING switch.** On the curve the alert is unchanged. After bonding, the same alert measures the market cap: the gain of a swap's market cap over the lowest market cap of the same pool's swaps in the trailing 10 minutes. The window shown on the card runs from that low to the swap.
- **A threshold per chat.** +15%, +20%, +30% or +50%, default +20%.
- **A market cap minimum for feeds.** $25K, $50K, $100K or $250K, default $50K. Feeds need a current USD price to check it. Watchers skip it, and use their own threshold.
- **Re-arm in place of a cooldown.** The curve version waits an hour per chat and token. After bonding, PUMPING fires once per chat and token and re-arms when the token's 10-minute gain falls under +5%. Every swap reports its gain, including those under every threshold, so the re-arm sees each dip.
- **Event order within a batch.** The re-arm state is read and written in event order while routing, on a draft per poll batch. Each write commits the changes of the events the cursor has passed, so a failed write is routed again from the state its written events left.
- **In memory.** The state is not persisted. A restart can repeat one PUMPING per chat and token.
- The card shows the gain, market cap, ath with the drawdown from it, liquidity, volume, trades and buying wallets in the window, the creator's holdings, and the time since bonding (age for a token that started in a pool).

## Consequences

- A token that keeps climbing sends one PUMPING, not one an hour, until it pulls back under +5%.
- Chats tune bonded PUMPING without touching the curve version, whose threshold stays fixed.
- After a deploy a pump in progress can alert again once.
