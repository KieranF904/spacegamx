# Ops, deploy & tools
How the game gets onto the user's shared VPS (space.brotherk3d.com), how it is backed up and watched, and the developer tooling around it: dev servers and ports, test commands, benches, profilers, still/screenshot renderers, update panels, notifications. The VPS is shared with the user's other projects (brotherk3d.service on :3001, mealmaker, Postgres, nginx site `brotherk3d`): never disturb them. No Docker on the box on purpose. Fly.io is retired; "live game" means the networked code and the VPS.

## Files (what each owns)
| path | lines | owns |
|---|---|---|
| `deploy/vps/deploy.sh` | 19 | Local entry: tars `common server server-browser client data` (+`site` if `WITH_SITE=1`), excluding player/runtime data, scp to the box, runs `remote-install.sh` over ssh (`DEPLOY_HOST` root@brotherk3d.com, `DEPLOY_KEY` ~/.ssh/bk3d_deploy) |
| `deploy/vps/remote-install.sh` | 99 | Runs on the VPS as root: builds in `/opt/spacegame/.build` as user `spacegame`, stops units, swaps dirs, keeps data, makes secrets once, installs units/timer, nginx snippet, restarts, `nginx -t && reload` |
| `deploy/vps/spacegame-{server,browser,site}.service` | 27-36 | Units. Server: 127.0.0.1:3100, admin 3105, `BROWSER_URL=http://127.0.0.1:8790`; lobby 8790; site 8791 (`GAME_MODE=static`). Hardened (`ProtectSystem=strict`, `ReadWritePaths`) |
| `deploy/vps/spacegame-dbdump.{service,timer}` | 17/10 | Nightly 04:20 `pg_dump` to `/opt/spacegame/data/backups/db/spacegame-YYYY-MM-DD.sql.gz`, keeps 14. Installed only when secrets.env has `DATABASE_URL` |
| `deploy/vps/nginx-spacegame.conf`, `nginx-spacegame-site.conf` | 53/57 | Site file installed once (certbot edits it afterwards, never overwritten); the website routes are a snippet refreshed on every `WITH_SITE` deploy |
| `deploy/vps/monitor/{setup.sh,vpsmon-stream,60-vpsmon.conf}`, `scripts/vpsmon/{server.mjs,index.html}` | | Read-only VPS monitor: locked-down `vpsmon` SSH account forced to run `vpsmon-stream`; `npm run monitor` serves a local dashboard (127.0.0.1:8971, token per run). Add a service: edit `UNITS` in `vpsmon-stream` and `SERVICES` in the dashboard JS, rerun `setup.sh` as root with the public key |
| `scripts/notify.mjs` | | Pushover: `node --env-file=.env scripts/notify.mjs "Title" "Message"` (`PUSHOVER_TOKEN`/`PUSHOVER_USER` in `game-v2/.env`) |
| `scripts/contributor-notes.mjs` | | Reads map notes from the live VPS (`/opt/spacegame/data/contributor`) over ssh; `--author`, `--mark-done <id> --note ".."`; needs `npm run build:common` first; docs `docs/contributor-notes.md` |
| `scripts/db/{migrateJsonToPostgres.ts,vps-sync.sh}` | | JSON to Postgres copy/verify (`--dry-run|--verify-only|--replace`); docs `docs/ops/postgres-migration.md` |
| `scripts/render/{render,daemon,daemonClient,cdp}.mjs`, `scripts/native-render/*` | | Stills. `npm run render -- ship:sparrow-t --out x.png` uses the native renderer (Node + Python/OpenGL service, port 5311, no browser, `--list`, `--status`, `--stop`); `--browser` uses the render daemon (`npm run render-daemon`), one headless Chrome |
| `scripts/boss-shots/shoot.mjs` | | Live-game screenshots via DevTools in a tab leased from the daemon's Chrome: `node shoot.mjs <url> <outPrefix> [steps json|@file]` |
| `scripts/profile/{clientProfile,loadTime,precacheAudit,bossBulletHell}.mjs` | | Client frame/CPU profiling (needs Vite 5273 + server 3000), load time, precache audit |
| `server/src/bench/{tickBench,netBench,collisionBench,profileBench,bulletHellBench}.ts` | | Benches. `cd server && npx tsx src/bench/tickBench.ts [--seconds N] [--pilots N]`; `npm run bench:net` (in `server/`) |
| `scripts/gen-sfx.mjs`, `gen-*.mjs`, `scripts/{sun-sky-proto,planet-proto,surface-art,terrain,bespoke}` | | Asset generators and render prototypes (`npm run gen:sfx` reads `.env`) |
| `docs/panels/` (`index.md`, `<date>/<category>/`) | | Before/after panels for dev updates |
| `docs/ops/`, `docs/audits/` | | Ops runbooks and audits (`server-robustness.md` lists what guards the live server) |

## Public interface
- `bash deploy/vps/deploy.sh` (from `game-v2/`): the only way code reaches the VPS. `WITH_SITE=1` adds the website (takes over `/`, game moves to `/play`).
- Secrets live in `/etc/spacegame/secrets.env` (root-only, loaded by units via `EnvironmentFile`): `LOBBY_ADMIN_SECRET`, `SITE_SECRET`, `ADMIN_SERVER_PASSWORD`, `DATABASE_URL`. Created once by `remote-install.sh`; never print or commit them (look up with `sudo grep NAME` on the box only when needed).
- Dev ports: game server 3000 (admin 3005), Vite 5273, site 5310, lobby 8787, native renderer 5311, monitor 8971.
- Data preserved across deploys: `data/{users.json,lobby,ships/players,profiles,telemetry,contributor,status,site,world}`.
- Backups: profile daily copies `data/profiles/backups/<id>/<date>.json` (7 days, `BACKUP_DAYS` in `server/src/profile/JsonProfileStore.ts`); world memory `data/world/memory.json`; nightly pg dumps (14 kept); pre-migration copies under `/opt/spacegame/data/backups-pre-pg-*`.

## Invariants
- Touch only `/opt/spacegame`, the `spacegame-*` units, the `spacegame` nginx site and its snippet. Always `nginx -t` before reload. Do not run SSH/deploy unless the user asked.
- Never print secrets; never commit `.env`. Production must not seed `admin/admin`.
- Git: never `checkout`, `restore`, `stash` or `reset` (huge uncommitted tree; the last deploy tarball `/root/spacegame.tgz` on the VPS is the recovery copy). Commit/push only when asked.
- Process hygiene: check the port before starting a dev server and reuse a running one; kill what you (or your subagents) start, by PID (`taskkill /T /F`), never sweep by port; never kill the user's Chrome (C:\Program Files\Google\Chrome) or processes under a live VS Code terminal.
- One headless browser per agent at a time, closed in a `finally`; no parallel shot runs; run test suites alone, not alongside a browser run; prefer native `npm run render` for stills.
- Panels: capture the "before" first; files `docs/panels/<YYYY-MM-DD>/<category>/<topic>-before.png|-after.png|<topic>.png`, no overlays on pixels, add one entry file in `docs/panels/entries/` and run `npm run panels:index` (see docs/panels/README.md; never edit `docs/panels/index.md` by hand).
- Send a Pushover note before long autonomous work, at milestones, and after a deploy.

## How to extend
1. **Deploy**: from `game-v2/` run `npm test` and a build check, then `bash deploy/vps/deploy.sh` (`WITH_SITE=1` for the site). Watch for `Deployed.`; check https://space.brotherk3d.com/; notify via `notify.mjs`.
2. **Add a systemd unit/timer**: write `deploy/vps/spacegame-<name>.service` (+ `.timer`), copy `spacegame-dbdump.*` as a model (hardening, `ReadWritePaths`, `EnvironmentFile=/etc/spacegame/secrets.env`); `deploy.sh` already scp's `*.service *.timer`; add `install -m 644` + `systemctl enable --now` in `remote-install.sh` (after the `daemon-reload`, guarded like the dbdump block).
3. **Add a secret**: add its name to the `for name in ...` loop in `remote-install.sh` (generated once with `umask 077`).
4. **Add a service to the monitor**: see the monitor row above.
5. **Add a bench/profiler**: `server/src/bench/<x>Bench.ts` (copy `tickBench.ts` header and flags); register an npm script in `server/package.json` if it should be routine.
6. **Fetch contributor notes**: `node scripts/contributor-notes.mjs --author <name>`; after implementing `--mark-done <id> --note "..."`.
7. **Postgres re-sync / switch**: `scripts/db/vps-sync.sh --verify-only|--dry-run|--replace`; full steps in `docs/ops/postgres-migration.md`.

## Tests
- `npx vitest run` from `game-v2/` (root config includes common, server, client, server-browser, site, `scripts/db` tests; heap raised to 6 GB, each server test loads all systems so it is heavy).
- Area slices: `npx vitest run server/src/profile`, `scripts/db`. Client tests alone via `cd client && npx vitest` stub `fs`.
- Shell syntax of deploy scripts (no execution): `bash -n deploy/vps/remote-install.sh deploy/vps/deploy.sh`.
- Typecheck/build: `npm run build` (common, server, client); `cd server-browser && npx tsc --noEmit`; `cd site && npm run typecheck`.
- Dev stack: `npm run dev:browser` (8787), `npm run dev:server` (3000), `npm run dev:client` (5273); see DEVELOPMENT.md Quick Start.

## Gotchas
- `set -euo pipefail` in `remote-install.sh`: a failing test inside `x=$(cond && ...)` or a bare `cond && cmd` as the last command can abort the deploy mid-swap with services stopped. Existing lines use `x=$([ ... ] && echo 1 || echo 0)` (the `|| ` makes it safe); keep that shape, or use `if`.
- The units are stopped before the directory swap and started at the end: a failure between leaves the game down; re-run the script after fixing.
- `nginx-spacegame.conf` is installed only if the site file is missing (certbot edits it); changing it in the repo does nothing on the box. Website routes come from the snippet, refreshed only with `WITH_SITE=1`.
- Vite node stubs (`fs path os url zlib` -> `client/src/nodeStubs.ts`) mean a server module that does real file I/O breaks the sandbox bundle.
- Render daemon: a leaked tab lease blocks every later `shoot.mjs` run until `LEASE_MS` (20 min) expires; always close/return your tab; check for orphaned "Chrome for Testing"/`--headless` processes by executable path after stopping agents (three parallel agents once left about 30 at 100% CPU).
- The VPS still allows password logins for root (flagged to the user, unchanged).
- Production uses Postgres since 2026-10-31 ~14:33 via the systemd drop-ins `spacegame-{browser,server}.service.d/postgres.conf` (not in repo units; the deploy leaves drop-ins alone). Pre-switch backups: `/opt/spacegame/data/backups-pre-pgswitch-20261031-143323`. The deploy installs the nightly `pg_dump` timer `spacegame-dbdump`. `docs/ops/postgres-migration.md` has the rollback steps.
- Windows host, Git Bash: use forward slashes and `/dev/null`; temp files go in the session scratchpad.

## Related areas
`web-accounts` (site, lobby, Postgres stores), `server-core` (profile stores, status file `data/status/live.json` that the monitor reads, graceful shutdown), `render-ships` and `render-world` (renderers used by stills), `bosses-ai` (boss-shots stage files `scripts/boss-shots/*.json`), `ui-hud-input` (screenshot checks), `networking` (netBench).

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **VPS monitor**: `npm run monitor` opens a dashboard of the box's CPU, memory, network, disk, each service and the game's tick times, streamed over SSH as a read-only `vpsmon` account (key `~/.ssh/vpsmon_ed25519`; set up by `deploy/vps/monitor/setup.sh`, which only lets that key run the stats script).
- **Sound files**: effects are generated with fal.ai (`fal-ai/elevenlabs/sound-effects/v2`) by `npm run gen:sfx` (`scripts/gen-sfx.mjs`, key from `.env`; prompts in `scripts/sfx-manifest.json`) into `client/public/sfx/` with an `index.json`; `AudioManager` loads and prepares them (ui-hud-input notes).
- **Panels practice** (before/after panels): see `docs/panels/README.md`. Put images in `docs/panels/<date>/<category>/`, add one entry file in `docs/panels/entries/`, run `npm run panels:index`; never edit `docs/panels/index.md` by hand.
- **Boss shots / stills**: `npm run render` (native, no browser) for stills; `scripts/boss-shots/shoot.mjs` only for live-game shots (render-ships notes).
- **Profiling**: `node scripts/profile/loadTime.mjs <client url>` (first visit vs reload); tick-breakdown harness over `GameServer.step()` and `npm run bench:net` in `server/`. Performance pass of 2026-10-25 (headless Chrome 1600x900 on an RTX 5070 Ti, SwiftShader at 960x540 as a weak-GPU stand-in): client 0.4-1.2 ms CPU a frame in every scene tried (system map adds ~0.4 ms), heap steady ~24 MB, server 0.07 ms a tick empty to ~1.4 ms with 40 pilots and 140 hostiles. Wins: sun quad cut to what it draws (Sol Central software frame ~190 -> ~130 ms), shader quads share programs (a repeat visit to Ashfall 50 -> 6 ms, the Maw 32 -> 1.6 ms), turret windows skip parts their rays miss (~2x; all-designs state build ~22 -> ~12 ms). Left as is: star layers are most of the GPU work; snapshots grow with clients x rows (100 crowded pilots ~4.4 ms on a snapshot tick).
- **Scripts worth knowing**: `scripts/ship-ratings.ts` (run with `npx vite-node`: every design's rating per grade and every system's pack ratings), `scripts/ship-energy.ts`, `scripts/add-batteries.ts`, `scripts/merge-thrusters.ts`, `scripts/gen-enemy-ships.mjs`, `scripts/econ/models.mjs` (see ship-parts), `scripts/render-ships.ts`.
- **Dev servers**: client Vite 5273 (also `viewer.html`, `sunlab.html`, `planetlab.html`), game server 3000, admin dashboard 3005, lobby 8787, site 5310, native-render service 5311 (127.0.0.1 only), render daemon 5281, `npm run proto` for the in-browser server. Environment variables are in the DEVELOPMENT.md router table.
