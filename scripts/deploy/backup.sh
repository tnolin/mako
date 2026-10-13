#!/usr/bin/env bash
# Nightly dump of the bot schema (settings, subscriptions, queue). Runs as postgres. Dumps are deleted after 14 days.
# The indexer schema is not dumped: it can be rebuilt from the chain with a backfill.
set -euo pipefail
dir=/var/backups/mako
file="$dir/bot-$(date -u +%F).dump"
pg_dump -Fc -n bot ink > "$file.tmp"
mv "$file.tmp" "$file"
find "$dir" -name 'bot-*.dump' -mtime +13 -delete
