# 0012. Launch flood mode

Date: 2026-10-15
Status: Accepted

## Context

On 24 Aug InkyPump had 552 launches in 61 seconds. With one NEW TOKEN alert per launch, every chat with NEW TOKEN on would get hundreds of alerts at Telegram's pacing, and most would be dropped as stale.

## Decision

- A launch is in flood when its launchpad had more than 10 launches in the 5 minutes up to and including it, by block timestamp. A flood starts at the first such launch and ends at the first launch back at 10 or fewer. The thresholds are constants in `src/delivery/flood.ts`.
- Detection reads only launch events, with no stored state, so a crash, a re-run or a replay classifies every launch the same way.
- While a launchpad is in flood, its launches queue no individual NEW TOKEN alerts. Every chat with NEW TOKEN on gets one notice per flood and one NEW TOKENS card per minute of launches, routed like NEW TOKEN.
- A card row is created when its minute's first flooded launch is read and held with `send_after` until the minute ends plus 30 seconds. Later launches of that minute are appended to the pending row once each.
- The sender orders a chat's rows from the same poller pass by event time, so the notice follows the individual alerts before it.

## Consequences

- A flood minute's card arrives 30 to 90 seconds after its launches.
- A launch that is read after its minute's card was sent appears in no card.
- Other launchpads and other alert types are unaffected.
