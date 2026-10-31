# Energy & circuits
How a ship makes, stores and spends power. Power runs along player-drawn wires (`Blueprint.wires`) that join generators to consumers; each wire network is a *circuit* with its own charge, stores and brownout. Capacitors/Pulse Dynamos touching each other form *banks* that feed only what they touch (Surge). The core has its own store (battery on the main circuit, trickle elsewhere). Layout is computed once per `rebuild`; the tick (`powerTick`) runs a loop over circuits and is identical on the server and in client prediction. Design doc: docs/design/energy-system.md (read only "Implemented (Phase 1)" l.26 and "Implemented (Phase 2)" l.156-231; the rest is the original draft/proposals).

## Files (what each owns)
| path | lines | owns |
|---|---|---|
| common/src/ships/wires.ts | 245 | wire cells/keys, `cleanWires`, `autoWire` (designs without wires), `wireNetworks`, `isPowerPart`, spool cost (`SEGMENTS_PER_SPOOL`, `wireSpools`, `addedWires`) |
| common/src/ships/circuits.ts | 292 | `powerLayout()` -> `PowerLayout` (circuits, `StoreGroup`s kinds g/d/w/k, banks, feeds, core store); `circuitTuning`, `partDischarge`, `partCapacity`, `CIRCUIT_DEFAULTS` |
| common/src/ships/energy.ts | 503 | `Charge`, `powerTick` (l.212-375), brownout, `gunLoad`, `feedShare`, `thrustShare`, `remapCharge`, `packCharge`/`unpackCharge`, `circuitCharges`, `loadTest`, `payMining` |
| common/src/ships/surge.ts | 177 | power types (`POWER_TYPES`), Surge reactions (`surgeReaction`, `surgeShot`, `surgeKick`, `flashRestore`), `bankFor`, `railUnheld`, `SURGE_DEFAULTS` |
| common/src/ships/rebuild.ts | - | calls `powerLayout` in one delimited block (l.535-539, "Local circuits") and steady-load sharing (steps 3-4, l.310-355) -> `ShipDerived.power`, `.energy`, `.satisfaction` |
| data/ships/tuning.json `energy` (l.426) | - | `coreCapacity`, `boostDraw`, `coreDischarge`, `coreTrickle`, `discharge{general,drive,weapon,bank}`, `surge{...}` |
| scripts/econ/models.mjs | - | store/generator fields on models: `produce`, `store`, `pool`, `discharge`, `bank`, `surge`, `dual` (battery/capacitor rows in `OTHER`, Surge block l.300) |
| client/src/ships/wireEdit.ts | 299 | hangar wire tool + `powerReport` (circuit colours, warnings); `hullWire.ts` draws wires on the hull |
| client/src/ships/HangarUI.ts | - | POWER panel (`this.power`, l.1462-1510), `drawPower` (l.1925), load test (l.1436 `loadTest`) |
| client/src/ui/CircuitBars.ts | 88 | per-circuit HUD bars (letters, S1.. banks, brownout flash) |
| client/src/ships/partTip.ts | - | Circuit/Bank/"On Surge" tooltip rows (l.143-205) |
| common/src/ships/circuits.test.ts, surge.test.ts | - | guards (below) |

## Public interface
- `ShipDerived.power: PowerLayout` (circuits, stores, core, feeds, `feedOf`, `storeOf`, `circuitOf`, `draw`, `dual`), `ShipDerived.energy: EnergyInfo` (capacities and draws).
- `Charge { core, s: number[] }` (percent per store group); `FULL_CHARGE`; `powerTick(d, charge, PowerUse, tuning) -> PowerResult`; `gunLoad(ship, tick)` = guns' draw per feed group, passed to `stepFlight` as `boost.load`; `remapCharge(before, after, c)` on every rebuild; `chargeTotal`, `circuitCharges`, `capCharge`.
- Wire format: `packCharge`/`unpackCharge`; pilot-row slots start at `CHARGE_GROUPS_AT` (15), at most `MAX_CHARGE_GROUPS` (24) groups. Others index after (strafer.ts `pilotExtras` reads dodge/tow past the groups).
- Surge: `surgeReaction(fn)`, `surgeTuning`, `POWER_TYPES` (colours used everywhere), `bankFor(d, part)`.
- NOTE: the audit names `CHARGE_GROUPS` and `drawsEnergy(fn)`; the real names are `CHARGE_GROUPS_AT`/`MAX_CHARGE_GROUPS` and `isPowerPart` (wires.ts) / `burst` predicate in rebuild.

## Invariants
- Deterministic and identical on both sides: `powerTick` runs inside `stepFlight` (flight.ts l.472) for the server (`ShipBridge.stepMovement`), the pilot (`ShipClient.predict`) and replicas. No Date.now/Math.random, no client/server imports.
- Layout only at rebuild; the tick is O(circuits + feed groups + stores), no per-part loops except guns/thrusters.
- Surge never travels along wires, only by touch inside a bank. Steady loads (shields, scanners, coils) are shared at rebuild, bursty ones (engines, guns, miners, dodge, tow) at the tick.
- Charge rides the snapshot as percent per store group; changing group order/count changes the wire layout (protocol bump + `remapCharge` must keep working). Flash restores are server-only (shields aren't predicted).
- A store gives at most its discharge rate; past it the circuit browns out proportionally (engines first). `BROWNOUT = 0.995`.
- Hand-drawn wires carry cost (spools: server `Hangar.ts` l.165); destroyed cells cut wires.

## How to extend
Add a store/generator type:
1. models.mjs: add the model with `produce`/`store`/`pool`/`discharge`/`bank`/`surge` (see `OTHER` and the Surge block).
2. circuits.ts `powerLayout`: membership (`kindOf` l.136, banks, labels); keep within `MAX_CHARGE_GROUPS`.
3. energy.ts `powerTick`: only if a new rule is needed; read steps in the header comment (l.1-30), then the section you change.
4. Surface it: wireEdit.ts `powerReport`, HangarUI POWER panel, partTip.ts, CircuitBars.ts, field guide Surge section.
Add a Surge reaction: one row in `surgeReaction` (surge.ts), tune in `SURGE_DEFAULTS`/tuning.json, hook where the category acts (guns.ts shots, flight.ts kicks, ShipBridge shields).
Add a new power draw (like the Tow Beam): include it in `gunLoad` (energy.ts l.193) or `PowerUse` (l.166), and the feed group in `powerLayout` (`burst` in rebuild.ts).
New power type: `POWER_TYPES` + `Circuit.type` (circuits.ts, currently `'steady'` only) + colours; update the design doc "Implemented" section.

## Tests
- `npx vitest run common/src/ships/circuits.test.ts` migration (library ships never brown out), circuit isolation, discharge rate, brownout, banks, split/remap, snapshot round-trip.
- `npx vitest run common/src/ships/surge.test.ts` dynamo bank, reactions, Rail Driver, Flash Screen.
- `npx vitest run common/src/ships/ships.test.ts` (energy basics in rebuild/powerTick), `strafer.test.ts`/`tow.test.ts` (burst draws), `client/src/ships/wireEdit.test.ts` (wire tool, report).

## Gotchas
- Any enemy/boss design without wires is auto-wired as ONE circuit; keep that so old fights behave.
- Battery capacity of the main circuit and the core are one general pool: they give together (`takeGeneral`).
- Adding a store changes group indices; stale `Charge.s` after rebuild must go through `remapCharge`.
- Engines draw whichever way they push (no direction-aware draw); a loaded gun fires its first shot on an empty circuit (decisions in the design doc).
- Beams, pulse lasers and mining lasers have no Surge reaction yet.
- Energy.ts was the biggest single-commit churn file; read by header comment and the function you need, not whole.

## Related areas
- [ship-parts](ship-parts.md) (models/fields, rebuild). [flight](flight.md) (`stepFlight` calls `powerTick`, kicks, cargo, dodge). [weapons](weapons.md) (`guns.ts` charged shots, `gunLoad`). [hangar-ui](hangar-ui.md) (wire tool, POWER panel, load test), [ui-hud-input](ui-hud-input.md) (CircuitBars), [networking](networking.md) (charge groups in the pilot row, PROTOCOL_VERSION).

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **Phase 1 summary**: each wire network keeps its own charge; every store gives at most its `discharge` a second (past it the circuit browns out: guns reload slower, engines push less, beams burn that share of the time); capacitors give only to what they touch; the core's store is a battery on the main circuit plus a trickle to the rest. Layout is worked out at the rebuild (`circuits.ts`), run each tick by `energy.ts` (server and pilot prediction alike). Numbers: `discharge` in models.json (from `scripts/econ/models.mjs`), `energy` in `data/ships/tuning.json`. `circuits.test.ts` flies every library ship through a scripted fight and fails if a discharge rate ever bites. Design and decisions: `docs/design/energy-system.md`, "Implemented (Phase 1)".
- **Pools** (`FunctionDef.pool`; capacity `store` x area x grade output): general (core's `tuning.energy.coreCapacity` plus standard batteries) serves everything; drive batteries feed engines only; weapon batteries feed guns and mining lasers only. In the rebuild flow solve only steady loads (shields, scanners, jump coils) share the generators' supply; engines, guns and mining lasers get satisfaction 1 if power reaches them. `derived.energy` holds the capacities, the spare power after steady loads, and the draws.
- **Per tick** (see the `energy.ts` header): engines first (spare stream, then drive pool, then general; boosting draws `1 + boostDraw x boostDrain` times as much and needs stored charge), then guns (`WeaponInfo.energy` per shot, beams per tick, from weapon pool then general; with the stores dry they are silent) and mining lasers (per 15-tick segment aligned to the tick count, `payMining`, `ShipState.minePaid`). Spare power charges the pools in proportion to how empty each is.
- **Charge on the wire**: `Charge` is percentages per pool, kept per ship in `ShipBridge.charge` (absent: full), sent in the pilot's own snapshot (`data[1]` general, `data[10]` drive, `data[11]` weapon; `data[9]` charging-field flags, `data[12]` a stillstone's priming, negative for a scarred one's) and predicted on the client (`GameState.charge`). `Boost.fuel`/`GameState.boostFuel` are the combined percentage for the ENERGY gauge (`chargeTotal`). Pilotless ships' flight is not metered; their guns are. `rateShip` counts guns at the rate energy sustains.
