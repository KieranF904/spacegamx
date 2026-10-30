#!/usr/bin/env bash
# Deploy the working tree to the VPS (space.brotherk3d.com). Run from game-v2/:
#   bash deploy/vps/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST=${DEPLOY_HOST:-root@brotherk3d.com}
KEY=${DEPLOY_KEY:-$HOME/.ssh/bk3d_deploy}
SSH="ssh -i $KEY -o BatchMode=yes"
TGZ=$(mktemp -d)/spacegame.tgz

tar -czf "$TGZ" --exclude=node_modules --exclude=dist \
  --exclude='data/users.json' --exclude='data/users.db*' --exclude='data/lobby' --exclude='data/ships/players' --exclude='data/profiles' --exclude='data/telemetry' --exclude='data/contributor' --exclude='data/status' \
  common server server-browser client data
$SSH "$HOST" 'mkdir -p /root/spacegame-deploy'
scp -i "$KEY" -o BatchMode=yes "$TGZ" "$HOST:/root/spacegame.tgz"
scp -i "$KEY" -o BatchMode=yes deploy/vps/*.service deploy/vps/nginx-spacegame.conf deploy/vps/remote-install.sh "$HOST:/root/spacegame-deploy/"
$SSH "$HOST" 'bash /root/spacegame-deploy/remote-install.sh'
