# Decision inputs: server brains, shared bodies (design, 2026-11-04)

Kieran (2026-11-04): "for bosses, a lot of it can be simulated. some of it can be cheaply controlled by the server;
rather than sending whole states, or giving client access to the random number generator, we can keep some logic
server side only, sent to the client at fixed intervals, basically a cheap 1 byte input that determines behaviour
that both sides can execute deterministically at the right tick."

This is the design for that, bosses first, then the regular AI. Build stages 1 and 2 are built (protocol 36,
`CAPS.BODIES` 256): section 11 says what, where it differs from this design, and what the probe measured. It builds on
docs/design/deterministic-maths.md (all simulation maths through detTrig, seeded generators in common/src/math/rng.ts),
docs/design/confirmed-hits.md parts D-G (the tick-aligned layer, client-found hits, the adaptive levels, the own ship
stepped by its client), docs/design/packed-frames.md, and the lab's commander/pilot split
(docs/design/netcode-lockstep.md 6a, "orders decided ahead"). The ranked work it belongs to is
docs/audits/lockstep-alignment-2026-11-04.md (groups B, C, E, G and the "boss move-level items").

## 1. The split

| half | runs | what it does | reads | never |
|---|---|---|---|---|
| **brain** | server only (server/src/game/brains, Bosses.ts, Enemies.ts commander) | chooses: which move next, who to fight, which way to circle, when a stage is beaten, novas' and blinks' rolls, the AI's state and waypoints | the whole world, the server's RNG streams, the damage ledger (who's been hurting it), timers | sent; the client never sees it or its RNG |
| **decision** | the wire | the brain's choice, about one byte plus a small argument, stamped for a tick a little ahead | | retracted: once sent it holds, like an input |
| **body** | both sides (common), the same code | carries the choice out tick by tick: flying, holding, dashing, telegraphs, shells, beams, strikes, pulls, launches | shared state at that tick (its replica, its target's, its structure), its decisions, the tick | `Math.random`, `host.rng()`, the server's ledgers, anything the client doesn't hold |

The server runs the body exactly once, as it runs the brain's moves today, and its results stay authoritative
(damage, kills, credit and loot never move to the client: confirmed-hits part E1's rule). The client runs the same
body on its tick-aligned layer, so what it draws (the boss's motion, its telegraphs, its shells) and what it derives
(hits on the boss, pulls on its own ship) come from the body, not from rows. A client whose body disagrees is caught
by a hash and put right (section 5).

### Rules a body keeps (checked by tests and the simMaths guard)

1. **Pure of the tick.** A body's tick is a function of: its own state, its decisions in effect, the replicas it
   reads at that tick, and the tick number. It holds no reference to server modules; it reaches the world only through
   a `BodyHost` (section 4), which each side implements.
2. **Randomness from the decision.** Rolls inside a move (Scrap Mother's slag side angle, a spiral's start, a dart's
   side, Pyreclast's broadside turn and lance swing, death booms) draw from `tickRng(seed, moveStartTick, salt)`,
   where `seed` is an 8-bit value the brain rolled from its own secret stream and sent with the move. The server's
   streams (`Bosses.rng`, `Enemies.rng`, `host.rng`) never leave it, and a client can't work out a move's rolls before
   the move's decision reaches it.
3. **Outputs on the wire's grid.** A body's controls are quantised as replicas are (aim to the 13-bit cursor grid,
   `ctlOfPower`), and its impulses to a fixed grid (1/1024 world units a tick per axis), on both sides, before they
   touch the ship. Same rule as the lab's AI pilots.
4. **Latches on the grid.** A value a move keeps across ticks (a rivet line's angle off the nose, slag spots, a
   scissor's heading, a ring's gap offset) is quantised when it's taken (angles q13, points to 1/16 unit). Then a
   body's state can be sent exactly when a client needs it (a resync, a client arriving mid-fight).
5. **Order by id.** Pilots near a boss are taken in entity-id order, and ties in "nearest" are broken by (distance,
   id): never `host.players()` order, Map or Set insertion order (audit section 5, "Ordering").
6. **Structure at the tick.** "Is this part still working" reads the structure the boss had on that tick: the client
   applies a `shipSync` at its rebuild tick (as part G does for its own ship), so a gun shot off on tick k stops firing
   from tick k + 1 on both sides.
7. **Phase order.** A body's work happens at the points in the server's tick it happens today (server/src/golden/
   tickOrder.json): phase work (novas, blinks, a phase's effects) in `bosses`, before `collisionSystem`; flying, moves,
   fire, pulls and launches in `ships`, after it. The client's tick layer keeps that order (section 4).

## 2. The decision record

### 2.1 Interval and lead

- **The grid: every 4 ticks** (15 Hz, the lab's AI think rate). A decision takes effect only on a tick that is a
  multiple of 4. Brains think on the same grid, so nothing is lost by it: a move starts at most 3 ticks later than it
  would today (boss tests' timings move by that, section 8).
- **Lead: 16 ticks** (4 slots, 267 ms) for anything the brain can see coming: its next move (decided during its rest,
  16 ticks before the rest ends), a side change, a target change, a nova or blink, an AI's order.
- **Next slot** for reactions it can't foresee: its target dead or out of reach (`CUT`), a stage beaten (`STAGE`),
  its last stage beaten (`DIE`). These take effect at the next grid tick after the brain sees them (1-4 ticks).
- **Nothing on an empty slot.** "Fixed intervals" means a fixed grid of ticks on which decisions can land, not a
  heartbeat: a slot with no change costs nothing. Frames are reliable and in order (one WebSocket), so a client that
  has a snapshot for tick T has every decision the server sent before it: silence means "carry on", exactly.

Why 16: a decision is useful to the client's *predicted* layer (its own ship drawn ahead of the server, where a
magnet's pull or a charge's knock should already show) only if it arrives before the predicted clock reaches the
decision's tick. The predicted clock runs about one-way up plus a margin ahead of the server; the decision arrives
one-way down plus up to 3 ticks of coalescing after it was sent. So the lead must cover RTT + 3 + the margin (about
2): 16 ticks covers an RTT up to about 11 ticks (180 ms). The lab measured 15 ticks as enough at 40-70 ms each way
(0.0% of AI ticks wrong on the predicted screen). For the tick-aligned layer the lead doesn't matter (2.3).

### 2.2 Format

A new packed snapshot section `d` (and a `d` field on the base-format snapshot for unpacked clients), after the fire
events. One record per decision:

| field | bits | what |
|---|---|---|
| who | the packed encoder's entity slot (about 6-9; base format: the id) | the boss or AI ship |
| slot | 3 | its effect tick: `floor4(snapshot tick) + 4 × (slot + 1)` (4 to 32 ticks after the snapshot's grid tick) |
| op | 4 | below |
| args | by op | below |

| op | args (bits) | used by | the body then |
|---|---|---|---|
| `MOVE` 0 | move (4: index into the boss's move table, which lists every move it has, interrupts like the charge included), seed (8) | staged bosses | starts that move at the tick (a stage-three boss darts first: body rule) |
| `CUT` 1 | none | staged bosses | drops the move under way (want cleared); the rest after it starts |
| `TARGET` 2 | target slot + 1 (the packed slot, 0 = none) | every boss and AI | flies and aims at it from the tick |
| `SIDE` 3 | way round (1) | staged bosses, AI strafe | circles the other way |
| `STATE` 4 | phase (3), fighters - 1 (4, 1-16) | every boss | rage, haste, rests, counts and damage scale follow (all derived today from `view.phase`, `view.fighters`) |
| `STAGE` 5 | stage (2), seed (8) | staged bosses | stops, holds still, can't be hurt, and blows the stage away on the schedule `blowStage` uses |
| `DIE` 6 | seed (8) | staged bosses | shudders and bursts (`die`, `burst`): the boom picks from the seed |
| `NOVA` 7 | ring angle a0 (10: 2π/1024) | phase bosses | `bossCharge` drawn at the tick, the ring fired `warnTicks` later from the body's pose (Bosses.ts stepPhases) |
| `BLINK` 8 | angle (8), distance step (6: 700 + 500 × k/63) | hushwing, void leviathan | teleports beside its target at the tick (both sides: no keyframe) |
| `PHASE` 9 | phase index (3) | phase bosses | the phase's enrage, heal share, blink and nova settings (escorts stay server-spawned ships) |
| `ORDER` 10 | state (2: patrol, engage, flee, return), strafe (1), aim error (6, signed, steps of the faction's max), outgunned (1) | AI pilots | flies that state from the tick (section 6.4) |
| `WAYPOINT` 11 | x, y on a 16-unit grid relative to its pack's home (2 × 12) | AI patrols, roaming bosses | flies there |
| `LAUNCH` 12 | count (4), first shell or mob id (varint) | later: a body's launches whose ids the client must know (6.3) | |
| 13-15 | reserved | | |

Kieran's "1 byte": op plus args is 4-16 bits (a `MOVE` is 12 bits of payload); with the address and slot a
record is 2-3.5 bytes, and records exist only when something changed.

The `MOVE` table, the move bodies and their constants live with each boss in common (section 4), registered by brain
id like `BRAIN_IDS`; adding a boss adds a module and a registry line, never a branch in Bosses.ts, ShipBridge or
GameServer. Adding the section and the op table is a wire change: `npm run wire:bump`.

### 2.3 Late decisions

- **The tick-aligned layer is never late, by construction.** The server writes a decision into a client's stream
  before the snapshot for the tick it was decided on, and its effect tick is later than that tick. The client steps
  its tick layer only when a snapshot arrives, through the snapshot's tick, so every decision in effect for those
  ticks is already in. Coalescing holds the whole frame, decisions with it, and changes nothing. The encoder checks
  it: a decision whose effect tick is at or before a snapshot tick already written for that client is a server bug,
  counted, and that boss goes to the client the old way until its next move (2.4).
- **The predicted layer can be late** (RTT above ~180 ms, a stall). The own ship's prediction misses a pull or knock
  until the decision arrives; the own tick layer (part G) has it exactly, and the prediction is put right the way it
  is today (replayed from the tick layer). Telegraphs that arrive after their tick are drawn fast-forwarded: BossFx
  already draws from "ticks left".
- **The brain changing its mind** inside the lead (target died, stage beaten): it never retracts. The body handles the
  common cases itself (a move whose target is gone does what `t < 0` does today), and the brain sends `CUT` or `STAGE`
  for the next slot.
- **A client that arrives mid-fight** (enters the system, comes into view, joins) gets a `bodySync` with its first
  keyframe of the boss (2.4).

### 2.4 Body state on demand: `bodySync`, and sitting a move out

A client needs a body's state when it first holds the boss and when its hash disagreed (section 5). `bodySync`
(COMPACT, sent once): the boss, the tick, its home, target, side, phase and fighters, stage, the move under way and
its start tick, seed and args, its rest-until, its loop place and passive timers (`nextIdle`, `turn`), its shot
counter, and the carry-overs that outlive a move (rivets due down a gun line: part, angle q13, tick, left; pools: x,
y, next, until; strikes due), all latched on the grid (rule 4), so the client takes them exactly.

The moves are generators today, and a generator's place can't be sent. Until the moves are rewritten as explicit
steps (build stage 6), a client given a `bodySync` mid-move **sits that move out**: for that client the server sends
the move the old way (its telegraphs, beams, strikes' detonations, its shells as rows, the boss's keyframes and
control rows), and the client runs the body from the next `MOVE`. A move lasts 1-4 s, so this costs little, and the
server already has every old path (legacy clients use it). The same mechanism covers STRICT (section 5.3).

## 3. What disappears from the wire, for a client that runs bodies

| today | after | why |
|---|---|---|
| boss keyframes nearly every snapshot (11.3 a second in the probe: its drive impulse isn't replicated, `PilotOrders.impulse` added after `replicaCtl`) | first sight, a `bodySync`, and what bodies still don't model (contacts until they move to common, a stage shed's recentring until rebuilds are derived) | the client steps the boss with the body's controls and impulse |
| boss control rows | none | the body makes them |
| `bossTelegraph`, `bossBeam`, `bossCharge` | none | the body draws them at their ticks |
| `bossBlow`, the blow-away and death `detonation`s | none (the shed itself stays a `shipSync` until rebuilds are derived) | `STAGE`/`DIE` and the body's schedule |
| strike `detonation`s (slag, mortar walls, claws, synapse, intake grinding) | none; the damage still goes as today (`damage`/`shipHps`) until splash is derived (audit group D) | the body lands them |
| boss shells as projectile rows (`Weapons.spawn` bypasses `ships.fired`) | straight shells: nothing but their ids (2.2 `LAUNCH`, or none with derived ids, 6.3); homing seekers and lobs stay rows until homing is replicated (audit group E) | the body fires them |
| own-ship `PULL` causes (`[ago, 0, dvx, dvy]` every tick a magnet pulls: 600 a minute in the probe) | none | the body works the pull out; the own tick layer applies it where the cause sat |
| `CONTACT_FLAG.STATE` on contacts with the boss (828 of 834 contacts a minute carried the boss's pose) | the contact without its state (~2 B instead of ~10) | the client's replica of the boss is the contact pass's |
| hits on the boss told because it was keyframed in the window (117 of 131 records) | found by the client (part D), once the body supplies `taken()` and `invulnerable()` | the replica is exact and the body knows its brace and iris |
| urgent frames for telegraphs (28 in 20 s) and own rows correcting the prediction after pulls and blows (145) | none for decisions (they're never urgent); far fewer own rows | the lead puts pulls in the prediction |

A legacy or STRICT client gets all of this the old way, unchanged.

## 4. Integration

### 4.1 Where the code lives (modular layout)

- `common/src/bodies/`: `kit.ts` (the `BodyHost` interface; `fly`, `keepHome`, `homeward`, `hold`, `dart`,
  `charge`, `land`, `beam`, `gather`, `ring`, `chunk`, `aimAt`, `bodyFrame`, `partMount`, the staged tables), one
  module per boss (`scrapMother.ts`, `pyreclast.ts`, later `broodMother.ts`, `nova.ts` for phase bosses), and
  `registry.ts` (`BODIES` by brain id, each with its move table). The simMaths guard already covers common/src.
- `server/src/game/brains/`: what stays the brain: picking (`pick`, `interrupt`, the loop's skips by structure), the
  side flip, the target from `Enemies.pilot`, fighters from the damage ledger, stage and death detection, the seed
  rolls. It emits decisions through `BrainHost.decide(op, args, lead)` and drives its body through the same
  `applyDecision` the client calls.
- `server/src/net/decisions/`: the outgoing queue per system (decisions are the same for every client in a system:
  encoded once), the encoder's lateness check, the body journal (5.2), `bodySync`.
- `client/src/ships/bodies/BodyRunner.ts`: runs bodies on the tick layer; hands telegraphs to BossFx, shells to
  SelfHits and WeaponFx, pulls to the own tick layer and to replicas.

### 4.2 The client's tick layer

Bodies run where SelfHits runs: when a snapshot is opened (`SelfHits.open`), over each tick of its window, once the
frame's decisions and syncs are read. Per tick, in the server's phase order:

1. pilots' replicas step (and the own ship's tick layer, part G);
2. `bosses` work: a `NOVA` charging or firing, a `BLINK`, a `PHASE`'s effects;
3. the collision step's hits (SelfHits, as now);
4. `ships` work: each body's tick: its controls and impulse, then its replica steps with them; its volleys, strikes,
   beams and launches; its pulls on pilots' replicas and on the own ship's tick layer, in the order the server's step
   had them (pulls are causes now, so they are already ordered that way).

This needs `ShipReplicaSet` to step a bodied ship with a controller (the body) instead of rows, after the pilots: the
start of the audit's "replica world step in server phase order" (phase 3), only as far as bodies need it.

### 4.3 The server: replication and the shadow

- The pilotless step records the controls the body made and the impulse it added (both on the grid), and
  `replicaStep` gets an impulse term applied before `stepShipPhysics`, as `stepPilotless` adds it. The shadow is
  stepped with them, so for every client the shadow stays on the ship's path and keyframes go only for what bodies
  don't model.
- A client with the cap gets no control rows for a bodied ship (it makes them). A legacy client gets the control rows
  with the impulse on them (a small control-row extra: angle q13 and a drive-table index, about 2 B a change) or its
  keyframes as today: the cheaper of the two is a measurement for build stage 2.
- The server's bodies already run at the right point in its tick; nothing on the server moves.

### 4.4 Caps and levels

- A new caps bit, `CAPS.BODIES` (128), on top of `OWN_SIM` (bodies pull the own ship) and `SELF_HITS` (shells off
  bodies land in the hit layer). Offered in dev builds behind `?bodies=0|1`, allowed by the dev server's `netCaps`.
- **Part E levels apply unchanged.** The body check (5.2) is one more chain feeding the client's `ConfirmLevel`: a
  `bodySync` after a disagreement is a correction (STRICT); a clean stretch steps it down. At **STRICT** the client
  runs no bodies (every move sat out: the old messages, +2 ticks as STRICT has for hits). At **ROUGH** its body check
  goes at most once a second.

## 5. Detect, then correct

### 5.1 What the client hashes

Per bodied boss it runs, per tick: a 32-bit mix of its replica's state as rounded at the tick's end (place, velocity,
heading, turn), its move and ticks into it, its shot counter, its rolls drawn and its carry-overs' count. The window's
chain is the sum over its ticks (order-free, as the hit chain); over every body the client runs, one sum.

### 5.2 Up and judged

- Up: one byte, the chain's low byte for the last snapshot's window, riding an input that goes anyway (flags2 is full:
  the input gets a tail-flags byte of its own; a protocol bump), at the level's cadence (part E).
- The server keeps its own chain per bodied boss per window (once per boss, not per client: it ran the body once) and
  sums the bosses a client runs. Judged as part D: agreeing settles; two disagreements running mean a `bodySync` and
  a keyframe of each boss it runs, and STRICT. A lying client spoils only its own view: the server never takes a
  body's result from a client.
- Also checked on the server, every snapshot, for free: the shadow of a bodied boss (a keyframe would be a body the
  server's replica step doesn't follow: counted in `Replication.why`, a test failure).

### 5.3 What a correction costs

A `bodySync` (~20-40 B) plus a keyframe (~20 B), once, then the old messages for the move under way. With the part D
probe's rate of disagreement (zero in every scenario once F3 landed) this is a safety net, not a stream.

## 6. Every boss and AI: simulable now, decision inputs, not yet

"Simulable" means: on detTrig and shared data already; runs as body once its inputs are exact. "Not yet" says what it
waits on (audit groups: B forces in the replica, D exact HP and shields, E fire-event extensions, G mobs).

### 6.1 Scrap Mother (brains/scrapMother.ts on staged.ts; the probe's fight)

| part of the fight | simulable now | decision | not yet |
|---|---|---|---|
| flying between moves (circle at range, held to home, boost, stage drive) | the maths (`fly`, `keepHome`) | `TARGET`, `SIDE` (the 0.4%-a-tick flip, now rolled once a slot by the brain) | |
| move order (loop, skipped when its part is gone) and the charge interrupt | | `MOVE` (brain picks; 4-bit move, 8-bit seed) | |
| rests, haste, rage, counts by fighters | all of it, from phase and fighters | `STATE` (phase 3 + fighters 4) | |
| barrage (wing guns clockwise, lines then rivets) | order, line angles, rivet volleys every 3 ticks | | rivet ids (6.3) |
| idle guns (stage 1) and flak (stage 2) between moves | timers (`nextIdle`, `turn`), aims | | flak's fuse burst is splash damage (D) |
| haul (magnet rings, pull, claw lines, snap) | rings, the pull field, claw geometry, snap strikes' placement | | snap damage (D: splash) |
| brood (mites) | bay mounts, counts, launch angles | `LAUNCH` (mite ids) | mite flight and hits (G) |
| intake (lane, pull, grinding) | lane, pull, grind strikes' placement | | grind damage (D) |
| slag (lobbed sludge, pools) | spots (the side angle from the move's seed), timings, pools' life | | pool and landing damage (D) |
| shrapnel rings (gaps turning) | all | | chunk ids (6.3) |
| charge (wind-up, ram, drift) | all, including the impulse | `MOVE` (charge) | the ram's contact with a pilot: contacts in common (B) |
| dart before every stage-3 move | all (side from the seed) | | |
| scissor (two welder beams crossing) | arms, sweep angles, beam geometry against rock (`rayTerrain`) | | beam damage (D: thermal on part HP) |
| seekers (greyseam spikes) | gather, launch angles, who each hunts (by id order) | | homing replication (E) |
| spiral, fans, iris rings | all; spiral start from the seed | | |
| iris and brace (`taken`: 0.4 braced, 1.5 open) | from the move and spikes left | | |
| stage blow-away and death | the schedule | `STAGE`, `DIE` (seed for the booms) | the shed's structure stays a `shipSync` until rebuilds are derived (D) |
| phases (its last: enraged) | | `STATE` | |

### 6.2 Pyreclast (brains/pyreclast.ts)

Its own copy of staged.ts's machinery (about 400 lines). Fold it onto `StagedBrain` first (no behaviour change,
modular-layout rule: one shared rule), then split as the Scrap Mother.

| part | simulable now | decision | not yet |
|---|---|---|---|
| flying, rests, haste, rage | as 6.1 | `TARGET`, `SIDE`, `STATE` | |
| barrage, passive magma swells (telegraph, then magma) | turret order, fans, swell timing | `MOVE` | magma splash damage (D) |
| brood (ember drones, from phase 1) | as 6.1 | `LAUNCH` | drones (G) |
| broadside (turns side-on, turrets fire down lines) | lines, volleys; turn way from the seed | `MOVE` | |
| mortar wall (lane of strikes, a cap; one for each other pilot) | spots (other pilots in id order, rule 5), sort, timings | `MOVE` | strike damage (D) |
| dash chain (4-5 dashes, cinder fans) | dashes, impulses, fans; side flips from the seed | `MOVE` | |
| lance sweep | geometry; swing from the seed | `MOVE` | beam damage (D) |
| synapse lock (marks ahead of you, lightning) | marks, fuse | `MOVE` | strike damage (D) |
| charge | all | `MOVE` | contacts (B), its rock stop (terrain is common) |
| vents (fire near its hull, always) and its vent window | reach, timings | | ignite and burns (D) |
| crystal beams, ring pulse, spiral | all; spiral start from the seed | `MOVE` | beam damage (D) |
| swarm (heart seekers) | launch angles from the seed, targets by id | `MOVE` | homing (E) |
| blow-away, death | schedule | `STAGE`, `DIE` | shed structure (D) |

### 6.3 Shell and mob ids

A body's shells need the ids the server gives them, for the hit chain, told records and removals. Two ways:

1. **Sent**: a `LAUNCH` record per tick a body fires (first id as a varint and a count; ids in a volley are usually
   consecutive, otherwise a run list as debris splits send them): 2-3 B a volley instead of ~12 B a shell row packed.
   No change to how the server allocates ids. Build this first.
2. **Derived**: the server gives a body's shells wire ids of their own (`(boss slot, shot counter)` in a reserved
   range), mapped to its entity ids in the snapshot and hit ledger. Zero bytes, more plumbing; later, if the bytes
   matter.

Mobs a body launches (mites, ember drones) take the same `LAUNCH`; their flight is group G (the mob step in common,
`hullDistance` common, a target rule both sides keep: the owner's target, else the nearest pilot by (distance, id)).

### 6.4 Bosses flown by the enemy AI (bosses.json without a `brain`)

Rustjaw, Hoarfrost, Hushwing, Prism Colossus, Cinder Warden, Void Leviathan, the Maw Heart, the Foundry Warden (arena),
the Tallyman and the seven giants: `Enemies.fly` flies them, `Bosses.stepPhases` adds phases.

| part | simulable now | decision | not yet |
|---|---|---|---|
| flying | the pilot half of `Enemies.fly` (6.5) | `TARGET`, `ORDER` | the AI split (6.5) |
| novas (cannon, EMP, flak, prism shards: straight; missiles: homing; singularity: a held orb with a pull) | the ring from a0, its fire tick (`warnTicks`) and spawn points | `NOVA` (a0, 10 bits); the charge start is its tick | missile rings homing (E); the singularity's pull on pilots (a pull field like the magnet's, then simulable); EMP and splash results (D) |
| blinks (Hushwing, Void Leviathan) | the teleport, from the target's pose at the tick | `BLINK` (angle 8 + distance 6) | |
| phases: enrage, heal | rage scale; heal share | `PHASE` | the healed HP until HP is derived (D): `shipHps` as today |
| escorts | | stay server-spawned ships (spawn spots and rolls are the server's) | |
| roaming (Tallyman, giants) | | `WAYPOINT` | |
| fixed (Redtooth Hold, Redtooth Picket, Hollow Crown) | | | pinned bodies keyframe ~9-10 times a second today: the `CTL.pinned` bit (audit group A) first, no decisions needed |

### 6.5 Regular AI (Enemies.ts: packs, nests, escorts, siege hostiles)

The lab's split, on the game's AI:

- **Commander (server)**: everything inside `if (now >= e.nextThink)` in `Enemies.fly`: flee and give-up, the pack's
  nerve, passive packs' anger, the hitter, the nearest pilot or ward, prey, the packmate's target, the patrol
  waypoint, the strafe flip and the aim error. It already thinks at its own cadence (12-18 ticks); its outputs become
  `ORDER` (state 2, strafe 1, aim error 6, outgunned 1), `TARGET` and `WAYPOINT`, sent only when they change, 16 ticks
  ahead, on the 4-tick grid. "Outgunned" (it reads the damage ledger) and the pack's side angle (it reads every
  member) are frozen into the order at think time, so the pilot reads only its own body and its target's.
- **Pilot (both sides)**: the rest of `Enemies.fly` (lead the target, the fighting spot, close in, back off, strafe,
  hold, fire when likely, flee, cruise in pulses), moved to common as a pure function of (its body, its target's, its
  order, tick, its blueprint's reach). The engage strafe pattern (`(now + eid × 7) % 180`) and the patrol pulse already
  are. `pack.pace` and `pauseUntil` (server rolls) go with the order.
- **What it saves**: the AI's control rows (328 of 567 B/s in the pirates fight) and the keyframes from its drive;
  the cost is a few orders a minute per ship (lab: 20-37 B/s for 8-24 bots).
- **Before it**: the audit's group C rows (seeded aim error and flips: done by this design, the brain rolls them;
  tie-breaks by (distance, id); the pack centroid summed in id order).
- **Siege turrets** (`sieges/turrets.ts`, the GameServer `arm` controller): `pickTarget` stays the brain (`TARGET`);
  the lead aim is a body. **Siege roles** (sapper, runner, escort): `ORDER`s, with a "follow lead slot" state.
  **Station defence**: turret target as `TARGET`; the shot is a fire event already. **Traffic autopilot**:
  `WAYPOINT` at each station; the autopilot itself (`setAutopilot`) is a body.

### 6.6 Brood Mother (brains/broodMother.ts: a stub, docs/bosses/brood-mother.md)

Build it on the split from the start: its moves as common body modules with explicit steps (not generators), its
brain only picking, so it is the first boss whose `bodySync` is complete (no move sat out).

### 6.7 What stays on the server for good

Kill credit, loot, bounties, the intro card and defeat (once a fight), escorts' spawning, respawn timers, the
damage ledger behind `fighters`, every damage result's authority, and SystemMemory's capture and restore. The brain
itself, and every RNG it draws from.

## 7. Bytes: the Scrap Mother fight, before and after

Probe: the session scratchpad's `net/own/netAuditOwn2.ts` with a per-entity split of the observer's base-format
snapshots added (`net/decide/netAuditDecide.ts`, copied into server/src/bench while it ran, then deleted); a
Hammerhead against the Scrap Mother, 20 s, 3 ticks each way, caps 127 (everything on), the shooter's B/s. For
reference, the same fight with everything off (caps 0) is 5,501 B/s on the wire (4,297 deflated): the "4-5 KB/s".

What the boss costs today (the shooter, packed), and where it goes:

| block | B/s today | attribution (observer's base split) | after decisions + bodies | after mobs too |
|---|---|---|---|---|
| boss keyframes | ~375 of 385 | the boss keyframed 11.3 times a second (399 B/s base), the pilot's own 3 a minute | ~40 (first sight, blow-aways, contacts until common) | ~40 |
| boss control rows | ~5 | 7.5 B/s base (it's keyframed instead) | 0 | 0 |
| `bossTelegraph` (+ beams, charges, blows) | 56 | | 0 | 0 |
| boss shells as rows | 59 | 5 rows a second | ~15 (`LAUNCH` ids, seekers as rows) | ~15 |
| strike and blow `detonation`s | 27 | | ~10 (part blasts stay) | ~10 |
| hit records, `shipHps`, `damage`, `projectileHit` | 80 | 117 of 131 records told because the boss was keyframed | ~40 | ~35 |
| own-ship causes (pulls, contacts with the boss's state) | 29 | 600 pulls and 828 stated contacts a minute | ~8 | ~8 |
| mob rows (mites) | ~620 of 837 entity rows (the rest is the pilot's own row) | 24 rows a second (606 B/s base) | ~620 | ~50 (`LAUNCH`, corrections) |
| decisions | 0 | | ~2 (about 0.4 a second: a move every ~4 s, side flips, state changes) | ~3 |
| everything else (the pilot's own row and fire events, `shipSync` 230 and `partDestroyed` 56, head, contact, toasts) | ~950 | | ~950 | ~950 |
| **payload** | **2,205** | | **~1,690** (-23%) | **~1,130** (-49%) |
| WebSocket messages a second | 14.5 (176 of 290 urgent: own rows 145, telegraphs 28) | | ~10 (telegraphs never urgent; pulls predicted, so far fewer own-row corrections) | ~10 |
| **wire** (payload + 66 B a message) | **3,162** | | **~2,350** (-26%) | **~1,790** (-43%) |

Per fight, at about three minutes: **~570 KB on the wire today** (397 KB payload), ~420 KB after decisions and bodies,
~320 KB with the mites too; the decisions themselves are ~70 records, about 0.2-0.3 KB a fight. The largest blocks
left after that are not decisions: `shipSync` and `partDestroyed` (audit group D, rebuild derivation: ~230 more), the
pilot's own fire events and row. Upstream adds the body check: at ROUGH one byte a second riding an input.

The "after" columns are estimates from the attribution above, not a measurement. Build stage 2's measurement is in
section 11.4: the flight alone took the boss's keyframes from 445 to 306 B/s close in (contacts with the pilot keep most
of them) and from 245 to 90 held off at range.

The pirates fight (no boss, regular AI, 6.5): 328 B/s of AI control rows, expected to fall to ~30 plus ~10 of
orders, about -45% of its payload.

## 8. Goldens and tests

- **Behaviour moves on purpose**: moves start on the 4-tick grid, 16 ticks after the brain decides; in-move rolls
  come from the move's seed, not the shared stream; the side flip is rolled once a slot. scrapMother.test.ts,
  pyreclast.test.ts and bosses.test.ts pin timings and outcomes: re-check each change is one of these, then update.
  frameHash moves (the boss streams); flightTraces, parity and hitRules shouldn't.
- **New tests**: a body parity test (a real server and a fake client with `CAPS.BODIES` in a Scrap Mother fight: the
  client's boss replica equals the server's ship at every tick, its telegraphs and shells equal the server's, zero
  body disagreements, no boss control rows or drive keyframes); a forced desync (a decision dropped on the client:
  caught, `bodySync`, STRICT, back down); a client arriving mid-move (sits it out, runs the next); a late-decision
  test for the encoder's check; the move table's round trip through both formats; det:engines gets a boss body
  scenario (seeded decisions, both engines bit for bit).
- The probe (section 7) at each build stage: keyframes, telegraph and shell bytes, urgent frames, disagreements.

## 9. Open questions

- **Fighters** counts pilots who hurt the boss in the last 30 s; with 4 bits it saturates at 16 (no fight comes near
  it today).
- **Stage timing**: the server's invulnerability would start at `STAGE`'s tick (up to 4 ticks after the stage's
  last deciding piece fell) instead of that tick; hits in between land on the beaten stage's cover. Both sides agree
  by construction; whether it feels different needs a play test.
- **Reading the body early**: a modified client sees a move up to 16 ticks (267 ms) before it starts. It already sees
  each telegraph's whole warning; a quarter second more of a move it can't change isn't worth hiding.
- **Legacy clients**: impulse on control rows versus keyframes as today (4.3) is decided by measurement.
- **The predicted body**: drawing the boss ahead of the tick layer (with the own ship) would need its body run ahead
  with predicted pilots; not proposed: the boss is drawn interpolated like every other ship.

## 10. Build order (next stage)

1. **The channel**: decision section and ops in common (`wire:bump`), `CAPS.BODIES`, the server's per-system queue
   and lateness check, the client's reader, `bodySync`, the body chain up and judged, wired into `ConfirmLevel`. No
   boss uses it yet; tests with a dummy body.
2. **Scrap Mother's flight as a body**: `fly`, `hold`, `dart`, `charge` and the stage drive in common;
   `TARGET`/`SIDE`/`STATE`/`MOVE`/`CUT` from her brain; the impulse term in `replicaStep`; `ShipReplicaSet` stepping
   her with the body after the pilots. Checkpoint: her keyframes ~375 -> under 50 B/s, hits on her found, contacts
   without state; the probe re-run replaces section 7's estimates.
3. **Novas, blinks and phases for the AI-flown bosses** (`NOVA`, `BLINK`, `PHASE`): small, and covers the nine nova
   bosses and both blinkers at once (a nova ring's 8-24 rows go to ~3 B).
4. **Scrap Mother's moves**: telegraphs, beams, strikes' placement and booms, straight shells with `LAUNCH` ids, the
   magnet and intake pulls (own `PULL` causes go), `taken`/`invulnerable` from the body, seeds in moves, `STAGE`/`DIE`.
   Checkpoint: no `bossTelegraph`/`bossBeam`/boss rows for a `BODIES` client; zero body disagreements.
5. **Pyreclast**: onto `StagedBrain` first (no behaviour change), then stages 2 and 4 for it.
6. **Moves as explicit steps** (no generators), so `bodySync` is complete; the Brood Mother built this way.
7. **The regular AI**: commander/pilot split of `Enemies.fly` with `ORDER`/`TARGET`/`WAYPOINT` (flies the phase
   bosses and escorts too), then siege turrets and roles, station defence, traffic.
8. **Mobs**: `LAUNCH` for mites and ember drones, the mob step in common, its target rule, mob hits (audit group G).

## 11. Built: stages 1 and 2 (2026-11-04, protocol 36)

### 11.1 What there is

- **common/src/bodies/**: `decisions.ts` (the ops, the wants, `applyDecision`, `bodiesFor`), `stagedFlight.ts` (the
  staged bosses' flight: circle at range held to home, boost, the stage drive, hold, hold facing the target, a heading
  or its lead, drive a way with a first-tick kick), `registry.ts` (`BODY_KINDS` by brain id: the Scrap Mother, and the
  Brood Mother, who borrows her flight), `hash.ts` (`bodyHash`, the check's byte).
- **The brain** (server/src/game/brains/staged.ts): `fly` is the body. Moves set `want` as a quantised record
  (`wantFly`, `wantHold`, `wantAim`, `wantFace`, `wantLead`, `wantDrive`); each tick the brain decides what changed
  (`TARGET`; `SIDE`, its 0.4% roll still the brain's; `STAGE`; `WANT`), folds it into its `BodyState` and hands it to
  `BrainHost.decide`; then `stagedFlight` makes the controls and the push (`PilotOrders.body`). No target: `OFF`, the
  enemy AI flies it; back on: a `SYNC` in the log. The flight tables moved from the brains into the registry.
- **The wire**: a snapshot's `decisions` (`d`, compact index 11, an 11-bit packed mask): `[id, dt, op, ...args]`, dt
  the decision's tick less the snapshot's (0 or less); packed by `decisionsIO` (the boss's slot, dt, a 4-bit op, args
  as signed varints): 2-3 bytes a record. The body check on inputs: 3 bytes (the hash byte, the tick's low 12 bits),
  in the base layout flag byte 5's 0x80 after the own check, in the compact one `CI_EXTRA.BODY_CHECK`.
- **Server** (server/src/net/decisions/BodyNet.ts): one decision log per boss, shared by every client; per client the
  bosses it runs. A boss it can run (body on, in view, its target itself or a ship it has) and doesn't yet: a `SYNC`
  (the whole state at the snapshot's tick) and a keyframe; one it runs: the log since its last snapshot; one it can't
  any more: `OFF`. `note`/`check` judge its checks; off, it's synced again. Replication keeps a **bodied shadow** per
  boss (stepped with the body's controls and push; its own versions, counting down from -1): a running client gets no
  control rows of the boss, and a keyframe only when that shadow leaves the ship (a contact, a shed's recentring, an
  EMP) or when it's about to get a keyframe of the boss's target (`Replication.keysFor`: what the body read of the
  target this window was off).
- **Client** (client/src/ships/bodies/BodyRunner.ts): decisions folded in at their ticks (a tick already stepped is
  stepped again), and each snapshot the bodies are re-stepped from just after the last one (what they read of other
  ships is final only then). `ShipReplicaSet.setDriver` steps a bodied replica with its body's controls and push;
  `ShipReplicaSet.preAt` gives the target as the server's boss step reads it (after its own step, before that tick's
  pulls and contacts). The check goes every 30 ticks at most, riding an input that goes anyway. Offered in dev builds
  (`?bodies=0|1`, with `ownsim`), allowed by the dev server.
- **Legacy and STRICT clients**: unchanged; the boss's control rows and keyframes go as before (the legacy shadow is
  untouched).

### 11.2 Where it differs from the design

- **No grid and no lead for flight wants.** A move's wants change inside its generator on ticks only it knows (hold
  for `warn`, then drive), so a `WANT` takes effect on the tick it's decided, written into the snapshot after it. The
  tick-aligned layer is never late (2.3 holds: the decision is in before the snapshot that covers its tick). The 4-tick
  grid and the 16-tick lead stay the plan for `MOVE` (stage 4), where the predicted layer needs the lead.
- **`SYNC` is an op**, not a `bodySync` message: the flight's whole state is 7-9 small numbers, and a sync goes with a
  keyframe in the same snapshot anyway.
- **The check is a snapshot's sum**, not a window's chain: the body's state at a snapshot's tick folds in every tick
  before it (a tick wrong leaves the state wrong), as the own check does.
- **A body is only as exact as what it reads.** A boss flying at another pilot reads that pilot's replica, which is
  off between that pilot's divergence and its keyframe; the server keyframes the boss for that client in the same
  snapshot (`targetKeyed`), so the boss is exact at every snapshot's tick, and hits in such a window are told
  (keyframed), as before.
- **Hits on a boss a client runs stay told** (`HitLedger` 'body'; the client leaves them to the records each window).
  With fewer keyframes the client would find them itself, but how much of a hit the boss takes (braced, laid open,
  between stages) is its brain's until stage 4 puts `taken` and `invulnerable` in the body. Without this the probe
  went STRICT (4 disagreements in 78 hits).
- **The own layer re-steps from the last snapshot each snapshot** (OwnTick.onSnapshot): a boss's body may ask for the
  own ship between its `shipSync` and the snapshot carrying its rebuild, which stepped it with the new structure early.

### 11.3 Tests

server/src/net/decisions/bodies.test.ts (a real server, a fake client with every cap, a legacy observer): through her
three stages (the dev shed), the client's replica of the Scrap Mother equals the server's ship at all 433 snapshot
ticks, with no control rows of her, 33 keyframes of her against the observer's 285, and 50 checks agreeing; a lost
decision is caught by the check and put right with a SYNC and a keyframe; a client arriving mid-fight is synced at once
and exact from there. common/src/bodies/bodies.test.ts: decision rows through the base and packed formats, the body
check through both input layouts, decisions folded in, the flight pure of its inputs and on its grids. The boss tests
(scrapMother, bosses, scrapNest) pass with their assertions unchanged: quantising the wants moved nothing they pin.
frameHash's streams moved (the protocol version); every world hash held.

### 11.4 Measured (the probe, 2026-11-04)

The session scratchpad's `net/bodies/netAuditBodies.ts` (section 7's probe, plus the boss on the client's tick layer
against the server's at every snapshot and every tick of each window), copied into server/src/bench while it ran and
deleted after. A Hammerhead against the Scrap Mother, 20 s, 3 ticks each way, the shooter's bytes; caps 127
(everything but bodies) against 383 (with bodies). "Close" holds 1300-1700 from her (touching her hull much of the
time); "far" holds 2300-2700.

| | close, 127 | close, 383 | far, 127 | far, 383 | pirates, 127 / 383 |
|---|---|---|---|---|---|
| payload B/s | 1,984 | 1,837 (-7%) | 1,720 | 1,542 (-10%) | 640 / 640 |
| wire B/s (payload + 66 a message) | 2,888 | 2,728 (-6%) | 2,598 | 2,400 (-8%) | 1,307 / 1,307 |
| messages a second (urgent) | 13.7 (7.5) | 13.5 (7.5) | 13.3 (6.4) | 13.0 (6.4) | 10.1 (0.3) |
| keyframes section B/s | 445 | 306 | 245 | 90 | 46 |
| control rows section B/s | 91 | 80 | 120 | 92 | 362 |
| snapshots with a keyframe of her | 359 of 400 | 194 of 384 | 235 of 395 | 55 of 379 | |
| her control rows | 38 | 0 | 106 | 10 (while OFF) | |
| decisions (B/s) | | 21 (4.0) | | 12 (2.3) | |
| her replica off at a snapshot tick | | 0 of 383 | | 0 of 335 | |
| body checks (off) | | 40 (0) | | 36 (0) | |
| hit disagreements, fixes | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 0, 0 |
| own-ship keyframes | 2 | 2 | 3 | 3 | 2 |

Her bodied shadow left her 188 times in 20 s close in and 26 times held off: contacts with the pilot's hull (close in,
the probe's pilot keeps touching her edge) and her sheds' recentring are what keyframe her now. 35 and 29 more were her
target's replica off on the client (`targetKeyed`: the observer is pulled by her magnets). The pirates fight has no
body yet (stage 7), so it's the same either way.

### 11.5 Review (2026-11-04): lifecycle fixes

A review of stages 1 and 2 for determinism, late decisions, joins, reconnects, the cap switching and legacy clients
found no maths or ordering leak (the body is detTrig only, both sides fold decisions in tick order, the hash sum is
order-free), but four lifecycle holes, now closed:

- **The cap switched off mid-session** (`capsNext`, the admin's switch): the client stopped every body, but BodyNet
  still counted it as running them, so when the cap came back no SYNC went and the boss was flown by stale controls, its
  checks never sent; its hits were also told as `body` while off. SnapshotBuilder now calls `BodyNet.drop` for a client
  without the cap: it runs none, rows come the old way, and the cap back on starts with a SYNC.
- **A boss let go** (despawned, defeated): its brain went without an OFF, so its body stayed on in BodyNet. Entity ids
  are reused, so a later ship on that id could be SYNCed and flown as her. `StagedBrain.dispose` now decides OFF, and
  an OFF whose ship is gone forgets the boss there and then (not only when a capable client's snapshot noticed).
- **A reconnect**: the client kept its runs from the old connection; a boss whose body was off on the server (nothing
  to SYNC it) went on being flown here, its rows ignored. `ShipClient.resetHits` (a new connection) now resets the
  BodyRunner too.
- **The own layer's re-step** (11.2) now runs only while bodies are on (OwnTickHost.restep): with the cap off, OwnTick
  is as it was before stage 1.

Hot path: BodyRunner no longer copies a body state every tick (a tick with no decisions shares the one before; states
are never changed once kept), no longer goes through every kept state each tick to trim them, and its rewind doesn't
copy the key list. Tests: bodies.test.ts adds the cap off and back on mid-fight (her rows while off, a SYNC and an exact
replica after) and her removal mid-fight; BodyNet.test.ts the forgotten boss (its id reused, never synced) and `drop`.

### 11.6 Left, in order

1. **Contacts and sheds**, most of her keyframes left: the client that touched her already works out its own half of a
   contact; the boss's half for that client, and a shed's recentring as the own ship's `REBUILD` cause does it. Then
   the target re-keys (a pilot's replica exact for everyone: its pulls as causes for all, not only its own client).
2. Stage 3 (novas, blinks, phases), stage 4 (her moves, with `taken`/`invulnerable` in the body, so hits on her are
   found by the client), then stages 5-8 as section 10.

## 12. Built: stage 7, the enemy AI's pilots (2026-11-04, `CAPS.PILOTS` 8192, no wire change)

- **common/src/bodies/aiPilot.ts**: the pilot half of `Enemies.fly` as a body. Orders are wants: PATROL `[0, wx, wy,
  pace, pauseUntil]`, RETURN `[1, hx, hy]`, ENGAGE `[2, range, reach, hitBy, errMax, seed, strafe, flank, ...mates]`,
  FLEE `[3]`; with TARGET and SIDE (the strafe way). Its aim error is re-rolled every 12 + id % 7 ticks from the order's
  seed (`aiAimError`, rolled once by the commander) instead of at each think; `hitBy` (the damage ledger's "its target
  shot it lately") is the commander's, a WANT when it flips; a pack's side is its centroid as it ended the last tick,
  summed in id order (mates as ids less its own; the server's `Pack.cent` is taken at the start of `Enemies.tick`, the
  client reads `at(mate, t - 1)`); its heading is held against the aim it flew with last tick (`BodyDriver.step`'s new
  `prevQ`), as `e.face` held it. `BODY_KINDS` is generic now (`reads`, `step`, `toldHits`, `pilot`).
- **Server**: `game/brains/aiPilot.ts` (`AiPilots`) decides and flies; Enemies keeps the think. Every AI ship flies by
  the body whether or not anyone runs it (one simulation); its body is ON while its target is a pilot's ship or there's
  none (pilotless targets are stepped in the server's own order among pilotless ships: rows). `Enemies.pilot` (a
  staged brain's base) flies it with no decisions. Bosses without a brain fly on it too (6.4's flight).
- **BodyNet**: a client must hold every ship a body reads; a body whose read was keyframed late (`readersOf`, an own
  keyframe from a contact) or whose dropped read is gone this window (`dropped`) is keyed too. Hits on AI ships stay
  the client's to find (`toldHits` false; `HitLedger` 'body' only for staged bosses).
- **Tests**: server/src/net/decisions/pilots.test.ts (pirate packs, Rustjaw with escorts into phase 3, Hushwing into
  its blink phase: every hostile run is the server's ship at every snapshot, no control rows, checks agreeing; a lost
  second of decisions caught; a BODIES client without PILOTS runs none). Behaviour moved on purpose: frameHash
  regenerated (world and streams).
- **Needs CAUSES (review, 2026-11-05)**: `pilotsFor` takes PILOTS only with CAUSES. Without other ships' causes a
  pilot's body reads targets that contacts keyframe mid-window, and the crowd bench's ball 50 had 12 AI ticks off
  without a keyframe (caps 511 | PILOTS). Such a client gets control rows of AI ships, as before PILOTS. The bench also
  shows the bodies' rekeys cost corrections: ball 50 with every cap 3.7 a second per probe, without PILOTS 1.0 (bytes
  1.5% up); spread 50 1.3 against 0.2 (bytes 14% up).
- **Measured**: docs/audits/decisions-2026-11-04.md. Section 11.4's gap (-7% for bodies) is closed by CAUSES: bodies
  now -25.6% payload, -18% wire on the Scrap Mother; the wire gap left is stage 4's (telegraphs and own-row urgent frames).

Left, in order: stage 4 (her moves: telegraphs, beams, strikes, LAUNCH ids, pulls, taken/invulnerable), stage 3
(NOVA/BLINK/PHASE: now the AI-flown bosses' flight is a body, these are the next bytes there), 5, 6, 8 (mob LAUNCH:
mobs already fly by the waypoint law), and stage 7's second half (siege turrets and roles, station defence, traffic).
