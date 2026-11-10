# Parts, power and progression redesign (spec)

The contract every piece of this refactor builds against. Decisions taken with Kieran (2026-10-30):

- **Modules are fixed named models**, not material × function × piece. Each has its own size (piece), stats, trade-offs
  and handwritten recipe. Materials stay for **structure** (hull, armour, cargo plates), where they make sense.
- **Power runs along wires**, an overlay drawn over the hull, not conduit blocks. A wire works while it's connected end
  to end; destroying the block under any of it cuts it there.
- **Levels unlock things you want**: everything a pilot can make has an unlock level, and nothing opens earlier (no
  schematics: retired 2026-10-30). The boss legendaries are gated by a very rare boss part in their recipe.
- **Existing saves migrate**: old parts map to the nearest model; nothing a player owned is lost.
- Enemy ships keep their graded legacy parts (their difficulty still scales by system), auto-wired.

## 1. The component model

A model is a function (`FunctionDef`) that is locked to its own piece(s) and a fixed material, with explicit stats.
Everything that reads functions keeps working (rebuild, flight, guns, rendering); only what chooses parts changes.

New `FunctionDef` fields (common/src/ships/types.ts):

| field | meaning |
|---|---|
| `model: true` | a player model (shown in the hangar palette, fabricated from its own recipe) |
| `family` | its family id (`cannon`, `ion`, ...): grouping in the palette and migration |
| `material` | the fixed material it's built of (its HP, mass, resistances; it is NOT a stat multiplier) |
| `grade` | its tech tier 1..5: armour penetration, kill pay, build points (replaces the material's grade for it) |
| `points` | build points per cell (overrides GRADE_BUILD_COST) |
| `unlock` | `{ level }`: the pilot level it's learned at (every model has one) |
| `weaponMods` | `WeaponMods` applied in gunDef before gems (`{ mul, add, set }`, the existing format) |
| `rated` | engines: the speed (world units/tick) its thrust fades out towards (flight.ts) |
| `legacy: true` | the old material-graded functions: enemy ships and migration only, never shown or crafted |

Rules:
- A model's stat formulas ignore its material's `output`: `outputOf` is 1 for a model part (partSupply, partDemand,
  partThrust, weaponStrength, battery `store`, shield). Its numbers are the model's own.
- A model's size factor is 1 (its `pieces` list is its own size; `weaponBaseArea` = its own area).
- `gradeOf` for a model part is `fn.grade`; build points use `fn.points`.
- Models live in `data/ships/models.json` (`{ "models": FunctionDef[] }`), merged into the function list when the
  catalog loads (server loadShipConfig, client Game.ts/protoMain, tests via loadShipConfigFromDisk).
  `scripts/econ/models.mjs` writes it from its tables: edit that, not the JSON.
- Item ids are unchanged in form: `part:<material>:<fn>:<piece>`. A model has exactly one item per allowed piece (its
  material is fixed), so most models are one item.

## 2. Recipes

`data/recipes.json` gains `models: { <modelId>: { inputs: Bag, time: seconds } }`. `recipeFor(partId)` uses the model's
recipe when there is one; structure keeps the plates formula. New intermediate components (items.json, category
`component`, crafted in `craft`):

| component | inputs | used by |
|---|---|---|
| `barrel_assembly` | 2 steel_plate, 1 servo_motor | cannons, autocannons, flak, mortars |
| `coil_winding` | 6 copper_wire, 1 ferrite_plate | railguns, arc, EMP, jump coils |
| `capacitor_cell` | 3 copper_wire, 1 insulated_polymer, 1 scrap_electronics | batteries, capacitors, pulse, lasers |
| `thrust_nozzle` | 2 titanium_plate, 1 ceramic_plate | torches, plasma/fusion drives |
| `fuel_injector` | 1 steel_plate, 2 propellant, 1 servo_motor | afterburners, torches |
| `reactor_core` | 2 hardened_steel, 1 crystal, 2 coolant | generators past the cell reactor |
| `wire_spool` | 4 copper_wire, 1 insulated_polymer | wires (one spool lays 4 segments) |

(Existing: scrap_electronics, servo_motor, targeting_chip, power_coupling, shield_emitter, nav_computer, quantum_core,
crystal_lens and the boss artefacts.)

## 3. The catalogue

Stats are per model, at its own size. Weapons are a base kind (tuning.json `weapons`) plus `weaponMods`; the interval
is `fireInterval` (ticks). Levels are unlock levels; L0 = starter.

### Weapons
| model | family | piece | L | kind | mount | what it is (trade-off) |
|---|---|---|---|---|---|---|
| Pip | cannon | sq | 0 | cannon | fixed | interval ×1.5 (draw kept): the starter gun, light, quick |
| Hammer | cannon | rect2 | 6 | cannon | fixed | dmg ×3.2, interval ×2.4, speed ×0.8, size ×1.6, pen +1: a slow heavy shell |
| Twinlink | cannon | rect2 | 12 | cannon | turret | burst 2, dmg ×0.9, spread +1.5, draw ×1.6: sustained, power-hungry |
| Longbarrel | cannon | rect2 | 20 | cannon | fixed | speed ×1.7, life ×1.4, dmg ×1.6, interval ×1.7: a sniper's cannon |
| Bastion | cannon | block2 | 30 | cannon | fixed | dmg ×4.4, interval ×1.7, pen +1, heavy: a ship-killer that slows your turning |
| Rattler | autocannon | sq | 3 | autocannon | turret | the base autocannon |
| Chainsaw | autocannon | rect2 | 14 | autocannon | turret | interval ×0.55, spread ×1.6, draw ×2: a hose |
| Stinger | autocannon | sq | 24 | autocannon | turret | dmg ×1.5, spread ×0.4, interval ×1.25: accurate |
| Burst | flak | sq | 4 | flak | turret | the base flak (ammo) |
| Cloudmaker | flak | rect2 | 16 | flak | turret | splash radius ×1.45, splash ×1.7, interval ×1.4 |
| Lobber | mortar | sq | 7 | mortar | turret | the base mortar (ammo) |
| Quake | mortar | rect2 | 24 | mortar | turret | splash radius ×1.4, dmg ×2, interval ×1.6 |
| Glint | laser | sq | 9 | laser | turret | the base pulse laser |
| Cutter | laser | rect2 | 18 | laser | fixed | dmg ×2.1, range ×0.8: close and brutal |
| Searchlight | laser | round | 26 | laser | turret | range ×1.5, dmg ×0.8: reaches out |
| Strobe | pulse | sq | 10 | pulse | turret | the base pulse gun |
| Overpulse | pulse | rect2 | 25 | pulse | turret | burst 4, vs shields ×1.9, vs hull ×0.5 |
| Dart | missile | sq | 11 | missile | fixed | the base launcher (ammo) |
| Swarm | missile | rect2 | 21 | missile | fixed | burst 3, dmg ×0.5, homing ×1.3 |
| Hammerhead | missile | block2 | 33 | missile | fixed | dmg ×3.5, splash ×1.6, speed ×0.7, interval ×1.8 |
| Needle | railgun | rect2 | 13 | railgun | fixed | the base railgun (ammo) |
| Coilgun | railgun | rect2 | 22 | railgun | fixed | no ammo, dmg ×0.7, interval ×0.6, draw ×1.8 |
| Spear | railgun | block2 | 28 | railgun | fixed | dmg ×2.6, interval ×1.5, pierce +1, draw ×2.2 |
| Hush | emp | sq | 15 | emp | turret | the base EMP |
| Blackout | emp | block2 | 35 | emp | turret | radius ×1.6, duration ×1.4, interval ×1.5 |
| Spark | arc | sq | 17 | arc | turret | the base arc projector |
| Tesla | arc | round | 29 | arc | turret | chain +2 jumps, falloff kept |
| Eel | torpedo | rect2 | 19 | torpedo | fixed | the base torpedo (ammo) |
| Leviathan | torpedo | block2 | 38 | torpedo | fixed | dmg ×2.4, speed ×0.8 |
| Lance | lance | rect2 | 32 | lance | fixed | the held beam |
| Hive, Frostbite, Cinder Bloom, Prism, Phase, Singularity | legendary | as now | 12, 12, 22, 10, 26, 30 | as now | per weapon | boss legendaries, one model each; each needs its boss's artefact (§6) |

Each weapon's mount is its model's (`FunctionDef.mount`, set in models.mjs `MOUNT`), not the pilot's choice: `partMount`
(blueprint.ts) reads it, and a placed part's `mount` counts only for legacy guns (enemies, bosses). Legendaries: Hive and
Phase fixed; Frostbite, Cinder Bloom, Prism and Singularity turret; the Demolition Launcher fixed. A model's numbers are
the whole of it: `tuning.fixedGun`'s slower loading and slower, bigger shells apply only to legacy fixed cannons (the
gimbal applies to every fixed gun).

### Mounting rules

Each weapon model also says how it may be fitted (`FunctionDef.mounting`, set in models.mjs `MOUNTING`; read through
`mountingOf` in common/src/ships/mounting.ts, defaults filled in). A gun fires out of its `facing` (a free straight edge)
and its base bolts on at its **attach edge**:

- `attach`: `'back'` means its attach edge must be joined to another part (it bolts on from there, not by a side);
  `'any'` (default) any join will do.
- `angle`: `'straight'` (default) the attach edge is opposite where it fires; `'right'` a **side mount**, the attach
  edge at right angles: to the left of where it fires, to the right when the part is flipped (F in the hangar).
  `weaponSides(catalog, part)` gives `{ fire, attach }`.
- `arc`: a turret's traverse in degrees, centred on where it fires (rebuild clips its window to it; 360° turns the
  short way round). Fixed guns have none: they keep the small gimbal (`tuning.fixedGun`).
- `clear`: cells that must hold no part, as `[right, ahead]` in the gun's own frame (ahead 1 = the cell just past its
  firing edge), counted from each cell of that edge (a 2-wide face clears a 2-wide lane), mirrored by `flip`.
  `clearCells(catalog, geom)` gives them in grid cells.

| model | mount | arc | attach | angle | clear ahead |
|---|---|---|---|---|---|
| Pip | fixed | – | back | straight | – |
| Hammer | fixed | – | back | straight | 1 |
| Twinlink | turret | 180° | any | straight | – |
| Longbarrel | fixed | – | back | straight | 3 |
| Bastion | fixed | – | back | straight | 2 |
| Rattler | turret | 270° | any | straight | – |
| Chainsaw | turret | 240° | back | straight | – |
| Stinger | turret | 200° | any | straight | – |
| Burst | turret | 200° | back | right (side mount) | – |
| Cloudmaker | turret | 240° | back | right (side mount) | – |
| Lobber | turret | 360° | any | straight | – |
| Quake | turret | 360° | back | straight | – |
| Glint | turret | 240° | any | straight | – |
| Cutter | fixed | – | back | straight | 1 |
| Searchlight | turret | 360° | back | right (side mount) | – |
| Strobe | turret | 220° | any | straight | – |
| Overpulse | turret | 120° | back | straight | – |
| Dart | fixed | – | back | straight | 1 |
| Swarm | fixed | – | back | right (side mount) | 1 |
| Hammerhead | fixed | – | back | straight | 2 |
| Needle | fixed | – | back | straight | 2 |
| Coilgun | fixed | – | back | straight | 2 |
| Spear | fixed | – | back | straight | 3 |
| Hush | turret | 360° | any | straight | – |
| Blackout | turret | 120° | back | straight | – |
| Spark | turret | 270° | any | straight | – |
| Tesla | turret | 300° | back | right (side mount) | – |
| Eel | fixed | – | back | straight | 2 |
| Leviathan | fixed | – | back | straight | 3 |
| Lance | fixed | – | back | straight | 4 |
| Rustjaw's Hive | fixed | – | back | straight | 1 |
| Frostbite Lance | turret | 150° | back | straight | – |
| Cinder Bloom | turret | 360° | any | straight | – |
| Prism Splitter | turret | 270° | any | straight | – |
| Phase Cannon | fixed | – | back | straight | 3 |
| Singularity Launcher | turret | 180° | back | straight | – |
| Demolition Launcher | fixed | – | any | straight | – |

(Clear cells are a straight lane, `[0, 1]`…`[0, n]`.) The round Searchlight and Tesla are side mounts because a
quarter-round has straight edges on two adjacent sides only: it fires out of one and bolts on at the other.

Enforcement: `checkMounting` / `partMountingProblems` (mounting.ts) report every rule each part breaks;
`validateBlueprint` turns them into `badMounting` errors, so the server refuses a refit, slot save, design save or share
that breaks one. A saved ship is loaded with `validateBlueprint(..., { mounting: false })` (Pilots.applyShip): one
fitted before a rule existed still flies, and the hangar marks its broken guns red (attach edge, blocked clear cells,
the reason in the part's tooltip) until the pilot fixes them. Legacy weapons (enemies', bosses') have no rules. The
hangar always applies the rules, free build included (that skips ownership only): the part in hand shows its attach
edge (green), its clear cells (shaded; red where blocked) and its turret arc, picks a facing that keeps the rules
when facing is auto, and refuses a placement with the reason.

Strength grows gently with tier rather than by a material ladder: a model's `grade` is roughly its unlock level / 8
(1..5), which sets penetration; raw damage per cell across a family rises about 1.5× from its first to its last model.

### Engines (thrust per cell, draw per cell, rated speed, boost × / boost drain)
| model | piece | L | thrust | draw | rated | boost | character |
|---|---|---|---|---|---|---|---|
| Ion Drive | sq | 0 | 2.0 | 9 | 34 | 2.0 / 1.0 | efficient, low top speed |
| Vernier | tri | 2 | 1.2 | 4 | 40 | 1.6 / 0.8 | cheap small side thrust |
| Afterburner | sq | 5 | 1.6 | 8 | 50 | 3.6 / 3.0 | weak cruise, huge burst boost |
| Torch | rect2 | 8 | 4.0 | 34 | 70 | 1.6 / 1.2 | brutal thrust, burns energy |
| Plasma Drive | rect2 | 16 | 3.1 | 20 | 55 | 1.8 / 0.8 | the balanced main engine |
| Drift Sail | round | 22 | 0.9 | 3 | 26 | 1.3 / 0.5 | near-free cruising |
| Fusion Torch | block2 | 30 | 3.6 | 28 | 85 | 1.7 / 1.0 | the long-haul racer |

### Power
| model | piece | L | stat | character |
|---|---|---|---|---|
| Cell Reactor | sq | 0 | produce 35/cell | the starter generator; explodes when destroyed |
| Isotope Pile | round | 9 | produce 18/cell | weak but tough and never explodes |
| Fusion Plant | block2 | 18 | produce 48/cell | heavy (mass ×2), a big blast |
| Overclock Reactor | rect2 | 24 | produce 62/cell | fragile (hp ×0.5), the biggest blast |
| Battery | sq | 0 | store 200/cell, general | |
| Capacitor | sq | 7 | store 160/cell, weapon pool | light, feeds guns |
| Drive Cell | sq | 10 | store 320/cell, drive pool | |
| Heavy Bank | block2 | 20 | store 300/cell, general | dense, heavy |

### Utility, shields, structure
| model | piece | L | notes |
|---|---|---|---|
| Mining Laser | sq | 0 | the base miner |
| Bore | rect2 | 10 | a heavier miner (its material sets its mining tier) |
| Demolition Launcher | sq | 8 | mining charges |
| Siphon | sq | 12 | gas siphon |
| Scanner | sq | 5 | range 2400 |
| Long-Range Array | round2 | 20 | range ×2, draw ×2 |
| Deflector | sq | 11 | shield 40/cell |
| Flicker Screen | round | 19 | shield 20/cell, draw ×0.4 |
| Bulwark Projector | block2 | 27 | shield 45/cell, draw ×1.2 |
| Jump Coil | sq | 14 | jump capacity 12/cell |
| Heavy Coil | block2 | 30 | jump capacity 16/cell |
| Constructor | sq | 2 | as now (Mk III titanium; level 2 so the lane-clearance job, offered at 2, can have you build one) |
| Reactive Armour | sq, rect2 | 12 | armour 2, hp ×2, mass ×1.6: lighter protection |
| Spaced Plating | sq, rect2 | 22 | armour 1, hp ×3.2, mass ×1.3 |

Hull, armour and cargo stay material plates: Alloy (L0), Composite (L3), Steel (L5), Titanium (L12), Cobalt (L22),
Neutronium (L32). The special materials open at the level their plate can be refined (recipes.json refining):
Insulated Polymer 10, Leestone 12 (and the Ark's job, Ark-Heavy, as well), Dense Ferrite 30, Conductive Steel 35,
Leaded Iridium 45, Ceramic Laminate 45, Sealed Composite 45 (econ/market.ts MATERIAL_LEVEL). The bosses' own materials
and dev's aren't a pilot's to build with.

## 4. Power: wires

- `Blueprint.wires?: [x0, y0, x1, y1][]`: segments between neighbouring grid cells (8-neighbour; each end a cell's
  integer coordinates). A cell is live if an intact part covers its centre; a segment is live if both its ends are.
- **Networks**: live wire segments join into nets; a part joins every net with a live wire node inside it, and a part
  touching a generator directly is plugged into it (no wire needed). Parts bridge the nets they sit on. Modules
  touching modules do NOT share power any more; conduit blocks are gone (legacy conduits are plain structure).
- Per network: generators' supply; steady loads share it by priority (allocateFlow, as now); engines, guns and miners
  are powered if their network has a generator or a battery, else not. Batteries count only on a network with a
  generator. Spare power is summed over networks into the ship's battery, as now.
- A blueprint without `wires` (enemies, old designs) is auto-wired once at load (`autoWire`, common): a shortest-path
  tree over cells under parts from the generators to every part that makes, stores or draws power. The hangar has an
  Auto-wire button that does the same; players can draw and erase segments by hand.
- Wires cost `wire_spool` (1 per 4 segments), charged when a design is saved, like structure plates.
- Drawn over the hull: lit in its network's power when live, dark when cut.

## 5. Engines

- `ThrusterInfo.rated`: the engine's rated speed. Its thrust at speed v is `thrust × clamp(1 − (v / rated)^6, 0, 1)`:
  near full until close to its rating, none past it (flight.ts thrustAlong takes the speed). Legacy engines (no
  `rated`) don't fade. Replicated as everything in flight is (clients step the same derived).
- A model's draw is its own (`demand` per cell, no output scaling).

## 6. Progression

- XP curve unchanged: `120 × (L^2.2 − 1)` (Kieran kept the old pace).
- **Nothing opens early** (Kieran, 2026-10-30): everything a pilot can make has a level and opens there, never before.
  A model at its `unlock.level` (`modelLicensed`); a structure material at its MATERIAL_LEVEL (`materialLicensed`);
  a fabricator recipe that isn't a starter at its `level` (recipes.json craft; `canCraft`, and the data validator
  insists on it). A job's kit (`quest`: the buoy parts, the field crucible) needs its job's teaching too, and leestone
  its job's licence; the core keeps its licence (First Light teaches it at level 1).
- **The schematics are retired**: every `schematic_*` item is gone, with its drops, quartermaster stock and quest
  rewards (a quest whose reward was a licence gives plate or parts instead). A save is cleaned on load
  (econ/retired.ts): a held boss-legendary schematic becomes that boss's artefact, any other schematic goes, and so do
  the fn:/material: licences they taught (all but the core's and leestone's).
- **The boss legendaries** open at their level (Prism 10, Hive 12, Frostbite 12, Cinder Bloom 22, Phase 26,
  Singularity 30) and each recipe needs one very rare part from its boss, rolled per pilot per kill (and only while
  you don't already hold one): Prism Shard (Prism Colossus) 6%; Rustjaw's Cog (Rustjaw) 5%; Heart of Hoarfrost
  (Hoarfrost Matriarch) 5%; Warden's Ember (Cinder Warden 4%, the Pyreclast 6%); Void Pearl (Void Leviathan) 4%;
  Fragment of the Maw (Heart of the Maw) 3%. With respawns of 9 to 15 minutes that's about 17 to 33 kills on average,
  an evening or several of farming.
- Fabricator recipe levels: buoy parts 2 (and Cleared for Departure), field crucible 4 (and The Crucible Pattern),
  servo motor 10, targeting chip 12, insurance bond 15; special ammunition a few levels after its gun: frag 6,
  incendiary 8, chaff 10 (flak 4); shaped 13, seeker 15, cryo 17 (missile 11); sabot 15, aurum 18, tungsten 20
  (railgun 13). The outpost armoury's dead "special ammunition" perk (tier 3) is now its **Quench line**: it presses
  Quench Slugs (railgun; 30% less damage, ×2.5 on Cinder Cult ships, not bosses: `set.bane`), a recipe that opens at 25
  and is taught only by Forgemaster Hale's job Cold Iron (`cinder_quench`, after main_10). Both locks: the job teaches
  it, and only your own station's armoury (tier 3 `rounds`) makes it.
- Level-up toasts name the models and materials it unlocked; the field guide shows the track.
- Fixes: per-kill credits rise with enemy grade (no inversion); the top reputation rank is reachable; skill caps rise to
  20 each and a level gives a point up to 60 points.

## 7. Migration (profile version 4)

- Each legacy part (`fn`, `piece`, `material`) becomes a model by a table: the family for its function, the model of
  its size (sq/tri/slope/round → small, rect2 → medium, block2/block3 → large; nearest if a size is missing).
  Hull/armour/cargo keep their material. Conduit blocks become hull of the same material.
- Ships in `ship`, `hangar[]`, `designs[]` are converted and auto-wired; part items in cargo and storage become the
  mapped model's item (counts kept); fabricator jobs' outputs too. Licences are kept.
- The starter and library blueprints (data/ships/blueprints/*.json, not enemy/) are converted in place by
  `scripts/archive/econ/migrate-blueprints.mjs`.
- Salvage from enemies (legacy parts) yields the mapped model's item.
