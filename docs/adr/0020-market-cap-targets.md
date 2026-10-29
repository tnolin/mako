# 0020. Market cap targets

Date: 2026-10-30
Status: Accepted

## Context

People watch a token to hear about it, but often what they want to know is whether it reaches a price. A market cap is easier to name than a token price: `/watch $GOBLO 500k`. Tokens now trade on the curve and, after bonding, in a pool; both kinds of event carry the market cap in quote units.

## Decision

- **The target lives on the watch row.** `bot.subscriptions` (users) and `bot.chat_token_watches` (groups and channels) gain `target_usd`, `target_up`, `target_set_usd` and `target_set_at` (migration 0008). A target needs a watch, so one row holds both, there is at most one target per token per user or chat, and removing the watch removes the target. A check constraint keeps targets off mute rows.
- **The direction is fixed when the target is set.** `target_up` is true when the target is above the market cap at that moment. The alert fires when the market cap is at or past the target in that direction, so a target set below the current value means "tell me if it drops to this".
- **No target without a price.** Setting one reads the token's newest trade or swap and the current USD price of its quote. Without both, the command refuses and changes nothing.
- **Fire once, then clear.** MCAP TARGET is a candidate bound to the one user or chat whose target fired. It skips feeds, the one-alert-per-event choice and cooldowns, so it arrives beside any other alert for the same trade. The delivery insert and the clearing of the target run in one transaction, and the update matches the target value the rule read, so a target replaced in between is not cleared and its stale delivery is not written.
- **Only fresh events fire it.** An event from before `target_set_at`, an event older than the alert's 30-minute queue window, or an event without a current price never fires or clears a target. The next fresh trade past the target does.
- **No switch.** MCAP TARGET is an alert kind (priority with BONDED) so a group can route it to a topic and hide its image. It is always on; a group whose MCAP TARGET route is paused gets nothing and keeps its target.
- **Lookup by name.** `/watch` finds a token by address, `$TICKER` or name. Several matches give a pick list, bonded tokens and tokens that started in a pool first, then by most recent trading.

## Consequences

- One target per token per user or chat. A second `/watch` with an amount replaces the first and says so.
- A target that fires while the chat's queue is backed up past 30 minutes is cleared and its delivery dropped as late. This needs the queue to be that far behind and is accepted; restoring the target on a late drop is the upgrade if it shows up.
- Targets are in USD while events are in quote units, so a quote whose USD price is unavailable holds its targets until the price returns.
