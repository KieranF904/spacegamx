#!/usr/bin/env bash
# Deploy the working tree to the VPS (space.brotherk3d.com). Run from game-v2/:
#   bash deploy/vps/deploy.sh             the game (client, server, lobby); a website already running is left alone
#   WITH_SITE=1 bash deploy/vps/deploy.sh also the website: it takes over / and the game moves to /play
#   bash deploy/vps/deploy.sh releases    list the releases kept on the box (* the running one)
#   bash deploy/vps/deploy.sh rollback [release]   put back the release before the running one (or the one named)
# The box keeps the last few releases (/opt/spacegame/releases, each with the git commit it came from and whether the
# tree was dirty), and the tarball before this one as /root/spacegame.prev.tgz.
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST=${DEPLOY_HOST:-root@brotherk3d.com}
KEY=${DEPLOY_KEY:-$HOME/.ssh/bk3d_deploy}
SSH="ssh -i $KEY -o BatchMode=yes"

case "${1:-}" in
  releases) exec $SSH "$HOST" 'bash /root/spacegame-deploy/remote-install.sh releases' ;;
  rollback)
    # (this machine's remote-install.sh, so the rollback runs the newest rules)
    scp -i "$KEY" -o BatchMode=yes deploy/vps/remote-install.sh "$HOST:/root/spacegame-deploy/"
    exec $SSH "$HOST" "bash /root/spacegame-deploy/remote-install.sh rollback $(printf '%q' "${2:-}")" ;;
  '') ;;
  *) echo "usage: deploy.sh [releases | rollback [release]]" >&2; exit 2 ;;
esac

# The data must validate (shapes, then every cross-referenced id) before anything is built or shipped; set -e aborts on errors
npm run --silent data:validate

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
TGZ=$WORK/spacegame.tgz

# What this deploy is: the commit, and whether the working tree had changes on top of it (and a hash of them, so two
# dirty deploys of the same commit can be told apart)
{
  echo "commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  changed=$(git status --porcelain -- . 2>/dev/null | wc -l | tr -d ' ')
  if [ "$changed" != 0 ]; then
    echo "dirty=yes ($changed paths changed)"
    echo "changes_sha1=$( { git diff HEAD -- . ; git ls-files --others --exclude-standard -- . ; } 2>/dev/null | sha1sum | cut -d' ' -f1)"
  else
    echo "dirty=no"
  fi
  echo "built_by=$(whoami)@$(hostname) $(date -u +%FT%TZ)"
} > "$WORK/REVISION"
cat "$WORK/REVISION"

# Runtime data (accounts, players' ships, profiles, telemetry, contributor notes, status, the website's data, the
# world's memory, backups) never ships; nor do the dev-only data files (the dev systems and dev test ships: the
# production server doesn't read them). blueprints/remakes does ship: the design update swaps players' saves for them.
# The client is built here, not on the box: its production build needs more memory than the shared VPS can spare (vite
# ran out of heap there, 2026-11-07). It ships as client/dist; remote-install.sh builds only if none came
(cd client && VITE_NO_SOURCEMAP=1 VITE_BROWSER_URL=https://space.brotherk3d.com/lobby npx vite build --outDir "$WORK/client-build" --emptyOutDir --logLevel warn)
# (data/dev and data/ships/blueprints/dev ship: dev parts are admin-only in the game, not stripped from the data)
tar -czf "$TGZ" --exclude=node_modules --exclude=dist --exclude='*.map' --transform 's,^client-build,client/dist,' \
  --exclude='data/users.json' --exclude='data/users.json.tmp' --exclude='data/users.db*' --exclude='data/lobby' \
  --exclude='data/ships/players' --exclude='data/profiles' --exclude='data/telemetry' --exclude='data/contributor' \
  --exclude='data/status' --exclude='data/site' --exclude='data/world' --exclude='data/backups' \
  common server server-browser client data $([ "${WITH_SITE:-}" = 1 ] && echo site) \
  -C "$WORK" REVISION client-build
$SSH "$HOST" 'mkdir -p /root/spacegame-deploy && if [ -f /root/spacegame.tgz ]; then cp -p /root/spacegame.tgz /root/spacegame.prev.tgz; fi'
scp -i "$KEY" -o BatchMode=yes "$TGZ" "$HOST:/root/spacegame.tgz"
scp -i "$KEY" -o BatchMode=yes deploy/vps/*.service deploy/vps/*.timer deploy/vps/nginx-*.conf deploy/vps/remote-install.sh deploy/vps/spacegame-dbdump.sh "$HOST:/root/spacegame-deploy/"
# Pushover keys for the live server's notices (someone joins or registers: server/src/auth/pushover.ts), from this
# machine's game-v2/.env into the box's secrets file (root-only), replacing older values; piped, never printed
# PayPal keys for donations (server-browser/src/donations) go the same way. The live lobby only takes PAYPAL_ENV=live:
# sandbox keys copied here leave donations off there
if grep -qE '^(PUSHOVER_(TOKEN|USER)|PAYPAL_(ENV|CLIENT_ID|CLIENT_SECRET))=' .env 2>/dev/null; then
  grep -E '^(PUSHOVER_(TOKEN|USER)|PAYPAL_(ENV|CLIENT_ID|CLIENT_SECRET))=' .env | tr -d '\r' | $SSH "$HOST" 'f=/etc/spacegame/secrets.env; install -d -m 700 /etc/spacegame; umask 077; touch "$f"; while IFS= read -r line; do k=${line%%=*}; grep -v "^$k=" "$f" > "$f.tmp" || true; echo "$line" >> "$f.tmp"; mv "$f.tmp" "$f"; done; chmod 600 "$f"'
fi
$SSH "$HOST" "WITH_SITE=${WITH_SITE:-0} bash /root/spacegame-deploy/remote-install.sh"
