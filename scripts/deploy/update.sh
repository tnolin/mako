#!/usr/bin/env bash
# Deploys a release tag as root: sudo mako-update <ink-indexer|mako> <tag>
# Installed at /usr/local/sbin/mako-update. The app trees are root-owned; the service user can write only to
# node_modules, so code it runs can't change the checkout, the git data or the scripts that root and postgres run.
set -euo pipefail
repo="${1:?repo}" tag="${2:?tag}"
case "$repo" in
  ink-indexer) unit=ink-indexer; user=ink-indexer; envfile=indexer ;;
  mako) unit=mako-bot; user=mako; envfile=mako ;;
  *) echo "repo must be ink-indexer or mako" >&2; exit 2 ;;
esac
[[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid tag: $tag" >&2; exit 1; }
# The snapshot is the way back if an update goes wrong. Delete it once the update is verified (14 days at most).
read -r -p "Did you take your provider's snapshot of this server just now? [y/N] " snap
[[ "$snap" == y ]] || { echo "Take a snapshot at your provider first." >&2; exit 1; }
cd "/opt/$repo"
# Hooks are off for every git command here: they would run as root.
git="git -c core.hooksPath=/dev/null"
$git fetch --tags --force origin
$git rev-parse --verify --quiet "refs/tags/$tag^{commit}" >/dev/null || { echo "no such tag: $tag" >&2; exit 1; }
$git -c advice.detachedHead=false checkout --force "refs/tags/$tag"
# The service user installs into node_modules in the root package and in each package under apps and packages.
for d in . apps/* packages/*; do
  [ -f "$d/package.json" ] && install -d -o "$user" -g ink "$d/node_modules"
done
sudo -u "$user" pnpm install --frozen-lockfile
if [ "$repo" = mako ]; then
  # Root and postgres run these copies, so they come only from the root-owned tree.
  install -d -m 0755 -o root -g root /usr/local/lib/mako
  install -m 0755 -o root -g root scripts/deploy/backup.sh /usr/local/lib/mako/backup.sh
  install -m 0755 -o root -g root scripts/deploy/update.sh /usr/local/sbin/mako-update
fi
if grep -q '^SENTRY_RELEASE=' "/etc/ink/$envfile.env"; then
  sed -i "s/^SENTRY_RELEASE=.*/SENTRY_RELEASE=$tag/" "/etc/ink/$envfile.env"
else
  echo "SENTRY_RELEASE=$tag" >> "/etc/ink/$envfile.env"
fi
systemctl restart "$unit"
systemctl --no-pager --lines=20 status "$unit"
