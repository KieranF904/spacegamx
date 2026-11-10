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
| 4 | ~~**Stabiliser Anchor** (utility)~~ | S–M | Bombard, Longshot, Bulwark, Prospector | While braced: more range, accuracy, shield and mining steadiness, immune to pulls; zero thrust and a slow un-brace. **Built (2026-10-31, L18) and removed the same day after playtesting** (Kieran: "take it out, it's lame"); see "Removed: Stabiliser Anchor" below. The archetypes it served need another answer. |
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

---

## Implemented: Repair Beam and Point Defence Turret (§5 #6, #7)

*Built 2026-10-31, awaiting review, not deployed. Code: `common/src/ships/features/support/support.ts`; docs/areas/ship-parts.md has the map.*

- **Repair Beam** (`utility_repair_beam`, utility, level 17, Mk II steel, 1×2, turret 240°): held on the fire key and
  aimed at the cursor like any turret (so a Warden points at who needs it; its other guns' shots pass through friends
  anyway). It passes through every ship it may not mend and stops on the first friendly hull: a party member, any pilot
  outside a PvP zone (inside one, only your party), a ward. It mends 42 HP/s at full power (a library ship's parts hold
  about 80 to 160 HP; an autocannon deals about 43/s), spread over the damaged parts nearest where it lands, at most three, nearest first. Draws 56/s
  while on (about two Cell Reactors); no heat. **Decisions:** it never mends a destroyed part (stations and repair kits
  rebuild), its own ship or a shield; no auto-targeting (the cursor is how every turret aims, and a client can't know a
  friend's exact damage to predict an auto-pick).
- **Support credit** (open question 7, answered "yes" as the default): `server/src/ships/features/support/Support.ts` notes who mended
  whom. A pilot who mended another at least 15 HP within the last 20 s is their supporter: an enemy the supported pilot
  kills pays its supporters nearby as it pays the killer's party (75% XP, 40% credits; not its job steps), and a boss
  counts the supporters of everyone it credits among its winners. The same hook (`supporters(target, now)`) is where
  shielding, towing or painting would add support later.
- **Point Defence Turret** (`point_defence_turret`, weapon, level 10, Mk I steel, 1×1, turret 300°): fires on its own,
  never on the trigger and never at ships, at shots coming from anything that may hurt its ship, within 560 of it: the
  nearest it has a clear line to, turning three times a gun's rate. 5 shots a second, 2 energy a shot (10/s firing flat
  out), each hit instant. Quiet while EMPed, jumping or docked. **Interceptable** (`intercept`: hits to bring down):
  missile 1 (and the Swarm's), hive 1, mortar shell 1, torpedo 3, the Scrap Mother's seam seekers 2, the Pyreclast's
  heart seekers 2. Not: shells of any kind, beams, flak, EMP, arcs, prism shards, the singularity, the Scrap Mother's
  chunk rings and the Pyreclast's heart sparks (those are dodging patterns). **A boss nova is never interceptable**
  whatever its kind (the Maw Heart's missile ring included) unless its phase sets `nova.intercept: true`. There are no
  mines in the game yet; a mine kind would just set `intercept`.

---

## Implemented: Burst Strafer and Tow Beam (§5 #1, #8)

*Built 2026-10-31, awaiting review, not deployed. Code: `common/src/ships/features/strafer/strafer.ts`, `tow.ts`,
`server/src/ships/features/tow/Towing.ts`; docs/areas/ship-parts.md has the map.*

- *Superseded the same day by the rework below ("Burst Strafer rework"); kept as it was first built.*
- **Burst Strafer** (`engine_burst_strafer`, engine, level 10, Mk I steel, 1×1, must point a facing edge out): no
  cruising thrust at all. A press of **Space** (rebindable "Dodge") fires one burst of 15 ticks (0.25 s) from every
  strafer pushing that way: 5.5 push per cell, as a force, so mass and cargo matter. On a Sparrow T one strafer gives
  about +290 m/s sideways and moves the ship about 105 units in half a second; a heavy ship hardly moves. Three
  charges, one back every 2.5 s. **Side:** the way you're steering (WASD on screen, turned into the ship's frame, or
  Q/E at the helm); with no side held, the other way from your last dodge (so tapping it weaves), or the only side
  your strafers push. A strafer pushes away from its nozzle, so one on each flank dodges both ways. **Energy:** a burst
  draws 280/s per cell while it runs (70 a burst: over 10× a Vernier's energy per unit of push), from the capacitor
  bank the strafer touches first (`PowerUse.dodge`), then its circuit as an engine, then the core's trickle. On a
  plain Sparrow, three dodges in a row take most of the core's store and starve the guns for a moment; a bank against
  the strafers pays instead. Short of power, a burst pushes that much less. **Not** while the jump drive spools or the
  anchor's out. HUD: a DODGE chip with a pip per charge. Look: a hot pink jet out of the nozzle and speed streaks.
- **Tow Beam** (`utility_tow_beam`, utility, level 12, Mk I steel, 1×2, facing edge out): **U** takes hold of the
  wreck, debris or loot pod nearest the cursor within 420 of your hull; U again lets go. A spring tether (slack 70 past
  both hulls, snaps 900 past that) pulls it towards you, damped; anything over 25 mass answers less. You carry 80% of
  its mass as cargo (at most three times your own), so a Corsair wreck costs a Sparrow about 60% of its thrust. Draws
  12/s per cell, only while towing (on its circuit like a gun); under 25% power it lets go. It also lets go if you jump,
  change system or it snaps. **Never** a working ship: no enemies, bosses, wards, traffic or pilots (decision below).
  **Salvage hook:** towed into a station's reach (docking ring), a wreck or debris is cut up for plate (half of its
  intact structure's materials) into your station storage, and a derelict also pays its salvage credits and XP and
  respawns later, as if broken; a pod's contents go into storage. The pilot's `salvaged` stat counts each delivery.
  Modules aren't salvaged (salvageOf gives components in full, which would make every kill's debris a component farm).
- **Decisions for Kieran:** (1) Dodge on a dedicated key (Space) rather than double-tap strafe: mouse-steer has no
  ship-relative strafe keys, and double-tap misfires on fine adjustments. (2) No towing friendly pilots: their own
  prediction would fight the tether (rubber-banding on their screen); it needs a "towed" flight mode first. (3) The
  load is constant (mass × 0.8) rather than by tension, so prediction stays exact. (4) Pods with room in your hold
  are still pulled in by the usual pickup, so towing pods matters when the hold is full. (5) Debris doesn't crumble
  while towed. (6) No heat (as asked).

---

## Burst Strafer rework (2026-10-31, after playtesting)

*Kieran: "lackluster and very restricted"; "the user should be able to use it as they like with a short cooldown, it
should be stronger and use more energy; rather than forcing this recharge thing, they need to compensate with their
energy system". Code: `common/src/ships/features/strafer/strafer.ts`, `flight.ts`; protocol 16.*

- **Any way.** A press dodges the way the movement keys ask (WASD on screen, diagonals too; forward/back/Q/E at the
  helm), worked out inside the shared step from the inputs of that tick and quantised to one of 32 ship-local ways, so
  prediction, the server and replicas agree without a direction on the wire. Each strafer pushes away from its nozzle
  and a way gets the sum of their components along it: strafers facing all four ways dodge anywhere, a pair on the
  flanks mostly sideways (a diagonal gets cos 45° of them). **Nothing held** (or a way no strafer pushes at all): back
  the other way from the last dodge (tapping weaves), else sideways (the stronger side, right on a tie), else whichever
  way the strafers push hardest. Strafers no longer need to point sideways to count.
- **No charges; a short cooldown.** One burst a press, 12 ticks (0.2 s); the next can start 24 ticks (0.4 s) after the
  last one started. A press made during the cooldown waits for it (client-side, up to 250 ms) rather than being lost.
- **Stronger.** 14 push per cell (was 5.5) over 12 ticks (was 15): about twice the impulse. On a Sparrow T one strafer
  now moves the ship about 600 units (was ~300 by the same measure), well clear of its own width.
- **Energy is the limit.** Demand 700/s per cell while bursting (was 280): 140 energy a strafer firing straight out (was
  70), less at an angle (each strafer draws by how much of its push goes the dodge's way). Dodging as fast as it allows
  is 350/s a strafer: the test strafer (four Cell Reactors, four batteries, two capacitor banks of two) gets about
  thirteen full dodges in a row, then about half-strength ones it can sustain. Still from the bank the strafer touches
  first, then its circuit as an engine. Short of power a burst pushes that much less; one that gets under a quarter of
  its draw on its first tick is **refused** (no push; ready again once the key's let go), deterministically on every side.
- **HUD:** the DODGE chip shows READY or a ring filling over the cooldown, LOW POWER n% / NO POWER when the circuit
  can't pay for a full burst the way you'd dodge now, and the ways it can dodge if not all four.

## Removed: Stabiliser Anchor (§5 #4)

*Built 2026-10-31 (commit 5896116) and removed the same day after playtesting: "take it out, it's lame".* It was a
2×2 steel utility part at level 18 drawing 3/s per cell: Y toggled a brace that spooled in over a moment, then held the
ship still (no thrust, slow turning) for +range and −scatter on its guns, faster shield recharge, less shield taken a hit
and immunity to pulls, knockback and most collision push, with a committed spool out. Everything is gone: the model,
its recipe and decor, the `brace` input flag and CTL bit, the body counter, the pilot-row and keyframe slots (protocol
16), `WeaponTuning.reach/steady` and the HUD chip. Its id stays in the append-only wire dictionary. If a "hold still for
an edge" verb comes back, it needs more than numbers: the playtest found standing still simply wasn't fun.
