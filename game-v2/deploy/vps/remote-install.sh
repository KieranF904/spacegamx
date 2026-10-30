#!/usr/bin/env bash
# Runs on the VPS as root: unpack /root/spacegame.tgz into /opt/spacegame,
# keep player data, build, install the services and nginx site, restart.
# Touches nothing outside /opt/spacegame, its two systemd units and its nginx site.
set -euo pipefail

APP=/opt/spacegame
TGZ=/root/spacegame.tgz
SRC=$(cd "$(dirname "$0")" && pwd)
PARTS="common server server-browser client"

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
run "cd $B/client && npm ci --no-audit --no-fund && VITE_BROWSER_URL=https://space.brotherk3d.com/lobby npx vite build"

# Swap in the new build; player accounts, saved ships, profiles, telemetry and contributor notes stay
systemctl stop spacegame-server spacegame-browser 2>/dev/null || true
for d in $PARTS; do rm -rf "$APP/$d"; mv "$B/$d" "$APP/$d"; done
ln -sfn "$APP/common" "$APP/server/node_modules/@space-game/common"
mkdir -p "$APP/data/ships/players"
mkdir -p "$APP/data/profiles" "$APP/data/lobby" "$APP/data/contributor"
rsync -a --exclude users.json --exclude 'lobby/' --exclude 'ships/players/' --exclude 'profiles/' --exclude 'telemetry/' --exclude 'contributor/' --exclude 'status/' "$B/data/" "$APP/data/"
rm -rf "$B"
chown -R spacegame:spacegame "$APP"

# The lobby and the game server share a secret for managing accounts (the admin tools' ranks and bans):
# made once here (root-only, never printed) and read by both services (EnvironmentFile)
SECRETS=/etc/spacegame/secrets.env
install -d -m 700 /etc/spacegame
if ! grep -q '^LOBBY_ADMIN_SECRET=' "$SECRETS" 2>/dev/null; then
  (umask 077; echo "LOBBY_ADMIN_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$SECRETS")
fi

install -m 644 "$SRC/spacegame-server.service" "$SRC/spacegame-browser.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable spacegame-browser spacegame-server
systemctl restart spacegame-browser spacegame-server

# nginx site: install once; certbot edits it in place afterwards, so don't overwrite it
if [ ! -f /etc/nginx/sites-available/spacegame ]; then
  install -m 644 "$SRC/nginx-spacegame.conf" /etc/nginx/sites-available/spacegame
  ln -sf /etc/nginx/sites-available/spacegame /etc/nginx/sites-enabled/spacegame
fi
nginx -t && systemctl reload nginx
echo "Deployed."
