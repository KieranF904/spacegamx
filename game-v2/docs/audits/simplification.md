# Simplification audit

Written 2026-10-31, before the architecture refactor. Owner rule: **"we prioritise understandable mechanics; there are
too many strange, poorly thought-out mechanics."** Test for every mechanic: can it be explained in one sentence in the
hangar, and does it give the player a real decision?

Feedback source: `docs/design/backlog-after-refactor.md`. Inputs: five read-only area surveys (weapons, energy, wiring
and hangar, flight and utility parts, economy and progression), with the doubtful claims spot-checked against the code.
Line counts are rough estimates of code removed across common, server and client. Data and art are counted where noted.

Why now: every mechanic cut before the refactor is code the refactor does not have to move. Cuts are cheap now. Anything
that needs a new design (the semi-auto rifle, hauling) waits until after the refactor.

---

## 1. Summary

- **Size of the surface.** The surveys list 155 mechanic rows. Some mechanics appear in more than one area (Surge, ammo,
  mounting, cargo mass, materials). Without the repeats that is about **120 distinct mechanics**.
- **How many are a problem.** About **85 (70%)** are rated confusing or redundant. About 35 are clear. The clear ones
  are the core: thrust and mass, guns that cost energy, brownout, splash and homing, salvage, credits, XP and levels,
  refining, loot pods.
- **Where the strangeness comes from.** Most of the confusing rules are not core verbs. They are hidden second layers on
  top of a clear first layer:
  - a second power type (Surge);
  - a second power-delivery channel (capacitor banks fed by touch);
  - a second inventory (ammo crates);
  - a second wiring mode (hand wiring);
  - a second modifier system (gems);
  - a second and third progression track (skills, reputation);
  - a second placement puzzle (side mounts);
  - a second weapon resource (heat).

**The five biggest wins:**

1. **Cut Surge completely.** This removes the Pulse Dynamo, the Flash Screen, charged shots, the engine kick, the shield
   flash restore, the Rail Driver bank scaling and touch-fed capacitor banks. About 550 lines. It closes three open
   design calls at once (Surge on beams, charged-shot visuals, most of the wire-dictionary skips).
2. **Make auto-wire the only wiring.** This removes hand wiring, the W wire tool, wire spools, weak-link scissors, the
   duplicate circuit overlay, loose circuits, the core trickle and the main-circuit choice. About 1,000 lines. This is
   the direct answer to "wiring is a little convoluted".
3. **Guns run on energy, not crates.** Only missiles and torpedoes keep ammo. This removes 13 special ammo types,
   dry-fire, the ammo loadout screen and the "open crate" state. About 1,200 lines including economy and UI.
4. **Cut gems and restrict weapon mods to one grade multiplier.** About 750 lines. This removes the largest hidden
   modifier system and a second source of heat on beams.
5. **Hide the legacy materials.** This is a data flag only, an hour of work, and directly fixes "the hangar still shows
   legacy material categories". 15 of the 28 materials are already `exclusive`. The other 13 non-Mk materials
   (insulated_polymer, conductive_steel, leaded_iridium, leestone, ceramic_laminate, sealed_composite, dense_ferrite,
   pyre_*, and so on) need checking. Then the palette shows one Mk I to V ladder.

Together, the "cut before refactor" list in section 2 removes roughly **5,000 to 6,000 lines**. About 1,500 of those are
data and art. The redesign items add more later.

---

## 2. Recommended cuts and merges (pick from here)

Ranked by clarity gained × code removed. **Timing** means one of two things:
- **Cut before refactor:** a cheap removal, with no new design needed.
- **Redesign after refactor:** needs a new design first.

Effort: S is under half a day, M is 1 to 2 days, L is 3 or more days.

Cross-cutting costs that apply to many rows:
- The wire dictionary is append-only. A cut id stays reserved.
- Saved ships and storage that hold a removed model id need a migration to the nearest kept model.
- Anything removed from the snapshot or pilot row needs a `PROTOCOL_VERSION` bump and `wire:bump`.

### 2a. Cut before refactor

| # | Cut / merge | Clarity | ~Lines | Effort | What the player loses | Dependencies |
|---|---|---|---|---|---|---|
| 1 | **Cut Surge wholesale.** Delete `surge.ts` (177 lines), the Steady/Surge power types, the Pulse Dynamo, the Flash Screen, charged shots, the engine kick, the shield flash restore and the Rail Driver's bank scaling. Capacitor banks become ordinary small batteries on the wire, so union-find banking, `feeds.bank` and the S1/S2 bank HUD bars all go. | High | 550 | M | Three niche part tricks. The Rail Driver loses its gimmick (it gets a new design later, row R1). | `surge.test.ts` deleted. Library or enemy ships that use the dynamo, Flash Screen or Rail Driver need a migration. Charge groups shrink (protocol bump). Field-guide and lore text. Closes the open calls "Surge on beams" and "charged-shot visuals". The wire-dictionary skip list drops to repair beam and point defence. |
| 2 | **Auto-wire only.** Cut hand wiring, the W tool (Draw/Erase, E, right-drag), wire spools and the Auto-wire / Clear / Back-to-auto buttons. The wire overlay becomes read-only. One overlay: powered/unpowered plus wires. Drop the weak-link scissors and the duplicate `drawCircuits`. | High | 900 | M | Manual routing. A player can no longer split a ship into separate circuits on purpose. | `Blueprint.wires` is derived, or dropped on load. Saved hand-wired designs get migrated (drop the wires and re-run auto-wire). Remove the spool item and its recipe, the wire bill in `Hangar.save`, the wire checks in `validateBlueprint`, and update `wireEdit.test.ts`. Enemies already auto-wire, so nothing changes there. |
| 3 | **Simplify power plumbing.** Unwired means unpowered, with a red warning (cut the loose circuit). Cut the core trickle and the main-circuit heuristic: the core is just a battery on its circuit. Cut the per-store discharge rate. Merge the general, drive and weapon pools into one battery kind (Drive Cell becomes a battery). Brownout is shared equally: no per-part priority, no engines-first rule. | High | 350 | M | Drive Cells as an engine-only reserve. Priority control. | `circuits.test.ts` migration guarantee (library ships never brown out) must still pass. Auto-wired enemies are unaffected. Rebalance a few library ships. The charge-group packing becomes trivial (protocol bump). Goes in after #2 so the circuit model is settled once. |
| 4 | **Energy-only guns (ammo option A).** Railgun, flak, mortar and cannon_hv run on energy. Only missiles and torpedoes keep crates, auto-drawn from the hold. Cut all 13 alternate ammo types (sabot, tungsten, aurum, quench, incendiary, chaff, frag, shaped, seeker, cryo, and others). Cut dry-fire (the 40% plain shot): an empty launcher just stops. Cut the per-ship loadout screen and the "open crate" state. Coilgun merges into Needle. | High | 1,200 | L | Ammo as a money and cargo sink. Situational ammo swaps, including the quench bane round against a boss. | `Ammo.ts`, `econ/loadout.ts`, the `ammoFor` items, recipes and shop rows, the dry flag in fire events (protocol), ammo tests. Economy loses a credit sink (see open question 3). Option B (keep crates, one stack per kind, no loadout UI) is the fallback and costs about half as much. |
| 5 | **Cut gems and the gem cutter.** Restrict `WeaponMods` to one grade multiplier. | High | 750 | M | Socketing gems to tweak a gun. | `gems.ts`, `gems.json` (which also edits `heatPerSec` on beams), the 18 jewel items, the outpost `gem_cutter` track, `seamGemChance`, the hangar socket UI, quests that grant gems. The `WeaponMods` extras on the blueprint go, and `weapons2.test.ts` changes with them. |
| 6 | **Hide the legacy materials.** Mark every non-Mk material `exclusive`, so it is enemy and boss skin only. Hide composite. The palette shows a single Mk I to V ladder. | High (owner request) | 15 + data | S | Themed hull materials in the player palette. | Enemy drops and recipes that name those materials. `partItemId` includes the material. Check that no quest gives the player one. |
| 7 | **One mounting rule.** "The gun's back edge touches the ship, and the barrel needs N clear cells ahead." Cut side mounts (`angle: right`), the F mirror/flip, the `attach any/back` split, the ±2° gimbal fire tolerance and the per-cell clear offsets. Turret arcs become a fixed number per model. | High | 350 | M | Side-mounted flak, searchlight, swarm and tesla layouts. | Regenerate `models.mjs` and `models.json`. `mounting.test.ts`, `turret.test.ts`. Saved ships with side mounts or flip need a migration. `PlacedPart.flip` in the wire format. The legacy-cannon `fixedGun` shell scaling moves to model numbers. |
| 8 | **Cut heat.** The Lance and Frostbite Lance use plain energy draw, like every other gun. | Medium | 150 | S | A resource bar on two guns. | The HUD heat bar, the beam heat colour, the snapshot heat field (protocol), the gem `heatPerSec` entries (gone anyway with #5). |
| 9 | **Cut the Stillstone jump fields.** The jump drive works the same everywhere. If the world still needs them, a live stillstone becomes a plain "cooldown resets inside this radius" point, with no scarred or dead tiers. | Medium | 170 | S | A hidden world modifier. | `jumpFields.ts`, `pilotJumpStep` on the server, client and replica, tuning `jump.lodestone*`. **Lore:** stillstones are canon. Check the lore docs before touching world text (lore-attribution rule). |
| 10 | **Cut skills** (mining, engineering, navigation) and fold a small flat bonus into level if needed. | Medium | 200 | M | A third progression track and the K window. | Profile migration. Quest rewards that grant skill points. Engineering currently adds fab slots silently, so fab slots become a constant. |
| 11 | **Cut hidden economy rules.** Cut the rare-traces ledger (traces become a fixed refining byproduct). Cut the insurance bond, the station loan with its 25% repay, docking fees and repair upkeep: repair at stations is free. Cut the market's 4-hour wanted/glut cycles but keep saturation. Rarity becomes colour only, taken from value. | Medium | 600 | M | Some money sinks and the trade-cycle motive for haulers. | Profile fields (`debt`, the traces ledger) need a migration. Aurum, voidglass and iridium need a new source. Trader vendor stock. Credit-sink balance (open question 3). |
| 12 | **Thin the part list.** Guns go from 38 to about 26. Cut Stinger, Cutter, Quake, Tesla, Overpulse, Blackout, Cloudmaker, Swarm and Coilgun, and either Longbarrel or Spear (decided with R1); grades do the scaling. Cut the Drift Sail and Vernier engines, the Heavy Coil (one Jump Coil with linear range), and the Flicker shield. | Medium | 450 (mostly data and art) | M | Variety that differed only by numbers. | Migrate saved ids. Reshuffle unlock levels. `gunDecor` barrel art, sfx, recipes, the `models.test.ts` counts. |
| 13 | **One damage-vs-defence rule.** Each weapon is "good vs shields", "good vs hull" or "even". Cut the per-kind `pen` table, damage type × material resist, and flat armour on plating (a plate just has more HP; Reactive and Spaced merge). Torpedo shield bypass becomes the same flag. | Medium | 300 | M | The "resists X" identity of plating and materials. | `damage.ts`, the resist table in `materials.json`, `damageModel.test.ts`, armour tooltips. Boss "bane" rules (check them before cutting `bane`). |
| 14 | **Strafer and dodge cleanup.** The dodge goes the way you hold; with no key held it goes sideways. Cut the last-dodge weave memory and the fallback chain, and quantise to 8 directions instead of 32. Energy is all-or-nothing: no partial-strength bursts, no 0.25 refusal, no bank-first path. | Medium | 150 | S | Nothing visible. | `strafer.test.ts`, `dodgeDir` comes out of keyframes and the pilot row (protocol). The Burst Strafer playtest is pending, so do it together with that playtest. |
| 15 | **Small invisible rules.** Each one here can be cut or merged on its own: (a) Stagger: guns fire together. (b) `CARGO_TURN_SHARE`: one cargo factor. (c) `driveFactor`: flight divides by full mass only. (d) Per-engine `boostDrain`: one boost rule. (e) The rock-tier mining percentage ladder: a tool can mine a rock or it can't. (f) Scrap returns: one fraction for everything. (g) Repair Beam: heals the part it hits, no 3-part spread. (h) Point Defence: one hit kills any interceptable shot. (i) Fab: drop the `instantMaxArea` exception. | Low each, Medium together | 350 | M | Nothing a player would notice. | Each has its own test file. Client prediction parity for stagger, `driveFactor` and boost. |
| 16 | **Hangar UI tidy.** (a) Dead `carriesFlow`/`loss` fields (types.ts:168,174 plus the validation schema). (b) The duplicate `WEAPON_FAMILY` map. (c) Core gets category `structure` in the data. (d) The connectors/joins overlays go behind free-build. (e) Leftover `knownPlans` and the `slotSave` plan field. (f) Rarity tags come off parts, but the legendary flag stays. (g) One `free` flag instead of `free`/`freeBuild`/`grantAll`. | Low | 300 | S | Nothing. | The `slotSave` shape change is a protocol bump. |

### 2b. Redesign after refactor

| # | Item | Why it needs a design | Notes |
|---|---|---|---|
| R1 | **Semi-auto rifle replaces the Rail Driver.** Owner request. Clip of 6 at about 8 ticks per shot, then a reload of about 2 s that costs one energy draw. No Surge, no slug crate, pierce 1. | New fire state (shots left, reload timer) that the client predicts deterministically by tick. HUD pips. Also gives a "reload" vocabulary that Twinlink and Swarm-style bursts could reuse. | About +80 lines for the clip, in the refactored weapon module. Cut the Rail Driver's Surge block now (#1). Until the rifle exists, the Rail Driver can run as a plain heavy railgun. Rebalance the Spear against it. **Confirm the gun (open question 1).** |
| R2 | **Hauling.** Owner: "cargo mass plus towing gives no decisions." | Needs a new hook: cargo worth protecting, fragile or volatile loads, a tow that matters in a fight. | Before the refactor, do only #15b (one cargo factor). After it, decide whether per-item mass (`load.ts`, the snapshot cargo slot, the item mass table) is cut or replaced. Tow load: prefer a physical tether reaction over "tow counts as cargo". Tow spring tuning (12 parameters) cut down to range, pull, break distance and salvage share. |
| R3 | **Quest and economy structure.** Merge the 22 step kinds into about 7 ("go to", "bring X to", "make X", "kill", and so on). Fold Operations (844 lines) into quests with a timer field. Dialogue keeps say/ask/offer/give/end. | Touches every quest in `quests.json` and `people.json`. This is content rework, not a deletion. | About 1,000 lines. Best done once the refactor has a quest registry. |
| R4 | **Reputation and vendors.** 6 factions, rank discounts, vendor-only items. | If vendors go, every vendor-only item needs a recipe, and reputation loses its purpose. Needs a decision on what factions are for. | Cheap part, which can be done now: delete `RANK_DISCOUNT` and the negative "Distrusted" range. |
| R5 | **Structure vs module, rebuild, death.** Make every part an item, or every part a material cost. Choose one rebuild rule. Remove "secure hold". | Changes ownership rules, the profile format and death penalties together. | About 400 lines. Pairs with the loaner (kept). |
| R6 | **Hangar build orders and ghosts.** One FIFO queue with cancel, no rank/hold/top. Parts in hand, or auto-queue on save, with no "ghost" placeholders. | `Hangar.ts` is a god-file the refactor will split anyway. | About 650 lines across orders, ghosts and slot counters. |
| R7 | **Legendaries.** Fold the Hive into missiles, Phase into the rail family, Frostbite into Lance with frost, Cinder Bloom into mortar with burn. Keep the Prism Splitter and Singularity as the distinctive ones. | Artefact recipes and lore are tied to them. Their kinds stay as boss attacks. | About 250 lines. Check the lore docs. |
| R8 | **Lasers on one beam path.** Drop the pulse fade-in, peak and trail curve. Laser, lance, frostbite, repair and mining all use `fireBeam`. | Needs new laser balance and visuals (`PulseFx`). | About 300 lines. |
| R9 | **Jump drive side rules.** Charge no longer takes the engines; "invulnerable during the burn" replaces "passes through hulls"; coil range is linear. | Changes how the drive feels and needs a playtest. | About 60 lines. |
| R10 | **Support credit.** "Healed the killer this fight" counts you as party, with no 20 s window and no 15 HP floor. One party share for XP and credits. | Answers the open "support-credit threshold" call, but multiplayer value is unproven. | About 85 lines. Could also be cut until the multiplayer need is proven. |
| R11 | **Outpost tracks** go from 9 to 3 (storage, hangar, defences). **Progression capacities:** keep build points (integer cost per grade) and hangar bays. Fab, refinery, party and design slots become constants. **Generated model recipes:** one formula, so the generated block in `recipes.json` is deleted. | These change the economy loop and the generator script. | About 1,100 lines combined. |
| R12 | **Steady vs burst loads on one allocator.** | Risks shifting library ship balance. Do it after #3. | About 70 lines. |

---

## 3. Per-area tables

Rating: **C** = clear, **X** = confusing, **R** = redundant. The "§2" column points to the section 2 row that covers it.

### Weapons

| Mechanic | Rating | Recommendation | §2 |
|---|---|---|---|
| Fixed vs turret mount | X | Keep the split. Cut the gimbal tolerance and the hull-ray arc recompute | 7 |
| Mounting rules (attach back, side mount, clear cells) | X | One rule: back edge plus clear lane | 7 |
| Stat sheet (damage, burst, interval, draw) | C | Keep. Hangar shows DPS and energy/s | – |
| Families with 1-3 thin variants (38 guns) | R | Thin to about 26 | 12 |
| Ammo crates | X | Energy-only except missiles and torpedoes | 4 |
| Special ammo variants (13) | X | Cut | 4 |
| Gems / WeaponMods on guns | X | Cut gems. Grade is a single multiplier | 5 |
| Heat (Lance, Frostbite) | X | Cut. Use energy draw | 8 |
| Pulse-shape laser vs beams | X | Merge onto one beam path | R8 |
| vsShield / vsHull / pen / type × material | X | One three-word rule | 13 |
| Chaining (Arc, Tesla) | C | Keep one arc gun | 12 |
| Splash, fuse, homing | C | Keep. State the "few nearest parts" cap | – |
| EMP and 4 s immunity | C | Keep. Chaff ammo goes with #4 | – |
| Rail Driver Surge bank scaling | X | Cut, then the rifle | 1, R1 |
| Coilgun (power instead of slugs) | R | Merge into Needle | 4 |
| Sniper: Rail Driver vs Longbarrel | X | Rail Driver becomes the rifle. Confirm | R1 |
| Heavy guns slow turning | C | Keep (general mass rule) | – |
| Legendaries (6) | X | Keep 2 distinctive, fold 4 | R7 |
| Repair Beam support credit | X | Simplify | R10 |
| Point Defence | C/X | Keep. One hit kills | 15h |
| Demolition Launcher | R | Cut (overlaps mining). Its `charge` path goes with #4 | 4 |
| Stagger | X | Cut | 15a |
| Dry-fire at 40% | X | Cut | 4 |

Correction to the weapons survey: the `magma` kind is **not** orphaned. It is a boss attack (tuning, boss telegraphs,
BossFx, sfx). Keep it.

### Energy and power

| Mechanic | Rating | Recommendation | §2 |
|---|---|---|---|
| Generators and demand | C | Keep (the core rule) | – |
| Steady vs burst loads | X | Hide in the tooltip now, one allocator later | R12 |
| Local circuits | X | Auto-wire only. Show a bar only when there is more than one circuit | 2, 3 |
| Loose circuit (unwired limps on) | X | Cut. Unwired means unpowered | 3 |
| Discharge rate per store | X | Cut | 3 |
| Brownout | C | Keep. Equal share | 3 |
| General / drive / weapon pools | R | Merge into one battery kind | 3 |
| Core store plus trickle | X | Core is a plain battery, no trickle | 3 |
| Main circuit auto-choice | X | Cut | 3 |
| Capacitor banks by touch | X | Capacitor becomes a plain battery | 1 |
| Surge power type | R | Cut | 1 |
| Charged shot | X | Cut | 1 |
| Engine kick | X | Cut | 1 |
| Shield flash restore | X | Cut | 1 |
| Flash Screen | R | Cut | 1 |
| Pulse Dynamo | X | Cut | 1 |
| Rail Driver bank power | X | Cut | 1 |
| Boost | C | Keep. Draw from total stored energy | 15d |
| Priorities, engines first | X | Cut | 3 |
| Wire spools | X | Cut | 2 |
| Gun, beam, mining and tow draw | C | Keep. Mining moves to draw-while-active later | – |
| Only engines pushing your way draw | C | Keep | – |
| Batteries | C | Keep (the one store) | – |
| Hangar load test | C | Keep. Shrinks to one line | – |
| Charge groups on the wire | C | Simplify (falls out of #1 and #3) | 3 |

### Wiring and the hangar

| Mechanic | Rating | Recommendation | §2 |
|---|---|---|---|
| Power flows along wires | C | Keep (one sentence) | – |
| Hand wiring vs auto-wire | X | Auto-wire only | 2 |
| Wire spools | X | Cut | 2 |
| Wire tool (W, E, right-drag) | X | Cut | 2 |
| Touching a generator means powered | C | Keep | – |
| Parts bridge networks | X | Falls away with #2 | 2 |
| `carriesFlow` / `loss` fields | R | Delete (dead) | 16a |
| Power, circuit and weak-link overlays | X | One overlay | 2 |
| Six overlay toggles | X | Keep power, arcs and balance. The rest go to dev | 16d |
| Load test panel and `designSig` | X | One "sustained fire N s" line | 2 |
| Weapon facing (T) | C | Keep | – |
| Attach back / side / any | X | Back edge only | 7 |
| Clear lanes | C | Keep. A single `clear: n` | 7 |
| F flip / mirror | X | Cut | 7 |
| Non-retroactive mount warnings | C | Keep | – |
| Legacy functions in palette data | R | Mark exclusive or move to enemy data | 16 |
| Seven tabs with Core folded in | X | Six tabs | 16c |
| Second weapon-family map | R | Merge with `modelCards` | 16b |
| Material chips (legacy materials) | X | Hide the non-Mk materials | 6 |
| Material vs grade | X | "Higher Mk is better." Drop resists | 13 |
| Size scaling exponents (^1.15, ^0.15) | X | Output proportional to cells | 15 (rebalance) |
| Rarity labels | R | Keep only the legendary flag | 16f |
| Licence by level | C | Keep | – |
| Part sources and ghosts | X | Redesign | R6 |
| Structure built from materials | C | Keep. Don't extend | – |
| Design slots and loaner refusal | X | Show "flying" and "N to build" only | R6 |
| Load lists (saved, shared, presets, plans) | X | One list. Drop plans | 16e |
| Ship summary and comparison | C | Keep | – |
| free / freeBuild / grantAll flags | R | One flag | 16g |

### Flight and utility parts

| Mechanic | Rating | Recommendation | §2 |
|---|---|---|---|
| Thrust, turn, mass | C | Keep | – |
| `driveFactor` on wrecked ships | X | Full mass only | 15c |
| Boost with per-engine `boostDrain` | X | One boost rule | 15d |
| Engine rated-speed fade | X | Keep. Show it as "top speed" | – |
| Cargo mass | X | Redesign with hauling | R2 |
| `CARGO_TURN_SHARE` | R | Cut | 15b |
| Burst Strafer | C | Keep | – |
| Dodge directions and fallback chain | X | Simplify | 14 |
| Dodge partial energy and refusal | X | All or nothing | 14 |
| Dodge input buffering | C | Keep | – |
| Strafer push by facing | C | Keep | – |
| Jump drive side rules | X | Simplify | R9 |
| Jump Coil / Heavy Coil ratio | X | One coil, linear | 12 |
| Stillstone fields | X | Cut | 9 |
| Gravity wells and horizon | C | Keep | – |
| EMP and cold numbing controls | X | One status-effect concept with HUD icons (hazards area) | – |
| Tow Beam spring (12 params) | X | Four params | R2 |
| Tow load counted as cargo | R | Physical tether | R2 |
| Salvage by towing | C | Keep (the Tow Beam's identity) | – |
| Tow limits (no live ships) | C | Keep. Answer "towing friendlies" with **no** | – |
| Repair Beam exclusions and 3-part spread | X | Heal the part hit | 15g |
| Support credit | X | Simplify or cut | R10 |
| Point Defence intercept hits and slew | X | One hit, plain turn rate | 15h |
| Turret, fixed and arc | C | Keep | – |
| Shields (Deflector, Flicker, Bulwark) | C | Keep. Cut Flicker | 12 |
| Flash Screen | X | Cut | 1 |
| Reactive vs Spaced plating | X | One plate | 13 |
| Material resists and grade | X | One ladder | 13 |
| Scanner and Long-Range Array | C | Keep | – |
| Mining Laser and Bore | C | Keep | – |
| Demolition Launcher | R | Cut | 4 |
| Siphon (gas) | X | Merge into the Mining Laser, or cut if gas has no use | open question 9 |
| Constructor Mk III exception | X | Drop the grade override | 16 |
| Battery / Drive Cell / Capacitor pools | X | One battery | 1, 3 |
| Surge and Pulse Dynamo | X | Cut | 1 |
| Wiring | X | Auto-wire | 2 |
| Per-part priority | X | Cut | 3 |
| Docking invulnerability | C | Keep | – |
| Seven engines | R | Five (cut Drift Sail and Vernier) | 12 |

### Economy and progression

| Mechanic | Rating | Recommendation | §2 |
|---|---|---|---|
| Credits and kill pay | C | Keep | – |
| Party and support kill share | X | One share number | R10 |
| Item catalogue (10 categories) | X | Fold gem and volatile into minerals, artefact into component | R3 |
| Rarity tiers | R | Colour only | 11 |
| Mining and refining | C | Keep. Drop the refinery slot cap | R11 |
| Rock tier efficiency ladder | X | Binary (can or can't mine) | 15e |
| Rare traces ledger | X | Cut | 11 |
| Gems and gem cutter | X | Cut | 5 |
| Part costs with per-function extras | X | 3-4 shared extras | R11 |
| Fab instant vs timed, slots | X | Drop the exception and the skill slots | 15i, 10 |
| Hangar build orders | X | One FIFO queue | R6 |
| Structure vs module ownership | X | One rule | R5 |
| Scrap 70% ore / 100% components | X | One fraction | 15f |
| Level unlocks by grade | C | Keep. One table | – |
| Six capacity meters | X | Keep build points and bays | R11 |
| Build points with fractional grade cost | X | Integers | R11 |
| Licences (level plus quest) | X | Level only | R11 |
| Sector licences | C | Keep | – |
| Market buy/sell spread | C | Keep | – |
| Saturation and demand cycles | X | Keep saturation, cut the cycles | 11 |
| Reputation (6 factions, discounts) | X | Redesign. Cut the discounts now | R4 |
| Faction vendors | X | Merge into crafting | R4 |
| Pilot titles | C | Cosmetic. Don't add rules | – |
| Ribbons that pay credits and XP | R | Cosmetic only | 11 |
| Rankings | C | Keep | – |
| Skills | X | Cut | 10 |
| XP and levels | C | Keep | – |
| 22 quest step kinds | X | About 7 | R3 |
| Generated bounties | C | Keep | – |
| Quest items and storage delivery | X | Flag in UI, one destination | R3 |
| Operations | X | Merge into quests | R3 |
| Dialogue (10 line kinds) | X | Five kinds | R3 |
| Codex | C | Keep | – |
| Ammo purchase and loadout | X | See weapons | 4 |
| Consumables (3 kit tiers, boost cell, scanner charge) | X | One repair kit. Cut the rest unless a role exists | 11 |
| Insurance bond | R | Cut | 11 |
| Death modes and secure hold | X | Redesign | R5 |
| Rebuild bill and unflyable state | X | Redesign | R5 |
| Station repair cost | X | Free | 11 |
| Station loan / debt | X | Cut | 11 |
| Loaner ship | C | Keep | – |
| Tow salvage (structure only) | X | Fixed share | R5 |
| Loot pods | C | Keep | – |
| Cargo volume plus mass | X | Volume only, then hauling | R2 |
| Cargo vs storage | X | Keep. Drop secure hold | R5 |
| Player trade | C | Keep | – |
| Outpost (9 tracks) | X | Three tracks | R11 |
| Craft gating (starter / level / quest) | R | Level only | R11 |
| Plans and `retired.ts` | X | Delete after migration | 16e |
| 72 generated model recipes | X | Formula only | R11 |

---

## 4. Keep: clear and good (do not cut by accident)

- **Flight core:** thrust, turning, mass, gravity wells and the horizon, docking invulnerability, only the engines
  pushing your way draw power.
- **Burst Strafer** (just reworked), with direction set by nozzle facing and input buffering.
- **Energy core:** generators make power, parts draw it, batteries buffer it, a shortfall browns everything down, boost
  burns extra, guns cost energy. The hangar load test as a teaching tool.
- **Building:** fixed vs turret (the core build decision), weapon facing, clear lanes, non-retroactive mount warnings,
  structure built from materials, the ship summary, licence by pilot level.
- **Combat vocabulary:** the stat sheet, chaining, splash, fuse, homing, EMP with its 4 s immunity, Point Defence as a
  counter, the shield size ladder, scanners.
- **Missiles and torpedoes** as the one limited-supply heavy ordnance.
- **Two distinctive legendaries** (Prism Splitter, Singularity Launcher) and the artefact-gated unlock.
- **Boss attack kinds** (`magma`, `prism_shard`, `cinder_bloom`, `phase`, `singularity`), even where the player model
  folds.
- **Economy core:** credits, XP and levels, mining and refining, crafting, loot pods, the loaner ship, player trade,
  rotating bounties, sector licences, the market spread and saturation, the codex, rankings.
- **Tow Beam salvage**, as the Tow Beam's single identity.

---

## 5. Open questions for the owner

1. **Which gun is the "sniper"?** The audit assumes the Rail Driver, because it is the only gun that depends on Surge.
   Longbarrel is a plain cannon with no hidden rule. If it is the Rail Driver, does Longbarrel stay or get cut as a thin
   variant?
2. **Ammo: option A or option B?** A: energy only, except missiles and torpedoes. B: keep crates, but auto-consumed
   with no loadout screen.
3. **Money sinks.** Cutting ammo, repair upkeep, docking fees, the loan and the bond removes most credit sinks. Is that
   acceptable, or should fabrication cost credits instead?
4. **Hand wiring.** Is anything lost by never letting a player route wires, for example separate circuits so that one
   hit can't black out the guns? If yes, keep a single "re-run auto-wire" and cut only the spools and the tool modes.
5. **Gems.** Cut them entirely, or keep a tiny version (damage or fire rate only)?
6. **Material and plating identity.** Is "this plate resists X" worth keeping, or is "higher Mk is better" enough?
7. **Stillstones.** Cut the jump fields outright, or keep them as a plain recharge point for the lore?
8. **Progression tracks.** Cut skills? Keep reputation only to unlock vendors, or cut it with the vendors?
9. **Gas and the Siphon.** Does gas have a planned use? If not, cut the Siphon.
10. **Save compatibility.** Are there live player profiles that must survive these cuts? The answer decides whether the
    migrations in section 2 are required or optional.
11. **Legendaries.** Fold four into base families as proposed, or keep all six as trophies?
12. **Size scaling.** Should a 2×2 gun be exactly four 1×1 guns? That is clearer, but every design gets rebalanced.
