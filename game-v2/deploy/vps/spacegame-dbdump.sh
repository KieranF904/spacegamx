#!/usr/bin/env bash
# The nightly dump of the game's Postgres database (spacegame-dbdump.service runs it as the spacegame user).
# Installed as /opt/spacegame/bin/spacegame-dbdump by remote-install.sh.
# DATABASE_URL (from /etc/spacegame/secrets.env) is turned into libpq's PG* settings and a password file in the unit's
# private /tmp, so the password is never on a command line (where any user on the box could see it in ps).
# Keeps the last 14 nights: data/backups/db/spacegame-YYYY-MM-DD.sql.gz
set -euo pipefail
umask 077
: "${DATABASE_URL:?DATABASE_URL is not set}"

PGPASSFILE=$(mktemp)
trap 'rm -f "$PGPASSFILE"' EXIT
export PGPASSFILE

# node reads the URL from the environment (not argv), writes the password file and prints the rest as
# shell-quoted exports (single quotes, each ' written as '\'')
eval "$(node -e '
const u = new URL(process.env.DATABASE_URL);
const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
const d = decodeURIComponent;
const out = [];
const set = (k, v) => { if (v) out.push(`export ${k}=${q(v)}`); };
set("PGHOST", u.searchParams.get("host") || d(u.hostname).replace(/^\[|\]$/g, ""));
set("PGPORT", u.searchParams.get("port") || u.port);
set("PGUSER", u.searchParams.get("user") || d(u.username));
set("PGDATABASE", u.searchParams.get("dbname") || d(u.pathname.replace(/^\//, "")));
set("PGSSLMODE", u.searchParams.get("sslmode"));
const pass = u.searchParams.get("password") || d(u.password);
// (the password file: any host, port, database and user; \ and : escaped as libpq wants)
require("fs").writeFileSync(process.argv[1], pass ? "*:*:*:*:" + pass.replace(/\\/g, "\\\\").replace(/:/g, "\\:") + "\n" : "", { mode: 0o600 });
console.log(out.join("\n"));
' "$PGPASSFILE")"

d=/opt/spacegame/data/backups/db
mkdir -p "$d"
f="$d/spacegame-$(date +%F).sql.gz"
pg_dump --no-owner | gzip > "$f.tmp"
mv "$f.tmp" "$f"
ls -1t "$d"/spacegame-*.sql.gz | tail -n +15 | xargs -r rm --
