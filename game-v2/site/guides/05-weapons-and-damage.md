---
title: Weapons and damage
order: 5
group: Ships
summary: Weapon families, how guns fire, penetration against armour, shields, ammunition and gems.
checked: 2026-11-04
sources: data/ships/models.json, data/ships/tuning.json (weapons, damage, shield, fixedGun, turret), data/ships/materials.json, data/gems.json, common/src/ships/partStats.ts, damage.ts, guns.ts, mounting.ts, turret.ts, hitRules.ts (outcomes only), server/src/GameServer.ts (canDamage), client/src/ui/fieldGuide.ts
---
<!-- TODO: hitRules.ts is being rewritten (shared hit rules, confirmed hits). This page describes outcomes only: penetration, shields, glancing hits. Recheck after the netcode work lands. -->
<!-- TODO: damage per second and reach below come from partStats() at full power for the model's own material. The Draw column is an average; ammo guns spend crates, not energy (field guide), though their data still carries a demand figure. -->
<!-- TODO: gem sockets: byGrade [[0,0],[0,0],[0,1],[1,2],[1,2],[1,2]] with levelByGrade [0,0,19,32,0,0] in data/gems.json. What the 0 levels for grades IV and V mean (no gate, or none) is not confirmed, so only grades II and III are stated. -->

## Weapon families

Every gun is a named model with its own size, material and numbers (most are a single square or a two-cell panel; the heaviest are 2 by 2 blocks). The figures below are at full power, for the model's own material. Reach is in world units. **Draw** is average energy per second while firing.

| Weapon | Level | Mount | Fires | Damage/s | Reach | Draw | Type | Pen |
|---|---|---|---|---|---|---|---|---|
| Pip | 0 | Fixed | Cycle | 56 | 7,200 | 8 | Kinetic | 1 |
| Rattler | 3 | Turret | Cycle | 43 | 5,400 | 12 | Kinetic | 0.5 |
| Burst (flak) | 4 | Turret | Ammo | 26 | 1,700 | crates | Explosive | 0 |
| Hammer | 6 | Fixed | Cycle | 69 | 5,700 | 10 | Kinetic | 2 |
| Lobber (mortar) | 7 | Turret | Ammo | 28 | 2,640 | crates | Explosive | 0.5 |
| Glint (pulse laser) | 9 | Turret | Cycle | 53 | 5,100 | 15 | Thermal | 1 |
| Strobe | 10 | Turret | Cycle | 54 | 5,040 | 12 | Energy | 0.5 |
| Dart (missile) | 11 | Fixed | Ammo | 28 | 11,440 | crates | Explosive | 0.5 |
| Twinlink | 12 | Turret | Clip | 62 | 7,200 | 7.7 | Kinetic | 2 |
| Needle (railgun) | 13 | Fixed | Ammo | 50 | 9,000 | crates | Kinetic | 3.5 |
| Chainsaw | 14 | Turret | Cycle | 80 | 5,400 | 21 | Kinetic | 1.5 |
| Hush (EMP) | 15 | Turret | Cycle | none | 2,700 | 9.3 | Energy | 2 |
| Cloudmaker (flak) | 16 | Turret | Clip | 25 | 1,700 | 12.1 | Explosive | 1 |
| Spark (arc) | 17 | Turret | Cycle | 39 | 3,960 | 18 | Energy | 2 |
| Cutter | 18 | Fixed | Beam | 150 | 900 | 32 | Thermal | 2 |
| Slurry Cannon | 18 | Fixed | Cycle | 69 | 5,700 | 36 | Kinetic | 4 |
| Eel (torpedo) | 19 | Fixed | Ammo | 117 | 7,800 | crates | Explosive | 3 |
| Longbarrel | 20 | Fixed | Charge | 49 | 8,400 | 10.3 | Kinetic | 4 |
| Swarm (missile) | 21 | Fixed | Ammo | 36 | 11,440 | crates | Explosive | 2.5 |
| Coilgun | 22 | Fixed | Cycle | 89 | 2,700 | 15.6 | Kinetic | 4.5 |
| Stinger | 24 | Turret | Clip | 36 | 5,400 | 14.4 | Kinetic | 2.5 |
| Quake (mortar) | 24 | Turret | Ammo | 43 | 2,640 | crates | Explosive | 2.5 |
| Overpulse | 25 | Turret | Clip | 40 | 5,040 | 13.3 | Energy | 2.5 |
| Searchlight | 26 | Turret | Beam | 25 | 7,650 | 15 | Thermal | 3 |
| Spear (railgun) | 28 | Fixed | Cycle | 84 | 9,000 | 63.2 | Kinetic | 5.5 |
| Rail Driver | 29 | Fixed | Clip | 96 | 9,000 | 19.2 | Kinetic | 5.5 |
| Tesla | 29 | Turret | Beam | 70 | 660 | 30 | Energy | 4 |
| Bastion | 30 | Fixed | Clip | 100 | 4,800 | 16.7 | Kinetic | 5 |
| Lance | 32 | Fixed | Beam | 210 | 500 | 90 | Thermal | 5.5 |
| Hammerhead (missile) | 33 | Fixed | Ammo | 44 | 8,008 | crates | Explosive | 3.5 |
| Blackout (EMP) | 35 | Turret | Charge | none | 3,300 | 14.9 | Energy | 4 |
| Leviathan (torpedo) | 38 | Fixed | Ammo | 229 | 8,580 | crates | Explosive | 6 |

What the less obvious ones do:

- **Hammer**: one slow slug that pierces armour. **Longbarrel**: charges while held, then fires one shot that picks off a part.
- **Chainsaw** spins up from 4 to 16 shots a second while you hold fire, and is poor on a tap.
- **Glint** charges for 1.8 seconds, then a 1.4 second pulse peaking at 96 damage. Time it.
- **Strobe** and **Overpulse** do 1.6 and 1.9 times damage to shields, and 0.6 and 0.5 times to hull.
- **Cutter** burns deeper the longer it stays on one part: 60 rising to 150 damage a second over 1.5 seconds.
- **Searchlight** barely hurts, but what it lights takes 20% more damage from everyone for 2 seconds.
- **Spark** leaps to 3 more ships near what it hits. **Tesla** leaps to 5.
- **Eel** and **Leviathan** torpedoes go straight through shields. **Dart** homes on the ship nearest your cursor. **Hammerhead** steers toward your cursor while you hold fire.
- **Hush** and **Blackout** do no damage. They switch a ship's engines and guns off for 2 and 2.8 seconds. After an EMP the target is immune for 4 seconds.
- **Lance** needs a 0.3 second windup, pierces, and does 20% more to plating.

Six **legendary** weapons open at their level too, but each is built with a rare part that only its boss drops: Rustjaw's Hive (level 12), Frostbite Lance (12), Prism Splitter (10), Cinder Bloom (22), Phase Cannon (26) and Singularity Launcher (30). The Frostbite slows what it touches by 40%. The Phase Cannon's round passes through rock, wrecks and shields.

Support parts are in the same slots: the **Repair Beam** (level 17) mends a friendly ship, and the **Point Defence Turret** (level 10) shoots down incoming missiles, torpedoes and mortar shells on its own, 5 shots a second out to 560 units.

## How guns fire

Each gun fires one of five ways.

| Fires | What it does | Energy |
|---|---|---|
| Cycle | A shot on a fixed beat while you hold fire | Drawn as it reloads |
| Clip | A few rounds fast, then a reload when empty or shortly after you let go | Drawn on reload |
| Charge | Hold to charge. It fires itself at full charge, and nothing fires if you let go early | Drawn on charge |
| Ammo | Fires rounds from crates in your hold on a fixed beat | None. With no crates it fires plain rounds at 40% damage |
| Beam | Burns while you hold fire and the power lasts | Per second held |

Some guns take crates: Burst, Lobber, Quake, Dart, Swarm, Hammerhead, Needle, Eel, Leviathan and the Demolition Launcher. Special crates (sabot, incendiary, seekers and so on) change their rounds. Crates are made at a fabricator. Set how many of each a ship carries in the hangar's ammunition panel.

## Fixed guns and turrets

- A **fixed** gun points where your ship points, with a 2 degree correction toward the cursor (9 for fixed beams). It fires once the target is inside that.
- A **turret** turns to your aim within an arc, 120 to 360 degrees depending on the model, and fires only through gaps in your own hull. All turrets aim parallel along the line from your ship to the cursor. As parts of your own hull are shot away, a turret's firing arc widens.
- Either mouse button fires everything. See [Controls and flight modes](/guides/controls-and-flight-modes) for mining.

## Penetration and armour

Damage is not absolute. Every gun has a **penetration** (its grade, plus its kind's own bonus: the **Pen** column) and every block has an **armour** (its material's grade, plus one for armour plates). The gap sets how much of the damage gets through.

| Pen minus armour | +1 | 0 | −1 | −2 | −3 | −4 |
|---|---|---|---|---|---|---|
| Damage dealt | ×1.15 | ×1 | ×0.55 | ×0.25 | ×0.1 | ×0.05 |

Between whole steps the multiplier is interpolated. The result is then multiplied by what the block's material takes of that damage type (see the table in [Building a ship](/guides/building-a-ship)).

Examples for a Pip (pen 1):

| Target | Armour | Damage |
|---|---|---|
| Alloy hull | 1 | ×1 |
| Alloy armour plate | 2 | ×0.55 |
| Steel hull | 2 | ×0.55 |
| Titanium hull | 3 | ×0.25 |

A hit that gets through with under 60% of the gun's damage is flagged **glancing** and flashes grey. If you see grey, the gun is too weak for what it hit: use a bigger one, or go for a part with less armour.

### Damage types

Kinetic, explosive, thermal, energy, cryo and exotic. Materials take more or less of each. Ceramic Laminate shrugs off heat but cracks under shells, Insulated Polymer turns energy and melts under heat, and plain steel takes less from shells and more from energy. Tooltips show a gun's type and penetration and a block's armour.

### Parts

- A **destroyed core** explodes and takes the ship with it.
- Generators, thrusters and guns blow up a moment later and can set off their neighbours. Armour and hull just break.
- Without a core the remaining parts drift off and slowly crumble.
- Splash only hits the few parts nearest the blast.
- Collisions hurt both ships.

## Shields

A shield soaks damage before the hull and stops refilling while it is being hit.

| Part | Level | Capacity per cell | Refill | Draw per cell |
|---|---|---|---|---|
| Deflector | 11 | 40 | 8 a second after 3 s unhit | 16 E/s |
| Flash Screen | 13 | 36 | None: returns whole 4 s after it breaks, or at once for 4 E a point from a Capacitor bank touching it | 16 E/s |
| Flicker Screen | 19 | 20 | 20 a second after 1 s unhit | 6.4 E/s |
| Bulwark Projector | 27 | 45 | 5 a second after 4 s unhit | 19.2 E/s |

A shield only counts while it is powered, and refills slower when power is short. Torpedoes pass straight through shields.

Two plating parts sit with them: **Reactive Armour** (level 12) blunts small fast hits, so it beats streams of fire, and **Spaced Plating** (level 22) takes half damage from blasts.

## Gems

Cut gems fit in weapon sockets and change how a gun fires. Weapons of Mk II and above have sockets: a Mk II gun on a panel or larger has one, from level 19; a Mk III gun has one, or two on a panel or larger, from level 32. Putting a gem in is free; taking it out destroys it, and a gem is lost with its part.

| Gem | Level 1 | Level 2 | Made from |
|---|---|---|---|
| Frost | Hits chill, −15% damage | Chills harder | Voidglass pane |
| Ember | Hits set the part burning, −20% rate | Burns neighbours too | Aurum ingot |
| Splitter | Shots shatter into 2 shards, −30% range | 3 shards | Voidglass pane |
| Lance Core | +25% range | +40% range, pierces one more | Iridium ingot |
| Grapple | Shots drag ships in, −25% shot speed | Drags harder | Aurum ingot |
| Scatter | +1 shot a volley, wider spread | +2 shots | Aurum ingot |
| Keel | +15% part HP, −10% damage | +25% HP | Ferrite plate |
| Sight | −10% spread, −10% rate | −20% spread | Crystal lens |
| Overdrive | +15% rate of fire | +25% | Aurum ingot |

Gems are cut at a station. On top of the material above, a level 1 cut takes 3 crystal and 1 coolant and 5 minutes; a level 2 cut takes 2 crystal and 2 coolant and 15 minutes, with a 20% chance to fail that returns half. The materials are rare traces from refining: see [Mining and refining](/guides/mining-and-refining).

## Targets, ratings and PvP

- **Tab** cycles hostiles, nearest first. **T** targets the ship under your cursor.
- Each ship and system shows a **rating** against yours: easy, a fair fight, hard or deadly. A ship's rating weighs its firepower against its toughness.
- Grey ships are passive and leave you alone unless shot. Red ones come for you.
- Other pilots can only hurt you in **Void Sector**, **The Maw**, and **Cinder Reach** away from its station (past 9,000 units of it). Docked ships and station rings are always safe. Everywhere else you can only hurt hostiles, debris and pilotless ships.
