# Networking: Causes, waypoints, mob volleys, enemy pilots
(Part of [networking](../networking.md); the other parts are listed there.)

### Other ships' causes (protocol 39, `CAPS.CAUSES` 2048, common network/causes.ts)
With OWN_SIM (dev builds; `?causes=0|1`). What moved a ship besides its controls (a contact, a rebuild's recentring, a
pilot's pull: a pull field's goes only to a client that can't work it out, see Pull fields) is noted for every ship (bridge/ownCauses.ts, each with its place in the tick's order: a contact pair
shares one) and worked out on every shadow by the clients' own function (`applyOwnCauses`; net/causes/shadowCauses.ts:
`workCauses`, `settleContacts`, `causeRecords`). A shadow has two versions from one count: `version` (moves for causes
too: everyone else's keyframes) and `cver` (CAUSES clients': only when the shadow, causes and all, left the ship; a
bodied boss the same, counting down). A CAUSES client is sent a snapshot's `causes` records (`x`, index 12; packed
`causesIO`, ships named before in the section by their place there): `[ago, 0, id, dvx, dvy]` a pull, `[ago, 1, a, b,
flags, (a's state), (b's state)]` a contact once for both ships (`PAIR` flags: pins, states, OTHER_BEFORE either
side), `[ago, 2, id]` a rebuild. A side's other goes without its state when the client's replica of it, worked to that
pair (its own causes before it in the tick: ShipCauses.midOf, the own ship's OwnTick.midOf), is the pass's
(`inStep`/`bodyStep`, judged per client after the snapshot's keyframes are known). The client (client
ships/causes/ShipCauses.ts, through `ShipReplicaSet.setCauses`: pre-cause states, a rebuild's structure split) applies
each record to the ships it holds that aren't keyframed now; hits on a ship a record names are told that window
(SelfHits.onCaused, HitLedger's keyed set); fire events are built from `preAt`. What a client can't work out (a contact
with a ship whose structure it lacks, two rebuilds in a window, a rebuild between structures it doesn't have:
`rebuildOk`) is a keyframe. The own check's state byte adds a byte over every ship it holds (`replicasByte`, server
`Replication.heldByte`); off, every ship it holds is keyframed again. Split debris waits for the snapshot's causes
(the parent's pose as the server split it: ShipCauses.beforeRebuild; client ships/debris/DebrisSplits.ts, shared with
the fakes). Tests: server/src/net/causes/causes.test.ts. Measured: docs/audits/effects-2026-11-04.md.

### Scheduled waypoints (protocol 40, `CAPS.WAYPOINTS` 4096, common guidance/)
With OWN_SIM (dev builds; `?waypoints=0|1`). Homing shells (missiles, hive seekers, salvo and boss homing volleys: any
`def.homing` that isn't `guided`) and mobs fly by one shared law, on the server and on a WAYPOINTS client's tick layer
(common guidance/waypoints.ts): a waypoint is a point on the 4-unit grid and the tick the next takes over; the planner
makes the first from the target's state, checks for a swerve every 4 ticks (staggered by id; replaced past
max(64, 0.15 × the distance left)), and queues the next min(16, L/2) ticks before the current ends, spacing L 48..4
(mobs 32..4) by the ticks to the target; the steer turns toward it (a mob: points, thrusts, sideways drift 0.86).
State is on the 1/256 grid (a mob's heading 1/65536), so a SYNC carries it exactly. The server (Weapons.home, Mobs.tick)
reads the target as it is then: a pilot after its step, anything else as it ended the tick before; the client reads
`preAt` and `at(t - 1)` alike (GuideRunner.targetAt). net/guides/GuideNet.ts keeps one log of each one's records
(sources: Weapons, Mobs) and gives a WAYPOINTS client, in snapshot field `guides` (`w`, index 13; packed as the
decisions are) `[id, dt, op, ...]`: SYNC when one comes within the projectile range (12 km), then per window MODE when
it changes (derived: it held the target, or it's its own ship, at its last snapshot and now and the target isn't
keyframed in this one; else sent), WP/NEXT in sent windows, LOST and TARGET (a mob's brain's pick) always, OFF out of
range. It gets no projectile rows of a shell it runs after the first, and a mob's row only when its HP changes; a
snapshot always goes while it runs one. The client (client ships/guides/GuideRunner.ts, shared with the fakes) steps
each to the snapshot's tick (LOST/TARGET, the queue, then the planner or the sent records, the steer, the move) and
draws it from there (`draw`: the rows it would have had). Its own check's state byte adds a byte over the ones it runs
(`GuideRunner.byte`, server `GuideNet.heldSum`); off, all are SYNCed again (`GuideNet.resync`). A told hit ends one
too (`remove`). Not on it: guided shells (they follow the owner's cursor), AI ships (control rows, already exact).
Tests: common/src/guidance/waypoints.test.ts, server/src/net/guides/guides.test.ts (scene:
server/src/bench/guides/guideScene.testkit.ts). Measured: docs/audits/waypoints-2026-11-04.md.

### Mob volleys (`CAPS.LAUNCHES` 262144, with WAYPOINTS; protocol 48, no wire change)
A volley of mobs laid at once (a Rivet Sower's mines, `Mobs.launch`) is one guide row:
`LAUNCH [turn, accel, max, arm, x, y, line, n, ring, gap, ...ids]`. The fields are:
- the mobs' guide kind, as a SYNC carries it
- the pattern round a point on the guide grid: along a q13 line `gap` apart, or in a ring of radius `gap`
- the ids in spot order, as `packIds` runs

`common/src/guidance/launch.ts` has `launchSpots`, `launchArgs` and `launchOfArgs`. The server lays the mobs with the
same `launchSpots`.

`GuideNet.launchRows` offers each volley once to each client, by sequence. A volley laid between ticks is as of a tick
the client's last snapshot may already have covered. It is offered only while every one of its mobs is still there as
laid, in the client's system and in range; otherwise each mob gets a SYNC, as for any mob. The client's `GuideRunner`
makes each mob's run from the row.

### The enemy AI's pilots (`CAPS.PILOTS` 8192, with BODIES; protocol 40, no wire change)
Dev builds (`?pilots=0|1`). Enemies.ts's think is the commander (server only: state, target, waypoint, strafe side,
aim-error seed); the rest of its flight is common bodies/aiPilot.ts, run for every AI ship on the server
(server game/brains/aiPilot.ts `AiPilots`) and, from the same decisions, on a PILOTS client's tick layer (body kind 2,
`ai`, in common bodies/registry.ts). Orders go as body wants (PATROL/RETURN/ENGAGE/FLEE, whole numbers) with TARGET,
SIDE, SYNC and OFF through BodyNet, as the staged bosses' do; a running client gets no control rows of the ship. Aim
error is re-rolled every 12 + id % 7 ticks from the order's seed; a pack's side is its centroid as it ended the last
tick, summed in id order (the client reads its replicas at t - 1); the heading is held against the last tick's
quantised aim. It leads by its main gun's real round (2026-11-07, common bodies/aiLead.ts: the commander's
`aiLoadout` picks the gun with the most damage a second, its launch speed, and a homing or guided shell's acceleration
to its top speed; three whole numbers in an ENGAGE or HAUL order at places 8-10, mates from 11; an order without them
leads as if at 45 u/tick, at most 40 ticks either way). Its body is off while its target is a pilotless ship (wards, siege prey: rows). Bosses without a brain
(Rustjaw, Hushwing, the giants...) fly on it too. A body whose read (target or pack mate) was keyframed late, or a
pack mate it stopped reading this window that's gone, is keyed too (BodyNet `readersOf`, `dropped`).
Tests: server/src/net/decisions/pilots.test.ts, common/src/bodies/bodies.test.ts. Measured: docs/audits/decisions-2026-11-04.md.

