# Networking: Notes (moved from DEVELOPMENT.md and the old engine-map)
(Part of [networking](../networking.md); the other parts are listed there.)

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **Protocol changes (the rule)**: the wire format is pinned: `protocol.test.ts` hashes the wire tables (`COMPACT`, `SNAP_FIELDS`, the dictionary, the binary input layout) and fails until the pin is updated. Adding a model, material or piece to `data/ships` makes `wireDictionary.test.ts` fail until you run `npm run wire:sync` (appends the new ids to the append-only `common/src/network/wire-dictionary.json`; never reorder or edit it by hand). After any wire change run `npm run wire:bump "what changed"`: it rebuilds common, increments `PROTOCOL_VERSION`, writes `PROTOCOL_WIRE_HASH` and appends a line to `common/src/network/PROTOCOL_CHANGELOG.md`; it does nothing if the hash already matches, so a second run is harmless. Part ids you do not want on the wire go in the manifest's `"skip"` list (`wire:sync --skip`).
- **Design**: everything the simulation does with a ship is deterministic (the shared flight step, rounded each tick to `SHIP_PRECISION`), so clients are sent only what they cannot work out. Other ships: `replicaStep` (`common/src/ships/replica.ts`) is one tick of a ship as the server moves it when nothing interferes; `ShipBridge.replicaCtl` records the controls each body flew with (aim on the 13-bit cursor grid); `server/src/net/Replication.ts` keeps a shadow of every ship and compares after each tick: while they agree clients get only control changes (`snapshot.ctl`: `[id, ticksAgo, bits, q, ...]`); when they do not (collision, blast, EMP, out of boost, rebuild changing flight, docking) the next snapshot carries a keyframe (`snapshot.ships`). A keyframe version per ship; clients new to a ship or behind get one. Client: `ShipReplicaSet` (`common/src/network/replication.ts`) steps each ship from keyframe + controls, rewinding if a control arrives late; `ShipClient.placeReplica` places it. A keyframe that moves a ship off the path it was drawn on (a boss's drive or dash impulses, which aren't replicated, bring one most snapshots) is blended in for drawing only (`ShipReplicaSet.pose`, `fixWeight`): the old path is stepped on to the keyframe's tick, then the drawn path bends onto the keyframe by its tick (or, if it came late, eases out over 8 ticks after); 400 units or more snaps. `at` stays exact. A rewind (a body's SYNC or its runner's per-snapshot restep, a late control row, a cause) never reaches back past the keyframe: the ticks before it are the path it was drawn on, kept for the blend. Wiped, they were drawn at the keyframe, and a body-run ship keyed again (its SYNC, its target keyed) jumped ahead to it and stood there for the interpolation delay (the Helios Drones' "snap into a fixed place", 2026-11-05). A ship drawn before its first state (just come into view) is drawn coming in along its velocity from that state, at most 20 ticks back, not standing at it. `server/src/net/replication.test.ts` checks a client rebuilds every ship bit for bit. Shadows are not stepped in systems no client is in.
- **Prediction clock**: the client steps its ship once per tick number (`GameState.predictedTick`, `ticksDue`), ahead of the server's tick by the trip plus a jitter margin (`leadTicks`) so an input stamped tick + input delay arrives in time. The server tick is estimated by smoothing the offset between its tick and our clock (`getEstimatedServerTick`), not the tick itself (smoothing a value that climbs 60 a second trails it and made inputs late); it snaps when more than 20 ticks off. The ship is drawn between its last two steps, half a tick back. State hashes for ticks the server has not reached are held (`aheadHashes`).
- **The held aim angle (common sim/aimHold.ts)**: a pilot's aim goes in its control rows only when it changes what
  the ship does. Its ship still flies its raw aim every tick, on the server and on its own client; beside it the step
  works out whether the aim it was last applied at (`SimInput.heldQ`: `ShipState.aimQ` on the server, the ring's
  previous q on its client) would have done exactly the same: the flight (ships/flight.ts `stepFlight`,
  `FlightResult.aimHeld`: the same spin out of steerSpin and the torque caps, the same jump counter, no burn starting
  along the aim; at the helm the aim steers nothing) and the guns (ships/guns.ts `stepGuns`, `GunOrders.heldAim`,
  `GunStep.aimHeld`: every aimed gun's offset and readiness alike on a tick the trigger is down, held or let go, a
  semi-automatic click waits or anything fires; idle, a turret's look is drawing only), and not mining (its beams are
  drawn along the cursor state, the replica's aim). Both the same, its applied aim (`ctl.q`, what the shadow, every
  replica and gun lane fly, and what the own-state hash hashes) stays the held one; else it's the raw one. So a ship
  flown on its applied aims goes exactly where it went on its raw ones, and a row gets a new aim only when that
  changes. The server works it out across stepMovement (the flight's half: `replicaCtl` keeps `q` applied, `rawQ`,
  `heldQ`) and fireWeapons (the guns' half); its client in `stepOwnShip` (heldQ from OwnTimeline.step); everyone else
  takes the applied aim as sent. Replication's own-exception check compares the client's inputs with the raw aim.
  Tests: common sim/aimHold.test.ts (raw, rule and a copy on the applied aims alike bit for bit), server
  net/own/ownSim.test.ts. Bench line: crowdBench "pilots' aims" (`ShipBridge.stats.aimHold`).
- **Your own ship, drawn from its tick layer (sim foundation Stage 3b)**: one step a tick, the whole one. OwnTick's
  step (client ships/own/OwnTick.ts, through ShipReplicaSet's `OwnTimeline.step`) runs common sim/ownStep.ts
  `stepOwnShip` (the one stepper, guns in the step: the server's stepMovement + fireWeapons on the same cores) on its
  full state: pose from the replica ring, stores, guns, hazards and priming (`OwnExtras`) kept by tick. GameState steps
  it to the prediction's tick each tick (`ownStep` = ShipClient.ownStepTo) and draws it at `ownDrawTick` from the ring
  (`ownPose`: ShipReplicaSet.pose; an own keyframe or a re-step eases out from where it was drawn). What its guns did on
  a tick is drawn once, as the prediction reaches it (OwnTick.takeEvents -> ShipClient.presentOwn: shells, pulses,
  beams, gun sounds, the HUD's gun state); its own shells on the tick layer are built from the events as a snapshot
  confirms them (OwnTick.takeConfirmed -> OwnShells). Past the newest snapshot it finds no contact pairs (the snapshot's
  window finds them once). Its aim goes on the grid the server flies (sim/ownStep.ts `pilotAimQ`); the server's
  control rows carry only what it can't work out (held keys, aim, hazard bits: not its engines' power, Replication
  `OWN_DERIVED_BITS`). The head hash and its own check's state byte hash that full state (sim/headHash.ts
  `ownStateHash`); off, the server sends its own keyframe and an `ownSync` (the extras, exact, just before the
  snapshot: SnapshotBuilder, net/own/OwnChecks.ts rekey), also with every own row that goes as a fix (first sight, a late
  input, a new keyframe version, a hazard change). A window its ship was keyframed or ownSynced in has its own shells'
  hits told (`conn.ownWindow`, OwnShells `keyed`). Every client holding its own ship gets a snapshot at least about once
  a second for the head hash, in the HUD numbers' round (`HEAD_HASH_TICKS`). Parity: server/src/golden/parity.test.ts
  (server vs the own step, the correction), common/src/sim/a-callers.test.ts, server/src/net/own/ownSim.test.ts.
- **Other ships: the PT/ST layer (prediction C3, the default since the C3 rollout)**: every ship the client holds on
  its tick layer is predicted to your own predicted tick and drawn where your shells meet it. Code: client/src/predict/.
  - *PT*: each ship stepped once a tick, to `GameState.predictedTick`, in the layer's own StateRing, by its kind
    (predict/shipKinds.ts `PT_KINDS`, first claim wins): `ai` (BodyRunner.ahead: AI pilots, custom enemies) read off the
    replica layer stepped ahead on its decisions, never pushed in PT; `pilot` (replica mode Player) and `rows`
    (dummies, haulers, anything on control rows) on held last input (common CtlChangeInputs 'assumed', stepped with
    `ShipReplicaSet.stepAlone` = replicaStep). Then the tick's contact pass over the PT states plus your own ship as a
    fixed body (it pushes, PT never moves it): predict/contacts.ts `RealContacts`, the server's resolveContacts
    (contactPairs through a ContactPairCache, pairs in the pass's order, contactPieces/contactPair, big bodies' near
    pieces, every pushed body rounded): with the same states before it, the same states after
    (server/src/net/causes/ptContacts.test.ts: perfect inputs, a grinding pack, 0 of 2880 ship-ticks off; 2708 off
    without the pass). Each tick's pairs are found once; a re-step finds the ticks it steps again (dropFrom).
  - *ST*: the replica layer at the confirmed tick (`GameState.serverTick`). Confirmed ticks keep their own pairs,
    found once a tick by ContactWorld (CAPS.CONTACTS); PT never feeds the tick layer. ContactWorld finds no pairs past
    the newest snapshot (a ship stepped there, an AI stepped ahead for PT, is stepped again from the window at the next
    snapshot's begin): before the C3 rollout every AI stepped ahead found pairs on unfinished ticks, stepping every
    held ship there (crowd ball 100: probe tick layer 9.9 -> 2.8 ms a tick, PT 3.4 -> 0.7 ms).
  - *Check*: each time the confirmed tick C moves, every ship's `shipHash(ST(C))` against the PT(C) it recorded. A
    match costs nothing. A miss re-steps that ship once from ST(C) to the PT head; the touch register (the PT steps'
    contact events in (C, head]) adds every ship it touched, and a ship the re-stepped path newly reaches joins at that
    tick. The drawn pose eases from the old PT to the new over 150 ms (`lerpMs`); a correction of 400 units or more
    (`PT_SNAP_DIST`: a respawn, a teleport, a blink) snaps.
  - *Coming and going*: the layer's ship list is re-read on every advance and confirm (`ReplicaPtWorld.ships`: held,
    flown, with structure, not your own, not a boss whose hits are told). A ship new to it (into view or a focus cell,
    a late joiner, back from away with its keyframe, a respawn under a new id) starts from its ST at the confirmed tick
    and is stepped alone to the head; one gone from the list (out of view, removed, docked, debris) drops its PT. A
    confirmed tick that falls far behind the layer's (a reconnect) starts the layer over.
  - *Level of detail*: ships further than `PT_TUNING.reach` (6 km) from your ship at the confirmed tick stay on the
    plain view (interpolated at the render tick, the replica layer's pose); one on PT leaves past 1.15 x that; at most
    `PT_TUNING.maxShips` (48) on PT, nearest first (one already on PT counts 1.15 x nearer); a ship going onto PT or off
    it eases between its interpolated and PT poses over 250 ms (modes.ts `PT_SWITCH_MS`). Cost: crowd bench `--pt-reach 1e9` lifts it (numbers in the C3
    rollout section of the sim-foundation plan; the probe reports "probe PT").
  - *Drawing*: the hook (`GameState.drawMode`, state/drawMode.ts) is the only thing in the hot paths: `frame` checks
    and advances the layer before ships are placed, `placed` puts a PT ship at its PT pose (plus the ease) at
    ownDraw - its kind's `drawBack` (a pilot 0.5 tick behind your shells, anyone else AHEAD_BACK: where the collision
    step meets it, sim/timeline.ts hitStateTick), and `shot` draws that ship's shells on the same tick (WeaponFx
    timeline), yours at your own draw tick. Bosses (told hits) are drawn by the replica layer at their PT tick (its own pose eases their rewrites; the bodies kind's ease isn't added on top), homing shells and mobs by the guides kind (`entity`); debris and ships out of reach keep the render tick.
  - *Plugging in* (the other tracks: pulls, other ships' shells, mobs and boss attacks, own-shot hit matching): the
    world's kinds are a `PtKinds` registry (predict/ptKinds.ts, order ships 0, bodies 10, guides 20, moves 30; the
    game's set in worldKinds.ts, the PT/ST layer joining as `ShipsKind`); a new kind of thing adds a `PtKind` there.
    Past the confirmed tick other ships are read through `AheadReads`, never the replica layer. A new kind of ship
    registers with `registerPtKind` (its claim, step, pushable, drawBack); anything else on the predicted
    timeline that must hear the ships layer's own re-steps adds a `PtTrack` (`PtStLayer.addTrack`: told `stepped(t, layer, group)` after each tick's ships and
    contacts, `restepped(c, ids)` after a re-step, `reset()`), and keeps its own state, hash and ease. Contacts stay
    the world's (`PtStWorld.contacts`).
  - *Modes*: C3 is `DEFAULT_MODE` (predict/modes.ts), installed by `Prediction` in Game.ts whenever prediction is on
    (not proto), in dev and production builds. A (interpolated), B (prediction off), C1 (AI ahead) and C2 (no touch
    register) are dev-only alternatives, switched live from F7 (docs/areas/ops-tools.md "Prediction modes").
  - *Not predicted (open)*: your own ship's contacts past the newest snapshot (OwnTick finds none there; it pushes PT
    ships as a fixed body), contact damage and the rebuild it brings (a hard ram is a correction), AI pushed by a
    contact (its PT is its decided path), pinned structures (no pinned flag on the client: pushed as anything else).
  - Tests: client/src/predict/ptst.test.ts (fake transport: no re-step when matching; one re-step per mispredict;
    C3's touched ship re-stepped at the same confirm, C2's a confirm later; the ease; snap; entering, leaving and
    coming back; tracks), modes.test.ts, server/src/net/causes/ptContacts.test.ts (the pass against the server's).
- **The PT timeline's kinds (C3, the default, and C2; track C)**: `client/src/predict/ptKinds.ts` is the contract for anything stepped ahead of the confirmed tick to the own predicted tick (`PtKind`: `advance(to)` steps and records by tick, `confirm(c)` holds what was recorded at c against ST and re-steps once on a miss, `pose`/`eased` the drawn place; `PtKinds` confirms every kind in `order`, then advances them all). Kinds (`client/src/predict/worldKinds.ts`, installed by Prediction.ts in C2/C3): ships (the PT/ST layer, predict/ptst.ts), bodies (bosses), guides (homing shells, mobs), moves (bodies' moves: looks and straight shells; MoveRunner `from`/`only` forks, `takeTimed`). Hooks they use: `GameState.drawMode` (`entity`, `ahead`), `ShipClient.ptMoves` / `show` / `forkMoves` / `bodyHost.ahead`, `GuideRunner.fork` / `stepFork`, `WeaponFx.predict` (returns an id) / `retract`. Past the confirmed tick other ships are read through `predict/aheadReads.ts`: reading the replica layer itself there (preAt of another pilot) steps it ahead, and something kept from those steps was read by ST later (a mob's ST went off the server's in ptWorld.test.ts; the likely cause, ContactWorld finding pairs for ticks past the snapshot, is gone since the C3 rollout: no pairs there, and ships stepped there are stepped again from the window at the next snapshot). Tests: server/src/net/decisions/ptWorld.test.ts.
- **Other ships' guns, stepped from their inputs (after the C3 rollout)**: another pilot's or an AI pilot's gunfire is
  worked out on each client from the controls it already holds, as its own is; the server sends no fire record of it.
  Code: common/src/sim/otherGuns.ts (the shared lane steps and wire forms), server/src/net/guns/GunNet.ts, client
  src/ships/guns/OtherGuns.ts, client src/predict/kinds/shellsKind.ts.
  - *Controls*: a pilot's held keys and aim are its control rows; its triggers and cursor distance (the input's 4-unit
    grid) are gun rows, the snapshot's `gun` field (protocol 61; `packGunRow`: [id, bits × 8 + ago, distance step, ...],
    a run form like the control rows'; until then a plain `gunCtl` message just before the snapshot). The client takes
    them before the rest of the snapshot (serverMessages `snapshot`, `OtherGuns.onGunCtl`). Each row is made once a
    round (GunNet) and goes as an encode-once block (`BlockStore.gunRow`, rowsIO `gunRowBody`, `PK_GUN`); a snapshot
    carrying any is urgent, as the gunCtl message was (PackedLink `urgentFor`: 'gunRows'). They go when they change,
    and only to clients stepping that ship.
    The distance goes exactly only where a lane needs it (GunNet `ctlTick`): on the tick a trigger changes, while
    one is held, and `SEMI_BUFFER` (5) ticks after a release (a semi-automatic click still fires). Held, "exactly" is
    as the guns stepped on it: a pilot's guns hold their distance (`ShipState.heldDist`, in the gun state, the lane's
    gunSync and the ownSync) and take the cursor's only on a gun's due ticks, its fire tick (before it steps, so the
    shot is exact) and halfway to its next (common ships/guns.ts `distDue`, a pure function of the gun state: the
    server's real ship, its lanes, other clients' lanes and the pilot's own prediction all hold the same one; several
    guns: the union of their ticks; a beam: every tick). So a held cursor goes about twice a fire interval, only when
    that changes it (crowd bench: exact updates 7.2 -> 4.3 a pilot a second at ball 20, 13.2 -> 6.8 at ball 50; gunCtl
    1332 -> 1055 B/s, 5903 -> 3993 B/s). The server's lane steps on the controls as sent, as its clients' do. With no trigger held
    a turret points straight at the aim and carries nothing (the turret rule, docs/areas/weapons.md), so there the
    distance goes roughly (`idleDue`): when the change since the last sent would turn some gun's line to the aim point
    (from a turret's pivot, a fixed gun's muzzle) by `IDLE_TURN` (0.5°) at `IDLE_MIN_GAP` (15 ticks, 250 ms) since,
    proportionally less the longer since (0.5° × 15 / ticks: a small change waits longer, a big one goes at 250 ms),
    and any change at all at `IDLE_MAX_GAP` (180 ticks, 3 s); unchanged, nothing. A pilot holding its cursor on a
    moving target now sends about 0.25-0.4 idle updates a second instead of 10-16 (crowd bench). Every lane steps on
    what was sent (held between); what that changes from the real ship, an idle turret's aim, is left out of the lane
    hash (as is the held distance while idle). For drawing, `OtherGuns.distAt` eases between two idle updates
    (ShipClient.placeReplica's cursor distance, in place of the status row's hundreds, for a ship whose lane it steps).
    The status row's hundreds (the fallback for a client not stepping that lane) move by the idle rule, firing or not
    (GunNet `GunLane.rough`, SnapshotBuilder `roughCursor`: idle, what the lanes were sent; held, the cursor's when the
    turn is due), not every time the cursor crosses a hundred (an unarmed pilot, with no lane: the cursor's).
    Measured in docs/audits/bitpack-2026-11-06.md.
    An AI pilot's trigger, lead and distance are its body's (common bodies/aiPilot.ts: the trigger rule `aiFires` moved
    there from Enemies.ts, its target's size read where each end has its structure, `lobs` in the ENGAGE order's
    hitBy field), so a client flying its body (CAPS.PILOTS) fires it too: nothing goes for them.
  - *The lane*: each such ship's gun state and stores (the own ship's `OwnExtras` form), stepped beside its replica
    every tick (ShipReplicaSet side steps): a pilot's stores through the accounted flight from its replica at t - 1
    (stepOwnShip, the guns left out), then its guns (stepShipGuns) at its replica after t's step, before t's causes;
    an AI pilot's battery as the server's pilotless step runs it (powerTick, no thrust), then its guns. A rebuild between
    two ticks moves the stores onto the new structure (`laneRemap`, as the server's rebuild does). What a lane fired on a
    tick becomes the records a fire row carries (`laneRecords`: straight volleys, pulses, charge tells, beam pieces,
    mining pulses), built into shells at the snapshot that confirms the tick (`OtherGuns.confirm`, onto `snapshot.fire`
    before ShipClient.preSnapshot builds it), each named by its shot id (`otherShotWireOf`: above every 31-bit id, under
    the packed codec's 2^48). They end on their own at their life's end; a removal the server still sends (a rock, a
    point-defence intercept) and its hit records name them so (HitLedger `shellName`: `SnapshotBuilder.otherShotLog`).
  - *The server's lane* (GunNet): the same step per ship, from the real ship's pose (what its clients' replicas hold
    while in step) and the replicated controls. Each tick, what it fired against what the real ship fired (its fire
    records, `firedRec`/`sameRecs`): a tick they differ on is told, its fire records sent as before (an ammunition round,
    a sheltered pilot, a bot aiming off the input grid); one where the lane fired and the real ship didn't gets a
    TELL_NONE record. A told tick replaces the client's own records of that ship and tick. At each snapshot round the
    lane's state hash (`laneHash`: stores and gun state, point defence's aim, every gun's aim while no trigger is held, and the towed entity left out) is held to
    the real ship's; off (a shield drawing on the stores), it's put back to the real ship's, a new version, at most once
    per `GUN_FIX_GAP` (60 ticks). A respawn starts a lane again; docked, a pilot has none.
  - *Which clients step which ships* (`GunNet.forClient`): a ship it holds, within `GUN_REACH` (8 km) of its own (kept to
    `GUN_KEEP`, 10 km), lately firing or its trigger held (`GUN_ACTIVE`, 600 ticks); an AI pilot only while it flies its
    body. Then it gets a `gunSync` (plain, before the snapshot: the lane state as one sparse list, `packGunSync`), again
    only for a new lane version (its hash drifted from the real ship's, a respawn); an empty one drops the lane (gone
    far). A keyframe of the ship doesn't resend its lane: an empty `keep` gunSync says where that round's told span
    starts (its volleys go as rows), and the lane steps on from the state it had at the keyframe's tick (OtherGuns
    `stash`; the pose its guns fired from in that window wasn't the server's, so a drift shows in the hash and is resynced). Until then, and for the span of the round a gunSync goes in (`w`: the ticks
    before it were decided in rounds that sent the client nothing, and it works them out from the lane it had: the
    client installs a gunSync at its snapshot, `carry`), its fire records go as before. The first volley after a quiet
    spell is told and its gunSync goes with it; cruising crowds get none.
  - *Point defence* fires at threats only the server sees (features/support/pointDefence.ts). Its aim isn't stepped by a
    lane and isn't hashed; each shot is a TELL_PD fire record to the clients stepping that ship, which put it into the
    lane (`lanePd`: its cooldown restarts, so the power its reload draws stays the server's) and step again from it.
    Its intercepts are drawn from the `intercept` message as before.
  - *Not derived (told as before)*: rows-flown AI (an AI fighting a ward, a pinned or boss-brained pilot: its lead isn't
    on the wire; quantising it would change how AI ships fire), bosses' guns (their brains decide), shells that aren't
    straight (homing, lobbed, arming, aim bursts: rows as before), ammunition rounds, a window a ship was keyframed in.
  - *On the PT timeline* (C3): the `shells` kind (predict/kinds/shellsKind.ts, order 40) draws each ship's volleys on the
    tick they're fired, at the ship's PT pose (WeaponFx.predict; the snapshot's built shell, the same shot, takes it over:
    WeaponFx.claim). An AI pilot's lane is the tick layer's own, stepped ahead with its body; another pilot's is stepped
    on PT from the tick layer's lane at the confirmed tick on its last known gun controls (held), checked by hash at
    each confirm. A tick whose records or firing pose change (a re-step, a trigger let go, a decision) has what it drew
    taken back and redrawn; at each confirm, what it drew of the ticks now final is held to the tick layer's lane.
  - Tests: server/src/net/guns/otherGuns.test.ts (another pilot through every firing model, an AI pack, point defence:
    each built shell the server's exactly, each lane's hash the server's lane's at the same tick, no told hit missed),
    otherGunsPt.test.ts (fake transport, LAT 4: other pilots' and AI shells drawn on their fire tick ahead of the
    snapshot, exactly the server's).
- **Your own ship (before Stage 3b)**: predicted from your inputs, resent only when the prediction would be wrong: an input that reached the server after its target tick, a new keyframe version, a status change (shield, EMP, marked, slowed), a state-hash mismatch (server keeps 3 s of per-tick hashes), (no periodic copy: the snapshot's head hash `hh`). Boost regeneration is predicted too. A client that sends hashes then goes quiet for 3 s lets go of its controls.
- **Messages that repeat are sent once (protocol 26 work)**: `people` once at login (People.shown de-dupes the rest), `items` only when the message changed (`Session.itemsKey`, Pilots.sendItems), `party` only when the JSON changed (Party.sent, members' x and y in 1 km steps, hull in 5% steps; the leave messages clear the key), `ops` only when the view changed (Operations.shown holds the last JSON). All are full-state messages, so skipping an identical copy changes nothing on the client.
- **View range**: a client holds the ships homed in its focus cells (the focus grid, net/cells/FocusCells.ts; the 40 km circle is gone); the furthest flight zoom shows ~24 km. `FocusCells.view` keeps each client's `shipView`. Outside it: no keyframes, control/status rows, structure or HP; leaving goes in `snapshot.out` (blueprint kept); returning gets its keyframe and status row (plus a `shipSync` without the blueprint if rebuilt meanwhile). Combat effects (`damage`, `projectileHit`, `partDestroyed`, `contact`, and every `LAZY_TYPES` effect broadcast to a system that has a place: `detonation`, `ignite`, `stationFire`) go only to clients within 48 km (`broadcastNear`; damage always reaches whoever dealt it). `damage` is summed per target, source and glancing till the next snapshot and sent to a tenth. Removals go only to clients that were sent the entity (or made it: debris). A plain slug's hit (no splash, EMP, split, pierce, fire, chain, pull, hold or fuse: `Weapons.bursts`) sends no `detonation`: WeaponFx draws its impact from `projectileHit`. A shell striking a rock sends no `effect` (the client draws the rock's sparks where its drawn shell meets the drawn rock: ShipClient `struckFx` from `WeaponFx.onStruck`) and no `projectileHit` either (every client finds its own hits): its drawn shell stops at the rock and the snapshot's `removed` ends it on the tick layer (SelfHits sits that window out; HitLedger tells any hit in it). A stuck mining charge blowing still sends both (GameServer `hurtAsteroid`; docs/audits/rock-bytes-2026-11-05.md).
- **Projectiles**: another pilot's or an AI pilot's straight shells aren't sent at all where its client steps that ship's guns (below: "Other ships' guns"); otherwise shots from a replicated ship go as fire events (`snapshot.fire`: owner, ticks ago, weapon part, aim in 1/4096 rad, shell ids); the client rebuilds the shells from the replicated pose and blueprint (`rebuildVolley` in `launch.ts`; the server spawns through the same `launchShot`, randomness seeded by tick and shell id) within 0.01 unit. Sent as a row once: its own shots (predicted), homing missiles (again when their course changes), shots from a ship it is only now getting a keyframe for, shells from out-of-view ships within 12 km. Pods go once as a drift anchor (`podDrift`) and again only when moved. Effects wait up to 2 ticks to ride with the next frame (`Outbox.lazy`, net/snapshot/Outbox.ts). Status rows leave out position; ship bodies' core/hull % are derived on the client from part HP (`ShipClient.fillHull`); rebuild syncs carry only part HP the client lacks (`hpd`); part HP changes go together in one `shipHps` per snapshot, to a tenth. `shipSync` sends the blueprint the first time a client sees a ship; designs go once per client, others by hash (`shipSync.design`; `shipNeed` to re-ask).
- **Wire format**: snapshots are rows of values (`packSnapshot`/`unpackSnapshot`); everything owed in a tick goes in one frame (`{type:'batch', m:[...]}`, except pongs); frames are binary (`binaryCodec.ts`: `SERVER_FRAME` + each message in a small tagged format: small ints in a byte, varints, decimals as integer mantissas, lengths in the tag; decodes to what JSON would; `encodeServerMessage` encodes once for every client, `serverFrame`, `decodeServerFrame`). Frequent messages go compact `[code, ...values]` (`COMPACT` in protocol.ts; an unknown field falls back to a plain object). Projectile rows `p` have no position while on the straight line from the muzzle; a shell that ends at a chosen point (a mortar, an aim burst) carries its end tick (`data[9]`, sent as ticks after the snapshot's, before x and y). Control rows are stepwise (`packControlRow`: a row's first aim as the step from the one the client has, each later one as the change in step from the one before; packed with each field by its own chunk, `PK_CONTROL` [tb 4, ticks ago 3, first step 2, change 1], no per-value tag, rowsIO `controlValuesIO`: crowd bench probes' snapshot.c ball 20 954 -> 727 B/s, ball 50 3769 -> 3078 with the held aim angle). Common strings go by number (`DICTIONARY`). permessage-deflate on top (`SocketTransport`: level 4, 8 KB window, frames under 96 bytes left alone); the ping panel's down figure is before compression. Inputs: 11-byte binary (2-4 bytes compact, CAPS.INPUTS), only on change, aim as 13 bits, target tick as its low 16 bits (`unwrapTick16`), applied in target-tick order; at most 16 inputs a tick, scheduled no more than 64 ticks ahead, 32 waiting. Removals go only to clients in that system or sent the entity.
- **Measure**: `npm run bench:net` in `server/` (4 pilots in a running fight; `--spread`, `--gap N`, `--sample`). A 4-pilot fight went from ~116 KB/s per pilot (JSON) to ~1.3 KB/s (~1 KB/s deflated).
- **Plain messages**: `intercept` is sent as a plain object, not in the wire tables. `join` carries `protocol` and `caps`: a mismatch, or caps short of the full set, closes with 4002 and the client asks for a reload. Only `join`, `ping` and sign-in are accepted before joining.
