# 0009. One VPS in EU-central with systemd and Caddy

Date: 2026-10-12
Status: Accepted

Extends ADR 0004.

## Context

The bot talks to Telegram's Bot API and to Ink RPC endpoints, which are served from Europe. A host in EU-central keeps those round trips short.

## Decision

- **Host:** Hetzner Cloud in Nuremberg or Falkenstein, Ubuntu 24.04.
- **Services:** systemd units run the indexer and the bot as dedicated non-root users, with `Restart=always`.
- **Database:** Postgres uses peer auth over the unix socket, so there are no database passwords.
- **Redirect:** Caddy terminates TLS for the Trade redirect on `go.makobot.xyz` and keeps no access log.
- **Retention:**
  - Hetzner whole-disk backups are kept 7 days.
  - Nightly `pg_dump` of the bot schema is deleted after 14 days.
  - journald keeps 14 days.
- **Error reporting:** Sentry collects no user info, cookies, headers, query params or request bodies, and drops HTTP and console breadcrumbs. Scrubbers remove user and chat ids.

## Consequences

- One machine to watch; Sentry and its cron monitor report failures.
- Moving to separate machines later means changing connection settings, not code.
