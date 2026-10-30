#!/usr/bin/env bash
# Runs on the VPS as root: unpack /root/spacegame.tgz into /opt/spacegame,
# keep player data, build, install the services and nginx site, restart.
# Touches nothing outside /opt/spacegame, its three systemd units (game, lobby, website) and its nginx site
# (/etc/nginx/sites-available/spacegame and its snippet /etc/nginx/snippets/spacegame-site.conf).
set -euo pipefail

APP=/opt/spacegame
TGZ=/root/spacegame.tgz
SRC=$(cd "$(dirname "$0")" && pwd)
# The website only when asked (WITH_SITE=1): it takes over / from the game client
SITE=$([ "${WITH_SITE:-0}" = 1 ] && echo 1 || echo 0)
PARTS="common server server-browser client$([ $SITE = 1 ] && echo ' site')"

id spacegame >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin spacegame
mkdir -p "$APP"

# Build in a staging folder laid out like the real one (the packages refer to each other as ../common etc.)
B="$APP/.build"
rm -rf "$B"; mkdir -p "$B"
tar -xzf "$TGZ" -C "$B"
chown -R spacegame:spacegame "$APP"

run() { sudo -u spacegame -H env HOME="$APP" npm_config_cache="$APP/.npm" bash -c "$1"; }
run "cd $B/common && npm ci --no-audit --no-fund && npm run build"
run "cd $B/server && npm ci --no-audit --no-fund && npx tsc"
run "cd $B/server-browser && npm ci --no-audit --no-fund && npx tsc"
# The website runs its TypeScript through tsx (a dev dependency, so no --omit=dev); the check stops a broken deploy before the swap
[ $SITE = 1 ] && run "cd $B/site && npm ci --no-audit --no-fund && npx tsc --noEmit -p ."
run "cd $B/client && npm ci --no-audit --no-fund && VITE_BROWSER_URL=https://space.brotherk3d.com/lobby npx vite build"

# Swap in the new build; player accounts, saved ships, profiles, telemetry, contributor notes and the website's data stay
systemctl stop spacegame-site spacegame-server spacegame-browser 2>/dev/null || true
for d in $PARTS; do rm -rf "$APP/$d"; mv "$B/$d" "$APP/$d"; done
ln -sfn "$APP/common" "$APP/server/node_modules/@space-game/common"
mkdir -p "$APP/data/ships/players"
mkdir -p "$APP/data/profiles" "$APP/data/lobby" "$APP/data/contributor" "$APP/data/site" "$APP/data/world"
rsync -a --exclude users.json --exclude 'lobby/' --exclude 'ships/players/' --exclude 'profiles/' --exclude 'telemetry/' --exclude 'contributor/' --exclude 'status/' --exclude '/site/' --exclude '/world/' "$B/data/" "$APP/data/"
rm -rf "$B"
chown -R spacegame:spacegame "$APP"

# Secrets, each made once here (root-only, never printed) and read by the services (EnvironmentFile):
#   LOBBY_ADMIN_SECRET  shared by the lobby, the game server and the website (managing accounts: ranks, bans)
#   SITE_SECRET         the website's own (it signs its forms)
#   ADMIN_SERVER_PASSWORD  the game server's admin dashboard (127.0.0.1:3105 only; see it with
#                       sudo grep ADMIN_SERVER_PASSWORD /etc/spacegame/secrets.env). Not ADMIN_PASSWORD: the lobby
#                       reads that one to make an admin account
SECRETS=/etc/spacegame/secrets.env
install -d -m 700 /etc/spacegame
for name in LOBBY_ADMIN_SECRET SITE_SECRET ADMIN_SERVER_PASSWORD; do
  if ! grep -q "^$name=" "$SECRETS" 2>/dev/null; then
    (umask 077; echo "$name=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$SECRETS")
  fi
done

UNITS="spacegame-browser spacegame-server$([ $SITE = 1 ] && echo ' spacegame-site')"
for u in $UNITS; do install -m 644 "$SRC/$u.service" /etc/systemd/system/; done
systemctl daemon-reload
systemctl enable $UNITS
systemctl restart $UNITS

# nginx site: install once; certbot edits it in place afterwards, so don't overwrite it
SITE_CONF=/etc/nginx/sites-available/spacegame
if [ ! -f "$SITE_CONF" ]; then
  install -m 644 "$SRC/nginx-spacegame.conf" "$SITE_CONF"
  ln -sf "$SITE_CONF" /etc/nginx/sites-enabled/spacegame
fi
# ...but the website's routes are a snippet that file includes, refreshed on every deploy (with the website)
if [ $SITE = 1 ]; then
install -D -m 644 "$SRC/nginx-spacegame-site.conf" /etc/nginx/snippets/spacegame-site.conf
# A site file from before the website still has its own "location /" (the static game client): swap it,
# once, for the include (the include line is the marker that it's done). The old file is kept beside it,
# and put back if nginx doesn't accept the result.
if ! grep -q 'snippets/spacegame-site.conf' "$SITE_CONF"; then
  cp -p "$SITE_CONF" "$SITE_CONF.before-website"
  awk '
    /The client opens its WebSocket at the site root/ { next }
    skipping { depth += gsub(/\{/, "{") - gsub(/\}/, "}"); if (depth <= 0) skipping = 0; next }
    /^[ \t]*location \/ \{[ \t]*$/ { print "    # The website (and, at the root, the game socket): see /etc/nginx/snippets/spacegame-site.conf"; print "    include /etc/nginx/snippets/spacegame-site.conf;"; skipping = 1; depth = 1; next }
    { print }
  ' "$SITE_CONF.before-website" > "$SITE_CONF"
  if ! grep -q 'snippets/spacegame-site.conf' "$SITE_CONF" || ! nginx -t 2>/dev/null; then
    cp -p "$SITE_CONF.before-website" "$SITE_CONF"
    echo "Could not add the website's routes to $SITE_CONF; left it as it was. Add the include by hand (site/REVIEW.md, nginx)." >&2
  fi
fi
fi
nginx -t && systemctl reload nginx

# The website refuses to start when a setting is missing: say so here rather than leave it restarting
[ $SITE = 1 ] && sleep 3 && { systemctl is-active --quiet spacegame-site || { echo "WARNING: spacegame-site is not running:" >&2; journalctl -u spacegame-site -n 15 --no-pager >&2; }; }
echo "Deployed."
