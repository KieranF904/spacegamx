# Weapon groups, the Mine Bay and Docking Clamps

Agreed with Kieran, 2026-11-07. Three features, built in parallel as packages G, M and K (section 6) on top of a
shared foundation that is committed (section 5). Kieran tests on the local dev server, where guests and signed-in
pilots are admin. Every number here is a starting point for playtesting; each lives in one place (named below).

Netcode bar for all three (docs/design/netcode-lockstep.md, decision-inputs.md): deterministic things send no streams,
only decisions, inputs, corrections and rare events. No fire or input delay is added anywhere, and nobody's inputs are
coalesced or batched to save bytes. Kieran dropped the "delay both pilots' inputs" idea for docking: one pilot steers.

---

## 1. Weapon groups

### 1.1 Rules

1. Every weapon is in any of **four groups**, several at once if wanted. A part's groups are a 4-bit mask on the
   blueprint part, `wg` (bit 0 is group 1). **No `wg` means group 1 only**, so every existing design has all its
   weapons in group 1.
2. The pilot has two **selections**: the group the **left button** fires and the group the **right button** fires.
   Each is `all` (0) or a group 1-4. **Both start at `all`**, which fires exactly as the game does today: left fires
   every weapon; right fires every weapon, or the mining lasers on a ship that has them.
3. With the right selection on a group, the right button fires that group (a mining ship then does not mine on the
   right button until it is set back to `all`; the HUD says so).
4. Groups are edited in the **hangar** (saved with the design) and in the **field build overlay** on the live ship (a
   `weaponGroups` message, no plan save, free).
5. **Keys** (all rebindable, in `input/keybindings.ts` ACTIONS): `Comma` / `Period` cycle the left selection back /
   forward (all, 1, 2, 3, 4, all ...); `Slash` cycles the right selection forward. A Gameplay setting, off by default,
   lets the **mouse wheel** cycle the left selection (the wheel zooms today; with the setting on, zoom stays on the keys
   and `Home`). A second setting, off by default, makes **number keys 1-4** pick the left group and **5** pick `all`
   instead of the quick bar. (Wheel and digits are taken today, which is why both are opt-in.)
6. The **HUD** shows the two selections ("L: 2  R: all") and, for the left group's weapons, each one's state:
   **ready**, **reloading** (clip, charge, cooldown) or **short of power**, from the gun state the client already steps
   (`client/src/ships/gunHud.ts`, the weapon ring). A weapon outside both selected groups is drawn dim.

### 1.2 State and inputs

| What | Where | Notes |
|---|---|---|
| A weapon's groups | `PlacedPart.wg` (common ships/types.ts), kept by `canonicalPart`/`parseBlueprint` (weapons only, dropped when it is the default 1) | Pure helpers in `common/src/ships/weaponGroups.ts` (`partWeaponGroups`, `cleanWeaponGroups`) |
| The selection | One byte, `packGroupSel(left, right)`: left in the low nibble, right in the high, 0 = all | `ClientInputMessage.weaponGroups`, ECS `Input.weaponGroups` (ui8), `INPUT_NUMBERS` |
| The trigger word | `trigWord(left, right, sel)` = left 1, right 2, sel << 2 | What a tick's guns step on, and a gun row's bits (`GunCtl.bits`, today `GUN_FIRE` 1 / `GUN_ALT` 2: unchanged values) |
| Last tick's trigger word | `ShipState.trig` / `GunState.trig` (new, package G) | Replaces the meaning of `triggerHeld` per gun: a gun's trigger last tick is `gunTriggeredBy(mask, trig, hasMiners)` |

**On the wire** (foundation, done, protocol 64):

- Base binary input: type byte **0x04** is the 11-byte layout followed by the selection byte at `[11]`; the riders
  (hit report, own check, body check, acks) follow it. Type 0x03 is unchanged (no selection).
- Compact input: `CI_EXTRA.GROUPS` (0x20) puts one byte after the seq rider. It is present only when the message has
  `weaponGroups`.
- The client sends `weaponGroups` **only on the input whose tick it changes on**, and on the first input after a
  welcome or a respawn. Absent means "as it was". The server keeps `Input.weaponGroups` until an input changes it, and
  a dropped input (too far ahead, queue overflow, while berthed) still applies its selection
  (`server/src/net/handlers/flight.ts keepGroups`).

Bytes: a change costs 2 bytes once (EXTRA flag byte + the selection). Nothing is sent while firing that is not sent
today.

### 1.3 Determinism

Firing stays exactly as deterministic as it is. The selection is input state at a target tick, like a held key. Every
end that steps a ship's guns reads the same three things: the buttons, the selection, and each weapon's `wg` (from the
blueprint everyone has).

- `stepGuns` (common ships/guns.ts): `orders.firing` becomes per gun: `want = gunTriggeredBy(mask, word, hasMiners) && canFire`.
  The slew rule ("held through from the tick before") and the semi-automatic click are per gun, from this tick's word
  and last tick's (`ship.trig`). With the default selection this is identical to today, so every golden and parity
  test must pass unchanged with groups at `all`.
- `gunControls` (common sim/guns.ts): mining is `fireAlt && hasMiners && !rightFiresGuns(sel, hasMiners)`.
- The server's pilot step (`bridge/weapons.ts stepWeapons`) passes the word built from `Input.fireLeft/fireRight/weaponGroups`.
- Own prediction (`client/src/ships/own/OwnTick.ts noteExtras`, common `sim/ownStep.ts` OwnInputExtras) carries the
  selection with the fire bits at the input's tick.
- Other ships' gun lanes (`server/src/net/guns/GunNet.ts` gunCtlOf, `common/src/sim/otherGuns.ts` lanePilot, client
  OtherGuns): a gun row's bits become the trigger word. The gun row's bits are a varint already (`rowsIO.ts
  gunRowBody`), so no wire table changes; a selection change is one more gun-row event. The lane hash and `gunSync`
  carry `trig`.
- AI and bots: an AI's `aiFires` trigger is "left, all": unchanged.

### 1.4 What the change must not do

No fire delay, no batching: the selection never waits for anything; a click fires on the tick it did before.

---

## 2. The Mine Bay

### 2.1 Rules

1. A **Mine Bay** is a utility part (`mine_bay`: rect2, unlock L8, steel), not a weapon: it has no `weapon` field, is
   never aimed, is never in a weapon group, and nothing targets it as a gun.
2. **A key press drops a batch** (`mineDrop`): 4 mines out of the bay's open (facing) edge, fanned 0.35 rad apart,
   ejected at 3 u/tick plus half the ship's velocity, each with a little seeded extra speed. They slow evenly to rest
   over 40 ticks and then sit still (no drift, no gravity).
3. **Magazine** 12 mines per bay. **Cooldown** 120 ticks (2 s) between drops of one bay. With several bays the drop
   comes from the fullest ready one. A drop with fewer mines left than the batch drops what is there.
4. **Proximity**: a mine arms 60 ticks (1 s) after the drop, then goes off when a ship's bounding circle comes within
   40 u of it. **Never for its owner or the owner's party**, never for a docked (berthed) or warded ship.
5. **Blast**: 140 damage at the centre across 110 u, **through the normal damage funnel** (`ShipBridge.splashAt` ->
   `hurt`: shields, armour, falloff, PvP rules via `canDamage`). Kill credit goes to the owner.
6. **Life** 90 s, then the mine fizzles. **Cap**: 24 live mines per pilot; a drop past it fizzles the oldest first.
   The owner dying, leaving the system or logging out clears their field.
7. **Ammunition**: the field fabricator refills magazines with a fabricator job `rearm` (one bay, up to 4 mines a
   job). **PLACEHOLDER cost**: 3 work seconds and 1 alloy plate + 1 copper wire per mine (`REARM` in
   `common/src/econ/field/rules.ts`, the one place). Rearming runs after repairs and builds in the job order. A newly
   built bay starts empty. Magazines are saved with the ship (`FieldRecord.mines`, uid -> loaded).

Numbers: `MINES` in `common/src/ships/features/minebay/minebay.ts`; the bay's batch, magazine and cooldown are the
model's (`mineBay` in `scripts/econ/models.mjs`). Default key: `Digit0` ("Drop mines"; rebindable).

### 2.2 State model

| What | Where |
|---|---|
| A bay's model numbers | `FunctionDef.mineBay {batch, capacity, cooldown}`; derived `fx.minebay.bays[]` (part, uid, mouth, dir) |
| Magazines | server: per pilot, uid -> loaded, saved in `ShipRecord.field.mines`; client: the `mineBay` message |
| A drop | `MineDrop {owner, bay, tick, n, x, y, angle, vx, vy, seed}`: the decision record |
| A live mine | derived: `mineId(owner, tick, i)`, `minePos(drop, i, tick)`, `mineArmed`, `mineExpired` |

### 2.3 Messages (`common/src/network/minesProtocol.ts`, foundation)

- Up: `mineDrop` (no fields: the server picks bay and tick). Rate-limit it (`MessageLimits`, about 4 a second).
- Down: `minesLaid` (a `MineDrop`) to every client holding the owner, and each live drop again to a client that comes
  to hold the field (first sight, entering the system; mines of it already gone follow as a quiet `minesGone fizzle`).
  `minesGone {tick, ids, how, by?}` for a cap fizzle or a clear (at once) and a blast the client can't find itself (M2:
  just before the snapshot that closes the window it went off in); a life's end is derived, never sent. `minesKept
  {tick, ids}` (M2): mines the client's search would find going off that didn't (taken back; their ends are told from
  then on). `mineBay {loaded, readyAt}` to the owner when a magazine or the cooldown changes.

### 2.4 Determinism

A drop is one decision record. From it every end works out each mine's path, rest point, arming and expiry with exact
arithmetic and the deterministic trig (`minePos` uses `dsincos`, rounds to 2 decimals). Nothing about a mine is
streamed. **Detonations** (stage M1): the server decides them (it knows parties and the true positions) and deals the
damage the usual way. **Stage M2 (done, 2026-11-07)**: clients work detonations out themselves, the shared rules in
`common/src/ships/features/minebay/blasts.ts`:

- *Who a client may find*: a ship a pilot may hurt that isn't a pilot (`mineFindable`: `sidesHurt(PILOT, side) === 1`).
  A pilot setting a mine off (PvP zones, parties) stays the server's to tell, as two pilots' shell hits do.
- *Where*: armed mines at rest, a ship's bounding circle within `triggerReach` (`MineBuckets`, the geometry the server's
  pass uses too), the ship where the pass has it (a pilotless ship at the end of the tick before); on one tick a mine is
  set off by the lowest id touching it.
- *Found* (`findMineBlasts`): as each snapshot window is searched on the tick-faithful layer (client SelfHits.window),
  against the same exact ships the hit search uses. The server mirrors that set (`HitLedger.poseExact`: held, not
  keyframed, moved by a cause, synced or debris; the window searched at all: `searches`, at most `SEARCH_WINDOW_MAX`
  ticks) and sends nothing for what the client finds.
- *Told*: every other blast, as `minesGone`, just before the snapshot that closes its window (server Minefield
  `onSnapshot`, a feature hook the SnapshotBuilder calls), or at once to a pilot that gets no snapshots (dead, gone).
- *Kept*: a findable ship touching a mine that only the server knows can't set it off (dormant, jumping, a berthed
  owner) would be found as a blast that never was: `minesKept` takes it back, and that mine's end is told to that
  client from then on.
- *Predicted* (drawn at once): each frame an armed mine is checked against the ships as drawn (same rule). A
  prediction is confirmed by the found or told end (one blast drawn, never two), or undone once the windows
  `PREDICT_SLACK` ticks past it settle without one (the mine comes back, its blast is cut; held `PREDICT_HOLD` ticks
  so it doesn't flicker). Client `ships/features/minebay/mines.ts` reconciles the three.

The three open decisions stay as they were: magazines on death, triggers by pilots only where they may hurt each other
(`canDamage`), and blast damage to the owner's party (`splashAt` as any blast).

The owner's own drop is predicted: the client draws the batch at once from its own pose and tick (same `MineDrop`
fields from its prediction) and adopts the server's `minesLaid` when it comes (same owner, bay and tick: replace the
predicted record; a refused drop removes it).

---

## 3. Docking Clamps

### 3.1 Rules

1. Parts: **Docking Clamp** (`docking_clamp`: sq, L4, alloy, size 1) and **Heavy Docking Clamp**
   (`docking_clamp_heavy`: rect2, L16, steel, size 2). The facing edge is the clamp's **mouth**. Clamps **match** only
   with the same size.
2. **Lined up** (`clampLinedUp` in `common/src/ships/features/clamp/clamp.ts`, `CLAMP`): mouths at most 30 u apart along
   the normal (and no more than 15 u overlapped), at most 10 u sideways, facing each other within 10 degrees, relative
   speed under 2 u/tick, relative spin under 0.03 rad/tick. The **prompt** shows at 1.5 times those tolerances (no
   flicker at the edge); the lock needs them exactly.
3. **Prompt**: while lined up, both pilots see "Press H to dock" (the existing Dock key, `boundKeyName('dock')`; the
   clamp feature's `onKey` claims H only while a prompt is up or the ship is docked, otherwise H docks at a station as
   now). The prompt is worked out on each client from replicas; it needs no message.
4. **Both must press**: a press sends `clampDock {with, clamp, theirs}`; the other pilot gets `clampAsk` ("<name> wants
   to dock: press H"). The lock happens when both pressed within 180 ticks (3 s) of each other and the server finds
   them lined up on the tick it decides.
5. **The lock**: the pilot who pressed first steers (the leader). The other ship snaps to the exact mouth-to-mouth pose
   (`clampOffset`, `followerPose`). From then on the two fly as **one rigid body** (3.3).
6. **Swap who steers**: either pilot presses the swap key (`Minus`, rebindable, "Swap who steers (docked)"); the
   other gets `clampAsk what 'swap'`; both within 3 s and the server sends a new `clampLink` with the leader changed.
7. **Each pilot keeps their own weapons and other parts**: guns, beams, mining lasers, tow beam, fabricator, mine bay
   and shields stay with their owner. Only the steering pilot's movement keys and steering aim move the pair; the other
   pilot's movement keys do nothing (their aim still aims their guns).
8. **Undock**: either pilot alone, pressing H while docked (`clampUndock`). The two separate along the clamps' line
   at 1.5 u/tick each, and the same pair cannot lock again for 120 ticks.
9. **Breaks** (`clampBreak why`): either ship destroyed (`death`), its pilot disconnects or leaves (`gone`), either
   starts a jump charge (`jump`: the drive works only solo; the jump key while docked undocks first and starts the
   charge), either berths at a station (`station`), or either clamp part is destroyed or detached (`part`). A break
   leaves each ship with the pair's motion at its own pose.

### 3.2 State model

| What | Where |
|---|---|
| A clamp's mouth, way out and size | `FunctionDef.clamp {size}`; derived `fx.clamp.clamps[]` (part, uid, size, mouth, dir) |
| Presses | server only: per pilot, the last press (what, with whom, tick) |
| A link | `{leader, follower, lc, fc, offset {ox, oy, oa}, tick}`: the decision record (`clampLink`); server table and every holding client's |
| The pair's body | the leader's `FlightBody`, stepped as the pair (3.3); the follower's pose is `followerPose(leader, offset)` every tick |

### 3.3 The joined flight (shared, package K)

The pair is stepped by one deterministic step in common (new `common/src/sim/clampPair.ts`), the same on the server,
the steering pilot's own tick layer, the other pilot's tick layer and every replica:

- **Body**: the pair is flown at the leader's `FlightBody` (pose = the leader's centre of mass). The step uses a
  joined flight view of the two rebuilds, `joinDerived(leader, follower, offset)`: mass and full mass summed, centre
  of mass and inertia by the parallel axis rule, both ships' thrusters (rotated into the leader's frame, torque about
  the joined centre), manoeuvre force and turning torque summed, drive and boost thrust-weighted. Cached per (both
  rebuild counts, offset): it changes only when either ship rebuilds. The joined body's position is the joined centre
  of mass; the leader's pose is derived back from it after each step, then the follower's from the leader's
  (`followerPose`), both rounded as ships are (`quantizeShipBody`).
- **Controls**: the leader's input (bits, aim, boost) flies the pair. The follower's flight input is ignored (its
  control bits are `CTL.hold` for its replica, which the link overrides anyway).
- **Power**: each ship's engines are paid by that ship's own stores; the pair's engine share is the lower of the two
  ships' shares, quantised on the CTL power grid (`ctlOfPower`), and goes in the leader's control bits, so replicas fly
  the pair from the leader's bits alone.
- **Contacts**: the two linked ships never collide with each other (skipped in `contactCandidates`). A contact on
  either is applied to the pair body (impulse at the contact point, about the joined centre of mass).
- **Jump, dodge, tow**: no jump while docked (it breaks the link). A Burst Strafer dodge on either ship is refused
  while docked (first cut). Each ship's tow beam works as now; its cargo mass adds to the pair.

### 3.4 Messages (`common/src/network/clampProtocol.ts`, foundation)

- Up: `clampDock {with, clamp, theirs}`, `clampSwap`, `clampUndock`. Rate-limit (about 4 a second).
- Down: `clampAsk {from, what, until}` to the other pilot; `clampLink {tick, leader, follower, lc, fc, offset}` to every
  client holding either ship (also on a swap, and again to a client that comes to hold them); `clampBreak {tick, a, b,
  why}`.

### 3.5 Determinism and prediction

- Lock, swap and undock are decision records at a server tick. The pair's motion is the shared step from those
  records and the leader's inputs: no positions are streamed for the follower. The follower's replica is driven by the
  link (`ShipReplicaSet.setDriver`, as bodies drive bosses) and the server's Replication shadow for the follower uses
  the same driver, so it never asks for keyframes while the pair flies as the records say.
- **The steering pilot** predicts the pair on its own tick layer (its own ship is the leader; it holds the follower's
  structure and rebuild). **The other pilot** predicts its own ship as `followerPose` of the leader's replica, so their
  view is the leader's replica plus the usual PT/ST prediction of another ship: smooth, a round trip behind on the
  steering inputs, and no input delay for anyone. Their own guns aim and fire from their own predicted pose as today.
- A lock arriving late on a client: it snaps the follower to `followerPose` at the record's tick and re-steps from
  there (the existing re-step path).

---

## 4. Field fabrication hook (M)

`FieldJobKind` gains `rearm` (`uid` = the bay, `count` = mines). The job order (econ/field/order.ts) puts rearming
after repairs and builds. Cost and time: `rearmBill(n)`, `rearmWork(n)` (`REARM`, rules.ts). The core's own fabricator
can rearm too (starter materials only). `fieldText.ts` says "Making mines".

---

## 5. The foundation (committed)

- `common/src/ships/weaponGroups.ts` (+ test): masks, the selection byte, `gunTriggered`, the trigger word, cycling.
  `PlacedPart.wg`, kept by blueprint parsing (weapons only).
- Inputs: `ClientInputMessage.weaponGroups`, base layout 0x04, compact `CI_EXTRA.GROUPS`, ECS `Input.weaponGroups`,
  `INPUT_NUMBERS`, the server's copy and `keepGroups` (dropped inputs keep their selection). Tests in
  `inputCompact.test.ts`.
- Parts: `mine_bay`, `docking_clamp`, `docking_clamp_heavy` (models.mjs block "Mine Bay and Docking Clamps", recipes
  with placeholder costs), `FunctionDef.mineBay` / `clamp`, validateGameData keys, wire dictionary.
- Features: `common/src/ships/features/minebay` (derive `fx.minebay`, describe, `minebay.ts` rules + test, contract
  test) and `features/clamp` (derive `fx.clamp`, describe, `clamp.ts` geometry + test, contract test); stub server and
  client halves for both (registries generated and final).
- Field: `FieldJobKind 'rearm'`, `FieldJob.count`, `REARM`, `rearmBill`, `rearmWork`.
- Protocol: `weaponGroupsProtocol.ts`, `minesProtocol.ts`, `clampProtocol.ts`, unioned into `ClientMessage` /
  `ServerMessage`. **PROTOCOL_VERSION 64** (one bump: the input layout and the dictionary). Frame hash golden re-pinned
  (version and the new Input field only).

No package needs another protocol bump unless it changes a wire table (keyframes, packed tables, the input layout). If
one must, it says so in its report and Integrate bumps once.

---

## 6. The work split

Each package works on `refactor/split` in its own worktree branch (`groups-weapon`, `groups-mines`, `groups-clamps`),
runs only its own tests plus `npx tsc -p <pkg> --noEmit` for the packages it touched, rebuilds common after changing
it, and commits by explicit path. Never `git checkout/restore/stash/reset/clean`. Modular layout: behaviour in feature
folders and per-feature modules; GameServer.ts, ShipBridge.ts, Game.ts, Renderer.ts and HangarUI.ts get at most
one-line wiring each.

### G: weapon groups

Owns:
- `common/src/ships/guns.ts` (per-gun trigger), `common/src/ships/state.ts` (`trig`), `common/src/sim/guns.ts`,
  `common/src/sim/state.ts`, `common/src/sim/a-adapt.ts`, `common/src/sim/ring.ts`, `common/src/sim/headHash.ts`
  (gun-state fields only), `common/src/sim/otherGuns.ts` (gun row bits, `gunSync` `trig`), `common/src/sim/ownStep.ts`
  (`OwnInputExtras.sel` only), `common/src/ships/weaponGroups.ts` (extend if needed).
- `server/src/ships/bridge/weapons.ts` (stepWeapons builds the word), `server/src/net/guns/GunNet.ts` (gunCtlOf),
  new `server/src/net/handlers/weaponGroups.ts` (the `weaponGroups` message: weapons only, live blueprint and saved
  record updated, design hash changes so others resync; one registration line in GameServer.buildMessageHandlers),
  `server/src/net/MessageLimits.ts` (its line).
- Client: `client/src/app/inputSend.ts` (send the selection on change and on the first input after welcome/respawn),
  new `client/src/ships/weaponGroups/` (selection state, cycling, the HUD chip, the hangar and field-overlay editors),
  `client/src/input/keybindings.ts` (the three actions), `client/src/ships/own/OwnTick.ts` (noteExtras' selection
  only), `client/src/ships/guns/OtherGuns.ts`, `client/src/ships/gunHud.ts` + `client/src/ui/WeaponRing.ts` (group
  view), `client/src/settings/Settings.ts` + the Gameplay rows in `GameMenuUI.ts` (the two opt-in settings),
  one-line hooks in `HangarUI.ts` and `client/src/ships/field/FieldOverlay.ts`, `ShipClient.ts` line ~1937 (copy
  `trig`).
- Docs: `docs/areas/weapons.md` ("Either mouse button fires every weapon" becomes the groups rule), `ui-hud-input.md`.

Implement: sections 1.1-1.4. Tests: per-gun want with the default selection identical to today (the parity goldens
`server/src/golden/parity.test.ts` and the volley agreement `server/src/net/replication.test.ts` unchanged); a group
fires only its members; right-click group on a mining ship; slew and semi-auto per gun across a selection change; a
selection change mid-burst agrees on server, own prediction and another client's lane (extend `common/src/sim/b-guns.test.ts`
or a new `weaponGroups.parity.test.ts`); inputSend sends the selection once per change; the field-overlay message
updates the live ship and other clients' lanes. Run: `common/src/ships/fireModels.test.ts`, `common/src/sim`,
`server/src/golden/parity.test.ts`, `server/src/net/replication.test.ts`, `server/src/game/weapons2.test.ts`,
`client/src/app/inputSend.test.ts`, `client/src/ships/gunHud.test.ts`, your new tests.

Do not touch: the input wire layout (done), `features/minebay`, `features/clamp`, flight files, `replication.ts`.

### M: the Mine Bay

Owns:
- `common/src/ships/features/minebay/` (rules may be extended; keep `MINES` the one place), `common/src/econ/field/order.ts`
  (rearm in the job order) and `record.ts` (`FieldRecord.mines`, cleaned).
- `server/src/ships/features/minebay/` (fill the stub: a `Minefield` module with magazines, the `mineDrop` handler via
  `messages`, live drops and their mines, the trigger pass each tick in `tick()` using a spatial query of ships, blasts
  through the bridge's `splashAt`, expiry, the cap, clears on death/leave via `onLeave`, `minesLaid` to holders and
  late joiners, `minesGone`, `mineBay`). Add to `FeatureHost` (server features/types.ts) only the narrow calls it needs
  (party check, splash, holders of an entity), wired in GameServer by one line each.
- `server/src/game/field/FieldShips.ts`: the `rearm` job (start, finish into the magazine) — only the rearm branches.
- `client/src/ships/features/minebay/` (fill the stub: the drop action `Digit0` "Drop mines", the magazine chip and
  ready ring, drawing mines from drops (a pooled layer; armed blink, owner's in their colour, others red), the blast on
  `minesGone`, the predicted own drop), its server-message entries in `client/src/app/serverMessages.ts` (three lines).
- `client/src/ships/field/fieldText.ts` (done: "Making mines"), the field HUD's rearm line if needed.
- Docs: `docs/areas/weapons.md` (a Mine Bay note), `ship-parts.md`.

Implement: section 2 and 4. Tests: a drop record gives the same mines on server and client (positions, arming,
expiry); owner and party never trigger; armed and in reach triggers once; blast damage through `hurt` (shields take
it); cap fizzles oldest; magazine counts and cooldown; rearm job order and cost; `minesLaid` resent to a late joiner;
the own predicted drop adopted. Run: `common/src/ships/features/minebay`, `common/src/econ/field`, your server and
client tests, `server/src/game/field` tests.

Do not touch: guns.ts / the weapon step (a mine bay is not a gun), the input layout, `features/clamp`, flight.

### K: Docking Clamps

Owns:
- `common/src/ships/features/clamp/` (rules may be extended), new `common/src/sim/clampPair.ts` (joinDerived, the pair
  step, the follower driver) + tests, the link override in `common/src/network/replication.ts` (`ShipReplicaSet`: a
  link drives the follower and steps the leader as the pair; use the existing `setDriver` seam), and the skip of the
  linked pair in `common/src/ships/contactPass.ts` `contactCandidates`.
- `server/src/ships/features/clamp/` (fill the stub: presses, the lock decision with the server-side lined-up check,
  swap, undock, breaks, `clampAsk`/`clampLink`/`clampBreak` to holders and late joiners) and a new
  `server/src/ships/bridge/clamp.ts` (the pair step on the server's real ships, the follower placed each tick, contacts
  folded into the pair), wired by one line each in `bridge/flight.ts` (the per-tick loop) and ShipBridge.ts; the
  Replication shadow's follower driver in `server/src/net/Replication.ts` (its own small hook); the jump and station
  breaks via the existing jump start and `Docking` berth paths (one call each).
- Client: `client/src/ships/features/clamp/` (fill the stub: the prompt overlay from `clampLinedUp` at prompt slack,
  `onKey` for H while relevant and the swap action `Minus`, "waiting for <name>" from `clampAsk`, a docked chip "Docked
  with <name> · you steer / <name> steers · H undock · Minus swap", the clamp glow), the own-ship side in
  `client/src/ships/own/OwnTick.ts` (flight lines only: leader steps the pair, follower rides the leader's replica),
  the PT/ST layer hook if the follower needs one (`client/src/predict/`), its server-message entries in
  `client/src/app/serverMessages.ts` (three lines).
- Docs: `docs/areas/flight.md`, `networking.md` (the link records).

Implement: section 3. Tests: `clampOffset`/`followerPose` exact; the pair step is the same on server, steering pilot,
other pilot and a third client's replica for 600 ticks of scripted leader input (parity test beside
`server/src/golden/parity.test.ts`, new file); swap keeps the pose continuous; no keyframes for the follower while
linked (Replication shadow); each break; the prompt shows at slack and the lock refuses outside tolerance; weapons
still fire per owner while docked. Run: `common/src/ships/features/clamp`, `common/src/sim`,
`common/src/network/replicaSmoothing.test.ts`, `server/src/net/replication.test.ts`, `server/src/golden/parity.test.ts`,
`common/src/ships/ships.test.ts`, your new tests.

Do not touch: guns.ts and the gun-state chain (G), the input layout, `features/minebay`.

### Shared files and expected conflicts

`client/src/app/serverMessages.ts` (M and K add entries), `client/src/ships/own/OwnTick.ts` (G: input extras; K:
flight), `common/src/sim/ownStep.ts` (G: input extras; K may read a link), `docs/areas/weapons.md` (G, M). Keep edits
to those small and in separate places; Integrate resolves the merge. Generated files (`registry.ts` and the two
feature `index.ts`) are final; rerun `npm run features:gen` only if a feature is added (none should be).

### Integrate (after G, M, K)

Merge the three branches, `npm run features:check`, `npm run build:common`, tsc for common/server/client, then the
full suite once (`npx vitest run --maxWorkers=4`). Then a dev-server check with two pilots (Kieran): groups switching
mid-fight, a mine field and a party member flying through it, two ships docking, swapping and undocking.

---

## 7. Knobs to playtest

`MINES` (arming 1 s, reach 40, blast 140 / 110, life 90 s, cap 24, eject and slide), the bay's batch 4 / magazine 12 /
cooldown 2 s, `REARM` (3 s and 1 alloy + 1 wire a mine), `CLAMP` (30 / 10 u, 10 degrees, 2 u/tick, slack 1.5, 3 s
press window, undock push, relock 2 s), part unlocks (Mine Bay L8, Clamp L4, Heavy Clamp L16) and recipes.
