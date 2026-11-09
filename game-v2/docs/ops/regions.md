# Regional game servers (Fly.io)

Design: every region runs the same game and data, each world independent (own spawns, boss timers, `data/world/memory.json`).
Accounts, rankings, friends and inbox stay central (VPS Postgres + the lobby, `server-browser/`). One server today (the VPS);
nothing here changes it. Nothing below has been run.

## Files
- `deploy/fly/Dockerfile.server` (+ `.dockerignore`), `deploy/fly/fly.server.toml`: the on-demand server (shared-cpu-1x, 512 MB,
  `auto_stop_machines='suspend'`, `min_machines_running=0`, a 1 GB-ish volume for the world memory).
- `scripts/deploy/regions.mjs`: build once, same image to every region, then the VPS. Dry run unless `--apply`.
- Server env: `SERVER_REGION`, `SERVER_NAME`, `PUBLIC_HOST`, `BROWSER_URL` (= `LOBBY_URL`), `USER_STORE_BACKEND=postgres`;
  secrets `DATABASE_URL`, `LOBBY_ADMIN_SECRET`, `ADMIN_SERVER_PASSWORD`. `SERVER_ID` is set per app but the server does not read it yet
  (the lobby's region file work uses it).
- Wake-up: after a suspend/resume the loop skips a gap over 2 s (`server/src/gameServer/wakeGap.ts`): no catch-up ticks; the tick
  counter jumps, so boss/nest timers and world memory advance by wall clock like an empty system. Logged as `[Loop] woke after ...`.
- Old `fly.toml`, `fly.server.toml`, `fly.client.toml`, `server/fly.toml` are legacy (the old always-on apps); left untouched, unused.
- The region file `server-browser/regions.json` (format in the script header) is assumed to be what the lobby package defines; align the names.

## Add a region
1. `fly apps create spacegame-<id>`; `fly volumes create spacegame_world -a spacegame-<id> -r <region> -n 1 -s 1`.
2. `fly secrets set -a spacegame-<id> DATABASE_URL=... LOBBY_ADMIN_SECRET=... ADMIN_SERVER_PASSWORD=...`.
3. Let the app reach VPS Postgres (VPS steps, Kieran approves each): either TLS on Postgres (server cert, `hostssl` line in
   `pg_hba.conf` limited to Fly egress IPs, ufw rule for 5432 from those IPs) or a WireGuard tunnel (`fly wireguard create`, peer on the VPS,
   Postgres listening on the tunnel address only). Prefer WireGuard: nothing public. Use `sslmode=require` either way.
4. Add the server to the lobby region file (id, region, app, name, host `spacegame-<id>.fly.dev`) so it is listed while asleep, and register it in the lobby.
5. `node scripts/deploy/regions.mjs --only <id> --no-vps` (dry run first), then with `--apply`.

## Updates
Frontend is served from the VPS (versioned). A release: `node scripts/deploy/regions.mjs --apply` builds one image, deploys it to each
region, then runs `deploy/vps/deploy.sh`. Awake servers get the update countdown (15/5/1 min) from the lobby work before restarting;
suspended ones start on the new build when woken. Clients only join servers on their version.

## Costs
shared-cpu-1x 512 MB is about $3-4/month if it ran all month; suspended machines cost only their volume (about $0.15/GB-month) and
snapshot storage. Egress and extra regions add up per region; check Fly's current pricing before the first apply. A suspended machine is
free of CPU charges but takes a moment to wake on the first connection.
