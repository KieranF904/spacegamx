#!/usr/bin/env bash
# Sets up the resource monitor's account on the VPS (run as root, once; safe to run again):
#   bash setup.sh '<the monitor's public key>'
# A `vpsmon` user with no password, its home owned by root (it can't change its own key or anything else), its one key
# allowed to run only vpsmon-stream, and sshd's rules for it (60-vpsmon.conf), checked before sshd is reloaded.
# Touches nothing of the other projects on the box.
set -euo pipefail
KEY="${1:?usage: setup.sh '<public key>'}"
SRC=$(cd "$(dirname "$0")" && pwd)
case "$KEY" in ssh-ed25519\ *) ;; *) echo "not an ed25519 public key" >&2; exit 1 ;; esac

install -o root -g root -m 755 "$SRC/vpsmon-stream" /usr/local/bin/vpsmon-stream

if ! id vpsmon >/dev/null 2>&1; then
  # (a shell, so sshd can run its forced command; never a password)
  useradd --system --home-dir /var/lib/vpsmon --shell /bin/sh --user-group vpsmon
fi
passwd -l vpsmon >/dev/null
install -d -o root -g root -m 755 /var/lib/vpsmon /var/lib/vpsmon/.ssh
printf 'restrict,command="/usr/local/bin/vpsmon-stream" %s\n' "$KEY" > /var/lib/vpsmon/.ssh/authorized_keys
chown root:root /var/lib/vpsmon/.ssh/authorized_keys
chmod 644 /var/lib/vpsmon/.ssh/authorized_keys

install -o root -g root -m 644 "$SRC/60-vpsmon.conf" /etc/ssh/sshd_config.d/60-vpsmon.conf
# The config must be valid, the monitor locked down, and root's own rules what they were
# (each read in full first: grep -q stopping early would fail the pipe)
undo() { echo "$1" >&2; rm -f /etc/ssh/sshd_config.d/60-vpsmon.conf; exit 1; }
sshd -t || undo "sshd config invalid"
MON=$(sshd -T -C user=vpsmon,host=x,addr=203.0.113.1)
ROOT=$(sshd -T -C user=root,host=x,addr=203.0.113.1)
grep -qi '^forcecommand /usr/local/bin/vpsmon-stream' <<<"$MON" || undo "monitor not forced to its command"
grep -qi '^passwordauthentication no' <<<"$MON" || undo "monitor could use a password"
grep -qi '^permittty no' <<<"$MON" || undo "monitor could get a terminal"
grep -qi '^forcecommand none' <<<"$ROOT" || undo "root caught by the monitor's rules"
systemctl reload ssh
# The game's status file: data/ is the game's own (750), so the monitor reads data/status through an ACL (deploys
# set the same: remote-install.sh data_perms)
if [ -d /opt/spacegame/data ]; then
  if command -v setfacl >/dev/null 2>&1; then
    install -d -o spacegame -g spacegame -m 750 /opt/spacegame/data/status
    setfacl -m u:vpsmon:x /opt/spacegame/data
    setfacl -m u:vpsmon:rx /opt/spacegame/data/status
    setfacl -d -m u::rwx,g::rx,o::-,u:vpsmon:r /opt/spacegame/data/status
    if [ -f /opt/spacegame/data/status/live.json ]; then setfacl -m u:vpsmon:r /opt/spacegame/data/status/live.json; fi
  else
    echo "no setfacl (apt install acl): the monitor can't read the game's status file" >&2
  fi
fi
echo "vpsmon ready"
