---
title: Controls and flight modes
order: 2
group: Basics
summary: Every default key, mouse-steer against helm controls, boosting, the autopilot and the action menu.
checked: 2026-11-04
sources: client/src/input/keybindings.ts, client/src/app/inputSend.ts, client/src/ui/fieldGuide.ts, client/src/settings/Settings.ts, common/src/ships/flight.ts, data/ships/tuning.json (flight), server/src/ships/bridge/weapons.ts
---
## Default keys

Every key below can be rebound except the ones marked fixed. Open **Esc**, then **Controls**. Binding a key that is already used swaps the two.

### Flight

| Action | Key |
|---|---|
| Thrust up, down, left, right | **W S A D** or the arrow keys |
| Boost | **Shift** (left or right) |
| Jump drive | **J** |
| Switch mouse-steer and helm | **V** |
| Aim and steer | Mouse (fixed) |
| Strafe left, right (helm only) | **Q**, **E** |
| Dodge (Burst Strafer parts only) | **Space** |

### Combat

| Action | Key |
|---|---|
| Fire | Left mouse button, or right mouse button (fixed) |
| Target the next hostile, nearest first | **Tab** |
| Target the ship under the cursor (on empty space: clear the target) | **T** |
| Ping for your party (with Shift: danger) | **B** |
| Switch feeds (ships that have Selector parts) | **Y** |

### Ship and world

| Action | Key |
|---|---|
| Dock, or open the hangar, inside a station's docking ring | **H** |
| Use a jump gate, descend to a planet, talk to someone | **X** |
| Autopilot to the job you are following | **G** |
| Tractor beam pickup | **F** |
| Tow or let go (Tow Beam parts only) | **U** |
| Action menu: hold, then right-click | **Z** |
| Respawn after being destroyed | **R** |
| Quick bar slots | **1 2 3 4 5** |

### Interface

| Action | Key |
|---|---|
| Menu | **Esc** (fixed) |
| Galaxy and system map | **M** |
| Cargo and storage | **I** |
| Component Guide | **C** |
| Pilot log (jobs) | **L** |
| Skills | **K** |
| Toggle edge markers for stations, gates and objectives | **N** |
| Session stats | **O** |
| Party window | **P** |
| Chat | **Enter** (fixed) |
| Zoom | Mouse wheel (fixed) |
| Reset zoom | **Home** |

Keys that cannot be bound: Esc, Enter, F5, F11, F12 and the Windows or Command key.

## Mouse-steer and helm

You start in **mouse-steer**. Press **V** to switch, or set the default in **Esc → Settings → Gameplay**.

| | Mouse-steer | Helm |
|---|---|---|
| Ship turns | To face the cursor | With **A** and **D** |
| **W A S D** | Push the ship up, left, down and right on the screen | **A**/**D** turn, **W**/**S** thrust along the nose |
| **Q** and **E** | Not used | Strafe sideways |
| The view | Stays put | Turns with the ship, so the nose points up the screen |
| Turrets | Aim at the cursor | Aim at the cursor |

Both modes fly the same ship. Only the way you ask for thrust and turning changes.

### How fast you turn and accelerate

Thrust is the sum of what your engines can push in the direction you ask. An engine pointing the wrong way adds little, and the core always gives a small push of its own. Acceleration is thrust divided by the ship's mass, and **mass includes what is in your hold**: a full hold accelerates and turns slower. Station storage weighs nothing.

Engines fade as you approach their **rated speed**, in world units per tick (60 ticks a second):

| Engine | Level | Rated speed |
|---|---|---|
| Ion Drive | 0 | 34 |
| Vernier | 2 | 40 |
| Afterburner | 5 | 50 |
| Plasma Drive | 16 | 55 |
| Torch | 8 | 70 |
| Fusion Torch | 30 | 85 |

<!-- TODO: the Sparrow T's measured speeds in the sentence below (about 21 units a tick cruising, about 29 boosting) came from running stepFlight on its own, not from the live game. Recheck in flight. -->
The Sparrow T reaches about 21 units a tick cruising, and about 29 with a boost.

Losing parts never makes a ship quicker. A ship with half its mass gone has about 0.7 of its drive left.

## Boosting

Hold **Shift** while thrusting. Engines push harder and draw much more energy: a boosting engine draws its normal amount times `1 + 2.2 × its boost drain`. Boost only works while the ship has stored charge.

| Engine | Boost thrust | Boost drain |
|---|---|---|
| Ion Drive | ×2 | 1 |
| Afterburner | ×3.6 | 3 |
| Plasma Drive | ×1.8 | 0.8 |
| Drift Sail | ×1.3 | 0.5 |
| Fusion Torch | ×1.7 | 1 |
| Vernier, Torch | none | none |

An Afterburner pairs well with a **Drive Cell** touching it. See [Energy and ports](/guides/energy-and-ports). A **boost cell** from your quick bar tops up every battery on the ship.

## Firing and mining

- **Left mouse button** fires your guns.
- **Right mouse button** fires your guns too, *unless* the ship has a mining laser. Then right mouse runs the mining laser instead.
- Aim at an asteroid and hold fire to break ore loose, then fly through the chunks.
- Fixed guns turn only 2 degrees either way, so they fire once your nose is on the target. Turrets follow the cursor on their own, but only through gaps in your own hull.

More on guns in [Weapons and damage](/guides/weapons-and-damage).

## Jump drive

Press **J** to spool the drive. The default is **tap to start** and tap again to abort; **Esc → Settings → Gameplay** can change it to **hold to spool, release to abort**.

1. **Charge**: 1.5 seconds. The engines go quiet and you slow down, so it is a poor way to leave a fight.
2. **Burn**: 1.5 seconds, along your nose, with no steering and no guns.
3. **Cooldown**: about 11 seconds on a small ship (15 seconds at the baseline). A soft chime says it is ready.

Point the cursor where you want to land. A ring around your ship shows the range, and the landing reticle goes red if you would land in a star's heat or among hostiles. Aiming at a station, gate or marker locks on to it. Range and cooldown depend on your jump coils against your hull size. See [Travel](/guides/travel).

## Autopilot and the action menu

- **G** flies you to the job you are following, gate by gate, using the jump drive on long legs.
- On the map (**M**), click a station, gate, wreck or system. Right-click a point in your system to fly there.
- Any flight key, or firing, takes back control.
- Hold **Z** and right-click anything, or open space, for the options on it: dock, travel through, land, hail, target, inspect, trade, fly there or jump there. A plain right-click fires.

## Targets and pings

- **Tab** cycles through nearby hostiles, nearest first. **T** targets whatever is under the cursor.
- The target panel shows its hull, shield and core. A homing missile locks on to the ship nearest your cursor, or your target if none is near it.
- **B** pings what is under the cursor for your party: on a hostile it means attack, on loot it means grab it. With **Shift** it marks danger. On the map use **Shift + right-click**.
- Rest the cursor on anything to see it in the info panel at the bottom right.

## Zoom and map

The mouse wheel zooms. **Home** resets it. Zooming out far enough hands over to the system map. **M** opens the galaxy view (systems, gate links) and the live system view. **C** inside the map centres on you.
