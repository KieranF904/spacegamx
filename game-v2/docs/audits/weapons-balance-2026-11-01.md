# Weapons balance audit, 2026-11-01

Branch `refactor/split`, after the weapons, parts and energy rework (`docs/design/rework-2026-11.md`, report
`docs/reports/rework-2026-11-01.md`). Read-only: no data, tuning or code was changed.

Every number here comes from running the game's own shared code (rebuild, `stepGuns`, `gunLoad`, `powerTick`,
`hitMultiplier`, `castParts`, `nearestParts`) in `docs/audits/weapons-balance-calc.ts`. Re-run it with
`server/node_modules/.bin/tsx docs/audits/weapons-balance-calc.ts --md` from `game-v2/` (add `--after` to measure the
suggested numbers below).

## Owner feedback (2026-11-01)

- **Leviathan:** the owner finds it close to unusable in play, not too strong. Its 3.3x figure assumes every torpedo hits;
  it is slow (12 top speed), arms late and can't catch anything nimble. Do not trim it; look at making it usable
  (speed, arming, tracking) once the weapons test range exists.

## Summary

The owner's feeling is right, and the numbers say why.

1. **Most guns you unlock are worse than the free starter gun.** Measured against the hull of its own grade, 24 of
   the 37 guns (22 leaving out the two EMPs) do less sustained damage than one Pip. Counting bursts and splash (time
   to kill), 14 still kill start-area ships slower than a Pip. In the starting area a player can unlock the
   Rattler, Burst, Hammer, Lobber and Glint by level 9: the Rattler does 0.6x a Pip, the Burst 0.36x, the Lobber
   0.65x (though its blast kills well when it lands), the Glint ties, and only the Hammer is an upgrade. Late unlocks are no better: Stinger (level 24) 0.49x,
   Overpulse (25) 0.29x, Hammerhead (33) 0.63x, and the boss legendaries Prism 0.43x, Phase 0.6x, Singularity 0.36x.
2. **Penalties stack on the light and area guns.** Autocannon, pulse, missile and mortar shells carry penetration
   -0.5 (x0.775 against a same-grade hull) and flak -1 (x0.55), before armour plate halves them again. Steel and
   cobalt hulls also resist kinetic by x0.85. Model guns never get stronger with grade (their numbers are fixed; grade
   only adds penetration, capped at x1.15). So a gun that looks like 5 damage a shot really lands 3 to 4.
3. **Energy is not a constraint.** Two of any gun, held for a minute on the starter Sparrow (70 E/s, 240 store),
   never brown out, except Lance (1.9 s), Spear (3.3 s), Cutter (20 s), Tesla and Singularity (30 s). A pair of Pips
   uses 31% of the starter's spare power and 2% of its Output. The Output limit and the Capacitor's 2,000/s never
   bind, because guns pay over their reload: a gun never asks for more than 90 E/s, and Output starts at 720/s. A
   Capacitor bank is just 160 E of extra storage each (it buys the Lance 4 s and the Spear 12 s).
4. **Hitting things is the hard part, not killing them.** With every shot landing, a starter pair of Pips kills a
   Scrap Mite in 0.7 s, a Pirate Skiff in 2.2 s, a Redtooth Brawler in 4.5 s and the Tallyman boss in 16 s, so the
   starter's damage is adequate. But Skiffs and Cutters fly 26 to 30 u/tick (17 to 20 sideways), as fast as the
   Sparrow (20.7). A Pip shell (48 u/tick) needs a 256 u lead at 600 u, four times the Skiff's radius. Slower shells
   are worse (Burst 34, Lobber 22, Phase 30, Singularity 9), and the Eel (15 max) and Leviathan (12) can never catch
   a Skiff or Cutter at all. Every gun that is both slower to hit with and weaker than the Pip feels useless.
5. **Some specialist roles have nothing to work on, and a few guns are far ahead.** Enemy shields are tiny (the Frost
   Warden has 104 shield against 1,231 hull), so the shield-stripping pulse guns (x0.5 to x0.6 against hull) are pure
   loss: the Strobe kills even the shielded Warden slower than a Pip (21.7 s against 14.0 s). The Swarm uses 6 rounds
   a salvo and empties a 24-round crate in 12 s. On the strong side: Lance 4.3x a Pip, Leviathan 3.3x, Cutter 2.7x
   at level 18, Eel 2.3x at level 19, Frostbite 1.8x at level 12.

**The fix in one line:** raise about 25 guns so each one beats the Pip at the job its design gives it, trim the
Cutter, give the Eel enough speed to catch its prey, cut the Swarm's ammo use, and decide what energy is for (today
it limits only the Lance and Spear). The suggested numbers below were run through the same calculator: after them every
gun kills start-area ships at least as fast as a Pip except the two EMPs, the Searchlight (a support gun, 0.99),
the Coilgun at 600 u (a close-range gun) and three slow starters that lose only on tiny targets (Longbarrel,
Cinder Bloom, Singularity); against later enemies everything but the EMPs, the Coilgun and the Burst (0.75) beats
it, and late guns sit 2x to 5x above it.

## How it was measured (assumptions)

- **Shooter.** The starter Sparrow T with its Pips swapped for the gun under test (as `fireModels.test.ts` does).
  The gun's energy draw is set from its real piece (a model's demand is per cell). One gun for damage and kill
  times; two of it for energy.
- **Firing.** The trigger is held from tick 1 and the gun fires as `stepGuns` lets it: clips, reloads, charges,
  cooldowns, spin-up, beam windup all run for real. "Burst DPS" is the first volley or clip at its own beat;
  "sustained DPS" is a minute of held fire at full power. Raw damage per shot counts direct damage plus one full
  splash for every shell of a volley (salvo, walk, burst), plus a burn's whole damage.
- **Hits.** Every shot hits. Enemies face the shooter; each shell strikes the first standing part on the line from
  the front through the core (the kill path). Damage goes through a copy of the server's `hurt` and `splashAt`:
  shield first (with `vsShield`), then the part takes `amount x vsHull x penetration x material resist`; splash hits
  the `reach` nearest parts with `1 - 0.7 d/r` falloff; spaced plating's `splashTaken` applies; lost parts and
  parts cut off from the core drop out (rebuild). A ship dies when its core does. Shields regenerate as the server
  does (after `shieldDelay` without a hit).
- **Distance.** 600 world units (the factions like 520). Time to kill adds the last shell's flight to 600 u (and a
  Singularity's 228-tick hold).
- **Modelled by assumption.** Flak bursts on its fuse, half a tick's flight inside it (103 u short of the hull for
  the Burst). A lobbed mortar lands on the core; the Quake's three shells land at 70%, 100% and 130% of the aim
  distance along the line. The Prism is aimed a little short so it splits in front and 3 of its 5 shards land
  (aimed on the hull, it hits whole and its shards fly past that ship). The Coilgun's five slugs land at their exact
  fan offsets at 600 u. A Cinder Bloom burn moves to the next front part when its part dies. Beams stay on the front
  part (the Cutter's ramp restarts on each new part). Chains, pierce, marks, slows, EMPs and pulls do nothing to a
  single target and are not counted.
- **Kill speed vs Pip.** One Pip's time to kill divided by the gun's, the geometric mean over the five start-area
  enemies and over the five later ones. 1.00 means "as good as the free starter gun".
- **Energy.** Three setups, thrusting (not boosting) the whole minute: Starter (2 Cell Reactors 70/s, core 240
  store, 2 Ion Drives 18/s), Modest (140/s, 640 store, engines 40/s), Modest plus a 2-Capacitor bank touching the
  guns (320 store, 4,000/s). Ammo guns are assumed to have ammo; "crate lasts" is held fire from one crate.
- **Enemies.** Built the way `Enemies.ts` and `Bosses.ts` build them: the system's grade (`plated`), the faction's
  `hpScale`, an elite at `eliteHp` 1.7 with plate a grade better, a boss at its `hp` with its core x2.5 and plate +1.
  Mobs (Scrap Mite drone 55 HP) take raw damage, no armour.

## Weapons: verdicts

One gun, full power, every shot hitting, at 600 u. Kill speed and the TTK columns are the measures that count bursts, splash and the core path; DPS alone undersells splash guns and oversells shotguns. Detail per enemy is in the full time-to-kill table further down.

| Weapon | Lvl / Mk | Firing model | Burst DPS | Sustained DPS | E/s flat out | Kill speed vs Pip (start / later) | TTK s: Skiff / Brawler / Raider II / Elite Gunship II / Tallyman | Verdict |
|---|---|---|---|---|---|---|---|---|
| Pip | 0 / 1 | cycle, fixed | 56.0 | 56.0 | 8.0 | 1.00 / 1.00 | 4.2 / 8.7 / 10.2 / 17.2 / 31.5 | Reference. Fine: with perfect aim a pair kills start-area ships in 0.7 to 4.5 s. |
| Hammer | 6 / 1 | cycle, fixed | 68.6 | 68.8 | 10.0 | 1.50 / 2.03 | 3.1 / 5.2 / 4.5 / 8.0 / 22.7 | Good. A real upgrade (pen +1 ignores plate). |
| Twinlink | 12 / 2 | clip (clip 16, reload 90t), turret | 120 | 64.0 | 7.7 | 1.89 / 2.10 | 3.3 / 4.4 / 4.3 / 7.5 / 22.8 | OK. Strong clip burst, sustained only Pip level vs Mk II. Small reload cut. |
| Longbarrel | 20 / 3 | charge (charge 120t, cool 90t), fixed | 85.0 | 48.2 | 10.3 | 0.50 / 1.38 | 5.6 / 9.1 / 9.1 / 9.1 / 33.4 | Too weak for level 20: under one Pip sustained, 2 s charge before the first shot. |
| Bastion | 30 / 4 | clip (clip 2, reload 180t), fixed | 600 | 111 | 16.7 | 3.44 / 3.95 | 0.6 / 3.7 / 3.7 / 3.7 / 13.9 | Good, strong late gun. |
| Rattler | 3 / 1 | cycle, turret | 42.9 | 42.9 | 12.0 | 0.64 / 0.57 | 7.0 / 15.4 / 18.3 / 31.0 / 52.6 | Too weak: a downgrade from the free Pip (0.6x vs hull, 0.56x vs plate). |
| Chainsaw | 14 / 2 | cycle (spin 15->3.75t), turret | 80.0 | 79.3 | 22.4 | 1.16 / 1.80 | 3.4 / 5.6 / 5.8 / 9.3 / 21.0 | Borderline: under a Pip vs Mk II hull once the 0.85 kinetic resist and pen -0.5 apply. |
| Stinger | 24 / 3 | clip (clip 12, reload 72t), turret | 64.0 | 37.1 | 7.4 | 1.11 / 1.27 | 5.5 / 8.4 / 8.0 / 13.3 / 40.5 | Too weak for level 24: half a Pip. |
| Burst | 4 / 1 | ammo, turret | 37.1 | 37.1 | 0.0 | 0.27 / 0.18 | 18.4 / 20.7 / 66.0 / 113 / 187 | Unusable: a third of a Pip; the fuse bursts 100 u short with pen -1. |
| Cloudmaker | 16 / 2 | clip (clip 4, reload 150t), turret | 62.0 | 31.0 | 6.7 | 0.90 / 0.53 | 8.4 / 5.8 / 20.9 / 36.5 / 81.6 | Too weak: a quarter of a Pip sustained. |
| Lobber | 7 / 1 | ammo, turret | 46.7 | 46.7 | 0.0 | 1.96 / 0.99 | 3.5 / 3.5 / 11.0 / 18.5 / 41.0 | Damage OK (splash reaches the core) but 28-tick flight makes it hard to land on anything that moves. |
| Quake | 24 / 3 | ammo, turret | 60.0 | 60.0 | 0.0 | 2.75 / 2.70 | 3.5 / 1.0 / 3.7 / 6.7 / 30.7 | Strong on paper, same landing problem as the Lobber. Leave. |
| Glint | 9 / 1 | cycle, turret | 53.3 | 54.4 | 15.0 | 0.81 / 1.01 | 4.2 / 9.6 / 9.6 / 15.0 / 33.0 | Equal to the Pip at level 9. Instant hit is its edge; small buff. |
| Cutter | 18 / 2 | beam, fixed | 150 | 150 | 32.0 | 2.04 / 3.77 | 2.1 / 3.3 / 2.6 / 3.9 / 11.0 | Too strong for level 18 (2.7x Pip). Trim the ramp. |
| Searchlight | 26 / 3 | beam, turret | 25.0 | 25.0 | 15.0 | 0.62 / 0.99 | 7.8 / 12.0 / 9.2 / 15.6 / 60.5 | Support gun; weak solo by design. Small buff so it is not dead weight. |
| Strobe | 10 / 1 | cycle, turret | 54.0 | 54.0 | 12.0 | 0.50 / 0.54 | 8.7 / 20.2 / 17.2 / 28.7 / 69.2 | Too weak: x0.6 hull and pen -0.5 make it under half a Pip; shields are too small for x1.6 to pay. |
| Overpulse | 25 / 3 | clip (clip 12, reload 90t), turret | 90.0 | 41.4 | 13.3 | 0.52 / 0.92 | 8.7 / 14.2 / 8.9 / 16.5 / 73.4 | Too weak for level 25: 0.29x Pip vs hull. |
| Dart | 11 / 1 | ammo, fixed | 35.6 | 36.3 | 0.0 | 0.67 / 0.55 | 7.6 / 9.4 / 20.2 / 34.6 / 63.4 | Too weak: half a Pip. |
| Swarm | 21 / 3 | ammo, fixed | 44.0 | 44.0 | 0.0 | 1.54 / 1.73 | 3.5 / 6.5 / 6.4 / 9.7 / 33.7 | Damage OK, but 6 rounds a salvo empties a 24-round crate in 12 s. |
| Hammerhead | 33 / 4 | ammo, fixed | 48.2 | 50.4 | 0.0 | 1.86 / 2.33 | 3.8 / 3.8 / 3.8 / 7.1 / 30.2 | Too weak for level 33: 0.63x Pip. |
| Needle | 13 / 2 | ammo, fixed | 49.6 | 49.6 | 0.0 | 1.14 / 1.73 | 5.1 / 6.3 / 6.3 / 10.1 / 31.3 | Slightly weak for level 13. |
| Coilgun | 22 / 3 | cycle, fixed | 88.9 | 89.3 | 15.6 | 0.45 / 0.73 | 11.8 / 18.1 / 15.4 / 26.2 / 85.6 | Fine at close range; at 600 u its cone spreads damage over side parts (slow kills). Leave. |
| Spear | 28 / 4 | cycle, fixed | 84.2 | 85.3 | 63.2 | 1.36 / 2.56 | 2.0 / 3.9 / 3.9 / 5.8 / 19.1 | OK; the energy hog it is meant to be (a pair on the starter browns out in 3.3 s). |
| Hush | 15 / 2 | cycle, turret | 1.1 | 1.1 | 9.3 | 0.03 / 0.05 | 176 / 292 / 197 / never / never | Control, no damage (by design). |
| Blackout | 35 / 4 | charge (charge 90t, cool 240t), turret | 2.0 | 0.6 | 16.4 | 0.03 / 0.05 | never / never / never / never / never | Control, no damage (by design). |
| Spark | 17 / 2 | cycle, turret | 45.3 | 45.3 | 18.0 | 0.99 / 1.68 | 3.9 / 7.6 / 4.6 / 8.4 / 33.9 | Equal to the Pip at level 17; buff. |
| Tesla | 29 / 4 | beam, turret | 70.0 | 70.0 | 30.0 | 1.51 / 3.17 | 3.0 / 4.6 / 2.8 / 4.8 / 21.8 | OK; small buff. |
| Eel | 19 / 2 | ammo, fixed | 125 | 125 | 0.0 | 1.14 / 2.83 | 5.1 / 5.1 / 5.1 / 5.1 / 13.1 | Big damage but max speed 15 cannot catch Skiffs or Cutters (26 to 30). |
| Leviathan | 38 / 5 | ammo, fixed | 200 | 200 | 0.0 | 2.65 / 5.61 | 1.2 / 1.2 / 1.2 / 7.2 / 7.2 | Strong fight-ender for big ships; cannot catch small ones (by design). |
| Lance | 32 / 4 | beam (windup 18t), fixed | 210 | 210 | 90.0 | 4.04 / 7.93 | 1.1 / 1.5 / 1.3 / 2.0 / 7.4 | Strongest sustained gun (4.3x Pip), held back only by 90 E/s and 500 range. Leave. |
| Rustjaw's Hive | 12 / 4 | clip+regrow (clip 8 regrow 45t), fixed | 176 | 30.8 | 8.0 | 2.31 / 1.79 | 1.3 / 6.6 / 3.8 / 12.5 / 48.6 | Salvo burst is good (kill speed 2.3x), sustained weak. Faster regrow. |
| Frostbite Lance | 12 / 4 | beam, turret | 95.0 | 95.0 | 24.0 | 2.35 / 4.12 | 2.1 / 3.2 / 2.2 / 3.7 / 15.9 | Strong for level 12 (1.8x Pip) plus a slow; acceptable for a boss artefact. |
| Cinder Bloom | 22 / 4 | cycle, turret | 105 | 105 | 11.7 | 0.87 / 1.42 | 5.8 / 8.7 / 6.6 / 11.1 / 39.9 | OK; slightly slow to kill small ships. Small rate buff. |
| Prism Splitter | 10 / 4 | cycle, turret | 20.6 | 20.9 | 10.0 | 0.46 / 0.92 | 8.3 / 16.3 / 9.9 / 16.3 / 73.9 | Too weak: 0.37x Pip, and aimed on the hull the shards fly past. |
| Phase Cannon | 26 / 4 | cycle, fixed | 31.8 | 32.7 | 13.6 | 0.70 / 1.44 | 4.8 / 11.4 / 6.9 / 11.4 / 46.6 | Too weak for a legendary: 0.6x Pip. |
| Singularity Launcher | 30 / 4 | cycle, turret | 20.0 | 21.0 | 30.0 | 0.63 / 1.15 | 4.9 / 4.9 / 11.9 / 11.9 / 67.9 | Too weak: 0.36x Pip single target and 5 s before the collapse. |
| Rail Driver | 29 / 4 | clip (clip 6, reload 90t), fixed | 240 | 104 | 19.2 | 4.80 / 4.02 | 0.9 / 2.6 / 2.4 / 4.8 / 14.5 | Good, strong late gun. |

## Enemies used

Built as the server builds them (see assumptions). Speeds are top speeds at full thrust with friction 0.985; the player's Sparrow T does 20.7 u/tick forward.

| Enemy | Tier | Parts | Total HP | Core HP | Shield (regen/s) | Plates | Material | Top speed fwd / side (u/tick) | Radius (u) |
|---|---|---|---|---|---|---|---|---|---|
| Scrap Mite (Sol, Mk I) | start | 11 | 389 | 45.0 | - | 4 | alloy | 4.2 / 4.2 | 65.3 |
| Scrap Crawler (Sol, Mk I) | start | 14 | 497 | 45.0 | - | 6 | alloy | 3.9 / 3.9 | 72.2 |
| Pirate Skiff (Sol lanes, Mk I) | start | 11 | 705 | 150 | - | 0 | alloy | 29.7 / 19.7 | 65.6 |
| Redtooth Cutter (Sol/Ashfall, Mk I) | start | 9 | 540 | 135 | - | 0 | alloy | 26.0 / 17.2 | 55.3 |
| Redtooth Brawler (Sol camp, Mk I) | start | 20 | 1634 | 135 | - | 5 | alloy | 5.6 / 3.7 | 70.7 |
| Pirate Raider Mk II (Nebula Prime) | mid | 14 | 1372 | 188 | - | 2 | steel | 15.1 / 8.8 | 63.5 |
| Frost Warden Mk II (Borealis, shielded) | mid | 16 | 1231 | 188 | 104 (14.6) | 0 | steel | 16.1 / 9.4 | 67.7 |
| Cinder Zealot Mk III (Cinder Reach) | mid | 15 | 1814 | 224 | - | 2 | titanium | 21.2 / 10.9 | 77.9 |
| Elite Pirate Gunship Mk II (x1.7 HP, plate +1) | elite | 22 | 3461 | 320 | - | 2 | steel/titanium | 16.1 / 6.2 | 88.8 |
| The Tallyman (Sol boss: Gunship Mk I, plate +1, x4 HP, core x2.5) | boss | 22 | 7490 | 1500 | - | 2 | alloy/steel | 17.1 / 7.6 | 88.1 |

Also in the starting area: mobs (single circles, no armour) such as the Scrap Mite drone (55 HP, 19 u/tick) and Ember Drone (70 HP). Every gun but the EMPs and the Singularity (4.9 s) kills a 55 HP mob in under 2.2 s if it hits (column "55 HP mob" below).

## Detail: damage, energy, range and hitting

"Eff. DPS" is sustained DPS after the gun's vsHull, penetration (its grade plus its kind's pen, against the part's armour) and the material's resist, against four reference parts. "Skiff drift" is how far a Pirate Skiff moves sideways at full speed while the shell flies 600 u: the lead you need. "Crate lasts" is held fire from one ammo crate.

| Weapon | Lvl / Mk | Firing | Dmg/shot (raw) | Burst DPS | Sustained DPS | x Pip | Eff. DPS vs Mk I hull / Mk I plate / Mk II hull / Mk III hull | Energy | E/s flat out | Range | Shell speed | Skiff drift at 600 u | 55 HP mob | Crate lasts | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Pip | 0 / 1 | cycle, fixed | 14.0 | 56.0 | 56.0 | 1.00 | 56.0 / 30.8 / 26.2 / 13.3 | 2.0/shot | 8.0 | 7200 | 48.0 | 256 u (13 t) | 1.0 s | - |  |
| Hammer | 6 / 1 | cycle, fixed | 48.0 | 68.6 | 68.8 | 1.23 | 79.1 / 68.8 / 58.5 / 35.9 | 7.0/shot | 10.0 | 5700 | 38.0 | 315 u (16 t) | 1.0 s | - |  |
| Twinlink | 12 / 2 | clip (clip 16, reload 90t), turret | 12.0 | 120 | 64.0 | 1.14 | 73.6 / 64.0 / 54.4 / 33.4 | 24.0/clip | 7.7 | 7200 | 48.0 | 256 u (13 t) | 0.6 s | - |  |
| Longbarrel | 20 / 3 | charge (charge 120t, cool 90t), fixed | 170 | 85.0 | 48.2 | 0.86 | 55.4 / 55.4 / 47.1 / 52.6 | 36.0/charge | 10.3 | 8400 | 140 | 98.5 u (5 t) | 2.1 s | - |  |
| Bastion | 30 / 4 | clip (clip 2, reload 180t), fixed | 180 | 600 | 111 | 1.98 | 128 / 128 / 109 / 121 | 60.0/clip | 16.7 | 4800 | 32.0 | 374 u (19 t) | 0.3 s | - |  |
| Rattler | 3 / 1 | cycle, turret | 5.0 | 42.9 | 42.9 | 0.77 | 33.3 / 17.2 / 14.6 / 7.1 | 1.4/shot | 12.0 | 5400 | 54.0 | 236 u (12 t) | 1.4 s | - |  |
| Chainsaw | 14 / 2 | cycle (spin 15->3.75t), turret | 5.0 | 80.0 | 79.3 | 1.42 | 85.2 / 61.4 / 52.2 / 30.1 | 1.4/shot | 22.4 | 5400 | 54.0 | 236 u (12 t) | 1.4 s | - |  |
| Stinger | 24 / 3 | clip (clip 12, reload 72t), turret | 8.0 | 64.0 | 37.1 | 0.66 | 42.6 / 39.8 / 33.9 / 27.3 | 20.0/clip | 7.4 | 5400 | 54.0 | 236 u (12 t) | 0.9 s | - |  |
| Burst | 4 / 1 | ammo, turret | 21.0 | 37.1 | 37.1 | 0.66 | 20.4 / 9.3 / 8.3 / 3.7 | 1 round | 0.0 | 1700 | 34.0 | 355 u (18 t) | 1.4 s | 68.0 s |  |
| Cloudmaker | 16 / 2 | clip (clip 4, reload 150t), turret | 31.0 | 62.0 | 31.0 | 0.55 | 31.0 / 17.1 / 15.3 / 7.8 | 30.0/clip | 6.7 | 1700 | 34.0 | 355 u (18 t) | 0.8 s | - |  |
| Lobber | 7 / 1 | ammo, turret | 70.0 | 46.7 | 46.7 | 0.83 | 36.2 / 18.7 / 16.8 / 8.2 | 1 round | 0.0 | 2640 | 22.0 | 552 u (28 t) | 0.5 s | 60.0 s | lobbed to cursor |
| Quake | 24 / 3 | ammo, turret | 180 | 60.0 | 60.0 | 1.07 | 69.0 / 64.5 / 58.1 / 46.5 | 3 rounds | 0.0 | 2640 | 22.0 | 552 u (28 t) | 0.5 s | 40.0 s | lobbed to cursor |
| Glint | 9 / 1 | cycle, turret | 96.0 | 53.3 | 54.4 | 0.97 | 54.4 / 29.9 / 29.9 / 11.6 | 27.0/shot | 15.0 | 5100 | instant | none | 0.6 s | - |  |
| Cutter | 18 / 2 | beam, fixed | - | 150 | 150 | 2.68 | 173 / 150 / 150 / 70.1 | 32.0/s | 32.0 | 900 | instant | none | 0.9 s | - |  |
| Searchlight | 26 / 3 | beam, turret | - | 25.0 | 25.0 | 0.45 | 28.7 / 28.7 / 28.7 / 21.3 | 15.0/s | 15.0 | 7650 | instant | none | 2.2 s | - | marks +20% |
| Strobe | 10 / 1 | cycle, turret | 27.0 | 54.0 | 54.0 | 0.96 | 25.1 / 13.0 / 15.6 / 5.7 | 6.0/shot | 12.0 | 5040 | 72.0 | 177 u (9 t) | 1.1 s | - | x1.6 shields / x0.6 hull |
| Overpulse | 25 / 3 | clip (clip 12, reload 90t), turret | 9.0 | 90.0 | 41.4 | 0.74 | 23.8 / 22.3 / 26.7 / 16.0 | 36.0/clip | 13.3 | 5040 | 72.0 | 177 u (9 t) | 0.8 s | - | x1.9 shields / x0.5 hull |
| Dart | 11 / 1 | ammo, fixed | 64.0 | 35.6 | 36.3 | 0.65 | 28.1 / 14.5 / 13.1 / 6.3 | 1 round | 0.0 | 10925 | 14.0->44.0 | 492 u (25 t) | 0.4 s | 43.2 s | homing 0.07 |
| Swarm | 21 / 3 | ammo, fixed | 132 | 44.0 | 44.0 | 0.79 | 50.6 / 47.3 / 42.6 / 34.1 | 6 rounds | 0.0 | 10925 | 14.0->44.0 | 492 u (25 t) | 0.4 s | 12.0 s | homing 0.091 |
| Hammerhead | 33 / 4 | ammo, fixed | 159 | 48.2 | 50.4 | 0.90 | 57.9 / 57.9 / 52.1 / 54.1 | 1 round | 0.0 | 7752 | 9.8->30.8 | 552 u (28 t) | 0.5 s | 79.2 s | homing 0.07, guided |
| Needle | 13 / 2 | ammo, fixed | 62.0 | 49.6 | 49.6 | 0.89 | 57.0 / 57.0 / 48.5 / 50.7 | 1 round | 0.0 | 9000 | 150 | 78.8 u (4 t) | 0.1 s | 250 s | pierce 2 |
| Coilgun | 22 / 3 | cycle, fixed | 80.0 | 88.9 | 89.3 | 1.60 | 103 / 103 / 87.3 / 97.6 | 14.0/shot | 15.6 | 2700 | 150 | 78.8 u (4 t) | 0.1 s | - | pierce 1 |
| Spear | 28 / 4 | cycle, fixed | 160 | 84.2 | 85.3 | 1.52 | 98.1 / 98.1 / 83.4 / 93.2 | 120/shot | 63.2 | 9000 | 150 | 78.8 u (4 t) | 0.1 s | - | pierce 3 |
| Hush | 15 / 2 | cycle, turret | 3.0 | 1.1 | 1.1 | 0.02 | 1.3 / 1.1 / 1.4 / 0.6 | 25.0/shot | 9.3 | 2700 | 30.0 | 394 u (20 t) | 48.9 s | - | EMP |
| Blackout | 35 / 4 | charge (charge 90t, cool 240t), turret | 3.0 | 2.0 | 0.6 | 0.01 | 0.6 / 0.6 / 0.8 / 0.6 | 90.0/charge | 16.4 | 3300 | 30.0 | 394 u (20 t) | 101 s | - | EMP |
| Spark | 17 / 2 | cycle, turret | 34.0 | 45.3 | 45.3 | 0.81 | 52.1 / 45.3 / 54.4 / 24.9 | 13.5/shot | 18.0 | 660 | 110 | 118 u (6 t) | 0.8 s | - | chains 3 |
| Tesla | 29 / 4 | beam, turret | - | 70.0 | 70.0 | 1.25 | 80.5 / 80.5 / 96.6 / 80.5 | 30.0/s | 30.0 | 660 | instant | none | 0.8 s | - | chains 5 |
| Eel | 19 / 2 | ammo, fixed | 500 | 125 | 125 | 2.23 | 144 / 144 / 129 / 125 | 1 round | 0.0 | 7458 | 6.0->15.0 | 1241 u (63 t) | 1.1 s | 24.0 s | homing 0.02, ignores shields |
| Leviathan | 38 / 5 | ammo, fixed | 1200 | 200 | 200 | 3.57 | 230 / 230 / 207 / 230 | 2 rounds | 0.0 | 6020 | 4.8->12.0 | 1359 u (69 t) | 1.1 s | 18.0 s | ignores shields |
| Lance | 32 / 4 | beam (windup 18t), fixed | - | 210 | 210 | 3.75 | 241 / 290 / 241 / 205 | 90.0/s | 90.0 | 500 | instant | none | 0.4 s | - |  |
| Rustjaw's Hive | 12 / 4 | clip+regrow (clip 8 regrow 45t), fixed | 88.0 | 176 | 30.8 | 0.55 | 35.4 / 35.4 / 31.9 / 30.8 | 48.0/clip | 8.0 | 8684 | 12.0->38.0 | 532 u (27 t) | 0.5 s | - | homing 0.11 |
| Frostbite Lance | 12 / 4 | beam, turret | - | 95.0 | 95.0 | 1.70 | 109 / 109 / 120 / 98.3 | 24.0/s | 24.0 | 760 | instant | none | 0.6 s | - | slows |
| Cinder Bloom | 22 / 4 | cycle, turret | 126 | 105 | 105 | 1.88 | 121 / 121 / 121 / 95.9 | 14.0/shot | 11.7 | 3240 | 36.0 | 335 u (17 t) | 0.3 s | - |  |
| Prism Splitter | 10 / 4 | cycle, turret | 33.0 | 20.6 | 20.9 | 0.37 | 24.0 / 24.0 / 28.8 / 24.0 | 16.0/shot | 10.0 | 2800 | 40.0 | 295 u (15 t) | 1.9 s | - |  |
| Phase Cannon | 26 / 4 | cycle, fixed | 70.0 | 31.8 | 32.7 | 0.58 | 37.6 / 37.6 / 37.6 / 37.6 | 30.0/shot | 13.6 | 3300 | 30.0 | 394 u (20 t) | 0.3 s | - | ignores shields, pierce 2 |
| Singularity Launcher | 30 / 4 | cycle, turret | 140 | 20.0 | 21.0 | 0.38 | 24.1 / 24.1 / 24.1 / 24.1 | 210/shot | 30.0 | 2052 | 9.0 | 1320 u (67 t) | 4.9 s | - |  |
| Rail Driver | 29 / 4 | clip (clip 6, reload 90t), fixed | 40.0 | 240 | 104 | 1.86 | 120 / 120 / 102 / 114 | 48.0/clip | 19.2 | 9000 | 150 | 78.8 u (4 t) | 0.2 s | - | pierce 1 |

## Energy

Two of the gun held for 60 s while thrusting. Each cell: first brownout / share of its full-power shots it still fires / its draw flat out as a share of the spare generation left after the engines / as a share of the Output.

| Weapon | starter | mid | bank |
|---|---|---|---|
| Pip | never / 100% / 31% / 2% | never / 100% / 16% / 1% | never / 100% / 16% / 1% |
| Hammer | never / 100% / 38% / 3% | never / 100% / 20% / 1% | never / 100% / 20% / 1% |
| Twinlink | never / 100% / 30% / 2% | never / 100% / 15% / 1% | never / 100% / 15% / 1% |
| Longbarrel | never / 100% / 40% / 3% | never / 100% / 21% / 1% | never / 100% / 21% / 1% |
| Bastion | never / 100% / 64% / 4% | never / 100% / 33% / 2% | never / 100% / 33% / 2% |
| Rattler | never / 100% / 46% / 3% | never / 100% / 24% / 1% | never / 100% / 24% / 1% |
| Chainsaw | never / 100% / 86% / 6% | never / 100% / 45% / 2% | never / 100% / 45% / 2% |
| Stinger | never / 100% / 28% / 2% | never / 100% / 15% / 1% | never / 100% / 15% / 1% |
| Burst | never / 100% / 0% / 0% | never / 100% / 0% / 0% | never / 100% / 0% / 0% |
| Cloudmaker | never / 100% / 26% / 2% | never / 100% / 13% / 1% | never / 100% / 13% / 1% |
| Lobber | never / 100% / 0% / 0% | never / 100% / 0% / 0% | never / 100% / 0% / 0% |
| Quake | never / 100% / 0% / 0% | never / 100% / 0% / 0% | never / 100% / 0% / 0% |
| Glint | never / 99% / 58% / 4% | never / 99% / 30% / 1% | never / 99% / 30% / 1% |
| Cutter | 20.1 s / 93% / 123% / 8% | never / 100% / 64% / 3% | never / 100% / 64% / 3% |
| Searchlight | never / 100% / 58% / 4% | never / 100% / 30% / 1% | never / 100% / 30% / 1% |
| Strobe | never / 100% / 46% / 3% | never / 100% / 24% / 1% | never / 100% / 24% / 1% |
| Overpulse | never / 100% / 51% / 3% | never / 100% / 27% / 1% | never / 100% / 27% / 1% |
| Dart | never / 99% / 0% / 0% | never / 99% / 0% / 0% | never / 99% / 0% / 0% |
| Swarm | never / 100% / 0% / 0% | never / 100% / 0% / 0% | never / 100% / 0% / 0% |
| Hammerhead | never / 97% / 0% / 0% | never / 97% / 0% / 0% | never / 97% / 0% / 0% |
| Needle | never / 100% / 0% / 0% | never / 100% / 0% / 0% | never / 100% / 0% / 0% |
| Coilgun | never / 100% / 60% / 4% | never / 100% / 31% / 2% | never / 100% / 31% / 2% |
| Spear | 3.3 s / 44% / 243% / 16% | 24.2 s / 88% / 126% / 6% | 36.4 s / 91% / 126% / 6% |
| Hush | never / 100% / 36% / 2% | never / 100% / 19% / 1% | never / 100% / 19% / 1% |
| Blackout | never / 100% / 63% / 4% | never / 100% / 33% / 2% | never / 100% / 33% / 2% |
| Spark | never / 100% / 69% / 5% | never / 100% / 36% / 2% | never / 100% / 36% / 2% |
| Tesla | 29.8 s / 96% / 115% / 8% | never / 100% / 60% / 3% | never / 100% / 60% / 3% |
| Eel | never / 100% / 0% / 0% | never / 100% / 0% / 0% | never / 100% / 0% / 0% |
| Leviathan | never / 100% / 0% / 0% | never / 100% / 0% / 0% | never / 100% / 0% / 0% |
| Lance | 1.9 s / 60% / 346% / 23% | 8.0 s / 76% / 180% / 9% | 12.0 s / 75% / 180% / 9% |
| Rustjaw's Hive | never / 100% / 31% / 2% | never / 100% / 16% / 1% | never / 100% / 16% / 1% |
| Frostbite Lance | never / 100% / 92% / 6% | never / 100% / 48% / 2% | never / 100% / 48% / 2% |
| Cinder Bloom | never / 100% / 45% / 3% | never / 100% / 23% / 1% | never / 100% / 23% / 1% |
| Prism Splitter | never / 100% / 38% / 3% | never / 100% / 20% / 1% | never / 100% / 20% / 1% |
| Phase Cannon | never / 100% / 52% / 4% | never / 100% / 27% / 1% | never / 100% / 27% / 1% |
| Singularity Launcher | 29.8 s / 89% / 115% / 8% | never / 100% / 60% / 3% | never / 100% / 60% / 3% |
| Rail Driver | never / 100% / 74% / 5% | never / 100% / 38% / 2% | never / 100% / 38% / 2% |

Reading it: only the Lance, Spear, Cutter, Tesla and Singularity ever brown out, and only on the starter. The Modest and Bank columns are the same for every gun but the Lance (8 -> 12 s to first brownout) and the Spear (24 -> 36 s). Boosting is not in the table: on the starter it takes 57.6 of the 70 E/s, leaving 12.4 for guns, so even then a pair of Pips (16 E/s) drains the 240 store in about a minute.

## Time to kill, every gun, every enemy

Seconds from the first shot until the core dies (plus the last shell's flight), with shots fired in brackets (and clips for clip guns). Beams have no shot count. Mite and Crawler: Sol scrapborn (hpScale 0.3). Skiff, Cutter, Brawler: Sol pirates and Redtooth. Raider II, Warden II, Zealot III: mid systems. Elite Gunship II: an elite. Tallyman: the Sol boss.

| Weapon | mite | crawler | skiff | cutter | brawler | raider2 | warden2 | zealot3 | eliteGun2 | tallyman |
|---|---|---|---|---|---|---|---|---|---|---|
| **2x Pip (starter)** | 0.7 | 0.7 | 2.2 | 1.7 | 4.5 | 5.2 | 7.0 | 18.0 | 8.7 | 15.7 |
| Pip | 1.5 (6) | 1.5 (6) | 4.2 (17) | 3.5 (14) | 8.7 (35) | 10.2 (41) | 14.0 (56) | 35.7 (143) | 17.2 (69) | 31.5 (126) |
| Hammer | 1.0 (2) | 1.0 (2) | 3.1 (5) | 2.4 (4) | 5.2 (8) | 4.5 (7) | 7.3 (11) | 13.6 (20) | 8.0 (12) | 22.7 (33) |
| Twinlink | 0.7 (6, 1 clip) | 0.7 (6, 1 clip) | 3.3 (17, 2 clips) | 1.5 (14, 1 clip) | 4.4 (28, 2 clips) | 4.3 (27, 2 clips) | 7.1 (41, 3 clips) | 13.4 (76, 5 clips) | 7.5 (45, 3 clips) | 22.8 (127, 8 clips) |
| Longbarrel | 5.6 (2) | 5.6 (2) | 5.6 (2) | 5.6 (2) | 9.1 (3) | 9.1 (3) | 16.0 (5) | 12.5 (4) | 9.1 (3) | 33.4 (10) |
| Bastion | 0.6 (2, 1 clip) | 0.6 (2, 1 clip) | 0.6 (2, 1 clip) | 0.6 (2, 1 clip) | 3.7 (3, 2 clips) | 3.7 (3, 2 clips) | 4.0 (4, 2 clips) | 4.0 (4, 2 clips) | 3.7 (3, 2 clips) | 13.9 (10, 5 clips) |
| Rattler | 2.1 (17) | 2.1 (17) | 7.0 (59) | 5.8 (49) | 15.4 (131) | 18.3 (156) | 24.0 (205) | 66.3 (567) | 31.0 (265) | 52.6 (450) |
| Chainsaw | 1.5 (13) | 1.5 (13) | 3.4 (42) | 3.0 (37) | 5.6 (78) | 5.8 (81) | 8.0 (117) | 16.3 (249) | 9.3 (137) | 21.0 (325) |
| Stinger | 1.0 (7, 1 clip) | 1.0 (7, 1 clip) | 5.5 (26, 3 clips) | 3.8 (21, 2 clips) | 8.4 (40, 4 clips) | 8.0 (37, 4 clips) | 11.6 (57, 5 clips) | 16.9 (82, 7 clips) | 13.3 (62, 6 clips) | 40.5 (191, 16 clips) |
| Burst | 5.4 (10) | 5.4 (10) | 18.4 (33) | 16.2 (29) | 20.7 (37) | 66.0 (117) | 59.8 (106) | 155 (274) | 113 (199) | 187 (330) |
| Cloudmaker | 1.3 (3, 1 clip) | 1.3 (3, 1 clip) | 8.4 (9, 3 clips) | 5.8 (8, 2 clips) | 5.8 (8, 2 clips) | 20.9 (22, 6 clips) | 21.4 (23, 6 clips) | 50.0 (52, 13 clips) | 36.5 (37, 10 clips) | 81.6 (83, 21 clips) |
| Lobber | 0.5 (1) | 0.5 (1) | 3.5 (3) | 3.5 (3) | 3.5 (3) | 11.0 (8) | 12.5 (9) | 27.5 (19) | 18.5 (13) | 41.0 (28) |
| Quake | 0.7 (1) | 0.7 (1) | 3.5 (2) | 1.0 (1) | 1.0 (1) | 3.7 (2) | 3.7 (2) | 6.7 (3) | 6.7 (3) | 30.7 (11) |
| Glint | 2.2 (2) | 2.2 (2) | 4.2 (3) | 4.1 (3) | 9.6 (6) | 9.6 (6) | 13.2 (8) | 42.0 (24) | 15.0 (9) | 33.0 (19) |
| Cutter | 0.8 | 0.8 | 2.1 | 1.9 | 3.3 | 2.6 | 4.0 | 8.1 | 3.9 | 11.0 |
| Searchlight | 2.2 | 2.2 | 7.8 | 6.6 | 12.0 | 9.2 | 15.0 | 22.1 | 15.6 | 60.5 |
| Strobe | 2.7 (6) | 2.7 (6) | 8.7 (18) | 7.7 (16) | 20.2 (41) | 17.2 (35) | 21.7 (44) | 83.2 (167) | 28.7 (58) | 69.2 (139) |
| Overpulse | 2.8 (13, 2 clips) | 2.8 (13, 2 clips) | 8.7 (44, 4 clips) | 8.1 (38, 4 clips) | 14.2 (70, 6 clips) | 8.9 (46, 4 clips) | 13.3 (61, 6 clips) | 29.3 (137, 12 clips) | 16.5 (79, 7 clips) | 73.4 (337, 29 clips) |
| Dart | 2.2 (2) | 2.2 (2) | 7.6 (5) | 5.8 (4) | 9.4 (6) | 20.2 (12) | 20.2 (12) | 61.6 (35) | 34.6 (20) | 63.4 (36) |
| Swarm | 0.6 (1) | 0.6 (1) | 3.5 (2) | 3.5 (2) | 6.5 (3) | 6.4 (3) | 6.8 (3) | 12.4 (5) | 9.7 (4) | 33.7 (12) |
| Hammerhead | 0.5 (1) | 0.5 (1) | 3.8 (2) | 3.8 (2) | 3.8 (2) | 3.8 (2) | 7.1 (3) | 7.1 (3) | 7.1 (3) | 30.2 (10) |
| Needle | 1.3 (2) | 1.3 (2) | 5.1 (5) | 2.6 (3) | 6.3 (6) | 6.3 (6) | 8.8 (8) | 10.1 (9) | 10.1 (9) | 31.3 (26) |
| Coilgun | 2.8 (4) | 2.8 (4) | 11.8 (14) | 9.1 (11) | 18.1 (21) | 15.4 (18) | 20.8 (24) | 19.0 (22) | 26.2 (30) | 85.6 (96) |
| Spear | 2.0 (2) | 2.0 (2) | 2.0 (2) | 2.0 (2) | 3.9 (3) | 3.9 (3) | 7.7 (5) | 7.7 (5) | 5.8 (4) | 19.1 (11) |
| Hush | 51.7 (20) | 51.7 (20) | 176 (66) | 149 (56) | 292 (109) | 197 (74) | never | never | never | never |
| Blackout | 106 (20) | 106 (20) | never | never | never | never | never | never | never | never |
| Spark | 1.6 (3) | 1.6 (3) | 3.9 (6) | 3.9 (6) | 7.6 (11) | 4.6 (7) | 8.4 (12) | 18.9 (26) | 8.4 (12) | 33.9 (46) |
| Tesla | 1.0 | 1.0 | 3.0 | 2.6 | 4.6 | 2.8 | 4.8 | 6.2 | 4.8 | 21.8 |
| Eel | 1.1 (1) | 1.1 (1) | 5.1 (2) | 5.1 (2) | 5.1 (2) | 5.1 (2) | 9.1 (3) | 5.1 (2) | 5.1 (2) | 13.1 (4) |
| Leviathan | 1.2 (1) | 1.2 (1) | 1.2 (1) | 1.2 (1) | 1.2 (1) | 1.2 (1) | 1.2 (1) | 7.2 (2) | 7.2 (2) | 7.2 (2) |
| Lance | 0.4 | 0.4 | 1.1 | 0.9 | 1.5 | 1.3 | 1.9 | 2.5 | 2.0 | 7.4 |
| Rustjaw's Hive | 0.7 (1) | 0.7 (1) | 1.3 (2) | 1.2 (2) | 6.6 (4) | 3.8 (3) | 6.8 (4) | 9.7 (5) | 12.5 (6) | 48.6 (18) |
| Frostbite Lance | 0.6 | 0.6 | 2.1 | 1.8 | 3.2 | 2.2 | 3.7 | 4.8 | 3.7 | 15.9 |
| Cinder Bloom | 1.5 (2) | 1.5 (2) | 5.8 (5) | 5.1 (5) | 8.7 (8) | 6.6 (6) | 11.1 (10) | 14.7 (13) | 11.1 (10) | 39.9 (34) |
| Prism Splitter | 3.5 (3) | 3.5 (3) | 8.3 (6) | 8.3 (6) | 16.3 (11) | 9.9 (7) | 17.9 (12) | 19.5 (13) | 16.3 (11) | 73.9 (47) |
| Phase Cannon | 2.6 (2) | 2.6 (2) | 4.8 (3) | 4.8 (3) | 11.4 (6) | 6.9 (4) | 9.2 (5) | 13.6 (7) | 11.4 (6) | 46.6 (22) |
| Singularity Launcher | 4.9 (1) | 4.9 (1) | 4.9 (1) | 4.9 (1) | 4.9 (1) | 11.9 (2) | 11.9 (2) | 11.9 (2) | 11.9 (2) | 67.9 (10) |
| Rail Driver | 0.3 (2, 1 clip) | 0.3 (2, 1 clip) | 0.9 (6, 1 clip) | 0.8 (5, 1 clip) | 2.6 (8, 2 clips) | 2.4 (7, 2 clips) | 3.3 (12, 2 clips) | 4.8 (13, 3 clips) | 4.8 (13, 3 clips) | 14.5 (39, 7 clips) |

## Suggestions

### The rule to tune to

A gun unlocked later should beat the free Pip at the job its design gives it, measured by kill speed (Pip time to
kill / its time to kill) against the enemies of its level:

| Unlock level | Kill speed vs one Pip |
|---|---|
| 0 to 9 (starting area) | 1.0 to 2.0 |
| 10 to 19 | 1.5 to 3.0 |
| 20 to 29 | 2.0 to 4.5 |
| 30 and up, and legendaries' specials | 3.0 to 6.0 (the Lance and Leviathan may go higher, paid for in energy or ammo) |
| Support and control (Searchlight, Hush, Blackout) | not judged on damage; at least a third of a Pip so the slot is not dead |

Energy follows damage (the generator's own rule in `scripts/econ/models.mjs`: "a gun that hits harder per second
draws that much more"), so each damage raise below raises the gun's energy by about as much, except where noted.

### Per weapon

All model changes are in `scripts/econ/models.mjs` (then `node scripts/econ/models.mjs`; never hand-edit
`models.json`): the gun's `W` row (its `k` numbers and `mods`), its `FIRE` block, `RAIL_E`, `BEAM_E` or `BEAM_SET`.
Legendary kinds and the Prism's shards are in `data/ships/tuning.json` `weapons` (no enemy uses those kinds). No
change touches a shared kind that enemies fire (cannon, autocannon, flak, pulse, missile, laser, railgun, torpedo),
so enemy guns are unaffected. Descriptions in the W rows quote numbers and must be updated with them.

| Weapon | Where | Change (from -> to) | Why |
|---|---|---|---|
| Rattler | W row | `k {}` -> `{ dmg: 1.4, int: 0.786 }`; mods `{}` -> `{ mul: { damage: x(1.4) } }`; FIRE `{ model: 'cycle', interval: 5.5 }` | Damage 5 -> 7, beat 7 -> 5.5 t (8.6 -> 11 shots/s), 1.4 -> 1.96 E a shot. The steady hose was a downgrade from the Pip (0.6x); now 1.07x, still the stream with the 270 degree turret. |
| Burst | W row mods | `{}` -> `{ mul: { damage: x(1.6), splashDamage: x(30/16) }, set: { fuse: 70 }, add: { pen: 0.5 } }` | Direct 5 -> 8, splash 16 -> 30, fuse 120 -> 70 (bursts nearer the hull), penetration -1 -> -0.5. Was a third of a Pip; now 1.0x at start, 0.75x later. Keeps "fire and forget, finds the near miss". |
| Lobber | W row mods | `{}` -> `{ mul: { splashDamage: x(90/70) } }` | Blast 70 -> 90. Its damage was fine when it lands; this pays for the 28-tick flight and the landing ring every target can see. |
| Glint | W row | mods -> `{ mul: { damage: x(125/96) } }`; `k {}` -> `{ dmg: 1.3 }` | Pulse 96 -> 125, 27 -> 35 E a pulse. Tied with the Pip at level 9; now 1.8x / 1.4x. Instant hit at 5,100 is its edge against fast ships. |
| Strobe | W row | mods -> `{ mul: { damage: x(12/9) }, set: { vsHull: 0.9 }, add: { pen: 0.5 } }`; `demand` 12 -> 16 | Bolt 9 -> 12, x0.6 -> x0.9 against hull, pen -0.5 -> 0, 6 -> 8 E a burst. Shields are too small for a x0.6 hull gun to pay off; still x1.6 on shields. 0.5x -> 1.2x / 1.5x. |
| Dart | W row mods, FIRE | mods -> `{ mul: { damage: x(40/30), splashDamage: x(45/34) } }`; FIRE interval 108 -> 72 | 30 + 34 -> 40 + 45 every 1.2 s instead of 1.8 s. Half a Pip -> 1.1x; homing makes it the easy-to-hit option. A crate lasts 29 s. |
| Twinlink | FIRE | reload 90 -> 70 | Kill speed was already 1.9x (the clip burst), sustained only Pip level. Small cut. |
| Needle | W row mods, FIRE | mods -> `{ mul: { damage: x(72/62) } }`; FIRE `{ model: 'ammo', interval: 54 }` | Slug 62 -> 72, every 0.9 s instead of 1.25 s. 1.1x -> 1.8x / 2.9x. A 200-slug crate still lasts 3 minutes. |
| Chainsaw | W row | mods -> `{ mul: { spread: x(1.5), damage: x(1.6) } }`; `demand` 10.5 -> 16.8 | 5 -> 8 a shot, 1.4 -> 2.24 E a shot. Under a Pip against Mk II hull; now 1.5x / 2.75x. A pair now browns a starter out after 13 s, which is right for a minigun. |
| Cloudmaker | W row mods, FIRE | mods -> `{ mul: { splashRadius: x(250/170), splashDamage: x(48.75/16), damage: x(1.6) }, set: { fuse: 70 }, add: { pen: 0.5 } }`; FIRE reload 150 -> 90, reloadE 30 -> 45 | Splash 26 -> 49 (r250 kept), reload 2.5 -> 1.5 s. Was a quarter of a Pip; now 2.3x. |
| Spark | W row mods, RAIL_E | mods -> `{ mul: { damage: x(50/34) } }`; `RAIL_E.arc_spark` 13.5 -> 20 | Bolt 34 -> 50. Was equal to the Pip at level 17; now 1.6x / 2.3x, and the chain is a bonus. |
| Cutter | W row mods (`set.ramp`) | `ramp: { to: 150 }` -> `{ to: 120, ticks: 90 }` | 2.7x a Pip at level 18 was the biggest early outlier. Now 2.1x sustained, kill speed 1.9x / 3.3x. Keep 60 start and 32 E/s. |
| Eel | W row mods | `set: { homing: 0.02 }` -> `set: { homing: 0.035, maxSpeed: 24 }` | It topped out at 15 u/tick, so it could never catch a Skiff (30) or Cutter (26). Still slow, still shot down in 3 hits; now it can finish a chase. |
| Longbarrel | W row mods, FIRE | damage `xp(170/14)` -> `xp(260/14)`; FIRE cooldown 90 -> 60, chargeE 36 -> 54 | Shot 170 -> 260, a shot every 3 s instead of 3.5 s. Was under a Pip sustained at level 20; now 1.7x and 2.2x later. Still slow against tiny ships (the 2 s charge), which is the sniper's trade. |
| Swarm | FIRE | `rounds` 6 -> 2, interval 180 -> 150 | A 24-round crate lasted 12 s (4 salvos), then it fires 40% plain rounds; now 30 s (12 salvos). Damage was fine (kill speed 1.7x / 2.0x). |
| Stinger | W row mods, FIRE | mods damage `x(1.6)` -> `x(3.2)`, add `pen: 0.5`; FIRE interval 7.5 -> 6, reload 72 -> 48, reloadE 20 -> 40 | Needle 8 -> 16, pen -0.5 -> 0 (the marksman SMG picks its part), 12 rounds at 10/s, 0.8 s reload. Was half a Pip at level 24; now 2.7x / 3.8x. |
| Overpulse | W row mods, FIRE | mods add `mul: { damage: x(14/9) }`, `set.vsHull` 0.5 -> 0.8, add `pen: 0.5`; FIRE clip 12 -> 16, reload 90 -> 60, reloadE 36 -> 60 | Bolt 9 -> 14, x0.5 -> x0.8 on hull, a 16-round dump. Was 0.29x a Pip at level 25; now 2.0x / 3.5x and x1.9 on shields still makes it the shredder. |
| Searchlight | BEAM_SET | dps 25 -> 40 (15 E/s kept) | The +20% mark is its job; 40 dps keeps a solo pilot from carrying dead weight (0.99x a Pip). |
| Spear | W row mods | `set.damage` 160 -> 210 (RAIL_E 120 kept) | 1.4x at start was low for level 28; now 4.5x later. Still the energy hog (a pair browns a starter out in 3.3 s). |
| Tesla | BEAM_SET, BEAM_E | dps 70 -> 100 (zap 14 -> 20); BEAM_E 30 -> 40 | 1.5x / 3.2x -> 2.3x / 4.5x at level 29, chaining to 5. |
| Hammerhead | W row mods, FIRE | damage `xp(3.5)` -> `xp(150/30)`, `set.splash.damage` 54 -> 80; FIRE `{ model: 'ammo', interval: 150 }` | Warhead 105 + 54 -> 150 + 80, every 2.5 s instead of 3.3 s. Was 0.63x a Pip at level 33. |
| Prism Splitter | tuning.json `weapons.prism.damage`, `weapons.prism_shard.damage`; FIRE | 22 -> 30; shards 11 -> 18; interval 96 -> 48 (RAIL_E 16 kept, so 10 -> 20 E/s) | Was 0.4x a Pip, the weakest legendary. Now 1.4x / 2.9x. |
| Rustjaw's Hive | FIRE | regrow 45 -> 35 | Its salvo was already good (2.3x); this lifts the sustained rate. |
| Cinder Bloom | FIRE | interval 72 -> 60 | Small: kill speed 0.87 -> 0.93 at start, 1.6x later; the burn is the point. |
| Phase Cannon | tuning.json `weapons.phase.damage`; FIRE | 70 -> 110; interval 132 -> 80 (RAIL_E 30 kept, 13.6 -> 22.5 E/s) | Was 0.6x a Pip; now 1.1x / 3.3x, through shields and rock. |
| Singularity | tuning.json `weapons.singularity.splash.damage`; FIRE; RAIL_E | collapse 140 -> 220; interval 420 -> 360; RAIL_E 210 -> 180 (E/s unchanged) | It is a crowd weapon (pull then collapse), but 0.36x a Pip single target was too little. Now 1.9x later. |

**Leave alone:** Pip (the reference), Hammer, Bastion, Rail Driver, Coilgun (strong at its close range; at 600 u its
cone spreads damage over side parts), Quake (strong when it lands), Lance (4.3x, paid for in energy and range),
Leviathan (a big-ship killer by design), Frostbite (strong for level 12 but a boss artefact with a slow), Hush and
Blackout (control).

### Systemic

1. **Pin the rule with a test.** Turn `docs/audits/weapons-balance-calc.ts` into a slow test (or a `npm run` report)
   that fails when a gun's kill speed falls outside its band above. Guns drift when kinds, materials or enemies
   change; today nothing catches it.
2. **Penetration penalties.** Pen -0.5 and -1 on the kind (autocannon, pulse, missile, mortar, flak) cost 22 to 45%
   against a same-grade hull before plate. That is fine as a rule ("small fast hits do not beat armour"), but each
   such gun's raw damage has to be set with it in mind; most were not. The per-weapon changes above do that, and
   give back +0.5 pen only where the design's character says so (Stinger, Strobe, Overpulse, flak).
3. **Decide what energy is for.** Today it limits only the Lance and Spear. Guns pay over their reload, so no gun
   ever asks for more than 90 E/s, while Output starts at 720/s: the Output limit and a Capacitor's 2,000/s never
   bind in combat (measured: a 2-Capacitor bank changes nothing for 35 of 37 guns). Two ways to make it matter:
   - (simplest) keep the model, and accept that energy is about sustained generation. The changes above raise
     energy with damage, so an early pair now uses 30 to 80% of a starter's spare power and the mid guns (Chainsaw,
     Spark, Tesla, Cutter) need a second reactor or a bank. Then reword the Capacitor's "Gives 2,000/s" in the
     hangar: what it really adds is 160 E of storage only the guns can use.
   - (bigger) make clip and charge guns pay their reload energy up front (the first 10 to 20 ticks of the reload,
     instead of spread over all of it). Then a Bastion, Rail Driver, Longbarrel or Spear reload is a real spike,
     Output and the Capacitor's rate start to matter, and the bank design (2.3) works as written. This undoes the
     design's "pay over the reload" choice for those guns only, so it is the owner's call.
4. **Hit difficulty.** The fast small pirates (Skiff 30, Cutter 26 u/tick) are as quick as the player and sideways
   faster than most shells can follow. Either slow their side thrust a little, or speed up the slow shells that are
   not slow on purpose: Burst 34 -> 44, Phase 30 -> 42, Cinder Bloom 36 -> 44, Prism 40 -> 50. (The Bastion's 32,
   the mortars and the Leviathan are slow by design and should stay.) These are not in the after-numbers, which
   assume every shot hits.
5. **Shields.** The pulse guns are built to strip shields, but only some enemies carry any and those are small
   (Frost Warden 104 against 1,231 hull). If the shield-shredder fantasy matters, give the mid and late factions
   (Frost, Wraiths, Maw) bigger shields; otherwise the pulse guns need the hull fixes above to be worth a slot.

### After the suggested numbers

Measured with `--after` (the suggestions applied in memory, everything else as before):

| Weapon | Lvl / Mk | Sustained DPS | Eff. DPS vs own Mk, x Pip | Kill speed vs Pip, start | Kill speed vs Pip, later | E/s flat out | Pair on starter: first brownout |
|---|---|---|---|---|---|---|---|
| Pip | 0 / 1 | 56.0 | 1.00 | 1.00 | 1.00 | 8.0 | never |
| Rattler | 3 / 1 | 42.9 -> 76.4 | 0.59 -> 1.06 | 0.64 -> 1.07 | 0.57 -> 1.01 | 12.0 -> 21.4 | never |
| Burst | 4 / 1 | 37.1 -> 67.1 | 0.36 -> 0.93 | 0.27 -> 1.02 | 0.18 -> 0.75 | 0.0 | never |
| Hammer | 6 / 1 | 68.8 | 1.41 | 1.50 | 2.03 | 10.0 | never |
| Lobber | 7 / 1 | 46.7 -> 60.0 | 0.65 -> 0.83 | 1.96 -> 2.45 | 0.99 -> 1.31 | 0.0 | never |
| Glint | 9 / 1 | 54.4 -> 70.8 | 0.97 -> 1.26 | 0.81 -> 1.82 | 1.01 -> 1.40 | 15.0 -> 19.5 | never |
| Strobe | 10 / 1 | 54.0 -> 72.0 | 0.45 -> 1.16 | 0.50 -> 1.22 | 0.54 -> 1.47 | 12.0 -> 16.0 | never |
| Prism Splitter | 10 / 4 | 20.9 -> 67.5 | 0.43 -> 1.39 | 0.46 -> 1.40 | 0.92 -> 2.90 | 10.0 -> 20.0 | never |
| Dart | 11 / 1 | 36.3 -> 70.8 | 0.50 -> 0.98 | 0.67 -> 1.12 | 0.55 -> 1.08 | 0.0 | never |
| Twinlink | 12 / 2 | 64.0 -> 72.4 | 0.97 -> 1.10 | 1.89 -> 1.97 | 2.10 -> 2.31 | 7.7 -> 8.7 | never |
| Rustjaw's Hive | 12 / 4 | 30.8 -> 39.6 | 0.27 -> 0.35 | 2.31 -> 2.42 | 1.79 -> 2.25 | 8.0 -> 10.3 | never |
| Frostbite Lance | 12 / 4 | 95.0 | 1.82 | 2.35 | 4.12 | 24.0 | never |
| Needle | 13 / 2 | 49.6 -> 80.4 | 0.87 -> 1.40 | 1.14 -> 1.78 | 1.73 -> 2.90 | 0.0 | never |
| Chainsaw | 14 / 2 | 79.3 -> 127 | 0.93 -> 1.49 | 1.16 -> 1.54 | 1.80 -> 2.75 | 22.4 -> 35.8 | never -> 13.1 s |
| Hush | 15 / 2 | 1.1 | 0.02 | 0.03 | 0.05 | 9.3 | never |
| Cloudmaker | 16 / 2 | 31.0 -> 75.7 | 0.27 -> 0.94 | 0.90 -> 2.34 | 0.53 -> 2.30 | 6.7 -> 12.9 | never |
| Spark | 17 / 2 | 45.3 -> 66.7 | 0.97 -> 1.43 | 0.99 -> 1.57 | 1.68 -> 2.27 | 18.0 -> 26.5 | never |
| Cutter | 18 / 2 | 150 -> 120 | 2.68 -> 2.14 | 2.04 -> 1.90 | 3.77 -> 3.26 | 32.0 | 20.1 s |
| Eel | 19 / 2 | 125 | 2.31 | 1.14 | 2.83 | 0.0 | never |
| Longbarrel | 20 / 3 | 48.2 -> 86.7 | 0.94 -> 1.69 | 0.50 -> 0.56 | 1.38 -> 2.21 | 10.3 -> 18.0 | never |
| Swarm | 21 / 3 | 44.0 -> 52.8 | 0.61 -> 0.73 | 1.54 -> 1.69 | 1.73 -> 2.04 | 0.0 | never |
| Coilgun | 22 / 3 | 89.3 | 1.74 | 0.45 | 0.73 | 15.6 | never |
| Cinder Bloom | 22 / 4 | 105 -> 126 | 1.45 -> 1.74 | 0.87 -> 0.93 | 1.42 -> 1.58 | 11.7 | never |
| Stinger | 24 / 3 | 37.1 -> 101 | 0.49 -> 1.71 | 1.11 -> 2.66 | 1.27 -> 3.77 | 7.4 -> 20.0 | never |
| Quake | 24 / 3 | 60.0 | 0.83 | 2.75 | 2.70 | 0.0 | never |
| Overpulse | 25 / 3 | 41.4 -> 89.6 | 0.29 -> 1.28 | 0.52 -> 2.04 | 0.92 -> 3.50 | 13.3 -> 23.1 | never |
| Searchlight | 26 / 3 | 25.0 -> 40.0 | 0.38 -> 0.61 | 0.62 -> 0.99 | 0.99 -> 1.59 | 15.0 | never |
| Phase Cannon | 26 / 4 | 32.7 -> 82.5 | 0.60 -> 1.52 | 0.70 -> 1.14 | 1.44 -> 3.26 | 13.6 -> 22.5 | never |
| Spear | 28 / 4 | 85.3 -> 112 | 1.49 -> 1.95 | 1.36 | 2.56 -> 4.47 | 63.2 | 3.3 s |
| Tesla | 29 / 4 | 70.0 -> 100 | 1.44 -> 2.05 | 1.51 -> 2.28 | 3.17 -> 4.45 | 30.0 -> 39.9 | 29.8 s -> 8.7 s |
| Rail Driver | 29 / 4 | 104 | 1.82 | 4.80 | 4.02 | 19.2 | never |
| Bastion | 30 / 4 | 111 | 1.94 | 3.44 | 3.95 | 16.7 | never |
| Singularity Launcher | 30 / 4 | 21.0 -> 36.7 | 0.36 -> 0.63 | 0.63 | 1.15 -> 1.94 | 30.0 | 29.8 s |
| Lance | 32 / 4 | 210 | 4.31 | 4.04 | 7.93 | 90.0 | 1.9 s |
| Hammerhead | 33 / 4 | 50.4 -> 92.0 | 0.63 -> 1.15 | 1.86 -> 2.15 | 2.33 -> 4.69 | 0.0 | never |
| Blackout | 35 / 4 | 0.6 | 0.01 | 0.03 | 0.05 | 16.4 | never |
| Leviathan | 38 / 5 | 200 | 3.29 | 2.65 | 5.61 | 0.0 | never |

With the changes the starting area has real choices: the Rattler, Burst, Lobber and Glint now match or beat the Pip, the Hammer stays the clear upgrade, and every later unlock outpaces the Pip in its band. Energy grows with damage: early pairs use 30 to 80% of a starter's spare power, and the Chainsaw and Tesla join the Lance, Spear and Cutter as guns that need more than a starter's reactors.

## Re-running

From `game-v2/`: `server/node_modules/.bin/tsx docs/audits/weapons-balance-calc.ts --md` prints every table above (about 3 s). `--after` applies the `SUGGESTIONS` list in the script in memory first. Without `--md` it prints the raw numbers as JSON. The script reads only data files and shared code; it writes nothing.
