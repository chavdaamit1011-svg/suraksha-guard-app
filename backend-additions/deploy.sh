#!/usr/bin/env bash
# Deploy the guard-app backend additions to the production Next.js app.
# Mostly new files; two existing files are replaced (src/proxy.ts and the guard register route)
# and are backed up first. Rebuilds + restarts the live app — run in a quiet window.
set -euo pipefail

KEY="${VPS_KEY:-../id_ed25519_new}"
HOST="ke@69.62.82.222"
PORT=2222
SSH="ssh -p $PORT -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
SCP="scp -P $PORT -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
APP=/home/suraksha/suraksha-new
STAMP=$(date +%Y%m%d-%H%M%S)

echo "==> Copying additions to staging (/home/ke/guard-backend-additions)"
$SSH "$HOST" 'rm -rf /home/ke/guard-backend-additions && mkdir -p /home/ke/guard-backend-additions'
$SCP -r src "$HOST":/home/ke/guard-backend-additions/

echo "==> Backing up the files this deploy replaces (/home/ke/guard-deploy-backup-$STAMP)"
$SSH "$HOST" "mkdir -p /home/ke/guard-deploy-backup-$STAMP && \
  sudo cp -a $APP/src/proxy.ts /home/ke/guard-deploy-backup-$STAMP/ && \
  sudo cp -a $APP/src/app/api/guard/auth/register/route.ts /home/ke/guard-deploy-backup-$STAMP/register-route.ts"

echo "==> Installing into suraksha-new (sudo, preserving ownership)"
$SSH "$HOST" "sudo cp -r /home/ke/guard-backend-additions/src/* $APP/src/ && sudo chown -R suraksha:suraksha $APP/src"

echo "==> Adding the Anthropic SDK (guard assistant) if missing"
$SSH "$HOST" "sudo -u suraksha bash -lc 'cd $APP && (node -e \"require.resolve(\\\"@anthropic-ai/sdk\\\")\" 2>/dev/null || npm install --save @anthropic-ai/sdk@0.126.0)'"

echo "==> Building + restarting as the suraksha user"
$SSH "$HOST" "sudo -u suraksha bash -lc 'cd $APP && npm run build && pm2 restart suraksha --update-env'"

echo "==> Verifying the new endpoints respond"
$SSH "$HOST" 'curl -s -o /dev/null -w "today endpoint: %{http_code}\n" "http://127.0.0.1:4545/api/guard/today?guardId=ping"; curl -s -o /dev/null -w "version endpoint: %{http_code}\n" "http://127.0.0.1:4545/api/guard/version"'
echo "Done. Backup of replaced files: /home/ke/guard-deploy-backup-$STAMP"
