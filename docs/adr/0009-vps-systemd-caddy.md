# 0009. One VPS with systemd and Caddy

Date: 2026-10-12
Status: Accepted

Extends ADR 0004.

## Context

The indexer, the bot, Postgres and the Trade redirect are small enough for one machine. The bot talks to Telegram's Bot API and to Ink RPC endpoints over the internet.

The setup below works on any Ubuntu 24.04 VPS.

## Decision

- **Host:** a single Ubuntu 24.04 VPS with 2 vCPUs, 4 GB RAM and about 40 GB of disk.
- **Access:** a sudo user with SSH keys only. Password, keyboard-interactive and root logins are off, set in an sshd drop-in that takes precedence over the cloud image's defaults.
- **Firewall:** `ufw` allows 22, 80 and 443 only.
- **Services:** systemd units run the indexer and the bot as dedicated non-root users, with `Restart=always`.
- **Database:** Postgres uses peer auth over the unix socket, so there are no database passwords.
- **Redirect:** Caddy terminates TLS for the Trade redirect on `go.makobot.xyz` and keeps no access log. The website on `makobot.xyz` is hosted elsewhere.
- **Backups and retention:**
  - A snapshot is taken at the provider before every update and deleted once the update is verified, within 14 days. Any provider backups are kept no longer than 14 days.
  - A nightly `pg_dump` of the bot schema is kept 14 days on the server and copied with `rclone` to an S3-compatible bucket. The backup job deletes copies older than 13 days, and a bucket lifecycle rule expires them as a backstop. The bucket key can only read and write that bucket.
  - journald keeps 14 days.
- **Error reporting:** Sentry collects no user info, cookies, headers, query params or request bodies, and drops HTTP and console breadcrumbs. Scrubbers remove user and chat ids.

## Consequences

- One machine to watch; Sentry and its cron monitor report failures.
- A lost server can be rebuilt from the deploy guide, with the bot schema restored from the bucket.
- Moving to another host means re-running the deploy guide and restoring a dump, not changing code.
