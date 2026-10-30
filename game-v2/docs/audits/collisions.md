# Collision audit: accuracy and cost

*October 2026. Scope: every way a weapon, ship or effect decides what it touched, on the server and in the client's visuals. The focus is bosses and pilotless ships.*

## Summary

Shells and beams were **already** tested against each part's real convex pieces on the server, and the client's mining and lance beams were too (`segmentHit`, `MiningBeamFx.castShips`). The "circle" Kieran saw came from these other paths:

1. **The shield ripple.** Every shell hit on a shielded ship flashed a patch on the *bounding-circle* rim, sized by the bounding radius. On a boss that patch is 400 to 1200 units across, on a circle far outside the hull. It is the clearest "it hit a circle" picture, and it is now fixed.
2. **Splash and part blasts went by part centroids.** A missile bursting on the edge of a boss's great plate did nothing when the plate's middle was further away than the blast radius. Now fixed.
3. **EMP, flak and mob fuses, and arc chains used circles.** They went by the bounding circle or the ship's centre, and on a boss the centre is up to 1400 units inside the hull. Arcs struck the boss's centre with a 30-unit splash, which usually reaches no part at all. Now fixed.
4. **Width was ignored against geometry.** A beam's width, a great orb's radius and a boss's sweeping beam (`margin`) only widened the bounding-circle test, never the part test. The laser approximated its width with three parallel lines. Now fixed with an exact capsule test.
5. **Station turrets hit a random part, even a buried core.** Their beam was drawn to the ship's centre. Now fixed.
6. **"Damage never spreads to a boss's back."** Scrap Mother's back is stage-2 hull, and no stage-1 plates cover it. By the stage rules, a hit there passes to the *nearest current-stage part*. That was measured centroid to centroid, and ties went to the lower index. **Every** hit along the back's spine went to `scrapmother_hinge_l`, the left hinge. The stage rule now measures from the impact point to each candidate's outline, so hits spread to whichever plate is actually nearest the strike. Since then (Kieran's call) a passed-on hit is **weakened**: the plate takes `stageCover` of it (0.4 by default, see below).

On cost, the narrow phase for shells and beams on bosses is **3 to 7× faster**, because each part's bounding box is tested before its convex pieces. Boss contacts are **2 to 3× cheaper**, because only the boss pieces near the other body are put into world space.

## Collision map

"Grid space" means the ship's own cell grid (`ShipBridge.worldToGrid`). A segment or point is moved into that space once, and the cached per-blueprint geometry (`blueprintGeometry`, held in a WeakMap) is used as it is. No world-space part polygons are built per hit.

### Broad phase

| What | Broad phase | File |
|---|---|---|
| Shells vs ships | Per-tick spatial hash (500-unit cells, pooled, lazily filled per system). The ship bodies are filed by bounding radius. The query is the shell's step box, padded by speed + 100. | `server/src/GameServer.ts:180` (`SpatialGrid`), `:3878` |
| Weapon, pulse and mining beams vs ships | Every body, then the segment against the bounding circle (`nearSegment`). | `ShipBridge.ts:1247`, `:1114` |
| Splash, EMP, part blasts | Every body, then the bounding circle against the radius. | `ShipBridge.ts:794`, `:816`, `:1763` |
| Ship vs ship contacts | Bodies split by system and swept along x (bounding circle + `CONTACT_MARGIN`), then piece bounding boxes. | `ShipBridge.ts:1580` |
| Shells vs mobs | Every live mob, circle vs segment. Mobs *are* circles, by design. | `server/src/game/Mobs.ts:187` |
| Shells vs asteroids | Orbit index, then circle, then asteroid polygon edges. | `GameServer.ts` collisionSystem |
| Missile lock, arc and flak targets | Every body, by centre distance (now by hull distance, see below). | `ShipBridge.ts:952` |

### Narrow phase and who takes the damage

| Weapon or effect | Before | Now | Part that takes it |
|---|---|---|---|
| Shells (cannon, railgun, pip...) | Per-part convex pieces (Cyrus–Beck), standing parts only. | The same, with each part's box tried first (`collide.ts castParts`). | The first part along the step. Stage rules (`cover`) pass it to the nearest current-stage part **from the impact point** (new), at the `stageCover` share. |
| Great orbs (radius ≥ 20, a boss's) | **The radius widened only the circle test**: a hairline against the parts. | A capsule of its radius against the convex pieces (exact). | The first part touched. |
| Laser, lance, frostbite beams | The centre line, and if that missed, two lines at ±half-width (approximate: misses slivers between them and corners). | One exact capsule test (`capsuleConvexEntry`). | The first part touched. |
| Pulse lasers | As lasers, with the tick's width. | As lasers. | The same. |
| Mining beams | Convex, thin, bounding circle tested twice. | Convex, thin, tested once. | The first part touched. |
| Boss sweeping beams (`pyreclast.ts:813`) | `segmentHit(.., width/2)`: the width only on the circle. | Capsule. | The first part touched. |
| Splash (missiles, flak, torpedoes, boss strikes, mob bursts) | Bounding circle, then **part centroid** within the radius, nearest `reach` parts. | Bounding circle, then **distance to each part's outline** (0 inside), nearest `reach` parts. Falloff goes by that distance. | The nearest `reach` parts by outline. Stage cover is measured from the blast point, and each passed-on share is weakened as shells are. |
| Part blasts (chain reactions) | Part centroid within the radius. | Outline distance. | Every intact part in reach. |
| EMP | **Bounding circle + radius**: a long ship was knocked out with no part near the burst. | Its hull (nearest standing part's outline) within the radius. | Whole ship. |
| Flak proximity fuse | Centre distance < fuse + 0.6 × bounding radius (on a boss: a burst some 800 units off the hull, or none at all, since the candidate search went by centre distance < fuse + 60). | Hull distance < fuse (`nearestTarget(.., hull)`). | Then splash. |
| Mob fuse | Centre distance − bounding radius. | Hull distance (`MobHost.hullGap`). | Then splash. |
| Arc chain (lightning) | Next target by **centre** distance. Struck its **centre** with a 30-unit splash (on a boss usually no part at all). | Next target by hull distance. Strikes the middle of the part nearest where it leapt from. | That part. |
| Incendiary (ignite) | The part with the nearest centroid to the hit point (often a neighbour). | The part the shell actually struck (else the nearest by outline). | That part, spreading as before. |
| Station turrets | **A random intact part** (cores included), with the beam drawn to the ship's centre. | The part a line from the station to the ship's centre strikes first (`partFacing`). The client draws the beam to that same point. | That part. |
| Contacts | Shrunk convex pieces in world space, SAT with bounding boxes. | Unchanged in result. A boss only transforms the pieces near the other body. | The touching parts on both sides. |
| Missile lock (no target set) | Centre nearest the aim point. | Hull nearest the aim point. | n/a |

### Client against server

| Visual | Agreement |
|---|---|
| Shell impacts | The server sends the hit point (`projectileHit`). Tracers stop and spark there. ✔ |
| Weapon and pulse beams (`MiningBeamFx.beamLine`) | Already cast against real parts. They now use the same `castParts` capsule, at the beam's (or the pulse tick's) width. ✔ |
| Shield ripple (`DamageFx.shieldHit`, `:583`) | **Was on the bounding-circle rim, boss-sized.** Now it sits at the server's hit point, rides with the ship, and is capped at 90 units. ✔ |
| Station turret beam | **Was drawn to the ship's centre.** Now drawn from the turret's muzzle to the spot the server's shot strikes: the first hull along the line from the station's centre to the ship's (`partFacing`), cast the same way on the client. ✔ (The server has no turret positions: the station layouts are the client's, `rendering/stationDesigns.ts`. So the struck spot is decided from the centre on both sides, and only the drawn line starts at the muzzle.) |
| Arcs | The server sends `from` and `to`, and `to` is now on a part. ✔ |

## Findings

| # | Where | Impact | Status |
|---|---|---|---|
| 1 | `client/src/ships/DamageFx.ts:583` (shieldHit/drawRipples) | Shell hits on any shielded ship flashed on a circle around it, sized by its radius: huge on bosses. This reads as "it hit a circle". | **Fixed** |
| 2 | `ShipBridge.ts:794` splashAt | Splash by part centroid: big boss plates struck at their edges took nothing. | **Fixed** (outline distance) |
| 3 | `ShipBridge.ts:1763` applyBlast | Chain blasts by centroid: the same problem. | **Fixed** |
| 4 | `ShipBridge.ts:816` empAt | EMP by bounding circle. | **Fixed** (hull distance) |
| 5 | `server/src/game/Weapons.ts:172` flak fuse | Circle and centre based: bursts far from big hulls, or never on a boss. | **Fixed** |
| 6 | `server/src/game/Weapons.ts:227` chain | Arcs struck ship centres, missing bosses. Targets were picked by centre distance. | **Fixed** |
| 7 | `server/src/game/Mobs.ts:161` | Mob fuse by bounding radius. | **Fixed** (`hullGap`) |
| 8 | `ShipBridge.ts:1342` segmentHit `margin` | Thickness was ignored against parts (orbs, boss beams). | **Fixed** (capsule) |
| 9 | `ShipBridge.ts:1224` fireBeam | Width approximated by three lines. | **Fixed** (one exact capsule) |
| 10 | `server/src/game/Enemies.ts:1108` stationShot | Random part, through the hull to the core. | **Fixed** |
| 11 | `ShipBridge.ts:1369` cover | Stage redirect by centroid, ties going to the lowest index. Every hit on Scrap Mother's back spine went to her left hinge. | **Fixed** (from the impact point, by outline; since weakened to the `stageCover` share) |
| 12 | `ShipBridge.ts:841` ignite | Fire went to the nearest centroid, not the struck part. | **Fixed** |
| 13 | `ShipBridge.ts:1352` castShip / `collide.ts` | Every convex piece of every part was clipped for every segment near a boss. | **Fixed** (per-part box test, ordered early-out) |
| 14 | `ShipBridge.ts:1540` worldPieces | A boss in contact put all its pieces into world space every tick, and again after every push. | **Fixed** (only pieces near the other body, for bodies of more than 40 parts) |
| 15 | `MiningBeamFx.castShips` | The client beam also stopped at ships the server's beam passes through: allies the shooter can't hurt (`canDamage`) and ships mid-jump. | **Fixed**: the client skips ships mid-jump and asks `client/src/ships/sides.ts canHurt`, the server's rules (wards and people's craft are flagged in the snapshot, `data[10]`) |
| 16 | `ShipBridge.fireBeam`, `stepMiners` | Beams looped over every body in the world (the circle test is cheap, but O(bodies) per beam per tick). | **Fixed**: they ask the tick's spatial grid (`ShipHost.shipsAlong`, a ray query that skips the cells the padded line can't reach), plus anything spawned or blinked since it was filed. 240 bodies: 31.1 → 9.1 µs a beam tick |
| 17 | `server/src/game/Mobs.ts:187` | Mobs are circles. | By design (one-shape enemies) |
| 18 | `ShipBridge.ts:952` nearestTarget (centre mode) | AI aim and turret targeting still go by centre. That is targeting, not hit detection. | By design |

## Changes

- **New `common/src/ships/collide.ts`**, shared by the server and the client:
  - `segmentBoxEntry`: slab test with an entry t, no allocation.
  - `capsuleConvexEntry`: an exact thick segment against a convex polygon. The polygon is grown by r as itself, plus an edge slab per edge, plus a corner disc per vertex. It reuses one scratch quad.
  - `pointConvexDistance` and `partDistance`: outline distance, with the box tested first.
  - `castParts`: the first part a segment or capsule meets. It tests each part's box, skips parts whose box entry is no sooner than the best hit so far, and only then runs `standing` and the pieces.
  - `nearestParts`: parts within a radius by outline distance, nearest first.
- **`server/src/ships/ShipBridge.ts`**:
  - `segmentHit` now means the bounding circle plus `castShip`, a capsule when `margin > 0`.
  - `fireBeam` and `stepMiners` use `castShip` directly; the bounding test isn't repeated.
  - `splashAt`, `applyBlast` and `empAt` use outline distance.
  - New `hullDistance`, `nearestPartPoint` and `partFacing`.
  - `nearestTarget(.., hull)`.
  - `ignite(.., struck)`.
  - `hitProjectile` returns the part.
  - `hurt` takes `vs.at` (the impact point in grid space), which `cover` uses.
  - `resolveContacts` only puts the near pieces of big bodies into world space.
- **`server/src/game/Weapons.ts`**: the flak fuse and arc chain go by hull, and ignite receives the struck part.
- **`server/src/game/Enemies.ts`**: station shots strike the facing part.
- **`server/src/game/Mobs.ts` and `server/src/GameServer.ts`**: a `hullGap` mob host hook drives the mob fuse.
- **`client/src/ships/MiningBeamFx.ts`**:
  - Beam visuals use `castParts`, at the beam's width (a pulse at its tick's width).
  - Station beams end at the hull.
- **`client/src/ships/DamageFx.ts`**: shield ripples sit at the hit point, at a capped size.

### Behaviour changes to know about

These are balance-relevant, but the accuracy calls are deliberate:

- **Splash and part blasts now hit harder on what they burst against.** Falloff is now measured from the outline, not the middle. A burst against a 1×1 cell is now up to about half a cell nearer than before, and against a boss plate up to many cells nearer. Chain reactions between neighbouring parts are a little stronger.
- **Flak against small ships.** It used to burst within fuse + 0.6 × radius of the centre; it now bursts within the fuse of the hull. This is about the same for a Sparrow, earlier for long ships, and finally works on bosses.
- **EMP no longer reaches a ship whose bounding circle, but not its hull, is in range.**
- **Beams hit with their exact width.** A part between the old three lines, or at a corner, can now be burnt where it previously wasn't.

## Benchmarks

`server/src/bench/collisionBench.ts` (new, run in `server/` with `npx tsx src/bench/collisionBench.ts --boss <design>`) sets up the following:

- One boss at the origin.
- 40 hostile ships around it.
- Times in µs per operation: shell-length (60) segments through the boss's bounding circle, 2500-long beam casts across it (thin, and 12 half-width), `splashAt` r=120 near the hull, `empAt` r=200, a pilot laser `fireBeam` over all bodies, and `resolveContacts` with one hostile against the boss's hull.
- Whole `server.step()` with about 12 shells fired per tick at the boss and the crowd, for 300 ticks.

The runs are a few seconds each, so expect ±10% noise.

| Operation (µs/op) | scrap_mother before → after | pyreclast before → after | maw_heart_titan before → after |
|---|---|---|---|
| Parts / radius | 113 / 1366 | 178 / 1135 | 245 / 666 |
| segmentHit, shell step | 6.93 → **1.07** | 12.03 → **1.68** | 5.48 → **1.85** |
| segmentHit, beam 2500 | 8.87 → **2.12** | 15.11 → **2.94** | 6.46 → **2.05** |
| segmentHit, wide beam (now exact) | 9.00 → 6.03 | 15.21 → 6.55 | 6.37 → 3.76 |
| splashAt r=120 (now exact) | 10.14 → 14.71 | 21.36 → 23.00 | 14.08 → 8.36 |
| empAt r=200 (now exact) | 1.00 → 3.25 | 0.94 → 3.80 | 1.07 → 4.67 |
| fireBeam (laser, 42 bodies) | 11.69 → 9.64 | 16.84 → 12.54 | 9.87 → 8.87 |
| resolveContacts, one boss contact | 68.9 → **31.0** | 70.0 → **21.5** | 70.6 → **35.0** |
| server.step mean (ms) | 1.436 → **0.848** | 1.817 → **0.948** | 0.917 → **0.706** |
| server.step p95 (ms) | 2.087 → 1.517 | 2.532 → 1.636 | 1.545 → 1.283 |

Notes on the table:

- Wide-beam and EMP casts do strictly more work than before, because they are exact where they used to be approximate, and they remain cheap.
- The wide beam is still faster than the old three-line approximation.
- Splash costs about the same; most of it is the `hurt` calls.
- Whole ticks with a barrage on a boss are 25 to 50% cheaper.

## Tests

- **`server/src/ships/collisions.test.ts`** (new). It runs against Scrap Mother (staged boss) and Giant Mammoth (large hostile). Every expectation comes from an **independent oracle**: points sampled every 0.5 units along the line, tested with `pointInConvex` against each standing part's pieces, and edge distances computed in the test itself. It covers:
  - Lines through the bounding circle that miss every part. They hit nothing, and a real shell flown along one does no damage. Lines that do hit report the oracle's entry point to within about 1.5 units.
  - Shells fired at the **back**. They damage exactly the part the oracle says they strike, which lies on the back half. On a staged boss, a later stage's part passes the hit to the current-stage plate nearest the impact by outline. Hits land on **both sides** of the back: the old rule put them all on one hinge.
  - The stage cover share (`the stage cover`): a beam, a shell and a splash on a later stage's part reach a current-stage plate at `STAGE_COVER` of their damage, the later part itself untouched, and a boss's own share overrides it.
  - A pilot's laser held from behind. It burns exactly the oracle's first part.
  - Splash beside a big part's corner, beyond the blast radius from the part's middle but within it from the outline. The part takes damage (the old centroid rule gave none). A point inside the bounding circle but further than the radius from every outline takes no splash and no EMP, and `hullDistance` there matches the oracle.
  - A beam's width catching a hull its centre line misses by 3 units, and not past the width.
- **`common/src/ships/collide.test.ts`** (new): exact capsule entry at a corner disc and a face, outline distance, and box entry.
- **Results:**
  - Full root suite (`npx vitest run --pool=forks --no-file-parallelism`): 99 files, 909 tests passed.
  - Client suite: 18 files, 246 tests passed.
  - `tsc --noEmit` is clean in `server/` and `client/`.

## Recommendations (not done)

1. **Make client beams skip ships the shooter can't hurt, and ships mid-jump.** Send a "beam passes" flag, or give the client the pairs `canDamage` refuses (party members, safe zones). Today a friendly crossing an ally's laser visually stops the beam while the server burns through to the target.
2. **Give beams a spatial query.** `fireBeam` and `stepMiners` walk `this.bodies` (all systems). Using `SpatialGrid.queryRay` with padding `half + max radius` would make them O(nearby). This only matters at a few hundred bodies.
3. **Add a per-blueprint part grid** (uniform cells over the parts' boxes) for the very largest designs. A ray could then walk cells (DDA) instead of trying every part's box. With box culling, the 245-part Maw Heart Titan costs about 2 µs per cast, so this isn't needed yet.
4. **Make splash cheaper.** Most of `splashAt` is `hurt`, called on up to `reach` parts per body. The geometry part is now small.
5. **Station turret origin.** The server casts from the station's centre and the client from the turret's muzzle. Sending the turret's muzzle position (it's derived from the station design) would make them agree exactly.
6. ~~**Revisit the stage redirect** with the designers.~~ **Decided (Kieran): the hit still passes on, at reduced damage.** A hit on a later stage's part goes to the nearest current-stage plate (from the impact point, by outline) at `stageCover` of its damage. The share is data: `bosses.json` `rules.stageCover` (0.4), and any boss can set its own `stageCover`; with neither, `ShipBridge.ts` `STAGE_COVER` (0.4). It's applied once, in `ShipBridge.hurt` where `cover` redirects, so shells, beams, splash, part blasts and contact damage all take it alike. Why 0.4: under half, so aiming at the stage being fought (2.5× the damage) is plainly the better play and the stage structure reads; well above nothing, so "shoot her back" still counts and a pilot who can't reach the plates (a giant's flank, a boss turning) isn't wasting the whole fight. 0.35 felt too close to "nothing" on the giants; 0.5 makes the plates barely matter.
