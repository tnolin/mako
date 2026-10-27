# 0019. MINT UPDATED

Date: 2026-10-27
Status: Accepted

## Context

The indexer writes a new `nft.drop` event each time a collection's drop page changes: a stage moves, a price or limit is edited, a stage is added or removed, the supply changes. A chat that watches the collection had no way to learn of this. UPCOMING MINT is sent once per collection, and MINT REMINDER is built from the schedule at send time.

## Decision

- A new `nft.drop` event is compared with the collection's previous `nft.drop`. `NftState.apply` returns the previous drop, as it already returns the previous collection snapshot.
- A MINT UPDATED candidate is made only when a previous drop exists, at least one shown field changed (price, starts, ends, limit, stages, supply), and the mint has not sold out or ended. Team stages are ignored on both sides of the comparison. Stages are matched between the two events by label.
- It is a watched-only alert. The rules make the candidate; routing sends it only to chats that watch the collection, and not to the All collections feed. A muted collection stays muted.
- It has no switch of its own. It is delivered under the chat's MINT REMINDER setting (REMINDERS), so a chat with that switch off gets neither.
- One card per event: the dedupe key is the collection contract and the event id.
- The card lists only what changed, as old → new with the stage label after ` · `, under a status row that says whether the mint is upcoming (with the first stage's start) or live (with the minted count).

## Consequences

- Watchers see schedule and price edits as they happen, including in a group that watches the collection.
- A drop edit made while the mint is live is reported, which the stage-start and minted alerts do not cover.
- Because the card is keyed by event id, several edits produce several cards. Only the late-event window (3 minutes for this kind) limits a burst of edits.
