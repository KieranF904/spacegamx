#!/usr/bin/env bash
# Runs scripts/deploy/upgrade-profiles-v6.ts (every saved profile to PROFILE_VERSION 6 in one pass) on the VPS, against
# the spacegame database, with the game data of the release that's installed (/opt/spacegame/data). Bundles the tool
# here, uploads it to /root/profile-upgrade-v6 (with its own 'pg'), and runs it there with DATABASE_URL from
# /etc/spacegame/secrets.env (never printed, never leaves the VPS). It touches no service, unit or secret, and nothing
# of the box's other projects. Same shape as the v5 tool's wrapper (scripts/db/vps-designupdate.sh, in git history).
# Steps and order: docs/deploy/runbook-2026-11-13.md.
#
#   scripts/deploy/vps-upgrade-profiles-v6.sh --dry-run   # one row per pilot (version, progress before/after, what changes, checks); a read-only transaction
#   scripts/deploy/vps-upgrade-profiles-v6.sh --apply     # stop spacegame-server FIRST. One transaction: the profiles table copied to
#                                                         # profiles_pre_v6, then every row below v6 written; refused if any check fails
#
# --dry-run uploads the tool (to /root/profile-upgrade-v6) and writes its report file there: the only writes it makes.
# Each run's report is kept on the VPS as /root/profile-upgrade-v6/report-<mode>-<time>.json (mode 600) and printed here.
# Exit: 0 done, 1 error, 2 a check failed (nothing written either way).
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${1:-}" in --dry-run|--apply) ;; *) echo "usage: $0 --dry-run|--apply" >&2; exit 2;; esac
MODE=${1#--}
HOST=${DEPLOY_HOST:-root@brotherk3d.com}
KEY=${DEPLOY_KEY:-$HOME/.ssh/bk3d_deploy}
SSH=(ssh -i "$KEY" -o BatchMode=yes)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

# (the alias: the server's loaders and this tool share one copy of common, so the tables it registers are the ones migrateProfile reads)
server/node_modules/.bin/esbuild scripts/deploy/upgrade-profiles-v6.ts --bundle --platform=node --format=esm --target=node22 \
  --external:pg --alias:@space-game/common=./common/src/index.ts --outfile="$OUT/upgrade.mjs" --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
PG_VERSION=$(node -p "require('./server/node_modules/pg/package.json').version")
printf '{"name":"profile-upgrade-v6","private":true,"type":"module","dependencies":{"pg":"%s"}}\n' "$PG_VERSION" > "$OUT/package.json"

"${SSH[@]}" "$HOST" 'mkdir -p -m 700 /root/profile-upgrade-v6'
scp -q -i "$KEY" -o BatchMode=yes "$OUT/upgrade.mjs" "$OUT/package.json" "$HOST:/root/profile-upgrade-v6/"
"${SSH[@]}" "$HOST" "bash -s" <<EOF
set -eu
cd /root/profile-upgrade-v6
if [ "$MODE" = apply ] && systemctl is-active --quiet spacegame-server; then
  echo "spacegame-server is running: stop it first (systemctl stop spacegame-server), it would save its in-memory v5 copies over the upgrade" >&2
  exit 1
fi
[ -d node_modules/pg ] && [ "\$(node -p "require('./node_modules/pg/package.json').version")" = "$PG_VERSION" ] || npm install --no-audit --no-fund --omit=dev >/dev/null
R=/root/profile-upgrade-v6/report-$MODE-\$(date -u +%Y%m%d-%H%M%S).json
umask 077
set +e
( set -a; . /etc/spacegame/secrets.env; set +a
  exec env -i PATH="\$PATH" HOME=/root DATABASE_URL="\$DATABASE_URL" node upgrade.mjs --$MODE --game-data /opt/spacegame/data ) > "\$R"
code=\$?
set -e
cat "\$R"
echo "report: \$R" >&2
exit \$code
EOF
