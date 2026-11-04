# Bosses, enemies & AI
Everything hostile and pilotless: faction packs and nests (Enemies.ts), single-body mobs (Mobs.ts), and bosses (Bosses.ts plus per-boss "brains" that fly them through telegraphed, staged moves). Bosses are ordinary ships built from bespoke or enemy blueprints; their fight logic is server-side generator coroutines. The design rules for a good boss are in docs/boss-design.md; read that before building one (218 lines). This guide is the map.

## Files (what each owns)
| path | lines | owns |
|---|---|---|
| data/bosses.json | 1781 | `rules` (creditRange, creditWindowTicks, barRange, repeatCredits, stageCover) and `bosses.<id>` (`BossDef`: lair, hp, damage, phases, loot, brain, design, stageCover...) |
| data/mobs.json | 35 | single-body enemies (ember_drone, scrap_mite...): radius, hp, speed, blast |
| data/factions.json | | factions, behaviour (aggro/range/flee/leash), ship tables, `spawns.<system>.nests/groups`, loot |
| data/ships/blueprints/enemy/*.json, data/ships/bespoke/*.json | | enemy and boss hulls; bespoke are generated from scripts/bespoke/*.mjs (pyreclast, pyreclast_heart, scrap_mother, brood_mother); enemy ones by scripts/gen-enemy-ships.mjs |
| server/src/game/Bosses.ts | 550 | `Bosses`: spawn at lair, phases (`stepPhases`, `enterPhase`), novas, credit/loot (`onDestroyed`, `rollLoot`), memory (`capture`/`restore`), `busy`, `stageCover`; `BossDef`, `BossPhase`, `BossesFile` |
| server/src/game/brains/ids.ts | 2 | `BRAIN_IDS` (pyreclast, scrap_mother, brood_mother); the validator reads it |
| server/src/game/brains/kit.ts | 118 | `BossBrain`, `BrainHost`, `BossView`; helpers `partsWith`, `partMount`, `bodyFrame`, `lead`, `strike`, `wrap` |
| server/src/game/brains/staged.ts | 468 | `StagedBrain` base (generator `Move`s, `StagedTables`, per-stage `loop`, stage blow-away, drones) |
| server/src/game/brains/{scrapMother,pyreclast,broodMother}.ts | 461, 988, 24 | concrete brains. broodMother.ts is an empty stub (loop `[[],[],[]]`); its design is docs/bosses/brood-mother.md |
| server/src/game/Enemies.ts | 1371 | god-file: `Enemies` (packs, AI `pilot()`, tick, kills). Banners: "Nests" (~L663), "Memory" (~L831), "The pilot" (~L1048), "Kills and station defence" (~L1247); types at top (`FactionDef`, `SpawnNest`, `PackMemory`, `EnemyHost`) |
| server/src/game/Mobs.ts | 251 | `Mobs`: circle-hit drones (kamikaze) |
| server/src/game/Roaming.ts, Arenas.ts | 133, 119 | how nest packs wander (`style`); job arenas (boss `arena: true` via `spawnAt`) |
| common/src/ships/stages.ts | 103 | `stagedIntegrity`, `currentStage`, `stageOf`: stage rules on bespoke pieces (`stage`, `ruin`, `skeleton`, `under`) |
| common/src/world/nests.ts | 37 | nest positions (orbits) from systems.json `nests` |
| client/src/ui/BossUI.ts, client/src/ships/BossFx.ts, skeletonBuild.ts | 151, 318 | boss bar/intro card; telegraph and blow-away FX; skeleton frame drawing |
| scripts/render/render.mjs, scripts/native-render/, scripts/boss-shots/ | | `npm run render -- boss:<name>` native stills; shoot.mjs for live-fight shots |
| docs/boss-design.md, docs/bosses/brood-mother.md | 218, 521 | design guide; Brood Mother fight spec (design only) |

## Public interface
- `Bosses`: `def(id)`, `of(eid)`, `isAlive(id)`, `eidOf(id)`, `spawn(id)`, `spawnAt(id, num, x, y)`, `inSystem(num)`, `phaseOf`, `stageCover(eid)`, `brainOf(eid)`, `busy(eid)`, `onDamage(target, amount, source)`.
- `BossBrain` hooks: `orders(base, ship, view)`, `integrity`, `invulnerable`, `taken`, `idle`, `forceShed`, `dispose`. `BrainHost.fire(owner, kind, x, y, angle, damageScale, {target, speed})` is the only way a brain shoots (goes to `Weapons.spawn`).
- `Enemies`: `spawnPack`, `info(eid)`, `design(type, grade, plating)`, `addBoss`, `pilot`, `capture`/`restore`, `intent(eid, plan)` (SimLod), `onDestroyed`.
- Wire messages: `bossIntro`, `bossTelegraph`, `bossPhase` (common/src/network/protocol.ts).
- Data validators: `bosses.json` strict schema in server/src/data/validateGameData.ts (~L362); `brain` must be in `BRAIN_IDS`.

## Invariants
- Every attack that hurts is telegraphed first (`bossTelegraph`); move order is a fixed `LOOP` per stage, random only inside a move.
- All boss damage and parts changes use ShipBridge APIs (`hurt`, `shed(eid, groups, fling, crumble)`); mid-fight debris must `crumble`.
- Brain code is server-only and may use the host `rng()` (not `Math.random`) so tests are repeatable. Its maths is deterministic (common/src/math/detTrig.ts: dsin, dcos, datan2, dhypot ...; the guard common/src/math/simMaths.test.ts fails on Math.sin/Math.random here), so a brain can later run on both sides from a small decision input (docs/design/deterministic-maths.md). The plan for that (server brain, shared body, decisions stamped 16 ticks ahead on a 4-tick grid, per boss and AI): docs/design/decision-inputs.md. Built so far (protocol 36): the staged bosses' flight is a shared body (common bodies/stagedFlight.ts, tables by brain id in common bodies/registry.ts); StagedBrain's moves set `want` (wantFly, wantHold, wantAim, wantFace, wantLead, wantDrive: quantised) and its target, side, stage and want are decisions (BrainHost.decide). A new staged boss's flight tables go in the registry, not in its brain. Built so far (protocol 36): the staged bosses' flight is a shared body (common bodies/stagedFlight.ts, tables by brain id in common bodies/registry.ts); StagedBrain's moves set `want` (wantFly, wantHold, wantAim, wantFace, wantLead, wantDrive: quantised) and its target, side, stage and want are decisions (BrainHost.decide). A new staged boss's flight tables go in the registry, not in its brain.
- `idle()` must return true only when nothing is under way; otherwise SimLod keeps the boss live and `Bosses.busy` blocks sleep.
- Hits on later-stage parts pass to the current stage at `stageCover` (rules 0.4; per-boss override).
- A boss's lore text (name, intro, phase `say`) must follow docs/lore-canon.md: every lore claim has an in-game owner; no contested lore as fact.
- Boss respawn clocks and hurt state persist via SystemMemory (`BossMemory`, `timers`/`setTimers`).

## How to extend
1. **Add a data-only boss** (no brain): add `bosses.<id>` in data/bosses.json (copy a neighbour, e.g. boss_rustjaw), a hull `data/ships/blueprints/enemy/<id>.json` (or `design`), loot, phases (`nova`, `escorts`). `npx vitest run server/src/game/bosses.test.ts` validates.
2. **Add a staged/brain boss**: follow docs/boss-design.md sections 2-7. (a) generator `scripts/bespoke/<boss>.mjs` writes `data/ships/bespoke/<boss>.json`; (b) render stills `npm run render -- boss:<name>`; (c) `server/src/game/brains/<boss>.ts` extending `StagedBrain` with `StagedTables`; (d) add id to `brains/ids.ts` and the factory map near Bosses.ts L34; (e) bosses.json entry with `"brain"`; (f) test file like scrapMother.test.ts; (g) weapon styles in client weaponStyles.ts and a boss kind in tuning.json (see `weapons` guide); (h) tune by measuring (doc section 6).
3. **Add a mob**: data/mobs.json entry (`shape`, `blast`); a new behaviour needs a branch in Mobs.ts.
4. **Add an enemy ship/pack**: `scripts/gen-enemy-ships.mjs` layout (char grid) then run it; reference the type in data/factions.json `ships` / `spawns.<system>.nests|groups`. Enemies.ts only for new AI behaviours (read "The pilot" banner only).
5. **Add a nest**: systems.json `nests` (orbit) + factions.json `spawns.<system>.nests`; `Enemies.nest()`/Roaming `style`. Test: nests.test.ts.
6. **Add a boss phase effect**: `BossPhase` field in Bosses.ts + `enterPhase`; update the validator schema.

## Tests
- `npx vitest run server/src/game/bosses.test.ts server/src/game/enemies.test.ts server/src/game/nests.test.ts server/src/game/scrapNest.test.ts server/src/game/tactics.test.ts`
- Boss fights: `npx vitest run server/src/game/scrapMother.test.ts server/src/game/pyreclast.test.ts` (use `--pool=forks --no-file-parallelism` if flaky).
- Sieges (also hostile AI): sieges.test.ts, siegeProfiles.test.ts. Data: any test calling `validateGameData`.
- After editing common/: `npm run build:common`.
- Bullet-hell cost: server/src/bench/bulletHellBench.ts (docs/audits/boss-bullet-hell.md).

## Gotchas
- Dev-server boss stills: use native `npm run render`, not a browser; shoot.mjs only for live-fight shots.
- Moving a ship between render chunks must copy its damage row (fixed in ShipBatch); see boss-design section 9.
- broodMother.ts is a stub; `Bosses` still instantiates it, so a Brood Mother in a system does nothing special yet.
- A boss left mid-move is never put to sleep; `idle()` bugs show up as bosses stuck live far from pilots.
- Tests share state if run in parallel against the same game server; use the forks flag.
- Uncommitted edits exist in bosses.test.ts; do not revert.

## Related areas
`weapons` (boss kinds in tuning.json, `Weapons.spawn`, stage cover in `ShipBridge.hurt`), `world-sim` (SimLod `busy`/`idle`, SystemMemory capture/restore, nests in systems.json), `render-ships` (boss looks, skeletons, native renders), `economy-quests` (loot, kill credit, bounty quests), `networking` (boss messages), `ship-parts` (bespoke materials in materials.json, wire dictionary for new ids: `npm run wire:sync`).

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **Making a boss**: follow docs/boss-design.md (stages, look, fight, tuning, tools); stills via `npm run render -- boss:<name>` (no browser).
- **Bosses** (`data/bosses.json`, `Bosses.ts`): lair spawns, phases (escorts, enrage, heal, blink, telegraphed novas), cores hardened x2.5, intro on engagement, shared credit (damage in the last minute or close at death), personal loot to storage, respawn timers (a boss left alone is not reset: its system is remembered, see world-sim "world memory"). A boss pays full credits on a pilot's first kill, then `bosses.json rules.repeatCredits` (0.25), and no second copy of an artefact they hold (stat `boss:<id>`). Snapshot `ShipBody` data[4] = 2 marks a boss and data[7] carries hull %. Client: `ui/BossUI.ts` (bar, title card) and `DamageFx` (charge rings, death chain). Quest arenas: `server/src/game/Arenas.ts` (a `boss` step with `arena` + `person`; the boss is `arena` in bosses.json, spawned with `Bosses.spawnAt`, keyed per copy).
- **Enemies** (`data/factions.json`, designs in `data/ships/blueprints/enemy/`, generated by `scripts/gen-enemy-ships.mjs`): packs per system, AI in `Enemies.fly`, loot and salvage; behaviour `strafe` (< 1) makes big ships hold and brake instead of circling. Station defence: only armed stations (`defence` in stations.json, turret stats `rules.stationDefence`); each turret keeps its target while in reach, else takes the nearest; `stationFire` says which turret fired. The legacy enemy/NPC stack (`enemies.json`, `npcs.json`, old AI/spawn systems, NPC entities) is gone.
- **Grades**: `factions.json spawns.<system>.grade` builds hostiles in a grade (Sol and Glasswater Mk I; Borealis and Nebula Prime II; Cinder Reach III; the Void IV; the Maw V). `Enemies.design` regrades and caches a design (above Mk I the name carries the grade); kill pay scales by `gradeReward` (output^1.6) and enemy pay grows faster than linearly with the ship (`0.1 x base^1.25` in factions.json, x grade); `Enemies.systemRating` is the weighted rating of a system's packs.
- **Zones and the Drift**: `systems.json` zones are named rings; `factions.json spawns.<system>.zones` give a ring packs of its own, spawned only around pilots inside it (`Enemies.zonePoint`); a zone's packs nobody has been near for `rules.idleDespawnSeconds` are recycled. Sol's Drift (76-100k) holds the Scrapborn (`scrap_mite`, `scrap_spitter`, `scrap_crawler`: one thruster, worn drives with blueprint `drive` 0.6-0.85, so at most half a starter's speed, held by a test; faction `hpScale` 0.3; 15-40 XP) and the Scrap Mother (boss, level 3, at (-62000, 61000)). The Foundry Warden was tuned by a simulated bot: a Bulwark wins comfortably, a Prospector in about 40 s, an Arrow can lose, a mining ship cannot win.
- **Events** (`Events.ts`): raids on stations and salvage fields rolled per occupied system; `worldEvent`/`worldEventEnd` drive the star markers.
- **Traffic and autopilot**: `setAutopilot` (server/src/ships/bridge/pilotless.ts, reached through `ShipBridge`) turns freighters to face their target, uses the screen-direction keys nearest the nose and coasts to a stop; the Ceres Haulers wait 6 s at each station and are replaced 2 minutes after destruction. Snapshots tag pilotless ships (`data[0]` = 1 derelict, 2 traffic).
