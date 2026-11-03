---
title: Bosses, the basics
order: 10
group: World
summary: What bosses do, how staged fights work, who gets paid, and a table of every boss with its level, rewards and respawn.
checked: 2026-11-04
sources: data/bosses.json (level, xp, credits, respawnSeconds, phases, loot only), server/src/game/Bosses.ts, common/src/ships/stages.ts, docs/boss-design.md, docs/areas/bosses-ai.md, client/src/ui/fieldGuide.ts
---
<!-- TODO: the "level" in data/bosses.json is shown as the boss's level. Whether it is a recommended pilot level or only a tier for scaling is not confirmed in the code read. -->
<!-- TODO: bosses.json hp is a multiplier of the design's health, not a number of hit points, so no HP figures are given. -->
<!-- TODO: only the Scrap Mother, Brood Mother and Pyreclast are confirmed as three-stage bosses (bespoke designs with staged parts). The other bosses are listed with their phase counts only. -->

## What a boss is

Bosses lair in particular systems (a skull on the system map). They bring escorts, change tactics as they break, and **telegraph their big attacks**: when a move is coming, a warning shows exactly where and when it will land, from about a second for quick moves to about two for the biggest. When you see one, get clear.

Everyone who fights a boss gets the XP, the credits, and their own loot, which goes to **storage**.

## Staged bosses

The Scrap Mother, Brood Mother and Pyreclast are fought in three stages, and each stage is its own fight.

- Each stage is an equal share of the health bar.
- Each stage has its own loop of moves, in a fixed order, and its own habit of movement. The last is the hardest.
- **Parts matter.** Shooting off a weapon part stops the move it powers. That is how you make a stage easier.
- A hit on a part belonging to a later stage is not wasted, but it is passed to the nearest part of the current stage at 40% of its damage. Aim at the stage in front of you.
- Between stages the boss cannot be hurt while it comes apart.
- Each stage gives you openings: the recovery after a move, a stun after a missed ram, a vent window where it takes more damage.

Other bosses have phases that begin at set points in the health bar, with new moves and sometimes an enrage.

## Getting paid

- You are paid if you damaged the boss in the last 60 seconds before it fell, or you were within 5,000 units of it when it fell, or the pilot you were mending or supporting was.
- **XP** is paid in full every time.
- **Credits** are paid in full the first time you kill a particular boss, then 25% on repeats.
- Your **loot** is rolled separately for each pilot. A rare part that you already hold is not given twice.
- One boss each week is **hunted**: everyone in on the kill gets double XP and credits.
- A boss comes back after its respawn time, counted in server time, so downtime counts.

Some bosses have a rare drop (3% to 6%) that a **legendary weapon** cannot be made without. See [Weapons and damage](/guides/weapons-and-damage).

### Loot of the staged bosses

| Boss | Drops (chance) |
|---|---|
| Scrap Mother | Scrap electronics (100%), alloy plate (100%), servo motor (100%), power coupling (80%), repair kit (60%) |
| Brood Mother | Frost gland (100%), aurora rime (100%), ice (100%), sapphire (40%) |
| Pyreclast | Titanium plate (100%), ruby (100%), cinder ember (6%) |

The Component Guide (**C**) lists what each boss drops.

## Every boss

| Boss | System | Level | XP | Credits | Respawn |
|---|---|---|---|---|---|
| Redtooth Hold | Ashfall Drift | 2 | 420 | 380 | 8 min |
| Redtooth Picket | Sol | 3 | 450 | 420 | 8 min |
| The Midden | Sol | 4 | 900 | 800 | 15 min |
| Redtooth Mammoth | Ashfall Drift | 4 | 1,000 | 900 | 15 min |
| Prism Colossus | Glasswater Expanse | 5 | 1,800 | 1,800 | 9 min |
| Foundry Warden | The Deep Foundry | 5 | 900 | 250 | arena |
| The Tallyman | Sol | 5 | 900 | 700 | 9 min |
| The Great Dredge | Glasswater Expanse | 5 | 1,400 | 1,300 | 15 min |
| Hollow Crown | Sol | 6 | 1,100 | 900 | 10 min |
| Hoarfrost Matriarch | Borealis | 7 | 2,200 | 2,400 | 10 min |
| Scrap Mother | The Scrap Mother's Nest | 8 | 2,400 | 2,400 | 10 min |
| Rimeback | Borealis | 8 | 2,400 | 2,200 | 15 min |
| Brood Mother | Borealis | 8 | 2,400 | 2,400 | 10 min |
| Rustjaw | Nebula Prime | 9 | 2,600 | 3,500 | 10 min |
| Hushwing | Borealis | 9 | 2,600 | 2,600 | 15 min |
| The Ironmonger | Nebula Prime | 10 | 3,000 | 3,200 | 15 min |
| The Ash Pilgrim | Cinder Reach | 17 | 5,000 | 5,500 | 15 min |
| Cinder Warden | Cinder Reach | 18 | 4,200 | 5,000 | 12 min |
| The Shroudhulk | Void Sector | 22 | 7,000 | 8,000 | 15 min |
| Void Leviathan | Void Sector | 23 | 6,000 | 7,000 | 13 min |
| Heart of the Maw | The Maw | 26 | 10,000 | 12,000 | 15 min |
| The Pyreclast | The Pyreclast's Cavern | 30 | 12,000 | 15,000 | 15 min |

The Foundry Warden is an arena fight, with no respawn timer.

## Tips

- Bring the right gun for the armour. Armour two steps above your gun's penetration takes only a quarter of the damage. See [Weapons and damage](/guides/weapons-and-damage).
- Weak points first: take off the part that powers the move you cannot dodge.
- Fight in a party. Everyone present is paid and has their own loot. See [Parties and chat](/guides/parties-and-chat).
- Bring repair kits and hold still to use them between stages, or fight close enough to a station for its repairs to reach you.
- A point-defence turret shoots down a boss's seekers and missiles: it takes two hits for a seeker. It cannot touch shells, beams or rings of shots.
- Check your ship's **rating** against the boss's before you go in. See [Weapons and damage](/guides/weapons-and-damage).
