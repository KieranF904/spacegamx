#!/usr/bin/env bash
# Runs on the VPS as root (prototypes/netcode-lab/deploy.sh sends it): unpack /root/spacegame-netlab.tgz into
# /opt/spacegame-netlab, install the spacegame-netlab unit and the /netlab/ routes, restart, check.
# Touches nothing but /opt/spacegame-netlab, its unit, /etc/nginx/snippets/spacegame-netlab.conf and one include line in
# the spacegame nginx site. Stops without changing anything if the box doesn't look as expected.
set -euo pipefail

APP=/opt/spacegame-netlab
TGZ=/root/spacegame-netlab.tgz
SRC=$(cd "$(dirname "$0")" && pwd)
PORT=3120
UNIT=spacegame-netlab
SITE=/etc/nginx/sites-available/spacegame
SNIP=/etc/nginx/snippets/spacegame-netlab.conf

# --- Checks first
id spacegame >/dev/null 2>&1 || { echo "no spacegame user: stopping" >&2; exit 1; }
[ -x /usr/bin/node ] || { echo "no /usr/bin/node: stopping" >&2; exit 1; }
command -v npm >/dev/null || { echo "no npm: stopping" >&2; exit 1; }
[ -f "$SITE" ] || { echo "no $SITE: stopping" >&2; exit 1; }
# The port: free, or ours
OWNER=$(ss -ltnpH "sport = :$PORT" | head -1)
if [ -n "$OWNER" ] && ! systemctl is-active --quiet $UNIT; then echo "port $PORT is taken by something else: $OWNER" >&2; exit 1; fi

# --- Build in a staging folder, then swap (the old copy is kept until the new one answers)
B=$APP.new
rm -rf "$B"; mkdir -p "$B"
tar -xzf "$TGZ" -C "$B"
chown -R spacegame:spacegame "$B"
sudo -u spacegame -H env HOME="$B" npm_config_cache="$B/.npm" bash -c "cd $B/server && npm ci --omit=dev --no-audit --no-fund --loglevel=error"
rm -rf "$B/.npm"

systemctl stop $UNIT 2>/dev/null || true
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$B" "$APP"
install -m 644 "$SRC/$UNIT.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable $UNIT >/dev/null 2>&1
systemctl restart $UNIT

ok=0
for i in $(seq 1 20); do sleep 0.5; if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi; done
if [ $ok != 1 ]; then
  echo "the new lab server didn't answer:" >&2; journalctl -u $UNIT -n 20 --no-pager >&2
  if [ -d "$APP.old" ]; then rm -rf "$APP"; mv "$APP.old" "$APP"; systemctl restart $UNIT; echo "put the previous copy back" >&2; fi
  exit 1
fi

# --- nginx: the routes are a snippet; the site gets one include line, inside its HTTPS server block (before "location /")
PREV_SNIP=$(mktemp); [ -f "$SNIP" ] && cp -p "$SNIP" "$PREV_SNIP" || rm -f "$PREV_SNIP"
install -D -m 644 "$SRC/nginx-netlab.conf" "$SNIP"
BACKUP=""
if ! grep -q 'snippets/spacegame-netlab.conf' "$SITE"; then
  BACKUP=/root/spacegame-netlab-deploy/spacegame-site.before-netlab   # (outside sites-available)
  cp -p "$SITE" "$BACKUP"
  # (only the first "    location / {" - the HTTPS block's; the port-80 block has none)
  awk 'done != 1 && /^[ \t]*location \/ \{[ \t]*$/ { print "    # The netcode lab (prototypes/netcode-lab): /netlab/ and its WebSocket"; print "    include /etc/nginx/snippets/spacegame-netlab.conf;"; print ""; done = 1 } { print }' "$BACKUP" > "$SITE"
  grep -q 'snippets/spacegame-netlab.conf' "$SITE" || { cp -p "$BACKUP" "$SITE"; echo "could not place the include in $SITE; left it as it was" >&2; exit 1; }
fi
if nginx -t 2>/dev/null; then
  systemctl reload nginx
else
  echo "nginx -t failed with the lab's routes; putting nginx back as it was (not reloaded):" >&2
  nginx -t >&2 || true
  [ -n "$BACKUP" ] && cp -p "$BACKUP" "$SITE"
  if [ -f "${PREV_SNIP:-/nonexistent}" ]; then cp -p "$PREV_SNIP" "$SNIP"; else rm -f "$SNIP"; fi
  exit 1
fi
rm -f "${PREV_SNIP:-}" 2>/dev/null || true
rm -rf "$APP.old"
echo "Deployed: https://space.brotherk3d.com/netlab/ ($(curl -fsS http://127.0.0.1:$PORT/health))"
