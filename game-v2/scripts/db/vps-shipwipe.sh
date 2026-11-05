#!/usr/bin/env bash
# Runs scripts/db/shipWipe.ts (the v5 ship wipe) on the VPS, against the spacegame database, with the game data of
# the release that's installed (/opt/spacegame/data: its starter ship is the one handed out). Bundles the tool here,
# uploads it to /root/ship-wipe (with its own 'pg'), and runs it there with DATABASE_URL from
# /etc/spacegame/secrets.env (never printed, never leaves the VPS). It touches no service, unit or secret: stop
# spacegame-server and take the backups first (docs/areas/ops-tools.md, "v5 ship wipe").
#
#   scripts/db/vps-shipwipe.sh --dry-run    # one row per player and the totals, as JSON; writes nothing
#   scripts/db/vps-shipwipe.sh --apply      # the same, written in one transaction (rows already at v5 skipped)
#
# Each run's report is kept on the VPS as /root/ship-wipe/report-<mode>-<time>.json (mode 600) and printed here.
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${1:-}" in --dry-run|--apply) ;; *) echo "usage: $0 --dry-run|--apply" >&2; exit 2;; esac
MODE=${1#--}
HOST=root@brotherk3d.com
SSH=(ssh -i ~/.ssh/bk3d_deploy -o BatchMode=yes)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

server/node_modules/.bin/esbuild scripts/db/shipWipe.ts --bundle --platform=node --format=esm --target=node22 \
  --external:pg --outfile="$OUT/shipwipe.mjs" --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
PG_VERSION=$(node -p "require('./server/node_modules/pg/package.json').version")
printf '{"name":"ship-wipe","private":true,"type":"module","dependencies":{"pg":"%s"}}\n' "$PG_VERSION" > "$OUT/package.json"

"${SSH[@]}" "$HOST" 'mkdir -p -m 700 /root/ship-wipe'
scp -q -i ~/.ssh/bk3d_deploy -o BatchMode=yes "$OUT/shipwipe.mjs" "$OUT/package.json" "$HOST:/root/ship-wipe/"
"${SSH[@]}" "$HOST" "bash -s" <<EOF
set -eu
cd /root/ship-wipe
[ -d node_modules/pg ] && [ "\$(node -p "require('./node_modules/pg/package.json').version")" = "$PG_VERSION" ] || npm install --no-audit --no-fund --omit=dev >/dev/null
R=/root/ship-wipe/report-$MODE-\$(date -u +%Y%m%d-%H%M%S).json
umask 077
( set -a; . /etc/spacegame/secrets.env; set +a
  exec env -i PATH="\$PATH" HOME=/root DATABASE_URL="\$DATABASE_URL" node shipwipe.mjs --$MODE --game-data /opt/spacegame/data ) > "\$R"
cat "\$R"
echo "report: \$R" >&2
EOF
