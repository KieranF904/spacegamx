# Development guide (router)

The project runs fully locally: no Supabase, no Fly.io, no external services. Production is the user's shared VPS
(`deploy/vps/deploy.sh`, see the ops-tools guide). Read this page, then only your area's guide in the table below.
Never open the big files whole (`Game.ts`, `Quests.ts`, `GameState.ts`, `GameServer.ts`, `Renderer.ts`,
`HangarUI.ts`; see CLAUDE.md for sizes): the guides give section maps to grep. The Stage 2-5 splits are where to start: `server/src/ships/bridge/*.ts`, `server/src/net/auth.ts`, `server/src/net/handlers/*.ts`, `server/src/net/SnapshotBuilder.ts`, `server/src/net/snapshot/*.ts`, `server/src/game/Docking.ts`, `server/src/game/Derelicts.ts`, `client/src/app/*.ts`, `common/src/network/inputFields.ts`, `common/src/ships/flightInputs.ts`.

## Quick start

```powershell
cd game-v2
npm run install:all      # first time only
npm run dev:browser      # server browser / lobby, port 8787
npm run dev:server       # game server, port 3000 (admin dashboard on 3005)
npm run dev:client       # Vite client, port 5273
```

Then open http://localhost:5273. The website is separate: `cd site; npm run dev` (port 5310, needs the lobby on 8787).

The dev server starts new pilots in the training yard, like production. `TUTORIAL=0` turns the yard off; `DEV_START=rockery` starts every pilot in the dev Rockery instead (dev only; it replaces the yard).

| Service | Port | Purpose |
|---|---|---|
| Client (Vite) | 5273 | Game client, `viewer.html` (dev only) |
| Game server | 3000 | WebSocket game server + HTTP auth |
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
| `BROWSER_URL` | `http://localhost:8787` | Server browser URL |
| `DEV_AUTH` | none (the dev npm scripts set `1`, from `dev.env`) | Turns on the dev-only known passwords: the seeded `admin` account (password `admin`) and the default `LOBBY_ADMIN_SECRET`. Off unless set to `1` explicitly, and never on under `NODE_ENV=production`. A server started by hand (`npm start`, `tsx src/index.ts`) without it has neither: set `ADMIN_PASSWORD` and `LOBBY_ADMIN_SECRET`, or pass `DEV_AUTH=1` |
| `ADMIN_PASSWORD` | none | Lobby: seeds the `admin` account with this password when there is no admin yet (any mode) |
| `LOBBY_ADMIN_SECRET` | `dev-lobby-admin-secret` with `DEV_AUTH=1`, else none | Shared by the lobby and game servers for admin account commands (admin rank, bans); same value on both; with none those commands are refused |
| `OWNER_USERNAMES` | none | Lobby: comma-separated usernames made the owner (the rank above admin) at every start; removing a name doesn't revoke (the lobby's `/admin/set-owner` does). See web-accounts, Ranks |
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
| Player bots | [docs/areas/bots.md](docs/areas/bots.md) | dev-only simulated-player and NPC bots, tasks, stats, the playerBot bench |

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
- **Layering** (checked by `server/src/layering.test.ts`; `npm run cycles:check`, also part of `npm run features:check`):
  `common/`, `server/` and `client/` have no import cycles (type-only imports don't count). Break one by moving the shared
  piece to a leaf module the others import (the old file re-exports it), or by passing the dependency in. An import line
  may carry `// cycle-ok: <why>` only for a lazily read edge that cannot go (today only `features/plan.ts` -> `registry.ts`,
  read inside `getPlan()`). The client and the server never import each other, except in tests (`*.test.ts`), test kits
  (`*.testkit.ts`, `server/src/testkits/`), `bench/` and `proto/` folders, and the client's `Proto*` and `replay*` tools.
  Shared code goes in `common/`.
- **Lore**: [docs/lore-canon.md](docs/lore-canon.md); every lore claim needs an in-game owner.
- Older long-form notes: `docs/engine-map.md` is now an index into the guides; design docs live in `docs/design/`,
  `docs/rendering/`, `docs/audits/`.
