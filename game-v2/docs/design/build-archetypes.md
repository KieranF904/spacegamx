# Build archetypes: a discussion draft

*Status: for discussion with Kieran, 2026-10-31. Nothing here is built. Part and archetype names are placeholders.*

The goal from Kieran's brief: many valid builds, each **situationally much better and generally worse**, so the
job decides the ship rather than the level. This draft looks at what pushes builds together today, suggests 15
archetypes worth supporting, the mechanics that would support them, and a short list of parts ranked by how much
variety they add for the work involved.

---

## 1. Diagnosis: why builds converge today

The parts redesign (docs/parts-redesign.md) fixed a lot on the **weapons** side. Weapon families now have different
verbs (beam, homing, chain, splash, pierce, EMP, lobbed, ammo vs energy) and real fitting rules (attach edges, side
mounts, arcs, clear lanes). **Movement, power and utility are still mostly one dial each.** The evidence:

| Area | What the code does | Why it converges |
|---|---|---|
| **Engines** | Every engine is the same mechanism: continuous thrust per cell, a draw per cell, a rated speed it fades towards (`thrust × (1 − (v/rated)^6)`), and the same hold-to-boost multiplier (flight.ts `thrustAlong`, energy.ts `powerTick`). | The seven models differ only in numbers. Thrust per unit draw sits in a narrow band (Ion 0.22, Afterburner 0.20, Plasma 0.155, Fusion Torch 0.13, Torch 0.12; only Vernier and Drift Sail at 0.30 stand out). There's no engine that *behaves* differently: no impulse, no spool-up, no fixed-duration burn, no directional bias. So "more Plasma/Fusion, pointed every way" wins. |
| **Strafing** | Strafe is just the thrust from whichever engines point sideways (`thrustAlong` over `d.thrusters`), with the core's `maneuverForce` (3) as a floor. | Agility is bought with the same parts as cruising, so a nimble ship is just a ship with more engines. There's no part that's *only* good at dodging. |
| **Energy** | Generators stream power (`spare`); three stores (general, drive-only, weapon-only). Engines take power first; guns pay per shot from stores; shields, scanners and coils are steady loads taken off the top (energy.ts header). | Three pools, but one rule: *more generation and more storage are always better*. Batteries have unlimited discharge rate, so there's no difference between a big slow bank and a small fast capacitor apart from which pool it fills. Reactors differ only in output per cell vs durability/blast. Nothing makes a burst-shaped ship differ from a sustained-shaped ship. |
| **Heat** | Only the Lance and Frostbite beams have heat (`heatPerSec`/`coolPerSec`, per weapon). Warmth (cold) is a ship meter, but only the environment and frost hits move it. | No ship-wide second resource, so the only thing that limits sustained output is the energy budget, which scales with reactor count. |
| **Mass** | Mass slows thrust and turning (`accelAlong`, `turnAccel`); Bastion and Fusion Plant are the only "heavy on purpose" parts. Cargo has **no mass** (no cargo-weight term in rebuild/flight). Dense Ferrite has a `mass_anchor` trait. | Hauling costs nothing but hold space, so a hauler is just "any ship plus holds". Heavy ships get no upside apart from HP, because nothing in the world pushes or pulls in a way that mass resists (the Singularity pull and the Scrap Mother's magnets are the exceptions, and they're boss moves, not something to build around). |
| **Tiers** | A model's `grade` (about unlock level ÷ 8) sets armour penetration; damage per cell rises about 1.5× across a family; materials climb Alloy → Neutronium with `output` 1 → 2.6. | Within each family the later model is usually a straight upgrade. Structure materials are still a ladder: Neutronium is the best plate except where its weight matters, and weight rarely matters (see above). The special materials (Insulated Polymer, Ceramic Laminate, Leaded Iridium...) are the healthy exception: real trade-offs. |
| **Utility** | Shields are a single regen pool (`regenPerSecond` 0.14, 180-tick delay). Repair is a passive out-of-combat heal (`tuning.repair`). There's no repair-other, no shield-other, no power transfer, no tow, no point defence, no drones. | Party play is "several DPS ships". No build gets anything from *being* in a party apart from damage. |
| **Content** | Jobs are mostly deliver / hold / kill / mine / travel / recover / boss (quests.json). Operations add escort / defend / uplink; there are sieges and nests. | Almost every job is answered by "kill things faster" plus some cargo space. Hauling, travel and cold ask little of the build, so they can't reward a specialist. |

**In one line:** the weapons got verbs, but engines, power, mass and utility are still single dials, and content
rarely asks a question that a combat build can't answer. Archetypes need **(a)** parts with a different *shape* of
trade-off (not just bigger numbers), and **(b)** content that rewards the shapes.

---

## 2. The archetypes

Fifteen builds. Each should be the best answer to something and a poor answer to most things. "Relies on" lists
existing parts first, then **new** part ideas (marked ✦; section 5 ranks them).

### 2.1 Dancer (dodge duelist)
*Light, twitchy, never where the bullet is.*

- **Excels:** boss bullet-hell phases, dodge-heavy mob packs, PvP duels.
- **Clearly worse:** escort (can't tank or stay put), hauling (no cargo, no mass budget), long travel (burst engines are inefficient to cruise on), cold (tiny reserves).
- **Loop:** read the telegraph, tap a burst strafe sideways through the gap, snap back to shoot during the boss's recovery window. Its energy is spent mostly on movement; it shoots in the openings.
- **Relies on:** Verniers, a small light main engine (Ion), Composite or Insulated Polymer hull, turrets so it can shoot while sliding (Glint, Rattler, Stinger). ✦ **Burst Strafer** (fixed-duration side impulse with charges), ✦ **Gyro Flywheel** (fast turn, costs mass).
- **Energy:** spiky. Big drive store, small gun draw. Starves its guns if it dodges too much.
- **Counters:** sustained area denial (Cloudmaker/mortar fields, pools), homing that tracks a strafe, getting caught empty after a chain of dodges. Fragile: one mistake costs a lot.
- **Party role:** boss "point" pilot: pulls the boss's aim and dives into windows. Pairs with a Warden behind it.
- **Content:** every boss stage that's built on readable patterns (docs/boss-design.md "movement punished, standing still punished more"); Pyreclast mark/lane moves.

### 2.2 Longshot (kiting sniper)
*Kills from outside the fight.*

- **Excels:** bosses with long-range phases or soft spots to pick off (shooting weapon parts off in stage 1), nest clearing from range, defending a fixed point against things approaching.
- **Clearly worse:** close brawls, swarms, anything fast that closes in; fixed guns need a straight line, so it can't fight while running away.
- **Loop:** hold range, line up the nose, fire slow heavy shots, back off when something closes. Repositions often, fires rarely.
- **Relies on:** Longbarrel, Needle, Spear, Searchlight (side-mounted, 360°), Long-Range Array. Clear-lane rules shape it: a long spine with clear lanes ahead. ✦ **Stabiliser Anchor** (brace for range and accuracy), ✦ **Targeting Uplink** (paint a target for the party).
- **Energy:** steady, low. A sniper's draw is small per second; spends it in big packets (Spear draw ×2.2). Doesn't need much drive.
- **Counters:** gap-closers, interceptors, swarms, flak screens; EMP while braced.
- **Party role:** removes key parts (shield emitters, weapon pods) and paints targets for others.
- **Content:** boss parts that need to be shot off; sieges where the enemy approaches across open space; PvP zone overwatch.

### 2.3 Blinker (burst-blink striker)
*Appears, unloads, vanishes.*

- **Excels:** boss vent/opening windows (a 150% damage window needs to be hit hard and fast), assassinating priority targets in a pack, short-hop exploration.
- **Clearly worse:** sustained fights (one strike then a long recharge), escort (can't stay with a freighter), mining (nothing to spend the burst on).
- **Loop:** charge a short-range jump; blink into the opening; dump capacitors into the target; blink or burst out before the window closes. Then cool down and play safe.
- **Relies on:** the jump drive's existing charge/burn/cooldown loop (flight.ts `stepJump`) but at combat range, Capacitors, Cutter (fixed, close, brutal), Hammer. ✦ **Blink Coil** (micro-jump of a few hundred units, long cooldown), ✦ **Discharge Capacitor** (dumps fast, recharges slowly).
- **Energy:** extreme burst. Two banks, both full before a strike, both empty after.
- **Counters:** being caught in the cooldown; enemies that punish proximity (Scrap Mother claws); EMP during the charge.
- **Party role:** finisher: waits for the Disruptor's stun or the boss's vent, then bursts.
- **Content:** boss windows; "kill the leader" jobs; PvP ambushes.

### 2.4 Bulwark (tank brawler)
*Stands in the fire so the freighter doesn't have to.*

- **Excels:** escort and defend operations, holding a point (hold jobs, uplinks), sieges, absorbing a boss's aim for a party.
- **Clearly worse:** bullet-hell dodging (big and slow), travel (heavy), mining (wasted mass), anything with a timer.
- **Loop:** park between the threat and the objective, keep the shields up, brawl with short-range guns. Turns to face damage on its armoured side.
- **Relies on:** Spaced Plating, Reactive Armour, Bulwark Projector, Bastion, Dense Ferrite (mass anchor), Isotope Pile (tough, never explodes). ✦ **Aggro Beacon** (draws enemy fire), ✦ **Brace Mode** for shields (more shield, no thrust).
- **Energy:** sustained, shield-heavy. Its reactors feed shields, not engines or guns. Starves mobility.
- **Counters:** being ignored (enemies that go round it for the objective), armour-piercing (Spear, Lance), EMP, pull effects if it's not anchored.
- **Party role:** the classic tank. Needs aggro tools to matter, which is the part to build first.
- **Content:** escort operations, defend operations, sieges, nests, boss stages with a heavy single-target beam (a tank on that line protects the party).

### 2.5 Carrier (drone master)
*Fights through a cloud of small friends.*

- **Excels:** swarms and nests (drones split targets), escort (drones screen while you stay with the freighter), party support (drones that repair or shield).
- **Clearly worse:** bosses with heavy area damage (drones die), solo burst damage, travel (the bays are heavy), PvP versus flak.
- **Loop:** launch a wing, give it a stance (guard me / attack my target / screen that ship), refill and relaunch when it's lost. The pilot plays a manager.
- **Relies on:** Hive (already a homing swarm) as the stepping stone. ✦ **Drone Bay** (stores and launches drones, which cost energy or parts to rebuild).
- **Energy:** steady, with a recharge cost per drone lost. Starves its own guns.
- **Counters:** flak, Cloudmaker, arc chains, EMP (drones go limp), bosses with sweeping beams.
- **Party role:** off-tank via screening drones; support via repair drones.
- **Content:** escort, nests, sieges, mining protection (drones guard the miners).
- **Note:** the most expensive archetype here (AI, network cost, rendering). Hive shows the minimum version.

### 2.6 Freighter (heavy hauler)
*A slow wall of cargo that earns the most per trip.*

- **Excels:** hauling and delivery jobs, trade runs, supplying a siege or a party base.
- **Clearly worse:** combat of every kind, bosses (a death sentence), cold (big hull loses warmth fastest if insulation scales by area).
- **Loop:** plan the route, keep momentum (it's slow to stop), call for escort through dangerous systems, dock and unload.
- **Relies on:** cargo holds, Drift Sails, Fusion Torch for long-haul, Isotope Piles. Needs **cargo to have mass** to have an identity at all. ✦ **Cargo Clamp / external container** (carries a big container outside the hull: huge capacity, ruinous handling, can be jettisoned).
- **Energy:** low and even. Wants efficiency, not power.
- **Counters:** anything that catches it; it can't run. Interceptors and a Bulwark keep it alive.
- **Party role:** the escorted. Pays the party (bigger loads, bigger rewards to share).
- **Content:** deliver/courier jobs scaled by cargo weight; siege supply runs; escort operations where a *player* is the freighter.

### 2.7 Pathfinder (deep-cold explorer)
*Goes where others freeze and comes back with the map.*

- **Excels:** cold systems, long travel, exploration and recovery jobs far from stations, scouting for a party.
- **Clearly worse:** bosses (light weapons), hauling (small hold), sieges.
- **Loop:** plan jumps between heat sources (stars' rings, Stillstones), keep the warmth meter in the green, scan ahead, choose fights rarely.
- **Relies on:** Insulated Polymer, Ceramic Laminate, Sealed Composite hulls (insulation 0.3/0.15/0.1), Jump Coils, Long-Range Array, Drift Sails, Isotope Piles. ✦ **Heater Core** (turns spare power into warmth), ✦ **Thermal Store** (stores heat from a star for later).
- **Energy:** low, long. Generation goes to heat and scanning, not guns.
- **Counters:** ambush on the way; anything that forces it into a long fight in the cold.
- **Party role:** scout and route-finder; can warm a party with a ✦ **Heat Lamp** (shares warmth nearby, like `burning` already does by accident).
- **Content:** cryo systems, far recovery jobs, the Hoarfrost/Brood areas, jump-range puzzles (Stillstones).

### 2.8 Prospector (dedicated miner)
*Eats asteroids; hates being interrupted.*

- **Excels:** mining jobs, ore income, siphoning gas, clearing lanes (constructor jobs).
- **Clearly worse:** anything that shoots back.
- **Loop:** scan a field, pick the rich rocks, set up (brace for steadier beams), mine in long cycles, haul back or hand off to a Freighter.
- **Relies on:** Mining Laser, Bore, Demolition Launcher, Siphon, Scanner, cargo. ✦ **Ore Scanner** mode (reveals ore quality), ✦ **Spool-up Bore** (slow to start, stronger the longer it runs).
- **Energy:** sustained miner draw (paid in segments: energy.ts `payMining`). Starves engines while mining.
- **Counters:** raiders, interrupted cycles (a spool-up bore loses its stacks).
- **Party role:** feeds the party; pairs with a Freighter (hand-off) and a guard (Interceptor or Carrier).
- **Content:** mining jobs, asteroid fields in dangerous systems, nests on rich fields.

### 2.9 Warden (support: repair and shields)
*Keeps everyone else alive.*

- **Excels:** party boss fights, sieges, escort (repair the freighter), long party operations.
- **Clearly worse:** solo anything; it barely shoots.
- **Loop:** stay behind the fight, keep the beam on whoever is hurt, drop a shield on the one about to take a hit, manage its own energy so it doesn't run dry mid-fight.
- **Relies on:** shields, Constructor (closest existing thing: builds), lots of generation. ✦ **Repair Beam** (heals another ship's parts, costly), ✦ **Shield Projector** (puts a temporary shield on another ship), ✦ **Power Link** (sends energy to an ally).
- **Energy:** sustained and high; its whole output goes to others.
- **Counters:** being focused (it's the first target in PvP), EMP, being out of range.
- **Party role:** the healer. Makes every other archetype braver.
- **Content:** party bosses, sieges, escort. Needs a "party reward share" so playing support earns as well as killing.

### 2.10 Bombard (siege artillery)
*Slow, far, and devastating to things that sit still.*

- **Excels:** sieges, nests, stationary bosses or boss stages that hold home, enemy structures.
- **Clearly worse:** anything mobile; dodging; travel; small fast enemies.
- **Loop:** pick a spot, anchor, lob shells over the arc to where the enemy will be, call corrections from a spotter.
- **Relies on:** Lobber, Quake, Hammerhead, Leviathan, Eel, Singularity. Ammo supply (a Freighter in the party). ✦ **Stabiliser Anchor** (braced: more range and splash, no movement), ✦ **Targeting Uplink** (shoot at what a party member paints).
- **Energy:** low (ammo weapons), but ammo-hungry.
- **Counters:** fast flankers, anything that reaches it before it un-anchors.
- **Party role:** heavy damage from the back; needs a spotter and a guard.
- **Content:** sieges and nests above all; boss stages that sit and brace.

### 2.11 Interceptor (escort picket)
*Fast enough to be everywhere the freighter isn't.*

- **Excels:** escort operations, catching runners, point-defence against missiles and torpedoes, response jobs.
- **Clearly worse:** bosses (fragile, light guns), sieges, mining, hauling.
- **Loop:** circle the escorted ship at speed, peel off to kill whatever closes in, shoot down incoming missiles, come back.
- **Relies on:** Afterburner, Torch, turreted autocannons and flak (Rattler, Chainsaw, Burst, Cloudmaker). ✦ **Point Defence Turret** (automatically shoots projectiles, not ships), ✦ **Speed-Matching** (a flight assist that holds station on a chosen ship).
- **Energy:** high drive, steady guns. Starves endurance (can't stay out long).
- **Counters:** heavy armour (light guns don't pen), Bulwark-type enemies, long fights.
- **Party role:** bodyguard for the Freighter and the Bombard.
- **Content:** escort, defend operations, any job with incoming missiles or torpedoes.

### 2.12 Disruptor (EMP and control)
*Doesn't kill much, but nothing works near it.*

- **Excels:** party fights against packs, PvP, interrupting boss telegraphs (if bosses can be staggered), protecting escort targets.
- **Clearly worse:** solo damage, mining, hauling; bosses immune to control.
- **Loop:** close to medium range, place EMP and slow fields where enemies will be, chain arcs, then call the kill for others.
- **Relies on:** Hush, Blackout, Spark, Tesla, Frostbite Lance (chill), Singularity (pull). ✦ **Tractor Beam** (pull or hold a target), ✦ **Ion Snare** (slow field: drains enemy thrust).
- **Energy:** bursty: each EMP or field is a big packet.
- **Counters:** insulated or shielded targets; long range; its own fragility.
- **Party role:** sets up the Blinker and Alpha Striker; protects the Freighter.
- **Content:** packs and nests, escort ambushes, boss stages that allow a stagger.
- **Needs a rule:** bosses take control effects in a reduced, readable way (a "stagger bar"), else this archetype dies at bosses.

### 2.13 Alpha Striker (glass cannon)
*One volley that ends the conversation. Then nothing.*

- **Excels:** short boss windows, killing armoured priority targets, PvP first strike.
- **Clearly worse:** anything long; anything that hits back first. No sustain at all.
- **Loop:** fill the banks, wait, fire everything in one coordinated volley (Spear + Hammerhead + Bastion), retreat to recharge.
- **Relies on:** Overclock Reactor (fragile, big blast), Capacitors, Spear, Bastion, Hammerhead, Leviathan. ✦ **Discharge Capacitor**, ✦ **Linked Fire** (fire-group trigger that syncs volleys).
- **Energy:** all burst. Huge storage, poor generation. A long fight starves it completely.
- **Counters:** sustained pressure, shields that soak alpha (Overpulse-type answers), being dived.
- **Party role:** damage spike on cue. Differs from the Blinker by staying at range and having no escape.
- **Content:** boss vent windows, armoured targets, high-value kills.

### 2.14 Salvage Tug (salvager and tower)
*Profits from everyone else's wrecks and moves what can't move itself.*

- **Excels:** recover jobs (there are eight), salvage after fights, towing disabled party ships or cargo, clearing debris.
- **Clearly worse:** direct combat, bosses, speed.
- **Loop:** follow the fight at a distance, tow wrecks and containers to safety, strip parts, haul to a station. Tows a disabled friend out of a boss arena.
- **Relies on:** cargo, Constructor, strong main engines (it pulls mass). ✦ **Tow Beam / Tether** (attaches to an object or ship and pulls it), ✦ **Salvage Cutter** (more salvage from wrecks, slow).
- **Energy:** steady, engine-heavy when towing.
- **Counters:** being caught while slowed by a tow.
- **Party role:** rescue and logistics; makes a party's losses cheaper.
- **Content:** recover jobs, post-siege cleanup, moving containers or buoys (construct jobs), rescuing frozen friends in cold systems.

### 2.15 Ghost (stealth runner)
*Unseen, unbothered, and gone.*

- **Excels:** courier and deliver jobs through hostile space, scouting nests, ambushes in PvP zones, reaching far points without a fight.
- **Clearly worse:** anything after it's spotted: weak guns, light hull.
- **Loop:** go cold (cut emissions), drift past packs outside their notice range, sprint when spotted.
- **Relies on:** Drift Sails (low emissions), Isotope Piles, small hull. Enemies already have an `aggro` range (Enemies.ts `behaviour.aggro`), so a ship **signature** that scales it is a small step. ✦ **Signature Dampener** (smaller aggro radius, no shields, guns weaker).
- **Energy:** low; a ship that runs hot (big reactors, boosting) is loud.
- **Counters:** scanners, Long-Range Arrays, area weapons.
- **Party role:** scout and forward spotter for the Bombard and Longshot.
- **Content:** courier jobs, scouting, PvP zones.

---

## 3. Cross-cutting mechanics that foster distinct builds

These matter more than any single part: they're what makes the trade-offs real.

### 3.1 Energy with shape, not just size
1. **Discharge rate.** Every store gets a maximum output per second. Batteries: big and slow. Capacitors: small and fast. Drive Cells: tuned for engines. A ship can then be *burst-shaped* (lots of capacitors, Alpha Striker, Blinker) or *sustain-shaped* (generation and batteries, Bulwark, Warden), and neither is simply better. This is the single biggest lever and fits energy.ts's three pools without new buses.
2. **Draw curves.** Parts declare how they draw: continuous (engines, beams), per-shot packets (guns), duty cycle (bores, spool-up guns), or a charge-and-release (blink coil, burst strafer, discharge capacitor). Charge-and-release parts are the natural home for "sharp thrust for high energy per impulse".
3. **Generation that isn't flat.** Reactor sidegrades: one ramps up slowly but is efficient (good for long hauls, bad in an ambush); one is strong but adds heat; the Isotope Pile stays the steady, safe one.
4. **Priority you control.** Today engines always come first. A three-way switch (engines / guns / shields first) lets a pilot change their ship's shape mid-fight, and gives the Warden and Bulwark a reason to care.

### 3.2 Heat as a second resource (tied to warmth)
Today warmth only goes down (cold). Proposal: **one ship thermal meter**, warm in the middle. Boosting, firing, burst thrusters, overclocked reactors and heavy beams push it **up**; cold space pulls it **down**; radiators (✦) and insulation set how fast each happens.

- In cold systems, heavy fighting **keeps you warm**: a Bombard or Alpha Striker is comfortable there; an idle Freighter freezes.
- Near stars and lava worlds, heat becomes the problem: burst builds overheat; the Pathfinder's insulation works against it.
- It gives every burst part a second cost that energy doesn't capture, and gives materials a thermal role beyond insulation (Ceramic Laminate: resists heat, Insulated Polymer: holds it).
- It reuses the warmth meter, stages and snapshot slot (warmth.ts), and the Lance's per-weapon heat becomes a local case of it.
- **Risk:** it adds a meter every pilot must watch. A softer version: heat only for parts marked "hot" (burst strafers, overclock, Lance), the rest stays as today.

### 3.3 Mass that matters both ways
- **Cargo has mass** (per item or per category). This alone gives the Freighter and Tug an identity.
- **Mass resists being moved**: pulls (Singularity, Scrap Mother magnets, ✦ Tractor), knockback and rams scale by mass. Heavy builds get an upside; boss moves that pull reward Bulwarks and punish Dancers, while dodge patterns do the reverse. Dense Ferrite's `mass_anchor` trait becomes meaningful.
- **Inertia per part position**: heavy parts far from the centre slow turning more (`turnAccel` already uses inertia; making it visible in the hangar teaches it).

### 3.4 Fitting rules that shape layouts
Weapons already have attach edges, arcs and clear lanes. Extend the same idea:
- **Exhaust lanes for engines**: a main engine needs clear cells behind it; burst strafers need clear cells to the side. Agile ships then *look* different (open flanks) from tanks (armour everywhere).
- **Spinal mounts**: some guns (Spear, Lance, a future spinal) get a bonus for running through the length of the hull. Snipers become long, thin ships.
- **Broadside mounts**: side-mounts with a bonus when several fire together. Gives slow ships a reason to turn side-on.
- **Radiator area**: radiators (✦) need an open edge, competing with armour for the outside of the hull.

### 3.5 Keeping tiers from strictly dominating
- **Sidegrade bands**: within a level band (say every ~8 levels), new models are alternatives, not upgrades. The later band adds a new *verb* (blink, tow, drone) rather than +20% damage.
- **Penetration is the only vertical stat**: keep `grade` → pen as the long progression; damage per cell stays flat inside a family. Better armour then still needs better guns, but a level-10 Hammer stays a real choice next to a level-30 Bastion against light targets.
- **Plates as a triangle, not a ladder**: Neutronium heavy and strong, Titanium middle, Composite light; with mass mattering (3.3), a Dancer picks Composite at any level.
- **A fitting budget**: build points already exist (grades.ts `buildPoints`). If the core sets a points budget (or a power-grid budget), a pilot can't fit "everything good"; they choose a shape.
- **Cheap switching**: the hangar keeps several ships (`hangar[]`, designs). Situational builds only work if swapping is quick and cheap at a station, maybe with a small per-swap fee rather than a rebuild. Without this, players settle on one generalist.

### 3.6 Content that asks different questions
Builds need jobs that reward them. A short checklist for new content:
- **Bosses**: each stage should favour a different archetype (a bullet-hell stage for Dancers, a long-range stage for Longshots, a vent window for Blinkers/Alpha Strikers, a pull stage for heavies, a summons stage for Carriers/Disruptors).
- **Escort**: freighters that are slow and need *staying close* (Interceptor, Bulwark, Carrier), with missile volleys (point defence).
- **Hauling**: reward by weight delivered, not by trip.
- **Travel/cold**: routes where the jump range and warmth budget matter more than firepower.
- **Sieges and nests**: stationary targets and defence lines (Bombard, Bulwark, Longshot).
- **Party rewards**: support (healing, shielding, towing, painting) counts towards the reward share, else Wardens won't exist.

---

## 4. The matrix

**S** = strong (a first pick), **o** = okay, **w** = weak. The aim: every activity has 2–3 strong answers; no row is strong everywhere.

| Archetype | Boss | Escort | Mining | Hauling | Travel | Cold | Siege / nest | Party support | PvP zone |
|---|---|---|---|---|---|---|---|---|---|
| Dancer | **S** | w | w | w | o | w | o | o | **S** |
| Longshot | **S** | o | w | w | o | o | **S** | o | o |
| Blinker | **S** | w | w | w | o | w | o | o | **S** |
| Bulwark | o | **S** | w | w | w | o | **S** | **S** | o |
| Carrier | o | **S** | o | w | w | w | **S** | o | w |
| Freighter | w | w | o | **S** | o | w | o | o | w |
| Pathfinder | w | w | o | o | **S** | **S** | w | o | w |
| Prospector | w | w | **S** | o | o | o | w | w | w |
| Warden | o | o | w | w | w | o | o | **S** | o |
| Bombard | o | w | w | w | w | o | **S** | o | w |
| Interceptor | w | **S** | w | w | **S** | w | o | o | o |
| Disruptor | o | o | w | w | w | w | o | **S** | **S** |
| Alpha Striker | **S** | w | w | w | w | o | o | o | o |
| Salvage Tug | w | o | o | **S** | o | o | o | **S** | w |
| Ghost | w | w | w | o | **S** | o | w | o | o |

Count of **S** per activity: Boss 4, Escort 3, Mining 1, Hauling 2, Travel 3, Cold 1, Siege 4, Party support 4, PvP 3.

**Gaps it shows:**
- **Mining** and **cold** have only one strong answer. Fix: let the Freighter be a *mining barge* variant (big hold, bores, no guns) and let heat (3.2) make a **Bombard or Bulwark** comfortable in cold, which would give cold a combat answer.
- **Boss** has four strong answers that are all damage/dodge. Good, as long as boss stages are designed to rotate which one is best (3.6).
- No row has more than three **S**: no build is good at everything.

---

## 5. New part ideas, ranked by variety per effort

Ranked by how many archetypes each one opens up against how much code it needs. "Effort" is rough: S = mostly data and a small rule, M = a new mechanic in an existing system, L = new system.

| # | Part | Effort | Opens | Trade-off in one line |
|---|---|---|---|---|
| 1 | **Burst Strafer** (thruster) | S–M | Dancer, Blinker, Interceptor | A fixed short burn (say 0.25 s) of very high side thrust, with 2–3 charges that recharge slowly; costs several times the energy per unit of push of a normal engine and does nothing for cruising. |
| 2 | **Discharge Capacitor** (power) | S | Alpha Striker, Blinker, Disruptor | Empties its whole charge in a moment for a big volley, then recharges slowly; useless for sustained fire. (Needs discharge rates, 3.1.1.) |
| 3 | **Cargo with mass** (rule, not a part) | S | Freighter, Tug, Prospector | A full hold hauls more but handles like a barge; empty, you're quick. |
| 4 | **Stabiliser Anchor** (utility) | S–M | Bombard, Longshot, Bulwark, Prospector | While braced: more range, accuracy, shield and mining steadiness, immune to pulls; zero thrust and a slow un-brace. |
| 5 | **Radiator** (utility) + heat (3.2) | M | every burst build; Pathfinder vs heat | Sheds heat fast, but must sit on an open edge, is fragile, and makes you colder in cold space. |
| 6 | **Repair Beam** (utility) | M | Warden, Tug, party play | Heals another ship's parts at a big energy cost; does nothing for yourself. |
| 7 | **Point Defence Turret** (weapon) | M | Interceptor, Bulwark, Freighter, escort | Shoots incoming missiles, torpedoes and slow orbs automatically; can't hurt ships. |
| 8 | **Tow Beam / Tether** (utility) | M | Tug, Freighter (containers), rescue | Drags a ship, wreck or container behind you; your handling falls with its mass. |
| 9 | **Signature Dampener** (utility) | S–M | Ghost, Pathfinder, PvP ambush | Shrinks enemies' notice range; disables shields and weakens guns while on. |
| 10 | **Blink Coil** (utility) | M | Blinker, Dancer, Pathfinder | A combat micro-jump (a few hundred units) with a short charge and a long cooldown; takes a large drive-store bite. |
| 11 | **Heater Core** (power) | S | Pathfinder, cold party support | Turns spare power into warmth and can warm nearby allies; adds nothing to combat. |
| 12 | **Drone Bay** (utility) | L | Carrier, Warden (repair drones), Interceptor screen | Launches drones that act on their own; heavy, loses drones to area damage, costs to rebuild. |

Close behind: **Spool-up Bore / Spool-up Chainsaw** (stronger the longer it runs, interrupted it starts over), **Gyro Flywheel** (fast turning, heavy and fragile), **Ion Snare** (a slow field), **Shield Projector**, **Power Link**, **Targeting Uplink**, **Cargo Clamp**.

---

## 6. Open questions for Kieran

1. **Heat**: one thermal meter shared with warmth (3.2), heat only on "hot" parts, or no heat at all? This decides how much burst builds cost beyond energy.
2. **Cargo mass**: is it OK for a full hold to make a ship handle worse? It's the cheapest way to make hauling a build, but it changes every miner's day.
3. **Swapping ships**: how cheap should switching between saved builds be at a station? Situational builds only make sense if swapping is easy.
4. **Fitting budget**: should the core (or a ship class) cap build points or power, so a ship can't fit everything good?
5. **Tiers**: are you happy for later models to be sidegrades with new verbs, keeping only armour penetration as the steady climb? That means rebalancing some current families (e.g. Twinlink vs Pip vs Bastion).
6. **Bosses and control**: should bosses take stuns, slows and pulls in a reduced way (a stagger bar)? Without it the Disruptor has no boss role.
7. **Support rewards**: should healing, shielding, towing and painting count towards the party's reward share?
8. **PvP**: how much should PvP zones shape archetypes? Dancer/Blinker/Ghost/Disruptor get much stronger with PvP in mind; if PvP stays small, they should be balanced for bosses and packs first.
9. **Drones**: worth the cost (AI, network, rendering, the bullet-hell budget in docs/audits/boss-bullet-hell.md)? Or keep the Carrier fantasy to Hive-style homing swarms?
10. **Which 5–6 to foster first?** Suggested starter set, because the first four parts in section 5 open them: **Dancer, Alpha Striker, Freighter, Bombard, Bulwark, Interceptor**, then **Warden** once repair exists.
