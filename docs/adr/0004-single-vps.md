# 0004. One VPS for indexer, bot and Postgres

Date: 2026-10-02
Status: Accepted

## Context

Starting traffic is small and fixed cost matters more than scale.

## Decision

Run the indexer, bot and Postgres on one small VPS. Split services only when load demands it.

## Consequences

- Lowest fixed cost.
- One host to monitor; a heartbeat and Sentry cover failures.
