# Field fabrication, material packs and the repair bank

Agreed with Kieran, 2026-11-07. Insurance, loaners, repair kits and free station repair go. Ships fit a **fabricator** and a
**refiner** that build, repair, refine and recycle from the hold while the ship flies. Each pilot has one **repair bank**
that rebuilds them after a death.

Status: the shared foundation is built and committed (section 9). Packages A to D (section 10) build the rest in parallel.
Kieran tests on the local dev server, where guests and signed-in pilots are admin. Every number here is a starting point
for playtesting.

**One build rule (Kieran, 2026-11-09).** The world build view (key 7) and the hangar both just edit the ship's
**blueprint**, in the same format and with the same look. A part the blueprint has and the ship hasn't is **missing**,
whether the build view planned it or a hit shot it off, and the same repair path builds it: the fabricator in the field
(damaged first, then missing, nearest the core), the station and the repair bank when docked. Taking out a standing part
marks it for recycling. There is no field plan apart from the blueprint: no draft kept beside it, no `waiting` list, no
placeholder (`ShipState.ghost`) flags for build view parts, no blue ghost overlay. Sections 1.5, 4, 5.1, 6 and 7 below
say it that way; the package briefs in section 10 are the history of how it was first built, with planned "ghosts".

**Planned ahead, not connected (Kieran, 2026-11-09).** Both editors accept a part that joins nothing, and the saved
blueprint keeps it. It is *planned but unreachable* (`ValidationResult.unreachable`, a status and not an error): nothing
builds it (the fabricator, the station, the bank and the hangar's fitting only pick parts that join a standing one), and
it never counts as built, flies, or adds mass, stats or power until something joins it to the core's structure; then it
builds as any missing part, nearest the core first. Both views show it faded with a dashed violet outline and a "not
connected" note, and list it in the summary. The hangar keeps it as a placeholder that no order makes (`buildableGhosts`).
Taking out a part no longer takes out the missing parts it held on: they stay, not connected.

What follows from it, for playtesting: a planned part counts as a lost part in flight (the flight model divides by the
whole design's mass, so planning a big addition slows the ship until it is built); the free spare, the station's
passing-by rebuild and a death's free part pay for planned parts as for lost ones. Still separate: the hangar's own
placeholders (`ShipRecord.ghosts`, parts the hangar has no item for yet, and a death's owed parts), which keep their
flag so flight doesn't count them; folding those in too is a later step.

---

## 1. The rules (Kieran's, as agreed)

1. **Fabricator**: at most one per ship, tiers 1 to 3. A higher tier is faster and makes higher-grade parts. It draws more
   power than any other part, and only while it works. It can be switched on or off at any time, mid-fight too, and it
   competes for power with guns and shields through the ports core's proportional, source-agnostic sharing. It builds
   from materials in the hold using the existing part recipes (`data/recipes.json`). It **builds and repairs**: damaged
   parts first, then missing ones, nearest the core first, as repair kits did.
2. **The core fabricates slowly by itself**: only starter parts and the Tier 1 fabricator, so a stripped ship can always
   bootstrap. It draws no power, so a bare core with no generator still works.
3. **Refiner**: its own part, at most one per ship, tiers 1 to 3. It draws a lot of power, but less than the fabricator,
   so it can run passively while mining. The core also refines slowly at low grade.
4. **Fabrication and attachment** are separate phases, so a hold full of finished parts cannot repair a ship instantly.
   A part placed from the hold still takes attachment time.
5. **Field plan**: building in world space is an overlay on the live game. The view swaps to the helm view, zooms in and
   shows the build interface while the ship keeps flying. Saving writes the ship's blueprint: new parts are missing
   parts the fabricator fills in, as it rebuilds parts shot off. Saving is free; only building costs.
6. **Recycling**: queue a standing part for removal. It is broken down slowly and returns about 50% of its materials.
   Rearranging a ship in space is recycling plus rebuilding.
7. **Orphaned build**: if the part a build depends on for placement is destroyed, the fabricator finishes the part anyway.
   It then goes to its planned spot if that is joined again, else to another open planned spot waiting for the same part,
   else into the hold until it can be placed.
8. **Hold full**: a finished item (a refined material, a part, recycled materials) stays inside the machine, and that
   machine stalls until the hold has room. Nothing is lost. A finished part that can go straight onto a planned spot does
   so without needing hold space.
9. **Material packs replace repair kits.** They are made only at stations, from mixes of refined materials. There are
   several pack types, each covering a niche of materials (the Tier 1 pack is 2 alloy plate, 2 composite sheet and 2 steel
   plate), and they stack like resources. **In the field a pack pays only ONE unit** of any one of its constituents. That
   is deliberately very expensive: a sink for surplus materials, to be playtested later. Work paid with packs goes **60%
   faster**.
10. **Stations**: refine and fabricate quickly, swap ships, and so on. **No free station repairs.**
11. **Insurance and loaners are removed entirely.** Each pilot has one **global repair bank**, the same at every station:
    - **Free part**: refills by itself, up to two starter ships' worth of basic materials, empty to full in about 5 minutes (changed 2026-11-09 from one ship over 30 minutes). It can't be withdrawn. On a
      respawn it pays for the ship at once, core outward. The half above one ship's worth can also pay basic materials for
      repairs.
    - **Deposits**: the pilot puts in packs and refined materials. Deposits can't be withdrawn and are counted apart from
      the free part. They do **not** pay at once on a respawn. They repair quickly and cover a wider range of materials:
      they mend the relevant parts as the ship passes a station, and after a respawn they rebuild, at the normal rate,
      whatever the free part didn't cover. A bank pack used on a part can give **all** of its constituents; any the part
      doesn't need is wasted.
    - **No guaranteed ship**: a pilot who dies again and again until the free part is empty respawns as a bare core, and is
      rebuilt slowly as the bank refills.
12. Existing players' repair kits and insurance bonds become **bank deposits** (a profile migration).

---

## 2. The numbers

All of them live in `common/src/econ/field/rules.ts` and `bank.ts` (`FIELD`, `FAB_TIERS`, `REFINE_TIERS`, `BANK`). Change
them there only. The server runs by them and the client predicts and shows by them.

### 2.1 Machines (`scripts/econ/models.mjs`, "Field machines" block)

**Work** is counted in seconds at speed 1. A machine of speed *s* at full power gets through *s* of them each second.
Short of power, it gets through its share of that.

| Part (id) | Tier | Piece | Unlock | Material | Draw while working | Speed | Makes up to | Recipe |
|---|---|---|---|---|---|---|---|---|
| core (built in) | 0 | | | | none | 0.25 | starter parts + Field Fabricator | |
| Field Fabricator (`fabricator_field`) | 1 | rect2 | L0 | alloy | **40 E/s** | 1 | Mk II | 4 alloy plate, 4 copper wire |
| Fabrication Bay (`fabricator_bay`) | 2 | block2 | L12 | steel | **70 E/s** | 1.6 | Mk III | 4 steel, 6 wire, 2 servo, 1 coupling |
| Assembly Forge (`fabricator_forge`) | 3 | block2 | L24 | titanium | **110 E/s** | 2.5 | any (Mk V) | 6 titanium, 3 servo, 2 coupling, 1 targeting chip |
| core (built in) | 0 | | | | none | 0.2 of a station | Mk I materials | |
| Field Refiner (`refiner_field`) | 1 | sq | L3 | alloy | **20 E/s** | 0.4 | Mk II | 3 alloy, 2 wire, 1 coolant |
| Refinery Bay (`refiner_bay`) | 2 | rect2 | L12 | steel | **35 E/s** | 0.7 | Mk III | 3 steel, 4 wire, 1 lens, 2 coolant |
| Smelter Forge (`refiner_forge`) | 3 | block2 | L24 | titanium | **55 E/s** | 1.0 (a station's pace) | any | 4 titanium, 4 wire, 1 reactor core, 2 coolant |

How these draws compare with the ship's power. A Cell Reactor gives 35 E/s and a Fusion Plant port gives 100. The starter
Sparrow T makes 70 E/s, and the player remakes in `data/ships/blueprints/remakes` make 140 to 808. The biggest steady
draws today are the Cutter at 32 E/s and the Mining Laser at 30. So a Field Fabricator at 40 is the biggest draw on a small
ship: running it on the Sparrow T leaves 30 E/s for the guns and engines. The Field Refiner's 20 E/s fits beside one
mining laser and a pair of Ion Drives on the Prospector (30 + 18 + 20 of 70).

Ports: power comes in at the back, like any tool: 1.5 times the draw, split over the back cells. Hull HP x0.8. The Bay and
both Forges are heavy (massScale 1.4 to 1.6). Category `utility`. **One of each kind per ship** (`blueprint.ts`
`machineCount`).

**Grade caps.** A part's grade is `ships/grades.ts partGrade`: a model's own grade, otherwise its material's. "Starter
parts" are models that unlock at level 0 (the Pip, Ion Drive, Cell Reactor, Battery, Mining Laser and Conduit) plus Mk I
structure. Each tier can make the next one: T1 makes the Bay (Mk II) and T2 makes the Forge (Mk III). The core never
makes a core. Legacy (enemy) functions are never made. A refining recipe's grade is its plate's material grade, otherwise
`1 + floor(level / 10)`.

**Which machine runs.** A ship that has no working fabricator part (or no refiner part) uses the core's own in its place,
at tier 0. So a ship always has exactly one fabricator and one refiner. A destroyed machine part hands its work over to
the core's own.

### 2.2 Work, time and cost (`rules.ts`)

| What | Work seconds | Cost |
|---|---|---|
| Fabricate a part | `6 x cells x timeByGrade[g]` + the part's station recipe time (`recipes.partTime`) | its recipe inputs (`partInputs`): a module's recipe, structure's plates |
| Attach a part (built here or taken from the hold) | `3 x cells` | - |
| Repair a damaged part (missing HP share *m*) | `fabricate x 0.5 x m` | `round(inputs x 0.5 x m)` by largest remainders, at least 1 unit |
| Recycle a part | `fabricate x 0.5` | gives back 50% of its inputs (largest remainders, `scaleBill`) |
| Refine one batch | the recipe's station `time` | the recipe's inputs |

`ticks = ceil(work x 60 / (speed x (1 + 0.6 x packShare)))`. A powered machine's job needs `ticks x rate` eu (`jobEu`,
where `rate` is its part's `PortsLayout.rate`). The core's jobs need `ticks` ticks.

Worked examples (from the data):

- Sparrow T without its core: 60 work seconds to fabricate and 30 to attach. That is **90 s on a Field Fabricator**,
  56 s on a Bay, 36 s on a Forge and **6 minutes on the core alone**.
- A Pip or Ion Drive: 6 s + 3 s. A Hammer: 52 s + 6 s (its station recipe time is 40 s). A Bastion: 416 s + 12 s, which
  only a Forge can make (2.9 minutes).
- A Field Fabricator made by the core: (52 + 6) / 0.25 = about 4 minutes.

### 2.3 Material packs (`data/items.json` `pack`, craft recipes in `recipes.json`, 20 s at a station)

| Pack | Made of (6 units) | Unlock | Value |
|---|---|---|---|
| Hull Pack `pack_hull` | 2 alloy plate, 2 composite sheet, 2 steel plate | starter | 40 |
| Wiring Pack `pack_wiring` | 4 copper wire, 2 insulated polymer | L6 | 35 |
| Optics Pack `pack_optics` | 2 crystal lens, 2 capacitor cell, 2 power coupling | L10 | 150 |
| Mechanism Pack `pack_mechanism` | 2 servo motor, 2 barrel assembly, 2 targeting chip | L12 | 260 |
| Heavy Plate Pack `pack_heavy` | 2 titanium plate, 2 cobalt alloy, 2 hardened steel | L15 | 260 |
| Drive Pack `pack_drive` | 2 fuel injector, 2 thrust nozzle, 2 coil winding | L15 | 300 |

- **In the field** (`packs.ts fieldPay`), each pack pays one unit of one constituent. The fabricator's pack mode (a
  `machine` message, saved in `ShipRecord.field.packs`) decides how packs are used:
  - `off` (default): packs are never used.
  - `fill`: loose materials pay first, and packs cover the rest.
  - `prefer`: packs pay first, for speed.

  The job's `packShare` is the share of its units that packs paid, and it speeds the job by 60% times that share.
- **In the bank** (`bankPay`), loose deposits pay first. Then the pack that pays the most units still owed is opened,
  over and over. An opened pack gives all of its constituents that the part needs, and the rest are wasted (`wasted`).

### 2.4 The repair bank (`bank.ts`, `PlayerProfile.bank`)

| Number | Value |
|---|---|
| Free-part cap | A starter ship's recipe inputs, without the core: **16 alloy plate, 8 copper wire** (`bankCap(econ, starter)`) |
| Refill | Empty to full in **30 min**. Each item refills at its own cap's pace (`refillBank`, by the wall clock). Fractional units are spent only whole |
| Spare for repairs | The whole units above 75% of the cap (`freeSpare`). Only repairs and rebuilds of the ship's own design use it, never new plan parts |
| Deposits | Packs, refined materials and components (`depositable`). Never ore, parts or ammunition. Never withdrawn |
| Passing a station | Within **1500** of any station: deposits heal damaged parts at **10% HP/s** and rebuild a missing part every **2 s**, nearest the core first |
| After a respawn | Deposits rebuild the parts the free part didn't cover, **anywhere**, at a Field Fabricator's pace (speed 1, attach included), until the ship is whole or the deposits can't pay |

---

## 3. Energy: the seam in the ports core (done)

- `PortsLayout.machine[p]` gives a machine part's kind (`MACHINE_FAB` 1, `MACHINE_REF` 2). `PortsLayout.machineDraw` gives
  the total E/s.
- `PortsState.mach` holds bits (`machineBit(kind)`). A machine tool draws its full `rate` on a tick only while its bit is
  set, and nothing otherwise. Its share of what it asked for is `e.sat[p]` (0 to 255). What it got is added to
  `PortsState.machEu[kind]`, a float counter that is never reset.
- A job progresses by the change in `machEu`. Power-starved means slower. So progress is deterministic and identical on
  the server and in the pilot's own prediction. **No progress streams.**
- `setPortsMachine(e, kind, on)`, `portsMachinePart(L, kind)`, `portsMachineEu(e, kind)`. `mach` and `machEu` survive
  `remapPorts` into another design, so a plan save or an attached part does not reset them. `clonePorts` (sim) and the
  own-ship sync (`sim/ownStep.ts` PORTS_ARRAYS) copy them, so the pilot's client gets the server's counter whenever it
  resyncs. The other-guns sync carries `mach`.
- The **server** sets the bit, as "drawing", while the machine is switched on and has a job it can run (materials taken,
  not stalled). It clears the bit otherwise. That is a decision, and it is told to the pilot in `fieldState`
  (`MachineView.drawing`).
- Ships without a machine are unchanged byte for byte (no `fx.machines`, `mach` stays 0).
- **Known gap for package A**: `remapPorts` into a design with a different part count makes the stores full again
  (`fullPorts`). That happens to hangar saves today. A plan save must not become a free refill: see A's brief.

---

## 4. State model

### 4.1 Saved (common, done)

- `ShipRecord.blueprint` is the **live design**: the standing parts, the parts queued for recycling (still standing),
  and the **missing** parts (`ShipRecord.hp[uid] = 0`), planned in the build view or shot off alike. **Invariant: it
  always passes `validateBlueprint(..., { mounting: false })`**. `Pilots.applyShip` resets a ship to the starter if it
  doesn't. `ShipRecord.ghosts` holds only the hangar's and the bank's own placeholders (parts the hangar has no item for
  yet, parts a death left owed); the build view never adds one.
- `ShipRecord.field` (`econ/field/record.ts FieldRecord`) holds:
  - `fabOn` and `refOn`, the switches;
  - `packs` and `recipe`;
  - `recycle`, the uids queued for recycling;
  - `held`, items inside the machines;
  - (old saves only) `waiting`, planned parts an earlier version kept outside the blueprint. The server moves them into
    the blueprint as missing parts, as far as it stays valid, the next time the ship flies (`FieldShips.migrate`); the
    rest are dropped. An old save's field-plan ghosts stay placeholders: they read as missing parts everywhere but the
    flight model.

  Jobs are not saved. On logout a job is called off: its inputs go back to the hold, or into `held` if the hold is full.
- `PlayerProfile.bank` (`RepairBank { free, deposits, at }`) is absent until the server first fills it at login
  (`newBank(bankCap(...), now)`).

### 4.2 Server runtime (package A)

There is one `FieldShip` per pilot ship. It holds each machine's `{ tier, uid, on, drawing, job?: FieldJob, at, holding,
blocked }`. `at` is the machine's clock when the job was last copied out: `machEu` for a powered machine, the tick for
the core. It also holds the claimed uids (a part being built, repaired or recycled has exactly one claimant), a cursor of
`machEu` read last tick, and a job id counter.

### 4.3 Client (package C)

The client keeps a copy of the last `fieldState`. Progress shown is `jobAt(job, at, nowClock)`, where `nowClock` is the
own-ship prediction's `machEu[kind]`, or the predicted tick for the core. The missing parts are simply the blueprint's
parts that aren't standing (`derived.alive`), read from the live ship every frame, so a part shows as built the moment
it is.

The world build view (`client/src/ships/field/FieldOverlay.ts`, edits in `plan.ts`) keeps only the pilot's unsaved
edits (parts added, missing parts dropped, parts marked or unmarked for recycling) and lays them over the live ship each
frame; each edit falls away by itself once the live ship shows it. It draws with the hangar's own part art
(`ships/build/partArt.ts`: `hullPreview2d` colours and `partDecor` hardware, shared with the hangar's canvas through
`drawDecorTo`): built parts are the ship itself, missing parts the real part faded (brighter as the fabricator builds
it), parts marked for recycling outlined red, the part in hand the real part tinted green or red; facing arrows and
shield cover on every part come from `ships/build/buildMarks.ts`. A new part can't go on the cells of a part still being
recycled: place it once that part is gone. The HUD schematic (`field/bridge.ts fieldHudMarks`) shows the part being
built and the parts being recycled from `fieldState`.

The hangar and station windows read the pilot's record instead (the `hangar` message: its design, `ghosts` and
`wrecked`; a missing part shows there as wrecked), so FieldShips sends it again (`FeatureHost.recordChanged`) whenever a
save or refit changes the design, and once the ship is rebuilt with a missing part it built. The repair bank's deposits
building owed ghosts while flying (Pilots.installOwed) still don't resend it.

---

## 5. Job rules (package A implements them with `econ/field`)

1. **Picking the next job** (`order.ts nextFieldTarget`), once a machine is free:
   1. damaged standing parts, nearest the core first;
   2. then recycling (`recycleCandidates`: a part whose removal strands nothing, deepest first);
   3. then missing parts (planned or shot off: the same thing) that join the standing structure, nearest the core first.

   Parts are skipped when the machine can't make them (`canFabricate`, the grade cap), when they are claimed, or when
   they are waiting on materials. Every part of the blueprint that isn't standing is "wanted" (hangar and bank
   placeholders too).
2. **Starting a job takes its inputs from the hold, all or nothing** (`fieldPay` with the pack mode). They then sit in the
   job (`FieldJob.held`). A build whose part item is already in the hold (`partItemId`) takes that instead and starts at
   ATTACH (`need: 0`). Repairs use `repairBill`. Repairs and rebuilds of the ship's own design (any missing part of its
   blueprint, planned or lost; not a hangar placeholder) may also be paid from the bank's free spare (`freeSpare`,
   through the host), after the hold. If nothing can pay, the job is passed over and the
   machine shows `blocked: 'materials'` when nothing else is runnable.
3. **Progress** is `stepJob(job, units)`, where units is the change in `machEu` (powered) or 1 per tick (the core). Builds
   run MAKE then ATTACH, and the rest run MAKE only.
4. **Finishing:**
   - A **build**'s part goes to its spot if that spot is open and joined. Otherwise the orphan rule decides
     (`placeFinished`): another open, joined spot wanting the same item, else the hold.
   - A **repair** sets the part's HP to full (one structural sync).
   - A **recycle** removes the part from the blueprint, puts `recycleReturn` into the hold, and drops the uid from
     `field.recycle`. Its cells are free from then on, for a new part the pilot places there.
   - A **refine** puts its output in the hold.
5. **Hold full**: output that doesn't fit (by volume, `ItemCatalog.volume`) stays in the machine (`holding`, saved as
   `field.held`). The machine stalls (`blocked: 'cargo'`, drawing off) until there is room. A finished part that can go
   onto a missing part's spot needs no room.
6. **On/off** takes effect on the tick the message arrives. Switching off pauses the job, which keeps its progress and
   inputs. `fieldCancel` gives the inputs back.
7. **The refiner**: `recipe` set means refine that recipe while the hold has its inputs. Auto means refine what the
   fabricator's next jobs are short of, from ore in the hold, else nothing. `canRefine` applies the grade cap.
8. **Death**: the machines' `held` items and the jobs' inputs go into the wreck with the cargo (B's `onDestroyed` asks A
   for them through the host).

### 5.1 Saving the build view (`fieldPlan`; `server/src/game/field/plan.ts`)

1. Validate the target as a hangar edit is (`parseBlueprint`, `validate`, licences, build points).
2. For each target part:
   - a part of the live design with the same uid and the same placement (piece, fn, material, x, y, rot, flip,
     facing, mount) stays as it is: standing, missing or placeholder;
   - a part with the same uid but a different placement is a new part with a fresh uid (the old one is recycled if it
     stands, else dropped);
   - a new part is appended **missing** (`ShipRecord.hp[uid] = 0`, no placeholder flag).
3. Standing parts not in the target are queued for recycling. They stay in the blueprint, standing, until broken down.
4. Missing parts not in the target are dropped from the blueprint. If one is being built, its job finishes and the part
   goes to the hold.
5. The result must pass `validate` with the parts being recycled still in it. A new part on their cells (or blocked by
   them) is refused with the reason: place it once the part is gone. The build view refuses the placement the same way.
6. Saving is free. New parts are **appended** at the end of `blueprint.parts`, and removed parts are spliced out only
   when their recycle finishes. The ports state is carried across by part index (`remapPortsByIndex`), so a save is never
   a free store refill.
7. `fieldPlanClear` ("As it stands"): every missing part, planned or lost, leaves the design and the recycling queue
   empties.

---

## 6. Death, respawn and stations (package B implements them with `econ/field`)

1. **Death** (`Pilots.onDestroyed`): the cargo drops as today (secure hold included). The wreck also holds the machines'
   contents and `SALVAGE` (70%) of the built parts' **minerals**, recoverable by flying back. Nothing goes to storage.
   There is no loaner and no insurance.
2. **Respawn** at home, in the **same design**. The core always comes back free. The free part then pays at once, core
   outward (`payCoreOutward` with `bill = partInputs`, `purse = freeWhole(bank)`, and `spendFree`). Parts it couldn't pay
   become ghosts. Deposits then rebuild those ghosts, core outward, anywhere, at `BANK.respawnSpeed` (`bankPay`; a part
   with a shortfall is skipped). Ghosts the deposits can't pay stay missing, for the fabricator, the core, or the free part
   as it refills: each time the free part could pay the next core-outward ghost, it does. An empty bank means a bare core.
   Every part of the design is owed after a death, standing or missing (a part the build view planned included); only
   the hangar's own placeholders are not.
3. **Passing a station** (replaces `repairStep`'s free and paid station repair): within `BANK.stationRange` of any station,
   and not hit for `combatPauseTicks`, deposits heal damaged parts at 10% HP/s and rebuild a missing part every 2 s, paid
   with `bankPay` on the part's `repairBill` or `partInputs`.
4. **A part has one builder at a time.** B's deposit rebuild and passing-by repair skip any uid that A's machines have
   claimed (`isClaimed` through the host).
5. **Station services**: the fast station refinery and fabricator stay as they are (`StationServices`). Packs are ordinary
   `craft` recipes. `bankDeposit` is accepted only at a station, from the hold or storage, and only for `depositable` items.

---

## 7. Protocol (`common/src/network/fieldProtocol.ts`; PROTOCOL_VERSION 63)

These are JSON messages, wired into `ClientMessage` and `ServerMessage`. All of them are decisions or rare events.

| Message | Direction | When | Handled by |
|---|---|---|---|
| `fieldPlan { blueprint }` | C to S | the build view saved: the new blueprint (new parts missing) | A |
| `fieldPlanClear` | C to S | "As it stands": missing parts dropped, recycling stopped | A |
| `machine { kind, on?, packs?, recipe? }` | C to S | a switch changed | A |
| `fieldCancel { kind, job }` | C to S | a job called off | A |
| `fieldRecycle { uids, cancel? }` | C to S | parts queued or unqueued | A |
| `bankDeposit { items, from? }` | C to S | at a station | B |
| `devBank { action, items? }` | C to S | dev server only: `fill`, `empty`, `clearDeposits`, `grant` | B (server), D (UI) |
| `fieldState { tick, machines[], recycle[], short? }` | S to C | something changed: a decision applied, a job started, finished or called off, a stall, a part placed | A sends; C applies |
| `fieldDone { kind, job, item, to, uid? }` | S to C | a part or batch finished: `to` is `ship`, `cargo` or `machine` | A sends; C toasts and plays the sound |
| `repairBank { free, cap, fullIn, spare, deposits, rebuilding? }` | S to C | at login, on a change, and at most once a minute while refilling | B sends; D shows |

- Part attachment and HP (a missing part is hp 0, as one shot off) travel on the existing ship sync (rebuilds, hp, ghosts): no new structural message.
- **Prediction**: the own client steps `machEu` itself, because the ports tick runs in the own-ship sim with `mach` as the
  server set it, and the own sync corrects it. The client never predicts a job start, a finish or a placement. It waits
  for `fieldState` and `fieldDone`. Between those it shows `jobAt`.
- A new client message needs a handler entry. A registers the field messages as the `machines` server feature's
  `messages`. B registers `bankDeposit` and `devBank` in `server/src/net/handlers/bank.ts`.

---

## 8. Profile changes and the migration (package B)

**PROFILE_VERSION 6**, the "field update". It runs in `migrateProfile` for saves below v6: a `was < 6` branch in
`profile.ts` calling `fieldUpdate(out, econ)` in a new `common/src/econ/fieldUpdate.ts`, beside `designUpdate.ts`. The
designUpdate pins (`PROFILE_VERSION` 5) move to 6 deliberately. The bulk tool `scripts/db/designUpdate.ts` reports v6.

- Every `repair_kit`, `field_repair_kit`, `nanite_repair_kit` and `insurance_bond` in storage and cargo is removed, and its
  craft recipe's inputs go into `bank.deposits`. For example, 2 repair kits become 4 alloy plate and 4 copper wire, and an
  insurance bond becomes 6 steel plate and 4 scrap electronics. The bank's free part starts full.
- Loaner records are dropped. If the active ship was a loaner, the pilot's lost ship becomes active, with `lost` cleared
  and its ghosts kept; at login B's respawn rule pays it from the free part. If there is none, they get a fresh starter.
- The quickbar's `repair_kit` slots are cleared. `newProfile`'s starter storage swaps its 2 repair kits for 2 Hull Packs.
- A one-time notice: "Repair kits and insurance are gone: N items moved into your repair bank."
- `ShipRecord.loaner`, `WipeReason 'loaner'` and the `loaner` fields stay readable (old saves), but nothing writes them.

---

## 9. The foundation (committed)

| Area | Files |
|---|---|
| Rules (pure, tested) | `common/src/econ/field/{rules,packs,order,bank,jobs,record,index}.ts`, `field.test.ts` |
| Parts | `scripts/econ/models.mjs` "Field machines" block + recipes → `data/ships/models.json`, `data/recipes.json` models; `FunctionDef.machine` (`ships/types.ts`); `machineCount` rule (`ships/blueprint.ts`); validator keys (`server/src/data/validateGameData.ts`) |
| Feature | `common/src/ships/features/machines/{index,machines,contract.test}.ts` (`fx.machines`, facts); registry regenerated |
| Energy | `common/src/ships/power/ports.ts` (machine tools, `mach`, `machEu`), `portsMachines.test.ts`; `sim/state.ts`, `sim/ownStep.ts`, `sim/otherGuns.ts` carry them |
| Packs | `data/items.json` six packs (`pack` field, `ItemDef.pack`), `data/recipes.json` craft |
| Profile | `PlayerProfile.bank`, `ShipRecord.field` (cleaned in `migrateProfile`; no version bump yet) |
| Protocol | `common/src/network/fieldProtocol.ts`, unions in `protocol.ts`, wire dictionary (+6 models), PROTOCOL_VERSION 63 |
| Client labels | `client/src/ships/modelCards.ts` `FAMILY_LABEL` (Fabricators, Refiners) |
| Pins re-pinned | `server/src/golden/frameHash.golden.json` (version and ports state fields); `client/src/ui/fieldGuide.test.ts` (level 12 now lists the Fabrication Bay) |

---

## 10. The work split

Rules for every package:

- **Branch and git**: work on `refactor/split` in the main tree, or in a worktree from it. Commit only your own files, by
  explicit path, with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never run checkout, restore, stash,
  reset or clean.
- **Never touch** `prototypes/energy-lab/ships.js` or `data/ships/blueprints/dev/gen-gunship-1.json`. Never hand-edit
  `models.json`, `wire-dictionary.json` or `docs/panels/index.md`.
- **The rules are common**: use `@space-game/common`'s `econ/field` functions, and don't re-derive numbers. If a rule must
  change, change it in `common/src/econ/field/*` with a test, and say so in your handoff (other packages read the same
  file).
- **God files** (`GameServer.ts`, `ShipBridge.ts`, `Game.ts`, `Renderer.ts`, `HangarUI.ts`, `protocol.ts`): one-line
  wiring or delegators only.
- **Tests**: run only your own tests plus `npx tsc -p <pkg> --noEmit`, with vitest always at `--maxWorkers=4`. Rebuild
  common (`npm run build:common`) after changing it.
- **Processes**: start no dev servers or browsers unless needed. If you do, avoid ports 3000, 3005, 5173, 5198, 5273,
  5310, 8787, 5390, 5455, 5611 and 8765, and kill what you start, by PID.

Where the packages meet (each side writes its half; integration wires them):

- **A and B**:
  - A's `FeatureHost` gains optional `bankSpare(eid)` and `spendBankSpare(eid, bill)`, which B implements.
  - B's rebuilders call A's `isClaimed(eid, uid)`, and `machineContents(eid)` at death.
  - Both are wired in `GameServer`'s host construction, one line each.
- **A and C**: the `fieldState` and `fieldDone` shapes in `fieldProtocol.ts`. If either needs a field, add it there and
  tell the other.
- **B and D**: `repairBank`, `bankDeposit` and `devBank`.
- **C and D**: both add entries to `client/src/app/serverMessages.ts`. Merge conflicts there are expected and trivial.

### A: server machines

**Owns** (new unless marked):
- `server/src/ships/features/machines/index.ts`, the server half: `serverFeature = { id: 'machines', create(host) }`. It
  has a `tick` for every pilot ship each tick and `messages` for `fieldPlan`, `fieldPlanClear`, `machine`, `fieldCancel`
  and `fieldRecycle`. Then run `npm run features:gen`.
- `server/src/game/field/`:
  - `FieldShips.ts`: per-ship runtime (4.2), picking jobs, starting, stepping and finishing them, stalls, sending
    `fieldState` and `fieldDone`.
  - `plan.ts`: the plan diff (5.1), `waiting`, and the blueprint invariant.
  - `refine.ts`: the refiner's recipe choice.
  - their tests.
- `server/src/ships/features/types.ts`: `FeatureHost` gains what A needs: the pilot's hold (count, take, give, room by
  volume), the econ, `send(pilot, msg)`, the ship record (blueprint, ghosts, field), set the blueprint keeping state,
  set ghosts and part HP, and the optional bank hooks above. The host construction in `GameServer.ts` gets one line each.
- `common/src/ships/power/ports.ts`: only a new `remapPortsByIndex(e, after, keep)`, and its test in
  `power/portsMachines.test.ts`.

**Implement**:
- Sections 3, 5 and 5.1 exactly, with the `econ/field` functions:
  - `nextFieldTarget`, `canFabricate`, `fieldPay`, `packShare`, `jobEu` or `jobTicks`, `stepJob`, `placeFinished`,
    `recycleCandidates`, `recycleReturn`, `repairBill`, `canRefine` and `refineWork`;
  - `setPortsMachine` on the ship's `charge.e` when "drawing" changes;
  - reading `portsMachineEu` deltas each tick.
- Keep `ShipRecord.blueprint`, `ghosts` and `field` in step with the live ship whenever they change. Do it through a host
  call into the pilot's record, not by importing Pilots.
- Export `isClaimed(eid, uid)` and `machineContents(eid): Bag` for B.

**Tests**, in `server/src/game/field/*.test.ts` with a small GameServer or bridge fixture like
`server/src/game/tow.test.ts`:
- a ship with a Field Fabricator and plates in the hold rebuilds a destroyed Pip: MAKE then ATTACH, and the tick counts
  match `jobEu` at full power;
- half power takes twice as long;
- off means no draw and no progress;
- the core alone builds a Pip at a quarter speed with no generator;
- the grade cap is refused;
- the hold full stalls with the output kept, and it resumes when room is made;
- the orphan rule: own spot, another spot, the hold;
- recycling returns `recycleReturn`, goes leaf first and never strands a part;
- a plan save is free, keeps standing parts, queues removals and appends ghosts, and the live blueprint stays valid;
- packs in `fill` and `prefer` modes pay one unit each and go faster;
- no `fieldState` is sent on ticks where nothing changed (no streams).

**Don't touch**: `Pilots.ts`, `Hangar.ts`, `bridge/rebuild.ts`, `StationServices.ts`, profile migration, any client file,
`items.json` or `recipes.json`.

### B: server bank and stations

**Owns**:
- New: `server/src/game/RepairBank.ts` (per pilot: fill at login, refill, `spare`, `spendSpare`, `deposit`, respawn
  rule, the deposit rebuild after a respawn, passing-by repair), `server/src/net/handlers/bank.ts` (`bankDeposit`,
  `devBank` refused unless the server is a dev server: use the same flag `freeBuild` or `shipEditAnywhere` use, never
  production), `common/src/econ/fieldUpdate.ts` (v6) and its test, and `scripts/econ/retireKits.mjs` (a one-off rewrite of
  drops, vendors and quest rewards; run it and commit the data).
- Edits:
  - `server/src/game/Pilots.ts`: `onDestroyed` without loaners and insurance; no `grantStarterBonds`; the kit branch of
    item use goes; `capture` writes `rec.ghosts` from the live ship; `payRepair`, `payRebuild` and
    `freeRebuildBelowLevel` go; the `repairBank` message is sent.
  - `server/src/game/Hangar.ts`: the loaner paths go.
  - `server/src/ships/bridge/rebuild.ts`: `repairStep` becomes deposit repair near stations, and `startRepairKit`,
    `stepRepairKits`, `repairKitLeft` and `needsRepair` go, with their one-line delegators in `ShipBridge.ts`,
    `bridge/core.ts` and `bridge/flight.ts`.
  - `server/src/GameServer.ts`: host wiring lines only.
  - `common/src/econ/profile.ts`: PROFILE_VERSION 6, the `was < 6` branch, the starter kit and quickbar.
  - `common/src/econ/designUpdate.ts`: the loaner paths stop writing loaners.
  - `data/items.json` and `data/recipes.json`: remove the kit and bond items and recipes (with
    `econ/retired.ts`-style cleanup so old ids in saves don't break), with the mapping
    `repair_kit`→`pack_hull`, `field_repair_kit`→`pack_wiring`, `nanite_repair_kit`→`pack_optics`,
    `insurance_bond`→`pack_mechanism` in drops (`bosses.json`, `factions.json`), quests and vendors.
  - `common/src/network/econProtocol.ts`: remove `loaner` from `HangarSlotView` and remove `ServerRepairKitMessage`.

**Implement**: sections 2.4, 6 and 8, with `bankCap`, `newBank`, `refillBank`, `freeWhole`, `freeSpare`, `spendFree`,
`bankPay`, `spendDeposits`, `depositable`, `depositInto` and `payCoreOutward`. Respawn uses the same design. Deposits
after a respawn work at `BANK.respawnSpeed`, using `jobTicks(fabWork + attachWork, 1)` per part. Skip uids claimed by A.

**Tests**:
- the bank fills at first login and refills by the clock;
- a death means no loaner, the same design back, and the free part pays core outward;
- an empty free part means a bare core;
- deposits rebuild the rest over time and never pay instantly;
- passing near a station heals from deposits;
- there is no free station repair;
- `bankDeposit` is refused away from a station and for non-depositable items;
- `devBank` is refused on a production server;
- migration v6: kits and bonds become deposits, loaners go, it is idempotent, and junk never throws.

Update the existing tests whose behaviour intentionally changes (insurance, loaners, kits, station repair:
`server/src/game/devShip.test.ts`, `solRegions.test.ts`, `ships/shipEdit.test.ts`, `designUpdate.test.ts`,
`models.test.ts` version pin, `economy.test.ts` if it uses kits) and say which in the handoff. Don't weaken any other.

**Don't touch**: `server/src/game/field/*`, `server/src/ships/features/machines/*`, `ports.ts` and client files.

### C: client field

**Owns**:
- New: `client/src/ships/features/machines/index.ts`, the client half (`clientFeature`: `actions` for the build overlay
  key and the fabricator and refiner toggles, `onKey`, `indicator` for the HUD chip, `drawShip` for planned and building
  parts). Then run `npm run features:gen`.
- New: `client/src/ships/field/`:
  - `FieldOverlay.ts`, the world-space build overlay on the live game: it switches to the helm view, zooms in, and
    places and removes planned parts against the live ship, reusing the hangar's palette and geometry modules
    (`HangarPalette.ts`, `paletteModel.ts`, `blueprintApi.ts`) **by import, not by editing HangarUI.ts**. Save sends
    `fieldPlan`. Standing parts can be marked for recycling. Clear sends `fieldPlanClear`.
  - `FieldHud.ts`: each machine's on/off, its tier, the job and its progress through `jobAt` on the predicted clock,
    "Output blocked: cargo full", "Short of materials", "Needs a better fabricator", and the pack mode and refine recipe
    pickers.
  - `fieldState.ts`: applies `fieldState` and `fieldDone` and keeps the client copy (4.3).
  - their tests.
- Edits: one line each in `client/src/app/serverMessages.ts` (`fieldState`, `fieldDone`, and remove `repairKit`), the
  key bindings through the feature's `actions` (no edit to `keybindings.ts` beyond what the registry merges), one-line
  mounts in `Game.ts` or `Renderer.ts`, and the HUD's repair-kit bar removed (wherever `repairKit` is drawn).

**Implement**: section 4.3 and the overlay. Planned parts are drawn as ghosts: translucent, with a build-progress fill on
the one being built, and a red outline on parts queued for recycling. Zoom and the helm switch are restored when the
overlay closes. The ship keeps flying with the overlay open, and the overlay never blocks flight input (no fire or input
delay). Copy is plain and short.

**Tests**:
- the client copy applies `fieldState`, and `jobAt` progress follows the predicted `machEu`;
- the overlay's plan diff produces a valid blueprint (appended ghosts, removals as recycle);
- HUD strings for each `MachineBlock`;
- the client feature contract (`client/src/ships/features/contract.test.ts`) passes.

**Don't touch**: server files, the bank and station UI (D), `HangarUI.ts` beyond one line, and `common/src/econ/field`
(ask A instead).

### D: client station, bank and dev tools

**Owns**:
- New: `client/src/ui/station/BankPanel.ts`, the bank tab: free part as a bar with "full in", spare, deposits, and
  deposit from the hold or storage (`bankDeposit`), with plain copy.
- New: `client/src/ui/station/packs.ts`: the pack crafting list (ordinary `craft` messages), with what each pack holds
  and the one-unit and all-units note.
- Edits:
  - `client/src/ui/StationWindow.ts`: mount the bank tab, the "loaner" status text goes, and the station shows fast
    refine and fabricate as today.
  - `client/src/ships/HangarUI.ts`: one-line removals of the loaner and insurance lines only (the "Loss cost" row's
    insurance note).
  - `client/src/ui/fieldGuide.ts`: the "Losing a ship" section rewritten for the bank, and new sections for field
    machines and packs.
  - `client/src/ui/itemIcons.ts`: pack icons.
  - `client/src/ui/AdminPanel.ts` and `AdminGive.ts`: dev-only bank buttons (fill, empty, clear deposits, grant a pack
    kit), sent as `devBank`, shown only when the server says it is a dev server.
  - `server/src/game/AdminTools.ts`: `/bank fill|empty|clear|grant` commands calling B's `RepairBank` (dev only).
  - one line in `client/src/app/serverMessages.ts` (`repairBank`).
  - `client/src/ui/Tutorial.ts`, if it mentions repair kits.

**Implement**: the station side of sections 2.4 and 8, from the player's view. Show the free part and deposits apart.
No lore. Copy is plain and short.

**Tests**:
- the bank panel renders from a `repairBank` message;
- deposit buttons only offer `depositable` items;
- the field guide's text has no "insurance" or "loaner";
- the admin bank buttons are hidden unless on dev;
- `fieldGuide.test.ts` and `componentGuide.test.ts` stay green (update their pins only where this design changes the
  text).

**Don't touch**: server files except `AdminTools.ts`, the field overlay and HUD (C), and `common/src/econ/field`.

### Integration (after A to D)

1. Wire the A and B host hooks in `GameServer` (one line each).
2. Run `npm run features:gen`, `npm run build:common`, tsc for `common`, `server` and `client`.
3. Run the full vitest suite once at `--maxWorkers=4`.
4. Re-pin goldens only for intended changes: `UPDATE_GOLDEN=1` on `server/src/golden/frameHash.test.ts` if the death or
   respawn flow touches the scenario.
5. Smoke-test on the local dev server: build a Field Fabricator from a bare core, rebuild a destroyed part in flight,
   recycle a part, fill the hold to see a stall, die to see the bank respawn, then deposit packs and fly past a station.

---

## 11. Knobs to playtest

| Knob | Current value |
|---|---|
| Pack field value | 1 unit (Kieran: "we'll adjust after you've played with it") |
| Pack speed bonus | 60% |
| Draws | 40 / 70 / 110 for the fabricators, 20 / 35 / 55 for the refiners |
| Core speeds | 0.25 fabricating, 0.2 refining |
| Bank refill | 30 min |
| Spare share | 25% |
| Station pass | range 1500, 10%/s heal, a part every 2 s |
| Recycle | 50% back, in half the time |
| Repair cost | half, by the HP missing |
| Attach | 3 s a cell |
