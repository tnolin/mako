#!/usr/bin/env bash
# Deploys a release tag: sudo scripts/deploy/update.sh <ink-indexer|mako> <tag>
set -euo pipefail
repo="${1:?repo}" tag="${2:?tag}"
case "$repo" in
  ink-indexer) unit=ink-indexer; user=ink-indexer; envfile=indexer ;;
  mako) unit=mako-bot; user=mako; envfile=mako ;;
  *) echo "repo must be ink-indexer or mako" >&2; exit 2 ;;
esac
[[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid tag: $tag" >&2; exit 1; }
cd "/opt/$repo"
sudo -u "$user" git fetch --tags --force origin
sudo -u "$user" git -c advice.detachedHead=false checkout "refs/tags/$tag"
sudo -u "$user" pnpm install --frozen-lockfile
if grep -q '^SENTRY_RELEASE=' "/etc/ink/$envfile.env"; then
  sed -i "s/^SENTRY_RELEASE=.*/SENTRY_RELEASE=$tag/" "/etc/ink/$envfile.env"
else
  echo "SENTRY_RELEASE=$tag" >> "/etc/ink/$envfile.env"
fi
systemctl restart "$unit"
systemctl --no-pager --lines=20 status "$unit"
