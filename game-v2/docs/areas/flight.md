# Flight & physics
How a ship moves: `stepFlight` turns inputs plus `ShipDerived` (thrust, mass, inertia, drive) into velocity/angle changes with PD turning, friction, boost, gravity wells, the jump drive, the Stabiliser Anchor brace, the Burst Strafer dodge and cargo/tow mass. `stepShipPhysics` wraps it with terrain collision and rounds the result to snapshot precision so the server, the pilot's client prediction and the replica shadow land on identical numbers. All of it is pure, shared code in common/src/ships.

## Files (what each owns)
| path | lines | owns |
|---|---|---|
| common/src/ships/flight.ts | 536 | `FlightBody`, `FlightControls`, `FlightConstants`, `stepFlight` (l.364-526: jump l.375, anchor l.379, rotation l.410, thrust l.438, strafer l.456, integrator l.516), `stepDrift`, gravity, jump drive state machine (`stepJump`, `jumpPhase`, `jumpRange`, `JumpTuning`, l.116-300), `accelAlong`, `turnAccel`, `ratedFade` |
| common/src/ships/physics.ts | 61 | `stepShipPhysics` (stepFlight + `collideTerrain` + `quantizeShipBody`), `SHIP_PRECISION`, `SHIP_FLIGHT_CONSTANTS` |
| common/src/ships/state.ts | 171 | `ShipState` (blueprint, per-part hp, derived, cooldowns; no position), `createShipState`, `damagePart`, `healPart`, `rebuildShip` |
| common/src/ships/load.ts | 49 | cargo mass: `cargoThrust`, `cargoTurn`, `cargoEffect`, `quantizeCargo`, `CARGO_TURN_SHARE` |
| common/src/ships/anchor.ts, strafer.ts, tow.ts | 124/128/103 | brace counter `stepBrace`; dodge counter `stepDodge`, `strafeForce`, `canDodge`; tow tether physics `towPull`, `towLoad` |
| common/src/ships/replica.ts | 136 | `replicaStep`, `controlBits`/`flightControls`, `CTL` bit flags, `ReplicaMode`: replay a ship from keyframe + control bits |
| common/src/ships/jumpFields.ts, hazards.ts, warmth.ts | 170/107/110 | jump charging fields; hazard and cold effects on control (`hazardFlight`, `withEmp`, `withNumb`) |
| common/src/ships/collide.ts | 158 | hit tests in grid space: `castParts`, `partDistance`, `nearestParts`; `stages.ts` which part is hittable on staged bosses. Hit tests are used by [weapons](weapons.md), not flight |
| common/src/terrain.ts | - | `collideTerrain`, `terrainRadius` (planet-surface rock) |
| server/src/ships/ShipBridge.ts | 2453 | server flight step `stepMovement` (l.1230-1280), `readBody`/`writeBody` (l.2360), debris/anchored drift (l.1790-1830) |
| client/src/ships/ShipClient.ts | 1154 | `predict()` (l.944-985) pilot prediction, `predictGuns` (l.436) |
| server/src/net/Replication.ts | - | the shadow `replicaStep` (l.113) that decides when a keyframe is needed |
| data/ships/tuning.json `flight`, `jump`, `anchor`, `tow`, `strafe` | - | gains and constants; read via `jumpTuning`, `anchorTuning`, `towTuning` |

## Public interface
- `stepFlight(body, input, derived, tuning, boost{charge,drainRate,load?,tick?}, k) -> FlightResult`; call `stepShipPhysics(body, input, derived, tuning, boost, gravity, jumpBoost, hazard, terrain)` instead; never quantize by hand (`quantizeShipBody`).
- `FlightBody` {x,y,vx,vy,angle,angVel, jump?, jumpScale?, brace?, cargo?, dodge?, dodgeSpent?}; `FlightControls` {forward, backward, left, right, boost, targetAngle, helm?, strafeLeft?, strafeRight?, jump?, jumpDist?, brace?, dodge?}.
- Counters on the body (jump, brace, dodge, dodgeSpent) are the whole feature state and ride keyframes/snapshots.
- Wire side of the input bundle: protocol.ts input message + binary flags2 (l.1159-1221: strafeLeft/Right, helm, jump, targetTick, brace, dodge, dodge-right); `CTL` bits in replica.ts; server `Input.*` ECS arrays (GameServer.ts input handler ~l.3459-3464 and reset ~l.3918).
- Jump: `jumpDriveStats`, `pilotJumpStep` (jumpFields.ts) wrap a step with field boosts; both ShipBridge and ShipClient use it.

## Invariants
- Deterministic: no Date.now, Math.random, I/O, imports from client/server. Same inputs -> same body, bit for bit.
- Server and client MUST feed `stepShipPhysics` identical data: body fields, controls, charge/load/tick, gravity, rangeBoost, hazard (EMP via `withEmp`, cold via `withNumb`), terrain. Divergence shows up as rubber-banding.
- Quantization: results rounded to `SHIP_PRECISION` (pos 2, vel 4, angle 5, angVel 6 decimals) after every step; cargo to `CARGO_PRECISION`. Never carry unrounded state across a tick.
- Cargo (hold + tow load) is part of the body (`body.cargo`), not stepped; flight divides thrust over mass + cargo (`accelAlong`).
- Losing parts never makes a ship quicker: flight divides by `fullMass`/`fullInertia`; `derived.drive` scales a wrecked ship's engines.
- A jump burn disables steering, thrust, friction and gravity; the anchor brace and dodge are gated by the jump state.
- `flightSignature(d)` equality = identical flight; changing what flight reads from `ShipDerived` must stay inside it.

## How to extend
Add a flight-affecting ability (brace-style):
1. Part and `ShipDerived` key: see [ship-parts](ship-parts.md) (rebuild.ts feature block l.463-535).
2. Feature file `common/src/ships/<x>.ts`: tuning + pure `stepX(counter, want, able, t)`; keep state as ONE integer on `FlightBody`.
3. flight.ts: add the field to `FlightBody` and the control to `FlightControls`; hook into `stepFlight` at the matching banner (read only that slice).
4. Controls plumbing, ALL copies: protocol.ts input type + binary flags (bump `PROTOCOL_VERSION`, `npm run wire:bump`), GameServer input handler + reset (`Input.x`), `controlBits`/`flightControls`/`CTL` in replica.ts, ShipBridge.stepMovement (body read + input), ShipClient.predict (body + `player.x` write-back), client input collection (`ui-hud-input`), `GameState.ts` pilot-row parsing (`player.dodge` etc.). The audit flags these hand-copied lists as the top drift risk.
5. Keyframes/snapshots: pilot row extras (`pilotExtras` in strafer.ts, GameServer ~l.5040).
Tune: edit data/ships/tuning.json, never inline constants; respect the `xxxTuning` default pattern.
Add a velocity source (gravity, hazard): through `FlightConstants`, not in the bridge.

## Tests
- `npx vitest run common/src/ships/ships.test.ts` flight basics, jump drive (l.615+, incl. determinism through the quantised step l.796).
- `npx vitest run common/src/ships/anchor.test.ts strafer.test.ts tow.test.ts jumpFields.test.ts hazards.test.ts warmth.test.ts` feature flight effects (anchor.test.ts also covers cargo/load).
- `npx vitest run common/src/ships/models.test.ts` (engine rated-speed fade, "same steps on both sides").
- `npx vitest run server/src/net/replication.test.ts server/src/ships/ships.engine.test.ts server/src/ships/collisions.test.ts common/src/ships/collide.test.ts common/src/terrain.test.ts`
- `client/src/ships/autopilotFlight.test.ts` (autopilot courses flown through the shared step).

## Gotchas
- ShipBridge.stepMovement and ShipClient.predict each build a `FlightControls` and body by hand; cargo, brace, dodge were each added in both places. A new field missing on one side is a silent desync. (Audit P10: extract a shared `buildFlightInputs`.)
- `replicaStep` (shadow on the server, Replication.ts) uses `FULL_CHARGE`, `drainRate 0`, and the control bits only: anything not in `CTL`/keyframe (jump distance, cargo, cursor) is not replicated, and a mismatch forces a keyframe. `replica.ts` header says clients replay too; at this time no client code calls `replicaStep`.
- Jump landing distance isn't replicated: the burn start triggers a keyframe.
- Berthed pilots skip prediction (`ShipClient.predict` early return).
- The Tow Beam's towed object is moved by the server only (server/src/game/Towing.ts) and never predicted; only its load (cargo mass) is.
- Never import collide.ts hit tests for gameplay damage outside the weapons code path; use the same functions server and client.

## Related areas
- [energy](energy.md) (`powerTick` inside `stepFlight`, `boost.load`), [ship-parts](ship-parts.md) (`ShipDerived`), [weapons](weapons.md) (hit tests via collide.ts, anchor weapon mods), [networking](networking.md) (input message, keyframes, pilot row, `PROTOCOL_VERSION`), [server-core](server-core.md) (tick order, input handler), [ui-hud-input](ui-hud-input.md) (key bindings to controls), [world-sim](world-sim.md) (gravity wells, hazards, terrain), [bosses-ai](bosses-ai.md) (stages, Pilotless mode).

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **Cargo mass**: a hold's contents have mass (`ItemCatalog.mass`: the item's `mass` in items.json, else `CATEGORY_MASS` by category x its volume; station storage weighs nothing). It rides on `FlightBody.cargo` (from `Pilots.cargoMass` each tick) and divides thrust and turning in `flight.ts` against the ship's own mass (`load.ts`), so the server, the pilot's prediction (snapshot `data[15]`) and replicas (keyframes carry it) fly the same load. `ItemCatalog.massOf(stacks)` is the hook for pay-by-weight jobs.
- **Stabiliser Anchor** (`functions.anchor`, model `utility_stabiliser_anchor`): braces on a toggled control (input flag `brace`, replica bit `CTL.brace`, key Y). Counter `FlightBody.brace` (`anchor.ts`; snapshot `data[14]`) spools in and out; while braced, flight holds the ship, guns get `bracedWeaponMods` (`gunDef braced`), shields recharge faster (`ShipBridge`), pulls and knockback go through `ShipBridge.pullShare`. Numbers: `tuning.json anchor` over `DEFAULT_ANCHOR`.
- **Burst Strafer** gives no thrust, only a dodge: the held `dodge` control (input flags2 0x40/0x80, replica bits `CTL.dodge`/`dodgeRight`, key Space; `ShipClient.dodgeControl` picks the side you steer) starts one burst of `strafe.ticks` from every powered strafer pushing that way and spends one of `strafe.charges`. State is two integers (`dodge`, `dodgeSpent`) stepped in `flight.ts stepDodge`, carried in keyframes and the pilot's row after the charge groups (`pilotExtras`). A burst draws `demand` via `PowerUse.dodge`: first from the capacitor bank the strafer touches, then its circuit as an engine. Numbers: `strafe` per model in models.mjs.
- **Tow Beam** is server-side (`server/src/game/Towing.ts`): `{ type: 'tow', on }` (key U) takes hold of the wreck, debris or pod nearest the cursor (never a working ship: `ShipBridge.towable`); a spring tether (`towPull`) pulls it each tick. Its mass rides as cargo (host `towLoad`) so prediction flies the load, and the beam draws while it tows (`ShipState.tow`, `gunLoad`). In a station's reach `GameServer.towDelivered` salvages it (wreck/debris structure as plate via `tow.salvage` into storage plus a derelict's credits; a pod's contents into storage). Numbers: `tuning.json tow` over `DEFAULT_TOW`.
- **Jump drive** (J; `stepJump`, `jumpPhase`, `jumpBurnSpeed`, `tuning.json jump`): one counter (`ShipState.jump`, `FlightBody.jump`): ready, charging while held, burn, cooldown. Rides in player snapshots as `data[3]`, control as an input bit. Charging lets you aim but takes the engines and brakes the ship; releasing cancels with no cooldown. The burn flies along the nose at fixed speed (~70k units in ~3.5 s, then 15 s cooldown) with no steering, friction or gravity; guns don't fire and the ship passes through hulls. The client latches J until the burn starts; J again aborts; `client/src/ships/JumpFx.ts` draws charge rings, flashes, wake, streaks and the gauge, and the camera locks and pulls back. The proto repair key is U.
- **Stillstone fields** (`jumpFields.ts`; "lodestones" in code): a live one's field reaches `jump.lodestoneField` past its `size` (`lodestoneFieldRadius`), speeds the drive's cooldown and primes the next jump; scarred ones give `lodestoneScarredCharge`/`lodestoneScarredBoost` of that (fractional charge counted in whole ticks by tick number, `wholeTicks`; priming kept negative, `primeBoost`); dead and shattered ones nothing. Server, prediction and replicas all run it from `systemInfo.lodestones`.
- **Flight damage**: `rebuild.ts` gives every ship mass and inertia as built (`fullMass`, `fullInertia`: every part but unbuilt hangar ghosts) and a `driveFactor` (1 whole, ~0.7 at half its mass, ~0.35 down to a core and a few parts). `accelAlong`/`turnAccel` divide by them and multiply by the drive, so losing parts never makes a ship quicker. Ghosts travel in `shipSync.ghosts` so prediction agrees. The core's maneuver force (3) and gyro are unchanged.
- **Scale**: `cellSize` 24 (hulls 3x larger), thruster `thrust` 2.26 and `coreManeuverForce` 3 (doubled), `gyroTorque` 216 and `thrusterTorqueGain` 9 keep turn rates; `BULLET_SPEED` 48. Thrust direction stays screen-relative: force along the input is the sum of thruster projections, floored by `coreManeuverForce`; turning torque = core gyro + `thrusterTorqueGain` x side thruster torque about the COM. Mouse-steer and helm share one flight model (the `helm` bit is in every input). Collisions use shrunk convex pieces and an impulse along the deepest-penetration normal (`tuning.collision`).
- **Docking** (`conn.docked`): a docked ship sits at the station's centre (put back at `docked.exit` on undock); `GameServer.dockedShips` lists them. Invulnerable, out of `canDamage` both ways, skipped by contacts, cannot fire (`ShipHost.sheltered`), left out of hostiles' and bosses' player lists. `ShipRenderer` hides docked ships; `ShipClient.predict` holds you at the station.
- Gravity wells (`centralBody.gravity`: strength, minRadius, horizon) are part of the shared step; crossing the horizon destroys a ship (The Maw, the Void Sector).
