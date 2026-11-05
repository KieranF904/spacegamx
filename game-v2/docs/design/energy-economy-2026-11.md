# Energy economy proposal (2026-11-01)

Status: **proposal, awaiting Kieran's decisions** (section 8). Nothing here is built.

The owner's brief: energy management is barely a thing. One level-1 generator services the best weapon in the game. Wanted: a
mix of weapons that need mostly energy, mostly ammo, or a moderate amount of both; generators that are low/moderate output;
batteries that are bulk storage with moderate output; capacitors that are high output; per-part **input** limits as well as
output; weapons that only fire at full speed when their feed is saturated (so a tier-1 generator *can* fire an endgame gun,
slowly); more variety in thrusters, including a fuel mechanic; and all of it done through the token-efficient layout
(docs/design/rework-2026-11.md §2, the modular-layout rule: few files per change, numbers in data, features in the registry).

## 1. What already exists (so the plan builds on it, not beside it)

| Mechanism | Where | State |
|---|---|---|
| Output limit: a ship gives at most spare generation + the pool's rate a second | energy.ts `powerTick` | built |
| A gun short of its share reloads/charges proportionally slower; a beam burns only its share of ticks | energy.ts `feedShare`, guns.ts `share`/`burns` | built: this *is* "full speed only when saturated" |
| Banks (Capacitor, Drive Cell) with their own Gives, feeding what they touch first | circuits.ts | built |
| Refill, emptiest first, from spare generation | energy.ts refill step | built, **uncapped per store** (no intake) |
| Load test in the hangar | energy.ts `loadTest`, HangarUI POWER panel | built; shows brownout time, not sustained rate |
| Ammo guns: rounds from crates, a trickle of energy for loaders/guidance | guns.ts model `ammo` | built; crate prices never tuned against DPS |
| `thrustGate` feature hook (the Burst Strafer asks for energy through `PowerUse.extra`) | features/strafer | built: the seam fuel engines will use |

So the proposal is: **(A) retune demand into bands that bite, (B) add one field, `intake`, (C) add fuel as a bank kind + a
feature, (D) show saturation.** No new tick logic beyond one clause in the refill step.

## 1b. Routing (owner's rule, 2026-11-01): no pool

Power is not pooled: it moves only between parts that touch, so a layout like Generator > Battery > Weapon is the wiring.
Generators push into what touches them; stores and a new Conduit pass power on, each limited by its Takes (in) and Gives
(out), so the narrowest part in a chain sets the rate; weapons, engines and tools are dead ends that draw only from what
touches them. Prototype: prototypes/energy-lab/index.html (open in a browser; game ships exported by export-ships.ts).
Thrusters (owner, 2026-11-01) have a buffer too: full thrust burns Burn E/s from it, it refills at up to Intake E/s, and
once it's empty thrust drops to Intake ÷ Burn (it never stops dead). Burn far above Intake suits strafing: the prototype's
Side Jet (5 thrust, burn 50, intake 6, buffer 100: 2.3 s full, then 12%) and the Burst Strafer as a dodge thruster (burn 700,
intake 40, buffer 140: one full dodge, then about 6% until it refills in 3.5 s; no cooldown, energy is the limit).
Found while prototyping: "engines first" only holds among parts sharing a source, so a gun next to the store an engine
also draws from can starve the engine; whether to keep that, or reserve power along chains, is an open decision.

## 2. The buffer model (owner's firing rule, 2026-11-01)

Every weapon has an energy **buffer** that must hold a shot's worth before it fires; it never fires early or weaker.
Three stats replace `demand`: **Shot** (E a shot; the buffer holds it), **Intake** (the most E/s the weapon pulls into
its buffer however much the ship offers), **Buffer** (shots stored; 1 for most, more for burst-then-wait guns).
`fire interval = max(mechanical cycle, Shot ÷ min(Intake, supply))`. Supply is the touching Capacitor bank's Gives,
then the weapon's share of Output, so the chain is generator → store Takes/Gives → weapon Intake.
Today's code is already this at Buffer 1 (guns.ts: cooldown/reload/charge advance by the energy share; a gun doesn't
fire until paid), so guns.ts needs no change for Buffer 1: models.mjs derives `demand`/`reloadE`/`chargeE` from the
three stats. Buffer > 1 is one per-part state array (`stored`, beside `cooldown`/`rounds`), and the `clip` model is
most of it (a clip is a multi-shot buffer paid as it reloads): fold `clip` into `buffer`? Beams: a buffer that burns
while held and refills at Intake (bursts, no sputter), or continuous at Intake: decision 7.

| Weapon | Band | Shot (E) | Intake (E/s) | Buffer | On one Cell Reactor (35 E/s) |
|---|---|---|---|---|---|
| Pip | starter | 10 | 20 | 1 | full speed |
| Glint | starter | 30 | 35 | 1 | full speed |
| Chainsaw | mid | 8 a round | 80 | 10 rounds | 44% after the first burst |
| Cutter (beam) | mid | 180 buffer | 40 | — | runs 3 s, rests 5 s |
| Longbarrel | late | 220 | 110 | 1 | a shot every 6.3 s, not 2 |
| Spear | late | 180 + a slug | 90 | 2 | two quick, then one every 5 s |
| Tesla (beam) | late | 300 buffer | 170 | — | 20% duty |
| Bastion | end | 60 a round | 220 | 16 rounds | a clip every 27 s |
| Lance (beam) | end | 600 buffer | 300 | — | 12% duty |
| Leviathan | end (ammo) | 15 (loader) | 15 | 1 | full speed, torpedoes permitting |

The band tables below give each weapon's Intake at full rate ("E/s proposed"); Shot = Intake × cycle unless listed.

## 2b. Three cost profiles, four bands

Bands by unlock level: starter 0–9, mid 10–19, late 20–29, end 30+. Legendaries sit in the band of their level.
"E/s" is one gun fired flat out, the per-cell figure (a rect2 gun's `demand` is per cell; these are the totals).

| Profile | Energy at full rate (starter / mid / late / end) | Ammo | Who |
|---|---|---|---|
| **E** energy | 20–35 / 50–90 / 110–170 / 220–320 E/s | none | cannons, autocannons, lasers, pulse, arc, EMP, Lance, most legendaries |
| **H** hybrid | half the E band: 10–18 / 25–45 / 55–85 / 110–160 | cheap crates (slugs, canisters): a round a shot | railguns (Needle, Coilgun, Spear, Rail Driver), flak (Burst, Cloudmaker) |
| **A** ammo | trickle 5–15 E/s (loader, guidance) | costly crates, priced to the weapon's DPS | mortars, missiles, torpedoes, Demolition |

What a Cell Reactor (35/s) buys: a starter E pair. A mid E gun needs two or three. A late E gun needs a Fusion Plant or an
Overclock pair. An end E gun needs a Fusion Plant and change, or nine Cell Reactors (nine bombs). The "generator wrapped in
armour" build still works for A and H guns, and for E guns at half speed.

### 2.1 Per weapon

Current E/s from the audit calculator (docs/audits/weapons-balance-calc.ts). "Full-rate share on one Cell Reactor" is
35 ÷ proposed E/s, capped at 100%: how fast the gun fires on a tier-1 generator alone.

| Weapon | Lvl | Piece | Profile | E/s now | E/s proposed | Ammo | Share on one Cell Reactor |
|---|---|---|---|---|---|---|---|
| Pip | 0 | sq | E | 8.0 | 20 | — | 100% |
| Rattler | 3 | sq | E | 12.0 | 28 | — | 100% |
| Burst | 4 | sq | H | 0.0 | 10 | canisters | 100% |
| Hammer | 6 | rect2 | E | 10.0 | 30 | — | 100% |
| Lobber | 7 | sq | A | 0.0 | 6 | shells | 100% |
| Glint | 9 | sq | E | 15.0 | 35 | — | 100% |
| Strobe | 10 | sq | E | 12.0 | 50 | — | 70% |
| Prism Splitter | 10 | sq | E | 10.0 | 60 | — | 58% |
| Point Defence Turret | 10 | sq | E | 10.0 | 25 | — | 100% |
| Dart | 11 | sq | A | 0.0 | 8 | missiles | 100% |
| Twinlink | 12 | rect2 | E | 7.7 | 55 | — | 64% |
| Rustjaw's Hive | 12 | sq | E | 8.0 | 60 | — | 58% |
| Frostbite Lance | 12 | rect2 | E | 24.0 | 90 | — | 39% |
| Needle | 13 | rect2 | H | 0.0 | 30 | slugs | 100% |
| Chainsaw | 14 | rect2 | E | 22.4 | 80 | — | 44% |
| Hush | 15 | sq | E | 9.3 | 40 | — | 88% |
| Cloudmaker | 16 | rect2 | H | 6.7 | 35 | canisters | 100% |
| Spark | 17 | sq | E | 18.0 | 70 | — | 50% |
| Cutter | 18 | rect2 | E | 32.0 | 90 | — | 39% |
| Eel | 19 | rect2 | A | 0.0 | 10 | torpedoes | 100% |
| Longbarrel | 20 | rect2 | E | 10.3 | 110 | — | 32% |
| Swarm | 21 | rect2 | A | 0.0 | 12 | missiles | 100% |
| Coilgun | 22 | rect2 | H | 15.6 | 70 | slugs | 50% |
| Cinder Bloom | 22 | sq | E | 11.7 | 130 | — | 27% |
| Stinger | 24 | sq | E | 7.4 | 120 | — | 29% |
| Quake | 24 | rect2 | A | 0.0 | 12 | shells | 100% |
| Overpulse | 25 | rect2 | E | 13.3 | 130 | — | 27% |
| Searchlight | 26 | round | E | 15.0 | 140 | — | 25% |
| Phase Cannon | 26 | rect2 | E | 13.6 | 140 | — | 25% |
| Spear | 28 | block2 | H | 63.2 | 90 | slugs (1 a shot) | 39% |
| Tesla | 29 | round | E | 30.0 | 170 | — | 21% |
| Rail Driver | 29 | block2 | H | 19.2 | 80 | slugs | 44% |
| Bastion | 30 | block2 | E | 16.7 | 220 | — | 16% |
| Singularity Launcher | 30 | sq | E | 30.0 | 240 | — | 15% |
| Lance | 32 | rect2 | E | 90.0 | 300 | — | 12% |
| Hammerhead | 33 | block2 | A | 0.0 | 12 | missiles | 100% |
| Blackout | 35 | block2 | E | 16.4 | 120 | — | 29% (utility: below band on purpose) |
| Leviathan | 38 | block2 | A | 0.0 | 15 | torpedoes | 100% |

Fuel for the retune (not changed here): a gun's time to kill at 100% stays as audited; at 25% it is four times longer.
The audit's ~25 damage/speed changes (docs/audits/weapons-balance-2026-11-01.md) stay a separate decision.

### 2.2 Ammo as the other currency

Today's crates (price / rounds): slugs 30/200, canisters 25/120, shells 45/40, missiles 50/24, torpedoes 160/6, charges 30/30.
At the retuned cadence, a Swarm burns 160 rounds a minute ($333/min), a Leviathan 20 ($533/min); a Needle burns $0.15 a shot.
Rule proposed: **an A gun's crate cost per minute of fire ≈ its band's E/s × a price per E/s** (so ammo and energy are
exchangeable at a known rate), and an H gun's is a tenth of that. The rate per E/s has to come from income data (section 8).

## 3. Stores: Holds, Gives and (new) Takes

`intake` (E/s a store can absorb per cell) is the one new field. Refill stays "emptiest first", capped per store.

| Store | Piece | Holds a cell | Gives a cell | **Takes a cell (new)** | Role |
|---|---|---|---|---|---|
| Core | ship | 240 | 720/s | 120/s | always there; drained, 2 s to refill |
| Battery | sq | 200 → **300** | 600 → **150/s** | **50/s** | bulk, moderate out, slow in: endurance |
| Heavy Bank | block2 | 300 (1,200) | 150 (600) → **100 (400)** | **150 (600)** | soaks spare generation fast, drips it out |
| Capacitor | sq | 160 → **120** | 2,000/s | **40/s** | the alpha strike: pays a Spear shot at once, then 3 s a cell to refill |
| Drive Cell | sq | 320 | 1,400/s | **80/s** | boosts and dodges; two free Strafer bursts a cell, 2 s each to earn back |
| Pulse Dynamo | sq | — | 10/s into touching banks | — | unchanged |
| *Flux Coil (optional new, rect2, lvl 20)* | rect2 | 80 | 600/s | **300/s** | a fast buffer that turns a steady plant into bursts |

Why Takes matters: between fights a ship recovers at min(spare, Σ Takes); a Capacitor bank rations alpha strikes to one every
few seconds however big the plant; a Heavy Bank grabs generation the guns aren't using. Generators stay stores-less: steady,
low-to-moderate output, no burst (the burst comes from what they fill).

## 4. Generators

Per piece (produce × cells). Kept as they are; a tier-5 plant is optional.

| Generator | Piece | Output | Character | Serves at full rate |
|---|---|---|---|---|
| Cell Reactor | sq | 35 | cheap, fragile, explodes | a starter E pair, or any A gun |
| Isotope Pile | round | 18 | weak, tough, never explodes | A/H trickles; the armoured brick |
| Overclock Reactor | rect2 | 124 | most power a cell, fragile, biggest blast | one late E gun |
| Fusion Plant | block2 | 192 | heavy, big blast | one late E gun and a mid one; **not** an end gun |
| *Stellarator (optional, block2, lvl 36)* | block2 | 300 | the end-game plant: huge mass, needs coolant | one end E gun |

## 5. Thrusters and fuel

Propellant: a new item, `propellant` (100 units a canister, ~$20; refined from cryo gas 2:1, so the Siphon gets a second
use). A **Fuel Tank** part (sq, holds 100 units a cell, explodes like a reactor) is a third bank kind: it feeds the engines
it touches, refills only from the hold (a canister at a time, like ammo), never from generation.

| Engine | Piece | Thrust a cell | E/s a cell | Fuel/s a cell | Thrust per E/s | Character |
|---|---|---|---|---|---|---|
| Vernier | tri | 1.2 | 4 | — | 0.30 | corner push, no boost |
| Drift Sail | round | 0.9 | 3 | — | 0.30 | near-free cruising |
| Ion Drive | sq | 2.26 | 9 | — | 0.25 | the starter, unchanged |
| *Chem Rocket (new, sq, lvl 3)* | sq | 3.0 | 2 | 2.0 | 1.50 | the starter's fast option if they buy fuel; stops dead when dry |
| Afterburner | sq | 1.6 cruise / 5.8 boost | 8 cruise, **8 boost** | **3.0 while boosting** | 0.20 / 0.73 | boost moves from the generator to the tank |
| Plasma Drive | rect2 | 3.1 | 20 | — | 0.155 | the balanced electric main |
| Torch | rect2 | 4.0 | 34 → **10** | **2.5** | 0.40 | brutal thrust, brutal *fuel* bill |
| Fusion Torch | block2 | 3.6 | 28 | 0.3 (ignition) | 0.129 | long-haul electric racer with a sip of fuel |
| Burst Strafer | sq | 14 kick | 140 a burst | — | — | unchanged |

Trade-offs this creates: fuel engines need almost no generation (small, fast ships) but cost money per minute, carry tank
cells that explode, and die when the tank runs out; electric engines are free to run but need plants and the plants' mass.
A Torch tank cell lasts 40 s flat out; a Chem Rocket's 50 s. Cold systems: no heating interaction (owner: not yet).

## 6. Showing it (hangar and HUD)

- Hangar POWER panel: a "sustained" column per gun from `loadTest` (fire rate at the ship's steady Output, after the stores
  empty), and Takes beside Holds/Gives on every store card.
- Weapon card / partTip: "Needs 300 E/s; this ship feeds 38% → one shot every 2.6 s".
- HUD: fuel bank bars ride `BankBars` (banks already draw); a dry tank flashes.

## 7. Architecture: few files, data first

| Phase | Change | Files | New tick logic |
|---|---|---|---|
| **A retune** (ship first, alone) | a `PROFILE` table in models.mjs (band × profile → demand/reloadE/ammo trickle); each weapon gets a `profile` tag; store numbers; `npm run models`; crate prices | scripts/econ/models.mjs, data/items.json, regenerated models.json, calculator pinned as a test, goldens/snapshots | none |
| **B intake** | `intake` model field; `partIntake()` beside `partDischarge` in circuits.ts; the refill step caps each store (one clause); Takes row in partTip and POWER panel | circuits.ts, energy.ts (refill loop only), partTip.ts, HangarUI powerHtml, models.mjs, circuits.test.ts | one clause |
| **C fuel** | `bankKind` gains `'fuel'` (one line); engine `fuel` field; `features/fuel` (common/server/client) using the existing `thrustGate` + `load` hooks: spends fuel, scales thrust to 0 when dry; tank level as a `pilotExtra` wire value; item + recipes; BankBars draws it | circuits.ts (1 line), models.mjs, features/fuel/*, features.wire.json, items/recipes data, BankBars | none in flight.ts/energy.ts |
| **D readouts** | sustained column in `loadTest`, card text via `describePart` | energy.ts loadTest, HangarUI, partTip, describe | none |

Each phase ships on its own and is tested in the circuits/features suites plus goldens. Retuning later is a table edit.

## 8. Decisions needed

1. The bands (section 2): are the end-game numbers (220–320 E/s) the feel you want: a Fusion Plant and change, or nine Cell Reactors?
2. Hybrid rails and flak buy slugs/canisters from level 4 (Burst) and 13 (Needle) on. OK, or keep flak pure ammo?
3. Ammo pricing needs an income figure: credits per hour a mid-game player earns. With it, crate prices follow the rule in 2.2.
4. Fuel: which engines (the table), the Fuel Tank as a bank kind, `propellant` as a new item or folding in `boost_cell`.
5. New parts: Chem Rocket (recommend yes), Fuel Tank (needed for fuel), Flux Coil (optional), Stellarator (optional).
6. Store retune (section 3): Battery slower and deeper, Capacitor smaller and slow to refill. OK?
7. Beams: a buffer that bursts and rests, or continuous at Intake?
8. Clips: fold `clip` into `buffer` (a Chainsaw's 10 rounds are its buffer), or keep both?
