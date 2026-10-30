# Engine map (modular-ships prototype, Step 0)

Written before any ship code, against `master` @ `c407ce1` plus the working-tree changes present on 2026-10-19.
All paths are relative to `game-v2/`. Line numbers are approximate and drift as files change.

## Layout

| Package | Path | Runs in | Notes |
| --- | --- | --- | --- |
| common | `common/src/` | client + server | ECS components (bitecs), protocol, shared physics, data schemas. Imported as `@space-game/common` (Vite alias on the client, `file:` link on the server). |
| server | `server/src/` | Node | `GameServer.ts` is the authoritative simulation (one 4.5k-line class). `systems/` and `world/` exist but are **not used** by `GameServer` (it has its own inline systems). |
| client | `client/src/` | browser | PixiJS 8 renderer, `Game.ts` orchestrates net/input/render/UI. `sandbox.ts` is a separate visual tuning tool. |
| data | `data/*.json` | server | Items, systems, enemies, NPCs, stations, quests. Loaded by `server/src/data/GameData.ts`. |

## Q1. Where is the ship entity defined, and where are its hardcoded stats?

There is no ship type: the "ship" is a **player entity** built from generic components.

- Entity creation: `GameServer.createPlayer()` — `server/src/GameServer.ts` ~L803. Adds `Position, Velocity, Rotation, Radius, Health, Shield, Player, Input, Boost, Equipment, EquipmentStats, Inventory, WeaponState, InSystem, NetworkSync`.
- Component definitions: `common/src/ecs/components.ts`.
- Hardcoded stats, all in `common/src/constants.ts`:
  - Movement: `ACCEL_BASE = 0.22`, `TURN_SPEED = 0.08` rad/tick, `FRICTION = 0.985`, `BOOST_FACTOR = 2.2`, `BOOST_*` fuel values.
  - HP/shield: `PLAYER_MAX_HP = 100`, `PLAYER_MAX_SHIELD = 50`, regen values. `PLAYER_RADIUS = 20` (collision circle).
  - Fire rate: `FIRE_COOLDOWN_TICKS = 10`, divided by the weapon item's `fireRate` in `GameServer.fireWeapon()` ~L2423. Bullet: `BULLET_SPEED = 64`, `BULLET_DAMAGE = 14`, `BLASTER_LIFE_TICKS = 180`.
- Equipment modifiers (booster/cockpit items) feed `EquipmentStats` in `GameServer.updateEquipmentStats()` ~L893, but `accelMultiplier` is **not** passed to the physics step today.
- Visual shape: the triangle is drawn in `client/src/rendering/Renderer.ts` `createPlayerGraphics()` ~L808. `SHIP_TIP_OFFSET` there is the laser muzzle offset.

## Q2. Where do the server tick and client frame loop run, and at what rate?

- `TICK_RATE = 60` Hz, `TICK_MS ≈ 16.67`, `SNAPSHOT_RATE = 20` Hz — `common/src/constants.ts`.
- Server: `GameServer.gameLoop()` ~L2134 is a fixed-step accumulator (max 4 catch-up ticks) scheduled with `setTimeout`/`setImmediate`. Each step calls `drainInputQueue()` then `tick()` ~L2222, which runs the inline systems in order: orbits → spatial grid → `playerMovementSystem` → boost regen → weapons → projectiles → missiles → mines → mining → enemy AI → spawns → `collisionSystem` → asteroid death → regen → lifetime → cleanup. Snapshots are sent every `TICK_RATE / SNAPSHOT_RATE` ticks.
- Client: Pixi ticker → `Game.update()` ~L397 (render rate). Inside it a fixed 60 Hz accumulator runs `tickInput()` + `GameState.drainDelayQueue()` (prediction), then `GameState.interpolate()` and `Renderer.update()`.

## Q3. How does player input get from the keyboard to the simulation?

1. `client/src/input/InputManager.ts` tracks keys/mouse.
2. `Game.tickInput()` ~L508 samples WASD/Shift/mouse buttons each 60 Hz tick, computes the cursor angle (quantized via `quantizeCursorAngle`), stamps `targetTick = cachedServerTick + inputDelayTicks`, and sends a `ClientInputMessage` **only when it changed**. Every tick is also queued locally for prediction.
3. `NetworkManager.send()` → `encodeMessage()` (`common/src/network/protocol.ts`, binary for inputs).
4. Server `handleMessage()` ~L936 pushes inputs to `inputQueue`; `drainInputQueue()` schedules them by `targetTick` per connection and `applyInputToEntity()` ~L1037 writes `Input.*` components.
5. `playerMovementSystem()` ~L2317 calls the shared `stepPlayerPhysics()` (`common/src/physics/PlayerPhysics.ts`). Movement is **screen-relative** (W = world −y) and the ship turns toward `targetAngle` at `TURN_SPEED`.

## Q4. How are entities rendered, and how is collision tested?

- Rendering: snapshots → `GameState.applySnapshot()` buffers → `GameState.interpolate()` produces `renderX/renderY/renderAngle` → `Renderer.update()` creates/updates one Pixi `Container` per entity id via `createEntityGraphics()` ~L769 (switch on `EntityType`).
- Collision (server only): a per-tick `SpatialGrid` (class at the top of `GameServer.ts`, 500-unit chunks, built in `buildSpatialGrid()` ~L2256). `collisionSystem()` ~L3394 ray-queries the grid per projectile and does **circle-vs-circle** tests (`Radius` component). Player shots only test enemies and asteroids; enemy shots test players. There is no ship-vs-ship collision. Asteroids use polygon raycasts (`common/src/asteroid/polygon.ts`).

## Q5. What code is shared, client-only, server-only?

- Shared (`common/src/`): `constants.ts`, `ecs/components.ts`, `physics/PlayerPhysics.ts` (must stay identical for prediction), `network/protocol.ts` + `stateHash.ts` + `cursorState.ts`, `networking/*` (BitBuffer, quantization), `asteroid/*` (deterministic orbits/polygons), `data/*` schemas and registries, `starfield.ts`.
- Server-only: everything in `server/src/` — `GameServer.ts`, `AdminServer.ts` (separate HTTP/WS dashboard on :3005), `auth/*` (user stores), `data/GameData.ts`.
- Client-only: everything in `client/src/`.
- Node coupling in server code before this branch: `GameServer` imported `http`, `path`, `ws` and created its own HTTP/WebSocket server in the constructor; `GameData` read files with `fs`.

## Q6. What does the network layer send for a ship today?

- Snapshot `EntityState` (`common/src/network/protocol.ts` ~L193): `id, type=Player, x, y, angle, vx, vy, hp, maxHp, shield, maxShield, name`, plus `data[]` carrying packed cursor/weapon state (`packCursorWeaponState`, see `CURSOR_STATE.md`). Delta-compressed per client in `GameServer.sendSnapshots()` ~L3923.
- `playerState` message (own ship only): hp, shield, boost fuel, xp, level, credits, systemId.
- `damage`, `death`, `effect` events.
- Client sends a 1 Hz `stateHash` of the predicted state; a mismatch forces a full snapshot.

---

## Prototype integration (what this branch adds)

### Running it

- `npm run proto` (in `game-v2/`) starts Vite and opens `/?proto`: GameServer runs in the browser tab behind a `LocalTransport`. No server process, no login, empty scene.
- `/?proto&legacy=1` flies the old triangle ship (`ships.legacy = true`).
- `npm test` runs every test (vitest, headless, CI-safe), including the 600-tick × 10 replay.
- In flight: **H** hangar · **K** damage part under cursor · **J** repair · **B** spawn dummy (blueprint picked in the admin panel) · **V** switch mouse-steer / helm controls · **R** respawn after death.
- Helm controls: A/D turn, W/S thrust along the nose, Q/E strafe; the mouse aims turrets. Ships with turrets start in helm mode.

### Where things live

| Path | What |
| --- | --- |
| `common/src/ships/` | All ship logic. Pure, deterministic, plain data. `catalog.ts` (loader, 8 variants, validation), `geometry.ts`, `grid.ts` (overlap, joins, facing), `blueprint.ts` (validation, serialisation), `rebuild.ts` (structure, flow, derived stats, weapons), `state.ts`, `flight.ts`, `shot.ts` (`buildShot` seam), `rng.ts`, `tuning.ts`. |
| `server/src/ships/ShipBridge.ts` | Engine glue: attaches ShipState to entities, runs flight/weapons/part hits/contacts/rebuild/debris at GameServer's hook points. |
| `server/src/ships/replay.ts` | Determinism harness (record inputs, replay, hash). Used by the CI test and the admin-panel button (in a Web Worker). |
| `server/src/net/SocketTransport.ts` | Node HTTP + WebSocket front end (moved out of GameServer). |
| `server/src/net/LocalTransport.ts` | In-process transport (same `ClientTransport` interface as `NetworkManager`). |
| `server/src/proto/createProtoServer.ts` | Browser-safe GameServer factory: empty scene, no accounts, optional ShipBridge. |
| `server/src/data/loadGameDataFromDisk.ts` | Node-only JSON loading (moved out of GameData). |
| `common/src/network/Transport.ts` | `ClientTransport`, `ClientSocket`, `ClientLink`. |
| `client/src/ships/` | Client-only: `ShipRenderer`, `ShipHud` (core HP + schematic), `HangarUI`, `ProtoTools` (keys, admin panel), `replayWorker`, `blueprintApi`. |
| `client/src/proto/protoMain.ts` | Proto entry, lazy-loaded from `main.ts` only when `?proto` is set. |
| `client/shipsDevApi.ts` | Vite dev-server middleware so the hangar can list/read/write `data/ships/blueprints/*.json`. Serve-only, never in a build. |
| `data/ships/` | `pieces.json`, `functions.json`, `materials.json`, `inventory.json`, `tuning.json`, `blueprints/` (Sparrow T, Bulwark, Arrow, Drum, Corsair). |

### Decisions where the spec left room

- **Connector diagonals:** `'NW'` is the `\` diagonal (NW to SE corner), `'NE'` the `/` diagonal.
- **Rotation pivot:** variants rotate about the origin cell's centre, so a multi-cell piece's footprint can extend into negative offsets.
- **Straight-edge rule:** the spec says every straight edge lies on a cell boundary or diagonal, but `slope2`'s hypotenuse runs 2:1. The loader enforces "straight edges run between grid corners" instead, which covers all three.
- **Demand is per unit of area**, like `produce` and `thrust`.
- **Conduit loss:** a consumer whose shortest path from a generator crosses conduits with total loss L draws `demand × (1 + L)` to receive `demand`.
- **Thrust direction:** movement stays screen-relative (legacy controls). The force along the input direction is the sum of thruster projections, floored by `flight.coreManeuverForce` from the core, so a rear-thruster-only ship can still back up and strafe slowly.
- **Turning:** torque = core gyro + `thrusterTorqueGain` × each side's thruster torque about the COM. Losing a side thruster makes turning lopsided.
- **Fire control:** either mouse button fires every weapon. Fixed weapons fire straight out of their facing edge.
- **Control modes:** mouse-steer (legacy feel) and helm share one flight model; only where the commands come from differs. The mode is sent in every input (`helm` bit), so it replays deterministically.
- **Turrets** (`mount: 'turret'` on a weapon): base window ±`turret.halfArcDeg` around the facing; rays from the turret's centroid that cross another live part of the same ship are closed. `rebuild` recomputes windows, so they widen as cover is shot away. A turret slews (`turret.slewRate`) anywhere in its base window but only fires when aligned with the cursor and pointing through an open sector. All turrets aim parallel, along the ship-to-cursor angle.
- **Shot scaling:** `buildShot` scales the base shot's damage by satisfaction (min 0.1). Fire interval is scaled separately by `rebuild`.
- **HP bands** start at full HP: the first band crossing is at 75%.
- **Collisions** use the shrunk convex pieces, an impulse along the deepest-penetration normal, and damage split over the touching parts on each side, scaled by the other body's mass share. Numbers are in `tuning.collision`.
- **Feel:** `thrust` was tuned so Sparrow T covers the same distance as the triangle in 5 seconds (checked in `ships.engine.test.ts`). The triangle's effective accel is ~25% below `ACCEL_BASE` because of velocity quantization.

### Fixes to the live game found on the way

- **Respawn never worked:** the client had no handler for "Press R to respawn", and `handleRespawn` required the `Dead` component on an entity `cleanupSystem` had already removed. R now sends `respawn`, the server accepts it once the entity is gone, and `welcome` clears the death screen.

### Live game integration (modular ships replace the triangle)

- Every player flies a modular ship, server and proto alike. `GameServerOptions.ships` is required and the legacy flag is gone (the old `stepPlayerPhysics` remains only as a test reference).
- **Network:** `shipSync` (blueprint + the exact HP the server rebuilt from, sent on first sight and after every rebuild or refit) and `shipHp` (visual-only deltas). Dummies and debris travel in snapshots as `EntityType.ShipBody`. Player snapshots carry `av` (angular velocity) and `data[2]` = cursor distance.
- **Prediction:** `common/src/ships/physics.ts` `stepShipPhysics` (flight + rounding to `SHIP_PRECISION`, exactly the decimals snapshots carry) runs on both server and client, so reconciliation replays from the server's true state.
- **Client:** `client/src/ships/ShipClient.ts` (store, renderer, HUD, hangar, helm toggle, prediction hook, turret visuals) is created by `Game` in every mode. `ProtoTools` keeps only proto debug tools.
- **Refits:** the hangar sends `shipEdit`; the server checks docking (`STATION_INTERACT_RADIUS`) and validation, replies `shipEditResult`, and keeps the blueprint per connection across respawns. Proto sets `shipEditAnywhere`.
- **Controls:** interact moved from E to **X** (E/Q strafe in helm mode).

### Weapons

- `client/src/rendering/weapons/` (`WeaponFx`, `weaponStyles`) owns all projectile visuals; the old trail and muzzle-flash code left `Renderer.ts` (about 460 lines removed).
- **Bullet origins:** shots are placed from their exact spawn point and tick (snapshot `data[3..5]`, owner in `data[6]`). Your own shots run on the present timeline, everyone else's on the interpolated one. `projectileHit` (projectile id + exact point) ends a tracer where it struck.
- **Look:** thin additive tracers, small brief muzzle flashes, spark bursts. `BULLET_SPEED` 64 → 24 units/tick, `BLASTER_LIFE_TICKS` 180 → 150.

### Sectors and the rift

- **New systems:** Cinder Reach (red giant, slag belt, Ember Forge station), The Maw (black hole, shard ring), Glasswater Expanse (pulsar, ice and crystal field, Prism Relay station). Gates link sol ↔ cinder_reach ↔ the_maw and borealis ↔ glasswater; sol ↔ nebula_prime got its missing return gate. `void_sector` is still unconnected.
- **Rifts:** `rifts` in `systems.json` (`RiftData`). A `Portal` entity with `kind = 1` pulls in any player flying within 200 units and fast-travels them to `destination`, keeping momentum (3-second cooldown). One rift: Sol (8200, −1800) → The Maw.
- **Shaders:** `client/src/rendering/shaderQuad.ts` helper; `RiftShader.ts` (vortex); `CentralBodyShaders.ts` (black hole with Keplerian disk and Doppler beaming; pulsar with sweeping beams). `void_sector` now renders as the black hole its data always said it was.
- **Travel fixes:** a shared `travelTo` for gates, rifts and admin teleport; gates land you beside the gate that leads back; the client drops the old system's entities and the server resends the new one's (both were stale before).

### Cleanup after the switch to modular ships

Removed, now that every player flies a modular ship:
- **Triangle ship:** `common/src/physics/` (`stepPlayerPhysics`), the legacy movement path, the triangle graphics and engine glow, and the client's legacy prediction fallback (until a ship has synced, the client just follows the server).
- **Equipment weapons:** laser, scatter, missile, pulse, mine and mining fire paths; missile homing, mine and mining-projectile systems; equip/unequip messages and handlers; `updateEquipmentStats`; the equipment panel in `InventoryUI`; the weapon cooldown bars; all laser rendering.
- **Shields and regen:** player shields and the health/shield regen system (player health mirrors core HP).
- **Unused ECS components:** `Equipment`, `EquipmentStats`, `WeaponState`, `Shield`, `Missile`, `Mine`, `WarpBeacon`, `WarpProjectile`, `MiningBeam`, `ParticleEmitter`, `Interpolated`, `QuestProgress`.
- **Unused modules and constants:** `server/src/systems/` and `server/src/world/` (never imported), the legacy weapon and ship constants, and unused imports and private members in the files touched.
- **Kept on purpose:** `common/src/networking/` and `WeaponDefinition.ts` (uncommitted work in progress), item data and shops, v1 design constants for enemies, XP and asteroids, and `sandbox.ts`.

### Finished features

- **Saved ships:** a logged-in pilot's ships (the active one and the hangar) are in their profile (`data/profiles/<userId>.json`, `Pilots`), restored on login. Guests' refits last for the session. (`data/ships/players/` is left over from an older per-ship store and unused.)
- **Hazards:**
  - Gravity wells (`centralBody.gravity`: strength, minRadius, horizon) are part of the shared flight step, so prediction stays exact. Crossing the horizon destroys a ship and removes debris. Wells exist at The Maw and the Void Sector.
  - `systemInfo` carries `hazards`. `client/src/ui/HazardOverlay.ts` adds haze, darkness, radiation and cold treatments, warning chips, and an event-horizon alert that scales with your ship's own thrust.
- **The Void Sector** is now reachable through a gate pair with The Maw.
- **Map (M):** `client/src/ui/SystemMapUI.ts` is now full screen and zoomable/pannable, with a galaxy view (all systems, sectors, gate links, rift routes, hover cards) and a live system view. Clicking warps you through `devTeleport`, which the server honours only with `devTeleport` on (dev mode, proto) or for admins.
- **Clock sync:** the client's server-tick estimate snaps when it's more than 20 ticks off, instead of creeping for seconds after joining.

### Jump drive, capital ships and system content

- **Jump drive (J):** part of the shared flight step (`flight.ts`: `stepJump`, `jumpPhase`, `jumpBurnSpeed`; numbers in `tuning.json` `jump`). Its whole state is one counter (`ShipState.jump`, `FlightBody.jump`): ready → charging while the jump control is held → burn → cooldown. The counter rides in player snapshots as `data[3]` and the control as an input bit, so prediction replays it exactly. Charging lets you aim but takes the engines and brakes the ship. Releasing during the charge cancels it with no cooldown. The burn flies along the nose at a fixed speed (about 70k units in roughly 3.5 s, then a 15-second cooldown), with no steering, friction or gravity. During the burn guns don't fire and the ship passes through other hulls. The client latches J on until the burn starts, and J again aborts. `client/src/ships/JumpFx.ts` draws the charge rings, launch and arrival flashes, the wake, screen streaks and the HUD gauge. The camera locks on and pulls back during the burn. The proto repair key moved from J to U.
- **Capital ships:** new pieces `block2` (2×2; hull, armour, conduit, reactor, engine) and `block3` (3×3; hull and armour). Four pre-made ships are in `data/ships/blueprints/`: Lancer Frigate (100 parts), Galleon (162), Bastion Dreadnought (210) and Hammerhead Carrier (211). They are generated from hull profiles and checked by `validateBlueprint`. Every gun and engine is fully powered, and each bigger hull is slower. The hangar's Load list has a "Pre-made ships" group, bundled into the build, and fits big ships to the view. The inventory stub was raised to cover them. The part cap stays at 255: a full rebuild (flow, joins, turret windows) takes about 5 ms at 210 parts and 11 ms at 370.
- **Planets:** `planets` in `systems.json` (`PlanetData`: kind, radius, slow orbit, rings, moons). `common/src/world/planets.ts` gives positions from the tick. `client/src/rendering/PlanetRenderer.ts` draws one shader quad per planet or moon: seven surface kinds, star-side lighting with the terminator, atmosphere rim, ring bands with the planet's shadow, and lava glow on the night side. Planets are scenery: you fly over them.
- **Stillstones** ("lodestones" in the code): `lodestones` in `systems.json` (`LodestoneData`: orbit or fixed `position`, `size`, `state` active/scarred/dead/shattered, a scarred one's `scar` arc, `rough` for the few new ones, an optional camp `zone`). `common/src/ships/jumpFields.ts` is the shared maths: a live one's field reaches `jump.lodestoneField` past its `size` (`lodestoneFieldRadius`), speeds the drive's cooldown and primes the next jump; a scarred one gives `lodestoneScarredCharge`/`lodestoneScarredBoost` of that (a fractional charge counted in whole ticks by the tick number, `wholeTicks`; its priming kept negative, `primeBoost`), dead and shattered ones nothing. The server, the pilot's prediction and replicas all run it from `systemInfo.lodestones`. `client/src/rendering/Scenery.ts` `LodestoneView` draws each once from its id (`StillstoneMesh.ts`) as lit polygons (one `LitMesh`, so it takes the sun and every nearby light like stations and asteroids; about 1–9k vertices) plus additive glow lines in 12 sectors whose alpha follows the night side and pulses while your drive charges there: dark rock in two rows of broad faces (some glassy, their corners tinted so a film runs across them), a sunk carving with a lip, rubble over its rim and branching cracks; the carving is a crown (pit, broken ring walls with teeth, spokes with barbs, needles past the edge), a rosette (three staggered rows of petals in bevelled terraces, each row the last shrunk) or nested polygons, picked from the id's hash. Scarred: an arc broken and dark; dead: dark, half its carving gone, needles snapped; shattered: a ring of fragments. A frame only turns it and sets the glows' alpha. The map, nav and far-zoom markers label dead and shattered ones and draw no field; `routePlan.ts` never detours through them and values a scarred one at its weaker field.
- **Derelicts:** `derelicts` in `systems.json` (`DerelictData`). On start the server spawns each as a battered pilotless wreck (`ShipBridge.spawnWreck`, seeded damage). Wrecks drift but feel no gravity. Whoever lands the last shot on a wreck's core gets its salvage (credits, plus a quarter of that as XP), via the `ShipHost.onShipDestroyed` hook. A destroyed wreck returns after 5 minutes, and wrecks are named in snapshots. `ShipConfig.library` holds every blueprint file.
- **More places to go:** stations at The Maw (Horizon Watch), the Void (Black Lantern) and Glasswater (Shardfall Depot); an Aurora Rift pair between Borealis and Nebula Prime.
- **Nav markers (N):** `client/src/ui/NavMarkersUI.ts` puts edge-of-screen chevrons on off-screen stations, gates, rifts, planets and wrecks, with distances, keeping clear of each other and of the HUD panels. The map's system view shows planets (with moons and rings) and wrecks, and has hover cards for both.
- **Fixes:** debris now stays in its ship's system (it was always created in system 0). Ship contacts only happen within the same system.

### Menu, settings and controls (Esc)

- `client/src/ui/GameMenuUI.ts` is the Escape menu, with these pages:
  - Resume, and the galaxy map
  - Pilot & ship: a live readout of level, credits, core, mass, speed, turn rate, power, guns and jump drive, plus a dock button when you're in a docking ring
  - Field guide
  - Settings: Audio, Display, Interface and Gameplay
  - Controls: every action is rebindable, and binding a key that's already in use swaps the two
  - Server: ping, jitter, pilots in system, copy address
  - Leave server and Log out, both with a confirmation

  Esc steps back from a page, then closes. Flight input is off while the menu is open, and the simulation keeps running.
- `client/src/settings/Settings.ts` is one settings object saved in localStorage (`spacegame.settings.v1`) and merged over the defaults. `Game.applySettings` pushes it into the audio, renderer (shake scale, planets, minimap, damage numbers, names), ship client (schematic, jump screen effects, default control mode), hazard overlay, nav markers, net stats, chat and zoom. Gameplay adds tap or hold for the jump key.
- **Rebinding:** `client/src/input/keybindings.ts` lists every action, with its default key and any always-on alternates (arrow keys, right Shift). Game code still listens for the default codes. `InputManager.setBindings` translates the bound key into the default code, and an action's default key does nothing once that action has moved to another key. `InputManager.raw` (hangar, menu) turns translation off, so the hangar's own keys keep working. HUD hints (dock, jump, helm) show the bound keys.

### Sound, music and Sol

- **Audio is synthesised, with no sound files.** `client/src/audio/sfx.ts` renders 21 effects at startup, each from a small Web Audio graph in an `OfflineAudioContext`: shots, impacts, hull hits, explosions, jump charge/launch/arrival, warp, dock/undock, credits, level-up, alarms, UI ticks, plus seamless engine and boost loops. `AudioManager` starts on the first click or key press. It positions and pans sounds by world position, caps voices per sound, and runs master → compressor, with separate effects and music buses, so the volume settings work.
- **Hooks:** each new projectile plays a shot (at most four per frame), `projectileHit` plays an impact, and hits on your own hull play a thump. Debris breaking off plays a small explosion and a lost core a large one. Jump phases (from `JumpFx.onPhase`; aborting cuts the charge sound), docking and refits, gates and rifts, credits and level-ups, the map and the menu, and the event-horizon alarm all have sounds. The engine and boost loops follow your thrust and speed.
- **Music:** `MusicEngine.ts` is generative. Each system has a mood (root, scale, chord progression, tempo, timbre). Each bar plays slow detuned pads over a drone, with bells through a feedback echo, into a synthesised reverb. Firing or taking hits fades in a combat layer (pulsing bass, quicker bars). A new system crossfades in at the next bar.
- **Sol additions:**
  - Planets Ares (desert, two moons) and Nereid (ringed ice giant).
  - Comet Halvorsen (`comets`, Kepler orbit in `cometPosition`): ion and dust tails point away from the star and lengthen near perihelion.
  - The Helios Array (`structures`, `solar_ring`): a rotating collector ring around the sun.
  - Lagrange Shipyard and Sentinel Watch stations.
  - Freighter traffic (`traffic`): three Ceres Haulers fly station loops. `ShipBridge.setAutopilot` turns them to face their target, uses the screen-direction keys nearest the nose, and coasts to a stop. They wait 6 s at each station and are replaced 2 minutes after being destroyed.
  - The Vesta Graveyard (four wrecks) and Colony Ship Perseverance (1,800 salvage).
  - The Cyan Rift to Glasswater.

  Snapshots tag pilotless ships: `data[0]` = 1 for a derelict, 2 for traffic. The map, nav markers and labels show all of the new content.

### Thrusters, asteroid orbits, map position

- **Thruster effects:** `client/src/ships/ThrusterFx.ts`, called by `ShipRenderer`.
  - Each engine has its own throttle. It fires only when it pushes the commanded way, or helps the current turn. Throttles spool up fast and fall off more slowly.
  - Your ship's command comes from your keys (`ShipClient.localThrustCommand`, for both helm and mouse-steer). Every other ship's command is inferred from its rate of velocity change plus the live friction term, so a freighter at cruise speed still burns.
  - Each engine draws a layered additive plume (glow, outer, inner, white core, shock diamonds above 60% throttle) with smooth flicker, and a faint nozzle glow at idle. Boost makes plumes longer and violet-white. Exhaust sparks are thrown out in world space on top of the ship's own velocity, capped at 900.
- **Asteroids orbit 3× slower:** `ORBIT_MU` is 625000 / 9, and orbit speed goes with √μ. Station orbits are unchanged, because Sol Central's speed is capped by `MAX_STATION_ORBIT_SPEED` either way.
- **Map position:**
  - The M map now opens on the system view.
  - You're a pulsing beacon with brackets, heading and velocity, drawn above everything else.
  - When you've panned away, an edge arrow shows your direction and distance.
  - ⌖ or C centres on your ship (in the galaxy view, on your system).
  - The galaxy view puts a ship pin over the system you're in.

### Bigger, faster ships

- **Size:** `cellSize` went from 8 to 24, so every hull is 3× larger. Mass is counted in grid units, so it didn't change.
- **Speed:** thruster `thrust` (1.13 → 2.26) and `coreManeuverForce` (1.5 → 3) are doubled, which doubles acceleration and top speed.
- **Turning:** inertia scales with cellSize², engine torque with cellSize × thrust, and the gyro is fixed. To keep turn rates exactly the same, `gyroTorque` went from 24 to 216 and `thrusterTorqueGain` from 6 to 9.
- **Bullets:** `BULLET_SPEED` went from 24 to 48, because ships at the new top speed would otherwise outrun their own shots. Range doubled with it.
- **Name tags and health bars** on modular ships now sit outside the hull's real radius and stay fixed on screen as the ship turns (`Renderer.shipRadius`).
- **Tests:** they now scale their fixtures with `cellSize` and the thruster data instead of hard-coding 8-unit cells. The feel test expects twice the old triangle's distance.

### Fixed guns aim

- **Fixed (non-turret) guns** now have a ±2° gimbal (`tuning.fixedGun.gimbalDeg`). Each one points at the cursor point from its own muzzle, as close as the gimbal allows. It fires only while the target is within the gimbal plus `fireToleranceDeg` (0.5°), so with fixed guns you aim the ship. It also fires when the angle from the ship's centre to the target is within that range. A close target can sit well off a muzzle out on a wing, so the gun then fires at its closest angle. The logic is in `stepFixedGunAim` in `turret.ts`. The server stores the offset in `ship.aim`, and `buildShot` turns the shot by it.
- **Fixed-gun shells** (`tuning.fixedGun`, legacy fixed cannons only: enemies' and bosses'; a model weapon's mount and numbers are its own, `partMount`): `intervalScale` 1.5 (a third lower fire rate, applied in `rebuild`), `speedScale` 0.7 and `sizeScale` 1.5 (carried on `ProjectileSpec`). Their lifetime is divided by the speed scale, so range is unchanged. Projectile snapshots now carry `data[7]` (shell size) and `data[8]` (1 = turret), and the client draws and voices each shot by them.

### Destroyed parts, decay and station repair

- **Part deaths** (`ShipBridge.partDeaths`, run each tick before the rebuild): every part whose HP hit 0 since the last rebuild sends a `partDestroyed` message (`how`: blast, break or crumble). Functions listed in `tuning.partBlast` blow up: core at once (so the parts it leaves carry the damage), the others after a seeded delay. A blast damages intact parts on any body within its radius, falling off with distance, so generators can chain. Deaths and due blasts repeat until nothing new dies that tick. Whoever started a chain gets the kill credit.
- **Debris decay** (`ShipBridge.decay`): a body with no core gives each part a crumble tick, spread around `debris.decayTicks`. Debris that splits keeps its parts' times, so wreckage crumbles away within about 1.25 × `decayTicks`. Crumbling parts never blow up.
- **Station repair** (`ShipBridge.repairStep`, every `repair.intervalTicks`): a ship with a core within `repair.range` of a station's edge heals `healPerSecond` of every intact part's max HP. It also regrows one missing part per `restoreTicks`, picking the one nearest the core (in joins) that touches the attached structure. Repairs pause for `combatPauseTicks` after damage. The client spots regrown parts in `shipSync` (`ShipStore.onSync` returns them) and plays the effect.
- **Collisions** send a `contact` message (point, normal, closing speed) above `collision.fxMinSpeed`, at most once per pair per `fxCooldownTicks`.
- **Client effects** are in `client/src/ships/DamageFx.ts`. Each part type has its own look: core fireball, generator arcs, thruster fire, weapon cook-off, armour plates, hull fragments, conduit shorts and crumble dust. The file also handles collision sparks, repair glints and debris embers.

### Sound files

- Effects are generated with fal.ai (`fal-ai/elevenlabs/sound-effects/v2`) by `npm run gen:sfx`. That runs `scripts/gen-sfx.mjs` with the key from `.env`; prompts are in `scripts/sfx-manifest.json`. Files go to `client/public/sfx/` with an `index.json`.
- `AudioManager` loads them at startup and prepares each one: it trims the lead-in, matches loudness and crossfades loops. It also applies a per-effect level (`FILE_GAIN`), playback rate (`FILE_PITCH`) and reverb send (`FILE_REVERB`).
- Anything without a file falls back to its synthesised recipe in `sfx.ts`.

### The game loop: economy, progress, quests and bosses

The full plan is `docs/game-plan.md`. Server modules live in `server/src/game/`, one class each with a small host interface (like `ShipBridge`); `GameServer` builds the hosts (`create*Host`) and routes messages.

- **Economy** (`common/src/econ/`): `ItemCatalog` (data items plus generated parts `part:<material>:<fn>:<piece>` and plans `plan:<file>`), `RecipeBook` (refining, part costs, crafting), `Economy`, stacks and bags, mining composition (`asteroidComposition`), market prices, quests and skills (`quests.ts`). Shared, so the client shows exactly what the server charges.
- **Profiles** (`server/src/profile/`): one JSON document per account. `JsonProfileStore` writes `data/profiles/<id>.json` atomically; `PostgresProfileStore` keeps a jsonb row (set `USER_STORE_BACKEND=postgres`). `migrateProfile` upgrades old saves. Guests get a fresh profile that's never saved.
- **Pilots**: profile lifecycle (login, autosave every 30 s, save on dock/logout/shutdown), credits, XP and levels, cargo vs shared storage, item actions, hangar refits that only use owned parts, the rebuild bill, death (cargo drops as a pod), skills, quest rewards (`grant`). It emits events (`onEvent`: items by source, earned, level, refit, login) that quests listen to.
- **Mining / LootPods / StationServices**: ore breaks off as chunks tagged with their miner (collecting your own chunk counts as mining); pods pull towards ships with room; stations refine, fabricate (instant or queued) and trade.
- **Quests** (`data/quests.json`): story, side stories, metallurgy, guild, shipwright and trader chains, generated station bounties (same for everyone per 30-minute window, rebuilt from their id). Nothing starts on its own: see People, quests and dialogue below. State is in `profile.quests` (active, done, known leads, dialogue flags). Counted steps advance on events; travel/dock/visit/level/refit/deliver steps are checked twice a second. Licences gate systems (`restricted`); gates and rifts refuse unlicensed ships. Client: `ui/QuestUI.ts` (tracker, contracts tab, pilot log L, skills K); objective markers in `NavMarkersUI`.
- **Enemies** (`data/factions.json`, designs in `data/ships/blueprints/enemy/`, generated by `scripts/gen-enemy-ships.mjs`): packs per system, AI in `Enemies.fly`, station defence (only armed stations: `defence` in stations.json, turret stats in `rules.stationDefence`; each turret keeps its target while in reach, else takes the nearest, and `stationFire` says which turret fired), loot and salvage. Behaviour `strafe` (< 1) makes big ships hold and brake instead of circling.
- **Bosses** (`data/bosses.json`, `Bosses.ts`): lair spawns, phases (escorts, enrage, heal, blink, telegraphed novas), cores hardened ×2.5, intro on engagement, shared credit (damage in the last minute or close at death), personal loot to storage, respawn timers (a boss left alone isn't reset: its system is remembered, see "Far ships and the world's memory"). Snapshot `ShipBody` data[4] = 2 marks a boss and data[7] carries hull %. Client: `ui/BossUI.ts` (bar, title card) and `DamageFx` (charge rings, death chain).
- **Legendary weapons**: functions `hive`, `frostbite`, `cinder_bloom`, `prism`, `phase`, `singularity` (tuning `weapons`: `burst`, `chill`, `ignite`, `split`, `pierceKeep`, `pull`). They open by level; each recipe needs its boss's artefact, a very rare drop (docs/parts-redesign.md §6).
- **Events** (`Events.ts`): raids on stations and salvage fields, rolled per occupied system; `worldEvent`/`worldEventEnd` messages drive the ✦ markers.
- **Combat rules worth knowing**: splash only hits the few parts nearest the blast; EMPs leave 4 s of immunity; PvP only where `systems.json` says (`GameServer.canDamage`).
- **Tests**: `server/src/game/*.test.ts` (economy, quests, bosses and events, weapons, enemies) and `server/src/ships/shipEdit.test.ts` drive a real `GameServer` through `LocalTransport`.

### Changes to existing files

Kept small on purpose; this list is the merge-back review checklist.

| File | Change |
| --- | --- |
| `server/src/GameServer.ts` | `applyInputToEntity` writes the strafe/helm bits. Constructor takes `GameServerOptions` (`gameData`, `userDB`, `adminServer`, `scene`, `autoStart`, `everyoneAdmin`, `ships`). HTTP/WebSocket setup moved to `SocketTransport`; `ClientConnection.ws` is a `ClientSocket`; `connect()` replaces `handleConnection()`; `handleAuthRequest` became public `handleHttpAuth`. New `step()`, `setPaused()`, `isPaused()`, `getTick()`, `getWorld()`, `getShips()`, `getPlayerId()`, `createShipHost()`. `scene: 'empty'` skips `initializeWorld()`, reserves entity 0 and sends `centralBody.type = 'none'`. Ship hooks (one line each) in `createPlayer`, `playerMovementSystem`, `weaponSystem`, `buildSpatialGrid`, `collisionSystem` (two), `tick`. `fireCannon` takes an optional `spawnOffset`. `setImmediate` falls back to `setTimeout`. Respawn fix (above). Guests are admins when `everyoneAdmin`. |
| `server/src/data/GameData.ts` | Constructor takes parsed JSON (`GameDataFiles`) instead of a directory. |
| `server/src/index.ts` | Builds GameData from disk, creates GameServer, attaches `SocketTransport`. |
| `common/src/index.ts` | Exports `network/Transport.js` and `ships/index.js`. |
| `common/src/network/protocol.ts` | Input gains `strafeLeft`, `strafeRight`, `helm`, `jump`, `cursorDist` (17-byte binary; older messages still decode). New `shipSync`, `shipHp`, `shipEdit`, `shipEditResult`, `projectileHit`; `EntityState.av`; `EntityType.ShipBody`. |
| `common/src/ecs/components.ts` | `Input` gains `strafeLeft`, `strafeRight`, `helm`, `jump`, `cursorDist`; `Portal` gains `kind`, `hue`. |
| `common/tsconfig.json`, `server/tsconfig.json` | Exclude `*.test.ts` and `testData.ts` from builds. |
| `client/src/Game.ts` | Optional `GameOptions` (`transport`, `proto` hooks, including `helmMode`; Q/E strafe in helm mode). Proto: skips login, no prediction/reconciliation, inputs sent without `targetTick`, no state hash, hooks for keys/input/frame. Respawn key and death-screen fix. |
| `client/src/state/GameState.ts` | `predictionEnabled` flag guarding `reconcilePlayer`. |
| `client/src/rendering/Renderer.ts` | `hiddenEntityIds` (proto draws those entities itself), `getEntityLayer()`, hides sun and glow when `centralBody.type === 'none'`. |
| `client/src/network/NetworkManager.ts` | `implements ClientTransport`. |
| `client/src/main.ts` | Lazy-loads `proto/protoMain` when `?proto` is in the URL. |
| `common/src/constants.ts` | `BULLET_SPEED` 24, `BLASTER_LIFE_TICKS` 150. |
| `common/src/data/schemas.ts` | `RiftData`, `PlanetData`, `DerelictData`; `StarSystemData.rifts`, `.planets`, `.derelicts`. |
| `common/src/data/definitions/AsteroidDefinition.ts` | Fields `cinder_belt`, `maw_shards`, `glasswater_field`. |
| `client/src/state/GameState.ts` (more) | `shipPhysics` prediction hook, `angVel`, `clearForSystemChange()`. |
| `client/src/rendering/Renderer.ts` (more) | Projectile visuals moved to `WeaponFx`; `ShipBody` has no default graphics; modular ships keep their name tag and health bar; rift and central-body shaders; `showProjectileHit()`. |
| `client/src/ui/SystemMapUI.ts` | Labels rifts vs jump gates. |
| `client/src/input/InputManager.ts` | Q and X are game keys. |
| `data/systems.json`, `data/stations.json` | New sectors, gates, rift, two stations. |
| `client/vite.config.ts` | `shipsDevApi()` plugin, `server.fs.allow: ['..']`. |
| `package.json` (root) | `proto` and `test` scripts, `vitest` dev dependency (+ new root `package-lock.json`). |

### Networking: inputs and controls, snapshots only when out of sync

Everything the simulation does with a ship is deterministic (the shared flight step, rounded every tick to `SHIP_PRECISION`), so clients are sent what they can't work out themselves and nothing else.

- **Other ships** (pilots, hostiles, freighters, wrecks, debris): `common/src/ships/replica.ts` `replicaStep` is one tick of a ship exactly as the server moves it when nothing interferes (player, pilotless, drift, anchored and docked modes). `ShipBridge.replicaCtl` records the controls each body flew with each tick (aim angles on the 13-bit cursor grid). `server/src/net/Replication.ts` keeps a shadow of every ship, steps it with those controls, and compares it with the real ship after the tick: while they agree, clients only get control changes (`snapshot.ctl`: `[id, ticksAgo, bits, q, ...]`); when they don't (a collision, a blast, an EMP, running dry of boost, a rebuild that changes how it flies, docking) the next snapshot carries a keyframe (`snapshot.ships`). Clients keep a keyframe version per ship and get one when they're new to a ship or behind. On the client, `ShipReplicaSet` (`common/src/network/replication.ts`) steps each ship on demand from its keyframe and controls, rewinding if a control change arrives late; `ShipClient.placeReplica` places it each frame. `server/src/net/replication.test.ts` checks a client rebuilds every ship bit for bit.
- **The prediction clock:** the client steps its ship once per tick number, every number once (`GameState.predictedTick`, `ticksDue`), running ahead of the server's tick by the trip there plus a jitter margin (`leadTicks`), so an input stamped for tick + input delay arrives before the server reaches it. The server's tick is estimated by smoothing the offset between its tick and our clock (`getEstimatedServerTick`), not the tick itself: smoothing a value that climbs 60 a second always trails it, and the old estimate fell up to 20 ticks behind at 60 fps, so inputs arrived late, every snapshot corrected the ship, and the replay was a tick out (the ship jumped a tick's travel). The ship is drawn between its last two steps, half a tick back, so it moves evenly when a frame runs no step or two. State hashes for ticks the server hasn't reached yet are checked when it gets there (`aheadHashes`).
- **Your own ship:** predicted from your inputs as before, and only resent when the prediction would be wrong: an input that reached the server after its target tick, a new keyframe version (something shoved it), a status change (shield, EMP, beam heat), a state-hash mismatch (the server keeps 3 s of per-tick hashes and checks the tick the client hashed), or every 2 s as a safety net. Boost regeneration is predicted too.
- **View range:** a client only follows the ships within 40 km of it (it lets them go past 48 km, so one at the edge doesn't flicker), plus its party and its target; the furthest flight zoom shows about 24 km. `GameServer.updateShipView` keeps each client's `shipView`. Ships outside it get no keyframes, control rows, status rows, structure or HP; one leaving it goes in `snapshot.out` (the client drops it but keeps its blueprint); one coming back gets just its own keyframe and status row, plus a `shipSync` without the blueprint if it was rebuilt meanwhile. Combat effects (`damage`, `projectileHit`, `partDestroyed`, `contact`) only go to clients within 48 km of them (`broadcastNear`; damage always reaches whoever dealt it).
- **Projectiles:** shots from a ship a client replicates go as fire events (`snapshot.fire`: owner, ticks ago, weapon part, aim in 1/4096 rad, shell ids). The client builds the shells itself from the ship's replicated pose and blueprint (`rebuildVolley` in `common/src/ships/launch.ts`; the server spawns through the same `launchShot`, with its randomness seeded by tick and shell id, and fires from the stepped aim), within a hundredth of a unit of the server's (`replication.test.ts` checks). Everything else goes as a row once: its own shots (predicted, not replicated), homing missiles (again whenever their course changes), shots from a ship it's only now getting a keyframe for, and shells flying in from ships out of its view, when they come within 12 km.
- **Pods:** a drifting loot pod goes once, as its drift anchor (`podDrift`: position, velocity, tick); it's sent again only when something else moves it (a ship's pull, a bounce).
- **Effects** (damage numbers, hit sparks, parts blowing off, bumps) wait up to 2 ticks to ride with the next frame a client gets (`GameServer.lazy`), which saves a packet's headers each time.
- **Status rows** for a ship the client already has leave out where it is (replicated anyway); ship bodies' core and hull % are worked out on the client from part HP (`ShipClient.fillHull`). Rebuild syncs carry only the part HP the client doesn't have (`hpd`).
- **Status rows:** ship bodies and other pilots carry only status (shield, hull, EMP, beams) in `entities`, sent when it changes; names go once per client.
- **Structure:** `shipSync` sends the blueprint the first time a client sees a ship; after a rebuild only part HP and detachments. Part HP changes go together in one `shipHps` per snapshot, to a tenth.
- **Inputs** go up as 11-byte binary messages, only when something changes: the aim as its 13-bit value, the target tick as its low 16 bits (`unwrapTick16` on the server).
- **Binary frames:** everything from the server goes as binary (`common/src/network/binaryCodec.ts`): a frame is `SERVER_FRAME` then each message's wire form, encoded with a small tagged format (small integers in a byte, varints, decimals as integer mantissas with their places so a position is ~5 bytes, short arrays and strings with their length in the tag). It decodes to exactly what JSON would; `encodeServerMessage` encodes a message once for every client it goes to, `serverFrame` puts a tick's messages together, `decodeServerFrame` reads them (and JSON still, for anything that sends it).
- **Compression:** the WebSocket negotiates permessage-deflate on top (`SocketTransport`: level 4, 8 KB window, frames under 96 bytes left alone), another ~30% off. The ping panel's ↓ figure is before compression (browsers only see the inflated messages).
- **Compact messages:** the frequent server messages (damage, hits, parts destroyed, contacts, ship syncs, HP, effects, deaths, HUD numbers) go as `[code, ...values]` in a fixed field order (`COMPACT` in `protocol.ts`; any field the table doesn't know sends the message as a plain object instead). Projectiles have their own snapshot rows (`p`), with no position while they're on the straight line from the muzzle (the client works it out from spawn, velocity and age). Control rows give each aim as the step from the last one the client has, pack ticks-ago and buttons into one number, and go in id order with each id as the step from the last (`packControlRow`). The binary format sends common strings (part functions, materials, blueprint keys...) by number (`DICTIONARY`). Ship designs go once per client: another ship of a design it has is sent by the design's hash (`shipSync.design`; a client that's lost it asks again with `shipNeed`). HUD numbers (`playerState`) go only when they change.
- **Wire format:** snapshots are rows of values, not keyed objects (`packSnapshot`/`unpackSnapshot`); everything a client is owed in a tick goes in one frame (`{type:'batch', m:[...]}`, `decodeServerFrame`), except pongs. Removals go only to clients in that system or that were sent the entity. Inputs are applied in target-tick order on both sides.
- **Measure it:** `npm run bench:net` in `server/` (4 pilots in a running fight; `--spread`, `--gap N` metres apart). A 4-pilot fight went from about 116 KB/s per pilot (35 messages/s) to about 6 KB/s (9 frames/s) with JSON, then 1.8 KB/s binary, then 1.3 KB/s with fire events and the rest (about 1 KB/s once deflated, 6 frames/s). `--sample` prints one of each message. The ping panel shows live ↓/↑ rates.

### Rendering: what a frame costs

Pixi rebuilds (re-triangulates) any `Graphics` that was cleared or drawn into that frame, so per-frame vector drawing was most of a frame's CPU. Now:
- **Effects are sprites of textures painted once** (`client/src/rendering/fxTextures.ts`: thruster plumes, soft glow dots, tracer streaks, flash petals). Thruster plumes and nozzle glows are pooled sprites per nozzle (`ThrusterFx`), the exhaust a `ParticleContainer`; tracers, heads, muzzle flashes, impact sparks and smoke come from `SpritePool`s (`rendering/spritePool.ts`, used by `WeaponFx`). Only an EMP orb's crackle is still drawn as lines.
- **Turret barrels** are drawn once per structure and turned and tinted per frame (`ShipRenderer.drawTurrets`); hostile health bars are redrawn only when what they show changes; every ship's flames sit in one layer under the hulls (one additive batch).
- **Ship damage effects** (`DamageFx`): sparks, fireballs, smoke and the shield bubbles are pooled sprites too; only the few big shapes (shockwave rings, electric arcs, tumbling chunks) are lines. Loot pods, station lights and the docking ring are drawn once and only faded, turned, or redrawn when a light changes.
- **Idle effects don't touch their Graphics** (`clearIfDrawn` in `rendering/gfx.ts`); asteroids are placed once per tick, not per frame; the minimap redraws at 20 Hz.
- **DOM:** HUD text and styles are written only when they change (`ui/domWrite.ts`); nav markers position by `transform` and measure the HUD panels they avoid 4 times a second instead of forcing a layout every frame.

- **Old effects** (explosions, asteroid breaks, bullet hits, pickup sparkles) are pooled sprites too, animated in the frame loop (they used to make a Graphics per particle and fade flashes with `setInterval`); damage numbers are a bitmap font, pooled, instead of a new rasterised Text per hit.
- **Shaders do only the work that shows:** a star layer looks at a neighbouring cell only when the fragment is within a star's reach of the shared edge (the old starfield checked all nine cells, ~130 hashes a pixel, for an identical picture); the sun's rim fractal runs only in the rim band, the black hole's disk noise only on the disk, the pulsar's wind noise only where the wind shows; the sun's glow quad is cut to the glow's size (it was 8× the area).
- **Bloom** (`rendering/Bloom.ts`, Display setting, on by default): the glowing layers (flames, exhaust, tracers and flashes, sparks, beams) are drawn again into a quarter-size texture, blurred at that size and added over the world. About 0.1 ms of CPU and 0.08 ms of GPU at 1440p.
- **Resolution:** pixel density is capped at 2 (a 3× screen would cost over twice the GPU work for nothing visible), and the Display setting *Render resolution* scales it down further for slow GPUs or 4K screens.

**Combat feedback** (all transforms and tints of things drawn once):
- Guns recoil and heat up. `WeaponFx` reports each shot it sees leave a gun (`onMuzzle`); `ShipRenderer.kick` finds the barrel whose muzzle is nearest and slides it back, easing home over ~9 frames, and warms it towards amber (sustained fire glows; it cools over ~2 s). Fixed guns' barrels are separate shapes under the hull so they slide into it.
- A ship that takes hull damage flashes (its outline in white, added over the hull, made on its first hit); an asteroid flashes and jolts. Shield hits light a patch of the bubble's rim facing the shot (`DamageFx.shieldHit`, from `projectileHit`).
- The HUD's damage indicator points at whoever hit you (the damage message's `sourceId`); with no known source it only reddens the edges.

### The sky: biomes, depth, corona

`client/src/rendering/sky/`. Every system gets a sky made from its id and a few hints in its data (`skyBiome.ts`). There's no art: an archetype is picked, then filled in by a seeded random, so systems of one kind still differ.

| Biome | Picked for | Looks like |
|---|---|---|
| band | core systems (Sol) | the galaxy's disc: a glowing band of unresolved stars with dark dust rifts, aligned across the direction to the galaxy's centre and brighter nearer it |
| cluster | a blue special-star hue (Borealis) | inside a young cluster: dense hot stars, many with diffraction spikes, blue reflection haze |
| emission | a nebula hue that isn't red (Nebula Prime) | big two-toned glowing clouds with bright fronts and dark pillars |
| ember | a red or orange nebula (Cinder Reach) | smoky red dust, reddened stars, drifting embers |
| void | a black hole with no special stars (Void Sector), some far-out systems | almost empty: a few faint stars, distant galaxies |
| abyss | a black hole with special stars (The Maw) | dark, warm dust swirls, sparse old red stars |
| remnant | a pulsar (Glasswater) | a supernova's shell of glowing filaments across the sky |

A system can name its own (`visuals.biome` in systems.json); an unknown system gets one from its seed.

How it's drawn (`SkyRenderer`), about 0.07 ms of GPU at 1264×705, about what the old uniform starfield cost:
- **One noise texture** (`noiseTexture.ts`, 256², tiling, four channels of fBM and ridged fBM, built once in ~18 ms). Clouds, dust and filaments are a few texture reads, not noise maths per pixel.
- **Haze** (band, nebula, dust, filaments, remnant shell) is drawn into a texture half the screen's size and stretched over it. It's all soft, so the difference doesn't show; it's a quarter of the pixels.
- **Stars** at full size, in six layers at real depths: a layer D behind the playing field shows at scale 1/(1/zoom + D), so near stars slide by and grow as you zoom in while far ones hardly move. Each layer shows a share of its cells that keeps its count on screen steady as you zoom, and near layers fade out when zoomed far out. Far stars crowd into the band and clouds and dim and redden behind dust (the star shader reads the same sky fields as the haze). Also: distant spiral and elliptical galaxies and globular clusters, dust motes drifting just past the camera (embers in an ember sky), streaks when the camera travels fast (a jump), and diffraction spikes on the brightest near stars.
- **Black holes lens the sky**: each pixel shows the sky at θ − θE²θ/|θ|², so stars and dust bend into arcs around the hole.
- **Corona** (`CoronaRaysRenderer`, between a sun's glow and its disc): streamers whose count, reach and motion come from the system's id and whose colours come from the sun's palette. About 0.03 ms.

### Lighting

`client/src/rendering/lighting/`. Ships, stations and asteroids are lit per vertex, not per pixel: the light is worked out at each corner on the GPU (`litShader.ts`) and blended across each triangle. There's no screen-sized light pass, so the cost is a few lights per vertex: about 0.02 ms of CPU per frame and nothing measurable on the GPU.

- **Geometry** (`LitGeometry.ts`): every vertex has a position, a normal and a base colour. Ship parts and station pieces (hub, pylons, every solar cell, ring segment, spoke) are panels with a bevelled rim tilted outward, so each piece catches light on the side facing it. Station windows glow by themselves. Asteroids get a real shape: a lumpy dome (heights at a centre, an inner ring and the rim) cut into facets, each lit by its true slope (`facets`). How much neighbouring facets' light blends together depends on what the rock is (`rockSmoothing` in `AsteroidLook.ts`): crystal asteroids are crisp cut glass, ice nearly so, metal and hard rock keep their edges, loose stony rock is smoothly rounded; hard rock and gem seams sharpen it. The other meshes (`fan`, `rings`, `dome`) are kept for comparison (`Renderer.setRockMesh`). Asteroids are batched 32 to a mesh, each in a slot whose transform goes to the shader, so they're a draw call per 32 and their geometry is only rebuilt when one joins or leaves.
- **Light** (`Lighting.ts`): each system has an ambient level (from its sky biome, dimmer with the darkness hazard, or `visuals.ambient` in systems.json) and a central light (a sun's warm light, a black hole's disc glow, a pulsar's cold one) coming in low from the centre. Each frame the sources add their lights: shots, muzzle flashes, impacts, explosions and fireballs, engines (one light per ship, where its thrust is), stations (a lamp in their accent colour, blinking nav lights), loot pods, gates and rifts. Close lights are merged; each mesh gets the 16 strongest that reach it.
- **Headlights**: where the ambient and sunlight fall below a threshold, ships' headlights fade on: a beam ahead (also drawn faintly, so you see it) and a soft light over the hull. Guns, turrets and loot crates are tinted by the light where they are (`levelAt`).
- **Setting**: Display → Lighting; off gives the plain colours.

### Flight damage: a wrecked ship limps

`rebuild.ts` gives every ship its mass and inertia **as built** (`fullMass`, `fullInertia`: every part but unbuilt hangar ghosts, held on through built parts) and a **drive** factor (`driveFactor`: 1 whole, about 0.7 at half its mass, about 0.35 down to a core and a few parts). Flight (`accelAlong`, `turnAccel` in `flight.ts`) divides by the built mass and inertia and multiplies by the drive, so losing parts never makes a ship quicker or nimbler, and a stripped frame crawls. The core's maneuvering force (3) and gyro torque are unchanged, so intact ships fly exactly as before. Ghost parts travel in `shipSync.ghosts` so client prediction agrees.

### The Drift (outer Sol)

`systems.json` zones are named rings (drawn on the system map, named on the HUD when you're in one); `factions.json` `spawns.<system>.zones` give a ring packs of its own, spawned only around pilots inside it (`Enemies.zonePoint`); a zone's packs nobody's been near for `rules.idleDespawnSeconds` are recycled (only while the system has pilots, and only once they're distant), so new ones come in where the pilots are. Sol's Drift (76–100k, past Nereid and the gates) holds the **Scrapborn** (`scrap_mite`, `scrap_spitter`, `scrap_crawler`): heavy steel junk with one thruster and worn-out drives (blueprint `drive` 0.6–0.85: engine output, never above 1), so at most half a starter ship's speed (6.7, 6.7 and 7.0 against 14.5; a test holds them to it), poor shots, aggressive but short-tempered, and flimsy (faction `hpScale` 0.3). 15–40 XP each. The **Scrap Mother** (boss, level 3) nests at (-62000, 61000). Three wrecks to scan, and the Sol Patrol's Drift contracts at Sentinel Watch (`drift_01..03`, chain `patrol`).

### Far ships and the world's memory

- **Distant ships** (`server/src/ships/SimLod.ts`): a pilotless ship no pilot has been within 64 km of for 10 s goes distant (never while busy: fighting, hurt or firing lately, EMP'd, a boss mid-move), and wakes the tick one comes within 52 km (a jump's whole reach counts while it spools). A distant ship flies a route worked out by time, a leg at a time (`common/src/ships/farRoute.ts`: flight's own integrator with the thrust held, in closed form, so a change of course is a rounded turn), each leg planned once when the last ends, from its intent (`Enemies.intent`, `GameServer.trafficIntent`, or its autopilot) with its own dice, so the same route gives the same place however often it's looked at. Where it is is only worked out when something asks (`lod.where`, the map, a look for pilots nearing: scheduled by how soon a pilot could get there, at most 10 s apart, and at once in a system where someone's just arrived or jumped). A patrol round a home that stays put (`Intent` `patrol`: the system's own packs, zone packs, escorts, bosses at their lairs) is worked out leg by leg from its dice without asking the AI (`patrolNext`), the same way on the client.
- **The world's memory** (`server/src/game/SystemMemory.ts`): a world system nobody's been in for `rules.json memory.evictAfterSeconds` is written down and taken out of the world: packs its own spawners sent (`Pack.origin`; events' and jobs' packs just go), bosses (hull and phases), freighters, derelicts, and every spawner's clock (bosses' `nextSpawn`, nests' `nestNext`/`nestRebuilt`/`nestLock`, zones', roaming packs', freighters' and derelicts' respawns). A pilot coming (at a gate's or rift's mouth, `MEMORY_GATE_MOUTH`, or however they arrive) brings it all back first: each ship flown on from where it was (`lod.adopt`, at most `fastForwardMinutes` of it), mended by `healPerMinute` of each part's max a minute away (`bossHealPerMinute` for bosses; wrecks don't mend), a boss's phases as its hull now is. What's due back comes back by the spawners' own clocks. NPC ships carry no ammunition, so there's none to remember.
- **Kept on disk**: `data/world/memory.json` (gitignored; the deploy's tar and rsync leave it alone), written whole (`.tmp` then renamed) every `saveSeconds` and at shutdown (`saveAll`). The format (`MemoryFile`, `MEMORY_VERSION` 1): `{ version, savedAt (wall ms), worldTick, timers: { enemies: { spawn, zone, nestNext, nestRebuilt, nestLock }, bosses }, systems: { <id>: { at, packs, bosses, traffic, derelicts } } }`, every time a world tick (the server's tick plus `memory.offset`, which carries the clock over restarts: downtime counts). A missing file, or one of another version, is a fresh world; one that won't parse is kept as `memory.json.bad-<time>`. Delete `data/world/` to reset the world.
- **The map's far ships** (`mapDots`, protocol 13): once a second while the map is open, only what's changed: a leg (`dots`) or a patrol (`routes`) per ship, the client carrying it on exactly (`client/src/state/FarShips.ts`), resent only when its route changes (a live ship: when it's strayed `MAP_DOT_SLACK`); what each is (`info`), once; `gone`; `full` for a fresh list. Other pilots are on it too (kind 4).

### Planet surfaces

A surface is a `systems.json` entry with `surface` (`of`, `planet`, `kind`, `radius`, `seed`, optional `city` and `siege`), and its planet names it (`planets[].surface`). It's a small bounded system: everything (ships, enemies, lighting, snapshots) works as in space. **Server** (`server/src/game/Surfaces.ts`): X in orbit within 900 of the planet's edge descends (`GameServer.handleInteract` → `Surfaces.descend`), arriving on the side you came from; past `radius` you climb back to orbit beside the planet. A city with a `siege` raises shield pylons (`city_pylon`, a thrusterless ward) and every `everySeconds` (first after half that) lays siege: a 20 s warning, then `waves` waves from the map's edge for the nearest standing pylon, bigger for more defenders and from two sides later. Hold with a pylon left and everyone who fought near the city is paid; lose them all and the shields fall. Progress goes out as `objective` / `objectiveEnd` messages (banner: `client/src/ui/ObjectiveBanner.ts`, with a nav marker). Admin: `/event siege`. **Client**: `rendering/surface/SurfaceRenderer.ts` replaces the sky with the ground (half-res shader: terrain from a height field, shaded by slope against the sun, sea and surf, the city's street grid, cloud shadows, haze at the edge) and a cloud layer over the world (parallax 1.4, thinning as you zoom in); palettes for terran, rocky, desert, ice, lava and toxic worlds. `CityView.ts` builds the city's blocks, towers, parks, spaceport and pylon platforms as one lit mesh on the street grid. Ships cast soft shadows; daylight replaces the star's light. The galaxy map leaves surfaces out; the system map shows the edge and the city. **Terra Nova** (Sol) is the first: a peaceful world with the city of New Meridian (no siege configured; the siege code is there for other cities). Planets, moons and comets are placed from the continuous clock (`GameState.getRawServerTick`), not the last snapshot's tick, so they glide rather than jump when snapshots arrive.

### Moon sieges (solo or party)

A moon can have a surface too (`planets[].moons[].surface`, `surface.moon`); with a `bastion`, everyone gets their own (a party shares one): the system's `instance.slots` are extra system numbers for the same system (`GameData.getSystemInstances`), and clients are only told its id, so a copy looks just like the original. **Server** (`server/src/game/Sieges.ts`): X over the moon (`Surfaces.descend` → `Sieges.enter`) takes a pilot (or their whole party) to their copy, made on first arrival with the bastion (`siege_bastion`, a ward) on its crater. By **day** the party spends shared supplies (`SIEGE_SHOP`: patch the bastion and turrets, build `SIEGE_TURRETS` (cannon, flak, laser, missile; marks I-III, an upgrade swapping in the next design) on its six pads, scrap one for half back; turrets are thrusterless wards with turret guns and a controller that fires on the nearest hostile, leading it for shells, with a per-kind damage multiplier, `SiegeHost.arm`), anyone can refit their ship, and everyone on the moon readies up or claims their haul and leaves (`{ type: 'siege', action, pad? }`). Structures (`SurfaceHost.spawnStructure`) are pinned (`ShipBridge.pin`): contacts treat them as immovable. **Dusk** (6 s), then **night**: `waveRoster` spends a budget that grows each night and with the party's size, leaning on whatever unlocked most recently (the first four nights all slow Scrapborn; pirates from night 5, cinder and frost from 8–9, wraiths from 12, the Maw from 19), in one front or two, a champion every fifth night. Dawn adds to each pilot's haul and to the supplies (kills add a little); the haul is paid when they claim it by day (`haulBonus`: +25% per five nights they held), or half with no bonus if they leave any other way (past the edge at night, shot down, disconnected: `Sieges.leave`, which also lifts them to orbit so they aren't saved on the moon) or the bastion falls. Lose the bastion and everyone goes back to orbit; a copy nobody's on is cleared after a minute. Pilots and wards (bastions, turrets, pylons, freighters) can't hurt each other (`canDamage`). **Client**: `ui/SiegePanel.ts` (the day's panel), the `objective` banner (its `night` darkens the ground, clouds and lighting: headlights come on by themselves), `rendering/surface/BastionView.ts` (crater, platform, lit pads). **Selene**, Terra Nova's moon, is the first.

### Admin tools

Accounts flagged admin in the lobby (or everyone on proto servers) get the admin panel (`client/src/ui/AdminPanel.ts`, **F2**), floating at the side so the game stays playable. **F3** teleports to the cursor and **F4** frees the camera (WASD flies it, Shift faster; F4/Esc back). Tabs: **Me** (position and cursor readout; god mode, hidden from hostiles, free camera; repair, credits, XP, skill points, any item; teleport to a system and point, or to any station), **Players** (everyone online: go to, bring, watch with the camera, and ⋯ for repair, god mode, hidden, credits, XP, send to a clicked spot, destroy, kick), **World** (spawn any faction or ship where you click, bosses at their lairs, destroy or quietly remove hostiles, clear loot, start a raid or salvage field, announce to everyone) and **Server** (tick time, memory, bandwidth by message, this client's prediction, recent errors).

Everything is a server command in `server/src/game/AdminTools.ts` (`{ type: 'admin', cmd, args }`, answered by `adminResult`; refused for non-admins; each logged as `[admin] name: cmd args`). The same commands work from chat for admins: `/help` lists them (`/tp`, `/goto`, `/bring`, `/god`, `/hide`, `/heal`, `/kill`, `/boot`, `/credits`, `/xp`, `/give`, `/skillpoints`, `/spawn`, `/boss`, `/clear`, `/clearpods`, `/event`, `/announce`, `/who`). Players are named by username (a unique prefix will do) or `#id`. God mode is `ShipHost.invulnerable` (no damage from anything, black holes included); hidden pilots are left out of the hostiles' and bosses' target lists (collisions still hurt). The old HTTP admin API (`AdminServer.ts`) now listens on 127.0.0.1 only.

### Station designs and defence turrets

`client/src/rendering/stationDesigns.ts` builds each station from its `design` in stations.json, seeded by its id: **ring** (hub, habitat ring, solar arrays, pylons), **outpost** (modules on a truss, tanks, cargo, a solar wing, a turning radar), **observatory** (a great dish, lab wings, an antenna boom), **bastion** (an armoured hexagonal keep with gun platforms on its arms and hangar bays), **shipyard** (a gantry frame round a half-plated hull, welders sparking, cranes) and **refinery** (a glowing furnace ringed by tanks, stacks, hot radiators and a crane). Each design gives its fixed geometry, a part that turns, nav and chase lights, lamps, and hardpoints. The design index, turret count and weapon go to the client in the station's entity data (`[9..11]`).

Armed stations (`defence: { weapon, turrets }`; mostly in hostile sectors: Sentinel Watch, Nebula Prime Observatory, Ember Forge, Black Lantern, Horizon Watch) get that many turrets on the first hardpoints: **laser** (twin barrels, quick red bolts), **flak** (quad barrels, tracers bursting into smoke and shrapnel, splash damage) or **lance** (one heavy beam every 1.5 s). Turrets sweep while idle, swing onto what they're shooting, kick back and light their surroundings as they fire (`StationView.fire`, effects in `DamageFx.onStationFire`). Unarmed stations don't fire. `devSpawn` (dev servers and admins) drops a hostile pack at a spot, for trying them.

A frame went from about 4 ms of CPU to about 1 ms (headless Chrome, 1600×900, uncapped); with the CPU slowed 4× it's about 5 ms, well inside 60 fps. GPU time at 1440p went from about 0.7–0.9 ms to 0.35–0.5 ms per frame (the starfield was most of it: 0.35–0.4 ms, now 0.11–0.17).

### Grades, sizes and ship rating

Materials are **grades** (`data/ships/materials.json`, `common/src/ships/grades.ts`):

| Grade | Materials |
|---|---|
| Mk I | alloy, or lighter and frailer composite |
| Mk II | steel |
| Mk III | titanium |
| Mk IV | cobalt (refined from cobalt ore) |
| Mk V | neutronium (refined from neutronium ore, found in danger 4+ belts) |

Each grade has a `toughness` (HP per cell), a `density` and an `output`. Output multiplies weapon damage (`WeaponInfo.strength`), generator power (`partSupply`) and shield capacity. Weapons and shields also draw `output` times the power (`partDemand`), so better guns need better generators.

A weapon's **size** is its piece. Damage grows as `(area / base)^1.15`, where `base` is the smallest whole-cell piece the weapon comes in, so a 2×2 cannon hits a bit harder than four cannons for the same power. Bigger shells are also larger and faster (`shot.ts`). Weapons now also come in `block2` and `block3`.

**Rating** (`ships/rating.ts`) scores every part:
- **firepower**: damage per second at the power it actually gets;
- **toughness**: hit points, plus shields × 2;
- **power**: what generators make.

A ship rates `√(firepower × toughness) / 22`. A starter ship is about 10, and each grade rates a design about a third higher. `partStats.ts` gives one part's numbers for the UIs: grade, size name, damage, reach, power, thrust and score.

Systems build their hostiles in a grade (factions.json `spawns.<system>.grade`):
- Sol and Glasswater: Mk I;
- Borealis and Nebula Prime: Mk II;
- Cinder Reach: Mk III;
- the Void: Mk IV;
- the Maw: Mk V.

Building them works like this:
- `Enemies.design` regrades the design and caches it; above Mk I the name carries the grade ("Pirate Raider Mk III").
- Kill pay scales by `gradeReward` (output^1.6).
- `Enemies.systemRating` is the weighted rating of a system's packs.

`GameServer.threats()` sends every system's and siege moon's rating in the `welcome` message. The client shows them:
- in the HUD, as your rating against the system's, coloured easy / fair / hard / deadly (`ui/threat.ts`);
- on the galaxy and system maps, where siege moons are labelled and clickable;
- in the target panel (entity data `[8]`);
- in the hangar summary;
- in part tooltips.

**Siege moons**:

| Moon | System | Grade |
|---|---|---|
| Selene | Sol | Mk I |
| Rimeholt | Borealis | Mk II |
| Cinderhold | Cinder Reach | Mk III |
| Gloam | the Void | Mk IV |
| Last Light | the Maw | Mk V |

Each moon's `bastion.grade` sets its nights' grade and pay. Its bastion and turrets are built a grade above the nights. `bastion.offset` (skipping early roster nights) exists but is 0 everywhere.

`scripts/ship-ratings.ts` (run with `npx vite-node`) prints every design's rating at every grade, and every system's pack ratings.

### Structure, modules and salvage

`common/src/econ/salvage.ts` splits ship parts into two kinds:
- **Structure** (hull, armour, conduits, cargo holds) is never fabricated or kept as an item. Placing it in the hangar costs its refined materials (`placeCost`). Items that arrive any other way are turned into materials: by `Pilots.give`, at login, and in enemy part salvage.
- **Modules** (everything else) are fabricated and kept as items.

**Refining** always takes time (`recipes.json` refining `time`, seconds per batch). It runs in a refinery queue at each station, separate from the fabricator queue, and refinery jobs (`refine:<id>`) don't use fabricator slots.

**The fabricator** never refines on its own: it says what's short. Its station tab lists modules by category (Weapons, Power, Engines, Shields, Mining & scanning, Core). For each it shows a description, the grades, and one row per size, with the part's numbers.

**The hangar** (`server/src/game/Hangar.ts`):
- **Save** builds what it can, paying modules from storage and structure from materials. Edits lose nothing: dropped modules go back to storage and dropped structure back to materials.
- **Build** (`slotBuild`) puts a slot **on order** (`ShipRecord.auto`). Each second `Hangar.tick` → `work` fabricates the modules it's short of (`StationServices.makeFor`) and refines the materials still short from storage ore (`refineFor`). Jobs run at this station, else home, else any station with the service. `fill` fits what has arrived.
- **Scrap** (`slotClear`) breaks built parts down with `salvageParts`: 70% of their minerals come back as raw ore (`SALVAGE`), and every component in full. `scrapItem` does the same for modules in storage, at a station.
- **Order priority**: `ShipRecord.rank` (lower first) and `paused`. `orderRanking` gives the order `tick` works slots in, so the first order takes storage first. `slotOrder` holds, resumes, moves to the front (`top`) or calls off (`cancel`, refunding its jobs) an order. Jobs the hangar queues carry `for` (the ship's name) and `slot`.

**Jobs** can be held, resumed, moved to the front of their queue or called off (`job` message, `StationServices.jobAction`). A held job keeps its current run's progress (`heldMs`) and the rest of its queue moves up (`reschedule`). Calling one off refunds its unfinished runs' inputs; calling off a job an order queued also holds that order, or it would queue it again.

**Order plans** (`common/src/econ/orders.ts`, `planOrders`) cost every unfinished slot down to ore, sharing storage and jobs in priority order. Each line is one item at one stage (part, material, ore), with how much is ready, coming, waiting (and why: `inputs`, `queue`) or short (`gather`, or `schematic`). The client runs the same planner (`PilotState.orders`) for the station's Ships tab (what to gather, the full bill), and for the refinery and fabricator's "Waiting" lists.

**Death** (`Pilots.onDestroyed`):
1. Cargo drops in a pod.
2. The ship's salvage goes to storage: 70% of its minerals, or all of them with an insurance bond, plus every component in full.
3. Its slot becomes every part a ghost, `lost` and on order. It can't be flown until it's whole, and `Hangar.tick` announces when it is.
4. The pilot respawns in a **loaner**: a free starter, `loaner: true`, in a free slot or an extra one. It can't be refitted, and goes back when they fly another ship.

There are no schematics (retired 2026-10-30): everything opens at its level (docs/parts-redesign.md §6); econ/retired.ts cleans old saves.

### Engines

There are three engine kinds (`data/ships/functions.json`). An engine is any function with `thrust` (`grades.ts isEngine`).

| Engine | Thrust | Power draw | Boost | Battery drain | Sizes |
|---|---|---|---|---|---|
| Ion thruster (`thruster`) | 2.26 | 15 | ×2.2 | ×1 | sq to block2 |
| Afterburner | 1.9 | 12 | ×3.4 | ×2.6 | sq to block2 |
| Plasma drive | 3.1 | 26 | ×1.6 | ×0.7 | rect2, block2, block3 |

Thrust and power draw are per cell, before grade and size scaling.

`partThrust` = thrust × area × (area / base)^0.15 × √(grade output). Power draw scales by √output too.

`rebuild.ts` gives each ship a `boostFactor` and `boostDrain`, weighted by each engine's thrust. `stepFlight` uses them in place of the global boost (`BOOST_FACTOR`) and drain, so prediction, replicas and the server agree.

`scripts/merge-thrusters.ts` refits ship plans, joining side-by-side single thrusters into two-cell ones. The starter, sparrow-t, is a test fixture and is left alone.

### Part hardware

`client/src/ships/partDecor.ts` draws engines and weapons as more than coloured cells, in grid units.

Engines:
- a bell nozzle (or several) out of the facing edge;
- a dark throat and a glowing exit ring;
- cooling ribs and a glowing combustion chamber;
- ion thrusters glow blue, afterburners orange, plasma drives violet.

Weapons:
- a chamfered gunmetal mantlet with a vented back (`housing`), plus per-kind hardware: a cannon barrel through a trunnion with a recoil sleeve and muzzle brake, flak twin barrels and an ammo drum, a laser's focusing tube with glowing rings, missile tubes, railgun rails with a glowing slot, lance prongs round a crystal, an EMP dish;
- barrels are separate shapes, drawn under the hull, so they recoil; each is one outline (`stepped`) so it recoils whole. Sleeves over the housing are part of the hull mesh;
- turrets get an octagonal deck plate, a ring and a dome (`turretBase`), and their barrel from `turretBarrel`;

Mining lasers (`miner`): a glowing crystal chamber, a focusing tube with coolant rings and a lens, and two claws.

- bigger parts get bigger hardware (by √size).

Where it's used:
- `ShipRenderer.drawHull` (lit, worn by damage);
- `ThrusterFx`, whose flames start at the nozzle exits;
- `HangarUI`;
- item icons (`drawDecor2d`).

`scripts/render-ships.ts out.png <plan names or .json paths>` draws designs to a PNG to check how they look (`PX=90` for a close-up).

### Docking

A docked ship (`conn.docked`) sits at the station's centre and is put back where it came in on undock (`docked.exit`). Each tick, `GameServer.dockedShips` lists docked ships. A docked ship is:
- invulnerable;
- out of `canDamage` both ways;
- skipped by contacts and unable to fire (`ShipHost.sheltered`);
- left out of hostiles' and bosses' player lists.

On the client, `ShipRenderer` hides docked ships: yours while berthed, and others whose replica is `Docked`. `ShipClient.predict` holds you at the station while you're docked.

### Energy and batteries

`common/src/ships/energy.ts`. Three pools of stored energy: **general** (the core's own `tuning.energy.coreCapacity` plus standard batteries) serves everything; **drive** batteries feed engines only; **weapon** batteries feed guns and mining lasers only (`FunctionDef.pool`; capacity `store` × area × grade output). In the flow solve (`rebuild.ts`), only steady loads (shields, scanners, jump coils) share out the generators' supply; engines, guns and mining lasers get satisfaction 1 if power reaches them. `derived.energy` holds the three capacities, the spare power after steady loads, and the draws.

Each tick, `powerTick` (from `stepFlight` when `drainRate > 0`) runs the engines first: thrusting, they take the spare power as it streams in, then the drive batteries, then the general one (boosting draws `1 + boostDraw × boostDrain` times as much and needs stored charge); with both dry they push `streamed / need` as hard (`FlightResult.power`). Spare power the engines leave charges the pools, each in proportion to how empty it is. Guns spend `WeaponInfo.energy` per shot (beams: per tick) from the weapon batteries, then the general one (`spend`, via `stepGuns` `orders.energy`), so they only ever get stored charge: thrusting on empty, they're silent. Mining lasers pay per 15-tick segment aligned to the tick count (`payMining`, `ShipState.minePaid`).

The charge (`Charge`: percentages of each pool) is kept per ship in `ShipBridge.charge` (absent: full), sent in the player's own snapshot (`data[1]` general, `data[10]` drive, `data[11]` weapon; `data[9]` is the charging-field flags and `data[12]` a stillstone's priming, negative for a scarred one's) and predicted by the client (`GameState.charge`); `Boost.fuel` / `GameState.boostFuel` are the combined percentage for the ENERGY gauge (`chargeTotal`). Pilotless ships' flight isn't metered; their guns are. `rateShip` counts guns at the rate energy sustains them. `scripts/ship-energy.ts` reports every design's budget; `scripts/add-batteries.ts` refits plans whose boost doesn't last.

### Levels, tiers and rewards

`common/src/econ/levels.ts`: XP to reach a level is `75 × (level − 1)³`. Each grade's licence (`material:*`) needs a pilot level (`GRADE_LEVEL`: Mk II 5, Mk III 10, Mk IV 15, Mk V 20). Higher grades take more plates per cell (`parts.platesPerAreaByGrade`), more ore per plate and longer to refine, and longer to fabricate (`parts.timeByGrade`).

Mining lasers yield by their grade against the system's rock tier (its enemy grade, `Mining` `rockTier`): `mining.json` `tierEfficiency` (a grade behind 35%, two behind 8%, a grade ahead 120%).

Credits are scarce by design: quest and ribbon credits are small, enemy pay grows faster than linearly with the ship (`0.1 × base^1.25` in factions.json, × grade), bounties pay `CREDIT_SCALE` of their old rates, and bosses pay the most.

### People, quests and dialogue

- **People** (`data/people.json`, `server/src/game/People.ts`, shapes in `common/src/econ/dialogue.ts`): each lives at a station (talk while docked: station window, Overview, People here) or at a point in a system, a planet's surface included (fly within 900 and press X: `handleInteract` asks `People.nearby` first). `moves` put someone elsewhere while a condition holds (Dr. Osei is at Shardfall during Trial by Fire). The server sends everyone, with where they are now and a mark (offer: has a job for you; step: a job of yours needs them), as `people`; the client draws the ones out in space (`ui/PeopleUI.ts`) and lists the docked ones.
- **Conversations** are run on the server and shown by `ui/DialogueUI.ts` (over the chat, bottom left; 1-9 answer, Space skips the typing, Esc walks away). Talking opens the hub: a greeting, the step of a job that needs them, their jobs on offer (lines, then Accept / Not now) and their own topics. Lines: `say`, `ask` + `choices`, `if`, `offer`, `reveal` (a new lead), `give`, `flag`, `advance`, `fight`, `end`. A talk step's lines advance it at the end, or only where they say `advance` (questions with wrong answers end with `end`), and its `take` items must be in hand (in the hold, away from stations). Calls over comms use the same lines: a step's `after`, a finished job (what it paid, and the person's next job on offer), milestones (`call`: once a person's job is open to you they call about it), the welcome. Calls queue behind an open conversation.
- **Nothing is forced**: jobs with a `person` are only offered by them; `starter` jobs are leads from the start; talking to someone reveals every job they could give you (locked ones as leads with what they need); rumours `reveal` jobs elsewhere. Any job can be abandoned (its `quest` items are taken back). The log's Quests tab lists in progress, leads and completed; following a lead points the marker at its person.
- **New steps**: `talk` (person, lines, take, give), `visit` (a point, radius, items found there), `boss` with `arena` + `person` (talk, "ready?", then your party's own copy of the arena: `server/src/game/Arenas.ts`; the arena surface has no way down from orbit; the boss is `arena` in bosses.json, spawned with `Bosses.spawnAt`, keyed per copy), escort `ward` (a named ship), craft `teach` (a job's own recipe, `recipes.json` craft entries with `quest`, shown only while the job is on).
- **Gates**: `restricted` systems name a shared `licence` (Glasswater, Borealis, Nebula Prime and Cinder Reach need `outer_lanes`, from Okafor's Cleared for Departure). (Fabrication `gates` went with the schematics.)
- **Objective guide** (`client/src/ships/route.ts`, `ui/GuideUI.ts`): routes go through gates, rifts, down to planets (fly close, X) and back up (out past the edge). The tracker's guide line names the next waypoint and its distance, chevrons point from the ship, and the autopilot (G) follows the same route. Settings › Interface: objective guide, calls over comms.
- **Content**: Sol beginners (Vance, Brannoch, Joe, Achebe), Cleared for Departure (three buoys, Achebe's questions, Okafor), Dr. Osei's metallurgy chain (the Kestrel wreck, the Shattered Bell, questioning Old Pell, a field crucible, escorting her shuttle, the Foundry Warden in the Deep Foundry under Halcyon), Sabine Kerr (hermit, found by chance or Joe's rumour) and Tobias Wren (stranded in Glasswater). The Ark Hall's chain (`ark_01`–`ark_07`) and the Helios Seat's (`bellwether`, `bw_01`–`bw_04`, Director Mbeki and Engineer Rask; it stops before Commissioning). Lore text follows `docs/lore-canon.md`.

- **Records** (`data/codex.json`, `common/src/econ/codex.ts`, `server/src/game/Codex.ts`, the pilot log's Records tab): lore as found documents and testimony, each attributed (`source`). Found when an entry's `unlock` condition holds (checked twice a second, only for those not yet found), by a `{ codex }` line, a job's `rewards.codex`, or an item's `codex` (items.json) when it enters the hold or storage (`Pilots.give`), or a wreck's log: a derelict with `log: { codex }` (systems.json) files that record for a pilot who flies within 900 of the hulk (the Codex host's `wreckLogs`, checked with the conditions; a `scan` step's 700 is inside it, so scanning the wreck reads it too) or lands the salvage kill on it (`GameServer.onPilotlessShipDestroyed`). A broken-up hulk can't be read until it's towed back. Saved as `profile.codex` (`found`, `fresh` until opened: `codexRead`); the client is sent only found entries (`codex`, all on login), toasted (strings.json `codex.found`), and each find is tracked once as `codex_<id>`. Admin: `/codex [name] id|all|clear`.
- **People's ships**: someone at a point (`craft` in people.json) lives aboard a ship from the plan library, spawned at world start (`GameServer.spawnPersonCraft`), pinned, invulnerable and out of `canDamage` both ways, named like a ward. The client labels the person over it, and while one is within talking range shows "X Talk to …" at the bottom of the screen.
- **Locked sectors on the galaxy map**: `SystemMapUI.locked` (Game: `restricted` from quests.json against your licences) draws a padlock, "… needed" and the hint in the tooltip.
- **One session per account**: `GameServer.loginPilot` saves and signs out any other connection on the same account (it's told why) before loading the profile; the client only forgets its saved token if no other tab has signed in since.
- **The Foundry Warden** was tuned by simulation (a bot keeping its distance and firing): a Bulwark wins comfortably, a Prospector in about 40 s, an Arrow can lose, a mining ship can't win.

### Collision performance

- **Spatial grid** (`GameServer` `SpatialGrid`, ships, enemies, shots and pods; asteroids have their own timetable below): one per system copy (instanced copies share coordinates; cell keys include the system). `buildSpatialGrid` only records what's where at the start of the tick; a system's cells are filled the first time something queries it. Queries dedupe with a stamp array, no Set. Callers pass the system.
- **Ship contacts** (`ShipBridge.resolveContacts`): bodies that can touch at all (mass, not jumping, not sheltered) are grouped by system and swept along x on bounding circles padded by `CONTACT_MARGIN` (more than a pass's pushes can move a body), then pairs run in the original order. Each part piece carries a bounding box (`worldPieces`); pieces are only SAT-tested against pieces whose boxes meet. `convexPenetration` projects inline, without arrays.
- **Asteroids**: `getAsteroidPolygon` caches each outline around its centre by id (same numbers as before), and every shot and beam skips asteroids its segment can't come within `size` of (`segmentNearCircle`).
- **Asteroid orbit timetable** (`server/src/game/AsteroidOrbits.ts`): asteroids aren't moved each tick or put in the spatial grid. Each orbit is walked once when the asteroid is made (by eccentric anomaly, so no Kepler solving) and filed in every 1000-unit cell its padded footprint passes through, with the stretch of mean anomaly (the orbit's clock) it spends there. A shot or beam's query checks each cell entry's clock against its stretch (a multiply, a modulo, a compare) and returns only asteroids that can be there now; `placeAsteroid` then works out the exact position, once per tick. Anything reading an asteroid's `Position` must call `placeAsteroid` first. Breaking unfiles it (`forgetAsteroid`), regrowth files the new orbit. About 730k entries (~9 MB) for the 2,190 asteroids, built in well under half a second. Old cost: 0.55 ms every tick solving all orbits plus grid filing, even with nobody shooting; new: nothing without shots, about 0.06 ms a tick for a 300-shot belt fight. Checked bit-for-bit against the deterministic fight (with a belt barrage, beams and 63 asteroids broken) and by `asteroidOrbits.test.ts` (every asteroid the old grid would have found comes back, at ticks up to weeks of uptime).
- **Shots and instances**: `hitProjectile` only considers ships in the shot's own system copy (before, a siege copy's shots could hit another copy's ships at the same spot).
- These were checked bit-for-bit against a deterministic 900-tick fight (seeded, piles of colliding ships, big overlapping hulls, shots into ships and the belt): identical state hash before and after. Measured: contacts with 425 bodies 27.7 → 0.27 ms; a galleon touching a hammerhead 32.6 → 0.75 ms; the grid rebuild 0.84 → 0.19 ms; 300 shots 2.1 → 0.97 ms.

### Data files, validation and presentation

- **Validation** (`server/src/data/validateGameData.ts`): every data file is checked at load, shape and cross-references (stations, systems, people, bosses, factions, designs, items, recipes, weapon kinds, dialogue targets). Dev and tests throw on an error; production logs. `GameData` checks the game files; `server/src/index.ts` checks again with the ship data. `validateGameData.test.ts` runs it on the real data.
- **Rules and strings** (`data/rules.json`, `data/strings.json`, `server/src/data/rules.ts`): tuning for sieges, surfaces, events and operations, and their player-facing text plus People's stock replies. The code keeps every value as its default; the data is merged over it (`mergeRules`, `texts`, `{name}` placeholders via `fmt`).
- **Part presentation** (`data/ships/functions.json`): name, rarity, description, fabricator category and order, colour, glow, decor shape key, shot and beam sounds, field-guide entry. A new part or weapon kind that reuses an existing decor shape and sound needs no code. The wire tables (`DICTIONARY`, `WEAPON_KIND_TYPE`) are still hand-kept: change them and `PROTOCOL_VERSION` with the hash in `protocol.test.ts`.
- **Music** per system: `systems.json` `visuals.music`.
- The legacy enemy/NPC stack (`enemies.json`, `npcs.json`, the old AI/spawn systems, NPC entities and the pre-People station menu) is gone. Hostiles are ship bodies (`Enemies.ts`), people are `People.ts`.

### Safeguards

- **Licences**: the hangar fits a part only if its material and function are licensed (`Hangar.licensedFor`), however it was got (bought plates, salvage); a plan the pilot knows builds as designed, up to the plan's own count of each part.
- **Pay**: ore-run and supply-drop bounties are scaled like the rest (`payOut`). A boss pays full credits on a pilot's first kill, then `bosses.json rules.repeatCredits` (0.25), and no second copy of an artefact they hold (stat `boss:<id>`).
- **Station repair** bills the cheapest station in range at its `repairCostPerHp`, from the free-rebuild level up; a pilot who can't pay is patched at a quarter rate for free (`Pilots.payRepair`).
- **Connections**: only `join`, `ping` and sign-in before joining; at most 16 inputs a tick, scheduled no more than 64 ticks ahead, 32 waiting; a client that sends state hashes and then goes quiet for 3 s lets go of its controls. `join` carries `protocol`: a mismatch closes with 4002 ('version') and the client asks for a reload.
- **Entity ids**: `ShipBridge.forget` clears every per-ship map when a body goes, so a reused id never inherits a battery, heading, gunnery or boss damage.

### More server performance

- Replication doesn't step shadows in systems no client is in (they're marked out of step, so an arriving client gets real states); docks and environments are built once per tick / per system.
- Beams and fuse targeting test distance before permission lookups; `jumpTuning` and gravity constants are built once.
- Loot pods work out collectors and free cargo once a tick; snapshot HP is converted once per ship per snapshot and skipped for clients already up to date.
- All checked bit-for-bit (world state and every message a client receives) against a deterministic 900-tick run with hostile packs, a belt barrage, beams, and a pilot flying into a system nobody was in.

### Asteroid spin

Asteroids turn at a steady rate set by their id (`asteroidSpin(id, tick)` in `common/src/asteroid/polygon.ts`): the server rotates the hit outline by it, the client the drawn rock and its mining-beam check, so the two always agree.

### Performance pass, 2026-10-25

Measured on the local stack (headless Chrome, 1600×900, RTX 5070 Ti; software rendering via SwiftShader at 960×540 as a stand-in for a weak GPU, where fill cost shows) and with a tick-breakdown harness over `GameServer.step()`.

- **Where things stand:** the client spends about 0.4–1.2 ms of CPU a frame in every scene tried (Sol Central, the Ashfall belt, the Maw, Terra Nova, a 40-ship fight, zoomed in and out to 0.04), the system map adds about 0.4 ms, and the heap holds steady at ~24 MB over minutes of flying (no growth in DOM nodes or listeners, GC well under 1%). The server takes 0.07 ms a tick empty, ~0.3 ms with 10 pilots, ~0.45 ms with 10 pilots and 10 hostile packs, ~1.4 ms with 40 pilots and 140 hostiles.
- **The sun's quad is cut to what it draws** (`SunRenderer.fitQuad`): it spanned five radii, but nothing shows past the flares (1.6 radii) or the atmosphere and corona radii, so anywhere near a star (Sol Central is inside it) the shader ran over the whole screen for transparent pixels. In software rendering at Sol Central the frame went from ~190 to ~130 ms. (The pixels are the same bar float interpolation noise on the rim's fractal.)
- **Shader quads share programs** (`shaderQuad.ts`): each `createShaderQuad` made a new `GlProgram`, which Pixi compiles and links on first draw (30–40 ms), so every arrival in a system with a black hole, brown dwarf, pulsar, planets or comets hitched again. Now one program per source: a repeat visit to Ashfall went from a 50 ms frame to 6 ms, the Maw from 32 ms to 1.6 ms. (A first visit still compiles once.)
- **Turret windows skip parts their rays miss** (`computeTurretWindow`): each part's bounding circle is checked before clipping the ray against its pieces. Same windows (29k compared against the old code across every design with random parts dead), about twice as fast; building every design's ship state went from ~22 to ~12 ms, which is most of what a client does when a crowd of ships syncs on arrival (Sol: 11 → 3.4 ms).
- **Left as they are:** the star layers are now most of the GPU's work in space (about 70–80% of a software-rendered frame; the shader was tuned in an earlier pass and already does only the cells a pixel can see). The server's snapshots grow with clients × rows: with 100 pilots crowded ten to a spot they're half the tick (~4.4 ms on a snapshot tick); at realistic numbers they're well under a millisecond. Entering a system with a stillstone builds its view from scratch every time (`LodestoneView`, about 6 ms in Sol, most of what's left of the arrival frame): left for the stillstone rewrite.
