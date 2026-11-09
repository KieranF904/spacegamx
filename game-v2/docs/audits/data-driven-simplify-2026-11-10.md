# Data-driven and simplify audit, 2026-11-10

Report only. Surveyed `common/`, `server/` and `client/` (no tests, prototypes or scripts). Every row below was checked
by reading the code. Effort: S under 1 hour, M a few hours, L a day or more. "Sim" says whether it touches shared-sim or
netcode code, which needs Opus and the golden/determinism tests.

The code is in better shape than usual for this size: the part tables, validation (`Spec`), ports, bosses and tick order
are already data or registry driven, and shared-sim code is clean of `Math.sin/cos/exp/**` (the only `**` hits are exact
integer powers of two in id packing). The wins are mostly copy-paste clean-up and a few hand-kept lists.

## Top 15

| # | Finding | Where | Kind | Effort | Risk | Sim |
|---|---------|-------|------|--------|------|-----|
| 1 | `mulberry32` and string-FNV hash copied into about 14 files | see A1 | duplicate | S | low | partly (common/econ) |
| 2 | Six different `wrapAngle`/`normAngle` copies, two can loop forever on Infinity | see A2 | duplicate | S | low | yes (flight, replication) |
| 3 | `validateGameData` is one 600-line function | `server/src/data/validateGameData.ts:650` | long fn | M | low | no |
| 4 | Core-outwards BFS copied twice, with `queue.shift()` | `common/src/econ/hangar.ts:112`, `server/src/game/Hangar.ts:772` | duplicate | S | low | no |
| 5 | `p.fn === 'core'` / find-the-core written 32 times, no helper | see A4 | duplicate | S | low | partly |
| 6 | Hand-kept part-fn lists in the client drift from `functions.json` | see C1 | data-driven | S-M | low | no |
| 7 | Dead legacy `fireCannon` and `ItemRegistry` | see D1 | dead code | S | low | no |
| 8 | `rebuildAsIs` is a 370-line function | `common/src/ships/rebuild.ts:373` | long fn | L | medium | yes |
| 9 | `buildPortsLayout` is a 350-line function | `common/src/ships/power/ports.ts:288` | long fn | M | medium | yes |
| 10 | `SECOND = 60` redeclared in 11 files; `TICK_RATE` exists | see B1 | duplicate | S | low | no |
| 11 | Party and loot share range (8000) defined twice; other gameplay numbers sit in code | see C2 | data-driven | S | low | no |
| 12 | Warmth lists every station in the world per pilot per step | `server/src/gameServer/wiring/game.ts:139` | perf | S | low | no |
| 13 | Snapshot builder makes two fresh `Map`s per client per snapshot | `server/src/net/SnapshotBuilder.ts:324` | perf | M | medium | yes (netcode) |
| 14 | `sendSnapshots` is a 250-line method | `server/src/net/SnapshotBuilder.ts:291` | long fn | M | medium | yes (netcode) |
| 15 | Tunables in code next to `tuning.json` (`BROWNOUT`, `CHARGE_DRAIN`, `MINE_CYCLE`...) | see C3 | data-driven | M | medium | yes (wire/golden) |

## A. Duplicated logic

**A1. RNG and hash copies (row 1).** `common/src/math/rng.ts` already exports `mulberry32` and `hashString` (same
constants, 32-bit FNV-1a over UTF-16 units). Byte-identical private copies exist in:
`common/src/econ/mining.ts:118-132`, `econ/quests.ts:316-330`, `econ/dialogue.ts:164`, `econ/market.ts:153`,
`server/src/game/Operations.ts:254`, `client/src/ui/itemIcons.ts:17-31`, `client/src/ui/systemMap/mapConsts.ts:56-70`,
`client/src/rendering/StationView.ts:39`, `client/src/rendering/surface/CityView.ts:22`, `client/src/dev/netSim.ts:38`
(this one uses `| 0` instead of `>>> 0`, check it before swapping), `server/src/bots/tasks/randomFlight.ts`,
`client/src/audio/sfx.ts`, `client/src/predict/ptKinds.ts:199` (own `FNV0` for a different integer fold, leave).
Why it matters: about 150 lines, and a fix to one copy (or a determinism rule) silently misses the rest. Change: import
from `@space-game/common`. I compared `mining.ts` and `itemIcons.ts` against `rng.ts` line by line: identical. The
common/econ ones feed payout rolls and quests, so run those tests; results stay identical. Do not touch `ViewerScene.ts:356`
(different mix). Also `fireCannon` (row 7) uses `hashString(\`bullet:${tick}:${eid}\`)`, a string per shot.

**A2. Angle wrapping (row 2).** Variants: `common/src/asteroid/orbit.ts:136` (`%` then one fix-up),
`common/src/network/replication.ts:226` and `common/src/ships/flight.ts:443` (`while` loops), `client/src/predict/ptKinds.ts:143`
(`while`), `client/src/rendering/cameraView.ts:34` (modulo form), and `common/src/ships/catalog.ts:122` (degrees).
The `while` forms spin forever if the angle is `Infinity` (NaN is safe: the compare is false). One closed-form
`wrapAngle` in `common/math/basic.ts` (the `cameraView.ts` form) would do. Careful: the loop and modulo forms differ in the
last ulp for values near +-pi, so replacing `flight.ts`/`replication.ts` (shared sim) changes bits in rare cases. Do the
client and `orbit.ts` first; for the sim ones add the helper but compare with a fuzz test before switching. Sim: yes.

**A3 (row 4). Core-outwards ordering.** `common/src/econ/hangar.ts:105-122` and `server/src/game/Hangar.ts:771-781` are the
same BFS, both with `queue.shift()` (O(n) per pop, so O(n^2) on a 500-part ship). `wires.ts:154` and `client/ships/route.ts:87`
do similar walks. Change: one `joinDepths` (it already exists in `common/src/econ/field/order.ts:10`, `joinDepths(n, root, joins)`)
used by all, with an index pointer instead of `shift`. Same results.

**A4 (row 5). Finding the core.** 32 sites do `parts.findIndex((p) => p.fn === 'core')` (e.g. `econ/hangar.ts:42,80,102`,
`ships/gunFacing.ts:111,181`, `server/game/RepairBank.ts:172,199,236`, `server/game/field/plan.ts:78,79,116`,
`client/ships/field/plan.ts:106,269`). No `coreIndex` helper exists. Change: `coreIndex(parts)` in `common/ships/blueprint.ts`.
Mechanical; the string 'core' then lives in one place.

## B. Constants and long functions

**B1 (row 10).** `const SECOND = 60` in `server/game/Arenas.ts:36`, `Events.ts:188`, `HomeStations.ts:31`, `Operations.ts:132`,
`Surfaces.ts:53`, `sieges/rules.ts:7`, `gunRange/target.ts:31`, plus `zoneshield/shaped.ts:20`, `power/ports.ts:65`, `portsLoadTest.ts:40`,
`power/units.ts:9`. `TICK_RATE = 60` is in `common/constants.ts:19`. Change: `import { TICK_RATE as SECOND }` (or export `TICKS_PER_SECOND`).
Several files also hold `STEP`/`CHECK_EVERY` cadences (`Warmth.ts:31`, `Operations.ts:131`, `Quests.ts:84`, `Codex.ts:42`)
that are fine as they are.

**B2 (rows 3, 8, 9, 14).** Longest real functions (brace-matched scan): `validateGameData` 602 lines, `rebuildAsIs` 369,
`buildPortsLayout` 348, `SnapshotBuilder.sendSnapshots` 250, `customMoves` 238 (a table, leave), `buildEnergyLayout` 232,
`stepFlight` 221 (sim, leave unless splitting by phase with golden proof), `AdminTools.exec` 221 (a command switch, fine).
`validateGameData` is the best target: it is already one block per data file (`index`, `ref`, `cond`, `lines` helpers at
681-800), so split into `validateShips`, `validateQuests`, `validateSystems`... in `server/src/data/validate/` with
the helpers in a shared context. No behaviour change, the test file already covers it. The sim/netcode ones
(`rebuildAsIs`, `buildPortsLayout`, `sendSnapshots`) have natural phases (see the numbered comments) but need Opus and
`golden/structure.test.ts` to prove nothing moved.

## C. Should be data

**C1 (row 6). Part-function lists in client code.**
- `client/src/ships/hullLook.ts:22-24`: `ENGINE_FNS`, `ENERGY_FNS` and the whole `hullKind` chain by fn id.
- `client/src/ships/partDecor.ts:87` exports a second `ENGINE_FNS`, derived from `functions.json` decor, with the same
  name. Both give the same set today (`thruster`, `afterburner`, `plasma_drive`); a new engine needs the first edited by hand.
  Delete the hand list and import the derived one (S).
- `client/src/ships/hullBuild.ts:36` `POWERED` (lists `dash_coil`, `brood_bay`, `pyre_lance`, `magma_mortar`, `heat_vent`,
  `molten_plate`, the Pyreclast's parts), `client/src/ui/shipStatus/source.ts:444` `PART_STORE_FN`,
  `client/src/viewer/builders.ts:12-13` `POINTED`/`ENGINES`, `client/ships/damage/shields.ts:149-156` the plating fn names.
  `functions.json` already has `category`, `decor`, `family`; add small fields (`hullKind`, `powered`, `stores`) and read them.
  Medium effort overall; low risk; client-only.

**C2 (row 11). Gameplay numbers in server code.** `rules.json` only holds `sieges, surfaces, events, operations, memory`.
Tunables outside it: `Party.ts` `WING_BONUS 0.08`, `WING_RANGE 3000`, `SHARE_RANGE 8000`, `PARTY_MAX 4`;
`enemies/loot.ts:15` `PARTY_SHARE_RANGE 8000` (the same number as `Party.ts:26`, kept twice); `Trade.ts` `TRADE_RANGE`;
`People.ts` `TALK_RANGE`; `Pilots.ts` `LOAN_REPAY_SHARE`; `LootPods.ts` `PULL_RANGE`; `Mining.ts` `CHUNK_BOOST`;
`Derelicts.ts` `DERELICT_PLATE_SHARE`; `enemies/defenders.ts` `DEFEND_GRUDGE_SHARE`; `Quests.ts` `LEAD_LEVELS_AHEAD`, `VISIT_RADIUS`.
Change: add `party`, `social`, `loot` sections to `data/rules.json` (the loader and validator pattern exists: `server/data/rules.ts`),
read once in the constructor. At minimum make `loot.ts` import `Party.ts`'s share range. Server-only, not sim. Do this when
Kieran wants to tune them; today they are single-file constants and cheap to find.

**C3 (row 15).** Shared-sim tunables as exported constants beside `data/ships/tuning.json`: `ships/energy.ts` `BROWNOUT`, `MINE_CYCLE`,
`CHARGE_GROUPS_AT`; `ships/guns.ts` `SEMI_BUFFER`, `CHARGE_DRAIN`, `CLIP_IDLE`; `constants.ts` `FRICTION`, `BOOST_*`,
`PLAYER_*`. They are already one named constant each, imported by both sides, so moving them gains little and costs a
golden/wire review. Low priority, listed for completeness.

## D. Dead or legacy code

**D1 (row 7).** `server/src/gameServer/combat.ts:20-72` `fireCannon` has no caller (only the constants it uses appear in
`ships.engine.test.ts`; `BULLET_SPEED`, `BULLET_DAMAGE`, `BLASTER_LIFE_TICKS` stay if the test still wants them).
`common/src/data/registries/ItemRegistry.ts` (with `getRarityColor` and its hardcoded colour switch) is imported only by
the `data/` index files, nothing in server or client. Both are removable; confirm with `tsc` and the tests. S.

## E. Optimisation with the same results

**E1 (row 12).** `server/src/gameServer/wiring/game.ts:139` (`warmthDeps.stations`) rebuilds
`[...stationQuery(world)].filter(system).map(...)` for every flying pilot every 15 ticks. `hosts/world.ts:133` already memoises
the same list in `gs.namedStations`. Cache per system the same way (stations never move). Tiny but free.
`hazardsDeps.flying`/`warmthDeps.flying` spread the clients map each call; once per 15 or 60 ticks, ignore.

**E2 (row 13).** `net/SnapshotBuilder.ts:324-325` creates `prevStates` fallback and `newStates` Maps per client per snapshot, then
stores `newStates` as next time's `prevStates`. Two Maps per client swapped and cleared would avoid the churn.
Small win per client, bigger at crowd sizes; netcode path, so Opus plus the netcode tests. Note `markIfChanged`'s
`JSON.stringify` only runs for newly seen stations and portals (guarded by `conn.knownEntities`), so it is not a hot cost.
`staticRows` still walks every station and portal per client per snapshot only to skip the known ones; a per-system
"all sent" flag on the connection would skip the walk.

**E3. Collisions.** `server/src/gameServer/combat.ts` `collisionSystem` and `ships/bridge/weapons.ts` `hitProjectile` are already
broadphase (spatial grid, bounding circle) then exact (`castShipAt` against real part shapes); I found no waste worth a change.
Minor: `hitProjectile` builds `{ eid, ship, ...hit }` and `{ ...shotVs, at, ... }` objects per candidate hit; only on actual hits.
`combat.ts:268` calls `asteroidSpin` and `getAsteroidPolygon` per asteroid candidate per shot; fine unless a profile says otherwise.

## Checked and fine

Shared-sim determinism (`Math.hypot/sin/cos/atan2/exp/pow` absent in `common/src` outside `detTrig`); tick order table; function
registry (`lookFn` + `partEffects` switch is the intended extension point); `sfx.ts` recipes (already data-shaped); validators
(already `Spec` driven); boss move tables in `common/bodies/moves` (per-boss code by design, per `docs/boss-design.md`).

## Suggested order

Sonnet, one branch: rows 1 (client and server copies), 4, 5, 7, 10, 11 (loot import only), 12, then 3 and 6. Opus: rows 2
(sim copies), 8, 9, 13, 14, 15.
