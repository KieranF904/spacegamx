---
title: Trade, jobs and credits
order: 7
group: Economy
summary: How markets price things, where credits come from, jobs and the pilot log, standing, skills and ribbons.
checked: 2026-11-04
sources: common/src/econ/market.ts, quests.ts, levels.ts, items.ts, ribbons.ts, data/stations.json (market), data/quests.json, data/achievements.json, data/factions.json (rules), server/src/game/Pilots.ts, Enemies.ts, Trade.ts, Quests.ts, client/src/ui/fieldGuide.ts
---
<!-- TODO: the plan prices below are 50 credits per part of the plan, bought at 135%, from common/src/econ/items.ts; rounding in the shop may differ by a credit. -->

## Credits

You start with 300 credits. Credits are scarce on purpose. They come from:

- Selling ore, refined goods and loot at station markets.
- Jobs and bounties.
- Kills: each hostile pays a base amount that rises with its grade.
- Bosses, which pay the most.
- Salvage: break the core of a derelict hulk and its salvage credits are yours.

They go on repairs, part rebuilds, docking fees at some outer stations, ammunition, plans, and anything a quartermaster sells.

## Markets

Open a station's **Market** tab when docked. Every station with a market lets you sell anything with a value and buy what it stocks.

- A station **sells** an item at 135% of its base value.
- A station **buys** at 60% of base value, times its own standing demand, times this cycle's shift, times saturation.
- **Saturation**: every unit you sell pushes the price down there. A station absorbs `2,400 ÷ base value` units (at least 12) before the price has dropped by a third. It recovers: saturation halves every 30 minutes.
- **Cycle shift**: every 4 hours each station wants 3 goods (it pays 35% to 80% more) and is glutted with 2 others (25% to 40% less). The same for everyone. The top of the market panel shows them.
- **Standing demand** is fixed per station: for example Sol Mining Outpost pays ×1.2 for titanium ore and ×1.15 for crystal, and Sol Trade Hub pays ×1.25 for gems.

The Market tab also shows where else a good pays more. Haul to the right station and it pays.

### What a full hold sells for

A Sparrow T hold is 30 units and each unit takes 1 space. At 60% of base value, before any shift or saturation:

| Cargo | Per unit | A full hold of 30 |
|---|---|---|
| Iron ore | 1 | 30 |
| Copper ore | 3 | 90 |
| Titanium ore | 6 | 180 |
| Cobalt ore | 10 | 300 |
| Crystal | 15 | 450 |
| Platinoid ore | 18 | 540 |
| Helium-3 | 24 | 720 |
| Ruby | 36 | 1,080 |
| Emerald | 72 | 2,160 |
| Void opal | 132 | 3,960 |

Rounded down per unit. Gems come from gem seams, so they need a harder tool and the right rock: see [Mining and refining](/guides/mining-and-refining).

## Kills

A hostile pays its ship's base XP and credits, times a multiplier for its grade.

| Grade | I | II | III | IV | V |
|---|---|---|---|---|---|
| XP multiplier | ×1 | ×1.5 | ×2.2 | ×3.3 | ×4.6 |
| Credit multiplier | ×6 | ×6.5 | ×7 | ×7.5 | ×8 |

An elite ship pays double: XP, credits and loot. Your party shares a kill: each member within 8,000 units gets 75% of the XP and 40% of the credits, and the kill counts for their jobs. Other pilots within 3,000 units get 50% of the XP. See [Parties and chat](/guides/parties-and-chat).

## Jobs

Jobs come from people and from station boards. **L** opens the pilot log: jobs in progress, **leads** (jobs you have heard about, and who has them), and what you have finished. Follow a job and a ★ marker points to its next step; **G** flies you there.

- **Beginner jobs** are open from the start: First Light, Guild Dues and Into the Drift. See [Getting started](/guides/getting-started).
- Other jobs come from **talking to people** at stations and out in space (**X** when close), from rumours, and by running into them. Nothing is forced: say "Not now" and they ask again.
- Jobs you cannot take yet appear when you are within three levels of them.
- Many jobs ask for more than a kill count: runs through rings against the clock, holding steady in a spot while something works, or recovering a container. The panel at the top of the screen shows progress.

### Station boards

The **Contracts** tab of each station posts four bounties that change every 30 minutes. They are the same for every pilot. The kinds are:

| Kind | Asks |
|---|---|
| Kill | Destroy hostiles in the system |
| Mine | Mine a number of ore |
| Salvage | Break a derelict |
| Deliver | Bring goods to the station |
| Parts | Bring a ship part |
| Courier | A sealed dispatch to another station, against the clock |
| Scan | Fly close to derelicts and hold steady |
| Escort | Meet a freighter and keep it alive |
| Defend | Hold a site against waves of raiders |

Bounties pay credits and XP, scaled by the system's danger, plus standing with a faction.

### Operations

Some jobs happen out in space: courier runs, scans of derelicts, escorts, and defence of an outpost against waves of raiders. A party can run **fleet operations** (uplinks, convoys, sieges) that need more than one pilot.

## Standing and quartermasters

Doing a faction's jobs raises your standing with it. Some stations have a **quartermaster** who sells kits, components and plate to pilots they know.

| Rank | Standing | Discount |
|---|---|---|
| Unknown | 0 | 0% |
| Noticed | 5 | 3% |
| Known | 15 | 6% |
| Trusted | 35 | 10% |
| Honoured | 70 | 15% |
| Exalted | 100 | 20% |

| Faction | Quartermaster at |
|---|---|
| Sol Patrol | Sentinel Watch, Sol Central Station, Ember Forge |
| Miners' Guild | Sol Mining Outpost, Borealis Research Station, Shardfall Depot |
| Trade Consortium | Sol Trade Hub, Prism Relay, Black Lantern, Nebula Prime Observatory |
| Lagrange Shipwrights | Lagrange Shipyard, Horizon Watch |
| The Ark | The Ark Hall |
| Helios Directorate | Helios Seat |

Each rank unlocks more stock. The Miners' Guild, for example, sells repair kits and scanner charges to everyone, servo motors at Noticed, titanium plate at Known, crystal lenses and field repair kits at Trusted, cobalt alloy at Honoured and helium-3 at Exalted.

## Plans

A ship **plan** is an item you buy once and then build as often as you like in the hangar. A plan costs about 50 credits per part of the ship at the station's price of 135%.

| Plan | Sold at | About |
|---|---|---|
| Corsair (36 parts) | Lagrange Shipyard | 2,430 credits |
| Hauler (85 parts) | Sol Mining Outpost | 5,738 credits |
| Lancer (100 parts) | Nebula Prime Observatory | 6,750 credits |
| Galleon (162 parts) | Lagrange Shipyard | 10,935 credits |
| Hammerhead (211 parts) | Ember Forge | 14,243 credits |

First Light gives you the Prospector plan for free. Building from a plan still costs build points and the parts' materials: see [Building a ship](/guides/building-a-ship).

## Repair and docking costs

- Repairing damaged parts near a station costs credits per hit point at that station's rate. The cheapest nearby station sets it. Below level 3 it is free.
- A lost part regrows for 40% of the minerals it is made from. The station supplies what you are short of at market price. If you cannot pay, it lends you the credits and takes 25% of what you earn until you have repaid. Nobody is left with a broken ship.
- Some outer stations charge a docking fee to pilots of level 10 and up, once every 30 minutes: Nebula Prime Observatory 40, Ember Forge 100, Horizon Watch 250 and Black Lantern 400 credits.

## Levels and skills

XP comes from kills, mining (0.35 XP a unit), jobs, bosses, salvage and ribbons. See [Getting started](/guides/getting-started) for the level table. You get **one skill point per level**, up to 60. Press **K** to spend them.

| Skill | Max points | First point | Effect |
|---|---|---|---|
| Mining | 20 | 8% | A chance of an extra unit from every unit mined |
| Engineering | 20 | 6.5% | Cheaper rebuilds, and an extra refinery and fabricator job at once at 2, 5 and 9 points |
| Navigation | 20 | 6.5% | More cargo space |

Each point is worth 90% of the one before, so spreading them pays. 10 points in Mining give about 52%; 20 give about 70%.

## Trading with another pilot

Open the party window (**P**) and choose **Trade** on a pilot within 2,500 units. Both of you put up items and credits, both accept, and the swap happens at once.

## Ribbons

Milestones earn ribbons, and each pays on the spot. The log has a **Ribbons** tab, and a **Rankings** tab with this week's and all-time leaders. Each week one boss is hunted: everyone in on the kill gets double XP and credits.

| Ribbon | For | Pays |
|---|---|---|
| First Blood | 1 kill | 10 credits, 50 XP |
| Prospector | 500 ore mined | 40 credits, 200 XP |
| Contractor | 10 jobs | 80 credits, 300 XP |
| Hunter | 50 kills | 150 credits, 600 XP |
| Giant Slayer | 1 boss | 200 credits, 1,000 XP |
| Deep Core | 5,000 ore mined | 400 credits, 1,500 XP |
| Merchant | 10,000 credits earned trading | 500 XP |
| Veteran Contractor | 50 jobs | 500 credits, 2,000 XP |
| Ace | 250 kills | 800 credits, 3,000 XP |
| Boss Hunter | 6 boss kills | 1,000 credits, 4,000 XP |
| Tycoon | 100,000 credits earned trading | 4,000 XP |

There are 24 ribbons in all, including ones for fleet operations, escorts, defences, salvage, crafting, refining, trades, systems visited and levels 25 and 50.
