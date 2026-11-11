---
title: Stations and services
order: 8
group: Economy
summary: Docking, the station tabs, repairs, storage, refining and fabricating, and which station has what.
checked: 2026-11-04
sources: data/stations.json, data/station.json, client/src/ui/StationWindow.ts, server/src/GameServer.ts (nearRepairSite, repairRate), server/src/ships/bridge/rebuild.ts (repairStep), data/ships/tuning.json (repair), data/unlocks.json, server/src/game/Docking.ts, Pilots.ts
---
<!-- TODO: stations.json has a refuelCostPerUnit on every station and a shipyard service on Lagrange Shipyard; nothing in the server or client reads either, so neither is described. -->
<!-- TODO: "Your station" (the pilot's own outpost, data/station.json) is not covered here. -->

## Docking

Fly into a station's **docking ring** and press **H**. While docked your ship is inside the station: it cannot be hurt, cannot fire and is left out of hostiles' target lists. Each station has its own ring size, shown on the map and by the nav markers (**N**).

Some outer stations charge a docking fee: see [Trade, jobs and credits](/guides/trade-jobs-and-credits).

## The station window

The tabs shown depend on the station's services.

| Tab | What it does | Service needed |
|---|---|---|
| Overview | Who is here, what you have queued, quick buttons for storage | none |
| Ships | Your hangar slots, plans you know, and building ships. See [Building a ship](/guides/building-a-ship) | none |
| Contracts | Four bounties, changing every 30 minutes | none |
| Market | Sell and buy | Market |
| Quartermasters | A faction's stock, by your standing | only at some stations |
| Refinery | Turn ore into plate | Refinery |
| Fabricator | Make modules, ammunition, kits and components | Fabricator |
| Your station | Your own outpost | none |

### Storage

Every station has **storage**, and it is **shared between all stations**: put ore in at Sol Central and take it out at Ember Forge. Storage weighs nothing. Hangar build orders only use what is in storage, so **store your ore when you dock**. The overview has quick buttons:

- **Store all but ammo and utility**: the safe one. It leaves ammunition, your loadout, repair kits and job items aboard.
- **Store ore and materials**.
- **Store loot**: components, artefacts, cut gems, plans, modules.
- **Store everything** (click twice).
- **Restock loadout**.

### Refinery and fabricator

- The **refinery** turns ore into plate, wire and lenses. Its queue has no limit, it works while you are away, and sends finished batches to storage. See [Mining and refining](/guides/mining-and-refining) for what each takes.
- The **fabricator** makes modules, ammunition crates, kits and components. Small, low-grade parts are made at once. Bigger ones take time. The queue has no limit and you can order before you have the materials: an order starts when they reach storage, and one that is waiting never holds up the ones behind it. The Engineering skill adds one job at a time at 2, 5 and 9 points.
- Each model is made at its level and nothing opens one earlier. See [Building a ship](/guides/building-a-ship).
- Any job in either queue can be **held**, **moved to the front** or **called off**, which refunds what was not used.

## Repairs

You do not have to dock to be repaired. Anywhere within **1,500 units of a station's edge**, your ship repairs itself:

- Damaged parts heal **6% of their maximum HP a second**.
- Missing parts regrow **one every 2 seconds**, nearest the core first. A part can only come back where it joins something still attached.
- Repairs **pause for 5 seconds** after you take a hit.

Healing costs credits per hit point at the station's rate. If more than one station is in reach the cheapest sets the price. Regrowing a part costs 40% of the minerals it is made from, taken from your storage and cargo first, then bought from the station. Below level 3 all of this is free. If you cannot pay, the crews patch you up at a quarter of the speed for nothing. See [Trade, jobs and credits](/guides/trade-jobs-and-credits).

Hazards change the price: in a system with corrosive air (Nebula Prime, The Maw) station repairs cost 25% more per point of corrosion beyond what your hull tolerates.

Repair kits patch you up in the field. You must hold still: moving or taking a hit wastes the rest. A basic kit mends up to 150 credits' worth of damage, a field kit 500 and a nanite kit 1,600, each faster than the last.

## The stations

Credits per hit point is the repair rate. Every station has storage.

| Station | System | Services | Repair rate | Docking fee | Defences |
|---|---|---|---|---|---|
| Sol Central Station | Sol | Repair, Refinery, Fabricator, Market | 0.8 | | |
| Sol Mining Outpost | Sol | Repair, Refinery, Fabricator, Market | 0.4 | | |
| Sol Trade Hub | Sol | Market | 1.2 | | |
| Lagrange Shipyard | Sol | Repair, Fabricator, Market | 0.6 | | |
| Sentinel Watch | Sol | Repair, Market | 0.72 | | 4 laser turrets |
| Farwatch | Sol | Repair, Refinery, Fabricator, Market | 0.6 | | 3 lance turrets |
| The Ark Hall | Sol | Repair, Market | 0.7 | | |
| Helios Seat | Sol | Repair, Market | 0.75 | | |
| Tinder Claim | Ashfall Drift | Repair, Refinery, Fabricator, Market | 0.4 | | |
| Borealis Research Station | Borealis | Repair, Refinery, Fabricator, Market | 1.2 | | |
| Thawline | Borealis | Repair, Refinery, Fabricator, Market | 1 | | |
| Prism Relay | Glasswater Expanse | Repair, Market | 0.4 | | |
| Shardfall Depot | Glasswater Expanse | Repair, Refinery, Fabricator, Market | 0.6 | | |
| Nebula Prime Observatory | Nebula Prime | Repair, Refinery, Fabricator, Market | 0.8 | 40 | 2 laser turrets |
| Ember Forge | Cinder Reach | Repair, Refinery, Fabricator, Market | 0.48 | 100 | 3 flak turrets |
| Horizon Watch | The Maw | Repair, Refinery, Fabricator, Market | 0.8 | 250 | 4 lance turrets |
| Black Lantern | Void Sector | Repair, Market | 1 | 400 | 2 flak turrets |

Station turrets fire on hostiles. Station rings are never a PvP zone.

### What the markets sell

Every market sells repair kits and boost cells; most sell scanner charges. A few extras:

| Station | Also sells |
|---|---|
| Sol Central | Field repair kits, alloy plate, copper wire, composite sheet, insurance bonds |
| Sol Mining Outpost | Alloy plate, copper wire, a Mining Laser, the Hauler plan |
| Sol Trade Hub | Alloy, steel, titanium plate, composite, crystal lens, servo motors, power couplings, insurance bonds |
| Lagrange Shipyard | Steel and titanium plate, power couplings, servo motors, the Corsair and Galleon plans |
| Sentinel Watch, Farwatch, The Ark Hall | Steel plate, insurance bonds |
| Borealis Research Station | Composite sheet, a Scanner |
| Thawline | Coolant, a Mining Laser |
| Nebula Prime Observatory | Crystal lens, targeting chips, the Lancer plan |
| Ember Forge | Steel, titanium plate, cobalt alloy, the Hammerhead plan |
| Horizon Watch | Cobalt alloy, quantum cores |
| Black Lantern | Insurance bonds, shield emitters |
| Prism Relay | Crystal lenses |
| Shardfall Depot | Alloy plate, copper wire, composite sheet, crystal lens |
| Tinder Claim | Alloy plate, a Mining Laser |
| Helios Seat | Power couplings, copper wire, composite sheet |

Prices and what each station wants change every four hours. See [Trade, jobs and credits](/guides/trade-jobs-and-credits).
