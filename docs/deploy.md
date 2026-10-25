# Deploying MAKO and ink-indexer

One VPS runs Postgres, the indexer, the bot and Caddy (ADR 0009). You buy the server in step 1, write the secrets in step 6 and set up DNS in step 8.

## 1. Server

- A single Ubuntu 24.04 VPS with 2 vCPUs, 4 GB RAM and about 40 GB of disk. Turn on your provider's backups and snapshots if it offers them.
- A sudo user that logs in with your SSH key. Cloud images usually ship one, such as `ubuntu`. Install your key with `ssh-copy-id <user>@<ip>` and confirm that key login works before going on.
- Note the connect times to the RPCs and Telegram:

```bash
for h in rpc-qnd.inkonchain.com ink.drpc.org rpc-gel.inkonchain.com api.telegram.org; do
  curl -s -o /dev/null -w "$h connect=%{time_connect} ttfb=%{time_starttransfer}\n" https://$h
done
```

## 2. Base system

Run the rest of this guide as root (`sudo -i` from your sudo user). Keep your current SSH session open until a new key login works after the restart below.

Ubuntu's cloud image ships `/etc/ssh/sshd_config.d/50-cloud-init.conf` with `PasswordAuthentication yes`, and sshd uses the first value it reads, so the hardening goes in a drop-in that sorts before it:

```bash
apt update && apt -y upgrade && apt -y install unattended-upgrades ufw git curl ca-certificates rclone
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/00-hardening.conf
systemctl restart ssh
sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '   # all three: no
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

`ufw` is the firewall.

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

## 6. Secrets

Write the env files from each repo's `.env.example`. systemd reads them as root, so only root needs access:

```bash
install -d -m 0750 -o root -g ink /etc/ink
install -m 0600 -o root -g root /dev/null /etc/ink/indexer.env
install -m 0600 -o root -g root /dev/null /etc/ink/mako.env
```

`/etc/ink/indexer.env`: `DATABASE_URL=postgres:///ink`, `PGHOST=/var/run/postgresql`, `PGUSER=indexer`, `INK_RPC_WS_URLS=`, `SENTRY_DSN=…`, `SENTRY_RELEASE=…`.

`/etc/ink/mako.env`: `DATABASE_URL=postgres:///ink`, `PGHOST=/var/run/postgresql`, `PGUSER=mako`, `TELEGRAM_BOT_TOKEN=…`, `INKYPUMP_REF_CODE=…`, `LINKS_BASE_URL=https://go.makobot.xyz`, `OPENSEA_API_KEY=…`, `SENTRY_DSN=…`, `SENTRY_RELEASE=…`.

`OPENSEA_API_KEY` is the same key as the indexer's: the bot's NFT card and Trending list spend the indexer's shared request budget through `indexer.opensea_take` and `indexer.opensea_block`, which `grants.sql` (step 7) grants to the `mako` role with `EXECUTE` only. Without a key those screens say details are unavailable. Optional: `NFT_ALERTS_SINCE` (Unix seconds; NFT events with an earlier block time never alert, and the default is the time the bot first ran with NFT rules) and `BUTTON_COLOURS=0` (alert switches read `: on` and `: off` instead of showing green).

`/etc/ink/backup.env`, from `scripts/deploy/backup.env.example`: an S3-compatible bucket, its endpoint, rclone's provider name for the service, and a key that can only read and write that bucket. Give the bucket a lifecycle rule that deletes objects 13 days after upload.

```bash
install -m 0600 -o root -g root /dev/null /etc/ink/backup.env
```

postgres.js reads the socket directory and role from `PGHOST` and `PGUSER` when the URL has no host.

## 7. Indexer

Check out the latest `indexer-v*` release tag of ink-indexer. `events-v2` is the event schema version mako builds against, not a deploy tag.

```bash
cd /opt/ink-indexer && sudo -u ink-indexer git checkout <indexer tag> && sudo -u ink-indexer pnpm install --frozen-lockfile
cp /opt/mako/scripts/deploy/ink-indexer.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now ink-indexer
journalctl -u ink-indexer -f   # backfill from block 45,252,770 to head
sudo -u postgres psql ink -f /opt/mako/scripts/deploy/grants.sql
```

## 8. Bot, redirect and backups

DNS: point an `A` record for `go` at the server IP, not proxied. Only `go.makobot.xyz` points at this server; the website on `makobot.xyz` is hosted elsewhere.

```bash
cd /opt/mako && sudo -u mako git checkout <tag> && sudo -u mako pnpm install --frozen-lockfile
cp scripts/deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
cp scripts/deploy/mako-bot.service scripts/deploy/mako-backup.service scripts/deploy/mako-backup.timer /etc/systemd/system/
install -d -m 0700 -o postgres -g postgres /var/backups/mako
systemctl daemon-reload && systemctl enable --now mako-bot mako-backup.timer
```

## Updating

The bot applies its database migrations when it starts. If a release changes `scripts/deploy/grants.sql`, run it again as in step 7.

1. Take a snapshot of the server at your provider. Delete the previous one first.
2. `sudo /opt/mako/scripts/deploy/update.sh <ink-indexer|mako> <tag>` asks for the snapshot, then checks out the tag, installs and restarts.
3. Check `journalctl -u <unit>` and the bot, then delete the snapshot. Never keep it longer than 14 days: it holds user data, and `/help` says backups are deleted after 14 days.

To roll back, restore the snapshot. Checking out the previous tag without restoring it leaves queued NFT alert and reminder rows that the older bot can't send; they fail or age out within 30 minutes.

## Monitoring

Sentry's cron monitor `ink-pipeline` gets a check-in from the bot every minute. It reports `error` when the indexer cursor hasn't moved for 10 minutes, and a missed check-in means the bot or the server is down.

The bot also runs health checks every 5 minutes and reports them to the same Sentry project (ADR 0017):

| Check | Level | Fires when |
| - | - | - |
| Indexer events | error | the newest event is more than 60 minutes old |
| Indexer cursor | error | the cursor is more than 100 blocks behind the chain head |
| Bot lag | error | the bot is more than 500 events behind the indexer for 10 minutes |
| Failed deliveries | error | 10 or more failed in the last hour |
| Quiet day | info | no alert was sent in 24 hours, at most once a day, with a summary of the day |

Each error opens one Sentry issue per incident, and a `Health recovered` info note follows when it clears. Open incidents are kept in `bot.state` under `health:<check>`, so a restart doesn't repeat them. To get the info notes by email too, add an alert rule for the project that covers info-level issues.

## Restore drill

From the local dump:

```bash
sudo -u postgres createdb scratch && sudo -u postgres pg_restore -d scratch /var/backups/mako/bot-<date>.dump
sudo -u postgres psql scratch -c "select count(*) from bot.users"   # compare with ink
sudo -u postgres dropdb scratch
```

From the off-site copy, as if the server were lost. The subshell keeps the credentials out of your shell:

```bash
(set -a; . /etc/ink/backup.env; set +a
 export RCLONE_S3_PROVIDER="${S3_PROVIDER:-Other}" RCLONE_S3_NO_CHECK_BUCKET=true RCLONE_S3_ENDPOINT="$S3_ENDPOINT" \
   RCLONE_S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" RCLONE_S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
 rclone lsf ":s3:$S3_BUCKET"                                            # at most 14 bot-<date>.dump files
 rclone copyto ":s3:$S3_BUCKET/bot-<date>.dump" /tmp/bot-restore.dump)
chown postgres /tmp/bot-restore.dump
sudo -u postgres createdb scratch && sudo -u postgres pg_restore -d scratch /tmp/bot-restore.dump
sudo -u postgres psql scratch -c "select count(*) from bot.users"   # compare with ink
sudo -u postgres dropdb scratch && rm /tmp/bot-restore.dump
```

Retention: provider backups and snapshots hold user data too, so keep none longer than 14 days; delete the update snapshot once the update is verified. `pg_dump` files are deleted after 14 days on the server and in the bucket, where the lifecycle rule also expires them. journald keeps 14 days of logs.
