# Tutorial (the training yard): foundation interfaces

Design (agreed with Kieran): new pilots start in ONE shared safe yard at Vesta in Sol (stationary station, rocks, drones, markers). Per pilot: the steps done and a damage counter per training object. Skip any time (`tutorialLeave`) or graduate: the starter pack, then a one-way exit into Sol. Existing profiles are marked left.

## Data: `data/tutorial.json` (shapes in `types.ts`, checked by `validateTutorialData`, run by the server's data validation)
- `yard`: system, station id (`data/stations.json`, `tutorial: true`), `center`, `spawnRadius`, `leash` (trainees held in), `keepOut` (others kept out), `stopSpeed`/`stopTicks` (a stop).
- `steps[]`: `id, title, lines[1-2] (with {action} key names), trigger {kind, objects?, panel?, item?, count?}, targets?, grant?`. First is `welcome`, last `graduate`.
- `objects[]`: `id, kind (rock|drone|ring|zone|exit), step, at (offset from yard.center), radius, hp?, drops?, chunks?, label?`. `rock`/`drone` are real asteroid entities (fixed orbit, never lose hp, asteroid index `TUTORIAL_INDEX_BASE + position in objects`, told to clients as an `asteroidSpawn`); `ring`/`zone`/`exit` are markers (no entity; the client draws them).
- `starterPack {credits, items}`: granted to storage on leaving.
- `TutorialObjectDef`s have world position `objectPos(data, o)`.

## Saved state: `PlayerProfile.tutorial: TutorialProfile { step, done[], left, hits? }`
`newTutorial()` for new profiles; `cleanTutorial(raw)` in `migrateProfile` (absent/junk = `left: true`, so existing pilots never enter). `objectLive(t, o)`: live unless the step is done or the pilot broke it. `hits[objectId]` is that pilot's damage on the object; at `hp` it is broken for them alone.

## Messages (`network/tutorialProtocol.ts`; JSON only, no wire-table change, no PROTOCOL bump)
- client -> server `tutorialLeave` (confirm with the pilot first), `tutorialReport {kind: 'ack'|'panel', step?, panel?}` (the Continue button, a panel opened; panels in `TUTORIAL_PANELS`).
- server -> client `tutorialState {step, done[], left, broken[]}`: to that pilot alone, on join and on every change. `step` is '' once left. Ghost an object when `done.includes(o.step) || broken.includes(o.id)`. Client store: `client/src/ui/tutorial/tutorialStore.ts` (`onTutorial`, `ghosted`, `currentStep`, `tutorialData`).

## Server: `server/src/game/tutorial/`
- `Tutorial` (reached as `gs.tutorial`, undefined unless the server runs a tutorial: `GameServerOptions.tutorial`, `index.ts` TUTORIAL env: on in production, on the dev server with `TUTORIAL=1` which also replaces the Rockery start, `TUTORIAL=0` off):
  - `hit(bodyEid, shooterEid, damage): boolean` (the three asteroid damage sites call it: `hurtAsteroid`, `mineBeam`, `beamAsteroid`; true = a training body, caller does nothing else).
  - `onEvent(pid, ev: TutorialEvent)`; `subscribe(fn(conn, ev))`; events emitted by the foundation: `objectBroken`, `ringPassed`, `zoneStopped`, `docked`, `jumped {x,y,exit?}`, plus `ack`/`panelOpened` from `tutorialReport`. Not yet emitted (other modules call `tutorial.onEvent`): `collected`, `refined`, `partPlaced`, `powered`.
  - `completeStep(conn, stepId)` (the engine's one way to advance; zeroes the next step's counters), `resetObjects(conn, step)`, `leave(conn)` (pack, home reset, exit, quests opened, state sent), `sendState(conn)`, `active(conn)`, `spawnFor(conn, resume)`, `objectOf/isBody/entityOf/def`.
  - `tick()` ('tutorial' entry in the world phase): rings/zones/jumps for trainees, the leash (turned back to the yard), the keep-out (a pilot who has left is sent to Sol's start).
- `TutorialSteps.advance(pid, ev)`: the STUB. Handles `ack` on the welcome step and `graduate`. The next stage fills in a case per trigger kind (see the header comment).
- Owner-only drops: `LootPods.keepPrivate(pod, key)` / `visibleTo(pod, key)`; the snapshot skips another pilot's private pods.
- The yard's station (`sol_station_yard`) and bodies exist only on a server with a tutorial. `GameData.getAllStations()` leaves the yard out.
- Hooks: `Pilots.tutorialSpawn` (new/returning trainees appear in the yard, respawn at its station), `Quests` `holdStarters` (beginner jobs wait until the pilot leaves), `Docking` `docked`.

## Caveats for the next stages
- A drone is an asteroid body, so the client draws a drone model where the asteroid for index `TUTORIAL_INDEX_BASE + i` is (hide the rock look); shells stop on it like on a rock. Hits count for guns and mining beams.
- The old client tour (`client/src/ui/Tutorial.ts`) still runs for everyone; retire or gate it on `inTutorialNow()`.
- Left pilots are still told of the yard's bodies when they enter Sol (they cannot reach them); the client may skip indices `>= TUTORIAL_INDEX_BASE` once `left`.
