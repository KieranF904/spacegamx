# Ship parts & models
Every buildable ship part is a *model*: a `FunctionDef` (common/src/ships/types.ts) with its own piece(s), material, grade, numbers and unlock level. Models are authored in one generator script, `scripts/econ/models.mjs`, which writes `data/ships/models.json`, the model recipes (`data/recipes.json` `models`), and the component items/recipes. `rebuild.ts` turns a blueprint of placed parts into `ShipDerived` (the stats everything else reads); `partStats.ts` explains one part in plain numbers for tooltips. Per-feature rules for the special parts live in small files (anchor, strafer, tow, support, surge).

## Files (what each owns)
| path | lines | owns |
|---|---|---|
| scripts/econ/models.mjs | 543 | THE source of every model. Banners: `W` weapon rows (l.50), `MOUNT`/`MOUNTING` rules (l.90-166), `LEGENDARY` (l.178), `E` engines (l.189), `OTHER` power/utility/shield/plating (l.257), then one appended block per feature: Surge (l.300), Support weapons (l.327), Strafer+Tow (l.359); `COMPONENTS` (l.397), `RECIPES` (l.408), write step (l.509+) |
| data/ships/models.json | 79 | GENERATED, one model per line (merge-friendly) + `legacy` family map |
| data/ships/{functions,materials,pieces,tuning}.json | 1075/420/192/558 | legacy functions (enemies/bosses/migration; still read for model base numbers), materials (HP, mass, grade), piece shapes, tuning (weapons, `tow`, `energy`, ...). Hand-edited |
| common/src/ships/types.ts | 402 | `FunctionDef` (l.148-275, every model field, one doc comment each), `MaterialDef`, `Blueprint`, `PlacedPart`, `WeaponMods`, `MountingRules` |
| common/src/ships/catalog.ts | 421 | `loadCatalog(files)` -> `Catalog` (`functions`, `families`, `materials`, `variants`); piece variants/transforms |
| common/src/ships/rebuild.ts | 609 | `rebuild()` FunctionDef -> `ShipDerived`. Numbered steps: 1 joins (l.292), 2 structure, 3 networks (l.310), 4 power (l.315), 5 physics (l.356), 6 weapons (l.423), 7 cargo/miners/scanners + feature blocks (l.463-535), local circuits (l.535) |
| common/src/ships/grades.ts | 200 | grade/material -> output: `partThrust`, `partSupply`, `partDemand`, `weaponStrength`, `partBuildPoints`, `isEngine` |
| common/src/ships/partStats.ts | 141 | `partStats()` plain numbers per part (fabricator, hangar, tooltips, rating) |
| common/src/ships/mounting.ts | 185 | weapon mounting rules: `mountingOf`, `checkMounting`, `partMountingProblems`, `mountingWords`, `clearCells` |
| common/src/ships/{strafer,tow,support,surge}.ts | 225/103/93/177 | per-feature tuning + pure arithmetic (see Energy/Flight guides for surge, strafer, tow; support = Repair Beam, Point Defence) |
| common/src/ships/models.test.ts, mounting.test.ts | - | catalogue/licence/migration invariants; mounting rules |
| common/src/econ/market.ts | - | `modelLicensed(fn,_,level)`, `partLicensed()`; `common/src/econ/items.ts` `partItemId()` |
| client/src/ui/componentGuide.ts, ComponentGuideUI.ts | - | Component Guide data (no DOM): `guideRows`, `rowGates`, tabs by `category` |
| client/src/ships/modelCards.ts, partTip.ts | - | palette cards and tooltips for a model |

## Public interface
- `Catalog` / `FunctionDef` (types.ts); `rebuild(RebuildInput): ShipDerived`; `ShipDerived` keys are the contract for flight, weapons, HUD, hangar (`strafe?`, `tow?`, `power?`, `weapons[]`, `thrusters[]`...).
- `partStats(catalog, tuning, {material,fn,piece}): PartStats | null`; `partMount`, `partBuildPoints`, `fnOutput`, `partGrade`, `partMaterial`.
- Mounting: `mountingOf`, `weaponSides`, `checkMounting`, `partMountingProblems`.
- Data files: models.json (generated), recipes.json `models` + `craft`, items.json components. `validateGameData.ts` (server/src/data) checks models.json (l.480), recipe-per-model (l.877).
- NOTE: docs/audits mention `describePart()` and a "feature registry"; neither exists yet. Facts come from `partStats` plus per-feature code.

## Invariants
- common/src/ships is deterministic and engine-agnostic: no Date.now, no Math.random (use rng.ts), no client/server imports. `rebuild` is pure.
- models.json, the `models` recipes and the component items are GENERATED: edit models.mjs and run `node scripts/econ/models.mjs`; never hand-edit them.
- Feature blocks in models.mjs are "appended last so no other model's order moves": `fabOrder` and `guide.order` come from array position; do not insert mid-list.
- Ids unique, a recipe for every model (the script throws otherwise); every id in `MOUNT` must be a weapon model.
- A model's material only sets HP/mass/resistances, never a stat multiplier. Unlock is by pilot level only (`modelLicensed`); no schematic opens a part early.
- Tests do not pin model counts (use invariants). Order of a family (e.g. cannons) IS pinned in models.test.ts.

## How to extend
Add a part model:
1. models.mjs: add a row to the right table (`W` weapons, `E` engines, `OTHER` generic) or, for a new mechanic, a new appended block like the Strafer/Tow one (l.359-387) with its own look (`color`, `decor`, `glow`; `decor` ids are in client/src/ships/partDecor.ts `DECOR_SHAPES`).
2. models.mjs `RECIPES` (l.408): add the recipe (script errors if missing or an input is unknown). New component: `COMPONENTS`.
3. Run `node scripts/econ/models.mjs`; diff data/ only for your model.
4. New FunctionDef field: add it to `FunctionDef` in types.ts (doc comment), read it in `rebuild.ts` in the matching numbered step (read only that slice), expose on `ShipDerived`, add the key to `validateGameData.ts` models schema (l.480-500).
5. New mechanic: own file `common/src/ships/<feature>.ts`, `export *` in index.ts, tuning under data/ships/tuning.json (read through a `xxxTuning(t)` with defaults, see tow.ts).
6. Weapon mount rules: `MOUNT` + `MOUNTING` entries in models.mjs (`attach`, `angle`, `arc`, `clear: ahead(n)`).
7. Surfaces: partTip.ts (tooltip rows), modelCards.ts, field guide section (client/src/ui/fieldGuide.ts), Component Guide picks it up from `category`/`unlock`/`guide`.
8. Protocol: a new model id must be appended to `common/src/network/wire-dictionary.json` (append-only; `npm run wire:sync` / `wire:bump`, see networking guide); `protocol.test.ts` pins a hash of the wire format, so a new model usually means re-pinning it and bumping `PROTOCOL_VERSION` (protocol.ts l.31, now 15).

## Tests
- `npx vitest run common/src/ships/models.test.ts` catalogue, licences, migration, fixed mounts, engine fade.
- `npx vitest run common/src/ships/mounting.test.ts` mount rules and checker.
- `npx vitest run common/src/ships/features common/src/ships/features/support/support.test.ts common/src/ships/surge.test.ts common/src/ships/catalog.test.ts common/src/ships/ships.test.ts server/src/game/tow.test.ts`
- `npx vitest run server/src/data/validateGameData.test.ts` data schema; `client/src/ui/componentGuide.test.ts`, `client/src/ui/fieldGuide.test.ts`, `client/src/ships/modelCards.test.ts`, `partPresentation.test.ts` UI facts.

## Gotchas
- The last commits each touched ~30 files for one part (Tow Beam): types, models.mjs, rebuild, partStats, partTip, field guide, protocol, flight, ShipBridge/ShipClient.
- `functions.json` legacy functions are still the BASE numbers for models (`FNS.get(KIND_BASE[family])`); do not delete them.
- `carriesFlow`, `loss` are dead fields (power runs along wires now); `exclusive` functions are never player parts.
- Old blueprints and saves are converted by `migrate.ts` (legacy kind -> family model); a new family needs no change there unless a legacy kind maps to it.
- Mount rules are not retroactive: saved ships that break them still fly, flagged in the hangar (`mounting: false` on load).

## Related areas
- [energy](energy.md): `demand`/`produce`/`surge`/`store`/`bank` fields feed circuits. [flight](flight.md): `thrust`, `strafe`, `tow` effects. [weapons](weapons.md): `weapon`, `weaponMods`, `gunDef`. [hangar-ui](hangar-ui.md), [render-ships](render-ships.md) (`decor`), [economy-quests](economy-quests.md) (recipes, items, unlocks), [networking](networking.md) (wire dictionary).

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **Grades** (`data/ships/materials.json`, `grades.ts`): Mk I alloy (or lighter, frailer composite), II steel, III titanium, IV cobalt, V neutronium (refined from neutronium ore, danger 4+ belts). Each has `toughness` (HP per cell), `density`, `output`; output multiplies weapon damage (`WeaponInfo.strength`), generator power (`partSupply`) and shield capacity, and weapons/shields draw `output` times the power (`partDemand`).
- **Size**: a weapon's size is its piece; damage grows as `(area / base)^1.15` (`base` = the smallest whole-cell piece it comes in), and bigger shells are larger and faster (`shot.ts`). Weapons also come in `block2`/`block3`. Pieces `block2` (2x2: hull, armour, conduit, reactor, engine) and `block3` (3x3: hull, armour) exist for capital ships; the part cap stays 255 (a full rebuild is ~5 ms at 210 parts, ~11 ms at 370).
- **Rating** (`rating.ts`): per part firepower (dps at the power it gets), toughness (HP + shields x 2), power; a ship rates `sqrt(firepower x toughness) / 22` (starter ~10, each grade ~a third higher). `partStats.ts` gives one part's numbers (grade, size name, damage, reach, power, thrust, score) for the UIs. `npx vite-node scripts/ship-ratings.ts` prints every design's rating per grade and every system's pack ratings.
- **Engines** (any function with `thrust`, `grades.ts isEngine`): ion thruster (thrust 2.26, draw 15, boost x2.2, drain x1, sq to block2), afterburner (1.9, 12, x3.4, x2.6), plasma drive (3.1, 26, x1.6, x0.7, rect2/block2/block3); numbers per cell before grade and size scaling. `partThrust` = thrust x area x (area/base)^0.15 x sqrt(grade output); draw scales by sqrt(output). `rebuild.ts` weights each ship's `boostFactor`/`boostDrain` by engine thrust and `stepFlight` uses them instead of the global `BOOST_FACTOR`. `scripts/merge-thrusters.ts` joins side-by-side single thrusters in plans (sparrow-t is a test fixture, left alone); `scripts/ship-energy.ts` and `scripts/add-batteries.ts` report/refit battery budgets.
- **Part presentation is data** (`functions.json`): name, rarity, description, fabricator category/order, colour, glow, decor shape key, shot and beam sounds, field-guide entry. A new part that reuses an existing decor shape and sound needs no code. The wire tables (`DICTIONARY`, `WEAPON_KIND_TYPE`) are still hand-kept apart from the model ids (see the networking guide).
- **Prototype decisions that still hold**: connector diagonal `'NW'` is `\` and `'NE'` is `/`; variants rotate about the origin cell's centre (footprint can reach negative offsets); the loader enforces "straight edges run between grid corners" (covers slope2's 2:1); demand is per unit of area; a consumer behind conduits with total loss L draws `demand x (1 + L)`; HP bands start at full (first crossing 75%); material only sets HP/mass, never a stat multiplier. Pre-made capital ships in `data/ships/blueprints/` (Lancer Frigate 100 parts, Galleon 162, Bastion Dreadnought 210, Hammerhead Carrier 211) are generated from hull profiles and checked by `validateBlueprint`.
- **Retired**: schematics (2026-10-30); everything opens by level (docs/parts-redesign.md section 6; `econ/retired.ts` cleans old saves). Fabrication `gates` went with them. `cellSize` is 24 (it was 8; mass is in grid units, so it did not change).
