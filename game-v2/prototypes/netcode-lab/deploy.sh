#!/usr/bin/env bash
# Deploy the netcode lab to the VPS (https://space.brotherk3d.com/netlab/). Run from anywhere:
#   bash prototypes/netcode-lab/deploy.sh
# Sends the lab's files and deploy/ to the box; deploy/remote-install.sh puts them in /opt/spacegame-netlab, runs the
# spacegame-netlab unit (127.0.0.1:3120) and adds the /netlab/ routes to the spacegame nginx site. Nothing else on the
# box is touched (the game, its data, the other sites).
set -euo pipefail
cd "$(dirname "$0")"

HOST=${DEPLOY_HOST:-root@brotherk3d.com}
KEY=${DEPLOY_KEY:-$HOME/.ssh/bk3d_deploy}
SSH="ssh -i $KEY -o BatchMode=yes"
TMP=$(mktemp -d)
TGZ=$TMP/spacegame-netlab.tgz

tar -czf "$TGZ" *.js *.html README.md server/*.js server/package.json server/package-lock.json
$SSH "$HOST" 'mkdir -p /root/spacegame-netlab-deploy'
scp -i "$KEY" -o BatchMode=yes "$TGZ" "$HOST:/root/spacegame-netlab.tgz"
scp -i "$KEY" -o BatchMode=yes deploy/spacegame-netlab.service deploy/nginx-netlab.conf deploy/remote-install.sh "$HOST:/root/spacegame-netlab-deploy/"
$SSH "$HOST" "bash /root/spacegame-netlab-deploy/remote-install.sh"
rm -rf "$TMP"
