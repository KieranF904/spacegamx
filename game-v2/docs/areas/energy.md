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
- Wire format: `packCharge`/`unpackCharge`; pilot row `data[8]` the pool percent, `data[9]` the group count (1 + banks), groups from `CHARGE_GROUPS_AT` (13): the pool's, then each bank's, at most `MAX_CHARGE_GROUPS` (24). `CHARGE_GROUPS_LAYOUT` is in the wire hash. Part features' values follow, in the order of `features.wire.json` `pilotExtra`.

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

## Ports core (designs with `power: 'ports'`; docs/design/energy-ports-2026-11.md §14)
`common/src/ships/power/ports.ts`: `buildPortsLayout` (rebuild.ts, when `blueprint.power === 'ports'`: then `ShipDerived.ports` is set and `.power` is absent), `portsTick` (energy.ts `powerTick` branches to it; `Charge.e` is the `PortsState`), the guns' gates (`portsGunReady`, `portsSpendShot`, `portsBeamStep`: guns.ts), `portsSwitchFeeds` (the `feedSwitch` message, key Y), the wire (`packPorts`/`unpackPortsInto`: triples in the pilot row, counted negative in `data[9]`; `ensurePortsCharge` on the client). Data: models.mjs "ports energy core" block (`ports`, `profile`, `takes`, `feedPort`, the feed parts), tuning.json `feeds`, the core's ports in functions.json. Tests: `common/src/ships/power/ports.test.ts` on the three dev ships.

## Power core (P1 of docs/design/energy-routing-impl.md; nothing in the game runs it yet)
`common/src/ships/power/` (exported from `@space-game/common`): the touch-routed replacement for circuits.ts/energy.ts, built
to §0 of the spec: **no wires** (power moves only between parts that share a full edge: rebuild's `joins`, bespoke joins
included, never a corner), clips are true magazines with a manual Reload, beats unchanged at full supply. Pure,
deterministic, integer eu (1/256 E), allocation-free per tick (module scratch: not re-entrant). P2 switches the game to it.

| file | exports |
|---|---|
| units.ts | `EU` (256), `toEu(E)`, `fromEu(eu)`, `perTick(E/s)` (rounded), `perTickUp(E/s)` (weapons' intake: rounded up so a gun keeps its beat) |
| layout.ts | `buildEnergyLayout(input: EnergyLayoutInput): EnergyLayout`, `layoutSig(L)`, `partHolds`/`partGives`/`partTakes(fn, area, mat[, pt])`, `powerTuning(tuning)`, `POWER_DEFAULTS`; `ROLE_*`, `GUN_SHOT`/`GUN_CLIP`/`GUN_BEAM`, `PHASE_THRUST`/`PHASE_TOOL`/`PHASE_WEAPON`, `NO_FILL_BOUND`, `NO_DEPTH`. Layout extras: `rounds` (a clip's salvo), `depth` (a relay's hops from generation). The sig leaves out generators' and dynamos' rates (health-scaled) |
| state.ts | `EnergyState {sig, held: Int32Array, flags: Uint8Array, sat: Uint8Array, shieldSat, gauge}`, `FLAG_LATCH` (1), `FLAG_LIT` (2), `createEnergyState(L)` (full), `fullEnergy(L, out?)`, `remapEnergy(e, after, sameDesign)`, `energyGauge(L, e)`, `energyGaugePct(L, e)` |
| tick.ts | `energyTick(L, e, ctl: EnergyControls, trace?)`, `thrustFrac()`/`thrustMul()` (by part, scratch), `stepThrustersFree(L, e, ctl)` (replicas), `settleEnergy(L, e, ticks, ctl?)` (default: tools asleep, wanting nothing; never refills an unlatched clip), `IDLE_CONTROLS` (every tool at full rate), `SETTLE_TICKS`; `genLeft()`/`givesLeft()`/`takesLeft()` (by part, scratch: waste and the Gives/Takes left after the tick); `drawFromRelays(L, e, p, eu, whole?)` (a one-off draw from the relays feeding p, fullest first: Flash); the guns' gates: `gunReady(L, e, p, n = L.rounds[p])`, `spendShot(L, e, p, n = L.rounds[p])` (returns eu, latches a clip that can't pay another salvo), `clipRounds(L, e, p)`, `beamStep(L, e, p, trigger)` (returns eu burnt). Every scratch accessor is valid only straight after the tick, for that layout's parts of its role |
| wire.ts | `ENERGY_SLOT_LAYOUT`, `ENERGY_ROW {sig: 8, count: 9, at: 13}`, `packEnergy(L, e, out)` (appends sparse `(part, held*4+flags)` pairs, returns n), `energySlotEnd(data)`, `unpackEnergyInto(L, e, data)` (false on a sig mismatch), `energyDigest(L, e)` (u16 over held/flags: §4.1b stateHash), `packThrusterTail`/`unpackThrusterTail` (P3) |

- **Input** (`EnergyLayoutInput`, all from rebuild): `fns`, `area`, `mats`, `alive`, `joins`, `core` (index or -1),
  `tuning`, `weapons` (`{part, fire, interval}` from WeaponInfo: a gun not listed is inert; `interval` with mods but
  **without** today's `/ satisfaction` term), `geoms` (for a Diode's out edge: pass it, or no Diode gives), `health`
  (generators and dynamos × it). A store with `relayOnly` (the Conduit, P4) or `oneWay` (Diode) is never topped up by a
  dynamo.
- **Roles**: generator `produce`; relay = the core or any `store` (Battery, Capacitor, Drive Cell, Heavy Bank, Conduit,
  Diode `oneWay`); thruster = engine or `strafe`; tool = any other `demand`; weapon; dynamo. Legacy defaults: a store
  with no `discharge` Gives `energy.discharge.general` (600)/cell and Takes a quarter; a legacy gun's shot is its draw
  over its interval, buffer 1, intake its draw; a legacy beam burns and takes its draw, buffer 2 s; a legacy engine
  takes its boost burn and buffers 1 s of it.
- **Controls** (`EnergyControls`): `active` (by part: thrusters pushing this tick; flight and the strafer set it),
  `boosting`, `toolWant` (by part, eu this tick; null = every tool its full rate), `reload` (D2: latches every clip not full).
- **Tick order**: budgets; thrusters take in then burn (boost only when it beats cruising); tools (`sat`, `shieldSat`);
  weapons take in (a clip only while LATCHED; latch clears at full; a beam's at relight); generators push into touching
  relays; relay pairs even out (one pass, one-way pairs never backwards; a full relay closes the last rounding gap to a
  deeper one, `L.depth`, so chains fill exactly and never bounce); dynamos; gauge. serve(): generators first, then
  relays fullest first, each waterfilling across its consumers smallest want first.
- **Guns (P2.3 calls these from stepGuns)**: ready = `gunReady` (+ the mechanical cooldown); a charge gun's timer runs
  only while `gunReady`; fire = `spendShot`; beams call `beamStep` each tick they are held.
- **Trace** (hangar): `Float64Array(L.links)`; link ids: feeds `[0, linkPush)`, pushes, pairs (signed), dynamos;
  `linkFrom`/`linkTo` per id.
- Tests: `npx vitest run common/src/ships/power` (layout, tick scenarios from the prototype, 10k-tick determinism, wire
  round trip). Bench: `POWER_BENCH=1 NODE_OPTIONS=--expose-gc npx vitest run common/src/ships/power/tick.bench.test.ts`.

## Design rules (for ship designers; scripts/shipgen reads the block below into its prompt: keep it true to the power core)
<!-- shipgen:rules -->
- Power moves only between parts that share a full cell edge (they touch). A corner touch carries nothing. There are no wires.
- A GENERATOR pushes its power into the stores, conduits, diodes, the core and the consumers it touches. Nothing else makes power.
- A STORE (and the CORE) holds power and passes it to every part it touches: consumers, and other stores (touching stores even out). It gives at most its Gives a second and takes in at most its Takes a second.
- A CONDUIT is a power line: it passes power between the parts it touches, both ways, and holds very little. Use a row of them to reach parts far from the generators.
- A DIODE passes power one way: out of its marked side (^ > v <), into the part there, which it must touch. The parts touching its other sides can only feed it. Use it to keep a reserve (for engines or shields) that the guns can't drain.
- Hull, armour, cargo and every other part marked "carries no power" pass no power: a gun behind hull gets nothing.
- Every CONSUMER (guns, engines, shields, tools) must touch a generator, store, conduit, diode or the core, and that chain must lead back to a generator. A consumer drawing on a chain gets no more than its weakest link gives.
- Put generators beside the stores that feed the hungriest parts (big guns, boosting engines), and give each group of guns or engines its own store.
- Parts that face out (guns, engines, mining tools) need the edge they face left free: nothing across it. Engines usually face back (v); fixed guns face forward (^); turrets may face out at the sides.
- Every part must touch the ship by a full edge, part to part, back to the core. A ship has exactly one core.
<!-- /shipgen:rules -->
