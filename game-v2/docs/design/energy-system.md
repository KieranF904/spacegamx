# Energy system: a discussion draft

*Status: for discussion with Kieran, 2026-10-31. Phases 1 (local circuits) and 2 (Steady and Surge) are built: see the "Implemented" sections below; the rest is the draft. Part names, power-type names and numbers are
placeholders. Sibling doc: docs/design/build-archetypes.md (this one builds on its §3.1 "Energy with shape").*

Kieran's brief, in short: batteries and generators are "just placed somewhere and they'll probably connect". He wants
placement and structure to have an effect, almost like a circuit with logic. Ideas he floated: generators that make
different **types** of power, power type changing what a weapon or thruster does, **multi-input** parts fed two types,
**type-locked** parts, and types that need **fuel**.

**Short version of this doc:**
- Today the wire network decides only *whether* a part is powered, never *how well*. All stored energy is one
  ship-wide pot (three pots, by use), so where a battery sits doesn't matter once it's connected.
- Four proposals, smallest to largest: **A. Local Circuits** (each circuit keeps its own charge, stores have a
  discharge rate, circuits brown out), **B. Power Types** (Steady, Surge, Thermal, later Exotic, with one reaction table
  and dual-fed parts), **C. Circuit Board** (cable grades, converters, breakers, diodes, switches and relays), and
  **D. Hot Layout** (heat that spreads between parts, with radiators on the edges).
- **Recommended path:** build A first, plus one rule borrowed from B: *capacitors only discharge into what they touch*.
  That alone makes placement matter and stays easy to read. Then add **Thermal** power (fuel and heat, tied to the
  warmth meter) and the first dual-fed parts. Then breakers, shock damage and a pilot "divert" switch. Exotic power
  and simple relays come last, if at all. **Avoid:** losses over distance, bonuses for lining generators up, free-form
  logic programming, and per-cell heat simulated every tick.

---

## Implemented (Phase 1): local circuits

*Built 2026-10-31, awaiting review, not deployed: proposal A plus the touch-only capacitor rule (§4 Phase 1), with its
hangar UX (§6.1 letters, §6.2 load test, §6.3 warnings and weak links) and per-circuit HUD bars. No heat, no Thermal,
no power types: nothing here touches the warmth system. The rest of this doc is the original draft.*

**Where it lives.** `common/src/ships/circuits.ts` works out the layout once per rebuild (circuits, store groups,
banks, feed groups, the core's store); `common/src/ships/energy.ts` runs the tick over it (O(circuits + feed groups +
stores), no part loops but the guns' and thrusters' own); `rebuild.ts` calls it in one delimited block
(`ShipDerived.power`). Server: `ShipBridge` passes the guns' load into the flight step and remaps the charge on every
rebuild. Client: the pilot predicts the same steps (`ShipClient.predict`, `predictGuns`).

### The rules as built

- **A circuit is a wire network** (wires.ts, unchanged). Its generators' spare (after its steady loads) streams to its
  own consumers first, then charges its own stores. Spare never crosses circuits.
- **Stores are grouped per circuit by label**, as before: general (Battery, Heavy Bank), drive (Drive Cell, engines
  only), weapon (legacy weapon battery, guns and mining lasers only). Each group gives at most the sum of its parts'
  discharge rates. A store on a circuit with no generator now counts (it starts full and never refills); before, it
  didn't count at all.
- **Per tick, per circuit:** engines first (stream, then drive pool, then general pool), then guns and mining lasers
  (what's left of the stream, then weapon pool, then general pool). Then each capacitor bank tops up the consumers it
  touches, then the core's trickle tops up what's still short elsewhere. What a circuit can't give, everything on it
  lacks in the same proportion: a **brownout** (`BROWNOUT` = below 99.5%).
- **Guns draw while they reload** (a decision, not in the draft). A shot's energy is spread over its reload: a gun
  reloading on a browned-out circuit reloads at the circuit's share, so it cycles slower; a loaded gun always fires its
  shot. Energy per shot is exactly what it was (draw × interval). Per-shot packets couldn't work with discharge caps (a
  big gun's packet would never fit in one tick's allowance). Held beams burn that share of the ticks; pulse lasers
  recharge like guns; mining lasers draw while their pulse runs and don't start (or stop) when their circuit can give
  nothing. The guns' load reaches the flight step from the ship's cooldowns (`gunLoad`), one tick behind, which is
  invisible.
- **Engines:** every engine draws while you thrust, as before, and each pushes at its own circuit's share
  (`thrustShare`; the core's maneuvering push is its own and never short). Drawing only for engines pushing the way
  you're going is supported (`PowerUse.dir`) but **not used**: it changed big ships' energy enough to change the
  autopilot's braking (a Galleon turned round three times), so flight keeps the old rule.
- **Capacitors** (models.json `bank: true`): capacitors touching each other are one bank. It charges from the circuit
  its first wired capacitor is on and gives only to the engines, guns and mining lasers it shares an edge with, as a top
  up after their circuit (so a bank stays full until the circuit can't keep up). A consumer touching two banks uses the
  first. An unwired bank still gives what it holds but never recharges. Legacy weapon batteries stay wired stores.
- **The core's store** (240) sits on the **main circuit** (the one making the most power; then holding the most; then
  the first), letter A. There it is part of the general pool: the pool's batteries and the core give together, each in
  proportion to what it holds (so they run dry together, as the one ship-wide pool did) and each within its own rate.
  It recharges only from the main circuit. To every other circuit, and to engines, guns and mining lasers wired to
  nothing at all, it trickles 12/s in total, shared by what each is short. So an unwired or cut-off part limps.
- **Steady loads** (shields, scanners, jump coils, the Stabiliser Anchor) are unchanged: shared out of their own
  circuit's generators at the rebuild, before any of this.
- **Damage:** a lost part splits circuits at the rebuild as before; `remapCharge` gives each new store group the
  capacity-weighted charge its parts held, so each half keeps its share and joined circuits pool theirs. A mended
  store comes back empty. A ship body that gets a new design (refit, swap) starts every store at the old ship's overall
  percentage.
- **Wave 2 hook:** `Circuit.type` (always `'steady'` now) is where a per-circuit power type goes; the layout already
  treats a circuit as the unit (letters, stores, feeds), so Steady/Surge can be added without reshaping it.

### Numbers

| Store | Holds /cell | Gives /cell /s | Empties at full rate in | Draft placeholder |
|---|---|---|---|---|
| Battery | 200 | 600 | 0.33 s | 30 |
| Heavy Bank | 300 | 450 | 0.67 s | 15 |
| Drive Cell (engines only) | 320 | 1,400 | 0.23 s | 60 |
| Capacitor (only what it touches) | 160 | 2,000 | 0.08 s | 200 |
| Core store (main circuit) | 240 total | 720 total | 0.33 s | 12 |
| Core trickle (every other circuit, shared) | | 12 total | | (same) |
| Legacy batteries (no `discharge`) | | general 600, drive 1,400, weapon 900, bank 2,000 | | |

Data: `discharge` per model in `scripts/econ/models.mjs` → `data/ships/models.json`; `coreDischarge`, `coreTrickle`
and the legacy defaults in `data/ships/tuning.json` `energy`.

**Why the rates are far above the draft's.** Boosting drains a big ship's stores at 0.5 to 1.8 times their capacity
a second (engine draw × 3.7 when boosting): the Galleon asks 1,751/s more than its five Fusion Plants make, the Hauler
1,161/s, the Bulwark 128/s from the core alone. With the draft's numbers every library ship's boost (and the Bulwark's,
Corsair's and Drum's, whose only store is the core's) would have browned out at once. So the rates are set to the
largest library need with margin, and the shapes are kept relative to size: a Heavy Bank gives 1.5× its capacity a
second, a Battery 3×, a Drive Cell 4.4×, a Capacitor 12.5×. What still browns out: big engines or many guns on a
circuit fed by stores alone, or by a Heavy Bank against a weak generator (the Galleon without its Fusion Plants:
engines and guns together ask 2,713/s of a bank and core giving 2,520/s), circuits with no generator once dry, and
anything on the trickle.

### Migration and the library

Auto-wired designs (every library ship, every enemy, old designs) are one circuit with the core's store on it, so
they behave as before except for the rates. `common/src/ships/circuits.test.ts` flies every library ship, the dev guest
ships and the starter through a scripted 40 s fight (thrusting throughout, a 1.5 s boost every 6 s, every gun firing
as the aim sweeps round) twice, once with these rates and once with stores that give without limit, and asserts the
rates never cut what the old pools would have given while the ship still had over 5% of its charge. Result: **0
rate-limited ticks on every ship**. The starter (Sparrow T) and the dev guests never brown out at all. Ships that run
flat by boosting 1.5 s at a time (Galleon, Hauler, Ark Tender, Lancer, Hammerhead, Bastion, Bulwark: 94 to 263 of
2,400 ticks) do so identically with unlimited stores: that's boosting until empty, as before. Hand-wired designs that
already split their power may now starve a circuit; the hangar says so, and the trickle keeps it limping.

### Protocol (14)

The pilot's own snapshot row: `data[1]` the whole charge (the ENERGY gauge), `data[10]` the core's store,
`data[11]` how many store groups follow, `data[16…]` each group's charge (hundredths of a percent; at most 24).
`packCharge` / `unpackCharge` in energy.ts. Nobody else's row carries charge. (The Stabiliser Anchor's `data[14]`
and `[15]` sit between.) `PROTOCOL_VERSION` 13 → 14, one bump for both changes; the wire-table hash didn't change.

### Hangar and HUD

- Power panel: each circuit by letter and colour (grey: no generator) with generators, stores, spare per second,
  what it holds and can give; the core's store line; **Load test** buttons (Fire, Boost, Both: 4 s from full, the
  ship's own code) with a verdict per circuit ("browns out after 1.2 s: engines 62%, guns 0%", "refills in 6 s",
  "never refills") and each browned-out part's share on the overlay; warnings for stores with no generator, capacitors
  touching nothing that draws power, unwired parts on the trickle; and **weak links** (every non-generator part a live
  wire runs through whose loss cuts consumers off from every generator; listed apart from the warnings, since every
  auto-wired tree has them, and marked ✂ with the Wires tool).
- Overlay: a letter badge on each circuit; trickle-fed parts amber, idle capacitors grey.
- Part tooltips: its circuit (and "main"), what a store gives a second, a capacitor's bank and what it feeds; the
  core's store and its two rates. Model cards: "gives N/s" (and "by touch").
- HUD: a thin bar per circuit with stores, plus the core's (◆), beside the ENERGY gauge; a circuit browning out
  flashes red. Hidden when there's only one store to show.
- Field guide: Energy rewritten, and a new **Circuits** section (circuits, discharge, brownout, the capacitor rule,
  the core's store, splits, the load test and weak links).

### For Kieran to decide

1. **Guns draw while reloading** instead of paying per shot. Same energy per shot; the difference is that a loaded gun
   always fires its first shot, even on an empty circuit. OK?
2. **Rates are high** (above). The library rule forces it while boosts drain big ships this fast. If you want Heavy
   Banks to feel truly slow, the lever is the boost draw (`energy.boostDraw` 2.8), not the rates.
3. **Direction-aware engine draw** (only engines pushing your way draw) is built but off. Turning it on makes
   strafer circuits matter more but needs the autopilot's braking retuned.
4. **The main circuit** is the one making the most power, not the one the core is wired into (the core usually isn't
   wired into anything: auto-wire doesn't route through it). Fine?
5. **Stores on a circuit with no generator** now count and start full (they never refill). Before, they counted for
   nothing.
6. A gun's stagger wait (railguns, missiles, pulse lasers rippling) counts as reloading, so it draws a little extra
   before a group's first ripple. Small; worth knowing.


## Implemented (Phase 2): power types, Steady and Surge

*Built 2026-10-31, awaiting review, not deployed: B1 (two types only), B3 (the reaction table's Surge column for guns,
engines and shields), B5 (two dual-fed parts) and the Pulse Dynamo. No Thermal (it's tied to heat), no Exotic, no
heat or warmth coupling. Phase 1's open questions were answered: a loaded gun fires its first shot on an empty
circuit; the rates stay; engines draw whichever way they push (direction-aware draw stays off); the main circuit is
the strongest; stores on a generator-less circuit count and never refill.*

**Where it lives.** `common/src/ships/surge.ts` (new: the reaction rules, `POWER_TYPES`, `surgeTuning`),
`circuits.ts` (banks: Pulse Dynamos, Surge output, shields touched, labels), `energy.ts` (a bank's dynamo output in
the tick). Hooks: `guns.ts` (charged shots, the Rail Driver), `flight.ts` (kicks), `ShipBridge` (the Rail Driver's
pierce on the shell, the flash restore on a broken shield).

### The rules as built

- **Two types.** A wired circuit carries **Steady** (`Circuit.type`). **Surge** never travels along wires: it belongs
  to a **bank** (`StoreGroup.type 'surge'`, labelled S1, S2...). Capacitors and Pulse Dynamos touching each other are
  one bank, and it gives only to what touches it, as in Phase 1.
- **Pulse Dynamo** (`models.json surge: 8`, per cell per second). **Decision: it is part of the bank it touches**
  (the simpler rule to read: "Surge parts that touch are one bank"). It's on no wire network (it isn't a `produce`
  generator, so touching it plugs nothing in, and Auto-wire ignores it). Its output first feeds what its bank touches,
  then charges the bank. Alone, it powers what it touches directly. A damaged one makes less (the health curve).
  Unlock **L18** (band L16–23), titanium, 1 cell, uses the battery look in violet.
- **The reaction table** (one line per category, never per model; `surgeReaction`). A part fed Surge also still runs
  on its Steady circuit; Surge only adds:

  | Category | Fed Surge by touch | Numbers (`tuning energy.surge`, defaults in surge.ts) |
  |---|---|---|
  | Projectile guns | **Charged shot**: after a pause, the shot takes a packet from the bank and hits harder | loaded and idle ≥ 30 ticks; ×1.5 damage; packet 3 × the shot's energy |
  | Engines | **Kick**: while boosting, a dash, a packet each | every 20 ticks; 12 ticks of the kicking engines' full thrust at once; packet 2 × their draw over those 12 ticks |
  | Shields | **Flash restore**: when the shield breaks, the fullest bank touching a shield generator puts some back at once | 50% of the shield; 4 energy per shield point |
  | Beams, pulse lasers, mining lasers, utility | nothing yet | |

- **Dual-fed parts** (`FunctionDef.dual`):
  - **Rail Driver** (`dual: 'rail'`, L29, the Spear's frame and numbers). Steady holds its rails: off a wired circuit it
    doesn't fire. Its bank sets every slug's power: ×0.7 with an empty bank (or none) up to ×1.5 full. A full bank
    (≥ 98%) also adds +1 pierce and is emptied; otherwise a shot takes 30% of the bank's capacity.
  - **Flash Screen** (`dual: 'flash'`, L13, a Deflector with shield 36 per cell): its bank puts **all** of the shield
    back when it breaks (any shield touching a bank with a Flash Screen on it).
- **Charge and prediction.** Packets come out of the bank's share of the charge (`Charge.s`). Charged shots, Rail
  Driver shots and kicks are worked out the same in the pilot's prediction (the kick needs the tick: the flight step's
  `boost.tick`). Flash restores are the server's alone, like shields; the next snapshot corrects the pilot's bank.
- **Not done (and why).** The Rail Driver's "much faster" slug and a charged shot's look: both would need a field in
  fire events (other clients build every shell from those), so only damage and pierce changed, server-side. Kicks from
  other pilots' ships show when the server's keyframe corrects their replica, as boosts on an empty battery already do.

### Hangar, HUD and guides

- Colour is the type: Steady circuits cyan `#18b4d0` (grey with no generator), Surge banks violet `#b57cff` with their
  label and a zigzag "arc" to every part they feed by touch. The POWER panel lists each bank (what it feeds, holds and
  makes). A Pulse Dynamo whose bank touches nothing gets a warning; a capacitor's status follows its bank.
- Tooltips: an **On Surge** line for every gun, engine and shield (its reaction, with numbers, and "fed by S1" or "no
  bank touches it"); the dynamo's output and bank. The load test runs as before (it doesn't fire reactions).
- HUD: each Surge bank its own violet bar (S1...), beside the Steady circuits' and the core's.
- Field guide: a new **Surge** section. Model cards: the three new parts' trade-offs, "+8 surge, by touch".

### Protocol

Unchanged (still 14): a bank's charge already travels in the store groups, and everything else is worked out from it
or on the server. No wire change, no bump.

### Tests

`common/src/ships/surge.test.ts`: dynamo bank membership and wireless charging, a lone dynamo powering a gun, the
reaction table, charged shots in bursts, flash restore (50%, Flash Screen 100%, none without a bank), kicks (and none
without a bank), the Rail Driver (full bank ×1.5 + pierce and emptied, no bank ×0.7, no fire off a wired circuit).
The Phase 1 library fight is unaffected (no library or enemy design has a capacitor).

### For Kieran to decide

1. The numbers above (×1.5 charged shot, kick every ⅓ s, 50% flash) are first guesses for playtesting.
2. Beams, pulse lasers and mining lasers have no Surge reaction yet (the doc's "pulse" for beams).
3. A charged shot and the Rail Driver's full-bank slug look like any other shot (a visual would need a protocol bump).

---

## 1. Diagnosis: why placement doesn't matter today

### 1.1 What exists (more than you might think)

The parts redesign (docs/parts-redesign.md §4) already replaced conduit blocks with a **wire overlay**, and it is a
real network:

| Mechanism | Where | What it does |
|---|---|---|
| Wire segments between neighbouring cells | `Blueprint.wires`, common/src/ships/wires.ts | Drawn by hand in the hangar or laid by **Auto-wire**. Cost: one `wire_spool` per 4 segments. |
| Networks | wires.ts `wireNetworks` (union-find) | Live segments join into networks. A part joins every network that has a wire node inside it, so **a part bridges networks**. A part **touching a generator** is plugged in with no wire at all. |
| Damage | wires.ts | A segment is live only while intact parts cover both its cells. Destroy the block under a wire and the wire is cut there. |
| Auto-wire | wires.ts `autoWire` | A shortest-path **tree** from the biggest generator out to every power part. Used for enemies, old designs and the hangar button. |
| Hangar overlay | client/src/ships/wireEdit.ts, ShipRenderer `drawWires` | Each network in its own colour, cut wires dark, plus warnings like "Pip on the left wing has no power". |
| Steady loads per network | rebuild.ts step 4, `allocateFlow` | Shields, scanners and jump coils share **their own network's** generator supply by priority. |

So the structure for "circuits" is already there: networks, cutting, an overlay, a wire tool and a cost.

### 1.2 What the network actually decides (evidence)

rebuild.ts step 4 and energy.ts:

1. **Engines, guns and mining lasers are on or off.** `satisfaction[i] = powered || stored ? 1 : 0`. If their network
   has *any* generator or *any* battery, they run at full. Then they draw from the ship-wide pools.
   - Result: a gun on a little island with one battery and no generator fires from **the whole ship's** stored
     energy.
2. **Batteries are ship-wide once counted.** A store counts only if its network has a generator
   (`networks[network[i]].powered`), but once it counts, its capacity goes into one of three ship-wide pools
   (`batteryMax`, `driveMax`, `weaponMax`).
3. **Spare power is summed across networks.** `spare += Math.max(0, supply - delivered)` for every network, and the
   total charges every pool (energy.ts `powerTick`). A reactor on network 1 charges the battery on network 2.
4. **The core's battery needs no wiring.** `batteryMax = hasCore ? coreCapacity (240) : 0`.
5. **Stores have no discharge rate.** `spend()` takes any amount instantly if it's held. A full bank can pay for every
   gun firing on the same tick. Ten capacitors and ten batteries behave the same apart from which pool they fill.
6. **Wires have no capacity, loss or grade.** A 20-cell run is as good as one cell. Length costs a few spools of
   copper and adds a bit of exposure to damage.
7. **The only "how well" effect** is steady loads sharing their own network's generator output. In practice it's a
   trap rather than a choice. A shield on a network with a weak generator runs under-powered while another network's
   spare goes into batteries the shield can't use.
8. **Material leftovers.** Conductive gun material gives a ×1.15 fire rate (`CONDUCTIVE_RATE`). The electromagnetic
   hazard tolerance still counts `fn === 'conduit'` parts, which are legacy now: modern ships have none, so that term
   is dead.

**Damage is the one place topology bites, and players can't see it.** Auto-wire builds a tree, and a tree has no
redundancy: cut one segment near the root and everything past it goes dark. That's a real placement effect, but the
hangar never shows it ("this cell is a single point of failure for 3 guns"). So players don't design around it.

### 1.3 What players optimise today

- **Totals:** generation ≥ steady loads + cruising engines; then as much storage as fits.
- **The pool split:** general vs drive-only vs weapon-only. A Capacitor (160/cell, guns only, light) is basically a
  smaller battery with a label.
- **Reactor choice by output per cell against blast and fragility:** Cell 35, Isotope 18 (never explodes), Fusion 48
  (heavy), Overclock 62 (fragile, biggest blast). Placement thinking stops at "keep the reactor away from the core
  and the outside".
- **Then press Auto-wire.**

The archetypes doc says the same thing in one line: *"more generation and more storage are always better"*. Nothing
makes a burst-shaped ship different from a sustained-shaped one.

---

## 2. Design goals

| Goal | Test question |
|---|---|
| **Placement and topology matter** | Can two ships with the *same parts list* behave noticeably differently because of layout? |
| **Readable at a glance** | Can a player look at the hangar's power view and say what will brown out, and what dies if a given cell is shot, without opening a spreadsheet? |
| **Depth without spreadsheet hell** | Can the core rules fit on one card? Are reactions **per category** (guns, engines, shields), not per model? |
| **Supports varied builds** | Does each archetype (Dancer, Alpha Striker, Freighter, Bombard, Bulwark, Pathfinder...) get a *different best layout*? |
| **Server-authoritative and cheap** | Is topology worked out in `rebuild()` (only when a ship changes), with per-tick work O(circuits)? Can the pilot's client predict it with the same code? |
| **Works with damage** | Does losing a part change the network in a way the pilot feels and can plan for (isolation, shock, brownout), not just "slightly fewer numbers"? |
| **Migration-safe** | Do existing ships and blueprints keep flying, with nothing a player owns becoming useless? |

---

## 3. The proposals

Shared vocabulary. A **circuit** is one of today's networks: what live wires and touching join. A **source** is a
generator. A **store** is a battery, bank, drive cell or capacitor. A **consumer** is anything with `demand`. A part's
**feed** is what powers it.

### Proposal A: Local Circuits ("power is where you put it")

*Effort S–M. The smallest change that makes placement matter.*

**Rules**

- **A1. Each circuit keeps its own charge.** Stores on a circuit fill from that circuit's generators and serve only
  that circuit's consumers. Spare power doesn't jump between circuits. (Today's three pools stay as a *label* on
  each store: a Drive Cell on a circuit still serves only that circuit's engines.)
- **A2. Every store has a discharge rate** (energy per second it can give). This is the archetypes doc's "single
  biggest lever":

  | Store | Capacity /cell | Discharge /cell /s (placeholder) | Shape |
  |---|---|---|---|
  | Battery | 200 | 30 | all-rounder |
  | Heavy Bank | 300 | 15 | deep and slow: endurance |
  | Drive Cell | 320 | 60 (engines only) | made for boosting |
  | Capacitor | 160 | 200 (**only into parts it touches**, see A4) | empties in under a second: alpha |
  | Core battery | 240 | 12 (any circuit, see A5) | slow universal reserve |

- **A3. Brownout.** Each tick a circuit can deliver *generator stream + the stores' discharge rates* (stores only
  while they hold charge). Steady loads take their share first, as now. If the burst consumers want more than is
  left, they all run at the ratio, in priority order: engines first by default, as today. Guns reload slower, engines
  push less, and lasers dim. A brownout is a state you can see, not a hidden number.
- **A4. Capacitors discharge only into what they touch.** A capacitor charges from the circuit it's wired to (at its
  circuit's spare), but its fast discharge goes only into consumers that share an edge with it. Touching capacitors
  form one **bank** that pools its charge. This is the placement hook for burst builds: the bank must sit against the
  guns or thrusters it feeds.
- **A5. The core is a slow universal reserve.** Its built-in battery feeds any circuit at a trickle (12/s here). An
  unwired or cut-off part still limps instead of going dead. That keeps old designs and badly damaged ships playable.
- **A6 (optional). Generators feed the circuit they're on**, as today. Plugging in by touch stays.

**What placement now changes**

- **Splitting is a real choice.** One big circuit shares every store, so it's efficient, but a full volley browns out
  your engines mid-dodge. Separate circuits (engines on one, guns on another) never starve each other, but a reactor
  idling on the gun circuit can't help the engines. Neither is simply better.
- **Capacitor banks have a place,** against the guns, which competes with armour and mounting rules (attach edges,
  clear lanes) for that space.
- **Battery type matters by shape, not size.** Heavy Banks for Freighters, Capacitors for Alpha Strikers, Drive Cells
  for Interceptors.
- **Damage:** losing a circuit's reactor drains only that circuit. Losing a capacitor bank loses that gun's alpha,
  not the whole ship's.

**Evaluation**

| | |
|---|---|
| Depth | Moderate. Three ideas: circuits, discharge rates and touch-fed capacitors. They interact well. |
| Readability | High. Circuits are already coloured in the overlay. Brownout is one red flash per circuit. |
| Build variety | Good. It separates burst-shaped from sustain-shaped ships (Alpha Striker, Blinker, Dancer, Bulwark, Freighter). |
| Server cost | Small. Circuits and rates are worked out in `rebuild()` (already per network). Per tick: a loop over circuits, typically 1 to 4. The pilot's `Charge` grows from 3 numbers to one per circuit (cap it at 6 sent; send one byte each). Replicas don't need charge. |
| Migration | Auto-wired ships (enemies, old designs) are trees from one generator, so they're one circuit and behave as now, except for discharge caps. Hand-wired multi-network designs may now starve one island. The hangar flags it and the core reserve keeps it limping. Tune rates so the library ships (Arrow, Bulwark, Galleon) **never brown out in ordinary use**; only stacked burst builds should hit the cap. |
| Effort | energy.ts (per-circuit charge, rates, brownout), rebuild.ts (per-circuit capacity and rates), the snapshot's charge field, ShipHud, shipSummary/rating, the hangar overlay. No new parts are strictly needed. |
| Degenerate optima | "Every gun its own circuit with its own reactor": checked by reactors' cost, mass and blast, and by idle generation being wasted. "One giant circuit": checked by brownouts (and by shock, in phase 3). |

---

### Proposal B: Power Types ("what you feed it changes what it does")

*Effort M–L. A plus types, which is the heart of Kieran's idea.*

**B1. The types.** Three at launch, a fourth later. Each has its own colour everywhere: wire, glow, HUD and tooltips.

| Type | Colour | Made by | Travels | Cost / catch | Good at |
|---|---|---|---|---|---|
| **Steady** | cyan | Cell Reactor, Isotope Pile, Fusion Plant, Overclock Reactor; Battery and Heavy Bank store it | along wires (a steady circuit) | none: the baseline | efficiency, endurance, everything works |
| **Surge** | white-violet | **Capacitor** banks (charged from any circuit), and a new **Pulse Dynamo** generator that charges the bank it touches with no wires | **by touch only**: from a bank into what it touches | small capacity, long refill; banks are fragile | spikes: charged shots, kicks, instant shield restores |
| **Thermal** | orange | new **Plasma Burner** (high output per cell); maybe the Overclock Reactor reclassified (open question) | along wires (a thermal circuit) | burns **propellant** (an existing item) while it's used; adds **heat** | raw power, afterburn, burning effects, warmth in the cold |
| **Exotic** (later) | green-gold | a **Resonance Core** whose recipe needs a boss artefact; one per ship | along wires (an exotic circuit) | rare; one per ship | waking up the boss legendaries' extra behaviour |

Surge being "by touch only" is the key readability trick. Surge never shows up in the wire overlay. It's always a
visible clump of capacitors pressed against something. Kieran's "generators of different types" holds: the Pulse
Dynamo is a surge generator, the Plasma Burner a thermal one.

**B2. One generator type per circuit.** A circuit carries its generators' type. The hangar won't join two circuits
whose generators make different types: the wire tool refuses, and the clash shows red with a reason. Same-type
circuits bridged by a part still merge (today's behaviour, so old ships are unchanged). A part that touches **two
circuits of different types** isn't a bridge; it's **dual-fed** (B5).

**B3. One reaction table, by category, not by model.** This is what keeps it out of spreadsheet hell. A player learns
about 12 cells, not 37 guns × 3 types.

| Consumer category | on **Steady** | on **Surge** (touching a bank) | on **Thermal** |
|---|---|---|---|
| **Projectile guns** (cannon, autocannon, railgun, flak...) | as now | **Charged shot:** a shot after a pause takes a bank packet and hits harder and faster. The fire rate isn't faster. | **Hot rounds:** shots set a short burn on hull hit; the gun adds heat |
| **Beams and lasers** (Glint, Cutter, Lance...) | as now | **Pulse:** bigger, shorter pulses (the bank sets the peak) | **Longer reach, more heat:** range up, heat per second up |
| **Engines** | as now | **Kick:** boost becomes a short fixed impulse per bank packet (the archetypes doc's Burst Strafer as a rule, not a part) | **Afterburn:** higher rated speed and boost; burns propellant and adds heat |
| **Shields** | normal regen | **Flash restore:** when the shield breaks, the bank re-raises part of it at once (then must refill) | not accepted |
| **Utility** (jump coil, scanner, miner) | as now | jump coil: **shorter charge time**; scanner: **ping** (a strong pulse) | bore and miner: **melt** (faster mining, more heat); a Heater Core turns it into warmth |

(Ammo weapons keep using ammo; the type changes what their energy cost buys.)

**B4. Type-locked parts. New parts only.** Every existing model keeps accepting Steady, so nothing anyone owns breaks.
Types add, never remove. New parts can be locked:
- **Surge only:** a new "Arc Bank" or a reworked Overpulse line (capacitor weapons), the **Burst Strafer**, the
  **Discharge Capacitor**.
- **Thermal only:** a "Flame Torch" engine, the **Heater Core**, a **Melt Bore**.
- **Exotic only:** the legendary upgrades (B7).

**B5. Dual-fed parts (the multi-input idea).** A part touching two types runs a combo. Draft list, with the archetype
each serves:

| Part (fed by) | Effect | Serves |
|---|---|---|
| **Rail Driver** / Spear (Steady + Surge) | Steady holds the rails (no steady, no fire); the touching bank sets each shot's power. A full bank gives a shot with pierce +1, much faster, that empties the bank. | Longshot, Alpha Striker |
| **Ignition Kick** on Afterburner (Thermal + Surge) | The boost becomes a short, huge dash per bank packet; each dash burns propellant and adds heat | Blinker, Interceptor, Dancer |
| **Flash Screen** on any shield (Steady + Surge) | Normal shield, plus one instant full restore when it breaks, then a long bank refill | Bulwark, Warden |
| **Plasma Arc** on Tesla/Spark (Surge + Thermal) | Chain jumps set burns; every jump adds heat | Disruptor |
| **Cutting Torch** on Lance/Cutter (Steady + Thermal) | Bonus against armour, longer beam, overheats faster | Brawler, Bulwark |
| **Melt Bore** on Bore (Steady + Thermal) | Mines faster through hard rock; heat; uses propellant | Prospector |
| **Snap Coil** on jump coil (Steady + Surge) | Much shorter charge for short hops; long refill | Blinker, Pathfinder |
| **Incendiary Lobber** on Lobber/Quake (Thermal) | Shells leave a burning patch, no special ammo needed (single-type, but it shows "type as ammo") | Bombard |

**B6. Fuel.** Plasma Burners burn **propellant** (an existing item) in proportion to the thermal power actually used,
not while idle. With none in the hold, the burner goes cold and its circuit runs on whatever stores it has. Economy
hooks: propellant is sold at stations and refined from siphoned gas (so the Prospector's Siphon feeds the Bombard),
and a hauler can supply a party's thermal ships. Optionally `helium3` (also an existing item) as an Exotic or
high-grade fuel later.

**B7. Exotic (later).** A Resonance Core (boss-artefact recipe, one per ship) makes Exotic. A legendary fed Exotic gets
an extra behaviour on top of its usual one (e.g. Frostbite's chill lasts longer, Phase's shots skip a shield layer).
The legendary works as now without it. That gives boss farming a second payoff without making legendaries useless to
current owners. (Effect names only here; no lore.)

**B8. Heat.** Thermal power adds to a ship heat value. In the simplest version it **pushes the existing warmth meter
up**: thermal ships stay warm in cryo systems (the Bombard and Pathfinder are comfortable in the cold). Above warm,
there's an **overheating** stage: thermal parts lose output, then shut for a few seconds. That needs warmth.ts's meter
to go above 100% and one extra stage. See D for a spatial version.

**Evaluation**

| | |
|---|---|
| Depth | High. Types × categories × combos give lots of distinct builds from few rules. |
| Readability | Good if colour-coded and if the reaction table is one card. The risk is combos the player can't see; the hangar must show "dual-fed: Flash Screen" on the part. |
| Build variety | Very strong. Every archetype gets a power identity (§5, §6.6). |
| Server cost | Types are resolved at `rebuild()`: each consumer gets a type, a bank and a combo flag. Per tick adds bank packets (event-like), propellant (a rate on the server, synced as cargo) and heat (one number per ship, as warmth now). Prediction: the pilot already predicts energy and warmth; banks and heat use the same pattern. |
| Migration | Clean if B4 holds (existing parts keep Steady). Existing Capacitors become Surge banks. The one behaviour change: a capacitor not touching anything that uses it stops helping guns. The hangar flags it. Enemies stay Steady and auto-wired, and selected boss designs can show off types. |
| Effort | New parts (Plasma Burner, Pulse Dynamo, a few type-locked ones), the reaction table in launch.ts/flight.ts/shield code, propellant consumption, heat, plus all of A. |
| Degenerate optima | Thermal being strictly best (it's high output): checked by fuel and heat. Surge on everything: checked by bank space, touch rules, fragility and refill time. Watch for one combo outclassing its single-type parent everywhere. Combos should be situational (big alpha, long refill). |

---

### Proposal C: Circuit Board ("components and simple logic")

*Effort L. B plus electrical parts. Deep, but only worth it in small doses.*

- **C1. Ports.** Power parts get a feed edge, like weapons' attach edge, shown green in the hangar. A wire must arrive
  there. This reuses the mounting-rule UI.
- **C2. Cable grades.** Thin wire (as now) carries N per second; **heavy cable** (more spools, more mass) carries 3N.
  An overloaded run glows red and everything past it browns out. Worked out at `rebuild()` as a max-flow over at most
  a few hundred cells (cheap at rebuild, never per tick).
- **C3. Converters.** For example, an **Inverter** (Steady → Thermal at 70%) or a **Rectifier** (Thermal → Steady at
  80%, makes heat). These let one reactor type serve two types, at a loss.
- **C4. Breakers and fuses.** These pair with a **shock** rule: when a charged store or generator is destroyed, part
  of its circuit's charge arcs into nearby parts on that circuit. A **Breaker** between two halves stops it, and a
  **Fuse** blows (opens the circuit) instead of letting parts take damage. A blown fuse is repaired like any part.
- **C5. Diodes.** One-way flow. For example, the drive circuit's spare can top up the gun circuit, but never the
  reverse.
- **C6. Switches and relays.** A **Switch** joins two circuits while it's on, and the pilot binds it to a key: a
  "divert" (engines to guns, or guns to shields). A **Relay** flips a switch automatically on **one of three triggers
  only**: *shield broken*, *boosting*, *fire group fired*. A **Sequencer** touching a bank fires the guns it touches
  in turn (the archetypes doc's Linked Fire). Example: "when shields break, close the relay so the gun circuit's bank
  dumps into the strafers".
- **C7. Resonance bonuses** (e.g. +x% for same-type generators in a line). **Recommended against:** it's a pure
  layout tax with one right answer.

**Evaluation**

| | |
|---|---|
| Depth | Very high, and the most "circuit-like". |
| Readability | The weak point. Cable bottlenecks and converter losses are invisible numbers unless the hangar works very hard. Relays are hidden behaviour. |
| Build variety | Adds expression rather than new archetypes. Switches and relays are the exception: they give the Warden, Bulwark and Blinker a mid-fight "shape change". |
| Server cost | Fine: everything is at rebuild except switch state (one bit per switch, synced like the control bits) and relays (checked when their trigger changes). |
| Migration | New parts only; old designs are unaffected (thin wire, no breakers). Cable grades could make long auto-wired runs brown out, so set thin-wire capacity above anything a library ship draws. |
| Effort | Large: max-flow at rebuild, several new parts, switch and relay sync, and a lot of hangar UX. |
| Degenerate optima | Heavy cable everywhere (checked by mass and cost); diode tricks that duplicate power (the solver must conserve energy); relay loops (only three triggers, no relay can trigger a relay). |

---

### Proposal D: Hot Layout ("heat is the placement driver")

*Effort M. Works alongside A or B instead of replacing them.*

- Generators, thermal consumers and firing guns emit heat into **the circuit they're on** (not per cell: that's the
  cheap version). Each circuit has a temperature.
- **Radiators** (new part) shed a circuit's heat, but only on an **open edge** of the hull. That makes them compete
  with armour and guns for the outside, and they're fragile (archetypes doc §3.4).
- **Insulating materials** (Insulated Polymer, Ceramic Laminate) slow heat moving between touching circuits and keep
  it in.
- A hot circuit loses output; an overheated one shuts down for a moment. The ship's overall heat feeds the warmth
  meter (B8).
- A **per-cell** version (heat spreading cell by cell every tick) is more "physical" but costs more and is harder to
  read; **not recommended**.

**Evaluation:** placement matters strongly (radiators must face out, and hot circuits want space between them).
Readability is good with a heat tint in the hangar. It's cheap as a per-circuit number. It fits Kieran's "fuel and
heat" thought and the existing warmth system. The risk is one more meter to watch, so keep it to thermal and overclock
parts at first.

---

### 3.5 The proposals side by side

| | A. Local Circuits | B. Power Types | C. Circuit Board | D. Hot Layout |
|---|---|---|---|---|
| Placement matters | yes (circuits, touch banks) | yes, strongly (types, touch, dual-feed) | very (ports, cables, components) | yes (radiators, spacing) |
| Readable | high | good with colours and one table | low to medium | good with a heat tint |
| New parts needed | none (rates on existing ones) | 3–8 | 6–10 | 1–2 (radiator) |
| Server cost | tiny | small | small (rebuild-time solver) | tiny (per circuit) |
| Migration risk | low | low (types only add) | low | low |
| Effort | S–M | M–L | L | M |
| Answers Kieran's ideas | "placement matters" | types, multi-input, type locks, fuel | "circuit with logic" | heat, fuel |

---

## 4. Recommended path

**Phase 1: the core that already makes placement matter** (A, plus Surge in all but name)
1. Per-circuit charge (A1), discharge rates (A2), brownout (A3) and the core trickle reserve (A5).
2. **Capacitors discharge only into what they touch** (A4). Existing capacitors become banks.
3. Hangar: circuits lettered and coloured, a **load test** button, brownout and "weak link" warnings (§6).
4. Tuning rule: the library ships and a typical player ship never brown out in normal flying. The cap only bites
   stacked alpha and boost builds.

*Why first:* no new parts, small code surface (energy.ts, rebuild.ts, the charge field, the overlay), and it
immediately separates burst ships from sustain ships. It also turns the wires players already draw into a decision.

**Phase 2: the first real power type, Thermal** (B1, B2, B6, B8)
1. Plasma Burner, propellant use and heat feeding the warmth meter (with an overheat stage).
2. The reaction table's Thermal column (hot rounds, afterburn, longer beams, melt).
3. The one-type-per-circuit rule and dual-fed parts. Ship the first three combos: **Ignition Kick**, **Rail Driver**
   and **Flash Screen**.
4. Name Surge properly now (a colour and the reaction table's Surge column), and add the **Pulse Dynamo**.

**Phase 3: damage and control** (C4, C6 lite, D lite)
1. **Shock** on destroying a charged store or generator, with **Breakers** to stop it. That makes big shared circuits
   risky.
2. A pilot **divert switch** (one key, a few presets), which is the archetypes doc's "priority you control".
3. **Radiators** and per-circuit heat if heat from Phase 2 needs a placement outlet.

**Phase 4: optional**
- Exotic power and the legendary upgrades (B7), once boss farming wants a second payoff.
- Relays with the three triggers and a Sequencer (C6), if players ask for more control.
- Cable grades (C2) only if circuits turn out too easy to solve.

**Avoid**
- **Distance losses** (an invisible tax with one right answer: make everything short).
- **Resonance or line bonuses** (layout tax).
- **Free-form logic** (no gates, no programmable conditions, no relay chains).
- **Per-cell heat each tick.**
- **More than four types.**
- **Converter chains.**
- **Locking existing parts to a type after the fact.**

---

## 5. Example layouts

Legend (each letter is one cell; multi-cell parts repeat their letter):

```
C core          R steady reactor (Cell/Isotope/Fusion)   O Overclock Reactor   P Plasma Burner (thermal)
Y Pulse Dynamo  B battery    H heavy bank    D drive cell    K capacitor (a touching group = one bank)
X breaker       W radiator   E main engine   A afterburner   V vernier/strafer   S shield   J jump coil
o cargo hold    h hull       a armour        .  empty
guns: p Pip  s Spear  b Bastion  r Rattler  q Quake  t Tesla  l Lance/Cutter
```

The **circuits** grid next to each shows which circuit a cell's part is on: `a`, `b`... (the type is noted under it),
`*` = fed by touch from a bank, `2` = dual-fed, `-` = no power role.

### 5.1 Dancer: strafers on surge banks (Phase 1–2)

```
   parts                    circuits
   .  .  r  .  r  .  .      .  .  a  .  a  .  .
   .  h  h  C  h  h  .      .  -  -  a  -  -  .
   V  K  h  R  h  K  V      *  a  -  a  -  a  *
   V  K  B  R  B  K  V      *  a  a  a  a  a  *
   .  h  E  D  E  h  .      .  -  a  a  a  -  .
                            a = steady
```

- One steady circuit. The two capacitor banks (`K`, two cells each) touch the Verniers on each flank.
- **Behaviour:** a strafe is a **kick** (Surge on engines). It's instant and strong, and paid from the side's bank,
  not the circuit, so a dodge never browns out the Rattlers. Each bank gives two or three kicks per side, then needs a
  couple of seconds to refill from the circuit's spare.
- **The alternative layout:** the same parts with the capacitors moved behind the guns. The strafes go back to weak
  continuous thrust, and the guns get charged shots instead. Same parts list, a different ship. That's the goal.
- **Damage:** a hit on a flank takes out that side's bank, so you can only kick one way. You feel it.

### 5.2 Alpha Striker: one bank behind three guns (Phase 1)

```
   parts                          circuits
   .  s  .  b  b  .  s  .         .  *  .  *  *  .  *  .
   .  s  K  b  b  K  s  .         .  *  a  *  *  a  *  .
   .  K  K  K  K  K  K  .         .  a  a  a  a  a  a  .
   h  h  O  O  C  h  h  .         -  -  a  a  a  -  -  .
   a  h  E  E  E  E  h  a         -  -  b  b  b  b  -  -
   .  .  D  D  D  D  .  .         .  .  b  b  b  b  .  .
                                  a = steady (gun circuit)   b = steady (drive circuit: stores, no generator)
```

- Eight capacitors make **one bank** (they all touch) pressed against both Spears and the Bastion. The Overclock
  Reactor charges them through the gun circuit.
- **Behaviour:** one volley takes the whole bank: all three guns fire on the same tick with charged shots (Spear +
  Surge, the Rail Driver combo). Then about 8 to 10 seconds of refill with the Bastion barely firing.
- **The deliberate flaw:** the drive circuit `b` has drive cells but **no generator**. The hangar warns "Drive circuit
  has stores but nothing to charge them" and the load test shows the engines dying after one long boost. The player
  either wires `b` into `a` (so a volley browns out the engines) or adds a small reactor to `b`. That's the trade-off
  made visible.
- **Damage:** the bank sits right behind the guns' attach edges. A hit there loses the alpha and, with shock (Phase
  3), arcs into the guns. A Breaker between the bank row and the reactor contains it.

### 5.3 Freighter: steady, slow and redundant (Phase 1)

```
   parts                       circuits
   .  h  h  E  h  h  .         .  -  -  a  -  -  .
   h  o  o  R  o  o  h         -  -  -  a  -  -  -
   h  o  o  H  o  o  h         -  -  -  a  -  -  -
   h  o  o  C  o  o  h         -  -  -  a  -  -  -      wires (=) run up the spine AND
   h  o  o  H  o  o  h         -  -  -  a  -  -  -      round the outer ring of hull:
   h  o  o  R  o  o  h         -  -  -  a  -  -  -      a loop, not a tree
   .  h  E  h  E  h  .         .  -  a  -  a  -  .
                               a = steady (Isotope Piles, Heavy Banks, Drift Sails)
                               (H, a 2×2 Heavy Bank, is drawn one cell wide for brevity)
```

- Isotope Piles (never explode) and Heavy Banks (deep and slow). The engines are Drift Sails and an efficient main
  engine, so the circuit never comes near its slow discharge cap.
- **Behaviour:** endless cruising on very little. A boost is weak (Heavy Banks can't discharge fast), and that's fine
  for this job.
- **Placement lesson:** the wire runs **as a loop** (spine plus outer ring). The hangar's weak-link view shows *no
  single cell* that cuts the engines off, where the auto-wired tree had three. It costs more spools and makes the ship
  survive ambushes long enough to run.

### 5.4 Bombard: a thermal battery in the cold (Phase 2)

```
   parts                          circuits
   .  .  q  .  .  .  .            .  .  b  .  .  .  .
   .  .  q  .  .  .  .            .  .  b  .  .  .  .
   W  P  P  X  R  h  .            b  b  b  -  a  -  .
   W  P  P  C  B  h  .            b  b  b  a  a  -  .
   .  h  o  o  J  h  .            .  -  -  -  a  -  .
   .  .  E  h  E  .  .            .  .  a  -  a  .  .
                                  a = steady (engines, jump coil)   b = thermal (Quake, Plasma Burner)
```

- A thermal circuit (`b`): a Plasma Burner feeding the Quake, with Radiators (`W`) on the open left edge. A separate
  steady circuit (`a`) for the engines and the jump coil. The Breaker (`X`) keeps the two apart, and the
  one-type-per-circuit rule makes that mandatory anyway.
- **Behaviour:** the Quake fires **hot rounds**: shells leave burning ground (Incendiary Lobber), which suits sieges
  and nests. The burner's heat keeps the ship warm in cryo systems, where an idle Freighter freezes. It burns
  propellant from the hold, so the Bombard needs supply (a Freighter, or a Prospector's siphoned gas).
- **Placement lesson:** radiators must face an open edge. Wrap the left side in armour and the circuit overheats in a
  long siege.

### 5.5 Bulwark: shields on their own circuit, with a divert (Phase 1 + 3)

```
   parts                          circuits
   a  a  a  a  a  a  a            -  -  -  -  -  -  -
   a  S  S  R  S  S  a            -  a  a  a  a  a  -
   a  K  K  h  K  K  a            -  *  *  -  *  *  -     banks touch the shields: Flash Screen
   r  h  R  C  R  h  r            b  -  b  a  b  -  b
   a  h  B  Z  B  h  a            -  -  b  b  b  -  -     Z = divert switch (joins a and b on a key)
   a  a  E  h  E  a  a            -  -  b  -  b  -  -
                                  a = steady (shields)   b = steady (guns, engines)
```

- The shields have their own reactor (`a`), so a long brawl on the guns never weakens the shield. Banks touching the
  Deflectors make it a **Flash Screen**: the first time the shield breaks, it pops back.
- **Divert switch (`Z`, Phase 3):** pressing the key joins `a` and `b`. When the shields are fine, the shield reactor
  helps the Rattlers fire faster; when they're breaking, the gun circuit's spare goes to the shields. That's a
  mid-fight shape change, which the archetypes doc says the Bulwark and Warden need.
- **Damage:** isotope reactors don't explode, and the armour ring keeps both circuits' cores inside.

### 5.6 Interceptor or Blinker: dual-fed afterburners (Phase 2)

```
   parts                       circuits
   .  .  r  .  r  .  .         .  .  b  .  b  .  .
   .  h  R  C  B  h  .         .  -  b  b  b  -  .
   .  P  h  h  h  Y  .         .  c  -  -  -  *  .     Y = Pulse Dynamo, charging the bank it touches
   .  P  K  K  K  K  .         .  c  *  *  *  *  .     one bank (four touching capacitors)
   .  .  A  A  A  A  .         .  .  2  2  2  2  .     2 = dual-fed: thermal wire (c) + touching the bank
                               b = steady (guns)   c = thermal (burner, afterburners)   * = surge bank
```

- The steady reactor and the Plasma Burner don't touch (a hull cell and a diagonal keep them apart), so the two
  circuits stay separate. The bank also tops up from the burner it touches.
- The afterburners sit on a thermal circuit **and** touch the surge bank, so they're dual-fed: **Ignition Kick**.
  Boost becomes a huge short dash per bank packet, with propellant and heat as the cost. Between dashes, they cruise
  hot and fast on Thermal.
- **Behaviour:** catches runners and missiles, and gets out of trouble in one move. In a long fight it overheats and
  runs low on fuel, so it can't stay out long, which matches the archetype's "starves endurance".
- **Placement puzzle:** the afterburners must touch both the thermal wires and the bank. The bank must touch the
  Pulse Dynamo. That forces the rear of the ship into one specific shape.

---

## 6. Hangar UX: making it learnable

The power view already exists (the wire overlay, per-network colours and the "has no power" warnings in
wireEdit.ts). Build on it rather than adding a separate screen.

**6.1 Seeing circuits**
- Circuits get **letters** (a, b, c) as well as colours. With types, the **colour is the type** (cyan Steady, orange
  Thermal, green-gold Exotic), and the letter tells same-type circuits apart.
- **Flow animation:** dots run along wires from generators to consumers. Their speed shows load (idle: slow
  drifting; full fire: racing). This is the single best teaching tool: you *see* where power goes.
- **Surge banks** shimmer, and draw short arcs into every part they touch. A capacitor touching nothing that uses it
  shows a dim "unused" mark.
- **Dual-fed parts** get a two-colour ring and their combo name ("Flash Screen") on hover.

**6.2 Load test**
- Buttons: **Full fire**, **Boost**, **Everything**. Each one plays a few seconds of the ship's energy (the same
  energy.ts code, run locally) on the hangar view. Circuits that brown out flash red; parts that slow down dim; banks
  empty and refill visibly; heat rises on thermal circuits.
- Result line per circuit: "Circuit a (steady): browns out at full fire, guns at 62%, refills in 6 s".

**6.3 Warnings** (extending wireEdit's report, most important first)
- "Drive circuit b has stores but no generator."
- "3 Capacitors touch nothing that uses surge."
- "Thermal circuit has no propellant in the hold."
- "Can't join: circuit a is steady, circuit c is thermal" (when the wire tool refuses).
- **Weak links:** "Shooting this cell cuts 2 Spears off". These are the network's bridges and articulation points,
  worked out once in the hangar (cheap), and shown as red-outlined cells when the weak-link toggle is on. This makes
  the existing damage behaviour visible for the first time.
- "Shields share a circuit with engines: boosting will weaken them." (soft hint)

**6.4 Power diagram view** (a toggle for players who want it)
- A schematic beside the ship: sources on the left, circuits as boxes in the middle (supply, store, discharge,
  type), consumers on the right, with lines sized by draw. Clicking a box highlights that circuit on the ship.
  Optional; the ship overlay should be enough for most players.

**6.5 Tooltips, HUD and teaching**
- Part tooltips show **accepted types** as coloured pips, and the reaction on each type in one line ("on Surge:
  charged shot").
- The reaction table (B3) is one card in the field guide.
- In flight: one small bar per circuit (up to four) under the energy gauge. A circuit that browns out flashes; a bank
  shows as a pip that empties and refills.
- Teaching: an early job that has the pilot move a capacitor to touch a gun and watch the load test change.

### 6.6 How this serves the archetypes

| Archetype | Energy identity under this design |
|---|---|
| Dancer | Surge kicks on strafers; guns on a circuit the dodge can't drain (§5.1) |
| Alpha Striker | One big bank against the guns, Rail Driver shots, long refill (§5.2) |
| Blinker / Interceptor | Ignition Kick (Thermal + Surge afterburners), Snap Coil jumps (§5.6) |
| Bulwark / Warden | Separate shield circuit, Flash Screen, divert switch (§5.5) |
| Freighter | Steady, Heavy Banks, a loop wire for redundancy, never browns out (§5.3) |
| Bombard | Thermal circuit, hot rounds, radiators, fuel supply chain (§5.4) |
| Pathfinder | Thermal heat keeps it warm; a Heater Core; Snap Coil |
| Prospector | Melt Bore (Steady + Thermal); its siphoned gas becomes propellant for others |
| Disruptor | Plasma Arc (Surge + Thermal Tesla) |
| Ghost | (future) a cold steady-only build: thermal ships run hot and loud, if a signature system arrives |

---

## 7. Open questions for Kieran

1. **How far?** Is Phase 1 (local circuits, discharge rates, touch-fed capacitors) a good first step, or do you want
   power types in the very first version?
2. **Type list:** are Steady / Surge / Thermal (+ Exotic later) the right three or four? Is Surge-by-touch (never in
   wires) intuitive to you, or should Surge run along wires like the others?
3. **One type per circuit:** OK to have the wire tool refuse to join different types? The alternative is "mixed
   circuits where each consumer picks", which is more flexible but less readable.
4. **Existing parts:** should the Overclock Reactor stay Steady or become a Thermal reactor (no fuel, but heat)? It's
   the hottest-feeling generator already.
5. **Fuel:** happy for Thermal to burn propellant from the hold? How punishing should running dry be: the burner
   stops, or it drops to a weak trickle?
6. **Heat:** extend the warmth meter upward (one meter: cold to warm to hot), or keep heat separate? This overlaps
   the archetypes doc's question 1.
7. **Shock damage** when a charged store or reactor dies: does that sound fun, or too punishing next to the reactor
   blasts that already exist?
8. **Pilot control:** is a divert switch on a key welcome, or should power be fully set in the hangar with no flight
   controls?
9. **Logic parts:** do you want relays and sequencers at all (the "circuit with logic" feel), or are types plus
   placement enough logic?
10. **Enemies and bosses:** should some enemy designs and bosses use types (a thermal boss that overheats, a boss whose
    capacitor banks can be shot off to stop its alpha), as content that teaches the system?
