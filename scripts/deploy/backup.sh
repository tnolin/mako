#!/usr/bin/env bash
# Nightly dump of the bot schema (settings, subscriptions, queue), kept 14 days on this server and in an
# S3-compatible bucket. Runs as postgres. The indexer schema is not dumped: it can be rebuilt from the chain.
set -euo pipefail
dir=/var/backups/mako
name="bot-$(date -u +%F).dump"
pg_dump -Fc -n bot ink > "$dir/$name.tmp"
mv "$dir/$name.tmp" "$dir/$name"
find "$dir" -name 'bot-*.dump' -mtime +13 -delete
# Off-site copy. S3_* come from /etc/ink/backup.env: a key that can only read and write this one bucket.
export RCLONE_S3_PROVIDER="${S3_PROVIDER:-Other}" RCLONE_S3_NO_CHECK_BUCKET=true
export RCLONE_S3_ENDPOINT="$S3_ENDPOINT" RCLONE_S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" RCLONE_S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
rclone copyto "$dir/$name" ":s3:$S3_BUCKET/$name"
# 14 days off-site as well. A 13-day lifecycle rule on the bucket is the backstop if this server stops running.
rclone delete --min-age 13d ":s3:$S3_BUCKET"
