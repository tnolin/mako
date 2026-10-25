# Reliability

What MAKO does so problems get noticed and stale or unsafe data doesn't reach a chat.

## Health checks

Every 5 minutes the bot checks four things:

- that the indexer is still writing events;
- that the indexer cursor is within 100 blocks of the chain head;
- that the bot is keeping up with the events table;
- that deliveries aren't failing.

Each problem is reported once when it starts and again when it clears. A day with no alert sent gets one note with a summary of the day. Reports go to the bot's log and, when `SENTRY_DSN` is set, to Sentry. See [ADR 0017](adr/0017-health-checks.md) and the Monitoring section of [the deployment guide](deploy.md#monitoring).

## Image download guards

Token and collection images come from URLs set by their creators, so the bot only fetches them from `https` hosts that resolve to public addresses. Every redirect target is checked the same way, and the bot follows at most 3 redirects. Downloads are capped at 5 MB, or 10 MB for NFT images. Decoding stops at 40 million pixels, and only the first frame of an animation is used. A slow image never holds an alert back: after 3 seconds the alert goes as text. See [ADR 0016](adr/0016-in-process-image-padding.md).

## Stale alerts are dropped

An alert that waited too long in the queue is not sent. Most alerts are dropped 3 minutes after their event, and slower-moving ones, such as DEV SELL, BONDED, MINTED and SOLD OUT, after 30 minutes. A restart loses nothing and doesn't flood a chat with old alerts. See [ADR 0006](adr/0006-events-table-only-and-db-queue.md).

## Backfilled NFT history never alerts

When the indexer backfills NFT history, old events arrive as new rows. NFT events from before the time the bot first ran with NFT alerts update the bot's view of each collection but never send an alert. `NFT_ALERTS_SINCE` can set that time. See [ADR 0013](adr/0013-nft-alerts-and-watches.md).

## No user or chat ids in error reports

Error reports to Sentry carry no user info, cookies, headers, query parameters or request bodies. HTTP and console breadcrumbs are dropped, and user and chat ids are removed at any depth before a report leaves the bot. Telegram errors are reported as their method, code and description only. See [ADR 0009](adr/0009-vps-systemd-caddy.md).
