# Lockstep alignment audit (2026-11-04)

Every networked mechanic, checked against the model we agreed:

- the server sets the pace and has the final say;
- the client runs a tick layer that matches the server bit for bit, built from inputs, decision inputs and the shared rules in common;
- a cheap hash goes up, and a correction comes down only when something disagrees;
- server-only brains send small decision inputs;
- rare things stay as plain server messages.

The audit covers five areas: flight and physics, weapons and combat, AI and bosses, economy and world, and replication infrastructure. Each area was surveyed from the code, the design docs and the phase 2-3 probes. The probes ran at caps 15, packed and coalesced, and give bytes per second per pilot. The flight survey also ran its own probe, which hooks `Replication.why` to record why each ship left its replicated path (scratchpad `flightaudit/kfwhy.ts`).

Three pieces of work are **in progress** in another workflow. This report builds on them and does not repeat them:

- **The deterministic-maths sweep** (detTrig through orbit.ts, polygon.ts, generation.ts, podDrift, Mobs, SimLod and others).
- **Boss decision inputs** (the brains, impulses and moves).
- **Own-ship detect-then-correct** (the own replica under CAPS.OWN_SHOTS and the own-row corrections).

Items that overlap these are marked *in progress*. All code references are to the working tree at e933c13, which is changing while this report is written. Re-check line numbers before building anything.

## 1. Summary

**Already aligned.** Most of the high-rate path now fits the model:

- Ship flight for every ship: control rows go only on change, are stepped by the shared `replicaStep`, and a server shadow sends keyframes only on divergence.
- Boost, strafer dodges, gyro brown-out and hazard flight.
- Straight shells, through fire events plus client-found hits, with the 1-byte hit chain on inputs, Part E levels and zero disagreements in every probe.
- Ignite, debris split, drift and knocks.
- Loot pod drift, the far ships on the map, and the awareness set with enter snapshots and `out` records.
- The packed codec and coalescing.

At idle a pilot receives about 150 B/s of payload, and most of that is first-sight keyframes and control rows for ships moving in view, which is what the model expects.

**What is left, by measured cost (packed, B/s per pilot):**

| Scenario | Total | Biggest blocks still sent as results |
|---|---|---|
| Boss fight (Scrap Mother) | 1,980 | mob rows 705, keyframes 425, shipSync 171, boss shell rows 155, controls 128, bossTelegraph 62 |
| Debris-heavy fight | 2,286 | part loss + shipSync 775 (shipSync about 600), keyframes 571, splash shipHps/damage about 120 |
| Pirates fight | 567 | AI control rows 328 |
| Gale (splash/chain) | about 400 | shipHps 104 (chain, burns, splash) |
| Mining (not probed, estimate) | about 1,000-2,000 | pod pull rows 0.6-0.9 KB/s, items/gained/profile spam about 0.5-1 KB/s raw |
| Upstream (not probed, estimate) | 1.5-4.6 KB/s with headers | one WebSocket message per input; the 1 Hz JSON stateHash (about 118 B/s) |

**Root causes.** Nearly every remaining keyframe comes from a short list of things the replica does not model:

- pinned bodies;
- brain impulses and dashes;
- the boss's magnet pull;
- ship-ship contacts;
- the centre-of-mass shift after a rebuild;
- tows.

The flight probe attributes 233 of 246 divergences in the pirates fight, and 465 + 84 in the boss fight, to these causes. The remaining shipSync and HP traffic waits on one keystone: **exact shields**, then derived splash, burns and rebuilds. The two biggest single blocks are **mob rows** (boss fight) and **AI control rows** (pirates). Both are decision-input jobs, and they need seeded RNG and fixed id-order tie-breaks first.

**Cheap economy fixes** are worth doing at once and do not touch the simulation:

- profile resent every second while mining (about 265 B/s);
- the full `quests` view (3.9 KB) resent on every counted event;
- `items` resent on every credit change;
- message types missing from CAN_WAIT, so each one forces its own frame (66 B of headers each).

## 2. Bring in line

Effort: S is under a day, M is a few days, L is a week or more. Savings are per pilot unless stated. Figures marked "est" are read from code, not measured. Groups are ordered by the value they unlock against the effort, best first. Within a group, the best value for the effort comes first.

### Group A: no dependency, small and self-contained

| Mechanic | Today | Change | Effort | Savings | Dependencies |
|---|---|---|---|---|---|
| Pinned bodies (fixed bosses Redtooth Hold and Hollow Crown, range dummies, siege wards) | `stepPilotless` snaps Position back to the pin and zeroes Velocity; the replica doesn't know, so the shadow diverges almost every tick (about 9-10 keyframes/s per body) | Add a `CTL.pinned` bit (16384 is free) or `ReplicaMode.Pinned`; `replicaStep` restores x,y from the keyframe and zeroes vx,vy; set it in bridge/pilotless.ts | S | 200-330 B/s near a fixed boss; also cuts server shadow churn | protocol bump |
| Boss nova ring | `bossCharge`, then 8-16 projectile rows (about 23 B each) | Roll a0 when the charge starts and send it with the fire tick in `bossCharge`; the client spawns the ring and the server sends no rows for it | S | 180-370 B per nova, down to about 2 B | coordinate with boss decision inputs (*in progress*) |
| Boss state: invulnerable, taken(), stage cover, rage | Not sent; client hits use defaults, so those hits are told | A 1-byte boss-state decision on change; ship bosses.json `stageCover` to the client | S | Correctness: boss hits go from told to derived | *in progress* (boss decision inputs) |
| Per-ship damage multipliers (`damageMul`: elite and pack damage, ward scale, wing bonus) and the Searchlight mark | Folded into Projectile.damage; corrected by record D extras or shipHps | A per-ship multiplier byte on the status row on change; mark ticks-left; `deriveShellHit` reads them | S | Removes D extras and the told records they force | none |
| Wing bonus near-count (Party) | Server-only; shows up as D overrides; `party` resends positions and hull the client already has | Near-count (2 bits) on the status row and own row on change; leave x, y and hull out of `party` for members in shipView | S | Correctness, plus 100-300 B/s of `party` resends in a shared fight (est) | none |
| PvP hits | Every pilot-vs-pilot hit is told (inPvpZone reads station orbits) | A 1-bit "in PvP zone" on the status row and own row on change; drop `pvp` from HitLedger.unfindable | S | All PvP shell hits become client-found | none |
| Hits on the client's own ship | Always told (`self`): boss 50 per 20 s | Allow `target === conn.playerId` when the shield is 0 (or absent) and the own replica wasn't keyframed in the window | S | About 15-20 B/s in boss and pirate fights | own replica (*in progress*, own-ship detect-then-correct) |
| Station turret hits (`stationFire`) | stationFire is the cause, but the hit also goes as damage/shipHps | Ship `rules.stationDefence`; move `partFacing` to common; the client applies the hit and splash; hpCheck confirms | S | Up to 100-200 B/s during raids (est) | station position: *in progress* (orbit sweep) |
| Warmth in the own row | Every 1% of warmth change counts as a flight change, so the whole own row goes urgent | Key `flight` on `warmthStage(...)` in SnapshotBuilder.selfRowState; the percent rides the non-urgent status key | S | Up to one 54-175 B urgent row per percent while cold | none |
| playerState | Overwrites the predicted hp and boostFuel with untimed values (a flicker bug; Game.ts reads boostFuel for boost) | Shrink to xp (and credits until `items` is derived); stop the client writing hp and fuel from it | S | 2-16 B/s, plus the bug fixed | none |
| First-sight status rows | Carry x, y and angle, duplicating the keyframe in the same snapshot | Drop the pose from first-sight rows when a keyframe for that id is in the snapshot | S | About 12 B per first sight | none |
| partDestroyed | 22 B legacy with fn, x, y, vx, vy and size, which the client can derive | Shrink to the cause (slot, part, how: 2 bits) | S | About 15-18 B per part lost (debris fights about 100 B/s) | none |
| asteroidSpawn | 222 B keyed, per respawn or outlier stage | Send `{id, index, stage?}`; the client rebuilds from `asteroidParamsAt` and the parent rock | S | About 215 B per respawn (rare) | the f32 rule in group F |
| Fire-event shells expiring by age | Listed in `removed` | Leave them out; the client expires them at the same tick | S | A few B/s | none |

### Group B: forces the replica must model (the shadow runs `replicaStep` too)

Every cause in this group must go into `replicaStep` and the server shadow (Replication.endTick), not just the client. Otherwise keyframes keep firing even though the client already has the right state.

| Mechanic | Today | Change | Effort | Savings | Dependencies |
|---|---|---|---|---|---|
| Boss/AI drive impulses (`PilotOrders.impulse`) | Added in pilotless.ts:88 after `replicaCtl` records only bits and aim, so the shadow always diverges. Boss keyframes 425 B/s; 146 of 216 boss hits told | Quantise the impulse on the server (angle plus a DRIVE-table index, about 2 B), carry it on the control row or as a stamped-ahead decision, and apply it in `replicaStep` before `stepShipPhysics` | M | Most of 425 B/s; boss hits become findable (about 15-20 B/s of records and shipHps); fewer own rows | *in progress* (boss decision inputs owns this; replication side as described) |
| Boss dashes and charges | The telegraph is sent, then a keyframe after the dash | Extend the dash/charge telegraph with fire tick, world angle (q13) and speed (1 B); a one-shot impulse in `replicaStep` | M | About 33 B per dash plus the told hits around it | the impulse item |
| Boss magnet pull (staged.ts `pull()`) | Writes pilots' Velocity mid-tick on the server only: 5.6 own corrections/s and keyframes; 143 of 273 urgent frames in the boss fight | A pull-field hazard {x, y, r, k, untilTick} applied at a fixed point in `stepFlight` (like withEmp), sent with the magnet telegraph | M | 250-300 B/s of headers and own rows; keyframes of other pilots | *in progress* (boss decision inputs); pull point needs the boss pose exact, or is sent and held |
| Rebuild centre-of-mass shift | After a part loss the server shifts Position, so every viewer gets a keyframe alongside the shipSync | Put the rebuild tick on shipSync; ShipReplicaSet applies the shift at that tick (`localToWorldDir`, detTrig); drop the `rebuild` keyframe once the client acknowledges the rebuild | M | About 1 keyframe/s in NPC fights, several a second when parts shed (part of 245-571 B/s) | none (fits fully with group D's rebuild derivation) |
| Keyframe at the divergence tick, sent as a residual | The keyframe is the real state at snapshot time; the whole window's shells go as rows and its hits as told records | Reset the shadow at the first divergent tick and stamp the keyframe there, followed by the window's control events. Then drop `keyed` gating of fire events and HitLedger `keyframed`. Encode keyframe fields as steps from the shadow body (lossless) | M | Keyframes about 33 down to 15 B (a third of 150-570 B/s); told records and rows in keyframed windows become found | gains most after the items above |
| Tow Beam | Towed debris is `touched` and keyframed every snapshot; towed wrecks and pods resent every snapshot | Carry the beam's share as a control-bit field (like CTL_SHARE); apply `towPull` at the towing phase of the replica step and before `stepDebrisWorld` | M | 440-660 B/s while towing (est), to every viewer | replica world-step order (see contacts) |
| Pull orbs / Singularity nudge | `host.nudge` changes Velocity on the server only | Apply the orb's pull in the tick layer in `projectileSystem` order, from the orb's parked position | M | One keyframe per affected ship per snapshot while an orb pulls (rare) | end-at-aim reach in fire events (group E) |
| Ship-ship contacts | Push-out and impulse on the server only: 3-7 keyframes/s in fights; `contact` messages; contact damage | (1) Sort pairs by entity id. (2) Step replicas as one world per tick in server phase order. (3) Move `resolveContacts` to common; keyframe pairs where one body is outside the client's awareness set (like debris `knocks`). (4) Derive contact damage and sparks | L | 70-230 B/s in fights; the biggest win in rams with bosses | id-ordered pairs (group C); goldens move |
| Rift push-back, boss blinks, jump burn start | One keyframe each | Optional: blink as a stamped decision input; jumpScale as a 16-bit control extra at the burn tick | S | 10-20 B each (negligible) | none |

### Group C: seeded RNG and id-order tie-breaks, then the AI pilot

The first two rows cost nothing in bytes but are needed by everything else in this group. A shared mulberry32 per subsystem (`Enemies.rng`, `Bosses.rng`) makes every draw depend on every other ship's draws. Map and Set insertion order breaks ties.

| Mechanic | Today | Change | Effort | Savings | Dependencies |
|---|---|---|---|---|---|
| AI aim error, strafe flips, staged boss side flip | Drawn from the shared `this.rng` / `host.rng` | `hashUnit(eid, thinkTick, SALT)` from common rng.ts; boss side flip rolled once per think, not every tick | S | Needed for any derived pilot (otherwise about 2 B per think) | none |
| Tie-breaks and hit order | `nearestTarget` keeps the first in bodies Map order; hits apply in bitecs sparse-set order; the burns list is in ignite order; `Weapons.extras` order decides same-tick fuses; contact pairs follow `list` index | Tie-break by (distance, eid); sort same-tick hits, fuses and burns by shell id or (eid, part); contact pairs by eid | S-M | Correctness for groups B, D and E; goldens move | coordinate with the sweep |
| Enemy pilot per-tick flying (Enemies.fly) | Controls replicated as rows on every change: 328 of 567 B/s in the pirates fight | Split the commander from the pilot. The pilot goes to common as a pure function of (own body, target body, decision, tick) on detTrig, with the pack side and "outgunned" frozen into the decision at think time. The client runs it in ShipReplicaSet; Replication drops rows for AIs the client runs | L | About 300 of 328 B/s in pack fights; 8-10 B/s idle | the two rows above, commander decisions, awareness pull-in of the target |
| Enemy commander decisions | Implicit, through changed controls | A decision record on change: state (2 bits), target slot + 1, waypoint on change (about 4 B), stamped 15 ticks ahead, as a new packed field kind | M | The cost side of the item above: about 3 B per change, a few a minute per AI | split of Enemies.fly |
| Patrol waypoints | Implicit in control rows | Fixed-home packs use the farRoute `patrolPoint(seed)` (no bytes); nest, nomad and boss roams send waypoints in the decision record | S | A few B a minute per pack | commander decisions |
| AI controls stamped ahead (interim, before the split) | Rows arrive about 3 ticks late, so every client rewinds and re-steps | AI controllers commit controls for T+k at tick T and send them stamped ahead; widen engage deadbands or quantise AI aim coarser | M | No client rewinds; about a third fewer NPC control rows (est 100 B/s) | none (a stepping stone if the split is far off) |
| Traffic freighters and escort wards (autopilot) | Already detTrig; rows on change | Move `autopilotControls` plus the held heading to common; send the destination per leg | S | Small; consistency near stations | none |
| Siege turrets | Aim with Math.atan2/hypot every tick, so rows go every snapshot per turret | Target slot as a decision on change; a common turret pilot (lead aim on detTrig); `pickTarget` stays on the server | M | 200-400 B/s at night (est, not probed) | none |
| Siege hostile roles (sapper, runner, escort) | Orders through the shared pack controls; escort re-orders every second | Role orders become commander decisions; add a "follow lead slot" decision kind | M | A few hundred B/s on siege nights (est) | commander decisions |

### Group D: exact HP and shields (the keystone)

Shields feed splash, burns, EMP, Flash, part blasts and own-ship hits. Once HP is exact from every source, part loss and rebuilds become derivable, and that is where the biggest combat block left (shipSync) goes away.

| Mechanic | Today | Change | Effort | Savings | Dependencies |
|---|---|---|---|---|---|
| Shields: soak, break, regen, EMP halving | The exact value is server-only; rows carry percentages; any hit a shield touches is told (S extra) | Move regen to common (`shieldStep(ship, tick, hazardScale)`); send the exact shield in keyframes and syncs; send the hazard shield scale on change | L | The keystone: unlocks the rest of this group; shield-% rows go away for derived ships | none to start |
| Rebuild after part loss (shipSync) | A shipSync per rebuild: debris 600, boss 171, beam 116, Hammerhead 67 B/s | The client runs `rebuildShip` at the end of the tick where a part reaches zero and acks a rebuild hash on the input tail; the server holds the shipSync until the ack (copy `debrisHeld`). Repairs and refits stay server syncs. Cast hits against the pre-rebuild shape until the rebuild tick | L | About 500-600 B/s in debris fights, 100-170 in boss and beam fights; removes the `synced`/`rebuilt` told group (about 360 hits per 20 s in Hammerhead) | every HP source must reach the client before the rebuild tick; group B rebuild shift |
| Splash (flak, missiles, torpedoes, mortars, magma, hive, singularity, prism) | damage + shipHps per target, plus detonation | Move splashAt's per-body loop to common as `splashRule`; derive it at the detonation tick; keep the told path for bodies outside the client's awareness set | L | Gale about 100 B/s, debris about 120 B/s | shields; awareness pull-in by blast radius; zone bit (A) |
| Proximity fuses (flak, EMP) | Removal + detonation + results | Common `fuseRule`; process in shell-id order on both sides | M | 15-20 B per flak shell; unlocks splash | tie-breaks (C), awareness |
| Arc chains and Tesla zap hops | detonation per hop + damage + shipHps | `chainRule` in common with the (distance, eid) tie-break; derive hops from the shell hit or the zap tick | M | Gale about 60-100 B/s | shields, tie-breaks |
| Burns ticking and spreading | HP via shipHps | `burnStep` in common over a list sorted by (eid, part), derived from derived ignites, on tick % 10 | M | Part of Gale's 104 B/s | shields, ordering |
| EMP effect, frost hits | Status row flags; own row EMP ticks | Common `empRule` at the detonation | M | Small; correctness for the own prediction | shields |
| Part blasts chaining | damage + shipHps on bodies in radius | Common `blastRule`; client queues blasts from derived part deaths; credit stays on the server | M | Blast HP in debris and boss fights | shields, debris HP |
| Hits on debris | Always told (186 per 20 s in the debris probe) | Treat acked, untouched debris like a replicated ship in HitLedger and SelfHits | M | About 40 B/s in debris fights | none (debris motion already exact) |
| Debris crumble | partDestroyed `crumble` + syncs + splits | Common `decaySchedule` (seeded `hashInts(eid, spawnTick, 77)`); client crumbles acked pieces itself; tow stays told | M | Most of the debris fight's late partDestroyed and syncs (hundreds of B/s) | rebuild derivation |
| Station repair and regrow | shipHps / shipSync per interval | Common `repairStep`; a 1-byte repair-factor input only when the pilot is short of credits | M | Repair HP rows near stations (est) | station orbits (*in progress* sweep) |
| Flash Screen restore | Effect + shield % change | Add a 1-bit "paid from banks" to the effect | S | Correctness once shields are derived | shields |

### Group E: fire-event extensions (shells sent as rows today)

| Mechanic | Today | Change | Effort | Savings | Dependencies |
|---|---|---|---|---|---|
| Boss shells via `BrainHost.fire` | `Weapons.spawn` bypasses `ships.fired`, so every boss shell is a row: 155 B/s; the spread seed falls back to `e${eid}` | Push a brain-fired record {owner, tick, kind, origin relative to the body, aimQ, ids, seeker target} and send it as a fire event; seed from (owner, pattern counter, index) | M | Most of 155 B/s (about 23 down to 5 B per shell) | *in progress* (boss decision inputs) |
| Homing missiles, torpedoes, Hive, seekers | Rows resent on every course change; hits told (`curve`) | Lock id (1-2 B) and salvo index in the fire event; `homingStep` in common in Weapons.tick order | M | 50-200 B/s with missile builds (est); makes PD derivable | target must be replicated exactly (not mobs) |
| End-at-aim shells (mortars, aim bursts, Quake salvos, Prism shards) | Rows with an end tick; shards and salvo shells get server ids | Reach (aim distance, 1-2 B) in the fire event; name shards and salvo shells by (parent shell, index), or reserve ids in the event | M | About 13 B per shell plus removals | none |
| Guided shells | Rows on every course change | Cursor distance on control rows on change for ships with a guided gun; `guideStep` in common | M | Several rows a second per shell while steering | none |
| Dry ammo | Dry rounds force the old way | A dry bit in the fire event | S | About 35 B per hit while dry | none |
| Own volleys | 38-198 B/s of own fire events | Run `stepGuns` on the confirmed own replica; hash the fired-volley count into the chain; send only on mismatch | L | Up to about 200 B/s for heavy shooters | lossless own charge; own-ship detect-then-correct (*in progress*); energy determinism |

### Group F: deterministic orbits (*in progress*, the sweep) plus the f32 rule

The sweep is moving orbit.ts and generation.ts onto detTrig. One gap stays open after it. The server stores asteroid orbit parameters, size and hp, and station orbit parameters, as `Types.f32` (common/src/ecs/components.ts l.222-228), and places rocks from those stored values. The client uses the f64 values from `asteroidParamsAt`, so the two differ by about 0.002-0.015 units at 30k. **One rule is needed:** either the server keeps f64, or the client applies `Math.fround` to the same fields.

| Mechanic | Today | Change | Effort | Savings | Dependencies |
|---|---|---|---|---|---|
| f32/f64 rule for orbits | Server f32, client f64 | Store f64 on the server, or `Math.fround` on the client (rocks and stations) | S | None by itself; the prerequisite for this group | *in progress* sweep |
| Docked replicas | `ShipReplicaSet.at()` returns the station's `renderX/renderY` (ShipClient.ts:247): a render value in the tick layer | Compute the station position at the given tick from the orbit row | S | Correctness | sweep + f32 rule |
| Mining laser stop (others) | Status row resent when the beam's hit fraction changes (1-3/s per miner) | Derive the beam stop in the tick layer; route `mineBeam` and `beamAsteroid` through detTrig; drop beam fields from the row key | M | 25-75 B/s per visible miner (est) | sweep + f32 rule |
| Pod tractor pull | A pod row every snapshot while being pulled (about 300 B per chunk, est) | A decision {pod slot, collector slot, start tick} (2-3 B); move the pull to common with dhypot; drop the PickupItem effect | M | 0.6-0.9 KB/s per mining pilot to everyone near (est) | none (the collector's pose is already exact) |
| Ore chunk spawn | A pod row per chunk (2-3/s per laser) | A tick-stamped input {rock, miner slot, speed/spread byte, summary byte}; Mining.ts on detTrig | M | 50-75 B/s per laser (est) | sweep + f32; exact rock hits |
| Cargo mass after a pickup | `items` and `gained` carry no tick; observers get a `cargo` keyframe | New quantised mass (1-2 B) and the tick in the pickup or pull record | M | About 30 B per pickup per observer (about 90 B/s per mining pilot, est) | pod pull item |
| Cargo/storage (`items`/`gained`) | A full `items` (185-300 B) plus `gained` per change; neither in CAN_WAIT | Move the fit logic of `Pilots.give` to common stacks.ts; the client applies `gained`; send `items` only on a hash mismatch (the hash rides playerState). Keep the server's key order | M | About 200 B per pickup or credit change | quick win first: CAN_WAIT (section 3) |
| Field operation views | `ops` about 1-2/s because of ticking text (timer, km, %) | Send deadline ticks, the ward id and rates once; move the strings to common; the client formats them | M | 160-320 B/s while an operation runs (est) | none |

### Group G: mobs

| Mechanic | Today | Change | Effort | Savings | Dependencies |
|---|---|---|---|---|---|
| Mob flight (mites, drones, kamikaze) | A full row every snapshot within 12 km: about 700 B/s packed in the boss fight, a third of its payload | Move the Mobs step to common (the sweep is moving it onto detTrig); make `hullDistance` common; send an exact spawn record (6-8 B, ids included) and a target decision on change; keep rows only as shadow corrections | L | About 600-650 of 705 B/s in boss fights | *in progress* (sweep, boss decision inputs for launches); seeded target rule |
| Mob hits and HP | Old way (projectileHit/damage) | Extend CAPS.HITS records to mob targets; derive bursts and fizzles | M | Mob hit traffic | mob flight above |

### Group H: own ship and upstream (*in progress*, own-ship detect-then-correct)

These are listed so the other workflow can pick them up, not to duplicate it.

| Mechanic | Today | Change | Effort | Savings | Dependencies |
|---|---|---|---|---|---|
| stateHash | JSON once a second (52 B plus 66 B of headers, about 118 B/s up); mixes hp and boostFuel into the flight hash | 1-2 B on the binary input tail, hashing the confirmed own replica at its tick; hash hp and fuel separately | S | About 100-118 B/s up, down to 0-3 B/s | *in progress* |
| Own-row safety copy (`SELF_SAFETY_TICKS` 120) | The whole own row every 2 s | Remove it for hash-sending clients (`conn.hashSeen`) | S | 15-27 B/s per idle pilot | stateHash item |
| Own-row motion fields | Sent on every own row even when the own replica already has them exactly | For OWN_SHOTS clients, omit motion and reconcile from the own replica at the acked tick | M | 10-30 B/s cruising, 100-250 B/s in boss fights (est) | *in progress* |
| Own control-row aim | The pilot gets its own aim echoed back: +116 B/s pirates, +84 boss | Send bits plus an "aim as input seq N" flag; full q only for late inputs | M | 80-110 B/s in AI-heavy fights | *in progress* |
| Own-row energy, shield and gun fields | Corrections, because energy isn't bit-exact | A 1-byte own-state hash; fields only on mismatch | L | Most of a Heron's about 95 B row | energy determinism |
| Input batching upstream | One WebSocket message per input, up to 60/s | A per-tick outbox every 2-3 ticks (raise the lead to match) with bit-packed deltas, carrying the hashes and acks in the same message. Measure upstream first | M | 60-75% of 1.5-4.6 KB/s up (est) | add an input stream to the phase23 probe |

### Boss move-level items (*in progress*, boss decision inputs)

These are listed for completeness. They belong to the boss workflow:

- **Move choice.** A move-start decision: loop index, seed/tick, target, fighters count. The move bodies then run on the client from `tickRng(bossEid, moveStartTick)`. This takes about 70 B/s of telegraphs, beams and charges and most result messages.
- **Strikes from circle telegraphs.** Add a damage code; the client lands the strike and the detonation. About 30 B/s plus damage.
- **Boss beam damage from `bossBeam`.** Add a damage byte; needs an exact boss pose.
- **Scorch vents.** Small saving.

## 3. Keep server-side

| Mechanic | Why it is cheap |
|---|---|
| Docking, undocking, respawn, gates, rifts, travel | A few per session; fees, licences and placement are server logic |
| Event-horizon crush, boss intro, defeat, kill credit, loot, bounty | Once per death or fight; must stay authoritative |
| Hazard wear and EM storm | About 1 Hz, 10-20 B/s per exposed pilot |
| Pack spawns, nests, events, arenas, lair respawns | Awareness entry is the model's snapshot-on-enter; minutes apart |
| Boss phases and blinks | A handful per fight; a blink needs a keyframe anyway |
| Siege state, shop, objectives, wave planning | On change; 400-900 B a few times a night |
| Market, shops, vendors, refining, fabrication, gem cuts | UI rate; market saturation is shared server state |
| Trade, chat, map pings, party invites, pilotInfo | Human rate; consent and item conservation are checked on the server |
| People and dialogue | Human rate; lines must stay hidden (lore reveals) |
| Ore and gem picks, mining XP, rare traces | Hidden contents; shared per-rock RNG consumed in miner order |
| Enemy and boss loot drops, salvage, death pods | Hidden contents; one pod row each, then derived drift |
| Repair kits, Repair Beam, ammo crates | Low rate; economy and party rules |
| Mark and slow status bits, gun firing for others (fire events) | Already decision inputs of a few bits or bytes |
| Hangar edits, saves, hangar state | Rare; licences and costs are enforced on the server |
| mapDots, playerState xp, ping/pong, netCaps, systemInfo, asteroidSeed, welcome | Once per join/system or about 1 Hz |
| Rows for shells flying in from outside the awareness set | The model's snapshot-on-enter for a shell |
| Admin and dev tools | Admins or the dev server only |

**Cheap trims inside the server-side path** (S effort, no simulation change, do first):

- `Pilots.addXp` sends the profile only on a level change: about 265 B/s per mining pilot and 265 B per kill.
- `addCredits` doesn't send `items` when only credits changed: about 200 B per kill.
- A `questProgress {id, stage, progress}` delta (6-10 B) for counted events instead of the whole 3.9 KB `quests` view. Call `sendPeople` only on a stage change.
- Add `items`, `gained`, `profile`, `quests`, `questStep`, `toast` and `systemMessage` to `CAN_WAIT` in PackedLink.ts: up to 66 B of headers per forced frame.
- Delete `levelUp` (no client handler) or handle it and drop the duplicate systemMessage.
- Optional:
  - COALESCE 6 for idle and cruising clients (wire about 600 down to 500 B/s);
  - pong in COMPACT form (about 25 B/s down);
  - the design by per-client index in shipSync (about 30 B per first sight);
  - static systemInfo shipped with the client (1-2 KB per system entry);
  - the hangar blueprint sent by design hash.

## 4. Blocked

| Item | Blocked by |
|---|---|
| Shell hits on asteroids, rock HP, rock breaks | The orbit sweep (*in progress*), plus the f32 rule; `Asteroid.hp` is f32 (needs `Math.fround` per hit on the client); damaged rocks need HP in asteroidSeed; a mined-out crumble depends on server mining RNG (send a "crumbled" flag) |
| Mining charges sticking to rock; shells against surface rocks | As above |
| Held beams (laser, lance, frostbite, Cutter, Tesla) and pulse/beam pieces | Other ships' energy (beam share byte as a decision input, or energy determinism); asteroid occlusion (the orbit sweep plus detTrig in `beamAsteroid`/`mineBeam`); beams against mobs (group G); ramp state |
| Point defence and intercepts | Its targets (homing and lobbed shells) aren't in the tick layer: group E first |
| Hits on mobs | Mobs not simulated on the client: group G first |
| Boss stage blow-away and death | Rebuild derivation (group D); death booms on the shared rng (needs tickRng) |
| Brood Mother | Not built yet; build it on the decision-input pattern from the start |
| Contacts with rocks or stations | Not simulated at all today; if added, put them in the shared step after the orbit sweep |
| Own-row energy fields and own volleys | Energy step not bit-exact (energy area) |

## 5. Nondeterminism found

These are concrete hazards. Each is fine while only its outcome is sent. Each must be fixed before the client derives the mechanic. Items marked (S) may already be fixed by the sweep.

**On the tick path today (fix now):**

- `common/src/terrain.ts` `circleOut` (l.99, l.107): `Math.hypot` inside `stepShipPhysics` on planet surfaces. Chrome and Node can disagree in the last bit, which shows up as rubber-banding on surfaces. Use `dhypot` and add a surface ship to scripts/det/scenario.ts. (S: hand to the sweep.)
- `client/src/ships/ShipClient.ts:247` `stationAt` returns `renderX/renderY` into `ShipReplicaSet.at()` for docked replicas: a visual feeds the tick layer and ignores the tick.
- The client's `ShipReplicaSet` uses one `env()` for every ship, but the server uses `host.env(eid)` per ship. They are equal today; any per-ship environment (terrain) would diverge without any warning.
- Asteroid and station orbit parameters are f32 on the server (components.ts l.222-228) but f64 on the client.
- `Asteroid.hp` and `Radius.value` are f32; `Projectile.damage` is f32 with f32 pierce. Every new derived damage path must reproduce the server's f32/f64 mix.

**Ordering:**

- `server/src/ships/bridge/flight.ts` `resolveContacts`: pair order follows the bodies Map insertion order, not the entity id.
- `server/src/ships/bridge/weapons.ts` `nearestTarget` keeps the first of equal distances in spawn order.
- Collision-system hit order follows the bitecs sparse-set order (it changes with removals). The burns list follows ignite order. `Weapons.extras` Map order decides same-tick fuses.
- Enemies.ts: the pack centroid sums over the `pack.members` Set in insertion order. The formation slot is `[...pack.members].indexOf(eid)`, and the lead is the first member. Wards are a Set, `run.info` is a Map (turret ties), and `host.players` breaks nearest-player ties.
- LootPods.tick: the collector loop takes ties in `this.clients` Map order (`d >= best`).
- Pilots.give fills the hold in Bag key order; Postgres jsonb reorders keys.

**Shared RNG streams:**

- `Enemies.rng` (mulberry32 0x5eed): spawns, nests, waypoints, aimErr, strafe flips, loot.
- `Bosses.rng` (0xb055): spawn angles, novas, blinks, roams, loot and every brain's `host.rng()`, including the per-tick side flip in staged.ts and pyreclast.ts l.220.
- Mining: per-rock `rand(r)`, shared across miners in call order.
- Boss shell spread seed falls back to `e${eid}` (a recycled server entity id).

**Math.random:**

- Sieges.ts l.106, 287, 376-377, 396
- sieges/plan.ts l.21, 38, 77, 83, 93, 97, 103-108
- Arenas.ts l.80
- LootPods `scatter`
- StationServices.ts l.387 (gem cuts)

**Native Math trig on paths that would move to the client:**

- Enemies.fly (about 49 calls), `stationDefence` and `stationShot` (Math.hypot)
- brains/staged.ts (27), scrapMother.ts (14), pyreclast.ts (56), and kit.ts `partMount` and `bodyFrame` (*in progress*, boss workflow)
- Mobs.tick and spawn (S)
- the GameServer arm turret controller; sieges/turrets.ts aim
- GameServer `mineBeam`, `beamAsteroid` and the `hurtAsteroid` normal; Mining.extract chunk throw; `nearRepairSite`
- LootPods.tick pull and near (Math.hypot, twice)
- Party.tick wing range (Math.hypot, with its own tick phase)
- features/tow/Towing.ts l.40, 105-106
- features/support/repairBeam.ts l.13
- the GameServer rift push-back (l.3177)
- Roaming.ts `placesOfInterest` and `looseWaypoint`
- SimLod.ts l.148, 162, 397, 415, 430-453
- common/src/asteroid/orbit.ts (`calcOrbitStateRaw`, `solveKepler*`) and generation.ts (`Math.pow`, `stationarySpot`) (S)

**Wall clock:**

- `GameServer.cometNow` (`this.clock()`)
- the market cycle (`MARKET_CYCLE_MS`)
- courier, operation and job timers through `host.now`

**State changed outside the step:**

- `PilotOrders.impulse` added after `replicaCtl` is recorded (pilotless.ts:88)
- `StagedBrain.pull` (staged.ts:295) writing pilots' Velocity mid-tick
- `Weapons` pull through `host.nudge` (Weapons.ts:240, GameServer.ts l.727)
- the rebuild centre-of-mass shift (rebuild.ts l.385-391)
- the unannounced Position/Velocity writes in `teleport` and Towing

**Precision at spawn:**

- Loot pods are stepped on the server from full precision while the client starts from the rounded anchor; spawns and re-anchors should round to wire precision.
- Mob rows round to 0.1 and 0.001, so mobs can't be stepped from rows.

## 6. Suggested order of work

Each phase ends at a checkpoint:

- `npm run bench:net` and the phase23 probe, compared with the figures in section 1;
- `det:engines` green;
- zero disagreements in the confirmed-hits probe.

**Phase 0: housekeeping (S, no simulation change).**
- The economy trims and CAN_WAIT additions (section 3).
- The playerState fix.
- Warmth keyed on its stage.
- partDestroyed shrunk to its cause.
- First-sight status rows without the pose.
- A compact asteroidSpawn.
- Probes for mining, a siege night, a raid and upstream input, added to netAuditPhase.ts.

*Checkpoint:* mining measured; no change in fight numbers; profile, quests and items rates down.

**Phase 1: cheap keyframe and told-hit removals (S).**
- The `CTL.pinned` bit.
- PvP zone bit.
- Per-ship damage multiplier byte.
- Wing near-count.
- Own-ship hits findable.
- Station turret hits derived.
- The `circleOut` dhypot fix and the docked `stationAt` fix (with the sweep).

*Checkpoint:* the home-spawn probe shows almost no pinned divergences; HitLedger told reasons `pvp` and `D` are rare.

**Phase 2: seeded RNG and ordering (S-M).**
- `hashUnit`/`tickRng` for aimErr, strafe and side flips.
- Tie-breaks by (distance, eid).
- Hits, fuses and burns in id order.
- Contact pairs by eid.

Re-baseline the goldens once, together with the sweep's.

*Checkpoint:* goldens moved once; behaviour tests (enemies, tactics, bosses) green.

**Phase 3: the replica world step (M-L).** This builds on boss decision inputs, which carry the impulse, dash and pull.
- Step replicas as one world in server phase order.
- Add the rebuild centre-of-mass shift.
- Add the tow share and pull.
- Then contacts in common.
- Then keyframes stamped at the divergence tick and sent as residuals.

*Checkpoint:* the flight probe's divergence list is down to first sight, mode changes and out-of-awareness knocks; boss fight keyframes under 100 B/s.

**Phase 4: fire-event extensions (M).**
- Boss shells as brain-fired records (with the boss workflow).
- Homing lock.
- End-at-aim reach and shard ids.
- Guided cursor distance.
- The dry bit.

*Checkpoint:* boss shell rows and `curve` told hits near zero.

**Phase 5: the AI pilot (L).**
- The commander/pilot split.
- Decision records stamped ahead.
- Waypoints from farRoute seeds.
- Then siege turrets, siege roles and the traffic autopilot.

*Checkpoint:* pirates-fight control rows from 328 down to about 30 B/s; siege-night probe.

**Phase 6: exact HP (L).**
- Shields in common.
- Then splash, fuses, chains, burns, EMP and blasts.
- Then rebuild derivation with an ack and hold.
- Then debris hits and crumble, and station repair.

*Checkpoint:* debris-fight shipSync from about 600 down to under 100 B/s; Gale shipHps under 30 B/s.

**Phase 7: mobs (L).**
- An exact spawn record.
- A target decision.
- The common step.
- Mob hit records.

*Checkpoint:* boss-fight entity rows from 705 down to under 100 B/s.

**Phase 8: the world after the orbit sweep (M-L).**
- The f32 rule.
- Rock hits and rock HP in the seed.
- Mining beam stop.
- Pod pull and chunk spawns as decision inputs.
- Cargo mass on its tick.
- `items` derived with a hash.
- Operation views.

*Checkpoint:* the mining probe at under a third of its phase 0 figure.

**Alongside all phases** (the own-ship workflow, *in progress*):
- stateHash onto the input tail;
- no safety rows;
- own-row motion and own aim derived;
- input batching once upstream is measured;
- later, energy-dependent fields once energy is deterministic.
