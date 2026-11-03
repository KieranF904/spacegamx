# Weapon effects audit (2026-11-04)

Every projectile gun's look (client/src/rendering/weapons: `weaponStyles.ts`, `kineticStyles.ts`, `ordnanceStyles.ts`,
`legendaryStyles.ts`, `WeaponFx.ts`; energy looks in client/src/ships/energyLooks.ts; detonations, shield ripples and
plating hits in client/src/ships/DamageFx.ts), checked three ways:

- **numbers**: each model's damage a shot, shell size and tier against its muzzle flash size, its hit's reach and life
  (`npx vite-node scripts/balance/impact-audit.ts`, plus the muzzle size `muzzle.size × scale`, worked out the same way);
- **live game**: a dev-server page drives WeaponFx directly (predicted shells from points in empty space at the dev
  range, hits reported for them, and the server's detonation message fed to DamageFx), frozen a set number of frames
  after, so before and after are the same moment and the same layout;
- **cost**: a heavy fight in the same page (below).

Panels: `docs/panels/2026-11-04/graphics/muzzle-flash-scale*.png`, `warhead-shell-marks*.png`.

## What changed

1. **Warhead shells drew a flat flash bigger than their own blast.** Missiles, torpedoes, mortars, flak, EMP, the Hive,
   Cinder Bloom, the Singularity and charges had no layered hit, so where the shell struck WeaponFx drew the old flat
   flash: a filled disc of `impact.flash × shot scale` (linear, not the square root the layered hits use), a second disc
   1.8× that, and `impact.sparks × shot scale` loose sparks, uncapped. DamageFx then drew the real explosion on top. A
   Leviathan's disc reached 476 units against its 160 blast (209 sparks); Hammerhead 222 vs 150, Eel 170 vs 90, Quake 99,
   Lobber 74. Now each of those kinds has `BURST_MARK` (weaponStyles.ts): a white pinpoint, a brief glow in the shot's
   impact colour, a few embers and its light, through the layered path (square-root scaled, particles capped at 1.5×):
   a typical reach of 31-39 units for all of them, its stray embers to about 130.
   Every missile, torpedo, mortar and flak shell's own mark now stays under three quarters of its blast (impactSpan.test.ts); the blast is DamageFx's,
   unchanged. Leviathan's and Hammerhead's loose sparks cut to 24 and 16.
2. **Muzzle flashes ran from a speck to a screenful.** The flash was `muzzle.size × shell size × shotScale`, linear: a
   Rattler's 5 units, a Leviathan's 200 (its soft bloom ~370 across). Now `muzzleScale` (weaponStyles.ts): in step
   with the shot through the usual range, at least 0.8, and growing at 0.4 of the rate past a shot scale of 3. The two
   ordnance flashes set without that in mind come down (Leviathan 42 → 26, girth 1.9 → 1.5; Hammerhead 30 → 20). Result:
   Leviathan 200 → 96, Hammerhead 115 → 67, Bastion 75 → 66, Eel 61 → 57; the light streams come up to the floor
   (Rattler 5 → 9, Stinger 6 → 10, Chainsaw 6 → 10, Coilgun, Strobe and Overpulse a little); every gun with a shot scale
   between 0.8 and 3 is unchanged. A Leviathan launch is still the biggest, now 1.45× a Bastion (test pins it under 1.6×).
3. **Overpulse hits were the Strobe's pink.** Its bolts are magenta but its hits used the pulse kind's pale pink spray
   and glow; it now has its own (`DIRECTED_HIT(0xf5c8ff)`, energyLooks.ts).

## Cost (heavy fight)

16 guns in a ring 700 units out, each firing every 8 frames at the middle (Bastion, Rattler, Dart, Spear, Pip,
Leviathan, Chainsaw, Hammer, Swarm, Needle, Quake, Twinlink, Eel, Spark, Hammerhead, Strobe: about 120 shells a second,
every one landing, warheads detonating), 900 frames, the first 60 dropped, camera on the middle at zoom 0.6, 1280×800,
headless Chrome on the real GPU. "Render + GPU" is every `renderer.render` call a frame with the main pass waited on by a
1-pixel `readPixels`, as scripts/profile/clientProfile.mjs's GPU probe does. Three runs each.

| | idle (no fight) | render + GPU, median | render + GPU, mean | p95 | WeaponFx.update (JS) | DamageFx.update (JS) |
|---|---|---|---|---|---|---|
| before | 1.85 ms | 3.6 / 4.2 / 3.6 ms | 4.2 / 6.3 / 3.9 ms | 7.1 / 12.7 / 5.8 ms | 0.28-0.35 ms | 0.06-0.08 ms |
| after | 1.85-1.92 ms | 2.5 / 2.5 / 2.5 ms | 3.0 / 3.1 / 2.8 ms | 5.3 / 5.0 / 4.7 ms | 0.27-0.30 ms | 0.07 ms |

The fight's own render cost over idle fell from about 2 ms to about 0.6 ms: almost all of it was overdraw from the
warhead discs and the big launch flashes. WeaponFx's JS is a third of a millisecond either way (peak about 600 sparks,
155 fragments, 700 smoke puffs, the smoke cap). The frame interval itself is headless Chrome's ~28 Hz pacing in both
(35.8 ms idle and fighting), so it says nothing here. One more after-run was taken while other work loaded the machine
(idle render itself 8.8 ms) and is left out.

## Per weapon

Tiers from models.json `infra.tier`. "Reach" is the hit's typical reach in world units (impact-audit).

### Kinetic (amber shells, cyan rails)
| gun | tier | good | weak / inconsistent |
|---|---|---|---|
| Pip | simple | the reference: short amber tracer, crisp rebound flick (66 reach, 0.24 s) | flash 15 units: barely there at zoom 0.6, fine at 1 |
| Rattler | simple | accent tracers read as a stream; small quick hits | dim rounds (0.4) all but vanish zoomed out, yellow on the brown nebula; flash was 5 (now 9) |
| Stinger | simple | thin white needles, tight spray | very thin (0.66 core): a grey hairline zoomed out |
| Chainsaw | dual | heat ramp orange to white, brass | hits identical in size to the simple guns (by design: 5 damage a round) |
| Twinlink | dual | paired tracers, brass, embers | pair reads as one dull line below zoom 0.4 |
| Hammer | dual | fat orange slug, dust ring, fireball and chips | none found |
| Slurry Cannon | dual | sticky embers that cling | looks like a plain cannon in flight (no look of its own) |
| Longbarrel | heavy | long gold streak and contrail, sniper hit | flash 51, smaller than Hammer's 56 for 10× the damage (girth 0.55 by design: a thin sniper flash) |
| Bastion | heavy | the heaviest kinetic hit: three-streak fan, fragments, shake | none found; flash 75 → 66 with the knee |
| Needle | simple | cyan streak, coil rings | none found |
| Coilgun | dual | five fanned streaks | none found |
| Rail Driver | heavy | snappy cyan, a strong hit | flash 24 is small for a heavy gun (girth 0.9, life 5) |
| Spear | heavy | lingering violet line, pass-through rings | violet is the energy family's colour (Lance, Tesla, Phase): reads as an energy weapon, not a rail |
| Burst / Cloudmaker (flak) | simple / dual | the airburst cloud (DamageFx) | shell mark was a flat disc (now BURST_MARK) |

### Ordnance
| gun | good | weak / inconsistent |
|---|---|---|
| Dart, Swarm | smoke trails, Swarm's weave | shell marks were flat discs over the fireball (fixed) |
| Hammerhead | blinking nose, white trail, guide line | flash 115 and mark 222 reach over a 150 blast (fixed: 67, small mark) |
| Eel | sonar ring quickening as it closes | mark 170 over a 90 blast (fixed) |
| Leviathan | beacon, incoming warning | flash 200 and mark 476 over a 160 blast, 209 sparks (fixed: 96, small mark, capped) |
| Lobber, Quake | swelling arc, landing rings, Quake's shake | flat landing disc over the burst (fixed); every ordnance detonation is the same orange missile fireball, scaled only by radius (DamageFx default branch): a Quake reads like a big Dart |

### Energy
| gun | good | weak / inconsistent |
|---|---|---|
| Glint (pulse beam) | ramp, flare, droplets (PulseFx) | none found |
| Strobe | hot pink bolts | none found |
| Overpulse | ribbon with ripple heads | hits were Strobe pink (fixed) |
| Spark | jagged bolt, splash along the normal | none found |
| Tesla, Cutter, Searchlight | held burns throw impacts every few frames; Cutter's pool | the Lance's and MiningBeamFx's short sparks don't ride their target (left from the particle-smear stage) |
| Hush, Blackout (EMP) | crackling orb, Blackout's radius ring, the dome on detonation | orb mark was a flat disc (now BURST_MARK, pale blue embers) |

### Legendaries
| gun | good | weak / inconsistent |
|---|---|---|
| Hive | weaving seekers, honeycomb | flat mark (now BURST_MARK) |
| Cinder Bloom | ember slug, cinder spray | flat mark with 38 uncapped sparks (now layered, capped) |
| Prism | rainbow shards, split flash | none found |
| Phase | afterimages, ripple through hulls | flash 88: the largest after the launchers, close to Bastion's for a fifth of the damage |
| Singularity | pull ring and motes, collapse | flat mark (now BURST_MARK) |

### Shared
- **Shield hits** (DamageFx `shieldHit`): the ripple is the same for every gun (only the Strobe and Overpulse have their
  own), so a Rattler round and a Leviathan ripple a shield alike.
- **Readability zoomed out**: below zoom ~0.3 the light guns' tracers are sub-pixel. Widening thin lines to a pixel on
  screen was tried and measured: no visible change (the glow layer's look there is set by the bloom), so it was left
  out. What does hurt is dim colour on the nebula (Rattler's dim rounds, Twinlink's pair).
- **Colour vs damage type** holds: kinetic amber/yellow, rails cyan, energy pink/magenta/blue/violet, explosives orange.
  The exceptions are the Spear (violet) and the boss kinds (their own palettes, by design).
- **Cost**: the remaining WeaponFx cost is small. Sparks and smoke are removed with `splice` (order kept), cheap at
  these counts (~600 alive).

## Left for Kieran

- Spear in violet: keep it (a capital rail that looks different), or move it to a hot cyan-white like the other rails?
- Every ordnance detonation is the same fireball scaled by radius: give mortars a dust-and-shock look and torpedoes a
  heavier, slower one (DamageFx, by kind)?
- Shield ripples scaled by the hit's damage?
- Phase Cannon's flash (88) and Rail Driver's (24): set by hand, not by tier; both could come into line.
- Rattler's dim rounds at 0.4: brighter (0.6) so the stream reads zoomed out?
