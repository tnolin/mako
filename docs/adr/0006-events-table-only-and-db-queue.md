# 0006. Read only the events table; queue in Postgres

Date: 2026-10-12
Status: Accepted

## Context

The bot needs alert data and a durable send queue with per-chat throttles. The indexer's events table is the contract between the two repos.

## Decision

- In the database the bot reads only `indexer.events` and `indexer.cursors`, and production grants allow nothing else. Token metadata, dev stats and windows come from event payloads.
- The bot polls confirmed events every second after its own cursor. Dedupe keys from `(txHash, logIndex)` or the token absorb reorg re-inserts.
- `bot.deliveries` is the queue, the dedupe record and the metrics source. Rows older than 90 days roll into daily counts.
- The one chain read is `balanceOf` for `dev holds`, done outside any transaction.

## Consequences

- No coupling to the indexer's internal tables, and no change there when MAKO grows.
- A restart loses nothing; stale alerts are dropped by their event time.
