# Boss bullet hell: what it costs (31 October 2026)

Measured, not guessed: the server's tick, the network and the client's frame through the densest projectile phases in
the game, against the ordinary busy fight in `profile-2026-10-31.md`. Nothing in the game was changed. New tools:
`server/src/bench/bulletHellBench.ts` and `scripts/profile/bossBulletHell.mjs`.

**Headline.** The bullet hell is cheap everywhere, and the fight around it costs more than the patterns do.

- **The worst pattern in the game** is the Pyreclast's enraged third stage: **131 boss shots alive at once** (great
  orbs, radius 65), 13 spawned a second. The Scrap Mother's is next with 109. Every data-driven boss nova is at most 36.
- **Server:** that phase costs **0.11 ms a tick with 1 pilot and 0.20 ms with 8** (p99 0.48 / 0.66 ms) of a 16.7 ms
  budget. With 8 pilots firing as well it is 0.58 to 0.62 ms (p99 1.5 to 1.65). The ordinary busy fight measures
  **0.92 ms (p99 3.0)** today. The pilots' own shells (about 250 a second with 8 pilots) cost far more than the boss's.
- **Network:** the boss's shots cost **1.2 to 1.8 KiB/s per pilot** (about 33 bytes a shot, sent once; seekers more
  often). With 8 pilots firing, each pilot gets about **30 KiB/s**. Most of that is hit messages for everyone's shells
  (`detonation`, `damage`, `projectileHit`: about 16 KiB/s), not projectile rows (8 KiB/s).
- **Client:** 60 fps throughout. Main thread **1.45 ms/frame** in stage 3 (about 110 shots on screen at the peak) against
  1.99 in stage 1. WeaponFx and particles are **0.12 ms/frame**. 40 draws a frame. The GPU cost was within run-to-run
  noise on this card (about 0.3 to 0.7 ms over a cleared scene at 900p and at 1080p DPR 2).
- **No optimisation is needed now.** The ranked list in §6 is about headroom: more pilots, denser future patterns,
  weak laptops. The cheapest real win is in hit messages, not projectiles.

## 1. Method

**Machine and caveats.** As in the profile doc: Ryzen 7 9800X3D, RTX 5070 Ti, Windows 11, headless Chrome (the render
daemon's, idle priority, ANGLE/D3D11) at 1440×900 DPR 1. Two other agents were running at the same time: a client
frame-time optimiser and a sun/sky shader prototyper that renders natively on the same GPU. **GPU numbers are noisy
for that reason.** One GPU probe read 4.07 ms; rerun 15 minutes later it read 2.08, and switching the effects layer off
made no difference beyond the noise. The working tree includes the other agent's uncommitted client changes:
`particlePool.ts` is now a single `ParticleContainer`, and Bloom, Lighting and WeaponFx have been edited. The client
numbers here are for that tree.

**Finding the mechanics.** Every way a boss fills the screen:

| source | where | what |
|---|---|---|
| Data novas | `data/bosses.json` `phases[].nova`, `Bosses.ts stepPhases` | A ring of `count` shots of a weapon kind every `every` ticks after a `bossCharge` warning. Up to 24 shots (Prism Colossus `prism_shard`, Maw Heart `cannon`). |
| Escorts | `phases[].escorts` | Ordinary hostile ships with their own guns. Their shots go as fire events (see §4). |
| Pyreclast brain | `server/src/game/brains/pyreclast.ts` | Stage 3: `ringPulse` (4 to 5 rings × 22 `heart_spark`, life 260 ticks, so all of them are alive at once), `spiral` (4 to 5 arms every 12 ticks for 160 to 200 ticks, half of them slow, plus aimed fans of 3), `swarm` (10 to 18 homing `heart_seeker`, more per extra pilot). Stages 1 and 2: magma volleys and broadsides, `cinder_bloom` slag fans, ember-drone mobs. |
| Scrap Mother brain | `brains/scrapMother.ts` | Stage 3: `shrapnel` rings (3 to 4 × 20 `scrap_chunk`, life 280), spirals and fans of chunks, `seam_seeker` swarms, rivets, flak. Scrap-mite mobs. |
| Brood Mother | `brains/broodMother.ts` | No moves yet (`loop: [[], [], []]`): no shots. |
| Mobs | `data/mobs.json`, `Mobs.ts` | Kamikaze drones (ember drone, scrap mite): one circle each, splash on fuse. No shots. |

All boss shots go through `GameServer`'s `fire` hook → `Weapons.spawn`. Each is an ordinary ECS projectile: it moves in
`projectileSystem`, is cast every tick in `collisionSystem` (spatial-grid ray, then `ShipBridge.hitProjectile` →
`segmentHit` → `castParts`, a capsule for great orbs; mobs; terrain; asteroids), and is replicated **one row per shot**
in the snapshot. On the client, `WeaponFx` draws each shot as about five pooled particles (glow and core lines, two halo
discs, a head) plus trail smoke, and gives each one light.

**Server: `bulletHellBench.ts`.** It runs a full `GameServer` in-process: one boss at its lair, and N pilots in god mode
flying Lancers (forward cannons; the guest Sparrow carries a beam and adds no shells) at about 1,800 units, weaving and
firing at it. The boss is put into its densest phase:

- **Staged bosses** (Pyreclast, Scrap Mother, Brood Mother) are stepped to stage 3 with the dev tool's `forceShed` (92
  steps for the Pyreclast, 47 for the Scrap Mother: the same numbers work as `devBoss shed n` on the dev server). They
  are then put in their last phase, enraged, which makes the Pyreclast's rings 5 rather than 4.
- **Data bosses** are worn below every phase threshold, as `devBoss wear` does: escorts out, enraged, nova on.

The pilots' hits on the boss are scaled down to 2% (a wrapper on `ShipBridge.hurt`) so the phase holds. Each run warms up
for 5 s, then measures 40 to 60 s. The bench times each part of the tick, counts live projectiles by owner each tick
(boss, escorts and other NPCs, pilots), and decodes every byte sent to one pilot. Each snapshot is re-encoded without
its projectile rows and their removals, which gives the projectile bytes exactly. `--nofire` isolates the boss's own
share. `--survey` runs every boss with 1 pilot.

**Client: `scripts/profile/bossBulletHell.mjs`.** It is built on `clientProfile.mjs`'s harness: a tab borrowed from the
render daemon, the same in-page probe (frame parts, draw calls, CPU profile, GPU readPixels probe). It adds a per-frame
census: live WeaponFx shots, `Lighting.point`/`cone` calls, bloom sources rendered, objects in the effects container and
the stage, smoke and flash counts. The run:

1. A guest joins in god mode and teleports to the **Pyreclast's lair** (ashfall_cavern, nowhere near the Redtooth
   picket the other agent profiles).
2. `/boss boss_pyreclast`, then **stage 1** for 12 s, firing at it: an ordinary boss fight.
3. `devBoss shed 92`, then **stage 3** for 24 s, which covers its loop (crystal, ring, spiral, swarm, vent).
4. The GPU probe, with layers switched off one at a time and at 1920×1080 DPR 2.
5. Everything cleared (`/clear 9000` round the spot) and measured again as the floor.
6. Cleanup: `/clear 9000`, god and hide off, the tab returned. The daemon (I started it) was shut down after, with no
   other leases in its log.

The dev server can't enrage a staged boss without wrecking its round, so **the client saw the calm stage 3**: 4 rings and
4 arms, about 20% fewer shots than enraged (shots peaked at 120 on screen).

## 2. Per-boss peak projectiles

Survey: 1 pilot, 40 s in the worst phase. The enraged stage-3 rows are from the 60 s runs (bold). "Boss" counts shots
owned by the boss itself; "escorts" counts shots from escorts and other NPCs; "all" includes the pilot's shells.
Projectiles are only ever this dense near a boss.

| boss | phase measured | boss peak | boss mean | boss shots/s | escort peak | all peak | tick mean / p99 ms |
|---|---|---|---|---|---|---|---|
| **Pyreclast** | **stage 3, enraged** | **131** | 48 | 12.8 | 0 | 149 | 0.163 / 0.63 |
| Pyreclast | stage 3, calm | 88 | 36 | 9.4 | 0 | 118 | 0.149 / 0.56 |
| **Scrap Mother** | **stage 3, enraged** | **109** | 51 | 11.3 | 0 | 140 | 0.138 / 0.44 |
| Scrap Mother | stage 3, calm | 71 | 34 | 7.2 | 0 | 102 | 0.193 / 0.86 |
| Giant Mammoth | 47%, escorts out | 36 | 25 | 22.1 | 5 | 43 | 0.156 / 0.83 |
| Rustjaw | 33%, nova cannon ×20, raiders + gunship | 31 | 13 | 24.2 | 10 | 44 | 0.190 / 0.83 |
| Prism Colossus | 37%, nova prism_shard ×24 | 24 | 1.4 | 3.6 | 2 | 41 | 0.137 / 0.60 |
| Hollow Crown | 19%, nova cannon ×16 | 22 | 4.6 | 2.6 | 12 | 55 | 0.151 / 0.65 |
| Maw Heart | 16%, nova missile ×14 | 21 | 5.7 | 3.3 | 6 | 37 | 0.152 / 0.59 |
| Hushwing | 22%, nova emp ×10, blinks | 15 | 2.8 | 7.3 | 8 | 23 | 0.147 / 0.63 |
| Cinder Warden | 31%, nova flak ×14 | 14 | 1.0 | 2.1 | 1 | 18 | 0.128 / 0.58 |
| Giant Dredge | 47% | 13 | 7.4 | 7.2 | 0 | 26 | 0.144 / 0.76 |
| Hoarfrost | 30%, nova emp ×8 | 12 | 2.0 | 5.5 | 5 | 23 | 0.163 / 0.79 |
| Redtooth picket | 22% | 12 | 2.4 | 1.4 | 1 | 41 | 0.173 / 0.82 |
| Void Leviathan | 27%, nova emp ×10, blinks | 10 | 1.9 | 1.6 | 0 | 23 | 0.143 / 0.64 |
| Redtooth Hold, Tallyman, Ironmonger | worst phase | 8 | 1.5 to 3.9 | 1.6 to 8.7 | 5 to 11 | 28 to 46 | ≤ 0.15 / 0.73 |
| Midden, Pilgrim, Rimeback, Shroud | 47% | 0 to 7 | ≤ 3 | ≤ 20 | ≤ 2 | ≤ 16 | ≤ 0.21 / 1.25 |
| Brood Mother | stage 3 | 0 (no moves yet) | | | | 45 | 0.163 / 0.74 |

- The Mammoth, Rustjaw and Pilgrim **spawn** more shots a second than the staged bosses (20 to 24 against 13). Their
  shells are fast and short-lived, so few are alive at once. The staged bosses' great orbs are slow and live 260 to
  280 ticks, so they pile up.
- The Pyreclast's swarm grows with the pilots (10 seekers + 2 per extra pilot, capped at 18). Nothing else scales with
  the party.
- Live boss shots measured are below the patterns' paper maximum. A ring is 22 orbs and a spiral about 100, but orbs
  that strike a pilot die early.

## 3. Server: tick

### 3.1 Worst phases at 1, 4 and 8 pilots (60 s, pilots firing Lancers)

| boss (enraged stage 3 / worst phase) | pilots | tick mean | p50 | p95 | p99 | worst | live peak (boss / pilots) | mean live |
|---|---|---|---|---|---|---|---|---|
| Pyreclast | 1 | 0.163 | 0.130 | 0.33 | 0.63 | 5.3 | 149 (131 / 63) | 64 |
| Pyreclast | 4 | 0.343 | 0.287 | 0.63 | 1.02 | 6.7 | 236 (131 / 197) | 121 |
| Pyreclast | 8 | 0.580 | 0.492 | 1.03 | 1.46 | 5.5 | 375 (118 / 289) | 183 |
| Scrap Mother | 1 | 0.138 | 0.119 | 0.26 | 0.44 | 4.1 | 140 (109 / 46) | 64 |
| Scrap Mother | 4 | 0.348 | 0.280 | 0.61 | 1.02 | 15.5 | 244 (102 / 159) | 119 |
| Scrap Mother | 8 | **0.619** | 0.505 | 1.11 | **1.65** | 12.4 | 357 (93 / 295) | 188 |
| Rustjaw | 8 | 0.563 | 0.425 | 1.01 | 1.65 | 18.0 | 220 (28 / 211) | 120 |
| Maw Heart | 8 | 0.500 | 0.411 | 0.90 | 1.29 | 15.1 | 122 (19 / 116) | 73 |
| **Boss shots only** (`--nofire`): Pyreclast | 1 / 8 | 0.114 / 0.200 | | | 0.48 / 0.66 | 2.4 / 5.2 | 131 / 122 | 48 / 47 |
| Boss shots only: Scrap Mother | 1 / 8 | 0.099 / 0.184 | | | 0.38 / 0.57 | 1.0 / 5.8 | 109 / 108 | 51 / 45 |
| *Ordinary busy fight* (profileBench today: 8 pilots, Redtooth picket + 14 packs, 109 hostiles) | 8 | *0.92* | *0.77* | *1.94* | *3.01* | *10.2* | | |

The worst ticks (4 to 18 ms) are one-offs: the first ticks after a teleport, an escort spawn, a GC. They are not the
patterns. In the boss-only runs, what the 8 pilots add is their own flight and snapshots, not anything the boss's shots
do.

### 3.2 The tick by part (µs per tick, enraged stage 3, pilots firing)

| part | Pyreclast 1 | 4 | 8 | Scrap Mother 1 | 4 | 8 | Pyreclast 8, **no pilot fire** |
|---|---|---|---|---|---|---|---|
| **collisionSystem** (every shot, every tick) | 60 | 161 | **279** | 55 | 159 | **283** | 34 |
|   `hitProjectile` (ships) | 20 | 77 | 148 | 19 | 74 | 145 | 7 |
|     `segmentHit` (parts cast near a hull) | 11 | 48 | 94 | 10 | 49 | 93 | |
|   `spatialGrid.queryRay` | 9 | 18 | 28 | 10 | 20 | 32 | |
|   asteroid query | 5 | 12 | 17 | 6 | 12 | 19 | |
|   `mobs.rayHit` | 1 | 4 | 7 | 1 | 4 | 7 | |
| **sendSnapshots** (every 3rd tick) | 25 | 60 | 109 | 23 | 60 | 119 | 45 |
|   `systemRows` (one row per shot, built per snapshot) | 17 | 32 | 47 | 15 | 32 | 51 | 16 |
| ShipBridge.tick | 25 | 38 | 77 | 20 | 52 | 95 | |
|   resolveContacts | 8 | 20 | 56 | 8 | 36 | 74 | |
| weaponSystem (pilots' guns) | 7 | 18 | 33 | 5 | 20 | 38 | 0 |
| bosses (phases, novas, the brain) | 14 | 15 | 15 | 8 | 9 | 10 | |
| flushOutbox | 5 | 10 | 15 | 4 | 8 | 14 | |
| projectileSystem (move + `Weapons.tick`: homing, fuses) | 2 | 4 | 5 | 2 | 4 | 6 | |
| `splashAt` | 1.5 | | | | | | |

**Per shot:**

- **A boss orb costs about 0.6 µs a tick in collisions** (34 µs for 47 live, no pilot fire). Mostly it misses everything:
  the grid ray, the asteroid query, the cavern's terrain ray, and bitecs `hasComponent` checks. Only 0.15 µs of that is
  `hitProjectile`, because the orbs are rarely near a hull.
- **A pilot's shell costs about 1.5 µs a tick.** It flies at a 113- to 245-part boss hull, so `segmentHit` → `castParts`
  runs on most ticks (about 0.8 µs a call).
- **Snapshot rows:** about 0.3 µs per live shot per snapshot to build (`systemRows`: the row, its `rowKey` string).
  Then each pilot's per-row key compare.
- **Splash is negligible:** boss shots with splash are only seekers and magma, and they hit rarely.

At these rates, **1,000 live boss orbs would cost about 0.6 ms a tick in collisions plus about 0.3 ms per snapshot**.
The server has room for patterns about 10× denser than today's.

## 4. Network: bytes per pilot

Projectiles go one row per shot (`EntityType.Projectile`: spawn tick, spawn point, velocity, weapon, owner, size). The
client places a straight-flying shot from spawn + velocity × age (`WeaponFx.place`, `GameState`), so **a row is sent
once**, when the client first sees it. A homing seeker is re-sent whenever its rounded velocity changes, which is every
snapshot. Shots from ships the client replicates go as **fire events** instead (`snapshot.fire`, the client builds the
volley itself with `launch.ts`): escorts' and other pilots' guns. **Boss pattern shots (`host.fire` → `Weapons.spawn`)
never do.** Rows go to everyone within `SNAP_PROJECTILE_RANGE` (12,000), which is the whole arena.

| run | KiB/s per pilot | peak second | projectile rows/s | projectile KiB/s | hit messages (`detonation` + `damage` + `projectileHit`) | snapshot |
|---|---|---|---|---|---|---|
| Pyreclast, 1 pilot, boss only | 3.2 | 10.2 | 38.6 | 1.24 (33 B a row) | 0.25 | 2.8 |
| Pyreclast, 8 pilots, boss only | 8.3 | 18.0 | 53.7 | 1.77 | 0.38 | 7.8 |
| Scrap Mother, 8 pilots, boss only | 7.8 | 14.3 | 38.2 | 1.23 | 0.33 | 7.3 |
| Pyreclast, 1 pilot firing | 5.6 | 13.2 | 65 | 2.0 | 1.9 | 3.6 |
| Pyreclast, 4 pilots firing | 16.7 | 27.5 | 166 | 4.7 | **8.2** | 8.2 |
| Pyreclast, 8 pilots firing | 30.6 | 42.4 | 281 | 7.8 | **16.2** | 14.0 |
| Scrap Mother, 8 pilots firing | 30.5 | 38.7 | 275 | 8.0 | **15.8** | 14.3 |
| Rustjaw, 8 pilots firing | 37.6 | 41.6 | 268 | 7.9 | **19.1** | 14.8 |
| *Ordinary busy fight* (profileBench, 8 pilots) | *12.9* | | | | *3.1* | *7.4* |

- **The boss's own shots are 1.2 to 1.8 KiB/s per pilot.** A 22-orb ring is about 720 bytes, once. Seekers are about
  half the rows: the Pyreclast spawns 12.8 shots a second but sends 38.6 rows a second.
- **Hit messages are the biggest part of a crowded boss fight's traffic.** Each shell with extras that hits (graded
  cannons count, since `gunDef` makes them non-plain) sends:
  - a `detonation` to **the whole system** (`Weapons.detonate`, radius 40 for a shell with no splash);
  - a `damage` to everyone near;
  - a `projectileHit`.

  With 8 Lancers on one boss that's about 250 hits a second, so **16 to 19 KiB/s per pilot**. That's twice the
  projectile rows, and more than the whole ordinary fight. It's caused by pilots focusing fire on one huge hull, not by
  the pattern.
- **Projectile rows from other pilots:** with pilots firing, rows rise from 39 to 281 a second, so most of the 8-pilot
  rows are other pilots' shells that went as rows rather than fire events. By the rules in `sendSnapshots` that should
  only happen for a ship being keyframed that snapshot, or one not yet in the client's `shipView`/`repKnown`. Pilots
  who teleport and weave in a bench may hit that more often than real players. I didn't dig further. Worth a check if
  bandwidth in big parties matters.

## 5. Client: frame

### 5.1 The frame (Pyreclast, ms per frame from the in-page wrappers; 1440×900 DPR 1, 60 fps throughout)

| | stage 1 (ordinary boss fight) | **stage 3 (bullet hell, calm)** | cleared (same spot) | *profile doc "boss" scene (112 hostile ships)* |
|---|---|---|---|---|
| main-thread busy (CPU profile) | 1.99 | **1.45** | | *4.24* |
| Game.update (all frame JS but the main pass) | 0.62 | 0.58 | 0.39 | *2.80* |
|   Renderer.update | 0.20 | 0.20 | 0.05 | *0.68* |
|     WeaponFx update + draw | 0.12 | 0.15 | 0 | *0.41* |
|   Renderer.applyLighting | 0.035 | 0.039 | 0.027 | *0.06* |
| pixi main pass (CPU submit) | 0.29 | 0.35 | 0.27 | *0.71* |
| draws / frame | 37 | 40 to 43 | 30 | *82* |
| live WeaponFx shots, mean / max | 38 / 58 | 63 to 68 / 111 to 120 | 0 | |
| `Lighting.point` calls / frame (mean / max) | 140 / 191 | 146 to 151 / 227 to 250 | 64 | |
| trail smoke particles (max) | 1,070 | 1,400 | 0 | |
| effects container objects (max) | 70 | 635 | | *4,582* |
| stage objects, all / visible (max) | 232 / 153 | 837 / 710 | 734 / 645 | *5,502 / 2,104* |
| bloom sources rendered | 5 | 5 | 5 | |
| long tasks | 0 (one 267 to 283 ms frame on the boss's arrival) | 0 (worst frame 100 to 133 ms) | 0 | |

The profile doc's column is from its own session, before the frame-time agent's work, so it is context and not a
like-for-like comparison. The like-for-like comparison is stage 1 against stage 3 of the same boss in the same session.

**CPU self time by subsystem, stage 3** (ms/frame): browser native `(program)` 0.48, Pixi 0.29, game code not grouped
below 0.26, WeaponFx and particles 0.12, ships 0.10, other rendering 0.07, UI 0.06, Lighting 0.04, network and state
0.02, GC 0.015. The top game functions are `WeaponFx.draw` (0.066), `fxTextures.paint` (0.029), `ParticlePool.take`
(0.019) and `Lighting.merge` (0.013).

**Doubling the shots on screen added about 0.05 ms to the frame.** The ParticleContainer pool keeps a particle to a few
numbers written. On a laptop about 3× slower that is about 4.5 ms in all: comfortable. With 8 pilots, add their shells
(about 70 more alive near the boss): an estimated +0.1 ms.

### 5.2 GPU (the readPixels probe; the probe's own floor is about 1.4 ms)

| scene | probe ms |
|---|---|
| stage 3 (85 to 120 shots) | 2.08 (an earlier run 4.07, while the other agent's native GPU renders were running) |
| stage 3, effects layer off | 2.53 |
| stage 3, bloom off | 1.89 |
| stage 3, ships off | 3.01 |
| stage 3 again | 1.81 |
| stage 3 at 1920×1080 DPR 2 (99 shots on screen) | 2.46 |
| the same, effects off | 2.38 |
| cleared (no boss, no shots) | 1.80 |

The bullet hell's GPU share can't be separated from noise on this card: switching the effects off didn't lower the
probe. The ceiling is roughly **0.3 to 0.7 ms over the cleared scene, even at DPR 2**.

The fill to watch on a weak GPU is the orbs' halos. A `heart_spark` (size 13) draws two halo discs of about 97 and 54
units and a 65-unit head, additive, and the glow layer is drawn again into the bloom: about 120 overlapping discs at
the peak. If a weak-GPU player reports stage 3 dropping frames, that's where to look (§6, #5).

## 6. Top costs and optimisations, ranked

Expected gains are on this machine. None of this is urgent: the worst phase uses about 4% of the server's tick and
under 10% of the client's frame.

| # | What | Measured cost now | Expected gain | Effort | Trade-offs |
|---|---|---|---|---|---|
| 1 | **Cut the hit messages in focused fire.** Send no `detonation` for a shell with no splash or EMP: the client already sparks at `projectileHit`'s point, and `detonate`'s radius 40 for a plain shell is only the default. Batch `damage` per target per snapshot (sum the amounts) rather than one message a hit, and drop `projectileHit` for shells the client never had a row for. | `detonation` + `damage` + `projectileHit`: 16 to 19 KiB/s per pilot with 8 pilots on one boss, about half of all traffic | 10 to 15 KiB/s per pilot in 8-pilot boss fights (about −40%), and about a third of `flushOutbox` | S (the detonation rule) to M (damage batching: the client's damage numbers would show sums at snapshot rate) | Graded cannons lose any bespoke detonation look (check `kind` styles first). Damage numbers merge per 50 ms. |
| 2 | **Patterns as seeds, not rows.** A ring, spiral step or fan becomes one event (`{kind, at tick, origin, a0, count, gaps, speedScale}`). Shot ids come from the event id + index so `projectileHit` can name them. The client builds the shots exactly as it builds fire events (`launch.ts`), since boss orbs already fly straight. The server keeps its entities for collisions. | Boss shot rows 1.2 to 1.8 KiB/s per pilot; `systemRows` about 15 µs/tick | Boss shot bytes about −85% (a 22-orb ring: about 720 B → about 40 B); `systemRows` −10 µs/tick | M | Nothing visual. A client that joins mid-pattern needs the rows (keep rows for shots older than its join, as fire events already do). |
| 3 | **Seekers: send the target, not the velocity.** `heart_seeker` and `seam_seeker` are re-sent every snapshot because their rounded velocity changes. Send the target id and homing params once and let the client steer (it already has the target's motion), with a keyframe every second or on a big error. | Seekers are about half the boss's rows (38.6 rows/s for 12.8 shots/s) | About −0.6 KiB/s per pilot during a swarm; fewer rows to diff | M | Small visual drift before each correction. |
| 4 | **A cheaper broad phase for boss patterns on the server.** Skip the asteroid query and `mobs.rayHit` for boss shots (they're never meant to hit their own mobs; check asteroids with the designers), hoist `hasComponent(Dead)` and `lobbed` out of the per-shot loop, and in the end test a ring analytically (one expanding circle against each pilot's hull distance) instead of per orb. | About 0.6 µs per boss orb per tick (34 µs for 47 live); pilot shells against a boss hull 1.5 µs (`castParts`) | −50 to 80% of boss-orb collision cost (about 20 to 30 µs/tick today). Matters only if patterns grow 10× | S (skips) to M (analytic ring) | The analytic ring has to keep each orb's own gaps, kills and pierce rules. Only worth it with far denser patterns. |
| 5 | **Client: cull and cap per pattern.** WeaponFx draws and lights every live shot, on screen or not (no camera test in `draw` or `collectLights`). `Lighting.point` gets 150 to 250 calls a frame for 16 slots (`MAX_LIGHTS`), sorted each frame. Cull shots outside the view (padded by halo + trail) before drawing and before `point`. Give a dense pattern a few lights (one per ring cluster, or the nearest N orbs). On the Low tier, drop the outer halo disc and trail smoke for great orbs, and draw far orbs as a head only (LOD). | WeaponFx 0.12 to 0.15 ms/frame; Lighting about 0.04; GPU halo overdraw within noise here | About 0.05 to 0.1 ms/frame now; it's what keeps a weak GPU or laptop flat in stage 3, and it scales with any denser pattern | S | Off-screen orbs no longer light the hull from outside the view (barely visible). A Low-tier orb is less glowy. |

Just outside the five:

- **Arrival hitch.** Both client runs had one frame of 267 to 283 ms right after the Pyreclast spawned, and one of 100 to
  133 ms around the stage 3 transition. Neither was a long task in steady state. They're likely its hull or skeleton
  build or a first-use shader. Not bullet hell; worth a look with the profile doc's tools.
- **Splash and ignite** from boss shots are negligible today (1.5 µs/tick). Keep measuring them per the boss guide when
  a new boss adds splashy patterns.
- **`SNAP_PROJECTILE_RANGE` (12,000)** sends every arena shot to every pilot. Fine at these counts; for a 10× pattern,
  cut it to the view plus the shots' reach.

## 7. Re-running

```bash
# server (in server/): every boss at 1 pilot, then the worst ones at 1, 4, 8 pilots; --nofire for the boss's share only
npx tsx src/bench/bulletHellBench.ts --survey --seconds 40
npx tsx src/bench/bulletHellBench.ts --boss boss_pyreclast,boss_scrap_mother --pilots 1,4,8 --seconds 60 [--nofire] [--json out.json]
# client (Vite 5273 + dev game server 3000; borrows the render daemon's tab; LAYERS=1 adds the GPU layer sweep)
node scripts/profile/bossBulletHell.mjs <outDir> 92
```

The client script goes to the Pyreclast's lair (ashfall_cavern), uses `devBoss shed 92` for stage 3, and cleans up
with `/clear 9000` there. Stop the render daemon afterwards if you started it (`POST 127.0.0.1:5281/shutdown`).
