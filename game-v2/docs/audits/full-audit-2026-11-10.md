# Full codebase audit, 2026-11-10 (report only)

Ten Sonnet readers covered one area each. Opus de-duplicated their findings and re-checked the top ones against the code. Nothing was changed. The raw findings (JSON and MD for each area, plus the test harnesses) are in the session scratchpad under `audit2/`. The site was skipped except where it touches account data.

## Summary

**Lines now (tracked source, tests counted separately)**

| Package | Code | Tests |
|---|---:|---:|
| client/src | 99.4k | 11.9k |
| client/tools | 8.0k | 0 |
| server/src | 53.6k | 30.2k |
| common/src | 45.2k | 15.2k |
| server-browser (lobby) | 4.7k | 1.9k |
| site/src | 6.3k | 1.7k |
| scripts | 33.2k | 3.1k |
| prototypes | 12.6k | 0.3k |
| data (JSON) | 131k | |

**Estimated lines removable, by category (after de-duplication)**

| Category | Lines | Needs a decision? |
|---|---:|---|
| Dev tool island: sandbox, legacy star renderers, BitBuffer, Starfield/Nebula, sun shaders | ~9,100 | No |
| Finished labs and prototype shaders (sun, sky, planet), plus scripts/sun-sky-proto and scripts/planet-proto | ~4,000 | No |
| Dead legacy data layer: Enemy, Item, Weapon, Particle and Trail definitions and registries, client particles/trails, dead schema types | ~3,900 | No |
| Save migrations below v5 and one-off migration scripts | ~3,400 | Yes: read-only prod check of profile versions |
| Scripts and prototypes: old evolver, maw-heart design tooling, netcode-lab, broken scripts | ~2,800 | Partly |
| Tests: shared server testkit, dead tests, repeated boss walk-throughs | ~2,200 | No |
| Pool and banks energy model, with its hangar and HUD views | ~1,800 | Yes (Opus) |
| Benches (dead or broken) | ~1,500 | No |
| Touch-routed power layout and shipgen's copy of the relay tick | ~1,200 | Yes: shipgen must move to ports |
| Other dead server, common and client code (ShipBridge privates, dead ECS components, methods, messages) | ~1,000 | No |
| Legacy server surfaces: AdminServer, game-server password auth, lobby legacy endpoints | ~1,130 | No |
| Legacy part functions (73 enemy designs still use them) | ~600 | Yes (Opus, large) |
| Fly.io and Docker files | ~540 | No |
| Proto mode wiring | ~420 | Yes: is `/?proto` still used? |
| **Total code** | **~33,600** | About 21k of it needs no decision |
| Generated data: bespoke hulls stored one number per line, plus evolver catalogue.json | ~79,000 data lines | No |

**Top perf and security items**

| Item | Measured |
|---|---|
| **SECURITY** SEC-01/PR-01: a socket that never joins gets a ship and snapshots, with no cap or timeout | Tick time 0.1 ms with none, 11 ms at 100 sockets, 99 ms at 300; 3,000 sockets ran out of memory |
| **SECURITY** SEC-02/PR-04: `join` is accepted again on a joined socket | Identity swap; skips the one-session sweep (possible item dupe); 2,000 re-joins in 0.56 s |
| **SECURITY** BD-1: ws 8.19.0 has a high advisory on the game server and the lobby | `npm update ws` to 8.22.2 (within range) |
| PR-02: one throw in `Game.update()` freezes the client for good | No try/catch at `Game.ts:567`, and no global error handlers |
| PR-03: none of the `pg.Pool` instances has an error listener | A Postgres restart crashes the game server and the lobby |
| tests-1: a world boot takes ~1.9 s, nearly all of it asteroid orbits | About 55% of suite CPU; the same cost hits server start |
| perf crowd: tick time at 100 pilots | 20 ms spread, 26 ms ball (budget 16.7 ms). `sendSnapshots` is 45% of it |
| perf-1/2: gun-lane hash rebuild and per-ship lodestone trig | 5.9% and 7.3% of step time; fixable with identical results |

## Ranked verified findings

Verdict key: **V** = checked against the code and confirmed. **C** = confirmed, with a correction (see the details). **T** = taken from the auditor's measurement and not re-run.

| # | Id | Title | Area | Lines | Effort | Risk | Opus | Verdict | Why |
|---|---|---|---|---:|---|---|---|---|---|
| 1 | SEC-01, PR-01 | **SECURITY** Unjoined sockets get a ship and snapshots; no cap or timeout | server net | +35 | S–M | med | yes | V | About 8 IPs can push the live server below 60 Hz |
| 2 | SEC-02, PR-04 | **SECURITY** `join` re-accepted after joining; no rate limit | server net | +5 | S | low | yes | V | Identity swap, one-session bypass, likely item dupe |
| 3 | BD-1 | **SECURITY** ws high advisory on both public sockets | deps | 0 | S | low | | T | A version bump within the existing range |
| 4 | PR-02 | Client frame has no try/catch; one throw freezes the game | client | +30 | S | low | | V | Hard lock-up with nothing reported |
| 5 | PR-03 | No `pool.on('error')` on the three pg pools | server, lobby, site | +3 | S | low | | V | A database restart crashes the services |
| 6 | SD-02 | A saved ship that fails validation is silently replaced by a Sparrow and saved over | saves | +40 | S | low | | V | A data edit could wipe pilots' ships with no trace |
| 7 | SD-04 (DDC-1 x2, DDC-12, DS-02) | Dead legacy data layer and client particles/trails | common, client | 3,900 | S | low | | V | Zero users; still compiled into main and 3 workers |
| 8 | DDC-2 (client), DS-05 | Sandbox island: sandbox.ts, legacy renderers, BitBuffer, Starfield/Nebula | client/tools | 9,100 | S | low | | T | Stale; dials the wrong admin port |
| 9 | DDC-3 (client), DS-06 | Finished sun, sky and planet labs, plus proto shaders | client, scripts | 4,000 | S | low | | T | The winning shaders shipped; rename `planet-proto/` (it is live) |
| 10 | tests-1 | World boot ~1.9 s, nearly all asteroid orbit filing | server | 0 | M | med | yes | T | About 55% of suite CPU, plus server start and respawns |
| 11 | tests-2 | 99 test files copy the same `world()` boot | tests | 1,400 | M | low | | T | One testkit; makes tests-1 a one-place fix |
| 12 | SD-01, DDC-10, DS-07, SD-12 | Profile migrations below v5, plus applied migration and refit scripts | saves, scripts | 2,800 | M | low | | C | `designUpdate.json` puts real usernames in every tarball; needs a prod version check first |
| 13 | SEC-03, PR-06, DDS-03 | AdminServer: write-only config, events with no handler | server | 580 | M | low | | C | Dead. It binds 127.0.0.1, so it is not public |
| 14 | SEC-04, DDS-02, PR-07 | Game-server `authLogin`/`authRegister` and HTTP `/auth/*` have no caller | server | 190 | S | low | | V | An unused credential path on the game port |
| 15 | SEC-05 | Lobby `/stats`, `/log`, `/logs`, `/stream` and the HTML page have no auth and no caller | lobby | 360 | S | low | | T | `/log` can push to SSE and pushover; nginx doesn't expose it |
| 16 | DDC-3 (common), DDC-4, DDC-5 (client) | Pool and banks energy model, with its hangar and HUD views | common, client | 1,800 | L | high | yes | C | Also reachable from saves below v5 (see details) |
| 17 | SEC-07 | `marketScan` takes 16.6 ms per message and allows duplicate ids | server | +5 | S | low | | V | One message costs a full tick |
| 18 | SEC-06 | Lobby `POST /register` needs no secret | lobby | +6 | S | low | | T | Safe only while it binds 127.0.0.1 |
| 19 | perf-1 | Gun-lane hash check rebuilds a full lane copy every round | sim | 0 | M | med | yes | T | 5.9% of step time; identical hashes |
| 20 | perf-2 | Lodestone positions recomputed per ship per tick | sim | 0 | S | low | yes | T | 7.3% of step time in Sol; memo per tick |
| 21 | DDS-11, perf-9 | 17 benches (3.7k lines) outside tsc; netBench and mapBench crash | server | 1,500 | S | low | | T | Fix crowd and tick benches, delete the rest |
| 22 | DS-01, BD-7, SEC-15, DDS-12 | Fly.io and Docker files | deploy | 540 | S | low | | V | Dead deploy path that names old secrets and hosts |
| 23 | DDC-7, DDS-04 | Proto mode and replay worker ship in dist (2.2 MB) | client, server | 420 | M | med | | C | A lazy chunk, so no startup cost; deploy size only |
| 24 | BD-3, BD-4, BD-2 | Data inlined in a 3.6 MB entry chunk; no manualChunks; workers pull in all of common | bundle | 0 | M | med | BD-3 | T | About 120 KB gzip at startup, and caching across deploys |
| 25 | BD-5 | 26.7 MB of source maps in every tarball; nginx 404s them | deploy | 0 | S | low | | T | 73% of the upload for nothing |
| 26 | PR-05 | `trackErrors` uses `JSON.stringify(Error)`, which gives `{}` | server | +8 | S | low | | T | The admin panel shows no error text |
| 27 | PR-08, PR-09, PR-12 | Fetches without timeouts; silent sockets not reaped; no V8 heap cap | server, lobby | +25 | S | low | | T | Ghost ships last about 15 min; an OOM is a SIGKILL with no save |
| 28 | SD-03 | Postgres saves are not fenced by the lease | saves | +30 | M | med | yes | T | A server that lost its lease keeps saving |
| 29 | DDC-2 (common), DS-04 | Touch-routed `power/layout.ts`; shipgen's copy of the relay tick | common, scripts | 1,200 | L | med | yes | T | The game runs neither |
| 30 | DDS-01 | 89 unused private members in ShipBridge | server | 179 | S | low | | T | Leftover from the split (tsc `--noUnusedLocals`) |
| 31 | SD-05, DDS-10, SD-06, DDS-06 | One-off rankings and friends imports; old load-time cleanups; field `waiting` migration | server, common | 660 | S | low | | V | They run on every start, login or tick for nothing |
| 32 | tests-5 | `devBoss`, `devSpawn`, `devStation` and `feedSwitch` guards are never tested | tests | +40 | S | low | | T | One dropped guard line would go unnoticed |
| 33 | tests-7, tests-11 | Two test files never run; migration tests skipped; liquidSplash uses unseeded random | tests | 327 | S | low | | T | Dead coverage and one real flake |
| 34 | SD-08 | Validator misses rules, strings, mobs and terrain, and prints 37 false warnings; deploy never validates | data | +120 | M | low | | T | Real data errors are hidden |
| 35 | DDS-07, DDS-08, DDS-09, SEC-14, DDC-8/11/14 (common) | Dead ECS components, methods, imports and message types | all | 1,000 | S | low | | T | tsc and reference-scan results |
| 36 | DS-11, DS-12, DDC-12 (common), DS-13 | Stale god-file warning, about 40 dead references in guides, CURSOR_STATE.md wrong | docs | 60 | S | low | | T | These mislead agents |
| 37 | SD-11, DS-03 | Bespoke hulls stored one number per line (72k lines); old relay evolver and catalogue.json | data, scripts | 460 + 79k data | S | low | | T | 862 KB stored where 366 KB would do |
| 38 | perf-5, perf-6, perf-7 | Second contact replay at `endTick`; client contact pass; per-client snapshot sets | netcode | 0 | L | high | yes | T | The 100-pilot ball misses budget; after the netcode run |
| 39 | DDS-05 | System and zone wandering spawner is dead by data | server | 45 | S | low | | C | Only system and zone `packs` are 0; nest packs are live |
| 40 | SD-10, DDC-11 (common) | 33 legacy part functions still drive 73 enemy designs | data, common | 600 | L | high | yes | T | A second part system; convert the designs first |

`+N` in the Lines column means lines to add rather than remove.

## Details (file:line)

**Security**
- **SEC-01/PR-01:** `gameServer/session.ts:29` calls `createPlayer()` before any join. The `SnapshotBuilder.ts:311` loop skips only closed sockets. The only cap is 16 per IP (`SocketTransport.ts:105`). Fix: add a join deadline of about 10 s and a total cap now. Creating the entity at join instead needs Opus, because of determinism and entity ids.
- **SEC-02/PR-04:** `net/auth.ts:42` sets `conn.joined = true` with no earlier check, and `dispatch.ts:30` `PRE_JOIN` always allows `join`. Fix: `if (conn.joined) return;` plus a `MessageLimits` entry for join.
- **SEC-07:** `Market.ts:82` loops over up to 80 ids with no dedupe, sorting every market for each. Fix: dedupe, and cap at about 20 ids.
- **SEC-06:** `server-browser/src/index.ts:182-221` accepts a heartbeat from anyone. Fix: require `LOBBY_ADMIN_SECRET`.
- **SEC-10:** `LoginUI.ts:558` puts the error string into innerHTML unescaped. Not exploitable today, but it is a one-line escape.
- **SEC-16:** the game-only nginx config sets no CSP, X-Frame-Options or nosniff.
- **SEC-09:** dev mode fails open, giving the known passwords and guest admin. Prod units set `NODE_ENV=production` (checked). Fix: make it fail closed.
- **For Kieran to decide:**
  - SEC-17: real prod admins can use the dev spawn, ship and boss tools.
  - SEC-11: the password policy allows 1 character.
  - SEC-12: session tokens are stored in plaintext.
  - SEC-18: the lockout is by name, so a stranger can lock any account.
  - SEC-20: a script can push out every kept guest pilot.
  - SD-13: database backups are on the same disk only.

**Saves**
- **SD-02:** `pilots/persist.ts:101-103` calls `setActiveShip(starter)` when validation fails, and the next autosave keeps it. Fix: log it, keep the old record in a hangar slot or a stash, and tell the pilot.
- **SD-01/DDC-10:** `econ/profile.ts:314-359,451-466`, `econ/designUpdate.ts`, `ships/migrate.ts`. Removable once a read-only query shows every prod profile is at v5 or above.
  - **Correction:** the pool model (row 16) is still reachable here. `persist.ts` `applyShip` does not force ports, so the v5 design update is what moves old saves onto ports. Remove the two together.
- **SD-07:** v6 `fieldUpdate.ts` can only go one deploy after it ships.
- **SD-03:** `PostgresProfileStore.ts:104` saves unconditionally. `lease.ts:46` only logs when the lease is lost.

**Dead code (checked)**
- **SD-04:** `common/src/data/definitions/{Enemy,Item,Weapon,Particle,Trail}Definition.ts` and the matching registries are used only by each other and by `client/src/particles` and `client/src/trails`, which nothing imports. Checked with grep.
  - Keep `AsteroidDefinition`, `AsteroidRegistry` and `SunShaderDefs`, but SunShaderDefs goes with the sandbox.
- **SEC-03/DDS-03:**
  - **Correction:** `AdminServer.ts:189` listens on 127.0.0.1, and prod uses port 3105, so it is not exposed publicly.
  - It is still dead. `getConfig()` has no reader. `gameServer/admin.ts:124-150` only logs. `index.ts:52` starts it.
- **DDS-02/SEC-04:** `net/auth.ts:106-243`, `SocketTransport.ts:64-75`. The client uses the lobby (`network/lobby.ts:13`). No sender found.
- **DDC-3 (common)/DDC-4 (client):** the server forces ports at `shipEdit.ts:91` and `FieldShips.ts:729`, and the hangar does at `HangarUI.ts:588`.
  - The pool still runs 17 dev blueprints, 11 fixtures and saves below v5.
  - Convert those first, then delete `circuits.ts`, `wires.ts`, the pool half of `energy.ts`, the hangar pool view, `BankBars` and `bankGlow`.
- **DDS-05:**
  - **Correction:** the auditor said every `packs` value is 0. Only the system-level and zone-level values are 0. The nest packs (`spawns.*.nests[].packs`) are 1 to 3 and live.
  - The dead code is the system and zone branch only (`Enemies.ts:192`, `placement.ts:122-153`).
- **DDS-06:** `FieldShips.ts:169` checks `field.waiting` for every pilot every tick, for a format that never shipped.
- **DDC-7/DDS-04:**
  - **Correction:** `main.ts:16` imports proto lazily, so players never download the 914 KB and 1.3 MB chunks. The cost is deploy size and the dev-only server options.

**Perf** (measured by tickBench and crowdBench)
- **perf-1:** `GunNet.ts:322`.
- **perf-2:** `jumpFields.ts:24,96,137`.
- **perf-3:** `sim/state.ts:31`.
- **perf-10:** `AsteroidOrbits.ts:216` computes the same sin twice.
- **tests-1:** `gameServer/asteroids.ts:15` creates every belt at boot, at 0.59 ms per rock. Options:
  - an empty-scene testkit for the tests that need no rocks;
  - lazy orbit filing (Opus, because it touches determinism).
- **Crowd:** `forClient.ts:199` `contactsFound` and `ContactWorld.ts:311` take about 6 ms per tick per client in the 100-ship ball. Leave this until the netcode run ends.

**Bundle**
- **BD-3:** `terrainData.ts:12` inlines 512 KB of terrain used in 2 systems, and about 490 KB of boss hulls, also bundled again in hullWorker.
- **BD-2:** `common/package.json` has no `sideEffects` flag. On a test build, adding one cut proceduralWorker from 114 KB to 38 KB.
- **BD-5:** `deploy.sh:52-57` tars the source maps.

**Tests**
- **tests-3:** 211 uses of `(server as any)`.
- **tests-8:** `structure.test.ts:101` hard-codes 105 message types and regex-parses ShipBridge source. `frameHash.golden.json` has been regenerated in 95 commits.
- **tests-10:** boss stage walk-throughs are repeated across 12 files, about 349 s in total.

**Docs**
- **DS-11:** `CLAUDE.md:7-9` lists god-files that are now about 760 lines each. The real big files are `Game.ts` (1,319 lines), `Quests.ts` and `GameState.ts`.
- **DS-12:** for example, `docs/areas/ui-hud-input.md:21` points to `CircuitBars.ts`, which no longer exists.
- **DS-14, tests-4:** 150 of 536 invariants say "none pinned", and the 4 `predict/kinds` files have no headers.
- **DS-15:** `networking.md` is 104 KB in one file.

## Checked and fine
- **Fuzzing:** 102 handlers took about 150k hostile payloads with 0 faults. 40k economy messages never made credits or cargo negative, NaN or fractional.
- **Leaks and lifecycle:**
  - No memory leak over 600 join/leave cycles, or over a simulated 1 hour or 300 s of play.
  - Shutdown saves, the update countdown and the lease logic all hold.
- **Lobby:** hashing (PBKDF2 at 100k rounds, timingSafeEqual), sign-in throttles, secret checks and body limits hold. No injection or file-path risk.
- **Runtime dependencies:** `npm audit --omit=dev` is clean apart from ws (BD-1). No secrets are committed.
- **Netcode bytes:** about 0.2–1.7 KB/s per player in normal play.
- **Checks that pass:** `contracts:check`, `features:check`, `cycles:check` and `tsc` all pass. The area guides are about 98% accurate.
- **Still live (not dead):** the `HitLedger` legacy path is the live fallback. No loaner or insurance code is left. Dev defaults are gated on `NODE_ENV`.
- **Prediction:** only C3 runs. A, B, C1 and C2 are dev-only and tree-shaken out, so they cost almost no lines.
- **Tests:** the common and client suites are fast (28 s and 12 s). Exact duplicate tests are rare (8 of about 3,084).

## Suggested order of work

Each package touches its own set of files, so it can run as a parallel worktree. Do the security and resilience packages first.

**Sonnet packages**
1. **S-harden** (server/lobby/client edges, about +150 lines):
   - Security: BD-1 ws bump, SEC-06, SEC-07, SEC-08 ping limit, SEC-10, SEC-16 nginx headers, SEC-09 fail-closed.
   - Resilience: PR-02, PR-03, PR-05, PR-08, PR-09, PR-11, PR-12.
2. **S-common-dead** (common/src/data, ecs, starfield.ts, plus client particles/trails, about −4.9k): SD-04, DDC-4 to DDC-8, DDC-14 (easy part).
3. **S-client-tools** (client/tools, labs, proto shaders, scripts/sun-sky-proto and scripts/planet-proto, about −13k): DDC-2, DDC-3, DS-05, DS-06, DDC-8 classic ground shader. Also rename `planet-proto/`.
4. **S-server-dead** (server/src and lobby, about −3.5k): AdminServer, password auth, lobby legacy endpoints, SEC-14, DDS-01, DDS-05 (system and zone branch only), DDS-07 to DDS-09, the bench cleanup (keep and fix crowdBench and tickBench), and the Fly and Docker files.
5. **S-tests** (test files only, about −2k): the shared `world()` testkit with an empty-scene option (tests-2), tests-5 guard sweep, tests-7, seeding liquidSplash, folding the repeated boss walk-throughs.
6. **S-bundle** (vite config, deploy.sh, common/package.json): BD-2, BD-4, BD-5, DDC-7 dev gate (if proto is kept), DDC-10 lazy UI.
7. **S-docs-scripts** (docs and scripts, about −3k code and −79k data):
   - Docs: DS-11 to DS-15, DDC-12.
   - Scripts: archive the DS-03, DS-07, DS-08, DS-09, DS-10 and DS-16 scripts.
   - Data: SD-08 validator plus validation in deploy.sh, SD-09 strings.json, SD-11 compact hull JSON.

**Opus packages**
1. **O-join** (net/auth, session, dispatch, SnapshotBuilder): SEC-02 re-join guard, then SEC-01 (create the entity at join, with a cap and deadline). Do this first.
2. **O-saves:** read-only prod check of profile versions, then SD-02, SD-03, SD-01/DDC-10 with SD-05, SD-06, DDS-06. Schedule SD-07 for after the next deploy.
3. **O-energy** (after O-saves): convert the 17 dev blueprints and 11 fixtures to ports, then remove the pool model (DDC-3 common), the hangar and HUD pool views (DDC-4, DDC-5 client), `power/layout.ts`, and move shipgen to ports (DS-04).
4. **O-sim-perf** (common/sim, jumpFields, AsteroidOrbits): perf-1, perf-2, perf-3, perf-10, and tests-1 lazy orbit filing, each with identical-hash parity tests.
5. **O-crowd** (after the netcode run): perf-5, perf-6, perf-7, BD-3 lazy data.
6. **O-legacy-parts** (large, later): convert the 73 enemy designs off the legacy part functions (SD-10, DDC-11).

**Decisions for Kieran before starting**
- Is `/?proto` still used? (DDS-04)
- Should real prod admins keep the dev tools? (SEC-17)
- Do you want any of SEC-11, SEC-12, SEC-18, SEC-20 and SD-13 done?
- Should the lobby's on-demand regions code go too? (DS-01)
