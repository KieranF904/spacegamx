# Server core
The Node process that runs the world: `index.ts` wires stores, data and transports; `GameServer.ts` (4,168 lines, one class) owns the ECS world, the 60 Hz tick (its system table is `buildTickSystems()`, phases in `tickOrder.ts`), the message handler table (`buildMessageHandlers()`, dispatch in `net/dispatch.ts`), snapshots, and the hosts that feed every `server/src/game/*` module. Join and sign-in (`net/auth.ts`), the module-forwarding handlers (`net/handlers/modules.ts`), ship editing and dock messages (`net/handlers/shipEdit.ts`), docking (`game/Docking.ts`) and derelicts and people's craft (`game/Derelicts.ts`) were split out of it in Stages 2 and 3; the snapshot path (`net/SnapshotBuilder.ts`, `net/snapshot/Outbox.ts`) in Stage 5. Most gameplay lives in those modules; GameServer is the glue. Do not read it whole: use the line map below.

## Files (what each owns)
| path | lines | owns |
|---|---|---|
| server/src/index.ts | 192 | entry: env (`PORT`, `ADMIN_PORT`, `BROWSER_URL`, `LOBBY_ADMIN_SECRET`, `NODE_ENV`), `createUserStore`, `createProfileStore`, `checkGameData`, builds `GameServer`, `SocketTransport`, writes `data/status/live.json` every 2 s, graceful `shutdown` (20 s save budget), process-level handlers, registers with the lobby every 10 s (also receives `deletedAccounts`) |
| server/src/GameServer.ts | 4168 | see section map below |
| server/src/net/SnapshotBuilder.ts | 828 | `SnapshotBuilder` with its `SnapshotHost` (built once at the end of the constructor, pieces copied into plain fields): `sendSnapshots`, `systemRows`, `sendShipUpdates`, row keys, `sendMapDots`, `updateShipView`, `enterSystem`, `sendPlayerState`, `sendSystemInfo`. GameServer reaches it as `this.snapshots` |
| server/src/net/snapshot/Outbox.ts, constants.ts | 140 / 25 | `Outbox`: outboxes, lazy effects, broadcasts, byte counters (`this.net`; GameServer bumps `this.net.batching` around a tick or request); the snapshot tuning constants |
| server/src/game/Docking.ts | 142 | `Docking`: berthing at a station, `dockedShips` (the Set GameServer aliases), `stationInRange`, `dockingSystem`, `handleDock`/`undock` |
| server/src/game/Derelicts.ts | 202 | `Derelicts`: derelict hulks (spawn, break-up, salvage, respawn, tow delivery), `personCraft`, `onPilotlessShipDestroyed` |
| server/src/net/auth.ts | 199 | `registerAuthHandlers`: join, authLogin, authRegister; guest-name rules; `handleHttpAuth`, `rejectAuth` |
| server/src/net/handlers/modules.ts | 170 | `registerModuleHandlers`: the message types that only forward to one game module (party, trade, market, items, quests, hangar orders, sieges, admin ...) |
| server/src/net/handlers/shipEdit.ts | 145 | `registerShipEditHandlers`: dock, undock, shipEdit, slotSave/Fly/Clear, designSave, shareDesign, pilotInfo; `clientBlueprint`, `handleShipEdit` |
| server/src/net/handlers/flight.ts | 256 | `registerFlightHandlers`: input (queued for the tick), ping, stateHash, mapView, interact, respawn, trainingDrone, target, tow; `handleInput`, `applyInputToEntity`, `releaseControls`, `recordSelfHashes` (GameServer keeps one-line delegates, called by `drainInputQueue` and the tick list); `portalQuery` |
| server/src/net/dispatch.ts | 55 | `dispatch(table, ctx, conn, msg)` and `HandlerRegistry` (`t.on(type, fn)`); the pre-join gate (`PRE_JOIN`), the per-type rate limit and the handler call. `MAX_INPUTS_PER_TICK` lives here too |
| server/src/net/ServerCtx.ts | 110 | `ServerCtx`: the narrow view of the server a client message handler may use (GameServer implements it) |
| server/src/net/ClientConnection.ts | 81 | `ClientConnection`: the per-socket state (was the CLIENT CONNECTION block of GameServer) |
| server/src/tickOrder.ts | 48 | `TickSystem`, `TICK_PHASES` (pilots-move, combat, world, persist), `checkTickOrder` |
| server/src/ships/bridge/core.ts, sync.ts, damage.ts, rebuild.ts, weapons.ts, flight.ts, pilotless.ts | 243 / 144 / 461 / 431 / 522 / 503 / 95 | ShipBridge split (see flight.md and weapons.md); ShipBridge.ts (540) is the facade: shared types and constants; body, health and tow glue; hits and EMP and fire; geometry, spawning, rebuild and repair; firing, beams and projectile hits; the movement step, tick, contacts and sleep/wake; AI pilots and the autopilot |
| server/src/AdminServer.ts | 511 | dev/ops HTTP+WS admin API (`/auth /config /stats /command /reload`), sessions, `adminPassword()` (no default in production: off without a password) |
| server/src/net/* | | transports, limits, shadows: see networking.md |
| server/src/profile/ProfileStore.ts, JsonProfileStore.ts, PostgresProfileStore.ts, durableWrite.ts, index.ts | 49/145/85/55/22 | `ProfileStore` interface (`load/save/delete/loadDoc/saveDoc/close`), `MemoryProfileStore`, JSON files with daily backups, Postgres jsonb, atomic fsync+rename writes, `createProfileStore(dataPath)` switch |
| server/src/auth/LobbyAccounts.ts, types.ts, index.ts | 122/71/11 | `UserStore` (the lobby keeps accounts; the game server asks it over HTTP: login, register, validateSession/checkSession, `admin` for ranks and bans) |
| server/src/data/GameData.ts, loadGameDataFromDisk.ts, validateGameData.ts (1165), devData.ts, rules.ts | | loading and cross-file validation of `data/*.json` (`checkGameData` at startup and in tests) |
| server/src/proto/createProtoServer.ts | | `createShipBridge(cfg)`, `createProtoServer` (in-process server for tests and `?proto`) |
| server/src/game/*.ts | | the modules GameServer hosts (Pilots, Quests, Enemies, Bosses, Hangar, ...): each takes a `*Host` interface built by `create*Host()` in GameServer |

## GameServer.ts section map (grep the banner text or the method name, then read a slice; no line numbers)
| section (banner or symbol) | what is there |
|---|---|
| imports, module constants | `RIFT_*`, `MEMORY_GATE_MOUTH` (the snapshot constants are in net/snapshot/constants.ts). `PRE_JOIN` and `MAX_INPUTS_PER_TICK` are in net/dispatch.ts |
| SPATIAL PARTITIONING (`SpatialGrid`) | the per-system collision grid (`addEntity`, `query`, `queryRay`) |
| PERFORMANCE METRICS, QUERIES | tick timing stats and the bitecs queries (`playerQuery`, `projectileQuery`, `droppedItemQuery` are imported from net/SnapshotBuilder.ts) |
| CLIENT CONNECTION | only the pilot-row helpers here; the `ClientConnection` interface is in net/ClientConnection.ts |
| GameServer class | `GameServerOptions`, class fields (`handlers`, `tickSystems`, `inputQueue`, the `Input` shadows), `constructor` (builds every module in dependency order, `create*Host()` for each) |
| `step()`, `setPaused`, `getTick`, `getShips` | tests and proto drive `step()` |
| `starterKit`, `create*Host()` factories | one per module (Pilot, Quest, Party, Ops, Event, Mob, Boss, Mining, Enemy, Admin, Surface, People, Arena, Siege, Pod, Ship); `loginPilot`, `lingerSystem`, `canDamage`, `inPvpZone`, `forgetAccounts`, `saveAll` |
| EXTERNAL CONTROL | transports, proto tools and tests |
| INITIALIZATION | `initializeWorld`, `createStation`, `createRift`, `createPortal`, `createAsteroids`/`createAsteroid`, `forgetAsteroid` |
| CONNECTION HANDLING | `connect(ws)` (builds `ClientConnection`, sends `welcome`, returns the `ClientLink`), `createPlayer` |
| MESSAGE HANDLING | `buildMessageHandlers()` calls `registerHandlers(t, register*)` for the four split families (net/handlers/modules.ts, net/auth.ts, net/handlers/shipEdit.ts, net/handlers/flight.ts), then registers what is left (`chat`, `shipNeed`, dev tools). `handleMessage` is one line calling `dispatch`. Also here: the delegates `handleInput`, `applyInputToEntity`, `recordSelfHashes` (bodies in net/handlers/flight.ts), `handleChat`, `travelTo`, `riftSystem`, `handleDevTeleport`/`handleDevSpawn` |
| GAME LOOP | `gameLoop` (fixed timestep, max 4 catch-up ticks, snapshots at 20 Hz, then `flushOutbox`), `drainInputQueue` (still here: it runs right before each tick), `releaseControls` (delegate) |
| crash isolation | `guard(where, fn)`, `fault`, `faultCounts` |
| `buildTickSystems()`, `tickSystemList()`, `tick()` | the tick table, built once; `tick()` walks it |
| SYSTEMS | `weaponSystem`, `projectileSystem`, `placeAsteroid`, `stationOrbitSystem`, `shotWall`, `collisionSystem`, `asteroidDeathSystem`, `trafficSystem`/`trafficIntent`, `createMemoryHost`, `threats`/`regionThreats`, `deathCause`, `lifetimeSystem`, `cleanupSystem` |
| DERELICTS | a seam only: `getTrafficShips`. Derelict respawn, salvage and tow delivery are game/Derelicts.ts (`derelictRespawnSystem`, `towDelivered`, `onPilotlessShipDestroyed`); GameServer keeps field aliases (`derelicts`, `personCraft`) |
| docking | the `dockingSystem` tick entry and `handleDock` live in game/Docking.ts; GameServer keeps the `dockedShips` alias and `stationInRange`/`isDocked` one-liners |
| NETWORKING | one-line delegates only: `send`, `flushOutbox`, `flushLazy`, `broadcastToSystem`, `broadcastProjectileHit`, `broadcastNear` (net/snapshot/Outbox.ts), `sendSnapshots`, `sendPlayerState` (net/SnapshotBuilder.ts); `terrainOf`, `replicaEnv` (the replication environments) |
| QUEST HANDLERS, BANK HANDLERS | the quest and bank message handlers, still registered in `buildMessageHandlers()` |
| ADMIN SERVER INTEGRATION | `setupAdminHandlers`, `adminKillAllEnemies`, `adminTeleportPlayer`, `handleHttpAuth` (delegates to net/auth.ts), `reportAdminStats`, `liveStatus` |

### Tick order (`buildTickSystems()` builds the table; `tick()` walks it)
Each entry is `{ name, phase, run }` plus optional `every`, `scene` or `when`. The walker guards every entry with `guard(name, run)`; a `perClient` entry runs its own loop and guards each client. `server/src/golden/tickOrder.json` pins the order, and `tickOrder.test.ts` checks the table. The summary below is for orientation; the table is authoritative.
stationOrbit, memory (load/unload systems), spatialGrid rebuild, playerMovement, towing, docking, rift, weapon, projectile, then (sectors scene only) enemies, bosses, mobs, events, surfaces, sieges, arenas, then collision, asteroidDeath, lod, ships (flight/damage), replication.endTick, recordSelfHashes, pods, mining, hazards, warmth, homes, comet watch, outpost finish (every 60), pilots, quests, codex, party, trade, achievements (every 60), ops, services+hangar (every 60), linger, derelictRespawn, traffic, lifetime, cleanup, perf/admin stats. Inputs are drained before each tick (`drainInputQueue`); snapshots are sent after the tick loop in `gameLoop`, not inside `tick()`.

## Public interface
- `new GameServer(opts: GameServerOptions)`: `gameData`, `userDB`, `ships`, `profileStore`, `scene` ('sectors'|'empty'), `autoStart`, `clock`, `telemetry`, `contributorStore`, `worldStore`, `devTeleport/guestAdmin/freeBuild` (dev only, refused in production), `devStart` (dev only, refused in production; index.ts passes `dev_rockery`: every pilot, guest or signed in, joins and respawns in the Rockery on a ring just inside the belt's inner edge, `devStartSpot`, instead of Sol Central or where they left off; seam: `createPlayer` and `PilotsOptions.spawn`, read by `Pilots.applyProfile`/`homePoint`; test game/devStart.test.ts).
- `connect(ws, address)` -> `ClientLink {receive, close}`; `step()`, `getTick()`, `getShips()`, `saveAll()`, `forgetAccounts(ids)`, `liveStatus()`, `faultCounts()`, `guard/fault`, `flushLazy()` (tests).
- Module pattern: `class Foo { constructor(host: FooHost, ...) }` with `FooHost` defined beside it in `game/Foo.ts`; GameServer builds the host in `createFooHost()`. Modules never import GameServer.
- `ProfileStore`, `UserStore` (above); `PilotConn` is the narrow view of `ClientConnection` the modules see.

## Invariants
- Every tick system, every message handler, every close step and every per-client send runs under `guard`/`try`: one failure must not stop the tick (docs/audits/server-robustness.md). A new tick system MUST be an entry in `buildTickSystems()`; the walker in `tick()` guards it.
- `dispatch` (net/dispatch.ts, called by `handleMessage`) drops non-objects, unknown types and pre-join messages, then rate limits (`limiter`). Handlers validate every field of `msg` (clients are hostile) and delegate; no game logic in the handler table.
- Never save a profile while it is loading or failed to load/migrate (`Session.loading`): a save we could not read is never replaced by a fresh one.
- Durable writes only through `writeFileDurable(Sync)` (temp + fsync + rename). Profile saves for one account are serialised, newest wins.
- Production refuses `guestAdmin`, `freeBuild` and a default admin password. Dev-only features check `NODE_ENV`.
- A second login of the same account kicks the first (saved first); a disconnect within `LINGER_COMBAT_TICKS` of damage leaves the ship in space for `LINGER_TICKS`.
- Shutdown order: stop accepting, `saveAll` (pilots, contributor notes, achievements, world memory), close profile and user stores, within 20 s.
- Systems not occupied are "put away" (`memory`); never assume a system's entities exist.

## How to extend
1. **Add a tick system**: write it as a module or a private method; add an entry `{ name, phase, run }` to `buildTickSystems()` at the right place in the order (after movement and before `replication.endTick` if it moves ships). If it only matters in sectors play, use the `scene` field rather than an `if`. Changing the order means updating `server/src/golden/tickOrder.json` on purpose. Give it a test that drives `server.step()`.
2. **Add a module**: `game/Foo.ts` with `FooHost`; add `createFooHost()` and construct it in the constructor (keep dependency order: Pilots before Quests, etc.); call `foo.tick()` in the tick list; clean up in `connect()`'s `close` (guarded) if it holds per-connection state.
3. **Add a client message handler**: see networking.md step 1; register it in `buildMessageHandlers()` with `t.on('type', ...)`, one line calling the module.
4. **Add a field to ClientConnection**: interface in `server/src/net/ClientConnection.ts` AND the literal in `connect()`; TypeScript will force the second.
5. **Add a profile field**: econ/profile.ts (interface, `newProfile`, `migrateProfile`; see economy-quests.md); stores need no change.
6. **Add an admin command**: game/AdminTools.ts (`AdminTools`), not AdminServer.
7. **Add an env var**: read it in index.ts, pass via `GameServerOptions`; document in deploy/vps unit or secrets and DEVELOPMENT.md.

## Persistence and production
- Profiles: `createProfileStore` picks Postgres when `USER_STORE_BACKEND=postgres` and `DATABASE_URL` are set, else JSON files in `data/profiles/<id>.json` (+ `_rankings.json`, backups in `data/profiles/backups/<id>/<yyyy-mm-dd>.json`, 7 days, corrupt files moved aside and the newest good backup loaded). Production now runs on Postgres (`profiles` jsonb table, `game_docs` for rankings); see docs/ops/postgres-migration.md (written during the migration, it may still say "game runs on JSON"; the switch-over steps are in it). jsonb does not keep key order. Postgres needs `pg_dump` for backups (a systemd timer, deploy/vps/spacegame-dbdump.*).
- Other state stays in JSON files under `data/`: world memory (`data/world/memory.json`), contributor notes (`data/contributor/`), telemetry (`data/telemetry/pilots.jsonl`), live status (`data/status/live.json`), achievements/rankings.
- Accounts live in the lobby (server-browser); the game server is a client of it via `LobbyAccounts` (5 s timeout; lobby down => joins with a token fail with "Accounts are unavailable", guests still join).
- Deploy: deploy/vps/deploy.sh to the shared VPS (systemd `spacegame-server.service`, port 3100, admin 3105); do not disturb other projects there.

## Tests
- `npx vitest run server/src/profile server/src/auth` : store contract (JSON, memory; Postgres when `DATABASE_URL` is set), durable writes, backups, LobbyAccounts.
- `npx vitest run server/src/game/robustness.test.ts server/src/game/safeguards.test.ts server/src/game/players.test.ts` : fault isolation, hostile input, join/leave.
- `npx vitest run server/src/data` : data validation (`validateGameData.test.ts`).
- Whole server: `npx vitest run server` (slow: each test builds a full server; the vitest config gives forks 6 GB).
- Typecheck: `cd server && npx tsc --noEmit` (common must be built: `npm run build:common`).

## Gotchas
- Line numbers in GameServer drift with every commit: grep the banner or method name, then read a 60-line slice.
- A guard hides errors in the log (one line per 10 s per place): check `faultCounts()` when something silently does nothing.
- `Input.*` fields: the on/off keys are copied from `INPUT_BOOLS` and let go through `INPUT_HELD` (common/src/network/inputFields.ts), used by `applyInputToEntity`, `releaseControls` (both in net/handlers/flight.ts) and the linger close path. The numeric fields (`cursorDist`, `targetAngle`, `sequence`) are still written by hand in `applyInputToEntity`. A new key goes in `INPUT_BOOLS` (the test `inputFields.test.ts` checks every Input field is listed once); a new number needs its own coercion.
- Tests construct a server with `autoStart: false` and drive `step()`; if you forget to `flushLazy()`, effect messages seem missing.
- `index.ts` still has a Fly.io comment/port branch (`publicPort = 443` in production); the project no longer deploys to Fly.io, nginx fronts the VPS.
- Production runs on Postgres (switched 2026-10-31; see docs/ops/postgres-migration.md for the rollback). The JSON profile store is the local-dev default.

## Related areas
networking (wire, snapshots, limits), economy-quests (Pilots, profile schema), bosses-ai and world-sim (modules ticked here), web-accounts (the lobby that owns accounts), ops-tools (deploy, monitor, db scripts), flight (ShipBridge step). Docs: docs/areas/<slug>.md; also docs/audits/server-robustness.md and docs/ops/postgres-migration.md.

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **Layout**: packages `common/` (client + server: ECS components via bitecs, protocol, shared physics, data schemas; imported as `@space-game/common`: Vite alias on the client, `file:` link on the server), `server/` (Node), `client/` (PixiJS 8), `data/*.json` (loaded by `server/src/data/GameData.ts`, which takes parsed JSON; `loadGameDataFromDisk.ts` is Node-only). Game rate: `TICK_RATE` 60, `SNAPSHOT_RATE` 20 (`common/src/constants.ts`); the loop is a fixed-step accumulator (max 4 catch-up ticks). Snapshots go every `TICK_RATE / SNAPSHOT_RATE` ticks. `server/src/net/SocketTransport.ts` is the Node HTTP + WebSocket front end; `LocalTransport.ts` is the in-process one (same `ClientTransport` interface as the client's `NetworkManager`), used by tests and by `npm run proto` (`createProtoServer.ts`: browser-safe, empty scene, no accounts; open `/?proto`, hangar H, `shipEditAnywhere` on). `scene: 'empty'` skips `initializeWorld()`. The determinism harness is `server/src/ships/replay.ts` (CI test; admin-panel button runs it in a worker).
- **Retired in the modular-ships switch**: the triangle ship and the old physics folder in common, legacy `stepPlayerPhysics`, equipment weapons and their ECS components (`Equipment`, `EquipmentStats`, `WeaponState`, `Shield`, `Missile`, `Mine`, `WarpBeacon`, `WarpProjectile`, `MiningBeam`, `ParticleEmitter`, `Interpolated`, `QuestProgress`), the unused server systems and world folders (deleted). Any older doc describing them (the original "Q1-Q6" tour: `createPlayer` adding Equipment, `ACCEL_BASE` movement, `stepPlayerPhysics`) is stale. Collision is still server-side circle/polygon tests on the spatial grid; `GameServer` holds the inline systems.
- **Hosts**: server modules in `server/src/game/` are one class each with a small host interface (like `ShipBridge`); `GameServer` builds the hosts (`create*Host`) and routes messages. Tests in `server/src/game/*.test.ts` and `server/src/ships/shipEdit.test.ts` drive a real `GameServer` through `LocalTransport`.
- **Data validation** (`server/src/data/validateGameData.ts`): every data file is checked at load, shape and cross-references; dev and tests throw, production logs; `GameData` checks the game files and `server/src/index.ts` checks again with the ship data. `data/rules.json` and `data/strings.json` (`server/src/data/rules.ts`) hold tuning and player-facing text; code keeps every value as its default and the data merges over it (`mergeRules`, `texts`, `fmt` for `{name}`). Music per system: `data/audio.json music` (client only).
- **Accounts in dev**: the JSON user store seeds `admin` / `admin` on first run (`data/users.json`, gitignored; delete to reset); the admin dashboard on 3005 uses `admin` in dev. The old SQLite `UserDB` and Supabase code are gone (only `Reference/ball` keeps v1).
- **Connection safeguards**: `ShipBridge.forget` clears every per-ship map when a body goes, so a reused entity id never inherits a battery, heading, gunnery or boss damage.
- **Collision performance**: `SpatialGrid` (ships, enemies, shots, pods) is one per system copy (cell keys include the system); `buildSpatialGrid` records what is where at the tick start and fills a system's cells on first query; queries dedupe with a stamp array; callers pass the system. `ShipBridge.resolveContacts` (bridge/flight.ts) groups touchable bodies (mass, not jumping, not sheltered) by system and sweeps along x on bounding circles padded by `CONTACT_MARGIN`; pieces are SAT-tested only when their boxes meet (`worldPieces`). Asteroids: `getAsteroidPolygon` caches outlines by id; shots and beams skip asteroids their segment cannot reach (`segmentNearCircle`). **Asteroid orbit timetable** (`server/src/game/AsteroidOrbits.ts`): asteroids are not moved each tick or put in the grid; each orbit is walked once when made and filed in every 1000-unit cell it passes with the stretch of mean anomaly spent there; a shot query checks each entry's clock; `placeAsteroid` then gives the exact position once per tick. Anything reading an asteroid's `Position` must call `placeAsteroid` first. Breaking unfiles it (`forgetAsteroid`). `hitProjectile` only considers ships in the shot's own system copy. Checked bit-for-bit against a deterministic 900-tick fight; `asteroidOrbits.test.ts` covers the timetable. Other server wins: shadows skip systems no client is in; docks and environments built once per tick/system; beams test distance before permission lookups; pods work out collectors once a tick; snapshot HP is converted once per ship per snapshot. Measured server cost: ~0.07 ms a tick empty, ~0.3 ms with 10 pilots, ~1.4 ms with 40 pilots and 140 hostiles.
- **Admin API**: the old HTTP admin API (`AdminServer.ts`) listens on 127.0.0.1 only.
