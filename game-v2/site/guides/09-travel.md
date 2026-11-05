---
title: Travel
order: 9
group: World
summary: The jump drive, gates and rifts, the map and autopilot, danger levels, hazards and cold.
checked: 2026-11-04
sources: data/systems.json, data/hazards.json, data/ships/tuning.json (jump), common/src/ships/flight.ts, jumpFields.ts, hazards.ts, warmth.ts, common/src/game/regions.ts, server/src/net/handlers/flight.ts (handleInteract), server/src/GameServer.ts (canDamage, inPvpZone), data/quests.json (restricted), client/src/ui/fieldGuide.ts, docs/areas/world-sim.md
---
<!-- TODO: Glasswater Expanse lists cold and radiation as visual hazards in systems.json but has no hazardRatings, so the hazard table gives it none. Recheck if ratings are added. -->
<!-- TODO: the Sol to Glasswater rift is defined on the Sol side only (rift_sol_to_glasswater); whether it works the other way is not confirmed. -->

## Jump drive

The jump drive is the fastest way across a system. Anything past about 10,000 units is quicker by jump than by flying. Controls are in [Controls and flight modes](/guides/controls-and-flight-modes).

| Phase | Length |
|---|---|
| Charge | 1.5 seconds. The engines go quiet and you slow down |
| Burn | 1.5 seconds along your nose, with no steering, thrust, friction or guns |
| Cooldown | 11 to 25 seconds, depending on your ship |

You jump as far as your cursor, up to your drive's **range**. You come out still moving and coast to a stop where you aimed.

### Range and cooldown

Range and cooldown come from the drive's **coils** against the size of the hull. At a perfect match a drive reaches **50,000 units** and recharges in **15 seconds**.

- The core has a coil good for a hull of about 40 cells. A **Jump Coil** square adds 12 cells' worth, a **Heavy Coil** block adds 64 and shortens the cooldown by a fifth.
- A hull bigger than its coils need reaches less and recharges slower, down to 30,000 units and 25 seconds. It still works.
- More coil than the hull needs helps a little, less with each one. The cooldown never drops much below 10 seconds. Better grades of coil do a little more.

| Ship | Parts | Range | Cooldown |
|---|---|---|---|
| Sparrow T | 14 | 61,696 | 11.4 s |
| Corsair | 36 | 50,117 | 15 s |
| Prospector | 17 | 59,914 | 11.9 s |
| Lancer | 100 | 30,000 | 25 s |

The hangar shows how your coils stand against your hull.

### Boosts

- Inside a star's **charging ring** (shown on the system map) the drive recharges twice as fast and reaches 25% further.
- Inside a **Stillstone** field (marked on the map and the screen edge) it also recharges twice as fast, and stays primed: your next jump within 60 seconds reaches 20% further. A scarred Stillstone gives half the help. Dead or shattered ones give none. If you are in both a ring and a field you get the better, not both.
- The landing reticle goes red if you would land in a star's heat or among hostiles. A jump aimed at a station, gate or marker drops you just short of it.

## Gates and rifts

- **Jump gates** link systems. Fly within 300 units and press **X**. A card says where it goes, how dangerous it is against your ship, and what it needs. The first time a gate leads somewhere deadly for your ship, it asks you to press again. Gates stop your ship.
- **Rifts** pull you through as soon as you touch them, within 200 units, and keep your momentum. They have a 3 second cooldown.
- Some systems need a **licence**. Gates and rifts refuse ships without it.

| System | Licence | How to get it |
|---|---|---|
| Glasswater Expanse, Borealis, Nebula Prime, Cinder Reach | Lane clearance | "Cleared for Departure", a level 2 job at Sol Central: fabricate a Constructor, fit it, and build the nav buoys it asks for |
| The Maw | Maw transit licence | "The Cinder Warden", a level 21 job at Ember Forge: defeat the Cinder Warden |

## The systems

Each system has a **danger** rating from 1 to 7 (the pips under your credits, and on the map). Danger brings richer rock and tougher hostiles.

| System | Danger | Gates and rifts to | Hazards (rating) | Pilots can fight pilots |
|---|---|---|---|---|
| Sol | 1 | Gates: Borealis, Cinder Reach, Nebula Prime, Ashfall. Rift: Glasswater | none | No |
| Ashfall Drift | 1 | Gate: Sol | none | No |
| Glasswater Expanse | 2 | Gate: Borealis | none | No |
| Borealis | 3 | Gates: Sol, Glasswater. Rift: Nebula Prime | Cold 3 | No |
| Nebula Prime | 4 | Gate: Sol. Rifts: Borealis, Void Sector | Radiation 2, corrosion 4 | No |
| Cinder Reach | 5 | Gates: Sol, The Maw | Heat 4 | Yes, away from its station |
| The Maw | 6 | Gates: Cinder Reach, Void Sector | Gravity 5, corrosion 1 | Yes |
| Void Sector | 7 | Gate: The Maw. Rifts: The Maw, Nebula Prime | Radiation 5, gravity 2 | Yes |

Sol, Nebula Prime and Glasswater Expanse each also have a gate to your own station.

### Danger bands in Sol

Sol is split into rings by distance from the star.

| Band | Distance | What it is |
|---|---|---|
| Inner Sol | up to 76,000 | **Safe.** Hostiles keep out, and a ship lost here comes back whole |
| Middle Sol | to 140,000 | **Contested.** Smugglers, the Drift, a Redtooth picket. About right for your first built ship |
| The Reaches | to 230,000 | **Hostile.** Veterans in better plate, fortresses and warbands. Ships lost here lose cargo |

Grey ships are passive and leave you alone unless shot. Red ones come for you.

## The map and the autopilot

- **M** opens the galaxy map (systems, sectors, gate links, rift routes, with a ship pin on your system) and the live system map (planets with moons and rings, stations, wrecks, gates).
- A padlock marks a system you need a licence for.
- **N** toggles markers on the screen edge for off-screen stations, gates, planets, wrecks and objectives, with distances.
- **G** flies you to the job you are following, gate by gate, using the jump drive on long legs.
- Click a station, gate, wreck or system on the map to fly there. Right-click a point in your system to fly to it.
- Any flight key, or firing, takes back control.

## Planets and surfaces

Press **X** in low orbit, within 900 units of a planet's edge, to descend to a planet that has a surface. A surface is a small separate area where everything works as in space; climbing past its edge returns you to orbit. 

**Siege moons** (Selene, Rimeholt, Cinderhold, Gloam and Last Light) are fortresses held through nights of waves, one for each grade from I to V. Each pilot or party gets their own copy.

## Hazards

Each system rates its hazards from 0 to 5. Your ship has a **tolerance** for each, from what it is built of. Rating minus tolerance, if positive, is the deficit, and effects are per point of deficit.

| Hazard | Effect per point of deficit | Tolerance from |
|---|---|---|
| Radiation | Hull cells lose 0.4% HP a minute, battery capacity −8% | Materials that tolerate radiation (Leaded Iridium, Leestone) |
| Heat | Shield regeneration −15% | Bulk: one point for every 100 mass; Ceramic Laminate |
| Corrosion | Armour cells lose 0.3% HP a minute, station repairs cost 25% more | Composite, Sealed Composite |
| Gravity | Light ships are pulled to the well and lose 10% of steering and thrust; jump range −15% | One point for each 25 mass above 20; Dense Ferrite counts double |
| Cold | Builds up as warmth loss: see below | Insulating materials only slow it |

Near a star the heat rating is at least 3 within 1,500 units of its surface. Near a black hole the gravity rating is at least 3 within 2,500 of its horizon. **Black holes** (The Maw and Void Sector) pull on everything; past the event horizon nothing survives. Watch for the red warning, which grows with your thrust.

### Cold and warmth

In a cold system, warmth runs down from 100% while you are away from heat. At rating 3 (Borealis) it takes about 5 minutes to go from warm to frozen.

| Warmth | Stage | Effect |
|---|---|---|
| Below 50% | Chilled | A warning |
| Below 25% | Numb | Thrust and steering drop by 20% |
| 0% | Frozen | The ship seizes up for 2 seconds, then comes out with 15% warmth |

Heat brings it back: near a star, near a station (docked is quickest), beside a ship that is on fire (yours counts), or near a lava world. Away from the cold it comes back on its own. Insulated materials slow the cold but do not stop it. Frost weapons take warmth off the same meter. Guns are not affected.
