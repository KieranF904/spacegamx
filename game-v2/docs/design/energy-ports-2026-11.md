# Energy ports: directed power routing (2026-11-02)

Status: **design for testing in the lab** (`prototypes/energy-lab/ports.html`), from the owner's direction on 2026-11-02.
Nothing in the game changes until the lab has settled the numbers. It replaces the touch-and-even-out routing of
`energy-routing-impl.md` (D1, D5), the bank and pool rules (`circuits.ts`), the Diode and the Pulse Dynamo. It keeps the
weapon buffer model (`energy-economy-2026-11.md` §2: Shot, Intake, Buffer) and the thruster buffer.

## 0. Why

The ship evolver (`scripts/shipgen/evolver`) was fed the game's own numbers and asked for the best gunship. It
built one and told us the meta:

- **Power is the cheapest thing on the ship.** A Cell Reactor makes 35 E/s for 16 credits: five times the value of the
  next generator. A spare reactor (16 credits, 1 build point) is cheaper than armouring one (35–70 credits, 2–4 points),
  so the optimiser builds spares and leaves them exposed. Losing one changes nothing.
- **Storage has no job.** No gun draws more than its steady supply, so a Capacitor (holds 160 for 57 credits) is a weak
  reactor. Burst damage equals sustained damage on every evolved ship. Nothing ever carried a store.
- **Blasts are too small to matter.** A reactor's 45 damage at 2 cells can't take out a 75 hp hull cell beside it.
- **Layout doesn't matter.** Power pools through whatever touches; the only decision is "is it adjacent". A level-30
  ship is a level-1 ship with more guns stuck on.

The owner's answer: make power a thing you **route**. Every power part has ports on specific edges. Power moves only
out of an out port into an in port across a shared edge. Generators are weak, dear and dangerous. Batteries are where
lines join and split, so a good gun needs two generators through a battery, and a superweapon needs a ship built around
its power chain. Then protecting the chain is the whole art of ship design, and the evolver can find it.

## 1. Rules

### 1.1 Ports

- A **port** is one edge of one cell of a part, marked **in** or **out**, with a **rate** (E/s, the most that may cross
  it in a second). A part may have any number of ports; most have one to four. Hull, armour and cargo have none and
  never carry power.
- Ports are in the part's own frame. Rotation (`rot`) and `flip` move them with the part. Unrotated: **N is the nose**
  (forward). Guns fire N and take power from S; engines push S and take from N; generators give N; stores take S, give N.
  A vertical chain reactor → battery → gun needs no rotation; the chain to the engines is the same parts turned about.
- Two ports are **linked** when they lie on the same shared edge and one is out and the other in. Power crosses a link
  from the out side to the in side, never back.
- A port that faces no matching port is **open**. An open out port on a generator wastes its share. An open in port on
  a gun means the gun is short that port's rate. Two outs or two ins facing each other **clash** and pass nothing (the
  hangar warns).

### 1.2 Parts

| Kind | Ports | Holds | Behaviour |
|---|---|---|---|
| **Generator** | out only | none | Each out port offers its rate every tick. What isn't taken is wasted. A two-port generator is two lines of half the power, not one line of all of it. |
| **Store** (battery, capacitor, bank, the core) | in and out | yes | Takes through in ports (each at most its rate; all together at most the space left), gives through out ports (each at most its rate; all together at most what it holds). What comes in and isn't given out stays as charge. |
| **Conduit** | 1 in, 1 out | 10 (a few ticks) | A store too small to matter: a one-way line. Straight (in S, out N) or corner (in S, out E; flip for W). The old Diode is retired: every Conduit is one. |
| **Consumer** (weapon, engine, shield, tool) | in only | its buffer | Takes through each in port at most that port's rate, into its buffer, until full. A part with two in ports fed on one gets at most half its intake. |

Power never flows store → generator, consumer → anything, or through hull. There is no pool: the core is a store like
any other, with the ports below.

### 1.3 The tick (deterministic, synchronous)

Every tick (60 a second), from the state at the start of the tick:

1. **Offer.** Each giver (generator or store) offers across each of its out links `min(out rate, in rate) × dt`, the
   link's cap. A generator offers the cap on every link. A store offers what it holds, water-filled across its out
   links (smallest cap first), so no link gets more than its cap and the total never exceeds what it holds.
2. **Accept.** Each taker accepts from its in links, water-filled: a store up to the space left in it, a consumer up to
   the space left in its buffer. What a taker refuses stays with the giver.
3. **Apply** every transfer at once. A store's charge changes by in − out; both were bounded by its start-of-tick state,
   so it stays within 0..Holds.
4. **Consumers act:** passive drain, firing, thrust, shields (§1.4, §1.5).

Order doesn't matter within a step, so the result is the same on the server, in the pilot's prediction and in the
hangar, and it parallelises. A conduit adds one tick of latency per cell; at 60 a second a ten-cell run is a sixth of a
second, which is fine. Integer eu as today (`units.ts`).

Backpressure falls out: a full store accepts nothing, so the store behind it fills, and so on back to the generator,
whose offer is then wasted. "Wasted at generators" is the signal that a chain is over-supplied.

### 1.4 Weapons

Unchanged from `energy-economy-2026-11.md` §2 and the lab: a weapon has **Shot** (E a shot), **Buffer** (shots stored)
and its in ports' rates sum to its **Intake**. It fires when its buffer holds a shot and its cycle is done; short of
supply it fires slower, never weaker (`fire interval = max(cycle, Shot ÷ supply)`). Beams burn from the buffer while
lit and relight at half. Clips are magazines (D2).

**New: passive drain.** A weapon may have a **Passive** (E/s) that leaves its buffer every tick whether or not it fires:
containment fields, targeting arrays, a lance's standing charge. Its buffer only fills at `supply − passive`, so
`fire interval = max(cycle, Shot ÷ (supply − passive))`, and **below Passive it never fires at all**. Most weapons have
0; the big ones have 5–15% of their intake. It is the floor under "a tier-1 generator can fire an endgame gun, slowly":
it can fire a Longbarrel slowly, but it can't light a Lance. The hangar card says "needs at least 40 E/s to charge".

### 1.5 Engines, shields and tools

As in the lab today: a thruster burns from a buffer that refills through its in ports; once empty it runs at intake ÷
burn. Shields and tools draw a flat rate into a one-second buffer; their share is what they get over what they want.
Priority between a gun and an engine on the same store is settled by the store's ports: the ship's wiring is the
priority, as the owner asked (2026-11-02), not a phase order.

### 1.6 Damage

- **Generators are weaker, dearer and far more explosive** (§3). A Cell Reactor's blast kills an alloy hull cell beside
  it and sets off a reactor next to it, so packing reactors is a chain reaction waiting to happen.
- **Charged stores explode in proportion to their charge:** `damage = 0.6 × held`, `radius = 1.5 + held ÷ 300` (at most
  4.5). A full Capacitor (160) does 96 at 2 cells; a full Heavy Bank (1,200) does 720 at 4.5 cells: a bomb to bury. An
  empty store is harmless. So a store is a liability as well as an asset, and the ship that discharges before it gets
  hit is playing well.
- Conduits and stores are fragile (§3). One hit on a line cuts everything downstream until it is repaired.
- Blasts as `bridge/damage.ts applyBlast` today: linear falloff to the radius, explosive resist, chains.

## 2. Design rules (how the numbers are chosen)

1. **A store is three numbers: In, Out, Holds.** Sustained = min(ΣIn, ΣOut). Peak = ΣOut, for Holds ÷ (Out − In)
   seconds. Refill = Holds ÷ (In − draw). **Out ≥ In always**: a store with Out below In is a bottleneck, not a store.
   The gap is its character: a battery's Out is a little above its In (smoothing and joining), a capacitor's far above
   (the alpha strike), a bank's about equal with huge Holds (endurance).
2. **A store cell competes with a generator cell over a burst.** Over a firing window of T seconds a store cell is
   worth Holds ÷ T E/s. With T ≈ 8 s and a reactor at 30 E/s, a store cell wants Holds ≈ 250–350 to be worth its
   cell. Capacitors sit below that on purpose (their value is Out, not Holds); banks above.
3. **A spare generator must cost more than covering one.** Generation is priced (credits and build points) so that
   two reactors cost more than one reactor plus the two or three armour cells that hide it. Then the optimiser hides
   them. Today it is the other way round.
4. **Weapon tiers are infrastructure tiers.** Starter guns take one port at ≤ 35 E/s: one reactor, direct. Mid guns take
   one port at ~70: two reactors through a Joiner Bank, or a plant port. Late guns take two ports: two joined lines or a
   plant. End guns take two to four ports at 150 each: plants, banks and a Capacitor Array. The ship grows around the gun.
5. **A gun is paid for by the ship around it.** A Lance is cheap for its damage; the 20 cells of plants, banks and
   conduits it needs, and the armour to hide them, are the price. The swarm build (many starter guns on their own
   reactors) stays viable because it loses one gun per hit instead of all of them; the superweapon build wins on
   penetration and alpha, which the swarm can never have. Both must evolve in their scenarios (§6).
6. **One sentence per part** (`rework-2026-11.md` §1). A battery's sentence is its ports: "Takes two lines in at 40
   each, gives one out at 90; holds 300."

## 3. The parts (first proposal: the lab's numbers)

Ports are written `dir side[cell] rate`. Sides are the part's own, unrotated (N nose). `[0]` is the left (W) cell of a
N or S side and the top (N) cell of a W or E side.

### Generators

| Part | Piece | Lvl | Ports | HP | Blast | Sentence |
|---|---|---|---|---|---|---|
| Cell Reactor | sq | 0 | out N 30 | 50 | 120 at 2.5 | The starter: one line of 30. Fragile; it takes its neighbours with it. (Today 35, 45 at 2.) |
| Twin Reactor (new) | sq | 6 | out N 18, out S 18 | 50 | 140 at 2.5 | Two lines fore and aft. More power, one blast for two chains. |
| Isotope Pile | round→sq | 9 | out N 15 | 150 | none | Weak, tough, never explodes: the armoured brick's heart. |
| Overclock Reactor | rect2 | 24 | out N[0] 55, out N[1] 55 | 80 | 350 at 4 | Most power a cell; the biggest blast. |
| Fusion Plant | block2 | 18 | out N[0] 60, out N[1] 60 | 300 | 260 at 3.5 | Two strong lines; heavy and tough. (Today 192 in one pool.) |
| Stellarator (new, optional) | block2 | 36 | out N[0] 60, N[1] 60, S[0] 60, S[1] 60 | 400 | 400 at 4.5 | Four lines: the end-game plant. |

### Stores and conduits

| Part | Piece | Lvl | In | Out | Holds | HP | Sentence |
|---|---|---|---|---|---|---|---|
| Core | rect2 | — | W 60, E 60 | N[0] 150, N[1] 150, S[0] 150, S[1] 150 | 240 | 150 | Power in from the sides, out fore and aft: the free hub every ship has. |
| Conduit | sq | 0 | S 200 | N 200 | 10 | 35 | A one-way line. |
| Conduit, corner | sq | 0 | S 200 | E 200 | 10 | 35 | A one-way line that turns (flip it to turn the other way). |
| Cell Battery | sq | 0 | S 40 | N 60 | 200 | 45 | Smooths one line. |
| Joiner Bank | rect2 | 3 | S[0] 40, S[1] 40 | N[0] 90 | 300 | 90 | Two lines in, one out: the first thing a mid gun needs. |
| Splitter Bank | rect2 | 5 | S[0] 80 | N[0] 45, N[1] 45 | 300 | 90 | One line in, two out: two guns on one plant port. |
| Capacitor | sq | 7 | S 40 | N 400 | 160 | 30 | Pays a big shot at once, then 4 s to refill. |
| Drive Cell | sq | 10 | S 60 | N 250 | 320 | 45 | The Capacitor for engines: a dodge or a boost, then 5 s. |
| Flux Coil (new) | rect2 | 20 | S[0] 150, S[1] 150 | N[0] 300 | 160 | 70 | Joins two plant lines into one fast one. |
| Heavy Bank | block2 | 20 | S[0] 70, S[1] 70 | N[0] 150 | 1,200 | 280 | Endurance: fills between fights, carries a gun through one. Full, it is a bomb. |
| Capacitor Array | block2 | 26 | S[0] 60, S[1] 60, W[0] 60, W[1] 60, E[0] 60, E[1] 60 | N[0] 600, N[1] 600 | 600 | 150 | Six lines in at 60, two huge lines out at 600: the last stage before a superweapon. |

Retired: Diode (every Conduit is one), Pulse Dynamo (wireless feeding has no place with ports), pools and banks in
`circuits.ts`, the Capacitor's "guns only" and the Drive Cell's "engines only" (ports decide who is fed).

### Weapons (the lab's subset; the rest follow the bands in §2.4)

| Weapon | Piece | Lvl | In ports | Shot / Buffer / Cycle | Passive | DPS at full rate |
|---|---|---|---|---|---|---|
| Pip | sq | 0 | S 20 | 10 / 1 / 0.5 s | 0 | 56 |
| Glint | sq | 9 | S 35 | 28 / 1 / 0.8 s | 0 | 54 |
| Hammer | rect2 | 6 | S[0] 70 | 70 / 1 / 1 s | 0 | 69 |
| Cutter (beam) | rect2 | 18 | S[0] 45, S[1] 45 | burns 90, buffer 180 | 5 | 150 lit |
| Longbarrel | rect2 | 20 | S[0] 55, S[1] 55 | 220 / 1 / 2 s | 0 | 48 |
| Spear | block2 | 28 | S[0] 45, S[1] 45 | 180 / 2 / 2 s | 10 | 85 |
| Bastion | block2 | 30 | S[0] 55, S[1] 55, W[1] 55, E[1] 55 | 60 a round, clip 16, 0.25 s | 15 | 111 |
| Lance (beam) | rect2 | 32 | S[0] 150, S[1] 150 | burns 300, buffer 600 | 40 | 210 lit |

The Hammer at level 6 is the first gun one reactor can't feed: it wants a Joiner Bank (level 3) and two reactors, or
to wait for a plant. The Lance on one Cell Reactor never lights (30 < 40 passive); on a Fusion Plant's two ports it runs
at 120 − 40 = 80 E/s into a 300 E/s burn, so it fires a quarter of the time: that is "a tier-1 generator fires an endgame
gun, slowly" with a floor under it.

### Engines and shields

| Part | Piece | In ports | Burn / Buffer | Thrust |
|---|---|---|---|---|
| Ion Drive | sq | N 12 | 9 / 30 | 2.26 |
| Plasma Drive | rect2 | N[0] 25, N[1] 25 | 40 / 120 | 6.2 |
| Deflector | sq | S 16 | flat 16 | — |

### Costs (direction, not numbers)

Credits come from recipes (`recipes.ts partValue` over `items.json`), and those values are guesses, not tied to how
hard anything is to get (owner, 2026-11-02). The cost audit is separate work: an export that computes each item's
effort (minutes of play to acquire at its level: mining rate × density × travel, drop rates × time a kill, refining and
fabrication time) and reports it against today's value. Until then the rule in §2.3 is the target: a Cell Reactor
about double today's 16 credits and 2 build points, so that a spare costs more than cover.

## 4. The meta this is meant to produce

| Build | Power layout | Strength | Weakness |
|---|---|---|---|
| Swarm | one reactor per starter gun, or a Splitter Bank per pair | loses one gun a hit; cheap; simple | no penetration; low alpha; many exposed reactors, each a small bomb |
| Trunk | two or three mid guns on a joined trunk from the core | efficient; one chain to armour | the trunk is a single point of failure |
| Superweapon | plants → Joiner Banks / Flux Coils → Capacitor Array → one gun | alpha and penetration nothing else has | most of the ship is power; one hit in the chain and it is a hull with a gun on it |
| Brick | Isotope Piles and Heavy Banks under armour | survives; never explodes | slow, low output, a bomb if the banks are full |

Penetration is what makes the superweapon worth its ship. The evolver's scenarios need the enemy's armour so that
penetration counts (today it ignores it), and the hit simulation needs the new blasts. With those, the gunship
scenario should evolve a trunk or a swarm and a "capital" scenario a superweapon, and both should bury their chains.

## 5. Hangar and HUD

- Every power part draws its ports on its edges: a filled triangle pointing out for an out port, a notch pointing in
  for an in port; amber for out, blue for in. A linked pair glows; an open in port on a consumer is red; a clash is
  red on both. Hovering a port shows its rate and what it faces.
- Rotate (R) and flip (T) turn the ports with the part; the ghost shows them before placing.
- The power overlay draws each live link with its E/s and dims the chain downstream of a broken part.
- The card: the part's sentence (§2.6), then "Now: in 60, out 48, holds 220 of 300", then the warnings.
- Blast rings on hover for generators and charged stores, as the hazard they are.

## 6. Implementation (after the lab settles the numbers)

| Phase | Change | Files |
|---|---|---|
| A ports in data | `ports: [{side, cell, dir, rate}]` on every power model, `passive` on weapons, new blast numbers, `storeBlast` in tuning; retire `bank`, `pool`, `dynamo`, `oneWay`, `discharge`, `intake` (port rates replace them) | `data/ships/models.json`, `tuning.json`, `scripts/econ/models.mjs`, `types.ts` |
| B the tick | links built in `layout.ts` from ports + rot/flip; `tick.ts` becomes offer/accept over links (§1.3); banks, pools, dynamos and the thrust-first phase go | `power/layout.ts`, `power/tick.ts`, `power/blueprint.ts`, tests, goldens |
| C validation | a consumer with every in port open is "unpowered" (hangar warning, not an error); a clash is a warning | `validate.ts`, `routeCheck` |
| D hangar | port glyphs, link overlay, hover, R/T | `HangarUI`, `partTip`, `describe` |
| E migration | a router that re-lays each bundled blueprint's power parts with ports and conduits (the evolver's `cheapest_build` is the start of it); players' saves show the overlay until they re-route | `scripts/ships/route.ts` (new), blueprints |
| F evolver | the catalogue gains ports; placements carry rot/flip; a `route` change lays conduits; scoring runs the game's own tick over a fight timeline (firing windows) through the kept-open node process, so storage, passive drain and ports are measured exactly as the game does them | `scripts/shipgen/evolver/*` |

Each phase is one PR, tested in the power suites and goldens, under the modular-layout rule.

## 7. Decisions for Kieran

1. **Generator split:** fixed per port (as written: a Twin Reactor is two lines of 18), or the part's total shared by
   demand across its ports? Fixed is readable and makes placement count; shared is forgiving.
2. **The core's ports:** in from the sides, out fore and aft (as written), or something else? It is the one free
   store, so its shape sets what every starter ship looks like.
3. **Passive drain:** on which weapons, and how much? Written: 0 on starter and mid guns, 5–15% of intake on late
   and end guns, 40 on the Lance.
4. **Charged-store blasts:** keep? The numbers (0.6 × held) make a full Heavy Bank a 720-damage bomb.
5. **Conduit corners:** a separate part, or one Conduit with a corner rotation state? (The lab has two parts.)
6. **Retire the Diode and the Pulse Dynamo,** or keep them as models with new meanings?
7. **Engines fed from the front (N) and guns from the back (S),** as written? Or every consumer from any side with
   per-side rates?
8. **Weapon power profiles (§9):** the assignment in §9.2 is a first pass. Which guns get which, and how hard?
9. **Threshold reads line ratings, not what's flowing (§9.1).** A store behind a gun always qualifies, however empty.
   That makes "a store or a joined line" the rule. The alternative (what arrives in the tick) turned out to be
   bypassed by any store anyway, but less readably.
10. **The feed layer (§10):** six consumables, each a trade-off and a hazard. Which to keep, and are the hazards
    (fire, freeze, arc, bomb) the right flavour for the game?
11. **Mixed feed networks** dilute every effect (as written) or should a pipe refuse to join two tanks of different
    consumables (the lab already keeps touching tanks of different kinds apart)?
12. **Pipes are undirected and unlimited in rate** (as written). A pump or rate limit would add another layout
    constraint; I'd hold it back until the basic layer has been played.

## 8. The lab

`prototypes/energy-lab/ports.html` runs these rules (the model is in `ports-model.js`, tested by `ports-model.test.mjs`).
Place parts, R rotates, T flips, hover for what each part is doing, click to pin it and edit its numbers (port rates
included). Fire runs the guns; **Bursts** fires in windows so you can see stores pay off; **Break** destroys a part and
sets off its blast. Examples in the Load menu:

1. **Starter: two reactors into the core, two Pips and two Ion Drives.** The core's in ports (60) are the limit.
2. **A Hammer needs two reactors.** Joiner Bank under it; take a reactor away and watch it drop to half rate.
3. **Two Glints on one line.** A Splitter Bank; the second plant port is wasted until you fix it.
4. **Alpha: a Longbarrel on a Capacitor.** Charged, it fires at once; then the refill sets the pace. Try Bursts.
5. **Passive and steady: a Spear on two reactors, a Lance on one.** Erase a reactor under the Spear and every charge collapses.
6. **A superweapon and its ship.** Two Fusion Plants and four reactors into Joiner Banks and a Capacitor Array, into a Lance.
7. **Engines round a corner.** Core, Drive Cells and corner conduits to Ion Drives on the flanks.
8. **Chain reaction.** Reactors packed beside the guns. Break one.
9. **Sunbreaker.** Six lines from three Fusion Plants. Erase plants to see the passive floor; break one to see a blast cut four lines.
10. **Feed: a Combiner flavours a line.** One Pip fires incendiary, its neighbour plain.
11. **Crossing.** A cryo pipe crosses two power lines through Passthroughs to a Scorcher.
12. **Discharge.** A Longbarrel straight on reactors against one behind Surge Cells: 4.7 s against 3.7 s a shot.
13. **Threshold.** A Hammer on a reactor (nothing) against one on a Joiner Bank.
14. **Two feeds.** A Slurry Cannon: power from a Cell Battery, tungsten from tanks touching it.

The page also opens any design from its address: `ports.html#design=<json>` (the evolver's Open in lab) or
`ports.html#file=evolved/<scenario>.json` when served over http (the evolver writes each scenario's latest best there;
`evolved/index.html` lists them).


## 9. Weapon power profiles (2026-11-02)

Owner's direction: every weapon wants its power differently, and that is part of its identity. Generators sitting
straight against guns should be the starter's answer, not everyone's. Each profile pushes towards a different structure.

### 9.1 The profiles (all in the lab's model)

| Profile | Rule | What it rewards |
|---|---|---|
| Direct | takes power from anything, any rate | nothing: starter simplicity |
| Passive | leaks this much a second whether it fires or not; below it, never charges | supply well above need |
| Discharge | its ports shut for this long after each shot | a buffer in front (a Capacitor or Surge Cell catches what arrives meanwhile) |
| Rest | a beam that burns out shuts its ports for this long | a buffer, or a beam that never burns out |
| Burst (owner, 2026-11-03) | a beam whose ports are shut while lit: it lights only when full, burns the whole buffer, rests, then recharges | a store in front that pours fast (the recharge is the wait), and enough supply to refill it in time |
| Threshold | takes power only from lines rated at least this much together (a link's rating is the lower of its two ports) | joining lines (a Joiner, a Flux Coil) or a store in front |
| Steady | while charging, a tick with less than this arriving collapses the charge | a line of its own, smoothed, not shared |
| Clip | empties, then refills the whole clip | a high-output store |
| Multi-port | lines from several sides | power from all round the ship |
| Feed | a second input (§10) | a feed line or a tank at that edge |

Profiles combine: the Sunbreaker is multi-port, passive and discharge; the Spear is steady and passive.

Discharge, worked: a 60 E shot, a 1 s discharge and a 30 E/s reactor. Direct, it fires every 1 + 60/30 = 3 s (the
reactor's output in that second is wasted). Behind a buffer that can give fast, every max(60/30, 1 + 60/out) = 2 s.
The lab's example 12 (a Longbarrel) shows 4.7 s against 3.7 s from the same two reactors.

### 9.2 First assignment

| Weapon | Profile |
|---|---|
| Pip | direct |
| Glint | discharge 0.3 s |
| Hammer | threshold 45 |
| Cutter (beam) | burst, passive 5, rest 1.5 s |
| Longbarrel | discharge 1 s |
| Spear | passive 10, steady 50 |
| Bastion | clip 16, passive 15, four ports |
| Lance (beam) | burst, passive 40, rest 2 s |
| Sunbreaker | six ports, passive 150, discharge 1 s |
| Scorcher (new) | feed (required), a beam |
| Slurry Cannon (new) | feed (required), threshold 40 |

New store for discharge: the **Surge Cell** (takes 120, gives 300, holds 120): a buffer fast enough on both sides to
catch a whole plant line while a gun is shut. The Capacitor (takes 40) does the same for a reactor's line.

## 10. The feed layer (revised 2026-11-03)

Owner's direction, over 2026-11-02/03: not fuel for power (that's only logistics) but a second network carrying
materials that reshape what guns and engines do, as sidegrades (something better, something worse), not as straight
bonuses and not as elemental effects (ammo types will carry those). No hazards. Only some guns take feed (about a third
of mid-level guns, half of high-level ones; none of the starters); some have a discrete feed input beside their power
input. Thrusters take feeds that modulate their stats, on one or two existing engines, plus a new thruster built for the
system. The pilot can switch which feed is hooked up, which needs two tanks and their lines.

### 10.1 Rules (as built in the lab)

- **Tanks** hold one material (120). Touching tanks of the same kind join. **Pipes** join anything with a feed point, on
  any side; a pipe crosses a power line only through a **Passthrough** (a conduit with a pipe through it, side to side).
- **A feed buffer** on every gun or engine that takes feed, beside its energy buffer. A shot (or a second lit or
  thrusting) uses some. **One kind at a time:** anything holding a material refuses another until it is empty. That is
  true of guns, engines, Combiners and lines alike.
- **Two ways in.** (a) A **feed port**: the part's own feed input on a given edge, fed by a pipe or a tank touching it;
  required on some guns (no feed, no shot). (b) A **combined line**: a **Combiner** (power in at its back, material on
  its side, one line out; it holds no charge, so it is tough and never explodes) puts the material onto a power line,
  and the conduits carry it on, one kind at a time, into a gun that takes it. **Batteries and capacitors carry power
  only**, so the Combiner goes after them (store → Combiner → gun). A gun that doesn't take the material blocks it, and
  the line backs up to the Combiner (the hangar warns).
- **A Selector** has two feed inputs and one output and passes one at a time; the pilot switches it. The old material
  runs out of the lines and buffers before the new one arrives, so the changeover takes as long as the buffers are
  deep: a real trade-off between buffering and quick switching. **Purge** dumps the buffers for an instant switch,
  wasting what was in them.
- **Compatibility:** each gun or engine lists the materials it takes; most guns take none. A material it doesn't take
  never enters it.
- **Costs:** the parts, the space, the routing and the consumable. Nothing explodes or leaks.

### 10.2 Materials (first numbers)

Each multiplies some of a part's stats. A part may respond more strongly (the Reaction Thruster).

| Material | For | Gives | Costs |
|---|---|---|---|
| Overcharge slurry | guns | damage ×1.3, discharge ×0.5 | energy a shot ×1.4 |
| Coolant | guns | discharge ×0.5, rest ×0.5 (less buffering needed in front) | damage ×0.85 |
| Damping gel | guns | threshold ×0.5, steady ×0.5 (a weak or shared line will do) | cycle ×1.25 |
| Flux salts | guns | energy a shot ×0.7 (more shots per reactor) | damage ×0.85 |
| Accelerant | guns | cycle ×0.7 | energy a shot ×1.25, threshold ×1.5 |
| Lens fluid | beams | burn ×0.75 (longer bursts from the same buffer) | dps ×0.9, rest ×1.5 |
| Catalyst | engines | burn ×0.6 (power freed for guns) | thrust ×0.85 |
| Reaction mass | engines | thrust ×1.4 | used fast |
| Burst gel | engines | boost ×1.5, boost drain ×0.5 | thrust ×0.9 |

### 10.3 Who takes what (the lab's set)

| Part | Takes | How |
|---|---|---|
| Pip, Glint, Hammer, Bastion | nothing | — |
| Cutter (beam, 18) | Lens fluid, Coolant | combined line |
| Slurry Cannon (16) | Overcharge, Accelerant, Flux | its own feed port, required |
| Longbarrel (20) | Overcharge, Coolant, Flux | combined line |
| Spear (28) | Damping gel, Overcharge | combined line |
| Lance (beam, 32) | Lens fluid, Coolant | combined line |
| Sunbreaker (34) | Overcharge, Coolant, Damping gel | combined line (any of its six) |
| Ion Drive | nothing | — |
| Plasma Drive (16) | Catalyst, Reaction mass | combined line |
| Reaction Thruster (new, 12) | Reaction mass, Catalyst, Burst gel | its own feed point; on power alone 1.0 thrust for 4 a second, on Reaction mass 5.0 for the same 4 |

### 10.4 Later

Mixers (two feeds into one combined effect), a Purge valve part (per line, not global), shields and mining tools
taking feed (recharge against capacity, yield against power), engine feeds that touch rated speed and turning.

## 11. Staging (by level)

A new player learns one network at a time.

| Level | What opens |
|---|---|
| 0 | Power: reactors, conduits and corners, the Cell Battery, direct guns (Pip), Ion Drives |
| 3–7 | Joiner and Splitter Banks, Capacitors, the first profiled guns (Hammer: threshold) |
| 8–10 | The feed layer: tanks, pipes, Passthroughs, Combiners, Scrubbers; Scorcher |
| 10–20 | Surge Cell, Drive Cell, discharge and rest guns (Glint, Cutter, Longbarrel), Slurry Cannon, Fusion Plants, Flux Coil, Heavy Bank |
| 20–30 | Steady and clip guns (Spear, Bastion), Overclock Reactor, Capacitor Array |
| 30+ | Superweapons (Lance, Sunbreaker), Stellarator; later: heat, voltage |

Every power and feed part past the starters should be earned (rare inputs, blueprints from bosses and factions,
research), so a build is something a player sets out to make. That needs the cost audit (effort to acquire, not guessed
values) before the numbers mean anything.

## 12. The ports evolver

`npm run evolver:ports` (`scripts/shipgen/evolver/ports_app.py`; headless: `python ports_evolve.py "<scenario>" <gens>`;
a batch of every scenario: `python ports_batch.py`). Ships are the lab's parts, scored by the lab's own model
(`ports_score.cjs`), so the evolver and the lab can't disagree.

- **Scoring:** a 30 s power phase (burst fire), then hit runs until the core goes (blasts, hazards, chains). A shot is
  worth its impact after the enemy's armour (its pen plus its feed's), plus its burn, splash and mark as the scenario
  values them; slow and disrupt build a suppression that thins the incoming fire. Each measure is scored against the
  scenario's fixed scale (what counts as 1), so penalties weigh the same whatever the start.
- **No router in evolution.** Changes are random; some are aimed: a part put so one of its ports faces an open port
  (a plain conduit or corner most times); a pipe or tank put against an open feed point; a straight Conduit made a
  Passthrough where a pipe needs to cross; an engine where nothing of the ship is behind it; a part moved a cell.
- **The start ship** (owner's original idea: the most basic connections, then evolve): hull over the outline, an
  upright core with a reactor above and below, Pips and Ion Drives on the silhouette's marks, the core's two right-hand
  lines laid as conduits to the nearest gun and engine, and a Cell Reactor straight behind every other one. A
  scenario's start parts (the Capital's Sunbreaker, the Siege's Longbarrels) are fixed like the core.
- **Wiring rewards** (owner, 2026-11-02): for each unfed gun or engine port, the share of its shortest path to power
  built with conduits pointing the right way, fully once power reaches them; every conduit still carrying power at the
  end; for each Combiner or feed gun without feed, the share of its shortest path to a tank built with pipes.
- **Idle penalty:** parts doing nothing (a store or line nothing passed through, a generator wasting every line, pipes
  and tanks on a network without both a tank and a user, pipes off every shortest path from a user to its tanks).
- **Scenarios:** Gunship (level 20), Capital: Sunbreaker (36), Raider (burn valued as much as the hit, light armour),
  Siege (armour 5: penetration matters).


## 13. What the evolver found overnight (2026-11-03)

Five batches (every scenario, two seeds each, up to 2,000 generations). Most of the night went on loopholes in the
scoring, each one a ship design that scored well for the wrong reason. They are worth knowing because a player would
find the same ones in a real ruleset.

| Loophole | What ships did | Fix |
|---|---|---|
| Wiring credit only for unfinished lines | left lines one cell short forever | every port counts; a fed one scores 1, so finishing always wins |
| "Systems kept" averaged only over what the ship had | threw away every gun, then counted 100% kept | a missing system counts as 0; firepower weighs 60% |
| Pipes weigh 0.3, hull 1 | 40–60 pipes as light hull to meet the thrust target | pipes off a tank-to-user path are idle; pipes and conduits weigh 0.8 |
| Hits too weak | outlived the 120 s fight, so reactor placement didn't matter | 200 a second incoming (300 for the Capital) |
| Unfed start guns cost points | deleted the Siege's Longbarrels and the Capital's Sunbreaker | start parts are fixed |
| Scores against the start ship | a weak start made gains huge and penalties invisible | fixed scales per scenario |
| Any one-in-one-out part as wire | Scrubbers and Passthroughs laid as conduit | aimed lines are plain conduits |
| Live conduits rewarded by count | 42-cell live snakes outscored the Sunbreaker | dropped |
| No rule that a ship is one piece | guns and their reactors floating off the hull | parts not joined to the core pay (detached) |
| One scorer crash lost a whole batch | (tooling) | the scorer restarts; a failed run keeps its best |

The gallery's ships (best of two seeds each):

| Scenario | Score | Damage a second | Dealt before the core went | Thrust for mass | Guns: links straight from a reactor |
|---|---|---|---|---|---|
| Gunship | 3.19 | 240 | 4,774 in 101 s | 0.124 (target 0.12) | 67% |
| Raider | 1.75 | 148 | 3,662 in 96 s | 0.088 | 0% |
| Siege | 0.38 | 19 | 296 in 111 s | 0.120 | 50% |
| Capital (an earlier batch, before the detached rule) | 0.70 | 142 | 3,129 in 146 s | 0.014 (target 0.06) | 0% |

What it says about the design itself (with the caveat that the search is still weak: two seeds of one scenario can
differ fourfold):

- **Generators next to guns is still common** (often every gun link straight from a reactor, every gun within a blast)
  in the cheap scenarios, but not in the Siege or the Capital, where the guns need joined or buffered lines. That
  supports profiles (threshold, discharge, steady) as the lever against it: direct wiring stays the starter's answer
  and stops working for heavy guns.
- **The feed layer gets used when it pays and dropped when it doesn't.** One gunship run did 98% of its damage with
  feed-carrying shots (tungsten and incendiary through Combiners); other runs carried none. In the Siege, tungsten is the
  difference between a Longbarrel doing 55% and 115% damage, and runs that found it scored best.
- **Thrust is the hardest thing to evolve** and was the largest loss in most runs: engines need wiring at the far end of
  the ship. The engine change helps; a real game would give the hangar an engine budget the player sees.
- **The Siege is unsolved.** Its Longbarrels are fixed in place, but no run built them a working joined or buffered
  line with tungsten; they deal 19 a second. Either the search needs a heavy-gun seed line (as the start ship has for
  Pips) or the scenario is asking too much of 1,200 generations.
- **The Capital barely moves** (its thrust is a quarter of the target) and is slow to evolve (about 4 s a generation).
- **Heavy weapons need help to be found.** Random search rarely builds a Joiner tree to a heavy gun from scratch, so the
  Siege and Capital start with their guns fixed in place and evolve the ship around them. That matches the design
  intent anyway: you decide on the superweapon, then build its ship.

Results are in the gallery: `prototypes/energy-lab/evolved/index.html` (over http: the lab server, then
`/evolved/index.html`), each ship opening live in the lab.

## 14. In the dev game (2026-11-03)

The ports core runs in the game for any design whose blueprint says `"power": "ports"` (`common/src/ships/power/ports.ts`;
the lab's `ports-model.js` is the reference). Such a ship gets `ShipDerived.ports` instead of `.power`; everything else
reads `power` as optional. The hooks are the same places the pool-and-banks system uses:

- `rebuild.ts` builds the layout (ports placed in each part's own frame: a gun's or engine's back is its back whatever
  its facing; links where an out port faces an in port across a shared edge; feed networks by union-find through
  pipes, tanks, Passthroughs and Combiners; Selectors look across). Every part on a ports ship is "satisfied": the
  core decides what each gets, every tick.
- `energy.ts`: `Charge.e` holds the parts' state; `powerTick`, `thrustShare` (each engine's share and its boost,
  folded in: a ports ship's `boostFactor` is 1), `remapCharge`, `chargeTotal`, `packCharge`/`unpackCharge` branch on
  it. The pilot row carries `(part, held×8+flags, closed·2^24+mat·2^20+amt)` triples for every part not full, counted
  negative in `data[9]` (`PORTS_SLOT_LAYOUT` is in the wire hash: protocol 23), the layout's sig in `data[8]`. A client
  reads the row once it has the layout (`ensurePortsCharge`, in `ShipClient.predict`/`predictGuns`).
- `guns.ts`: a gun fires a shot's worth from its own buffer (`portsGunReady` / `portsSpendShot`: discharge shuts its
  ports, material comes off its feed buffer and may scale the shot's damage); a clip's rounds are what its buffer holds
  and it latches, reloading, until full; a beam lights and burns through `portsBeamStep` (a burst beam only when full,
  resting after). Guns' energies are today's (`gunDraw`'s: draw × beat, a clip's reload energy, a charge gun's charge),
  not the routing data's `fire.shot/intake/burn`.
- Server: a spawn gives a ports ship a full state (`fullPortsCharge`); `feedSwitch` (key **Y**) flips every Selector.
- Data (`scripts/econ/models.mjs`, the "ports energy core" block): every generator, store and consumer's ports; profiles
  and `takes` on about a third of the mid guns and half of the high ones (Hammer threshold 40, Longbarrel discharge
  1 s, Bastion threshold 90, Spear steady 30, Cutter and Lance burst beams, Singularity passive 30); the feed parts
  (Joiner Bank, Splitter Bank, Surge Cell, Corner Conduit, Combiner, Passthrough, Feed Pipe, Selector, nine tanks),
  the Reaction Thruster and the Slurry Cannon; `tuning.json feeds` is the material table. The core's ports are in
  `functions.json`.

Three dev ships (F9, `data/ships/blueprints/dev/ports-*.json`; `common/src/ships/power/ports.test.ts` checks them):
**Ports Gunship** (six reactors into the core and two corner lines, a Pip and two Rattlers, three Ion Drives);
**Ports Lancer** (a Lance on a Combiner line, a Selector between Coolant and Lens Fluid, its second port on a battery
line round two corners); **Ports Slurry Raider** (the Slurry Cannon's Accelerant crossing its power line through a
Passthrough, two Reaction Thrusters on one Reaction Mass tank).

Not in this cut: the hangar draws no port glyphs and its load test skips ports ships; tanks refill only on a rebuild
(a respawn or swap); mining lasers and part features (Tow, Strafer, Flash) are unaccounted on a ports ship; shields
draw their buffer but their `sat` isn't wired to the shield; a hazard's battery cap is ignored.

## 15. Two ways to arm a ship: infrastructure tiers (2026-11-03)

The owner's framing: a ship is armed one of two ways. **Simple guns** need almost nothing (a Cell Reactor at the port),
so a ship carries many of them: a spammer, resilient, nothing worth sniping. **Infrastructure guns** need rated lines,
stores and feeds that eat the parts quota, so a ship carries two or three, and each must be much better and look it:
harder per shot or a frightening rate. The unit of balance is the gun **and the cheapest rig that runs it**.

Every powered gun has a tier (`infra.tier` in models.mjs, the `INFRA` table) and the tier sets the line rating it needs
at each port (`profile.threshold`, the gun's port ratings raised to match):

| Tier | Line at each port | Cheapest rig that passes | Damage a cell, target |
|---|---|---|---|
| simple | none | a Cell Reactor (35) | the simple guns' mean, 24 |
| mid | 50 | an Overclock Reactor (70), or a Battery (60) on a reactor | 1.2x |
| heavy | 85 | a Fusion Plant (100) | 1.4x |
| super | 120 | Surge Cells (300) on a Fusion Plant | 1.6x |

A material that raises the threshold (Accelerant, x1.5) needs a heavier rig; Damping Gel (x0.5) lets a lighter one
through: a feed choice that is also an infrastructure choice. The core gives 150 at its N and S ports, so a gun fed
straight off the core passes any tier: one or two guns can sit there.

`infra.damage` pays for the rig, on ports ships only (`portsSpendShot` for shells, `portsDamageMul` in the server's beam
and pulse damage). It was set by measuring every gun on the four rigs through the game's own ports core (10 s to spend
its starting charge, then 60 s of fire; a semi-automatic gun clicked; a beam counted by the time it is lit, so a burst
beam's rests count), picking the rig with the most damage a cell, and solving for the tier's target, between 1 and a cap
(mid 2, heavy 2.5, super 3). The burst beams' rests were shortened (Cutter 0.5 s, Lance 1 s) so their duty can reach it.
Ammunition guns keep their damage (they pay in rounds), as do support guns and legendaries. A gun takes at most its own
intake a tick, however well rated its lines (the rating gates it; the intake keeps its rhythm).

| Gun | Tier | Fires on a simple, mid, heavy, super rig | Best rig | Cells | Dmg/s | Damage × | Dmg/s per cell |
|---|---|---|---|---|---|---|---|
| Pip | simple | ●●●● | simple | 2.0 | 56 | 1 | 28.0 |
| Strobe | simple | ●●●● | simple | 2.0 | 54 | 1 | 27.0 |
| Glint | simple | ●●●● | simple | 2.0 | 53 | 1 | 26.7 |
| Spark | simple | ●●●● | simple | 2.0 | 45 | 1 | 22.7 |
| Rattler | simple | ●●●● | simple | 2.0 | 43 | 1 | 21.4 |
| Stinger | simple | ●●●● | simple | 2.0 | 36 | 1 | 17.8 |
| Lobber (ammo) | simple | ●●●● | simple | 2.0 | 28 | 1 | 14.0 |
| Dart (ammo) | simple | ●●●● | simple | 2.0 | 28 | 1 | 14.0 |
| Burst (ammo) | simple | ●●●● | simple | 2.0 | 26 | 1 | 12.9 |
| Eel (ammo) | mid | ●●●● | simple | 4.0 | 117 | 1 | 29.3 |
| Hammer | mid | ·●●● | mid | 4.0 | 117 | 1.7 | 29.1 |
| Chainsaw | mid | ·●●● | mid | 4.0 | 116 | 1.45 | 29.0 |
| Coilgun | mid | ·●●● | mid | 4.0 | 116 | 1.3 | 28.9 |
| Twinlink | mid | ·●●● | mid | 4.0 | 115 | 1.85 | 28.6 |
| Slurry Cannon | mid | ·◐●● | mid | 5.0 | 108 | 2 | 21.6 |
| Overpulse | mid | ·●●● | mid | 4.0 | 80 | 2 | 20.0 |
| Searchlight | mid | ·●●● | mid | 2.8 | 50 | 2 | 18.0 |
| Cloudmaker | mid | ·●●● | mid | 4.0 | 50 | 2 | 12.4 |
| Needle (ammo) | mid | ●●●● | simple | 4.0 | 50 | 1 | 12.4 |
| Swarm (ammo) | mid | ●●●● | simple | 3.0 | 36 | 1 | 12.1 |
| Quake (ammo) | mid | ●●●● | simple | 4.0 | 43 | 1 | 10.6 |
| Leviathan (ammo) | heavy | ●●●● | simple | 6.0 | 229 | 1 | 38.2 |
| Tesla | heavy | ··●● | heavy | 4.8 | 161 | 2.3 | 33.6 |
| Cutter | heavy | ··●● | heavy | 6.0 | 194 | 2.5 | 32.3 |
| Bastion | heavy | ··●● | heavy | 8.0 | 250 | 2.5 | 31.2 |
| Rail Driver | heavy | ··●● | heavy | 8.0 | 240 | 2.5 | 30.0 |
| Spear | heavy | ··●● | heavy | 8.0 | 211 | 2.5 | 26.3 |
| Longbarrel | heavy | ··●● | heavy | 6.0 | 121 | 2.5 | 20.2 |
| Hammerhead (ammo) | heavy | ●●●● | simple | 6.0 | 44 | 1 | 7.3 |
| Lance | super | ···● | super | 8.0 | 240 | 3 | 30.1 |

Reading it: the lighter rigs never fire a mid, heavy or super gun once its starting charge is spent (the dots), so the
tiers are forced, not advised. Mid guns land on 1.2x (29 a cell) where the cap allows; the Overpulse, Searchlight and
Cloudmaker stay under it at the cap (their worth is the mark and the area). Heavy guns land on 1.4x (31-34) except the
Longbarrel and Spear, paid instead in reach and pierce. The Lance is at 30 a cell even at 3x, because its rests are long;
lit, it burns 630 a second.

Build points still follow grade (a Bastion is cobalt, Mk IV), so a heavy build costs more points as well as more cells:
the Monitor below is 82 points against the Hornet's 48. Whether that double price is right is for testing.

Example ships (F9, Ports energy): **Hornet** (eight simple guns, each on its own reactor: 416 dmg/s, 48 cells),
**Brawler** (a Hammer and two Twinlinks on Overclocks: 346, 42 cells), **Monitor** (two Bastions on Fusion Plants, 450 a
ball: 500, 52 cells), **Pike** (one Lance on Surge Cells over a Fusion Plant with Lens Fluid: 630 while lit, 43 cells).
The scratch tools that made the table and the ships (measure.mjs, design.mjs) are not in the repo.
