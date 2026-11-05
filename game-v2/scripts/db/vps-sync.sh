#!/usr/bin/env bash
# Runs scripts/db/migrateJsonToPostgres.ts on the VPS, against the live JSON and the spacegame database
# (docs/ops/postgres-migration.md). Bundles the tool here, uploads it to /root/pg-migrate (with its own 'pg'),
# and runs it there with DATABASE_URL from /etc/spacegame/secrets.env (never printed, never leaves the VPS).
# It touches nothing else: no services, no units, no secrets, and the live JSON is only read.
#
#   scripts/db/vps-sync.sh --dry-run          # what it would write (in a transaction, rolled back)
#   scripts/db/vps-sync.sh --verify-only      # compare the database with the JSON as it is now
#   scripts/db/vps-sync.sh --replace          # re-sync: empty the four tables and copy again, then verify
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=root@brotherk3d.com
SSH=(ssh -i ~/.ssh/bk3d_deploy -o BatchMode=yes)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

server/node_modules/.bin/esbuild scripts/db/migrateJsonToPostgres.ts --bundle --platform=node --format=esm --target=node22 \
  --external:pg --outfile="$OUT/migrate.mjs" --log-level=warning \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
cp server-browser/schema.sql "$OUT/"
PG_VERSION=$(node -p "require('./server/node_modules/pg/package.json').version")
printf '{"name":"pg-migrate","private":true,"type":"module","dependencies":{"pg":"%s"}}\n' "$PG_VERSION" > "$OUT/package.json"

"${SSH[@]}" "$HOST" 'mkdir -p -m 700 /root/pg-migrate'
scp -q -i ~/.ssh/bk3d_deploy -o BatchMode=yes "$OUT/migrate.mjs" "$OUT/schema.sql" "$OUT/package.json" "$HOST:/root/pg-migrate/"
ARGS=$(printf '%q ' "$@")
"${SSH[@]}" "$HOST" "bash -s" <<EOF
set -eu
cd /root/pg-migrate
[ -d node_modules/pg ] && [ "\$(node -p "require('./node_modules/pg/package.json').version")" = "$PG_VERSION" ] || npm install --no-audit --no-fund --omit=dev >/dev/null
R=/root/pg-migrate/report-\$(date -u +%Y%m%d-%H%M%S).json
set +e
( set -a; . /etc/spacegame/secrets.env; set +a
  exec env -i PATH="\$PATH" HOME=/root DATABASE_URL="\$DATABASE_URL" node migrate.mjs --data /opt/spacegame/data --report "\$R" $ARGS )
code=\$?
[ -f "\$R" ] && chmod 600 "\$R"
exit \$code
EOF
