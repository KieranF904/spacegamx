# Networking: Boss bytes, contacts, pull fields, mine bays, clamps
(Part of [networking](../networking.md); the other parts are listed there.)

### Boss bytes round (protocol 49, 2026-11-05; docs/audits/boss-bytes-2026-11-05.md)
- **Own row with OWN_SIM**: the client's own row goes by its own keyframe version (`Replication.ownVersionOf`), so a
  contact or pull its tick layer worked out is no correction. (Stage 3b: there is no separate prediction any more; the
  own ship is drawn from its tick layer, below.)
- **Own contacts with a run boss** go without the boss's state when its bodied shadow is what the client has
  (`shadowCauses` `bodyPreStep`, `Replication.ownFor`).
- **Hits on its own ship** are found by an OWN_SIM client like any other (`SelfHits.ownExact`; `HitLedger` 'self' only
  without OWN_SIM).
- **`shipSync.dmg`**: a ship's shells' damage multiplier (a boss's `damage` and rage), on a new ship's sync when it
  isn't 1 and on any sync after it changed; client `ShipState.dmg`, `gunShell` scales the strength by it; the server
  derives with the one it sent (`shipSynced.dmg`), a stale one goes as the record's damage.
- **`DECISION.STATUS` [emp, slowed]** (op 7): an AI ship EMP'd or slowed, told to its body when what it had stops
  being what the ship has (`AiPilots.fly`); the body flies `CTL.emp`/`CTL.slowed` from it (`bodyStatusBits`). A SYNC
  clears it (BodyNet sends a STATUS after a SYNC while one is under way).

### Contacts on the tick layer (`CAPS.CONTACTS` 2097152, with CAUSES; protocol 53, no wire change)
Dev builds (`?contacts=0|1`; on by default). The server's contact pass takes its pairs by id (lower first) from one
shared sweep (common ships/contactPass.ts `contactCandidates`: bounding circles padded by `CONTACT_MARGIN`, from the
bodies before the pass). A CONTACTS client runs the same sweep on its tick layer (client ships/causes/ContactWorld.ts):
on each tick, over the ships it held before the snapshot's window and holds in step through it (no keyframe in it, not
gone or out of view, ships, not docked, not mid-jump, structure that tick known), from each one's step at that tick
(`ShipReplicaSet.preAt`, now a step worked out once, `stepPre`, with no causes). Each candidate becomes a row on both
ships (`CONTACT_FLAG.CHECK`: the pass's centre-distance test first) placed among their told causes by its place in the
pass (`CAUSE_PLACE`, `pairPlace`, `placeRows`: pulls before the pass, pairs by ids, rebuilds after), and is worked out
by `applyOwnCauses` as told ones are (ShipCauses `rowsAt`, OwnTick `rowsAt`/`midAt`). Such a pair goes as no record, no
own row and no `contact` sparks (the client draws its own: `contactFxDue`, the pass's threshold and cooldown); its ships'
hits are told that window as for a told cause (`SelfHits.onTouched`, Replication `out.caused`). A tick's pairs are worked
out once (memo) and again when any ship in them is stepped again from that tick (`ReplicaRewinds`: rewinds, keyframes,
late control rows, removal), every ship that took part stepped again; a window's ticks are final once its snapshot is in.
The server works out the same set per client and window (server net/causes/contactsFor.ts `contactWindow`, over the
pass log `ContactLog`, Replication `found`), and tells the client to leave out (a CONTACT record naming one ship twice,
`isLeftOut`) a ship it can't vouch for: out of the pass but not docked, pinned with a candidate among them, its structure
that tick not one the client has, or pulled after the pass began. A snapshot always goes when a pair was found in its
window. Sparks of pairs it doesn't find go with its snapshot (`Replication.contactFxFor`; everyone else gets them at
once). Tests: server/src/net/causes/causes.test.ts. Measured: docs/audits/contacts-tick-layer-2026-11-05.md. Left: contact
damage (HP isn't worked out on clients yet: group D), contacts with rocks (none are simulated).

### Pull fields (common sim/pullFields.ts, server ships/bridge/pullFields.ts)
Every pull on a pilot's ship is part of that ship's step, on every end. The decision to pull is a **field**, sent
once. The force is worked out each tick by the same function on both ends.

- **Declared a tick ahead.** A move says "I pull on the next tick" (`MoveWork.pull`, `CustomWork.pull`; a parked
  collapsing star in `Weapons.tick`). The server's `PullDeclarer` keeps a field open while the declaration stays the
  same. A field not declared again ends before the next pilot step (`settle`, in `playerMovementSystem`).
- **Five shapes.** CONE (the Scrap Mother's haul), LANE (her intake), POINT (a Scrap Crawler's magnet, on its target),
  REEL (a Hookboat's tether, on what it struck) and STAR (a fixed point, its owner skipped). The record is
  `[id, from, kind, t0, t1 (-1 open), target (-1 every pilot), skip, ...args]`. It goes in a plain `pulls` message just
  before the snapshot, when the field opens and again if it ends early (`r: 1`: a new system, forget the old). The
  connection keeps `pullsTold`.
- **The force: `fieldPull`.** It reads the puller as it ended tick t - 1 and the pilot after its motion on tick t
  (velocity too). The server's `stepMovement` passes `env.pulls` (`ServerPulls.source`, the puller's `Position` as the
  tick begins). A client's `ShipReplicaSet` passes its own source into every pilot step: `replicaStep` (now with the
  ship's id), the own ship's `OwnTick.step`, and `stepAlone` (the PT layer). That source reads the puller from the
  ring at t - 1.
- **Stepped again with the puller.** A puller stepped again from tick t makes the ships its fields pull be stepped
  again from t + 1. Its poses are kept as read, so a removed boss still pulled before it went. A window an earlier
  snapshot closed is final (`pullsFinal`).
- **One arithmetic.** Every pull on a pilot is `addPull` (the PULL grid, then the velocity back on its grid). It is
  applied after the motion and before every cause, in puller-id order. Shadows apply pull rows right after their
  replica step, before `pre`, so contacts and bodies read the pulled ship on both ends.
- **Told only where it can't be worked out.** Pulls still go as `PULL` rows in these cases, each tick whole
  (`untoldPulls`):
  - a pull that is the server's alone (a Grapple gem's moving shell; a pull on an AI ship is a push, keyframed as
    before);
  - a tick whose puller the client can't have as the server had it: not held before this snapshot, out of view, a
    shadow of it unlike the pose the pulls read (`notePullers`), causes it can't work out, or keyframed now. The
    client's step then takes the told rows in place of the fields' (`OwnTimeline.pulls`, `ReplicaCauses.pulls`);
  - a zero row where such a field could have pulled the ship and the server had no pull.

  Each tick is judged once (`pullsJudged`). Only pilots are pulled this way.

Tests: server/src/net/causes/pullFields.test.ts. It covers the haul and intake, the reel and magnet, pullers shoved on
the server alone, and a star. Both pilots and every body are exact at every snapshot. Measured:
docs/audits/sim-foundation-after-2026-11-06.md, "Pull fields".

### Mine Bay blasts (common network/minesProtocol.ts, ships/features/minebay/blasts.ts; JSON, no wire table change)

A drop is one record (`minesLaid`); blasts (stage M2, docs/design/groups-mines-docking.md 2.4) are found by each client
on its tick layer when the pilotless ship that set the mine off is exact there: client SelfHits calls its host's
`window(from, to, ships)` with the same targets its shell search uses, and the Mine Bay feature searches them
(`findMineBlasts`). The server keeps each tick's touches (server ships/features/minebay/Minefield.ts) and settles them
per pilot as its snapshot window closes: the SnapshotBuilder calls the part features' `onSnapshot(pilot, {from, to,
finds, exact})` just before the snapshot (`finds`: `HitLedger.searches` and a window of at most `SEARCH_WINDOW_MAX`;
`exact`: held and `HitLedger.poseExact` with the window's told ships). A blast the client finds goes unsaid; the rest go
as `minesGone` before the snapshot (a dead or departed pilot's at once); a blast it would find that never happened gets
`minesKept` (the mine is told only, for that client, from then on). A rule for what the client finds must be the same
on both sides (`poseExact` and SelfHits' targets), or blasts are missed or drawn wrongly: there is no chain for mines.

### Docking Clamps' links (common network/clampProtocol.ts, sim/clampPair.ts; no wire table change)

Two pilots' ships locked by Docking Clamps (docs/design/groups-mines-docking.md 3) are decision records, plain JSON:
`clampLink {tick, leader, follower, lc, fc, offset}` (a lock, a swap of who steers, a rebuild's fresh offset: the pair's
new record ends the old at its tick) and `clampBreak {tick, a, b, why, push?}` (`tick` the first tick each flies alone;
an undock's `push` on the leader, the follower's the reverse), to every pilot in the pair's system, and each open link
again to a pilot who comes there (Clamps.ts `tellLink`, every 30 ticks for newcomers only). `clampAsk {from, what, until}`
goes to the other pilot while a press waits. Up: `clampDock {with, clamp, theirs}`, `clampSwap`, `clampUndock`
(MessageLimits: 240 a minute each).

From the records every end steps the pair alike (the step's clamp source, `SimEnv.clamp` / `ReplicaEnv.clamp`): the
leader as the pair (the joined structure, its CTL power bits carrying the pair's engine share), the follower placed on
the leader as it ended the tick (`placeFollower`). No positions are sent for the follower and no input is delayed: the
client's ShipReplicaSet holds the links (`noteClampLink`, `noteClampBreak`, `clamps`), steps a follower's leader first
(`leaderFirst`: the steppers' scratch isn't re-entrant) and steps a follower again whenever its leader is
(`dropped`); the server's Replication shadow of a follower is the real ship while linked (`clampFollower`: never keyed
for it), the leader's shadows step the pair (`envOf`). A leader's own client flies the pair on its own engines' share:
when the follower's was lower the server sends it a keyframe of its own ship (`ClampTable.limited`). A contact on either
ship (the server's `foldClampContacts`) moves the leader off its shadows: a keyframe, the follower placed from it.
The linked pair is left out of the contact pass (`ContactEntry.link`, both ends).

Tests: common/src/sim/clampPair.test.ts (the joined flight on the three steppers), common/src/network/clampReplicas.test.ts
(the replica set), server/src/golden/clampParity.test.ts (600 ticks on a real server, the steering pilot, the other pilot
and a third client; no follower keyframes; the breaks).

