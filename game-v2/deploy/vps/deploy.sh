#!/usr/bin/env bash
# Deploy the working tree to the VPS (space.brotherk3d.com). Run from game-v2/:
#   bash deploy/vps/deploy.sh             the game (client, server, lobby)
#   WITH_SITE=1 bash deploy/vps/deploy.sh also the website: it takes over / and the game moves to /play
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST=${DEPLOY_HOST:-root@brotherk3d.com}
KEY=${DEPLOY_KEY:-$HOME/.ssh/bk3d_deploy}
SSH="ssh -i $KEY -o BatchMode=yes"
TGZ=$(mktemp -d)/spacegame.tgz

tar -czf "$TGZ" --exclude=node_modules --exclude=dist \
  --exclude='data/users.json' --exclude='data/users.db*' --exclude='data/lobby' --exclude='data/ships/players' --exclude='data/profiles' --exclude='data/telemetry' --exclude='data/contributor' --exclude='data/status' --exclude='data/site' --exclude='data/world' \
  common server server-browser client data $([ "${WITH_SITE:-}" = 1 ] && echo site)
$SSH "$HOST" 'mkdir -p /root/spacegame-deploy'
scp -i "$KEY" -o BatchMode=yes "$TGZ" "$HOST:/root/spacegame.tgz"
scp -i "$KEY" -o BatchMode=yes deploy/vps/*.service deploy/vps/*.timer deploy/vps/nginx-spacegame.conf deploy/vps/nginx-spacegame-site.conf deploy/vps/remote-install.sh "$HOST:/root/spacegame-deploy/"
# Pushover keys for the live server's notices (someone joins or registers: server/src/auth/pushover.ts), from this
# machine's game-v2/.env into the box's secrets file (root-only), replacing older values; piped, never printed
if grep -qE '^PUSHOVER_(TOKEN|USER)=' .env 2>/dev/null; then
  grep -E '^PUSHOVER_(TOKEN|USER)=' .env | tr -d '\r' | $SSH "$HOST" 'f=/etc/spacegame/secrets.env; install -d -m 700 /etc/spacegame; umask 077; touch "$f"; while IFS= read -r line; do k=${line%%=*}; grep -v "^$k=" "$f" > "$f.tmp" || true; echo "$line" >> "$f.tmp"; mv "$f.tmp" "$f"; done; chmod 600 "$f"'
fi
$SSH "$HOST" "WITH_SITE=${WITH_SITE:-0} bash /root/spacegame-deploy/remote-install.sh"
