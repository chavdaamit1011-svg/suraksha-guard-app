#!/usr/bin/env bash
# Deploy the guard backend additions into the live app. Run this ON the VPS, from the source
# folder /home/suraksha/suraksha-guard/backend-additions (the code's home on the server).
#
#   bash deploy-on-server.sh --check   # only show what would change, touch nothing
#   bash deploy-on-server.sh           # back up, copy, build, restart
#
# Two existing files are replaced (src/proxy.ts and the guard register route); both are backed
# up first. Rebuilds and restarts the live app, so run it in a quiet window, after taking a
# Hostinger snapshot. Checklist: DEPLOY.md, "Before you deploy".
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP=/home/suraksha/suraksha-new

if [ "${1:-}" = "--check" ]; then
  echo "==> Files that would be ADDED (new):"
  (cd "$HERE/src" && find . -type f) | while read -r f; do
    sudo test -e "$APP/src/$f" || echo "  + src/${f#./}"
  done
  echo "==> Existing files that would be REPLACED (content differs):"
  (cd "$HERE/src" && find . -type f) | while read -r f; do
    if sudo test -e "$APP/src/$f" && ! sudo cmp -s "$HERE/src/$f" "$APP/src/$f"; then echo "  ~ src/${f#./}"; fi
  done
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=/home/suraksha/guard-deploy-backup-$STAMP

echo "==> Backing up the files this deploy replaces -> $BACKUP"
sudo mkdir -p "$BACKUP"
sudo cp -a "$APP/src/proxy.ts" "$BACKUP/"
sudo cp -a "$APP/src/app/api/guard/auth/register/route.ts" "$BACKUP/register-route.ts"

echo "==> Copying src/ into $APP/src"
sudo cp -r "$HERE/src/." "$APP/src/"
sudo chown -R suraksha:suraksha "$APP/src"

echo "==> Adding the Anthropic SDK (guard assistant) if missing, building, restarting"
sudo -u suraksha bash -lc "cd $APP && (node -e 'require.resolve(\"@anthropic-ai/sdk\")' 2>/dev/null || npm install --save @anthropic-ai/sdk@0.126.0) && npm run build && pm2 restart suraksha --update-env"

echo "==> Verifying"
curl -s -o /dev/null -w "today endpoint: %{http_code}\n" "http://127.0.0.1:4545/api/guard/today?guardId=ping"
curl -s -o /dev/null -w "version endpoint: %{http_code}\n" "http://127.0.0.1:4545/api/guard/version"
echo "Done. Backup of replaced files: $BACKUP"
echo "Rollback: sudo cp $BACKUP/proxy.ts $APP/src/proxy.ts && sudo cp $BACKUP/register-route.ts $APP/src/app/api/guard/auth/register/route.ts, then rebuild and restart."
