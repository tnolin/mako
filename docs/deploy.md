# Deploying MAKO and ink-indexer

One VPS runs Postgres, the indexer, the bot and Caddy (ADR 0009). Steps marked **owner** buy services or handle secrets.

## 1. Server (owner)

- Hetzner Cloud, location Nuremberg (NBG1) or Falkenstein (FSN1), 2 vCPU and 4 GB RAM, Ubuntu 24.04, with backups enabled.
- Add your SSH key at creation.

## 2. Base system

Create a sudo user for yourself before disabling root login.

```bash
apt update && apt -y upgrade && apt -y install unattended-upgrades ufw git curl ca-certificates
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

## 3. Software

- Postgres 18 from the PGDG apt repository (https://www.postgresql.org/download/linux/ubuntu/).
- Node 24 LTS from NodeSource, then `corepack enable`.
- Caddy from its official apt repository (https://caddyserver.com/docs/install#debian-ubuntu-raspbian).

## 4. Users and checkouts

```bash
groupadd --system ink
useradd --system --gid ink --home-dir /var/lib/ink-indexer --create-home --shell /usr/sbin/nologin ink-indexer
useradd --system --gid ink --home-dir /var/lib/mako --create-home --shell /usr/sbin/nologin mako
install -d -o ink-indexer -g ink /opt/ink-indexer && install -d -o mako -g ink /opt/mako
sudo -u ink-indexer git clone https://github.com/tnolin/ink-indexer.git /opt/ink-indexer
sudo -u mako git clone https://github.com/tnolin/mako.git /opt/mako
install -D -m 0644 /opt/mako/scripts/deploy/journald-retention.conf /etc/systemd/journald.conf.d/retention.conf
systemctl restart systemd-journald && systemd-analyze cat-config systemd/journald.conf | grep -i MaxRetentionSec
```

## 5. Postgres

```bash
sudo -u postgres psql -c "create database ink"
sudo -u postgres psql -c "create role indexer login" -c "create role mako login"
sudo -u postgres psql ink -c "create schema indexer authorization indexer" -c "create schema bot authorization mako"
sudo -u postgres psql -c "grant create on database ink to indexer, mako"
```

The `grant create` is needed because each service's migration runs `create schema if not exists`, which checks CREATE on the database even when the schema already exists.

Peer auth, no passwords. Add to `pg_ident.conf`:

```
ink   ink-indexer   indexer
ink   mako          mako
```

And add these lines to the top of `pg_hba.conf`:

```
local   ink   indexer   peer map=ink
local   ink   mako      peer map=ink
```

Keep `listen_addresses = 'localhost'`, then `systemctl reload postgresql`.

## 6. Secrets (owner)

Write the env files from each repo's `.env.example`. systemd reads them as root, so only root needs access:

```bash
install -d -m 0750 -o root -g ink /etc/ink
install -m 0600 -o root -g root /dev/null /etc/ink/indexer.env
install -m 0600 -o root -g root /dev/null /etc/ink/mako.env
```

`/etc/ink/indexer.env`: `DATABASE_URL=postgres:///ink`, `PGHOST=/var/run/postgresql`, `PGUSER=indexer`, `INK_RPC_WS_URLS=`, `SENTRY_DSN=…`, `SENTRY_RELEASE=…`.

`/etc/ink/mako.env`: `DATABASE_URL=postgres:///ink`, `PGHOST=/var/run/postgresql`, `PGUSER=mako`, `TELEGRAM_BOT_TOKEN=…`, `INKYPUMP_REF_CODE=…`, `LINKS_BASE_URL=https://go.makobot.xyz`, `SENTRY_DSN=…`, `SENTRY_RELEASE=…`.

postgres.js reads the socket directory and role from `PGHOST` and `PGUSER` when the URL has no host.

## 7. Indexer

```bash
cd /opt/ink-indexer && sudo -u ink-indexer git checkout events-v1 && sudo -u ink-indexer pnpm install --frozen-lockfile
cp /opt/mako/scripts/deploy/ink-indexer.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now ink-indexer
journalctl -u ink-indexer -f   # backfill from block 45,252,770 to head
sudo -u postgres psql ink -f /opt/mako/scripts/deploy/grants.sql
```

## 8. Bot, redirect and backups

DNS (owner): in Cloudflare, an `A` record for `go` pointing at the server IP, DNS only (grey cloud).

```bash
cd /opt/mako && sudo -u mako git checkout <tag> && sudo -u mako pnpm install --frozen-lockfile
cp scripts/deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
cp scripts/deploy/mako-bot.service scripts/deploy/mako-backup.service scripts/deploy/mako-backup.timer /etc/systemd/system/
install -d -m 0700 -o postgres -g postgres /var/backups/mako
systemctl daemon-reload && systemctl enable --now mako-bot mako-backup.timer
```

## Updating

`sudo /opt/mako/scripts/deploy/update.sh <ink-indexer|mako> <tag>` checks out the tag, installs and restarts.

## Restore drill

```bash
sudo -u postgres createdb scratch && sudo -u postgres pg_restore -d scratch /var/backups/mako/bot-<date>.dump
sudo -u postgres psql scratch -c "select count(*) from bot.users"   # compare with ink
sudo -u postgres dropdb scratch
```

Hetzner backups keep whole-disk images for 7 days. `pg_dump` files are deleted after 14 days, and journald keeps 14 days of logs.
