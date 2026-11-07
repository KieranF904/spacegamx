# Heavier shots (2026-11)

Kieran's direction (2026-11-07): fewer rapid-fire weapons and heavier rounds. Rapid guns may stay, but slower and harder;
balance on the damage that lands, not the damage on paper; vary round speed by role (fast precise rounds for precision
guns, slow heavy dodgeable rounds only with big damage); point defence still catches missiles; enemies and bosses keep
working. This doc is the measurement and a proposal.

**Applied 2026-11-07** (scripts/econ/models.mjs, regenerated): the bench without `--after` now prints the After table
below exactly, and `PROPOSAL` in the bench is empty. On top of the proposal, as it went in:
- the Chainsaw's `demand` 10.5 -> 22.4: a spin gun's legacy draw is demand x its interval over its beat, so the slower
  top beat would have halved its energy a second; 22.4 keeps its spun-up 22.4 E/s per cell. The hangar now shows a
  spinning gun's spun-up draw (partStats), 22 either way;
- the Leviathan's `maxSpeed` is its speed, 10 (it never accelerates), so the hangar's reach reads its real 3,430
  (it showed 8,580);
- augments of the clip and spin guns (Twinlink, Chainsaw, Overpulse, Rail Driver) cost more a shot and buffer a clip,
  keeping their E a second;
- part descriptions and trade-off lines name the new rates and round counts.
The side findings below are still open.

Bench: `scripts/bench/heavierShots.ts`, run from game-v2/ (about 2 s, no world, no server):

    server/node_modules/.bin/tsx scripts/bench/heavierShots.ts --md                     # before: the game data as it is
    server/node_modules/.bin/tsx scripts/bench/heavierShots.ts --md --after             # the proposal applied in memory
    server/node_modules/.bin/tsx scripts/bench/heavierShots.ts --md --enemy [--after]   # enemy and ward guns at player ships, AI lead
    server/node_modules/.bin/tsx scripts/bench/heavierShots.ts --pd [--after]           # point defence against each interceptable round
    (--only id,id for a few guns)

## How it measures

It steps the shared deterministic weapon code; nothing about firing is re-implemented: `stepGuns` (every firing model:
cycle, clip, charge, spin, semi-automatic clicks, ammo), `volleyShells`/`launchShot` (spread, jitter, bursts, the same
seeds), `gunDef` (model mods), `distDue` (the held aim distance's due ticks), `guideTick` (the homing waypoint law),
`steerToward` (the Hammerhead's guided steer), `aimReach`/`lifeToReach` (mortars and aim bursts), `castParts` /
`nearestParts` (hits on real part outlines; splashAt's `reach` nearest parts and 1 - 0.7 d/r falloff), and
`hitMultiplier` (type x armour x penetration). The flight of a shell (straight, salvo and walk queues, fuses, splits) is
the bench's, written after server Weapons.ts.

- **Shooter**: the Sparrow T with one Pip swapped for the gun (the other made hull), standing still, trigger held
  (a semi-automatic gun clicked every few ticks, as a player spams it). A fixed gun's ship turns onto the aim exactly
  (an idealised pilot); a turret slews as it does in game.
- **Aim**: a competent pilot. Pilots get no aim assist and no lead from the game (the AI's lead is in
  bodies/aiPilot.ts and is only theirs), so the bench leads as a good player does: the intercept point for a round at the
  gun's own launch speed, from a smoothed read of the target's velocity (a 10-tick reaction), with a 0.004 rad hand
  wobble. Homing rounds lock the target; the Hammerhead is steered at the cursor; mortars land on the held aim distance.
- **Targets**: enemy designs at their real top speed and thrust, facing the shooter as an engaged AI does, flying across
  the line of fire and reversing at seeded random times, each at 400, 900 and 1,600:
  - small: Pirate Skiff, radius 66, 29.7 u/tick, jinking every 0.5-1.2 s
  - mid: Pirate Raider, radius 64, 18.6 u/tick, weaving every 1.5-3 s
  - large: Pirate Gunship, radius 89, 5.5 u/tick (60 % of its top speed), turning every 4-7 s
- **Numbers** (15 s of fire, two jink seeds, shells in flight allowed to land): volleys/s and shells/s; **stated DPS**
  (each shell's nominal direct + splash damage x shells/s, reloads and charges included); **landed DPS** (what came off
  the target's HP: through armour, and never more than a part had left, since overkill is lost as in hitRules
  `partHit`; a target whose core dies is put back whole); **hit rate** (shells that struck or burst on the target);
  **dist upd/s** (ticks `distDue` says the held aim distance goes out while firing: each a gun row of about 3.2 B, 25.7
  bits, to every client stepping that ship, docs/audits/bitpack-2026-11-06.md). Landed is averaged over the three ranges.
- **Left out**: shields (the targets have none; the pulse guns' x1.6-1.9 against shields is not shown), arc chains
  and pierce (one target), EMP, the Singularity's pull, beams and the Glint's pulse (no rounds: a beam's aim distance
  goes every tick it burns, which is its own byte question). Guns with few shots in 30 s (Longbarrel, Bastion,
  Leviathan, Singularity) are noisy, a few shots either way.

## Before

| gun | volleys/s | shells/s | dmg/shell | speed | splash r/dmg | stated DPS | landed small | landed mid | landed large | hit% small / mid / large | dist upd/s | ~B/s |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|---:|---:|
| Pip | 4.0 | 4.0 | 14.0 | 48.0 |  | 56.0 | 11.2 | 16.6 | 18.8 | 21% / 36% / 83% | 7.9 | 25.4 |
| Hammer | 1.5 | 1.5 | 48.0 | 38.0 |  | 70.4 | 11.9 | 18.1 | 34.9 | 17% / 29% / 75% | 2.8 | 9.0 |
| Twinlink | 5.3 | 5.3 | 12.0 | 48.0 |  | 64.0 | 13.9 | 24.6 | 27.9 | 20% / 37% / 58% | 10.6 | 33.9 |
| Longbarrel | 0.3 | 0.3 | 170 | 140 |  | 45.3 | 7.7 | 21.6 | 18.0 | 46% / 92% / 100% | 0.6 | 1.9 |
| Bastion | 0.7 | 0.7 | 180 | 32.0 |  | 120 | 4.8 | 8.0 | 35.1 | 12% / 18% / 65% | 1.2 | 3.8 |
| Rattler | 8.6 | 8.6 | 5.0 | 54.0 |  | 43.0 | 7.2 | 9.3 | 7.1 | 22% / 31% / 55% | 17.1 | 54.6 |
| Chainsaw | 15.4 | 15.4 | 5.0 | 54.0 |  | 77.0 | 15.0 | 19.7 | 20.4 | 18% / 26% / 44% | 30.7 | 98.3 |
| Stinger | 4.8 | 4.8 | 8.0 | 54.0 |  | 38.4 | 10.0 | 14.9 | 27.5 | 23% / 36% / 85% | 9.5 | 30.3 |
| Burst | 1.8 | 1.8 | 5.0 | 34.0 | 170/16 | 37.8 | 8.5 | 11.6 | 8.7 | 20% / 27% / 43% | 3.5 | 11.1 |
| Cloudmaker | 1.1 | 1.1 | 5.0 | 34.0 | 250/26 | 33.1 | 29.2 | 34.5 | 36.7 | 29% / 32% / 46% | 2.1 | 6.6 |
| Lobber | 0.7 | 0.7 | 0.0 | 22.0 | 220/70 | 46.7 | 26.7 | 20.0 | 61.9 | 18% / 18% / 62% | 1.3 | 4.1 |
| Quake | 0.3 | 1.0 | 0.0 | 22.0 | 260/60 | 60.0 | 34.2 | 44.6 | 94.0 | 17% / 19% / 31% | 0.6 | 1.9 |
| Strobe | 2.0 | 6.0 | 9.0 | 72.0 |  | 54.0 | 11.6 | 14.2 | 14.9 | 28% / 39% / 66% | 3.9 | 12.6 |
| Overpulse | 4.8 | 4.8 | 9.0 | 72.0 |  | 43.2 | 13.9 | 19.6 | 38.0 | 29% / 42% / 77% | 9.5 | 30.5 |
| Dart | 0.6 | 0.6 | 30.0 | 14.0 | 120/34 | 38.4 | 63.9 | 67.5 | 35.6 | 87% / 100% / 100% | 1.1 | 3.4 |
| Swarm | 1.3 | 2.7 | 10.0 | 14.0 | 60/12 | 58.7 | 96.7 | 107 | 94.9 | 88% / 100% / 100% | 2.6 | 8.3 |
| Hammerhead | 0.3 | 0.3 | 105 | 9.8 | 150/54 | 53.0 | 62.1 | 95.1 | 94.3 | 70% / 87% / 93% | 0.6 | 1.9 |
| Needle | 0.8 | 0.8 | 62.0 | 150 |  | 49.6 | 23.5 | 35.5 | 36.3 | 57% / 79% / 100% | 1.5 | 4.9 |
| Coilgun | 1.1 | 5.7 | 16.0 | 150 |  | 90.7 | 19.5 | 19.4 | 28.2 | 22% / 20% / 34% | 2.2 | 7.0 |
| Spear | 0.5 | 0.5 | 160 | 150 |  | 85.3 | 21.2 | 31.7 | 41.5 | 58% / 85% / 100% | 1.0 | 3.2 |
| Spark | 1.3 | 1.3 | 28.9 | 110 |  | 38.5 | 14.5 | 20.8 | 35.2 | 38% / 56% / 99% | 2.6 | 8.3 |
| Eel | 0.3 | 0.3 | 420 | 6.0 | 90/80 | 133 | 32.1 | 71.3 | 79.5 | 42% / 83% / 96% | 0.5 | 1.5 |
| Leviathan | 0.3 | 0.3 | 560 | 6.6 | 160/120 | 227 | 0.0 | 0.0 | 31.3 | 0% / 0% / 13% | 0.6 | 1.9 |
| Rustjaw's Hive | 0.4 | 1.6 | 10.0 | 12.0 | 70/12 | 35.2 | 60.0 | 68.4 | 63.4 | 86% / 100% / 100% | 4.0 | 12.8 |
| Cinder Bloom | 0.9 | 0.9 | 16.0 | 36.0 |  | 13.9 | 5.3 | 12.8 | 24.0 | 12% / 28% / 54% | 1.6 | 5.1 |
| Prism Splitter | 0.7 | 0.7 | 22.0 | 40.0 |  | 14.7 | 3.1 | 7.0 | 15.9 | 15% / 30% / 65% | 1.2 | 3.8 |
| Phase Cannon | 0.5 | 0.5 | 70.0 | 30.0 |  | 32.7 | 4.3 | 3.1 | 19.7 | 14% / 12% / 62% | 0.9 | 2.8 |
| Singularity Launcher | 0.2 | 0.2 | 0.0 | 9.0 | 300/140 | 28.0 | 7.8 | 13.9 | 49.2 | 6% / 11% / 28% | 0.3 | 0.9 |
| Rail Driver | 2.8 | 2.8 | 40.0 | 150 |  | 112 | 53.9 | 72.5 | 98.0 | 54% / 72% / 100% | 35.1 | 112 |
| Slurry Cannon | 1.5 | 1.5 | 48.0 | 38.0 |  | 70.4 | 11.3 | 18.3 | 42.7 | 17% / 29% / 75% | 2.8 | 9.0 |

What it says:

- **Spray guns land a fifth to a third of their paper DPS on anything that moves.** Chainsaw: 77 stated, 15 / 20 / 20
  landed (small / mid / large), 18-44 % hits. Rattler: 43 stated, 7 / 9 / 7. Twinlink: 64 stated, 14 / 25 / 28. Misses
  past 900 take most of it, and armour the rest: 5-damage rounds at pen -0.5 lose most to plating (the Rattler's raw
  landed on the Gunship is 24, through armour 7).
- **Round speed decides hit rate far more than rate of fire.** At the same lead, 48-54 u/tick rounds hit the jinking
  Skiff 8-15 % past 900; the 150 rails hit it 38-54 %; the 110 Spark 20-30 %. A round's chance doesn't depend on how many
  others are fired, so cutting the rate and raising the damage keeps landed DPS where it was, and a faster round
  raises it.
- **Very heavy slow rounds waste on overkill.** The Bastion's 180 lands 35 on the Gunship from 78 raw: half goes to
  armour and to parts that had less than 180 HP left. Heavier is not free: a round heavier than the parts it meets
  loses the rest.
- **Homing ordnance lands nearly all of it** (Dart, Swarm, Hive, Hammerhead 70-100 %), more than stated where a blast
  reaches several parts.
- **The Leviathan never hits anything that moves**: it has no homing, and only homing or guided shells accelerate
  (server Weapons.tick), so it flies its whole life at its launch speed, 6 x 1.1 = 6.6 u/tick, not "straight and fast".
- **Bytes**: the aim distance follows the fire rate (about two updates a fire interval): the Chainsaw 30.7 updates/s
  (~98 B/s to each client stepping that ship), the Rattler 17.1, the Twinlink 10.6. The Rail Driver shows 35/s because
  `distDue` counts a semi-automatic gun as due on every tick a click waits with its cooldown spent, and through its
  clip reload the cooldown is already 0: clicking through a reload sends the distance every tick (Side findings 2).

## Proposal

Principle: per gun, shells/s roughly halved for the hose guns and cut by a third for the bursts; damage a round raised
so damage x rate stays about the same (a little more where spray wasted it); round speed set by role. Only model rows
change (scripts/econ/models.mjs: the W row's `weaponMods` and the `FIRE` block; then `node scripts/econ/models.mjs`).
No kind in data/ships/tuning.json changes, so every enemy design and boss is untouched (below).

| gun | role | fire (before -> after) | dmg/round | round speed | other |
|---|---|---|---:|---:|---|
| Pip | starter, steady | cycle 15 t -> **20 t** (4 -> 3/s) | 14 -> **18** | 48 -> **54** | life 150 -> 133 (reach kept) |
| Hammer | slow heavy breacher | cycle 42 t -> **60 t** (1.43 -> 1/s) | 48 -> **88** | 38 (kept: slow, dodgeable) | |
| Twinlink | burst turret | clip 16 @ 6 t, reload 90 -> **clip 8 @ 10 t, reload 80** | 12 -> **20** | 48 -> **62** | life 150 -> 116 |
| Rattler | the hose | cycle 7 t -> **15 t** (8.6 -> 4/s) | 5 -> **11** | 54 -> **62** | life 100 -> 87 |
| Chainsaw | minigun | spin 15 -> 3.75 t (4 -> 16/s) -> **spin 24 -> 8 t (2.5 -> 7.5/s)**, up 60, down 30 | 5 -> **11** | 54 | |
| Stinger | marksman SMG | clip 12 @ 7.5 t, reload 72 -> **clip 6 @ 12 t, reload 60** | 8 -> **12** | 54 -> **88** | life 100 -> 61 |
| Strobe | shield pressure | 3-bolt burst every 30 t -> **2-bolt burst** every 30 t | 9 -> **14** | 72 -> **84** | life 70 -> 60 |
| Overpulse | shield shredder | clip 12 @ 6 t, reload 90 -> **clip 6 @ 10 t, reload 60** | 9 -> **13** | 72 -> **96** | life 70 -> 53 |
| Coilgun | rail shotgun | 5 slugs in +-6 deg -> **3 slugs in +-3 deg**, every 54 t | 16 -> **25** | 150 | |
| Rail Driver | semi-auto clip | clip 6 @ 10 t, reload 90 -> **clip 4 @ 12 t**, reload 90 | 40 -> **60** | 150 | |
| Leviathan | fight-ender | unchanged | 560 | 6.6 -> **10** | life 520 -> 343 (reach kept) |

(Lives keep each round's reach, speed x life, as the bench's proposal works them out.)

Unchanged on purpose: Longbarrel (already one charged shot; 140 is the precision round), Bastion (overkill: +22 %
damage gave +3 % landed in a trial), Needle and Spear (150 rails, already few shots), Burst and Cloudmaker flak (1-2/s,
area), mortars, Dart, Swarm (its job is to flood point defence with small rockets), Hammerhead, Eel, Spark (110, 1.3/s),
the legendaries, the Slurry Cannon, beams.

The round-speed spread after: 10 Leviathan, 22 mortars, 32 Bastion, 34 flak, 38 Hammer, 54 Pip and Chainsaw, 62 Rattler
and Twinlink, 84 Strobe, 88 Stinger, 96 Overpulse, 110 Spark, 140 Longbarrel, 150 rails (missiles 14 ramping to 44,
the Eel to 15). Slow means heavy: every round at 38 or under hits for 88+ or bursts.

Energy: keep each gun's energy a second. A cycle gun's shot is `intake x interval / 60` (models.mjs ENERGY), so a
longer interval with the same intake costs more a shot and the same a second: leave `intake`. Set the W row's `demand`
(or `k.dmg`) so the legacy pool draw stays today's (its formula reads dmg x burst / int). Clip guns keep `reloadE` per
reload (damage a clip stays close: Twinlink 192 -> 160, Stinger 96 -> 72, Overpulse 108 -> 78, Rail Driver 240 -> 240);
`buffer` follows `clip`. Descriptions that name numbers change with them (Pip "four ... shells a second", Chainsaw "four
... to sixteen", Stinger "twelve", Strobe "a burst of 3 ... 9 damage", Overpulse "a clip of 12 ... 10 a second", Coilgun
"five slugs", Rail Driver's clip, Leviathan "flies straight and fast").

## After (rerun with the proposal in memory)

| gun | volleys/s | shells/s | dmg/shell | speed | splash r/dmg | stated DPS | landed small | landed mid | landed large | hit% small / mid / large | dist upd/s | ~B/s |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|---:|---:|
| Pip | 3.0 | 3.0 | 18.0 | 54.0 |  | 54.0 | 12.2 | 17.3 | 19.1 | 25% / 41% / 85% | 5.9 | 19.0 |
| Hammer | 1.0 | 1.0 | 88.0 | 38.0 |  | 88.0 | 9.7 | 17.2 | 34.9 | 16% / 30% / 76% | 1.9 | 6.2 |
| Twinlink | 3.2 | 3.2 | 20.0 | 62.0 |  | 64.0 | 19.3 | 23.8 | 30.3 | 30% / 36% / 65% | 6.3 | 20.3 |
| Longbarrel | 0.3 | 0.3 | 170 | 140 |  | 45.3 | 7.7 | 21.6 | 18.0 | 46% / 92% / 100% | 0.6 | 1.9 |
| Bastion | 0.7 | 0.7 | 180 | 32.0 |  | 120 | 4.8 | 8.0 | 35.1 | 12% / 18% / 65% | 1.2 | 3.8 |
| Rattler | 4.0 | 4.0 | 11.0 | 62.0 |  | 44.0 | 8.9 | 11.4 | 8.7 | 27% / 39% / 66% | 7.9 | 25.4 |
| Chainsaw | 7.3 | 7.3 | 11.0 | 54.0 |  | 79.9 | 16.4 | 18.1 | 18.7 | 20% / 25% / 40% | 14.5 | 46.3 |
| Stinger | 3.1 | 3.1 | 12.0 | 88.0 |  | 37.6 | 15.2 | 20.7 | 29.6 | 37% / 52% / 94% | 6.1 | 19.6 |
| Burst | 1.8 | 1.8 | 5.0 | 34.0 | 170/16 | 37.8 | 8.5 | 11.6 | 8.7 | 20% / 27% / 43% | 3.5 | 11.1 |
| Cloudmaker | 1.1 | 1.1 | 5.0 | 34.0 | 250/26 | 33.1 | 29.2 | 34.5 | 36.7 | 29% / 32% / 46% | 2.1 | 6.6 |
| Lobber | 0.7 | 0.7 | 0.0 | 22.0 | 220/70 | 46.7 | 26.7 | 20.0 | 61.9 | 18% / 18% / 62% | 1.3 | 4.1 |
| Quake | 0.3 | 1.0 | 0.0 | 22.0 | 260/60 | 60.0 | 34.2 | 44.6 | 94.0 | 17% / 19% / 31% | 0.6 | 1.9 |
| Strobe | 2.0 | 4.0 | 14.0 | 84.0 |  | 56.0 | 12.1 | 13.8 | 13.6 | 29% / 38% / 58% | 3.9 | 12.6 |
| Overpulse | 3.3 | 3.3 | 13.0 | 96.0 |  | 43.3 | 16.4 | 21.6 | 40.9 | 36% / 49% / 82% | 6.5 | 20.9 |
| Dart | 0.6 | 0.6 | 30.0 | 14.0 | 120/34 | 38.4 | 63.9 | 67.5 | 35.6 | 87% / 100% / 100% | 1.1 | 3.4 |
| Swarm | 1.3 | 2.7 | 10.0 | 14.0 | 60/12 | 58.7 | 96.7 | 107 | 94.9 | 88% / 100% / 100% | 2.6 | 8.3 |
| Hammerhead | 0.3 | 0.3 | 105 | 9.8 | 150/54 | 53.0 | 62.1 | 95.1 | 94.3 | 70% / 87% / 93% | 0.6 | 1.9 |
| Needle | 0.8 | 0.8 | 62.0 | 150 |  | 49.6 | 23.5 | 35.5 | 36.3 | 57% / 79% / 100% | 1.5 | 4.9 |
| Coilgun | 1.1 | 3.4 | 25.0 | 150 |  | 85.0 | 24.5 | 23.9 | 35.0 | 30% / 29% / 48% | 2.2 | 7.0 |
| Spear | 0.5 | 0.5 | 160 | 150 |  | 85.3 | 21.2 | 31.7 | 41.5 | 58% / 85% / 100% | 1.0 | 3.2 |
| Spark | 1.3 | 1.3 | 28.9 | 110 |  | 38.5 | 14.5 | 20.8 | 35.2 | 38% / 56% / 99% | 2.6 | 8.3 |
| Eel | 0.3 | 0.3 | 420 | 6.0 | 90/80 | 133 | 32.1 | 71.3 | 79.5 | 42% / 83% / 96% | 0.5 | 1.5 |
| Leviathan | 0.3 | 0.3 | 560 | 10.0 | 160/120 | 227 | 6.2 | 5.2 | 31.2 | 3% / 3% / 17% | 0.6 | 1.9 |
| Rustjaw's Hive | 0.4 | 1.6 | 10.0 | 12.0 | 70/12 | 35.2 | 60.0 | 68.4 | 63.4 | 86% / 100% / 100% | 4.0 | 12.8 |
| Cinder Bloom | 0.9 | 0.9 | 16.0 | 36.0 |  | 13.9 | 5.3 | 12.8 | 24.0 | 12% / 28% / 54% | 1.6 | 5.1 |
| Prism Splitter | 0.7 | 0.7 | 22.0 | 40.0 |  | 14.7 | 3.1 | 7.0 | 15.9 | 15% / 30% / 65% | 1.2 | 3.8 |
| Phase Cannon | 0.5 | 0.5 | 70.0 | 30.0 |  | 32.7 | 4.3 | 3.1 | 19.7 | 14% / 12% / 62% | 0.9 | 2.8 |
| Singularity Launcher | 0.2 | 0.2 | 0.0 | 9.0 | 300/140 | 28.0 | 7.8 | 13.9 | 49.2 | 6% / 11% / 28% | 0.3 | 0.9 |
| Rail Driver | 2.0 | 2.0 | 60.0 | 150 |  | 119 | 53.0 | 80.3 | 88.9 | 51% / 74% / 100% | 38.7 | 124 |
| Slurry Cannon | 1.5 | 1.5 | 48.0 | 38.0 |  | 70.4 | 11.3 | 18.3 | 42.7 | 17% / 29% / 75% | 2.8 | 9.0 |

Compact, the guns that change:

| gun | shells/s | dmg/round | round speed | landed small | landed mid | landed large | dist upd/s |
|---|---|---|---|---|---|---|---|
| Pip | 4.0 -> 3.0 | 14 -> 18 | 48 -> 54 | 11.2 -> 12.2 | 16.6 -> 17.3 | 18.8 -> 19.1 | 7.9 -> 5.9 |
| Hammer | 1.5 -> 1.0 | 48 -> 88 | 38 | 11.9 -> 9.7 | 18.1 -> 17.2 | 34.9 -> 34.9 | 2.8 -> 1.9 |
| Twinlink | 5.3 -> 3.2 | 12 -> 20 | 48 -> 62 | 13.9 -> 19.3 | 24.6 -> 23.8 | 27.9 -> 30.3 | 10.6 -> 6.3 |
| Rattler | 8.6 -> 4.0 | 5 -> 11 | 54 -> 62 | 7.2 -> 8.9 | 9.3 -> 11.4 | 7.1 -> 8.7 | 17.1 -> 7.9 |
| Chainsaw | 15.4 -> 7.3 | 5 -> 11 | 54 | 15.0 -> 16.4 | 19.7 -> 18.1 | 20.4 -> 18.7 | 30.7 -> 14.5 |
| Stinger | 4.8 -> 3.1 | 8 -> 12 | 54 -> 88 | 10.0 -> 15.2 | 14.9 -> 20.7 | 27.5 -> 29.6 | 9.5 -> 6.1 |
| Strobe | 6.0 -> 4.0 | 9 -> 14 | 72 -> 84 | 11.6 -> 12.1 | 14.2 -> 13.8 | 14.9 -> 13.6 | 3.9 -> 3.9 |
| Overpulse | 4.8 -> 3.3 | 9 -> 13 | 72 -> 96 | 13.9 -> 16.4 | 19.6 -> 21.6 | 38.0 -> 40.9 | 9.5 -> 6.5 |
| Coilgun | 5.7 -> 3.4 | 16 -> 25 | 150 | 19.5 -> 24.5 | 19.4 -> 23.9 | 28.2 -> 35.0 | 2.2 -> 2.2 |
| Rail Driver | 2.8 -> 2.0 | 40 -> 60 | 150 | 53.9 -> 53.0 | 72.5 -> 80.3 | 98.0 -> 88.9 | 35.1 -> 38.7 (click artifact) |
| Leviathan | 0.3 | 560 | 6.6 -> 10 | 0 -> 6.2 | 0 -> 5.2 | 31.3 -> 31.2 | 0.6 |

- Shells a second across these eleven guns: 59.2 -> 34.6 (-42 %); the Chainsaw and Rattler halve.
- Landed DPS per role within about +-10 %, except where faster rounds stop wasting the spray: Twinlink +39 % on the
  small ship, Stinger +52 % / +39 % on small / mid (it becomes the precise SMG it says it is), Coilgun +25 %, Rattler
  +20 %. The Hammer gives up a little on the jinking Skiff (it is the slow round you can dodge) and holds the rest.
- Aim-distance updates while firing, summed over every gun in the table: 160 -> 125 a second; the Chainsaw alone 30.7
  -> 14.5 (about 98 -> 46 B/s to each client stepping that ship), the Rattler 17.1 -> 7.9.
- Overkill: heavier rounds start to lose damage to parts with less HP left (the Rail Driver's large-ship number falls
  98 -> 89 at +50 % a round). Past about 60-90 a round, extra weight mostly doesn't land on mid hulls; the proposal
  stays under that except the Hammer (88, and its landed held).

## Point defence

Point defence is unchanged (a shot every 12 ticks, instant hits, range 560). Its hits don't fly, so fewer shots
elsewhere change nothing for it; what matters is how long a round spends in its range. One turret, a round flying
straight at it:

| round | top speed | ticks in range (from 900 / 1600) | PD shots, 1 turret | hits each | shells a volley | one turret stops |
|---|---:|---:|---:|---:|---:|---|
| Lobber | 22.0 | 24 / 23 | 2 | 1 | 1 | 1 of 1 |
| Quake | 22.0 | 24 / 23 | 2 | 1 | 3 | 2 of 3 (needs 2 turrets) |
| Dart | 44.0 | 16 / 13 | 2 | 1 | 1 | 1 of 1 |
| Swarm | 44.0 | 16 / 13 | 2 | 1 | 2 | 2 of 2 |
| Hammerhead | 30.8 | 17 / 17 | 2 | 2 | 1 | 1 of 1 |
| Eel | 15.0 | 39 / 34 | 3 | 3 | 1 | 1 of 1 |
| Leviathan | 6.6 | 77 / 77 | 7 | 5 | 1 | 1 of 1 |
| Rustjaw's Hive | 38.0 | 16 / 14 | 2 | 1 | 4 | 2 of 4 (needs 2 turrets) |

After, only the Leviathan's row changes:

| round | top speed | ticks in range (from 900 / 1600) | PD shots, 1 turret | hits each | shells a volley | one turret stops |
|---|---:|---:|---:|---:|---:|---|
| Leviathan | 10.0 | 51 / 51 | 5 | 5 | 1 | 1 of 1 |

At 10 u/tick one turret still stops a Leviathan (5 shots in its 51 ticks in range, for its 5 hits). 16 would read as
"fast" but would need two turrets (3 shots). The Quake's three shells and the Hive's four already need two turrets; the
Swarm pair is caught by one, as now.

## Enemies, bosses and wards

- **Enemy designs** (data/ships/blueprints/enemy) carry only legacy functions (`weapon`, `autocannon`, `flak`,
  `missile`, `railgun`, `mortar`, `torpedo`, `arc`, `magma_cannon`, `emp`, `laser`, `lance`...). Their shells come from
  the kinds in tuning.json, which the proposal does not touch. The Rattler's model has no mods, so today an enemy
  autocannon and a Rattler fire the same shell; after the change they differ (the enemy keeps 5 dmg at 54).
- **Bosses** fire their own kinds from their brains (`Weapons.spawn`: rivet, scrap_chunk, seam_seeker, heart_*,
  prism_shard...): untouched.
- **Wards carry model guns**: outposts (bulwark.json) a Pip and two Rattlers, escorted freighters (hauler.json) two
  Rattlers and two Chainsaws. They shoot back with the AI's aim, which leads every shell as if it flew 45 u/tick for at
  most 40 ticks (bodies/aiPilot.ts `tof = min(40, d / 45)`), so faster rounds are over-led. Measured with that aim at
  player ships (`--enemy`; small Sparrow T 20.8 u/tick, mid Halberd 12.6, large Bulwark 7.9 at 60 %):

| gun | volleys/s | shells/s | dmg/shell | speed | splash r/dmg | stated DPS | landed small | landed mid | landed large | hit% small / mid / large | dist upd/s | ~B/s |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---|---:|---:|
| Cannon | 4.0 | 4.0 | 14.0 | 48.0 |  | 56.0 | 18.2 | 19.3 | 10.6 | 36% / 58% / 58% | 7.9 | 25.4 |
| Autocannon | 8.6 | 8.6 | 5.0 | 54.0 |  | 43.0 | 10.9 | 13.4 | 6.7 | 34% / 67% / 56% | 17.1 | 54.6 |
| Flak Cannon | 1.8 | 1.8 | 5.0 | 34.0 | 170/16 | 37.8 | 13.6 | 11.7 | 17.1 | 29% / 41% / 50% | 3.5 | 11.1 |
| Missile Launcher | 0.6 | 0.6 | 30.0 | 14.0 | 120/34 | 38.4 | 61.7 | 46.0 | 48.1 | 100% / 100% / 100% | 1.1 | 3.4 |
| Railgun | 0.8 | 0.8 | 62.0 | 150 |  | 22.4 | 14.3 | 19.3 | 9.5 | 63% / 82% / 56% | 1.5 | 4.9 |
| Mortar | 0.7 | 0.7 | 0.0 | 22.0 | 220/70 | 46.7 | 35.7 | 57.8 | 53.1 | 32% / 43% / 50% | 1.3 | 4.1 |
| Torpedo Tube | 0.3 | 0.3 | 420 | 6.0 | 90/80 | 60.1 | 2.1 | 10.3 | 4.6 | 4% / 17% / 8% | 0.5 | 1.5 |
| Arc Projector | 1.3 | 1.3 | 34.0 | 110 |  | 45.3 | 6.3 | 4.7 | 3.1 | 17% / 15% / 14% | 2.6 | 8.3 |
| Magma Cannon | 0.5 | 0.5 | 30.0 | 16.0 | 240/34 | 34.1 | 16.1 | 36.5 | 24.8 | 17% / 42% / 29% | 0.9 | 3.0 |
| Pip | 4.0 | 4.0 | 14.0 | 48.0 |  | 56.0 | 20.8 | 26.4 | 15.0 | 41% / 79% / 81% | 7.9 | 25.4 |
| Rattler | 8.6 | 8.6 | 5.0 | 54.0 |  | 43.0 | 11.0 | 13.5 | 6.7 | 34% / 67% / 57% | 17.1 | 54.6 |
| Chainsaw | 15.4 | 15.4 | 5.0 | 54.0 |  | 77.0 | 22.7 | 36.7 | 17.0 | 28% / 59% / 47% | 30.7 | 98.3 |

  After, only the three ward guns change: Pip 20.8 / 26.4 / 15.0 -> 19.5 / 27.7 / 14.4, Rattler 11.0 / 13.5 / 6.7 ->
  12.5 / 15.1 / 6.7, Chainsaw 22.7 / 36.7 / 17.0 -> 23.4 / 37.0 / 16.8 (landed at Sparrow T / Halberd / Bulwark): wards
  hit as hard as before with half the shells. Every legacy row is identical before and after (the bench prints both).

## Side findings (not part of the proposal; each its own decision)

1. **The Leviathan never accelerates** (above). Either the proposal's speed 10, or give non-homing torpedoes their
   `accel`/`maxSpeed` in Weapons.tick (that changes the kind for the enemy `torpedo` function too, and point defence
   would then need more turrets).
2. **Semi-automatic aim distance through a reload** (FIXED 2026-11-07: `distDue` asks `semiLoaded`; the bench's Rail
   Driver went from 38.7 to 1.9 dist upd/s, 124 to 6 B/s): `distDue` (common/src/ships/guns.ts) returns true for a semi gun
   whenever a click waits and the cooldown is spent, without checking a clip reload, so a player clicking through the
   Rail Driver's 1.5 s reload sends the aim distance every tick (35-39 updates/s in the bench, about 120 B/s to each
   watcher). Treating a reloading semi clip like any clip (due at the reload's end and half) would bring that to about
   4. It is shared deterministic code (server, own prediction, lanes), so the parity tests go with it.
3. **The AI leads every gun as if its rounds flew 45 u/tick.** (FIXED 2026-11-07: it leads by its main gun's round,
   common bodies/aiLead.ts; the bench's `--enemy` AI aim uses it. Railgun hit rate 63/82/56 % -> 92/100/100 %,
   the slow guns a little up, the 45-ish guns unchanged; enemy balance is up to Kieran.) With rounds spread from 10 to 150 it over-leads fast
   rounds and under-leads slow ones; reading the gun's own speed would be cheap. Enemy balance today is tuned around
   the current misses, so it's left alone here.

## Applying it (when Kieran says go)

1. scripts/econ/models.mjs: the W rows (Pip, Hammer, Twinlink, Rattler, Chainsaw, Stinger, Strobe, Overpulse, Coilgun,
   Leviathan: `weaponMods` damage / speed / life / burst / spread, `int` and `demand` as in Energy above), the Rail
   Driver's block (`set.damage`), and the `FIRE` blocks (intervals, clips, reloads, the Chainsaw's spin); then
   `node scripts/econ/models.mjs`. models.json is generated: never by hand.
2. Rerun `scripts/bench/heavierShots.ts --md` (without `--after`): it should print the After table above; then empty
   `PROPOSAL` in the bench.
3. Tests that pin today's numbers: common/src/ships/cannons.test.ts (Pip 14/48/15, Twinlink clip 16, Hammer 48/42),
   fireModels.test.ts (clips, the Chainsaw's spin), railguns.test.ts (Coilgun's five slugs, Rail Driver's clip of 6),
   ordnance.test.ts (Leviathan), models.test.ts, server beamsPulse.test.ts (Strobe, Overpulse); then the prediction
   parity firing scenarios (server/src/golden/parity.test.ts) and the volley agreement test
   (server/src/net/replication.test.ts), which should pass unchanged as no firing code changes.
4. The descriptions in models.mjs and the field guide's numbers.

## Appendix: before, per range and raw

Per range (landed DPS through armour and part HP; hit rate):

| gun | small@400 | small@900 | small@1600 | mid@400 | mid@900 | mid@1600 | large@400 | large@900 | large@1600 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Pip | 23.5 (45%) | 5.6 (10%) | 4.7 (8%) | 34.5 (78%) | 10.5 (22%) | 4.7 (8%) | 22.2 (97%) | 19.9 (91%) | 14.4 (62%) |
| Hammer | 24.8 (36%) | 3.7 (5%) | 7.3 (11%) | 39.5 (66%) | 6.5 (9%) | 8.1 (11%) | 44.4 (93%) | 33.3 (73%) | 27.1 (59%) |
| Twinlink | 30.9 (45%) | 7.2 (10%) | 3.7 (5%) | 46.0 (71%) | 19.3 (29%) | 8.4 (12%) | 37.2 (77%) | 29.8 (63%) | 16.5 (35%) |
| Longbarrel | 14.0 (75%) | 7.3 (50%) | 1.8 (13%) | 22.5 (100%) | 23.0 (100%) | 19.3 (75%) | 16.0 (100%) | 20.6 (100%) | 17.5 (100%) |
| Bastion | 11.8 (30%) | 0.0 (0%) | 2.5 (5%) | 24.0 (55%) | 0.0 (0%) | 0.0 (0%) | 52.2 (100%) | 30.7 (55%) | 22.5 (40%) |
| Rattler | 14.0 (43%) | 4.9 (15%) | 2.7 (8%) | 18.3 (62%) | 6.6 (22%) | 2.9 (9%) | 10.1 (76%) | 7.1 (55%) | 4.1 (34%) |
| Chainsaw | 29.5 (36%) | 9.3 (11%) | 6.3 (8%) | 37.1 (49%) | 13.1 (17%) | 9.0 (11%) | 29.0 (62%) | 19.6 (42%) | 12.6 (27%) |
| Stinger | 20.1 (47%) | 5.7 (13%) | 4.3 (10%) | 32.1 (77%) | 10.0 (24%) | 2.5 (6%) | 31.8 (98%) | 30.3 (94%) | 20.3 (63%) |
| Burst | 22.8 (54%) | 2.6 (6%) | 0.1 (2%) | 31.2 (72%) | 3.6 (7%) | 0.0 (0%) | 14.5 (72%) | 10.0 (48%) | 1.5 (7%) |
| Cloudmaker | 63.4 (63%) | 21.7 (19%) | 2.5 (6%) | 74.3 (78%) | 29.1 (19%) | 0.0 (0%) | 55.2 (69%) | 40.2 (50%) | 14.6 (19%) |
| Lobber | 51.6 (40%) | 11.9 (5%) | 16.7 (10%) | 49.1 (45%) | 10.8 (10%) | 0.0 (0%) | 81.3 (75%) | 76.1 (80%) | 28.3 (30%) |
| Quake | 66.6 (30%) | 18.2 (13%) | 17.8 (7%) | 111 (50%) | 23.1 (7%) | 0.0 (0%) | 159 (53%) | 94.7 (33%) | 28.6 (7%) |
| Strobe | 19.1 (47%) | 8.7 (21%) | 7.0 (17%) | 25.1 (71%) | 8.1 (22%) | 9.3 (25%) | 18.5 (80%) | 14.6 (67%) | 11.6 (49%) |
| Overpulse | 25.7 (53%) | 9.5 (19%) | 6.6 (13%) | 36.3 (77%) | 17.9 (38%) | 4.7 (10%) | 45.5 (91%) | 42.4 (85%) | 26.1 (53%) |
| Dart | 64.6 (89%) | 53.4 (72%) | 73.7 (100%) | 68.5 (100%) | 67.4 (100%) | 66.4 (100%) | 35.1 (100%) | 35.7 (100%) | 35.9 (100%) |
| Swarm | 101 (93%) | 79.6 (73%) | 110 (100%) | 106 (100%) | 108 (100%) | 109 (100%) | 94.6 (100%) | 95.3 (100%) | 94.8 (100%) |
| Hammerhead | 70.7 (70%) | 49.6 (60%) | 65.9 (80%) | 114 (100%) | 85.8 (80%) | 85.3 (80%) | 102 (100%) | 108 (100%) | 72.9 (80%) |
| Needle | 33.0 (79%) | 21.0 (54%) | 16.4 (38%) | 43.9 (100%) | 34.6 (75%) | 28.1 (63%) | 37.4 (100%) | 36.6 (100%) | 34.9 (100%) |
| Coilgun | 35.5 (39%) | 13.6 (15%) | 9.4 (11%) | 42.9 (46%) | 9.8 (9%) | 5.5 (5%) | 45.5 (55%) | 26.2 (31%) | 12.8 (15%) |
| Spear | 29.8 (81%) | 20.3 (50%) | 13.5 (44%) | 36.5 (100%) | 30.3 (88%) | 28.3 (69%) | 40.3 (100%) | 41.8 (100%) | 42.4 (100%) |
| Spark | 24.6 (65%) | 11.9 (30%) | 6.9 (20%) | 35.8 (95%) | 13.4 (35%) | 13.1 (38%) | 35.6 (100%) | 36.6 (100%) | 33.5 (98%) |
| Eel | 20.2 (25%) | 18.4 (25%) | 57.6 (75%) | 85.3 (88%) | 59.3 (88%) | 69.3 (75%) | 69.2 (88%) | 80.2 (100%) | 89.1 (100%) |
| Leviathan | 0.0 (0%) | 0.0 (0%) | 0.0 (0%) | 0.0 (0%) | 0.0 (0%) | 0.0 (0%) | 47.0 (20%) | 47.0 (20%) | 0.0 (0%) |
| Rustjaw's Hive | 57.5 (83%) | 52.8 (75%) | 69.7 (100%) | 66.3 (100%) | 68.5 (100%) | 70.3 (100%) | 64.0 (100%) | 62.5 (100%) | 63.6 (100%) |
| Cinder Bloom | 11.5 (27%) | 2.5 (4%) | 2.0 (4%) | 27.8 (62%) | 6.5 (15%) | 4.0 (8%) | 33.0 (88%) | 24.9 (54%) | 14.2 (19%) |
| Prism Splitter | 5.8 (35%) | 2.5 (10%) | 0.8 (0%) | 13.7 (70%) | 3.8 (20%) | 3.4 (0%) | 17.2 (95%) | 16.7 (70%) | 13.7 (30%) |
| Phase Cannon | 7.8 (29%) | 2.5 (7%) | 2.5 (7%) | 6.5 (29%) | 2.7 (7%) | 0.0 (0%) | 28.9 (93%) | 20.9 (64%) | 9.3 (29%) |
| Singularity Launcher | 0.0 (0%) | 0.0 (0%) | 23.3 (17%) | 41.8 (33%) | 0.0 (0%) | 0.0 (0%) | 148 (83%) | 0.0 (0%) | 0.0 (0%) |
| Rail Driver | 83.8 (81%) | 49.0 (50%) | 29.0 (31%) | 101 (100%) | 62.0 (62%) | 54.9 (55%) | 98.5 (100%) | 97.3 (100%) | 98.2 (100%) |
| Slurry Cannon | 23.0 (34%) | 3.7 (5%) | 7.3 (11%) | 39.5 (66%) | 6.8 (9%) | 8.6 (11%) | 51.4 (93%) | 42.3 (73%) | 34.4 (59%) |

Raw landed (as it arrived, before armour and part HP), mean over ranges: small / mid / large

- Pip: 11.8 / 20.1 / 46.5
- Hammer: 12.3 / 20.3 / 52.8
- Twinlink: 12.8 / 23.9 / 37.2
- Longbarrel: 20.8 / 41.6 / 45.3
- Bastion: 14.0 / 22.0 / 78.0
- Rattler: 9.4 / 13.4 / 23.6
- Chainsaw: 14.2 / 20.0 / 33.8
- Stinger: 9.0 / 13.7 / 32.6
- Burst: 15.7 / 23.1 / 41.1
- Cloudmaker: 31.1 / 38.8 / 77.8
- Lobber: 38.6 / 33.2 / 193
- Quake: 35.3 / 48.3 / 113
- Strobe: 15.2 / 21.2 / 35.4
- Overpulse: 12.4 / 18.0 / 33.1
- Dart: 89.9 / 104 / 108
- Swarm: 89.9 / 100 / 105
- Hammerhead: 82.2 / 110 / 118
- Needle: 28.2 / 39.3 / 49.6
- Coilgun: 19.6 / 18.5 / 30.4
- Spear: 49.8 / 72.9 / 85.3
- Spark: 14.8 / 21.5 / 38.2
- Eel: 70.2 / 149 / 173
- Leviathan: 0.0 / 0.0 / 57.0
- Rustjaw's Hive: 55.6 / 63.3 / 65.2
- Cinder Bloom: 4.7 / 11.3 / 21.7
- Prism Splitter: 2.8 / 6.2 / 12.5
- Phase Cannon: 4.7 / 3.9 / 20.2
- Singularity Launcher: 15.3 / 14.1 / 65.7
- Rail Driver: 60.4 / 80.9 / 112
- Slurry Cannon: 11.7 / 20.3 / 52.8

## Appendix: after, per range and raw

Per range (landed DPS through armour and part HP; hit rate):

| gun | small@400 | small@900 | small@1600 | mid@400 | mid@900 | mid@1600 | large@400 | large@900 | large@1600 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Pip | 22.6 (47%) | 7.4 (14%) | 6.7 (13%) | 33.5 (82%) | 12.5 (27%) | 5.8 (13%) | 23.0 (99%) | 19.6 (89%) | 14.7 (67%) |
| Hammer | 22.0 (37%) | 2.5 (3%) | 4.5 (7%) | 41.4 (73%) | 10.2 (17%) | 0.0 (0%) | 45.8 (97%) | 33.8 (73%) | 25.2 (57%) |
| Twinlink | 34.0 (53%) | 16.1 (25%) | 7.6 (11%) | 46.4 (70%) | 20.1 (30%) | 4.8 (7%) | 38.3 (80%) | 29.4 (65%) | 23.2 (49%) |
| Longbarrel | 14.0 (75%) | 7.3 (50%) | 1.8 (13%) | 22.5 (100%) | 23.0 (100%) | 19.3 (75%) | 16.0 (100%) | 20.6 (100%) | 17.5 (100%) |
| Bastion | 11.8 (30%) | 0.0 (0%) | 2.5 (5%) | 24.0 (55%) | 0.0 (0%) | 0.0 (0%) | 52.2 (100%) | 30.7 (55%) | 22.5 (40%) |
| Rattler | 16.0 (50%) | 6.3 (18%) | 4.5 (13%) | 21.5 (77%) | 7.4 (25%) | 5.2 (17%) | 11.3 (82%) | 8.7 (68%) | 6.2 (48%) |
| Chainsaw | 32.0 (41%) | 10.9 (13%) | 6.3 (7%) | 32.0 (45%) | 11.2 (15%) | 11.2 (14%) | 27.6 (59%) | 17.3 (37%) | 11.3 (25%) |
| Stinger | 24.3 (60%) | 14.5 (35%) | 6.9 (16%) | 34.6 (89%) | 16.8 (41%) | 10.7 (26%) | 31.4 (100%) | 30.7 (96%) | 26.5 (85%) |
| Burst | 22.8 (54%) | 2.6 (6%) | 0.1 (2%) | 31.2 (72%) | 3.6 (7%) | 0.0 (0%) | 14.5 (72%) | 10.0 (48%) | 1.5 (7%) |
| Cloudmaker | 63.4 (63%) | 21.7 (19%) | 2.5 (6%) | 74.3 (78%) | 29.1 (19%) | 0.0 (0%) | 55.2 (69%) | 40.2 (50%) | 14.6 (19%) |
| Lobber | 51.6 (40%) | 11.9 (5%) | 16.7 (10%) | 49.1 (45%) | 10.8 (10%) | 0.0 (0%) | 81.3 (75%) | 76.1 (80%) | 28.3 (30%) |
| Quake | 66.6 (30%) | 18.2 (13%) | 17.8 (7%) | 111 (50%) | 23.1 (7%) | 0.0 (0%) | 159 (53%) | 94.7 (33%) | 28.6 (7%) |
| Strobe | 19.9 (48%) | 10.1 (24%) | 6.3 (15%) | 23.2 (66%) | 9.5 (25%) | 8.7 (23%) | 18.0 (75%) | 13.1 (56%) | 9.5 (43%) |
| Overpulse | 26.7 (60%) | 14.5 (32%) | 8.0 (16%) | 35.6 (83%) | 16.5 (37%) | 12.6 (28%) | 45.6 (92%) | 43.3 (86%) | 33.9 (68%) |
| Dart | 64.6 (89%) | 53.4 (72%) | 73.7 (100%) | 68.5 (100%) | 67.4 (100%) | 66.4 (100%) | 35.1 (100%) | 35.7 (100%) | 35.9 (100%) |
| Swarm | 101 (93%) | 79.6 (73%) | 110 (100%) | 106 (100%) | 108 (100%) | 109 (100%) | 94.6 (100%) | 95.3 (100%) | 94.8 (100%) |
| Hammerhead | 70.7 (70%) | 49.6 (60%) | 65.9 (80%) | 114 (100%) | 85.8 (80%) | 85.3 (80%) | 102 (100%) | 108 (100%) | 72.9 (80%) |
| Needle | 33.0 (79%) | 21.0 (54%) | 16.4 (38%) | 43.9 (100%) | 34.6 (75%) | 28.1 (63%) | 37.4 (100%) | 36.6 (100%) | 34.9 (100%) |
| Coilgun | 41.5 (51%) | 17.7 (22%) | 14.2 (18%) | 51.7 (63%) | 12.2 (16%) | 7.7 (9%) | 50.6 (71%) | 34.2 (48%) | 20.4 (26%) |
| Spear | 29.8 (81%) | 20.3 (50%) | 13.5 (44%) | 36.5 (100%) | 30.3 (88%) | 28.3 (69%) | 40.3 (100%) | 41.8 (100%) | 42.4 (100%) |
| Spark | 24.6 (65%) | 11.9 (30%) | 6.9 (20%) | 35.8 (95%) | 13.4 (35%) | 13.1 (38%) | 35.6 (100%) | 36.6 (100%) | 33.5 (98%) |
| Eel | 20.2 (25%) | 18.4 (25%) | 57.6 (75%) | 85.3 (88%) | 59.3 (88%) | 69.3 (75%) | 69.2 (88%) | 80.2 (100%) | 89.1 (100%) |
| Leviathan | 18.5 (10%) | 0.0 (0%) | 0.0 (0%) | 15.7 (10%) | 0.0 (0%) | 0.0 (0%) | 43.0 (20%) | 39.5 (20%) | 11.0 (10%) |
| Rustjaw's Hive | 57.5 (83%) | 52.8 (75%) | 69.7 (100%) | 66.3 (100%) | 68.5 (100%) | 70.3 (100%) | 64.0 (100%) | 62.5 (100%) | 63.6 (100%) |
| Cinder Bloom | 11.5 (27%) | 2.5 (4%) | 2.0 (4%) | 27.8 (62%) | 6.5 (15%) | 4.0 (8%) | 33.0 (88%) | 24.9 (54%) | 14.2 (19%) |
| Prism Splitter | 5.8 (35%) | 2.5 (10%) | 0.8 (0%) | 13.7 (70%) | 3.8 (20%) | 3.4 (0%) | 17.2 (95%) | 16.7 (70%) | 13.7 (30%) |
| Phase Cannon | 7.8 (29%) | 2.5 (7%) | 2.5 (7%) | 6.5 (29%) | 2.7 (7%) | 0.0 (0%) | 28.9 (93%) | 20.9 (64%) | 9.3 (29%) |
| Singularity Launcher | 0.0 (0%) | 0.0 (0%) | 23.3 (17%) | 41.8 (33%) | 0.0 (0%) | 0.0 (0%) | 148 (83%) | 0.0 (0%) | 0.0 (0%) |
| Rail Driver | 82.2 (81%) | 44.9 (42%) | 31.9 (30%) | 106 (98%) | 84.6 (78%) | 50.9 (47%) | 88.3 (100%) | 86.4 (100%) | 92.0 (100%) |
| Slurry Cannon | 23.0 (34%) | 3.7 (5%) | 7.3 (11%) | 39.5 (66%) | 6.8 (9%) | 8.6 (11%) | 51.4 (93%) | 42.3 (73%) | 34.4 (59%) |

Raw landed (as it arrived, before armour and part HP), mean over ranges: small / mid / large

- Pip: 13.4 / 22.0 / 45.8
- Hammer: 13.7 / 26.4 / 66.5
- Twinlink: 19.1 / 22.9 / 41.3
- Longbarrel: 20.8 / 41.6 / 45.3
- Bastion: 14.0 / 22.0 / 78.0
- Rattler: 12.0 / 17.4 / 29.0
- Chainsaw: 16.4 / 19.7 / 32.3
- Stinger: 13.9 / 19.6 / 35.2
- Burst: 15.7 / 23.1 / 41.1
- Cloudmaker: 31.1 / 38.8 / 77.8
- Lobber: 38.6 / 33.2 / 193
- Quake: 35.3 / 48.3 / 113
- Strobe: 16.2 / 21.3 / 32.4
- Overpulse: 15.6 / 21.4 / 35.5
- Dart: 89.9 / 104 / 108
- Swarm: 89.9 / 100 / 105
- Hammerhead: 82.2 / 110 / 118
- Needle: 28.2 / 39.3 / 49.6
- Coilgun: 25.6 / 24.7 / 41.1
- Spear: 49.8 / 72.9 / 85.3
- Spark: 14.8 / 21.5 / 38.2
- Eel: 70.2 / 149 / 173
- Leviathan: 14.1 / 13.4 / 60.9
- Rustjaw's Hive: 55.6 / 63.3 / 65.2
- Cinder Bloom: 4.7 / 11.3 / 21.7
- Prism Splitter: 2.8 / 6.2 / 12.5
- Phase Cannon: 4.7 / 3.9 / 20.2
- Singularity Launcher: 15.3 / 14.1 / 65.7
- Rail Driver: 60.7 / 88.7 / 119
- Slurry Cannon: 11.7 / 20.3 / 52.8
