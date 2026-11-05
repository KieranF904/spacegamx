#!/usr/bin/env bash
# Runs on the VPS as root (deploy.sh starts it):
#   remote-install.sh                  install /root/spacegame.tgz into /opt/spacegame (WITH_SITE=1: the website too):
#                                      build, test nginx, swap, keep player data, restart, keep the release for rollback
#   remote-install.sh rollback [name]  put back the release before the current one (or the one named)
#   remote-install.sh releases         list the kept releases
# Touches nothing outside /opt/spacegame, its systemd units (game, lobby, website, nightly DB dump), its nginx site
# (/etc/nginx/sites-available/spacegame, its link in sites-enabled) and its snippets (/etc/nginx/snippets/spacegame-*.conf).
# Every nginx change is tested with nginx -t and put back as it was if that fails (and the deploy stops, non-zero).
set -euo pipefail

APP=/opt/spacegame
TGZ=/root/spacegame.tgz
SRC=$(cd "$(dirname "$0")" && pwd)
REL=$APP/releases
CURRENT=$APP/current-release
KEEP=3
# The website only when asked (WITH_SITE=1)
SITE=$([ "${WITH_SITE:-0}" = 1 ] && echo 1 || echo 0)
# Every part a release can have; a deploy ships the first four, and the website with WITH_SITE=1
ALL_PARTS="common server server-browser client site"
# What the players and the services make at runtime: kept by every deploy and rollback (never deleted by --delete).
# backups* covers data/backups (the nightly dumps) and the hand-made copies beside it (backups-pre-pgswitch-...)
RUNTIME=(--exclude='/users.json*' --exclude='/users.db*' --exclude=/lobby/ --exclude=/ships/players/
  --exclude=/profiles/ --exclude=/telemetry/ --exclude=/contributor/ --exclude=/status/ --exclude=/site/ --exclude=/world/
  --exclude='/backups*')
# Game data files a deploy or rollback replaces or removes are moved here, not lost (the newest KEEP kept)
REMOVED=$APP/data-replaced

log() { echo "== $*"; }

# ---------------------------------------------------------------------------------------------------------------------
# nginx: install files, test the whole config, put every file back as it was if the test fails
NGINX_BAK=""
NGINX_TOUCHED=()
nginx_put() { # <source file> <destination>
  local src=$1 dst=$2 key
  [ -n "$NGINX_BAK" ] || NGINX_BAK=$(mktemp -d)
  key=$(printf '%s' "$dst" | tr '/' '_')
  if [ ! -e "$NGINX_BAK/$key" ] && [ ! -e "$NGINX_BAK/$key.absent" ]; then
    if [ -e "$dst" ] || [ -L "$dst" ]; then cp -P -p "$dst" "$NGINX_BAK/$key"; else : > "$NGINX_BAK/$key.absent"; fi
    NGINX_TOUCHED+=("$dst")
  fi
  # (written beside it first, then moved over it in one step)
  install -D -m 644 "$src" "$dst.spacegame-new"
  mv -f "$dst.spacegame-new" "$dst"
}
nginx_link() { # <target> <link>
  local key
  [ -n "$NGINX_BAK" ] || NGINX_BAK=$(mktemp -d)
  key=$(printf '%s' "$2" | tr '/' '_')
  if [ ! -e "$NGINX_BAK/$key" ] && [ ! -e "$NGINX_BAK/$key.absent" ]; then
    if [ -e "$2" ] || [ -L "$2" ]; then cp -P -p "$2" "$NGINX_BAK/$key"; else : > "$NGINX_BAK/$key.absent"; fi
    NGINX_TOUCHED+=("$2")
  fi
  ln -sfn "$1" "$2"
}
nginx_revert() {
  local dst key
  for dst in "${NGINX_TOUCHED[@]}"; do
    key=$(printf '%s' "$dst" | tr '/' '_')
    if [ -e "$NGINX_BAK/$key.absent" ]; then rm -f "$dst"; else rm -f "$dst"; cp -P -p "$NGINX_BAK/$key" "$dst"; fi
  done
}
# Test what was put; reload if it passes. If it fails: everything put back, and false (the caller stops)
nginx_commit() {
  local out
  if out=$(nginx -t 2>&1); then
    NGINX_TOUCHED=()
    systemctl reload nginx || { echo "nginx -t passed but the reload failed (systemctl status nginx)" >&2; return 1; }
    return 0
  fi
  echo "nginx -t failed with the new files:" >&2
  echo "$out" >&2
  nginx_revert
  NGINX_TOUCHED=()
  if nginx -t >/dev/null 2>&1; then echo "Put the previous nginx files back; nginx was not reloaded." >&2
  else echo "Put the previous nginx files back, but nginx -t still fails: something outside this site is broken too." >&2; fi
  return 1
}

# Cuts an older live site file (routes written in it, certbot's TLS lines added) down to the new shape, once: every
# "location" block, root, index, gzip and comment-only line in its server blocks goes, the old snippet includes go,
# and the game snippet's include takes the place of "root /opt/spacegame/...". listen, server_name, the TLS lines,
# certbot's redirect block and anything else are kept as they are.
nginx_migrate() { # <old file> <new file>
  awk '
    function count(s, c,   t) { t = s; return gsub(c, "", t) }
    {
      line = $0
      opens = count(line, "[{]"); closes = count(line, "[}]")
      if (skipping) { sdepth += opens - closes; if (sdepth <= 0) skipping = 0; next }
      if (depth >= 1 && line ~ /^[ \t]*location[ \t]/) { sdepth = opens - closes; skipping = sdepth > 0; next }
      if (depth >= 1 && line ~ /^[ \t]*root[ \t]+\/opt\/spacegame\//) { print "    include /etc/nginx/snippets/spacegame-game.conf;"; next }
      if (depth >= 1 && line ~ /^[ \t]*(root|index|gzip[a-z_]*)[ \t]/) next
      if (depth >= 1 && line ~ /^[ \t]*#/) next
      if (line ~ /^[ \t]*include[ \t]+\/etc\/nginx\/snippets\/spacegame-/) next
      print
      depth += opens - closes
    }
  ' "$1" > "$2"
}

# The nginx files from <deploy files dir>: the game's snippet, the root (the website's, or the game alone), and the
# site file itself the first time (or cut down once from an older one)
install_nginx() { # <deploy files dir>
  local from=$1 root_conf site_conf=/etc/nginx/sites-available/spacegame tmp
  # The root: the website's when it ships now or is already running (a game-only deploy never takes / from a running
  # website), else the game alone (the website's files aren't needed)
  if [ $SITE = 1 ] || systemctl is-active --quiet spacegame-site; then root_conf=nginx-spacegame-site.conf; else root_conf=nginx-spacegame-play.conf; fi
  log "nginx: game snippet, root from $root_conf"
  nginx_put "$from/nginx-spacegame-game.conf" /etc/nginx/snippets/spacegame-game.conf
  nginx_put "$from/$root_conf" /etc/nginx/snippets/spacegame-root.conf
  if [ ! -f "$site_conf" ]; then
    nginx_put "$from/nginx-spacegame.conf" "$site_conf"
    nginx_link "$site_conf" /etc/nginx/sites-enabled/spacegame
  elif ! grep -q 'snippets/spacegame-game.conf' "$site_conf"; then
    log "nginx: cutting $site_conf down to its listen/TLS lines and the game snippet (old copy: /root/spacegame-nginx-site.before-snippets)"
    cp -p "$site_conf" /root/spacegame-nginx-site.before-snippets
    tmp=$(mktemp)
    nginx_migrate "$site_conf" "$tmp"
    if ! grep -q 'snippets/spacegame-game.conf' "$tmp"; then
      rm -f "$tmp"; nginx_revert; NGINX_TOUCHED=()
      echo "Could not find \"root /opt/spacegame/...\" in $site_conf to put the game snippet's include in its place." >&2
      echo "By hand: keep its listen, server_name and TLS lines, replace the rest of that server block with" >&2
      echo "    include /etc/nginx/snippets/spacegame-game.conf;" >&2
      echo "then run this again." >&2
      return 1
    fi
    nginx_put "$tmp" "$site_conf"
    rm -f "$tmp"
  fi
  nginx_commit
}

# ---------------------------------------------------------------------------------------------------------------------
# Data folder: the services' own (750, files made 640 by their UMask); the resource monitor (vpsmon, deploy/vps/monitor)
# may still read data/status/live.json, through an ACL
data_perms() {
  mkdir -p "$APP/data/ships/players" "$APP/data/profiles" "$APP/data/lobby" "$APP/data/contributor" "$APP/data/site" \
    "$APP/data/world" "$APP/data/status"
  chown -R spacegame:spacegame "$APP/data"
  chmod 750 "$APP/data"
  if id vpsmon >/dev/null 2>&1; then
    if command -v setfacl >/dev/null 2>&1; then
      setfacl -m u:vpsmon:x "$APP/data"
      setfacl -m u:vpsmon:rx "$APP/data/status"
      # (files the game server makes there later: readable by vpsmon too, whatever its umask)
      setfacl -d -m u::rwx,g::rx,o::-,u:vpsmon:r "$APP/data/status"
      if [ -f "$APP/data/status/live.json" ]; then setfacl -m u:vpsmon:r "$APP/data/status/live.json"; fi
    else
      echo "WARNING: no setfacl (apt install acl): the resource monitor can't read data/status/live.json now that data/ is 750" >&2
    fi
  fi
}

# The dump script (root's, so the service account can't change what its timer runs)
install_dbdump() { # <deploy files dir>
  local from=$1
  if grep -q '^DATABASE_URL=' "$SECRETS" 2>/dev/null; then
    install -d -o root -g root -m 755 "$APP/bin"
    install -o root -g root -m 755 "$from/spacegame-dbdump.sh" "$APP/bin/spacegame-dbdump"
    install -m 644 "$from/spacegame-dbdump.service" "$from/spacegame-dbdump.timer" /etc/systemd/system/
    mkdir -p "$APP/data/backups"; chown spacegame:spacegame "$APP/data/backups"; chmod 750 "$APP/data/backups"
    systemctl daemon-reload
    systemctl enable --now spacegame-dbdump.timer
  fi
}

# ---------------------------------------------------------------------------------------------------------------------
# Releases: /opt/spacegame/releases/<YYYYmmdd-HHMMSS>, each the code parts (hard links to the live files, so a
# release costs little disk), the game data files (runtime data left out), the deploy files and REVISION (the git
# commit and whether the tree was dirty). current-release points at the one running. The newest KEEP are kept
# (and always the current one).
snapshot() { # <release dir> <revision text>
  local r=$1 d
  mkdir -p "$r"
  for d in $ALL_PARTS; do [ -d "$APP/$d" ] && cp -al "$APP/$d" "$r/$d"; done
  rsync -a --link-dest="$APP/data/" "${RUNTIME[@]}" "$APP/data/" "$r/data/"
  printf '%s\n' "$2" > "$r/REVISION"
}
prune() {
  local cur keep=0 r
  cur=$(readlink -f "$CURRENT" 2>/dev/null || true)
  for r in $(ls -1d "$REL"/[0-9]* 2>/dev/null | sort -r); do
    if [ "$r" = "$cur" ]; then continue; fi
    keep=$((keep + 1))
    # (the current one counts among the KEEP)
    if [ $keep -ge $KEEP ]; then log "dropping old release $(basename "$r")"; rm -rf "$r"; fi
  done
}
list_releases() {
  local cur r
  cur=$(readlink -f "$CURRENT" 2>/dev/null || true)
  for r in $(ls -1d "$REL"/[0-9]* 2>/dev/null | sort); do
    printf '%s %s  %s\n' "$([ "$r" = "$cur" ] && echo '*' || echo ' ')" "$(basename "$r")" "$(grep -E '^(commit|dirty)=' "$r/REVISION" 2>/dev/null | tr '\n' ' ')"
  done
}

SECRETS=/etc/spacegame/secrets.env

# The game data files: exactly what <data dir> has (files gone from the repo go from the box too), runtime data
# untouched; whatever is replaced or removed is moved to data-replaced/<time> first
sync_data() { # <data dir>
  local b old
  b="$REMOVED/$(date -u +%Y%m%d-%H%M%S)"
  install -d -m 700 "$REMOVED"
  rsync -a --delete --backup --backup-dir="$b" "${RUNTIME[@]}" "$1/" "$APP/data/"
  if [ -d "$b" ]; then log "game data files replaced or removed by this sync: old copies in $b"; fi
  for old in $(ls -1d "$REMOVED"/[0-9]* 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) || true); do rm -rf "$old"; done
}

# Swap a part in: the old one out, the new one in its place
swap_parts() { # <from dir> <copy|move> <parts...>
  local from=$1 how=$2 d; shift 2
  for d in "$@"; do
    rm -rf "${APP:?}/$d"
    if [ "$how" = move ]; then mv "$from/$d" "$APP/$d"; else cp -al "$from/$d" "$APP/$d"; fi
  done
  ln -sfn "$APP/common" "$APP/server/node_modules/@space-game/common"
}

# ---------------------------------------------------------------------------------------------------------------------
rollback() {
  local cur target name units d parts=""
  mkdir -p "$REL"
  cur=$(readlink -f "$CURRENT" 2>/dev/null || true)
  if [ -n "${1:-}" ]; then
    target=$REL/$1
  else
    # The newest release older than the current one
    target=""
    for d in $(ls -1d "$REL"/[0-9]* 2>/dev/null | sort -r); do
      if [ -z "$cur" ] || [[ "$(basename "$d")" < "$(basename "$cur")" ]]; then target=$d; break; fi
    done
  fi
  if [ -z "$target" ] || [ ! -d "$target/server" ]; then echo "No release to roll back to. Kept releases:" >&2; list_releases >&2; exit 1; fi
  [ "$target" = "$cur" ] && { echo "$(basename "$target") is already the current release" >&2; exit 1; }
  name=$(basename "$target")
  log "rolling back to $name ($(grep -E '^commit=' "$target/REVISION" 2>/dev/null || echo 'commit unknown'))"
  for d in $ALL_PARTS; do [ -d "$target/$d" ] && parts="$parts $d"; done
  # Its nginx files, when it has them (an old release from before the deploy files were kept: nginx stays as it is)
  if [ -d "$target/deploy" ]; then
    install_nginx "$target/deploy" || { echo "Rollback stopped: nginx did not accept that release's files (nothing else was changed)." >&2; exit 1; }
  fi
  units="spacegame-browser spacegame-server"
  [ -d "$target/site" ] && systemctl is-enabled --quiet spacegame-site 2>/dev/null && units="$units spacegame-site"
  systemctl stop $units
  # shellcheck disable=SC2086
  swap_parts "$target" copy $parts
  sync_data "$target/data"
  for d in $parts; do chown -R spacegame:spacegame "$APP/$d"; done
  data_perms
  if [ -d "$target/deploy" ]; then
    for d in $units; do install -m 644 "$target/deploy/$d.service" /etc/systemd/system/; done
    systemctl daemon-reload
    install_dbdump "$target/deploy"
  fi
  systemctl restart $units
  ln -sfn "$target" "$CURRENT"
  log "rolled back to $name; running: $units"
}

case "${1:-install}" in
  rollback) rollback "${2:-}"; exit 0 ;;
  releases) list_releases; exit 0 ;;
  install) ;;
  *) echo "usage: remote-install.sh [install | rollback [release] | releases]" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------------------------------------------------
# Install
PARTS="common server server-browser client"; [ $SITE = 1 ] && PARTS="$PARTS site"
UNITS="spacegame-browser spacegame-server"; [ $SITE = 1 ] && UNITS="$UNITS spacegame-site"

id spacegame >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin spacegame
mkdir -p "$APP" "$REL"
chmod 700 "$REL"
# (npm's cache, in the build user's home)
install -d -o spacegame -g spacegame "$APP/.npm"

# Build in a staging folder laid out like the real one (the packages refer to each other as ../common etc.)
B="$APP/.build"
rm -rf "$B"; mkdir -p "$B"
tar -xzf "$TGZ" -C "$B"
chown -R spacegame:spacegame "$B"
REVISION_TEXT="$(cat "$B/REVISION" 2>/dev/null || echo 'commit=unknown')
deployed=$(date -u +%FT%TZ)
with_site=$SITE"

# (builds share the box with other sites: low CPU and disk priority)
run() { nice -n 10 ionice -c2 -n7 sudo -u spacegame -H env HOME="$APP" npm_config_cache="$APP/.npm" bash -c "$1"; }
run "cd $B/common && npm ci --no-audit --no-fund && npm run build"
run "cd $B/server && npm ci --no-audit --no-fund && npx tsc"
run "cd $B/server-browser && npm ci --no-audit --no-fund && npx tsc"
# The website runs its TypeScript through tsx (a dev dependency, so no --omit=dev); the check stops a broken deploy before the swap
if [ $SITE = 1 ]; then run "cd $B/site && npm ci --no-audit --no-fund && npx tsc --noEmit -p ."; fi
run "cd $B/client && npm ci --no-audit --no-fund && VITE_BROWSER_URL=https://space.brotherk3d.com/lobby npx vite build"
# Only the built files are needed at runtime (nginx and the website read client/dist); nginx must be able to read them
rm -rf "$B/client/node_modules"
chmod -R a+rX "$B/client/dist"

# nginx before anything stops: if the new files don't pass nginx -t, they're put back and the deploy ends here
install_nginx "$SRC" || { rm -rf "$B"; echo "Deploy stopped: nginx did not accept the new files (nothing else was changed)." >&2; exit 1; }

# The first deploy with releases: the build that's running now becomes one, so there's something to roll back to
if [ -z "$(ls -1d "$REL"/[0-9]* 2>/dev/null)" ] && [ -d "$APP/server" ]; then
  log "keeping the running build as release $(date -u +%Y%m%d-%H%M%S)-before"
  snapshot "$REL/$(date -u +%Y%m%d-%H%M%S)-before" "commit=unknown (running before releases were kept)"
  ln -sfn "$(ls -1d "$REL"/[0-9]* | sort | tail -n 1)" "$CURRENT"
fi

# Swap in the new build; player accounts, saved ships, profiles, telemetry, contributor notes and the website's data
# stay. Only this deploy's services stop (a game-only deploy leaves a running website alone).
systemctl stop $UNITS 2>/dev/null || true
# shellcheck disable=SC2086
swap_parts "$B" move $PARTS
# The game data files: exactly what was shipped (files gone from the repo go here too), runtime data untouched
mkdir -p "$APP/data"
sync_data "$B/data"
rm -rf "$B"
for d in $PARTS; do chown -R spacegame:spacegame "$APP/$d"; done
data_perms

# Secrets, each made once here (root-only, never printed) and read by the services (EnvironmentFile):
#   LOBBY_ADMIN_SECRET  shared by the lobby, the game server and the website (managing accounts: ranks, bans)
#   SITE_SECRET         the website's own (it signs its forms)
#   ADMIN_SERVER_PASSWORD  the game server's admin dashboard (127.0.0.1:3105 only; see it with
#                       sudo grep ADMIN_SERVER_PASSWORD /etc/spacegame/secrets.env). Not ADMIN_PASSWORD: the lobby
#                       reads that one to make an admin account
# Not made here (add by hand if wanted): OWNER_USERNAMES, comma-separated usernames the lobby makes the owner (the rank
# above admin) at every start, e.g. OWNER_USERNAMES=brotherk3d. Not a secret, but the lobby reads this file.
install -d -m 700 /etc/spacegame
for name in LOBBY_ADMIN_SECRET SITE_SECRET ADMIN_SERVER_PASSWORD; do
  if ! grep -q "^$name=" "$SECRETS" 2>/dev/null; then
    (umask 077; echo "$name=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$SECRETS")
  fi
done

for u in $UNITS; do install -m 644 "$SRC/$u.service" /etc/systemd/system/; done
systemctl daemon-reload
systemctl enable $UNITS
# The nightly dump of the game's Postgres database (only once secrets.env has a DATABASE_URL)
install_dbdump "$SRC"
systemctl restart $UNITS

# This build as a release (with the deploy files it came with), for rollback
R="$REL/$(date -u +%Y%m%d-%H%M%S)"
snapshot "$R" "$REVISION_TEXT"
mkdir -p "$R/deploy"
cp -p "$SRC"/*.service "$SRC"/*.timer "$SRC"/*.conf "$SRC"/*.sh "$R/deploy/"
ln -sfn "$R" "$CURRENT"
prune
log "release $(basename "$R"): $(grep -E '^(commit|dirty)=' "$R/REVISION" | tr '\n' ' ')"

# The website refuses to start when a setting is missing: say so here rather than leave it restarting
if [ $SITE = 1 ]; then
  sleep 3
  systemctl is-active --quiet spacegame-site || { echo "WARNING: spacegame-site is not running:" >&2; journalctl -u spacegame-site -n 15 --no-pager >&2; }
fi
echo "Deployed."
