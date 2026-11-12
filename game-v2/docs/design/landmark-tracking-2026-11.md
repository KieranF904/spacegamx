# Landmark tracking ("orbit with"), 2026-11

Built 2026-11-12. Code: `common/src/world/landmarks.ts` (rules, records, maths), `common/src/sim/step.ts` (the carry
in the step), `server/src/game/pilots/persist.ts` (the save), `client/src/ships/jump/JumpControl.ts` (the client's
copy of the records, the HUD cue).

## What it does

- A pilot's ship near a moving landmark is carried along with it, automatically.
- Inside the landmark's inner radius the ship tracks it exactly: park there, go AFK, and you are still beside it.
- Between the inner and outer radius the carry fades smoothly from all of the landmark's move to none.
- Logging out inside a zone saves the landmark and your offset from it; logging in puts you back at that offset from
  wherever the landmark is then.

## Which landmarks

Only landmarks that move have a zone (a ship that keeps still stays beside a fixed one anyway).

| Kind | Which | Inner radius (default) | Example |
|---|---|---|---|
| Station | one with an `orbit` (today: Sol Central only) | its docking ring, `stationInteractRadius(radius, design)` | Sol Central: 3600 |
| Planet | `orbit.period` above 0 | 1.5 × radius, at least radius + 900 | Vesta 1800, Jovan 6450 |
| Moon | its planet or the moon itself moves | same rule on the moon's radius | Selene 1160 |
| Stillstone | one with an `orbit` and a period | its charging field, size + `jump.lodestoneField` | 2250 to 2450 in Sol |

- Outer radius (default): 2 × the inner radius, so the fade band is as wide as the inner zone.
- Data can set its own: `tracking: { inner?, outer? }` on a station (stations.json), a planet, a moon or a stillstone
  (systems.json). `outer` absent: twice `inner`.
- Not landmarks: fixed stations and stillstones, nests, comets, asteroids, gates, the Helios Array.
- Systems where nothing moves have none: the training yard, the gun range, surfaces, siege moons, homesteads.
- Sol has 17, the eight main systems 53 in all.

## The rules, exactly

- **Weight** at distance `d` from the landmark's centre: 1 for `d <= inner`; 0 for `d >= outer`; between,
  `1 - u*u*(3 - 2u)` with `u = (d - inner) / (outer - inner)` (a smoothstep: continuous, slope 0 at both edges,
  never rising with distance).
- **Carry** on tick `t`: the landmark's move from tick `t - 1` to `t`, times the weight where the ship stood as tick
  `t - 1` ended. The landmark's positions are rounded to the ships' position grid (0.01) first, so a ship carried at
  weight 1 keeps its offset exactly, for any length of time.
- **A displacement, never a velocity.** Velocity stays in the world frame and is untouched: the HUD speed, thrust FX,
  friction and shots' inherited velocity are as before. An idle ship in the inner zone has velocity 0.
- **Where in the step**: `stepShipMotion`, straight after the ship's own physics, before the charging fields are read,
  before guns and pulls. The position is rounded to the grid again after it.
- **Overlapping zones**: the strongest weight wins. A tie goes to the landmark with the smaller inner radius (a moon
  inside its planet's inner zone wins there). There is no blending: where the winner changes, the carry's rate changes
  (by at most the two landmarks' relative speed, under 1 unit a tick), the position never jumps.
- **Rotation**: not included. Translation only.

## Who is carried

- Carried:
  - Pilots' ships (`ReplicaMode.Player`), on the server, on the pilot's own client and on every other client's
    replica of them.
  - Debris: in the debris world's shared step (`stepDebrisWorld`, the server's and every client's), after each
    piece's drift and before the knocks, by the same per-tick weight rule as a ship.
  - Loot pods (a lost ship's wreck is one): a pod is not stepped, both ends place it from its drift anchor, so its
    carry is a closed form too. The zone and weight are taken once, where the anchor was laid (`podHold`), and kept
    until the pod is anchored again (a tractor, a bounce); the pod is then at `podDrift(anchor) + weight × (the
    landmark's move since the anchor's tick)`. Dropped in an inner zone it stays by the landmark exactly. Dropped in
    the fade band it follows at that weight for as long as it lasts (it does not fade out as it falls behind). Dropped
    in open space it is never picked up by a landmark passing later.
- Not carried:
  - AI ships. A pinned ship (a fixed boss, a derelict, a siege structure) is put back by the server every tick, and
    bosses, mobs and guided shells have their own client-side runners (bodies, moves, guides); each would need the
    carry and the pinned flag. Left out.
  - Anchored wrecks (derelicts): fixed features of the map, which a planet passing by must not sweep off their spot.
  - Projectiles, asteroids.
  - A ship mid-burn in a jump (the burn lands where the jump overlay says).
  - A ship docked at a station (it already rides the station).
  - A Docking Clamps follower: it sits where its leader is put, and the leader is carried.
- Consequence: AI ships and derelicts stay in the world frame, so beside Sol Central (72 units a second) they slide
  past a parked pilot unless they fly. Planets move at 10 to 14 a second, moons at 15 to 40.

## Netcode

- Nothing is sent per tick. Both ends derive the carry from the tick and the system's landmark records.
- The server builds the records once a system (`GameServer.replicaEnv(num).landmarks`, from stations.json,
  systems.json and the jump tuning) and sends them once, in `systemInfo.landmarks` (a plain JSON field, about 1.6 KB
  for Sol). The client keeps them in `JumpControl.landmarks` and hands them to the replica env.
- A record: `{ id, name, inner, outer, c?: [radius, phase, period]*, k?: [type, a, e, argP, M0, epoch, timeScale], r?: 1 }`.
  `c` is circles summed (planet; planet + moon); `k` is a station's orbit, in single precision as the server's station
  entity holds it; `r` rounds to whole units (stillstones).
- The empty scene sends none.
- A pod's hold is not sent: the server keeps it on the anchor, a client works it out from the anchor row it was sent
  (position to a tenth, as the row carries it).
- `LANDMARK_CARRY_RULE` (landmarks.ts) is in the wire hash (`network/wireHash.ts` layouts): an older client would
  step without the carry, so the rule's arrival, and any later change to it, is a protocol bump.
- Checked by `server/src/net/own/landmarkCarry.test.ts`: a pilot flown through the fade band and the inner zone gets
  no keyframe, control row or ownSync, and every head hash agrees; a watcher's replica is exact.

## Persistence

- `profile.position` gains an optional `at: { id, dx, dy }` beside `system, x, y`:
  - `id`: `station:<id>`, `planet:<id>`, `moon:<planet id>:<index>` or `stone:<id>`.
  - `dx, dy`: whole units from the landmark's centre.
- Written by `capture` (the one path for logout, a dropped link, autosave, shutdown) when the pilot is in any zone,
  inner or fade band. In open space the field is absent. `x, y` are still the absolute spot.
- Read by `applyProfile`: with `at` and a landmark of that id in the system, the pilot is placed at the landmark's
  position at the system's current tick plus the offset (so a restart, whose ticks start over, is covered). Otherwise
  the absolute `x, y`, as before.
- `migrateProfile` keeps a well-formed `at` and drops a broken one. No profile version bump: a save without the field
  loads exactly as it did.
- The usual checks still apply to the restored spot (`safeToAppear`, arenas, the training yard).

## Client

- The own ship and other pilots are drawn between stepped states, so the carry is in what the camera follows.
- HUD: a "Holding" status icon (`ui/hud/statusEffects.ts`, id `holding`) while a landmark carries the ship, with the
  weight as a percentage; its tooltip names the landmark ("Holding with Sol Central Station").
- Known small offset: a station is drawn at the server's tick and the own ship at the prediction's tick, so a parked
  ship sits a steady few units ahead of where the server has it against the station (the lead in ticks × the station's
  speed). It does not jitter.

## Tests

- `common/src/world/landmarks.test.ts`: the weight curve; the game's records; idle 12 minutes by the station and by a
  moon with zero drift; the fade band; entering and leaving without a jump; server step against replica step to the
  bit; mid-burn and AI ships not carried; the save's offset.
- `server/src/net/own/landmarkCarry.test.ts`: the real server, a fake client's own layer and a watcher.
- `server/src/game/pilots/landmarkLogin.test.ts`: logout in a zone then login later and after a restart; open space;
  an old save; a landmark that is gone.
- `common/src/econ/econ.test.ts`: `migrateProfile` and `position.at`.
- `server/src/game/landmarkPodsDebris.test.ts`: pods at rest, flung and in the fade band beside Sol Central for two
  minutes (the anchor never laid again, the client's placement the server's); a ship blown apart there, its pieces
  exact on a watching client at every snapshot.
- `client/src/ui/hud/statusEffects.test.ts`: the Holding status.

## Not done

- Carry for AI ships and derelicts (see above).
- Stations drawn at the own ship's tick.
- Blended overlaps.
