# 0017. Health checks

Date: 2026-10-25
Status: Accepted

## Context

The `ink-pipeline` cron monitor catches a dead bot or host and an indexer cursor that stops. It doesn't catch an indexer that writes no events, a cursor that falls behind the chain, a bot that falls behind the events table, deliveries that keep failing, or a day with no alerts that might be an outage. Sentry's free plan includes one cron monitor, which `ink-pipeline` already uses, so these checks can't be more monitors.

## Decision

- The bot runs these checks every 5 minutes and reports them to Sentry as messages:
  - Error: the newest indexer event is more than 60 minutes old.
  - Error: the indexer cursor is more than 100 blocks behind the chain head (`eth_blockNumber` on `INK_RPC_URL`). When the head can't be read, the check skips that run.
  - Error: the bot's `events_cursor` is more than 500 events behind the newest event for 10 minutes.
  - Error: 10 or more failed deliveries in the last hour.
  - Info, at most once a day: no alert sent in 24 hours. The note lists the day's events by type, the biggest sale in a real collection against the BIG SALE minimum, and mints from real, filtered and other collections.
- Each error fires once per incident. The incident's start time is kept in `bot.state` (`health:<check>`), so a restart doesn't fire it again. When the check clears, the bot sends an info note, `Health recovered: … (lasted …)`, and deletes the row.
- Each incident has its own fingerprint (`health`, the check, the start time), so it opens a new Sentry issue and the project's new-issue email rule sends it. The recovered note has its own fingerprint too.
- The checks read only the newest event by id and the last 86,400 blocks, through existing indexes.

## Consequences

- An incident costs two Sentry events, so the checks stay well inside the free plan's error quota.
- The info notes email only if an alert rule covers info-level issues. The default high-priority rule may not.
- When the bot itself is down, these checks are down too. `ink-pipeline` still reports that as a missed check-in.
- The 10-minute wait of the lag check is kept in memory, so a restart restarts the wait.
