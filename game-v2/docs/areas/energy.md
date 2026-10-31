# Energy & banks
How a ship makes, stores and spends power. Power runs along wires (`Blueprint.wires`, hand-drawn or auto-wired) that join generators to consumers, exactly as before 5896116. The core's store and every battery on a powered network make **one ship pool**; Capacitors that touch form a **bank** that feeds the guns, beams and mining lasers it touches first, and touching Drive Cells a bank that feeds the engines and Burst Strafers they touch. Layout is computed once per `rebuild` (`circuits.ts`); the tick (`powerTick`) is identical on the server and in client prediction. Binding design: docs/design/rework-2026-11.md §2 (2.1 wiring, 2.2 pool and Output, 2.3 banks, 2.5 the wire). docs/design/energy-system.md is history (Phase 1 circuits, Phase 2 Surge: both cut).

## Files (what each owns)
| path | owns |
|---|---|
| common/src/ships/wires.ts | wire cells/keys, `cleanWires`, `autoWire` (designs without wires), `wireNetworks`, `isPowerPart`, spool cost (`SEGMENTS_PER_SPOOL`, `wireSpools`, `addedWires`) |
| common/src/ships/circuits.ts | `powerLayout()` -> `PowerLayout` (the pool, `Bank`s, feed groups, per-part `feedOf`/`bankOf`/`draw`/`partCap`/`pooled`); `bankKind`, `circuitTuning`, `partDischarge`, `partCapacity`, `CIRCUIT_DEFAULTS` |
| common/src/ships/energy.ts | `Charge {g, b[]}`, `powerTick` (engines, then guns/miners/features sharing the Output, then refill emptiest first, then dynamos), `BROWNOUT`, `gunLoad`, `feedShare`, `thrustShare`, `remapCharge`, `packCharge`/`unpackCharge`, `bankCharges`, `loadTest`, `payMining` |
| common/src/ships/rebuild.ts | the "powered" rule (steady loads share their network's generators by priority; engines, guns, miners and burst features run if their network has a generator or a battery, or a bank of their kind touches them) and the `powerLayout` call -> `ShipDerived.power`, `.energy`, `.satisfaction` |
| data/ships/tuning.json `energy` | `coreCapacity` 240, `boostDraw` 2.2, `coreDischarge` 720, `discharge{general,drive,bank}` |
| scripts/econ/models.mjs | store/generator fields: `produce`, `store`, `pool` (`'drive'` makes a bank member a Drive Cell), `discharge`, `bank`, `dynamo` (Pulse Dynamo: per second into each bank it touches) |
| client/src/ships/wireEdit.ts | hangar wire tool + `powerReport` (network colours `NET_COLORS`, unpowered warnings), as at 5896116^ |
| client/src/ships/HangarUI.ts | POWER panel (`powerHtml`: networks, pool and Output, banks, load test), `drawPower` + `drawBanks` (bank outlines and straps) |
| client/src/ui/BankBars.ts | HUD: a thin bar per bank (at most 4) beside the ENERGY gauge |
| client/src/ships/partTip.ts | Holds/Gives/Charges, Bank and "Fed by" rows |

## Public interface
- `ShipDerived.power: PowerLayout` (`pool {cap, rate, coreCap, coreRate, parts}`, `banks: Bank[]` (`kind` cap/drive, `parts`, `cap`, `rate`, `feeds`, `refills`, `dynamo`, `dynamos`), `spare`, `feeds[].banks`, `feedOf`, `bankOf`, `draw`, `partCap`, `pooled`), `ShipDerived.energy: EnergyInfo`.
- `Charge { g, b: number[] }` (pool %, then each bank's in bank order: banks number by their lowest part index); `FULL_CHARGE`; `powerTick(d, charge, PowerUse, tuning) -> PowerResult`; `gunLoad(ship, tick)` = guns' draw per feed group, passed to `stepFlight` as `boost.load`; `remapCharge(before, after, c)` on every rebuild; `chargeTotal`, `bankCharges`, `capCharge`, `poolHeld`, `bankHeld`.
- Wire format: `packCharge`/`unpackCharge`; pilot row `data[10]` the pool's %, `data[11]` the group count (1 + banks), groups from `CHARGE_GROUPS_AT` (15): the pool's, then each bank's, at most `MAX_CHARGE_GROUPS` (24). `CHARGE_GROUPS_LAYOUT` is in the wire hash. Part features' values follow, in the order of `features.wire.json` `pilotExtra`.

## Invariants
- Deterministic and identical on both sides: `powerTick` runs inside `stepFlight` for the server, the pilot (`ShipClient.predict`) and replicas. No Date.now/Math.random, no client/server imports. Per-tick scratch is module-level (`grow`); a tick allocates only its result.
- Output = spare generation + the pool's rate while it holds charge. Engines are served first (their Drive Cell banks, then the Output); guns, beams, miners and `PowerUse.extra` then draw their Capacitor (or Drive Cell, for strafers) banks first and share what's left equally. A bank gives at most its rate a tick; nothing but what it feeds can drain it.
- Banks refill from spare generation only with a member on a powered network, plus their Pulse Dynamos. Refill brings the emptiest stores up first (one level, by percentage).
- Charge rides the snapshot as percent per group; changing group order/count changes the wire meaning (protocol bump + `remapCharge` must keep working).
- Hand-drawn wires carry cost (spools: server `Hangar.ts`); destroyed cells cut wires.

## How to extend
Add a store/generator: models.mjs fields (`produce`/`store`/`discharge`/`bank`/`pool`/`dynamo`); `circuits.ts` only for a new kind of membership. A new power draw: make it a part feature (features/README.md). `burst: true` puts its parts on a feed group; `burst: 'engine'` lets Drive Cell banks feed it; a `load` hook adds to `gunLoad` (Tow Beam), a `thrustGate` hook asks through `PowerUse.extra` (Burst Strafer). No edit to energy.ts.

## Tests
- `npx vitest run common/src/ships/circuits.test.ts`: library fight (0 rate-limited ticks), the powered rule, Output limit, banks (a pool drained by boosting leaves a gun bank full; a Drive Cell gives a strafer 2 bursts), refill and dynamos, splits, the snapshot.
- `common/src/ships/ships.test.ts` (energy basics), `features/strafer/*.test.ts`, `features/tow/tow.test.ts`, `client/src/ships/wireEdit.test.ts`, `server/src/ships/devTestShips.test.ts`; goldens: `common/src/ships/golden` (scenario `drive-bank-boost`), `server/src/golden`.

## Gotchas
- Any design without wires is auto-wired as one network; keep that so old fights behave.
- Pre-5896116 rule: a battery on a network with no generator isn't in the pool, but it makes that network's engines and guns "powered" (they draw on the pool).
- Legacy `drive_battery`/`weapon_battery` are plain pool batteries now.
- If the library fight fails on the Heavy Bank's rate, lower `energy.boostDraw`, not the rate (design rule).
