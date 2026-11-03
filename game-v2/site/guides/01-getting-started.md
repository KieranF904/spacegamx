---
title: Getting started
order: 1
group: Basics
summary: Signing in, your first ship, your first ten minutes, and what happens when you are destroyed.
checked: 2026-11-04
sources: client/src/ui/Tutorial.ts, server/src/GameServer.ts (starterKit), server/src/game/Pilots.ts (onDestroyed), data/quests.json (drift_01, main_01, guild_01), data/unlocks.json, common/src/econ/levels.ts, client/src/ui/fieldGuide.ts
---
## Signing in

Play from the **Play** button on this site. One account works for the site and the game. A new pilot appears next to **Sol Central Station**, which is also where you come back to after a loss.

<!-- TODO: guest play (a fresh profile that is never saved) exists in the client (handleGuestPlay); not confirmed that the production server offers it, so it is not mentioned. -->

## What you start with

| | |
|---|---|
| Ship | **Sparrow T**: 14 parts, 14 build points, 2 Pip cannons, 2 Cell Reactors, 2 Ion Drives |
| Credits | 300 |
| Storage | 40 iron ore, 20 nickel ore, 20 silicate, 10 copper ore, 14 alloy plate, 6 copper wire, 2 repair kits, 2 boost cells |
| Insurance | 3 insurance bonds, given once (see [Losing your ship](#losing-your-ship)) |
| Quick bar | Slot 1 repair kit, slot 2 boost cell, slot 3 scanner charge (keys 1 to 5) |

The Sparrow T has a hold of 30 units and a jump range of about 61,700 world units. Its two Pips do about 56 damage a second together, drawing 16 energy a second; the reactors make 70.

## The tutorial

A new pilot gets a ten-step tour. You can skip it at any point and replay it from the menu (**Esc**). It covers, in order:

1. Flying with **W A S D**. The ship turns to face the mouse.
2. Holding **Shift** to boost. The **ENERGY** gauge on the right is your ship's power pool; boosting, guns and shields all draw on it.
3. Mining an asteroid: aim at it and hold the **left mouse button**, then fly through the chunks to scoop the ore.
4. Opening your hold with **I**.
5. Flying to the station, or opening the map (**M**) and clicking it so the autopilot takes you.
6. Docking with **H** inside the docking ring.
7. Finding the **Ships** tab.
8. Shooting down a training drone (**Tab** targets it).
9. Making a jump with **J**.
10. A last card with the other main keys.

All keys are listed in [Controls and flight modes](/guides/controls-and-flight-modes).

## Your first ten minutes

Three jobs are open from the start. Open the pilot log with **L**, or dock and look at **Contracts**.

| Job | Where | What it asks | Reward |
|---|---|---|---|
| First Light | Sol Central | Mine 10 ore, then dock at Sol Central | 150 XP, 30 credits, the Prospector plan, the core recipe, 2 repair kits |
| Guild Dues | Sol Mining Outpost | Mine 40 ore, then deliver 20 iron ore | 300 XP, 50 credits |
| Into the Drift | Sentinel Watch | Destroy 5 Scrapborn drones in the Drift (outer Sol), recover a drone core, bring it back | 220 XP, 40 credits, 2 repair kits |

Doing all three takes you past level 2, which needs 431 XP in total.

Between jobs:

- Mine in the asteroid belt around Sol (it runs from 35,000 to 65,000 units from the star). See [Mining and refining](/guides/mining-and-refining).
- Sell ore at a station market, or keep it in storage for refining. See [Trade, jobs and credits](/guides/trade-jobs-and-credits).
- Stay in **inner Sol**. Hostiles keep out of it. See [Travel](/guides/travel).

## Levels

Total XP to reach a level is `120 × (level^2.2 − 1)`, up to level 100.

| Level | 2 | 3 | 5 | 10 | 15 | 20 | 30 | 50 |
|---|---|---|---|---|---|---|---|---|
| Total XP | 431 | 1,225 | 4,019 | 18,899 | 46,287 | 87,267 | 213,110 | 655,897 |

Levels open parts, materials and room. Parts and materials open at a fixed level and nothing opens one early. A few of the first ones:

| Level | Opens |
|---|---|
| 0 | Pip, Ion Drive, Cell Reactor, Battery, Mining Laser |
| 2 | Vernier |
| 3 | Rattler |
| 5 | Steel parts, Afterburner, Scanner |
| 6 | Hammer, Gyro |
| 7 | Lobber, Capacitor |
| 10 | Strobe, Drive Cell, Bore, Burst Strafer |
| 11 | Dart, Deflector shield |

The **Component Guide** (**C**) lists every part with its level and cost. You also get one skill point per level to spend with **K**.

## Repairs

Near a station your ship repairs itself: damaged parts heal and lost parts grow back one at a time from the core outwards. It pauses for a few seconds after you are hit, and costs credits per hit point at that station's rate. Below level 3 it is free. Repair kits (quick bar, **1**) patch you up in the field if you hold still.

## Losing your ship

If you are destroyed you fly a free, fully repaired **loaner** (a starter ship) from your last station while your own ship waits in its hangar slot and rebuilds itself from its salvage. Press **R** to respawn. What else it costs depends on where it happened.

| Where | Ship | Hold |
|---|---|---|
| Safe space (inner Sol) | All of its minerals come back | Untouched |
| Anywhere else | 70% of its minerals come back, plus every component | Most of it stays in your wreck. The **secure hold** keeps your 3 most valuable stacks (up to 25 units each) |

The wreck is marked on your map and kept for you for 15 minutes. An **insurance bond** in storage makes one loss outside safe space whole.

## Where to read next

- [Controls and flight modes](/guides/controls-and-flight-modes)
- [Building a ship](/guides/building-a-ship)
- [Mining and refining](/guides/mining-and-refining)
