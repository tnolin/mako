#!/usr/bin/env bash
# Deploys a release tag: sudo scripts/deploy/update.sh <ink-indexer|mako> <tag>
set -euo pipefail
repo="${1:?repo}" tag="${2:?tag}"
case "$repo" in
  ink-indexer) unit=ink-indexer; user=ink-indexer; envfile=indexer ;;
  mako) unit=mako-bot; user=mako; envfile=mako ;;
  *) echo "repo must be ink-indexer or mako" >&2; exit 2 ;;
esac
cd "/opt/$repo"
sudo -u "$user" git fetch --tags --force origin
sudo -u "$user" git -c advice.detachedHead=false checkout "refs/tags/$tag"
sudo -u "$user" pnpm install --frozen-lockfile
sed -i "s/^SENTRY_RELEASE=.*/SENTRY_RELEASE=$tag/" "/etc/ink/$envfile.env"
systemctl restart "$unit"
systemctl --no-pager --lines=20 status "$unit"
