# Space Game v2: game plan

The roadmap for turning the prototype into a full, progressive game. Written
2026-10-20; not started. Phases are in order, each ending in something playable.

## The loop

**Mine → refine → craft parts and weapons → build or refit your ship → fly,
fight and quest → reach better resources and sectors → repeat at a higher tier.**

A new pilot starts docked at Sol Central with a Sparrow, 300 credits, a few
spare hull pieces and no other ship plans. The first quests teach the loop,
award a mining laser, and later award new ship plans. Dangerous sectors hold the
best minerals, enemy parts and bosses, which is what pulls players outward.

## Decisions made

| Question | Decision |
|---|---|
| Death penalty | Your ship is damaged, not lost. Rebuilding it costs a share of the **common minerals** its parts were made from; nothing unique (artefacts, components, plans) is ever consumed again. Cargo is dropped. |
| Storage | One shared storage, reachable from any station. |
| Crafting | Low-level parts and some consumables are instant. Most things are queued at a station and finish over time, including while you're offline. |
| Mining | Any weapon can mine. Dedicated mining lasers (and a few others) carry mining bonuses: faster yield, less waste, access to harder rock. |
| PvP | On in designated sectors only, off everywhere else. |

## What exists today (and is kept)

- Modular ships: parts, power flow, turrets, fixed guns, jump drive, part-by-part damage, station repair, crumbling debris.
- Hangar with validation, premade blueprints, per-account ship-design storage.
- 7 star systems, 12 stations with shops, derelicts, freighter traffic, planets, comets, the solar ring.
- A quest system (5 quests), 4 legacy enemy types, a bank, an in-memory inventory bar.
- Accounts behind a `UserStore` interface, with JSON and Postgres implementations.
- Server-authoritative simulation; clients send inputs and requests only.

Gaps the plan closes: nothing but the account and ship design is saved; the
hangar gives everyone unlimited parts and every blueprint; enemies and shop
weapons still belong to the old (non-modular) ship system; mining is just
shooting rocks.

## Features

### A. Saving progress and accounts

1. **Player profile** saved per account: credits, XP and level, skill points, cargo, shared storage, owned parts, quests (active and done), reputation, known plans, ship roster, current system and position.
2. **`ProfileStore` interface** alongside `UserStore`: `JsonProfileStore` now (one file per player, written to a temp file then renamed so a crash can't corrupt it) and `PostgresProfileStore` ready to switch on with `USER_STORE_BACKEND=postgres`. One shared test suite runs against both.
3. **Versioned saves** with migration steps, so old profiles keep loading as the schema changes.
4. **When it saves:** autosave every 30 s when dirty, plus on dock, quest turn-in, trade, craft, logout and server shutdown.
5. **Logging back in:** you return to the same system and position. Logging out leaves your ship in space for 20 s (no escaping fights by quitting). If you logged out inside a hazard or a PvP sector, you come back at the nearest station.
6. **Ship roster:** own several ships, kept at stations. The existing ship-design storage folds into the profile.
7. **Guests** keep today's behaviour (session only) with a prompt to register so progress is kept.

### B. Items and inventory

8. **One item catalogue** (`data/items.json`, rewritten) replacing the old ship system's items. Categories: resources (ores, gems, ice, gas), refined materials, components (from enemies), artefacts (from bosses), ship parts, weapon modules, plans, consumables. Five rarities: Common, Uncommon, Rare, Epic, Legendary.
9. **Cargo hold vs storage:** ship cargo is capped by its cargo parts (plus a small core allowance); storage is unlimited and only reachable while docked.
10. **Inventory window:** grid with stacks, tooltips, drag-and-drop, split, sort and filters; cargo and storage side by side when docked.
11. **Server validation of every item action:** move, split, sell, craft, jettison, equip. Checks docking state, capacity and ownership. Clients receive deltas, never the whole inventory.
12. **Loot pods:** drops float in space, are tractored in when close, and land in cargo. Jettisoned cargo becomes a pod.
13. **Death:** respawn at your last station. Cargo drops as a pod where you died (anyone can take it). Your ship comes back with every part at low HP and a **rebuild bill**: a share (around 40%, tunable) of the common minerals each part cost, paid from storage before launch. Parts whose bill isn't paid stay missing. Insurance consumables cover the bill.

### C. Mining

14. **Asteroid composition** by belt and system: common (iron, nickel, silicate, ice), mid-tier (copper, titanium), rare (crystal, gems). Seeded, so every client agrees.
15. **Mining with any weapon:** shots chip ore off rocks. Yield per damage is low for ordinary guns and high for mining lasers; each weapon has a `mining` block (yield multiplier, max hardness, waste).
16. **Mining laser part:** a continuous beam that heats the rock; chunks break off and the asteroid shrinks and splits as you mine.
17. **Hardness:** harder rock needs a better tool. Titanium needs a Mk2 laser (or heavy guns), void opal a Mk3; ordinary guns only crack the softest rock.
18. **Gem seams:** glowing veins (ruby, sapphire, void opal) on some asteroids, more common in dangerous sectors.
19. **Scanner part:** a pulse reveals composition and richness of nearby asteroids on screen and on the map.
20. **Gathering:** ice and gas near planets with a collector part; rare volatiles in comet tails.
21. **Motherlode events:** a rich field appears for a while, is announced to the system, and draws pirates.

### D. Refining, crafting and salvage

22. **Refinery (at stations):** ore → alloy, steel, titanium plate, composite, crystal lens, for a fee. Instant.
23. **Fabricator:** recipes in `data/recipes.json` turn materials and components into parts and weapons. Each recipe has a `time`; `0` means instant (basic hull pieces, ammo, small consumables). Everything else goes into the **station crafting queue**.
24. **Crafting queue:** timed jobs that run while you're away; collected on your next dock at that station. Queue length grows with engineering skill.
25. **Plans:** you start with basic recipes only. The rest come from quests, boss drops and faction vendors; learning a plan consumes it.
26. **Artefact modifiers:** adding an artefact to a recipe rolls bonus stats onto the result (the `buildShot` seam was written for this).
27. **Salvage:** tractor parts and components off wrecks before they crumble.

### E. Ship building

28. **The hangar uses only parts you own.** Refits consume and return parts; the hangar shows counts and what's missing.
29. **Ship plans:** "Build from plan" fills a design from storage and lists what's still needed. The premade blueprints become quest and vendor rewards.
30. **Core tiers cap size** (within the existing 255-part limit): Mk1 24, Mk2 60, Mk3 120, Capital 255. Better cores need boss artefacts.
31. **New part types:** cargo hold, scanner, tractor beam, collector, shield generator, point defence, repair bay, afterburner, heavy reactor, mining laser mount.
32. **Station repair** of lost parts costs common minerals (the same rule as the death rebuild); healing damaged parts stays free.
33. **Ship stats panel** in the hangar: mass, thrust, turn rate, DPS, power budget, cargo, mining rate, rebuild cost.

### F. Weapons

34. **Autocannon** (today's fixed cannon) in tiers.
35. **Railgun:** charges, then a long-range slug that passes through parts.
36. **Pulse laser:** instant-hit beam that builds heat. Good miner.
37. **Flak cannon:** airburst, strong against swarms and missiles.
38. **Missile launcher:** lock-on homing missiles that can be shot down.
39. **Mine layer.**
40. **Plasma lance:** short range, very high damage, melts armour.
41. **EMP projector:** drains the target's power network, briefly stopping thrusters and turrets (plugs into the flow solver).
42. **Legendary boss weapons:** Frostbite Lance (slows), Singularity Launcher (a small black hole that drags debris), Phase Cannon (passes the first part), Prism Splitter (beam splits on hit), Rustjaw's Hive (drone swarm), Cinder Bloom (sets targets burning).
43. **Firing costs:** weapons draw power; beams build heat. Loadout choices matter.

### G. Enemies and danger

44. **Sector danger tiers 1–7**, shown on the map and HUD: Sol 1, Glasswater 2, Borealis 3, Nebula Prime 4, Cinder Reach 5, Void Sector 6, The Maw 7. Danger rises with distance from stations; stations have defence turrets.
45. **PvP sectors:** Void Sector and The Maw are PvP; Cinder Reach has a PvP zone away from its station. Elsewhere players can't damage each other (shots pass through, no contact damage). Entering a PvP sector shows a warning; station rings are safe zones with turrets that fire on aggressors.
46. **Modular enemies:** enemies become ships built from blueprints, so they lose parts, blow up part by part and leave salvage.
47. **Factions** with their own look and behaviour: Sol Patrol (friendly), Pirates, Scavenger drones, Frost Brood, Cinder Cult, Void Wraiths, Maw Spawn.
48. **Behaviours:** patrol and guard fields, chase, kite, flank, swarm, flee and regroup, call reinforcements, ambush near derelicts, raid freighters.
49. **Elite variants** with traits: shielded, regenerating, explosive.
50. **Dynamic events:** pirate raid on a station, freighter under attack (help it for a reward), wraith incursion.

### H. Bosses

Shared framework: phases, telegraphed attacks, an arena, a boss health bar, loot shared by damage dealt, respawn timer, system-wide announcement. New bosses are mostly data.

51. **Rustjaw** (Nebula Prime): pirate dreadnought with turret batteries that launches fighters, then sheds armour and rams.
52. **Hoarfrost Matriarch** (Borealis): slows thrusters, spawns sprites, shard volleys.
53. **Cinder Warden** (Cinder Reach): fought in the corona, sweeping fire beams, ambient heat damage.
54. **Prism Colossus** (Glasswater): reflects lasers, drops gem artefacts.
55. **Void Leviathan** (Void Sector): phases, teleports, gravity pulls.
56. **Heart of the Maw** (The Maw): endgame, at the event horizon, built on gravity.

### I. Quests and story

57. **New step types:** mine, refine, craft, build a ship meeting conditions, deliver, escort (using freighter traffic), salvage, scan, defend, defeat a boss, reach a system.
58. **Main story, "The Silent Signal":** about 12 quests across every sector; ship plans are the rewards (Lancer, Hauler, Corsair, Hammerhead, Galleon, Bastion).
59. **Shipwright's apprenticeship:** the tutorial chain covering mine, refine, craft and refit.
60. **Miners' Guild chain:** laser tiers, the scanner and refinery access.
61. **Bounty boards:** repeatable generated contracts at each station, scaled to its danger.
62. **Faction reputation** unlocking vendors, plans and quests.
63. **Quest UI:** quest log, on-screen tracker, objective markers on the nav overlay and map, NPC dialogue.

### J. Economy and progression

64. **Station markets** with their own prices and demand, so trade runs pay.
65. **Skill tree:** levels give points across mining, gunnery, engineering and navigation.
66. **Gate licences:** jump gates into dangerous sectors open through quests.

### K. Visual and UI upgrades

67. Shield bubble shader with ripples where shots land.
68. Beam shaders for lasers, mining lasers and tractor beams.
69. Asteroid visuals: composition colours, glowing seams, fracturing into chunks.
70. Per-sector backdrops and ambient particles, tinted by danger; PvP sectors marked.
71. Faction colours and insignia; boss intro with camera pull-back and title card.
72. One docked-station screen: market, refinery, fabricator, queue, storage, hangar, repair, bounties.
73. Loot rarity colours with light beams and pickup notifications.
74. Boss health bar with each player's contribution.

### L. Playing together and getting around

75. **Autopilot:** fly to a job's destination (G), or click a station, gate, wreck or system on the map; routes through gates and uses the jump drive. Any flight key takes over.
76. **Parties** of up to four: shared kills (for jobs too), a wing bonus of 8% damage and mining yield per nearby wingmate, rally respawns beside a member, party chat (/p), and members on the map and as markers.
77. **Fleet operations:** party jobs on station boards that can't be done alone: relay uplinks (every beacon held at once), heavy convoys and outpost sieges, scaled to the party.
78. **Operations for everyone:** courier runs against the clock, derelict scans, freighter escorts and outpost defences.
79. **Trading between pilots:** both sides offer items and credits, both accept, the swap is atomic.
80. **Targeting and info cards:** Tab and T pick a target (missiles lock on); hovering over a pilot shows who they are and what they fly.
81. **Moving markets:** each station's wants change every few hours, selling saturates a market for a while, and the market shows where pays more. Faction quartermasters sell gear by reputation rank.
82. **Readable hangar stats** compared against the saved design; a guided first two minutes for new pilots; a ship marker when zoomed far out.

## How it's built

**Data-driven:** new JSON files for items, recipes, loot tables, factions, enemy blueprints, bosses, quests and PvP zones.

**Server modules** (not more lines in `GameServer.ts`): Profile, Inventory, Crafting, Mining, Loot, Market, EnemyDirector, BossDirector, QuestEngine, Events, PvpRules. Each is a class with a small host interface, like `ShipBridge`.

**Server authority:** clients send requests (mine here, craft this, sell that); the server validates and replies with results and deltas. Tests run through the in-process proto server, as the ship tests do.

## Phases

1. **Foundations** (A, B, 28): saving, one item catalogue, inventory window, hangar limited to owned parts, the new-player start, death rebuild bill. *Playable:* progress survives a restart; you start with only the Sparrow.
2. **Mining and crafting** (C, D, 29–33, 64): mining with any weapon, the mining laser, composition, refinery, fabricator with instant and queued recipes, markets. *Playable:* the full loop in Sol.
3. **Danger and combat** (34–41, 43–50): modular enemies and factions, danger tiers, PvP sectors and safe zones, new weapons, shields.
4. **Quests and story** (I, J): the quest engine additions, the main story with plan rewards, bounties, reputation, skill tree, gate licences.
5. **Bosses and legendaries** (42, H): the six bosses and the artefact system.
6. **Visuals, polish and balance** (K): spread through earlier phases where natural.

Phases 1 and 2 are the heaviest. Each phase is verified in the browser before the next starts.
