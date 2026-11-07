#!/usr/bin/env bash
# Runs scripts/db/designUpdate.ts (the v5 design update) on the VPS, against the spacegame database, with the game data of
# the release that's installed (/opt/spacegame/data: its ships/designUpdate.json, blueprints/remakes and starter ship). Bundles the tool here,
# uploads it to /root/design-update (with its own 'pg'), and runs it there with DATABASE_URL from
# /etc/spacegame/secrets.env (never printed, never leaves the VPS). It touches no service, unit or secret: stop
# spacegame-server and take the backups first (docs/areas/ops-tools.md, "v5 design update").
#
#   scripts/db/vps-designupdate.sh --dry-run    # one row per player (swapped, wiped, refund, XP and level before/after) and the totals, as JSON; writes nothing
#   scripts/db/vps-designupdate.sh --apply      # the same, written in one transaction (rows already at v5 skipped)
#
# Each run's report is kept on the VPS as /root/design-update/report-<mode>-<time>.json (mode 600) and printed here.
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${1:-}" in --dry-run|--apply) ;; *) echo "usage: $0 --dry-run|--apply" >&2; exit 2;; esac
MODE=${1#--}
HOST=root@brotherk3d.com
SSH=(ssh -i ~/.ssh/bk3d_deploy -o BatchMode=yes)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

server/node_modules/.bin/esbuild scripts/db/designUpdate.ts --bundle --platform=node --format=esm --target=node22 \
  --external:pg --outfile="$OUT/designupdate.mjs" --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
PG_VERSION=$(node -p "require('./server/node_modules/pg/package.json').version")
printf '{"name":"design-update","private":true,"type":"module","dependencies":{"pg":"%s"}}\n' "$PG_VERSION" > "$OUT/package.json"

"${SSH[@]}" "$HOST" 'mkdir -p -m 700 /root/design-update'
scp -q -i ~/.ssh/bk3d_deploy -o BatchMode=yes "$OUT/designupdate.mjs" "$OUT/package.json" "$HOST:/root/design-update/"
"${SSH[@]}" "$HOST" "bash -s" <<EOF
set -eu
cd /root/design-update
[ -d node_modules/pg ] && [ "\$(node -p "require('./node_modules/pg/package.json').version")" = "$PG_VERSION" ] || npm install --no-audit --no-fund --omit=dev >/dev/null
R=/root/design-update/report-$MODE-\$(date -u +%Y%m%d-%H%M%S).json
umask 077
( set -a; . /etc/spacegame/secrets.env; set +a
  exec env -i PATH="\$PATH" HOME=/root DATABASE_URL="\$DATABASE_URL" node designupdate.mjs --$MODE --game-data /opt/spacegame/data ) > "\$R"
cat "\$R"
echo "report: \$R" >&2
EOF
