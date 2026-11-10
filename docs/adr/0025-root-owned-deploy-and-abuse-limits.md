# 0025. Root-owned deploy tree and abuse limits

Date: 2026-11-10
Status: Accepted

## Context

The service users owned their checkouts, while root and the postgres user ran scripts and SQL from those same trees. Code running as `mako` (for example an install script from a dependency) could rewrite a script, a unit file or a git hook and have it run with higher rights on the next update or nightly backup. The restore drill ran `pg_restore` as the postgres superuser over schemas that the `mako` and `indexer` roles own. Separately, any Telegram user could use up the shared OpenSea request budget by pasting item links, and any client could add rows to `bot.user_actions` through the redirect server.

## Decision

- `/opt/mako` and `/opt/ink-indexer` belong to root, `.git` included. Each service user can write only its `node_modules` and its home directory.
- `mako-update` runs git as root with `core.hooksPath=/dev/null`, checks out a release tag, and installs dependencies as the service user. It installs `backup.sh` to `/usr/local/lib/mako/` and itself to `/usr/local/sbin/`, both root-owned.
- Units, `grants.sql` and the Caddyfile are copied only from the root-owned tree. A test checks that no unit run by root or postgres, and no documented privileged command, uses a path a service user can write.
- The restore drill runs as a `restore` login with no superuser, CREATEROLE or CREATEDB rights, which owns `scratch`, belongs to neither `mako` nor `indexer`, and is reached through a peer map. The restore and the comparison queries both run as that login.
- Each user can start 5 OpenSea lookups a minute. A 404 or failed item lookup is remembered for 10 minutes. The update handler waits only for the short request spacing; with no free token it answers "details unavailable" at once.
- `bot.user_actions` rows are deleted after 90 days, and click logging is skipped while more than 20 click writes are in flight. Caddy has no rate limit without a plugin, so the redirect is limited by a firewall rule.

## Consequences

- Updating a server needs root, and an existing server moves to the new layout once (see the deploy guide).
- A user who pastes many different item links gets "details unavailable" after the fifth in a minute; cached items are not counted.
- Under a click flood the redirect keeps working and some clicks are not recorded.
