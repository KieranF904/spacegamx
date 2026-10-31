# Development guide (router)

The project runs fully locally: no Supabase, no Fly.io, no external services. Production is the user's shared VPS
(`deploy/vps/deploy.sh`, see the ops-tools guide). Read this page, then only your area's guide in the table below.
Never open the god-files whole (`GameServer.ts`, `Game.ts`, `Renderer.ts`, `HangarUI.ts`,
`protocol.ts`, `sandbox.ts`): the guides give section maps to grep. The Stage 2-5 splits are where to start: `server/src/ships/bridge/*.ts`, `server/src/net/auth.ts`, `server/src/net/handlers/*.ts`, `server/src/net/SnapshotBuilder.ts`, `server/src/net/snapshot/*.ts`, `server/src/game/Docking.ts`, `server/src/game/Derelicts.ts`, `client/src/app/*.ts`, `common/src/network/inputFields.ts`, `common/src/ships/flightInputs.ts`.

## Quick start

```powershell
cd game-v2
npm run install:all      # first time only
npm run dev:browser      # server browser / lobby, port 8787
npm run dev:server       # game server, port 3000 (admin dashboard on 3005)
npm run dev:client       # Vite client, port 5273
```

Then open http://localhost:5273. No servers needed for `npm run proto` (the game server runs in the browser tab; open
`/?proto`). The website is separate: `cd site; npm run dev` (port 5310, needs the lobby on 8787).

| Service | Port | Purpose |
|---|---|---|
| Client (Vite) | 5273 | Game client, sandbox, `viewer.html`, `sunlab.html`, `planetlab.html` (dev only) |
| Game server | 3000 | WebSocket game server + HTTP auth |
| Admin server | 3005 | Live admin dashboard (password `admin` in dev; see `ADMIN_SERVER_PASSWORD`) |
| Server browser (lobby) | 8787 | Lobby/server registry and accounts |
| Website | 5310 | `site/`: updates, community, accounts, Play |
| Native renderer | 5311 | Stills service (127.0.0.1 only), `npm run render` |

Dev accounts: the JSON user store seeds `admin` / `admin` on first run (`data/users.json`, gitignored; delete to reset).

## Tests

Run from `game-v2/` with the root config, which also covers the client tests: `npx vitest run` (all, `npm test`),
or one area: `npx vitest run common/src/ships` (each guide lists its tests). The site's tests run with the rest
(`--pool=forks --no-file-parallelism` if you run them alone).
Never leave dev servers or headless browsers running after a check.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Game server port |
| `ADMIN_PORT` | 3005 | Admin dashboard port |
| `ADMIN_SERVER_PASSWORD` | dev `admin`; production none | Admin dashboard password (then `ADMIN_PASSWORD`, then `LOBBY_ADMIN_SECRET`). With none in production the dashboard does not start. The VPS deploy makes one in `/etc/spacegame/secrets.env` |
| `BROWSER_URL` | `http://localhost:8787` | Server browser URL |
| `LOBBY_ADMIN_SECRET` | dev fixed; production none | Shared by the lobby and game servers for admin account commands (admin rank, bans); same value on both; with none in production those commands are refused |
| `PUBLIC_HOST` | `localhost` | Host reported to the browser |
| `USER_STORE_BACKEND` | `json` | `json` or `postgres` (production is `postgres`, set by systemd drop-ins) |
| `DATABASE_URL` | none | PostgreSQL connection string |
| `VITE_BROWSER_URL` | `http://localhost:8787` | Client-side lobby URL (Vite) |

Site, renderer and ops variables (`SITE_*`, `GAME_MODE`, `NATIVE_RENDER_PORT`, ...) are in the web-accounts and
render-ships guides.

## Areas

| Area | Guide | Covers |
|---|---|---|
| Ship parts & models | [docs/areas/ship-parts.md](docs/areas/ship-parts.md) | `models.mjs`, `rebuild`, grades, ratings, engines, mounting rules |
| Energy & banks | [docs/areas/energy.md](docs/areas/energy.md) | wires, the ship pool and Output, batteries, Capacitor and Drive Cell banks, discharge, brownouts |
| Flight & physics | [docs/areas/flight.md](docs/areas/flight.md) | `stepFlight`, jump drive, cargo mass, strafer, tow, docking |
| Weapons & combat | [docs/areas/weapons.md](docs/areas/weapons.md) | guns, shells, beams, support weapons, part deaths, repair |
| Bosses, enemies & AI | [docs/areas/bosses-ai.md](docs/areas/bosses-ai.md) | bosses (see also `docs/boss-design.md`), packs, zones, events |
| World, systems & sim LOD | [docs/areas/world-sim.md](docs/areas/world-sim.md) | systems, travel, surfaces, sieges, hazards, cold, world memory |
| Economy, items & quests | [docs/areas/economy-quests.md](docs/areas/economy-quests.md) | items, recipes, hangar jobs, profiles and saves, quests, people, records |
| Networking & protocol | [docs/areas/networking.md](docs/areas/networking.md) | snapshots, replication, wire format, protocol changes |
| Server core | [docs/areas/server-core.md](docs/areas/server-core.md) | `GameServer` map, tick order, performance, data validation |
| Rendering: ships | [docs/areas/render-ships.md](docs/areas/render-ships.md) | hull look, part hardware, FX, asset viewer, native renderer |
| Rendering: world | [docs/areas/render-world.md](docs/areas/render-world.md) | sky, star, planets, lighting, asset cache, shaders, frame cost |
| Hangar UI | [docs/areas/hangar-ui.md](docs/areas/hangar-ui.md) | hangar editor, refit flow, proto tools |
| UI, HUD & input | [docs/areas/ui-hud-input.md](docs/areas/ui-hud-input.md) | menus, settings, keybindings, map, audio, admin panel |
| Website, lobby & accounts | [docs/areas/web-accounts.md](docs/areas/web-accounts.md) | `site/`, `server-browser/`, post-update CLI, Play handoff |
| Ops, deploy & tools | [docs/areas/ops-tools.md](docs/areas/ops-tools.md) | VPS deploy, backups, monitor, benches, sound generation, panels |

Each folder with a `CONTEXT.md` (`common/src/{ships,network,econ}`, `server/src/game`, `client/src/{rendering,ships,ui}`,
`deploy`, `server-browser`) points at its guide.

## Practices

- **Panels** (before/after images for updates): add one entry file in `docs/panels/entries/`, then `npm run panels:index`;
  never edit `docs/panels/index.md` by hand. Details: [docs/panels/README.md](docs/panels/README.md).
- **Protocol changes**: `npm run wire:sync` after adding a model/material/piece; `npm run wire:bump "reason"` after any
  wire change. Rules and files: networking guide, "Protocol changes".
- **New boss**: follow [docs/boss-design.md](docs/boss-design.md). Stills: `npm run render` (native, no browser).
- **Production data**: accounts and profiles are on Postgres since 2026-10-31; see `docs/ops/postgres-migration.md`
  (rollback steps). Local dev uses JSON files under `data/` (gitignored, kept by deploys).
- **Lore**: [docs/lore-canon.md](docs/lore-canon.md); every lore claim needs an in-game owner.
- Older long-form notes: `docs/engine-map.md` is now an index into the guides; design docs live in `docs/design/`,
  `docs/rendering/`, `docs/audits/`.
