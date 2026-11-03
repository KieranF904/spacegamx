# Energy routing: implementation spec (2026-11-01)

Status: **implementation plan** for the target agreed with Kieran on 2026-11-01. Sources: the prototype
`prototypes/energy-lab/index.html` (`rebuild()`, `tick()`, the T/W/EN tables), the proposal
`docs/design/energy-economy-2026-11.md` (§1b, 2, 2b, 3, 4), and five code maps. Line numbers are as of commit ae0c3da.

Out of scope: fuel, propellant, the Fuel Tank, the Chem Rocket, the Side Jet, the Flux Coil and the Stellarator. The
prototype's `hullConducts` setting stays off: hull and cargo never conduct.

## 0. Owner decisions (2026-11-01). These override anything below that disagrees.

| # | Decision | What changes in this spec |
|---|---|---|
| D1 | **Wiring is retired.** Power moves only between parts that physically touch. Wires may come back for other features later. | No runs, no `autoWireForest`, no `wireRate`. `wiresOf`/wire segments play no part in power. The hangar wire tool is hidden and spools are no longer billed for wires (P5); `bp.wires` stays readable in the format but is ignored. Power parts never conduct through hull. The Conduit (P4) is the routing part. |
| D2 | **Clips are true magazines, Hive included,** plus a **manual reload button.** | A clip gun fires its N shots with no top-up. Empty → it latches and must refill the whole clip before it fires again. A partly spent clip refills only when the pilot presses Reload (a new flight input bit, both sides; it latches every clip gun not already full). There is no idle auto-reload. The Hive's regrow is replaced by the whole-clip latch. Pick a key that is free in client input (check ui-hud-input.md), show it on the HUD, and replicate the latch in the gun state the pilot already predicts. |
| D3 | **Keep the current fire rhythm and damage.** | Q4 default: Shot is derived from Intake × the current average interval (§5.1). The prototype's cycles are not adopted. |
| D4 | **Enemies and NPCs follow the same rules, thrust included.** | Q2 default, with a server CPU benchmark before switch-over (P2). |
| D5 | **Local priority; Diodes for reserves.** | As in §1.1/§1.3. |
| D6 | **Network budget** (docs/audits/network-firing-2026-11-01.md) | §4.1b is binding. |

Migration under D1: bundled ships are re-routed by touch (P6, `routeCheck`). Players' saved designs keep their format; any
part that no longer touches power shows in the hangar's energy overlay and banner until the player re-routes it.

Terms used below:
- **Relay**: a part that holds energy and passes it on.
- **Consumer**: a dead end that only draws energy.
- **Run**: one connected component of live wire segments.
- **eu**: the integer energy unit, 1/256 E.

---

## 1. Rules (deterministic tick)

### 1.1 Graph (built once per rebuild, from alive parts only)

| Role | Parts | State |
|---|---|---|
| Generator | `produce > 0` (models and legacy) | none (per tick budget only) |
| Relay | Core, Battery, Heavy Bank, Capacitor, Drive Cell, **Conduit** (new), **Diode** (new): anything with `store > 0` or `fn.core` | `held` eu |
| Thruster | engines (`thrust > 0`) and Burst Strafer (`strafe`) | `held` eu (its buffer) |
| Tool | steady loads: shields, scanners, jump coils, miners, siphon, Tow, launchers (`demand > 0`, not engine/weapon) | none (`sat` this tick) |
| Weapon | every `weapon` part (energy and ammo models alike) | `held` eu, `flags` |
| Dynamo | `dynamo > 0` | none |
| Inert | everything else (hull, armour, cargo …) | none |

**Touch.** Two parts touch when they share a full cell edge. This is `computeJoins` from grid.ts (connector keys with
opposite normals). Bespoke-hull overlap joins (grid.ts:191) count too, so power follows structure; it is the same
`joins` list that rebuild already has. Diagonal contact never conducts.

**Runs (wires as conduits).** `wiresOf(bp)` gives the segments (hand-drawn, or auto-laid when `bp.wires` is missing).
- A segment is live while both end cells are covered by alive parts. This rule is unchanged from wires.ts:214.
- Live segments are union-found into **runs**, over wire nodes only. Parts are not merged in, and there is no
  "plugged into a generator" union.
- A part is **on** run r if any of its cells is a node of r.
- A run is a stateless **hyper-edge**: every pair of parts on it is linked through it.
- Each run has a per-tick throughput budget `runRate = tuning.energy.wireRate` (default 200 E/s, the Conduit's rate).
  Every eu that crosses a run-only link spends from that budget.
- When two parts both touch and share a run, the link is a touch link and is free.
- **A Diode never joins a run.** Its cells are skipped when parts are mapped onto runs.

**Auto-laid runs** (`bp.wires` missing): `autoWireForest` in wires.ts is the existing Dial search with **every
generator seeded at cost 0** (today it seeds only the biggest), reaching every power part (`isPowerPart` now counts relays,
thrusters, tools and weapons). The result is one tree per generator, so each auto run carries one generator's output
under its own 200 E/s budget. The tie-break is the seed's part index, then the cell key. It stays cached by `layoutKey`.

**Diode** (1×1, `oneWay: true`). It is a relay (hold 10, gives 200, takes 200) whose **out side** is
`PlacedPart.facing`, and that edge must touch a part (facing rule `'joined'`, §3.4).
- Let O be the part across the out edge.
- If O is a relay, the diode gets a pair (D→O) flagged one-way.
- If O is a consumer, D enters O's source list.
- Every other touching part N may only feed D: a relay N gets a pair (N→D) flagged one-way, and a generator N pushes
  into D.
- No consumer other than O lists D as a source, and D never pulls from O.

**Conduit** (1×1). A plain relay: hold 10, gives 200, takes 200 (prototype numbers). Being a relay already makes it
relay power, so it needs no special code.

### 1.2 Units and quantisation (parity)
- All energy state is **integer eu** in `Int32Array`s. Every per-tick budget is computed at rebuild as
  `perTick(eps) = Math.round(eps * 256 / 60)` and capacities as `Math.round(E * 256)`. Values stay under 2^31 (a
  Heavy Bank holds 1,200 E = 307,200 eu).
- In-tick arithmetic is on integers. Cross products such as `a.held*b.hold` stay below 2^53, so doubles hold them exactly.
  Use `Math.floor`. The only float is the thrust fraction `use/need`, a division of two integers, which is identical
  on both sides.
- Because the state is integer, the server's state, the wire values and the client's state are the same numbers.
  Reconcile is exact, and the 1 Hz state hash (gauge) can't drift.

### 1.3 The tick: `energyTick(L, e, ctl, trace?)`, 60 a second, in `stepFlight` where `powerTick` runs today

`L` is the layout, `e` the per-ship state, `ctl` the controls this tick. Order (the prototype's, adapted):

0. **Budgets.**
   - Each generator gets `genLeft = genRate`.
   - Each relay gets `gLeft = give` and `tLeft = take`.
   - Each run gets `runLeft = runRate`.
   - Clear `sat`.
1. **Thrusters.** Phase consumers = thrusters, in part order.
   - **Want:** `min(intake, cap − held)`, served by **serve()** (below), then added to `held`.
   - **Active:**
     - A main thruster is active when `ctl.thrusting` and `force·dir > 1e-9`. This is today's rule: it burns its
       full Burn whenever it pushes at all.
     - A strafer is active while its dodge burst runs (`dodge` counter 1..ticks).
   - **Burn:** `need = burn`, `use = min(held, need)`, `held -= use`, `frac = use/need`.
   - **Boost** (`ctl.boosting`, the thruster has `bBurn > burn`):
     - Compute boost `fracB = min(held,bBurn)/bBurn` with thrust `bThrust·fracB`, and cruise `fracC` with thrust
       `thrust·fracC`.
     - Take whichever gives more thrust, and burn that one's `use`.
     - Write `mul = bThrust/thrust` when boost wins, else 1. **Holding boost is therefore never slower than cruising.**
   - Write the scratch `frac[t]` and `mul[t]`. An inactive thruster gets `frac = 1`, `mul = 1`.
2. **Tools.**
   - **Want:** `demand·area` per tick while working. Shields always want; a shield that is full and not regenerating
     wants 0. Miners and Tow want while on (feature `want` hook); scanners and coils always want.
   - **Serve**, then `sat[p] = round(255·got/want)`. Shields also get one aggregate `e.shieldSat`, 0..255.
3. **Weapon intake.** Want per weapon (from §1.4), then serve, then add to `held`.
4. **Generators push.** Each generator, in part order, waterfills `genLeft` into its touching and run-linked relays.
   - Each relay's want is `min(tLeft, cap − held)`.
   - A run link also spends `runLeft`.
5. **Relay equalisation.** Pairs in their fixed order (sorted by `(a, b)` part index at rebuild). For each pair:
   - If fill(a) < fill(b) (cross-multiplied), swap so energy moves from the fuller to the emptier.
   - **A one-way pair moves nothing when the swap would reverse it.**
   - `want = floor((a.held·b.hold − b.held·a.hold)/(a.hold+b.hold))`.
   - `t = min(want, a.gLeft, b.tLeft, a.held, b.cap − b.held, runLeft if via a run)`.
   - Move `t`. This is a single pass, as in the prototype.
6. **Dynamos.** Each adds `min(rate, cap − held)` to each touching store relay (not to Conduits or Diodes).
7. **Gauge.** `e.gauge = Σ relay held` (an integer, kept for the HUD and the state hash).

**serve(phase)**: consumers draw from what touches them, generators first, then the fullest relay.
- **Precomputed at rebuild**, per phase, in CSR form:
  - the phase's source list, with generators first in part order, then relays;
  - for each source, the consumers in that phase that it can feed, each with its `via` (−1 for touch, otherwise the run
    id).
- **Per tick:**
  - Insertion-sort the phase's **relay** sources by fill, descending. Ties go to the lower part index. Use module
    scratch, no allocation.
  - For each source in that order, waterfill `avail` across its consumers that still want energy.
    - `avail` is `genLeft` for a generator, or `min(held, gLeft)` for a relay.
    - A run link is also capped by `runLeft[via]`. Within one source's waterfill, each run's budget is shared.
  - **Integer waterfill:**
    - Sort wants ascending, ties by index.
    - For each want, give `g = min(want, floor(left/k))`, where k is the number of wants not yet served.
    - Subtract g from `left` and decrement k.
- **Local priority falls out of this.** A thruster is served first only against sources it shares. There is no
  reservation along chains.
- **Carry over in P2: proportional sharing (Kieran, 2026-11-04).** The live pool and banks (energy.ts `powerTick`) now
  share a short supply by what each asks: every asker gets supply × its want / all wanted, so a thruster asking 10 and
  guns asking 20 get 1/3 and 2/3, and a store that isn't full asks for its intake (Takes) alongside the consumers (a
  Capacitor taking 30 for the thrusters it feeds gets 3/5 against the guns' 20: a store's intake is how a system raises
  its share). The waterfill above (smallest want first) fills small wants in full before large ones, and `tick.ts`
  was left as it is. P2 should switch each source's split to proportional (integer: `floor(left × want / Σwant)`, the
  remainder by part index, so it stays deterministic), with relays' intake counted as wants. docs/areas/energy.md and
  docs/audits/energy-audit-2026-11-04.md ("Proportional sharing") have the rule as built.

### 1.4 Weapons (buffer, latch, beams)

Per weapon, from `WeaponInfo.fire`:
- `shot` E per shot.
- `intake` E/s.
- `buffer` (in shots).
- `cap = shot·buffer` in eu.
- For a beam: `burn`, `intake`, `bufferE`, `relight` (default 0.5).

| Model | Want this tick (step 3) | Ready to fire (stepGuns) | On fire |
|---|---|---|---|
| cycle / auto / ammo | `min(intake, cap − held)` | `cooldown ≤ 0 && held ≥ shot` (ammo: plus today's spendAmmo, dry-fire unchanged) | `held −= shot`; cooldown += interval (mechanical, always −1 a tick) |
| cycle + `buffer > 1` (Chainsaw, Spear) | same (a reservoir that tops up continuously) | same | same |
| **clip** | **0 unless LATCH**; while latched, `min(intake, cap − held)` | `!LATCH && cooldown ≤ 0 && held ≥ shot·rounds` (semi: plus the click) | `held −= shot·rounds`; if `held < shot·rounds`, **set LATCH** |
| clip, latch clears | when `held ≥ cap`: clear LATCH (in step 3, after adding) | | |
| clip idle | partial clip and no shot for CLIP_IDLE = 60 ticks: set LATCH (today's reload-on-idle, now refills the **whole** clip) | | |
| charge (Longbarrel, Blackout) | `min(intake, cap − held)` (cap = 1 shot) | the charge timer advances only while held and aimed **and `held ≥ shot`**; fires at `charge` | `held −= shot`; cooldown = f.cooldown. Letting go keeps the energy (nothing was spent) |
| beam | `min(intake, cap − held)` where `cap = bufferE` | LIT is set when held and `held ≥ relight·bufferE`; while LIT and `held ≥ burn/tick`, it burns | `held −= burn/tick`; when `held < burn/tick`, clear LIT (rest) |

- **The whole-clip rule (owner).** Once a clip starts reloading, it is LATCHED. It takes in energy only while latched
  and cannot fire until the whole clip is paid. A clip that isn't latched takes nothing, so it is a true magazine of
  exactly `clip` shots.
- **Hive.** The `regrow` path is deleted, and the Hive becomes a latched clip (see Q5).
- **No weaker or slower shots.**
  - `share()`, `burns()`, BROWNOUT and `feedShare` are deleted.
  - Cooldown, clip reload and charge no longer scale with energy.
  - The only energy gate is `held`.
- **Clip rounds** are derived as `floor(held/shot)`. The `rounds` and `reload` writes for clips are gone.
- **Beam windup** stays in `charge[p]`. The Cutter ramp resets during a rest, which is accepted.
- **Legacy guns** (enemies and bosses, `fireOf`) get `shot = draw·interval/60`, `intake = draw`, `buffer = 1` at
  rebuild. They behave exactly as today at full supply, with no special case in stepGuns.
- **Rate mods** (conductive material, rate mod) shorten `interval`. `intake` is scaled by `interval₀/interval` so that
  at full supply the gun is never energy-bound, and `shot` stays fixed.
- **averageInterval** (ratings, cards):
  - Shot models: `max(interval, shot·60/intake)`.
  - Clip: `(rounds-per-clip·interval + cap·60/intake)/rounds-per-clip`.

### 1.5 Thrusters and the Burst Strafer
- Thrust becomes per thruster: `Σ max(0, f_i·dir) · fade_i · frac_i · mul_i`, floored by `maneuverForce`.
  - The core's floor is free and unbuffered.
  - Turning stays free.
  - `d.boostFactor` is kept for the planners only (autopilot, ratings).
  - `canBoost` and the ship-wide `power` scalar go.
- **Burst Strafer = a dodge thruster:** kick 14, burn 700, intake 40, buffer 140 (exactly one 12-tick burst).
  - `cooldown` is deleted. `dodgeCooldown` returns `ticks`.
  - `DODGE_MIN_SHARE` and `refuseDodge` are deleted, so a dry dodge pushes at intake/burn, about 6%.
  - The push is `Σ_i max(0, push_i·u) · frac_i`.
  - A press during a burst is ignored. The client latch waits only for the burst.
- **Spawn and respawn:** all relays and buffers start full.
  - A rebuild with the same blueprint keeps `held` per part, clamped to the new cap.
  - A destroyed part goes to 0, and a repaired part starts empty.
  - A refit (a new blueprint) starts full.

### 1.6 Who runs the tick

| Path | Today | New |
|---|---|---|
| Server pilot (bridge/flight.ts:198) | powerTick | `energyTick` via stepShipPhysics, the same call site |
| Pilot prediction (ShipClient.ts:1052) | powerTick | identical |
| Pilotless / NPC (pilotless.ts:89, :97) | flight drainRate 0, plus a guns-only powerTick | **full energyTick, thrust included** (NPC thrust becomes energy-limited) |
| Replicas and the server shadow (replica.ts:126/133, SimLod.ts:142) | FULL_CHARGE | `stepThrustersFree`: thruster buffers refill at full intake and burn as above. No relays, no guns (P3) |
| Sleeping catch-up (bridge/flight.ts:136) | up to 3,600 idle powerTicks | `settleEnergy(L, e, ticks)`: up to 600 idle ticks, then snap to full if `ticks ≥ L.fillBound` (a precomputed upper bound on the time to refill) |
| Hangar | loadTest | `energyView` (§7), using the same tick |

---

## 2. Data model

### 2.1 Replaces
- These go entirely:
  - `PowerLayout`, `Bank`, `CircuitInput`, `powerLayout`, `bankKind`, `CIRCUIT_DEFAULTS` (circuits.ts);
  - `Charge {g,b,eng,gun}`, `FULL_CHARGE`, `PowerUse`, `PowerResult`, `powerTick`, `serve`;
  - `gunDraw*` and `gunLoad*`, `feedShare`, `thrustShare`, `BROWNOUT`;
  - `poolHeld`, `bankHeld`, `bankCharges`, the `packCharge`/`unpackCharge` group form;
  - `CHARGE_GROUPS_LAYOUT`, `MAX_CHARGE_GROUPS`;
  - rebuild step 4 (`allocateFlow`, `nearBank`, `burst`/`engineLike`/`gunLike`).
- `partCapacity`/`partDischarge` move into `power/layout.ts`, with a new `partIntake`.

### 2.2 `EnergyLayout` (on `ShipDerived.energy`, rebuilt per rebuild, never sent)
```ts
interface EnergyLayout {
  n: number;                       // blueprint part count (arrays below are by part index)
  sig: number;                     // u16 hash of the graph + caps (pilot-row guard, flightKey)
  role: Uint8Array;                // 0 inert 1 gen 2 relay 3 thruster 4 tool 5 weapon 6 dynamo
  cap: Int32Array;                 // eu: relay hold / weapon cap / thruster buffer
  rate: Int32Array;                // eu/tick: gen produce | consumer intake
  give: Int32Array; take: Int32Array;           // eu/tick, relays
  burn: Int32Array; bBurn: Int32Array;          // eu/tick, thrusters (bBurn = burn when no boost)
  boostMul: Float64Array;                        // bThrust/thrust per thruster
  phase: Int32Array;               // [start,end) of thruster/tool/weapon consumer lists in cons
  cons: Int32Array;                // consumer part indices by phase
  srcStart: Int32Array; srcPart: Int32Array; srcVia: Int32Array;     // per phase: sources (gens first) and, per source, consumers (CSR)
  feedStart: Int32Array; feedCons: Int32Array; feedVia: Int32Array;
  pushStart: Int32Array; pushRelay: Int32Array; pushVia: Int32Array; // per generator
  pairA: Int32Array; pairB: Int32Array; pairVia: Int32Array; pairOneWay: Uint8Array;
  dynStart: Int32Array; dynRelay: Int32Array; dynRate: Int32Array;
  runRate: Int32Array; runs: number; segRun: Int32Array;            // per run; per wire segment (drawing)
  diodeOut: Int32Array;            // per part: the out-side neighbour, or -1
  linked: Uint8Array;              // consumer reaches a generator (hangar warnings)
  gaugeMax: number; fillBound: number;
  links: number;                   // total link count, for the trace (each CSR entry has a link id)
}
```
- `ShipDerived` loses `power`, `network`, `networks`, `wireNet` and `satisfaction`, and the old `energy: EnergyInfo`.
- It keeps `wires` and `wireLive` for drawing.
- It gains:
  - `energy: EnergyLayout`;
  - `powered: Uint8Array`, the static "has a source" flag that shieldMax, scanner range, coils, launchers and miners
    read;
  - `energyInfo {gaugeMax, gen, sustain}` for the summaries.

### 2.3 `EnergyState` (replaces `Charge`; held where `Charge` is now: bridge `chargeOf`, client `GameState.charge`)
```ts
interface EnergyState { sig: number; held: Int32Array; flags: Uint8Array; sat: Uint8Array; shieldSat: number; gauge: number }
// flags: 1 LATCH (clip reloading / beam resting), 2 LIT (beam on)
```
- `held`, `flags` and `sat` are sized `n` and allocated at `createEnergyState(L)`, **not per tick**.
- `fullEnergy(L, out?)` replaces `FULL_CHARGE`.
- `frac` and `mul` per part are **module scratch** in `power/tick.ts`, returned by reference and read immediately by
  flight. They are not re-entrant, as flight.ts CTX isn't.
- The trace (hangar only) is an optional `Float64Array(L.links)` that the tick adds flow into. It costs one null check
  per link when absent.
- Serve and sort scratch: module `Int32Array`s that grow to the largest layout seen (the energy.ts:283 pattern).
- **Allocation-free.** Nothing is allocated per tick. stepGuns' existing per-tick arrays are not touched and nothing is
  added to them.

### 2.4 Function and fire fields (types.ts)

| Where | Field | Meaning |
|---|---|---|
| FunctionDef | `store`, `discharge` (kept), **`intake`** | relay Holds, Gives and **Takes** per cell, scaled by `fnOutput` |
| FunctionDef | **`intake`, `buffer`** | thruster refill and buffer per cell, scaled like `demand` (Burn = `demand`, unchanged) |
| FunctionDef | **`oneWay`** | Diode |
| FunctionDef | `pool`, `bank` | **deleted** (stores are all alike now) |
| FireSpec | **`shot`, `intake`, `buffer`, `burn`, `bufferE`, `relight`** | per whole part |
| FireSpec | `reloadE`, `chargeE`, `regrow`, `reload` | **deleted** (refill time is `cap/intake`) |
| ThrusterInfo | **`burn`, `bBurn`, `intake`, `buffer`, `boostMul`** | eu-converted copies live in the layout |
| strafe | `cooldown` | **deleted** |

---

## 3. Module plan

### 3.1 New: `common/src/ships/power/` (pure, deterministic, single source for server, client and hangar)

| File | Exports |
|---|---|
| `units.ts` | `EU = 256`, `perTick`, `toEu`, `fromEu` |
| `layout.ts` | `buildEnergyLayout(input) → EnergyLayout`, `partCapacity`/`partDischarge`/`partIntake`, `layoutSig` |
| `runs.ts` | `wireRuns(segments, cellParts, alive, isDiode) → {segRun, runs, partRuns CSR}` |
| `tick.ts` | `energyTick`, `stepThrustersFree`, `settleEnergy`, `thrustFrac` (scratch accessors) |
| `state.ts` | `EnergyState`, `createEnergyState`, `fullEnergy`, `remapEnergy`, `energyGauge` |
| `wire.ts` | `ENERGY_SLOT_LAYOUT`, `packEnergy`, `unpackEnergyInto`, `energySlotEnd`, `packThrusterTail`/`unpackThrusterTail` |
| `view.ts` (P5) | `energyView(d, tuning, opts) → EnergyView` (a steady-state run with trace, statuses, bottlenecks and sustained rates) |
| `facts.ts` (P5) | `energyFacts(fn, area, mat, tuning) → Fact[]` (Holds/Gives/Takes, Shot/Intake/Buffer, Burn/Intake/Buffer, the dry %, the diode direction) |
| `index.ts` | re-exports |

### 3.2 Changed

| File | Change |
|---|---|
| `common/src/ships/wires.ts` | Add `autoWireForest` (all generators seeded). `wiresOf` uses it from P2. `isPowerPart` counts relays, thrusters, tools and weapons, and excludes diodes. `wireNetworks` and `netJoins` are **deleted** in P2 (replaced by `wireRuns`). The spool maths is unchanged |
| `common/src/ships/rebuild.ts` | Step 3/4 is replaced by one `buildEnergyLayout` call. `powered[]` replaces `satisfaction`. Thrust is no longer multiplied by satisfaction (:437). The weapon interval no longer divides by satisfaction (:471). `fireOf` defaults shot/intake/buffer. ThrusterInfo gets its new fields. The shield, scanner and coil stats use `powered` |
| `common/src/ships/energy.ts` | Shrinks to `PILOT_ROW` (with `pool` → `sig`, `groups` → `energyCount`), `MINE_*`, `energyTuning`, `payMining` (pays from `sat`) and a re-export of `power/`. Everything else in §2.1 is deleted |
| `common/src/ships/circuits.ts` | **Deleted** |
| `common/src/ships/flight.ts` | :494-520: calls `energyTick` (when `c.accounted`), otherwise `stepThrustersFree` for replica mode. Adds `thrustAlongPowered` (per-thruster frac and mul). `thrustAlong`/`accelAlong` keep their signatures for planners |
| `common/src/ships/features/types.ts` | `PartFeature.burst` and `load` are **removed**. Adds `want?(ship, d, out: Int32Array)` (tools phase, eu per part). FlightCtx: `load`/`loads`/`shares` → `active: Uint8Array` (thruster parts active) and `frac`/`mul` (read-only scratch) |
| `common/src/ships/features/plan.ts` | `burstMask`/`engineMask` → `wantMask` |
| `common/src/ships/features/strafer/{strafer,index}.ts` | Dodge thruster (§1.5). `dodgeLoad` → sets `c.active`. `dodgePush` uses frac. `burstEnergy`/`dodgeAffordable` read the strafers' `held`. Hint text changes |
| `common/src/ships/features/tow/index.ts` | `load` → `want` |
| `common/src/ships/features/contract.ts` | The energy section asserts layout roles and a finite `want`. The drainRate-0 parity check stays |
| `common/src/ships/guns.ts` | §1.4. Deletes `stepClip` regrow, `share`, `burns` and the clip parts of the gun-state slot (charge ticks stay). `averageInterval` and `clipReloading` (= LATCH) |
| `common/src/ships/state.ts` | Clip `rounds`/`reload` resets go. A respawn/restore calls `fullEnergy` |
| `common/src/ships/replica.ts`, `network/replication.ts` (P3) | Replica thruster buffers. Keyframe tail |
| `common/src/ships/blueprint.ts` (P4) | `partFacingRule(fn): 'free' \| 'joined' \| null`. Validation error `facingNotJoined` |
| `common/src/network/wireHash.ts` | Hash `ENERGY_SLOT_LAYOUT`, the new `PILOT_ROW`, `GUN_STATE_LAYOUT`, `STRAFER_LAYOUT = 'burst-no-cooldown'` and (P3) a keyframe-tail sample |
| `server/src/ships/bridge/{flight,weapons,pilotless,rebuild,sync}.ts` | `EnergyState` in place of `Charge`. Pilotless runs the full tick. `wake` → `settleEnergy`. Rebuild → `remapEnergy` |
| `server/src/ships/bridge/flight.ts:269` | Shield regen × `e.shieldSat/255` |
| `server/src/ships/features/flash/Flash.ts` | Pays from the touching relays' `held` (fullest first, `L.srcPart` of the Flash part). It is a server-only write that the pilot gets corrected on the next row (accepted) |
| `server/src/net/SnapshotBuilder.ts` | Calls `packEnergy` in place of the groups. No other logic |
| `client/src/state/GameState.ts` | Reconcile: `unpackEnergyInto`, then replay physics while re-applying logged weapon spends (§4.3) |
| `client/src/ships/ShipClient.ts` | Same tick inputs. `predictGuns` records spends into `SpendLog` |
| `client/src/ships/gunSync.ts` | Charge-model guns only. Clip state is now exact in the energy slot |
| `client/src/ships/features/strafer/*`, `DodgeIndicator.ts` | The phase gate waits only for the burst. The chip shows the strafer `held`/`cap` |
| `client/src/ui/BankBars.ts` | Rewritten as store bars: the 4 largest relays by hold, fill = held/cap, flashing when a consumer they feed has `sat < 255` or is under-fed |
| `client/src/Game.ts:1515` | Gauge = `e.gauge/L.gaugeMax` |
| `client/src/ships/{gunHud,ChargeFx,WeaponRing,ShipRenderer,PartFx,shipSummary,partTip,modelCards}.ts` | Read `held`/`flags`/the layout. The ring shows buffer fill, plus a "locked" pip state while LATCHED |
| `client/src/ships/HangarUI.ts` | P2: `powerHtml` → `energyPanelHtml(view)`. P5: the `Overlay` union → registry. `drawPower`/`drawBanks`/`boltGlyph` move out. P4: `pickFacing`/`placementProblem` ask `partFacingRule` |
| `client/src/ships/wireEdit.ts` | `powerReport` → a thin adapter over `energyView` (keeps `whereOnShip` warnings and the run colours) |
| `scripts/econ/models.mjs`, `data/ships/tuning.json`, `server/src/data/validateGameData.ts` | §5 |

### 3.3 New client files (P5)
- `client/src/ships/overlays/registry.ts`: `{id, label, default, draw(ctx, view, t)}[]`. The connectors, joins, com,
  thrust and arcs overlays are moved in as entries. **energy** is a new entry.
- `client/src/ships/energyOverlay.ts`: the draw functions.
- `client/src/ships/energyPanel.ts`: the POWER panel HTML.

### 3.4 Diode and Conduit (no feature folder)
- Both are **plain FunctionDef data** (`store`, `discharge`, `intake`, and for the Diode `oneWay`), read generically by
  `buildEnergyLayout`.
- They have no per-tick hook, so the registry isn't involved, and no code names their ids.
- `partFacingRule(fn)` returns `'joined'` when `fn.oneWay`, `'free'` when `partNeedsFacing`, otherwise null.
  `blueprint.ts` validation, `migrate.fitModels` and HangarUI placement all ask this one function.
- Overlay arrows come from `L.diodeOut`.

---

## 4. Wire format

### 4.1 Pilot row (own ship)

| Slot | Was | Now |
|---|---|---|
| data[1] | gauge % | gauge % = `round(10000·gauge/gaugeMax)/100` (also Boost.fuel and the state hash) |
| data[8] `PILOT_ROW.pool` | pool % | renamed `sig`: `L.sig` (u16). The client ignores the energy slot if its layout sig differs (rebuild race) and waits for the next row |
| data[9] `groups` | group count | renamed `energyCount`: the number of pairs n |
| data[13 …] | n group values | n pairs `(part, value)`: **sparse**. A part is omitted when `held = cap` and `flags = 0`, and is then taken as full |
| value | | `held·4 + flags` (integer, exact) |
| then | pilotExtras, gun state | unchanged order, found by `energySlotEnd(data)` |

- The gun-state slot is narrowed to charge-model guns (charge ticks). `GUN_STATE_MAX` stays 8. Clip state is gone from
  it and is exact in the energy slot.
- **Size:** worst case per pair is a 1-2 B index + a 3-4 B varint, about 6 B.

| Ship | Buffered parts (relays + weapons + thrusters) | Worst-case slot | Typical (most full) |
|---|---|---|---|
| Bastion / Dreadnought | 3 + 22 + 13 = 38 | ~230 B | <60 B |
| Hammerhead | 33 | ~200 B | <60 B |
| Sparrow-T | 5 | ~30 B | ~10 B |
| maxParts 255 | ≤255 | ~1.5 KB (pathological, not capped: the encoding is exact) | |

The row is sent on correction or every 120 ticks, as today, which is negligible next to the ~1.3 KB/s fight budget.
Check it with `npm run bench:net`.

### 4.1b Bandwidth rules (from docs/audits/network-firing-2026-11-01.md; binding)
- The energy slot is **not** part of the own-row resend key (SnapshotBuilder.ts:539). It rides only a correction row,
  the 120-tick keyframe, or a rebuild/EMP/part-loss event. Putting it in the key would resend ~150 B × 20 Hz ≈ 3 KB/s,
  doubling the cost of a fight.
- Add a 16-bit energy digest (over `held`/`flags` in part order) to the existing once-a-second `stateHash`. A mismatch
  triggers `forceSnapshot`, which carries the slot. In step, energy costs ~0 B/s; expect 10–20 B/s overall.
- The client adopts a correction patiently (as gunSync does), not by snapping mid-burst.
- Nothing per part goes into other players' status rows. Replicas get only the P3 thruster tail, and only on keyframes.
- `npm run bench:net` must show no rise in idle or firing bytes from P2 (a test pins it, alongside the frameHash goldens).

### 4.2 Keyframe tail (P3, replicas)
- After `dodgeDir`: an optional `count`, then `(thrusterOrdinal, held)` pairs, for thrusters not at their cap.
- The server shadow carries the same `Int32Array`.
- Replicas run `stepThrustersFree` (intake assumed met). A real shortfall (a shared generator) diverges and keyframes,
  as today.
- No relay, weapon or tool state ever goes to replicas.

### 4.3 Reconcile and replay
1. Snap `held`/`flags` from the row.
2. Replay pending inputs through stepShipPhysics. This is physics only, as today, and it runs the full `energyTick`.
3. At each replayed tick, re-apply the weapon spends that `predictGuns` logged for it.
   - The log is `SpendLog`: a fixed 128-tick ring of `(tick, part, eu, flagsAfter)`, with no allocation, owned by
     ShipClient.
4. With that, store levels and thrust replay exactly unless the server disagreed about a shot. Any disagreement is
   corrected by the next row.

### 4.4 Bump steps
- **P2:**
  1. Change `PILOT_ROW`, add `ENERGY_SLOT_LAYOUT = 'part-sparse-eu256-flags2'`, and change the `GUN_STATE_LAYOUT`
     string and `STRAFER_LAYOUT`.
  2. `npm run wire:bump "energy routing: per-part energy slot"` (20 → 21).
  3. Update `docs/areas/networking.md`, which is stale at 19.
- **P3:** keyframe-tail sample → `wire:bump` (→ 22).
- **P4:** append `power_conduit` and `power_diode` to `wire-dictionary.json`, then `npm run wire:sync` and `wire:bump`
  (→ 23).
- Each bump re-pins `protocol.test.ts`.

---

## 5. Numbers (all in `scripts/econ/models.mjs` + `data/ships/tuning.json`; run `npm run models`, never hand-edit models.json)

### 5.1 Weapons

**Rule: the game's mechanical beats and damage stay.** Intake is the proposal's "E/s proposed" (2.1). Shot is derived so
that the full-supply cadence is exactly today's:

| Fire model | shot | buffer |
|---|---|---|
| cycle / auto / ammo | `intake·interval/60` | 1 (Spear 2) |
| spin (Chainsaw) | `intake·spin.to/60` | 10 |
| clip | `intake·reload/(60·clip)` (whole clip refills in today's `reload` ticks) | `clip` |
| Hive | `intake·(regrow·clip)/(60·clip)` | 8 (latched) |
| charge | `intake·(charge+cooldown)/60` | 1 |
| beam | prototype burn / intake / bufferE, relight 0.5 | — |

- In models.mjs, add an `ENERGY` table keyed by weapon id with `{intake, buffer?}` or
  `{beam: {burn, intake, bufferE}}`.
- The loop at :470-487 derives the `fire.shot`/`buffer` columns above and sets `demand = r2(intake/area)` for the
  readers that still show E/s.
- `RAIL_E`, `BEAM_E`, `reloadE`, `chargeE` and `regrow` are deleted.
- Shot values in the table below are **derived**; "f" means models.mjs computes it from the `fireInterval` in
  functions.json.

| Weapon id | Intake | Buffer | Shot (E) | Note |
|---|---|---|---|---|
| cannon_pip | 20 | 1 | f | |
| autocannon_rattler | 28 | 1 | f | |
| flak_burst | 10 | 1 | f | H: canisters as today |
| cannon_hammer | 30 | 1 | f | |
| mortar_lobber | 6 | 1 | f | A |
| laser_glint | 35 | 1 | f | |
| pulse_strobe | 50 | 1 | f | |
| legendary_prism | 60 | 1 | 96 | interval 96 |
| point_defence_turret | 25 | 1 | f | auto |
| missile_dart | 8 | 1 | 14.4 | |
| cannon_twinlink | 55 | 16 (clip) | 5.16 | clip 82.5 E, refill 1.5 s |
| legendary_hive | 60 | 8 (latched) | 45 | clip 360 E, 6 s (Q5) |
| legendary_frostbite | beam 90 / 90 / 270 | | | |
| railgun_needle | 30 | 1 | f | H |
| autocannon_chainsaw | 80 | 10 | 5 | reservoir |
| emp_hush | 40 | 1 | 108 | |
| flak_cloudmaker | 35 | 4 (clip) | 21.9 | |
| arc_spark | 70 | 1 | 52.5 | |
| laser_cutter | beam 90 / 40 / 180 | | | runs 3.6 s, rests |
| torpedo_eel | 10 | 1 | f | A |
| cannon_longbarrel | 110 | 1 | 385 | charge 120 + cd 90 |
| missile_swarm | 12 | 1 | 9 | |
| railgun_coilgun | 70 | 1 | 63 | |
| legendary_cinder_bloom | 130 | 1 | 156 | |
| autocannon_stinger | 120 | 12 (clip) | 12 | |
| mortar_quake | 12 | 1 | 36 | |
| pulse_overpulse | 130 | 12 (clip) | 16.25 | |
| laser_searchlight | beam 140 / 140 / 280 | | | |
| legendary_phase | 140 | 1 | 308 | |
| railgun_spear | 90 | 2 | 171 | reservoir of two |
| arc_tesla | beam 170 / 170 / 300 | | | |
| railgun_rail_driver | 80 | 6 (clip, semi) | 20 | |
| cannon_bastion | 220 | 2 (clip) | 330 | clip 660 E |
| legendary_singularity | 240 | 1 | 1680 | large: balance check in P7 |
| lance_lance | beam 300 / 300 / 600 | | | windup 18 stays |
| missile_hammerhead | 12 | 1 | f | |
| emp_blackout | 120 | 1 | 660 | charge 90 + cd 240 |
| torpedo_leviathan | 15 | 1 | 45 | |
| utility_repair_beam | beam: burn = intake = today's demand × area, bufferE = 2 s of burn | | | |
| utility_demolition_launcher | today's demand × area | 1 | f | |

### 5.2 Stores, conduit, diode (per cell; `OTHER` + a new `LATE_POWER` block appended after `LATE_OTHER`)

| Model | store (Holds) | discharge (Gives) | intake (Takes) | Other |
|---|---|---|---|---|
| Core (tuning.energy) | coreCapacity 240 | coreDischarge 720 | **coreIntake 120** | |
| power_battery | **300** | **150** | **50** | |
| power_heavy_bank (block2) | 300 | **100** | **150** | |
| power_capacitor | **120** | 2000 | **40** | drop `pool`, `bank` |
| power_drive_cell | 320 | 1400 | **80** | drop `pool`, `bank` |
| **power_conduit** (new, sq, lvl 0, copper_wire recipe) | 10 | 200 | 200 | mass 0.3 |
| **power_diode** (new, sq, lvl 5) | 10 | 200 | 200 | `oneWay: true, facing: true` |
| Pulse Dynamo | — | — | — | `dynamo 10` unchanged |

- tuning.json `energy`:
  - add `coreIntake 120`, `wireRate 200`, `relight 0.5`;
  - delete `discharge.{general, drive, bank}`. A legacy store without `discharge` gets `general` from a code default
    (600, battery-like) and Takes = its Gives/4;
  - rewrite the `_pool` and `_comment` text.
- Generators are unchanged.

### 5.3 Thrusters (per cell; the `E` table gains `intake, buffer` columns; Burn = `draw` and boost burn = `draw·(1+boostDraw·boostDrain)`, both unchanged)

| Engine | Burn | Intake | Buffer | Full boost lasts | Dry cruise |
|---|---|---|---|---|---|
| Ion Drive (sq) | 9 | 12 | 30 | ~1.8 s | (never dry at cruise) |
| Vernier (tri) | 4 | 4 | 8 | no boost | 100% |
| Afterburner (sq) | 8 | 10 | 60 | ~1.2 s (bBurn 60.8) | — |
| Torch (rect2) | 34 | **30** | **40** | no boost | 88% after ~10 s (electric-only, fuel out of scope) |
| Plasma Drive (rect2) | 20 | 25 | 60 | | |
| Drift Sail (round) | 3 | 3 | 6 | | |
| Fusion Torch (block2) | 28 | 32.5 | 100 | | |
| Burst Strafer (`TUG` row) | 700 (`demand`) | 40 | 140 | one 12-tick dodge | ~6% |

The strafer row becomes `strafe: {kick: 14, ticks: 12}, demand: 700, intake: 40, buffer: 140`.

---

## 6. Migration

| What | Action |
|---|---|
| Players' saved ships (profile hangar slots and designs) | **The format is unchanged and there is no data rewrite.** Hand wires become runs (conduits). Wire-less designs get `autoWireForest`. No PROFILE_VERSION step. The hangar shows a generic banner from `L.linked` ("3 parts get no power") on open. Spool billing is unchanged. The legacy `conduit` function still migrates to hull |
| Starters and player ships (13: sparrow-t, arrow, ark-tender, bulwark, corsair, drum, galleon, hammerhead, hauler, lancer, prospector, bastion, bastion-dreadnought) | Re-route by touch: generator → store → guns/engines, with Conduits or hand wires where a run is needed. Each must pass `routeCheck` (below) with every consumer linked, no gun at 0%, and the starter guns at 100% on their plant |
| Dev ships (7: annihilator, guest-sparrow-t, test-brownout, test-strafer, test-support, test-surge-striker, test-tow-hauler) | test-brownout is redesigned to show a bottleneck (a Battery Gives limit). test-strafer gets a Drive Cell touching its strafers. guest-sparrow-t gets a Diode-protected engine bank (showcase). The others re-route. The parity pilots (test-strafer, test-tow-hauler, test-surge-striker, sparrow-t) are done **in P2** so the goldens move once |
| Enemies and bosses (63) | **Superseded by D1** (no `autoWireForest`, no wires): every ship `routeCheck` flags (an unlinked weapon, sustained fire < 50% of the old rate) gets a hand edit: a store or Conduit beside its gun cluster, touching its plant. maw_heart_titan included. This lands **before** the P2 merge (see the P2 gate in §8) |
| Touch-only coverage today (P1 review, 2026-11-01) | Built touch-only, 53 of 83 bundled blueprints have at least one gun with no power path and 33 have none powered (bastion, bastion-dreadnought, bulwark, corsair, galleon, hammerhead, lancer, prospector, test-tow-hauler, annihilator and 23 enemies and bosses); 287 of 379 guns are unpowered; bastion-dreadnought has no power link at all. Switching P2 over first would leave them dead |
| `scripts/ships/routeCheck.mjs` (new, P6) | Loads the catalog and every blueprint through common/dist and runs `energyView` for 10 s (fire + thrust). It prints, per ship: unlinked consumers, each gun's sustained %, thruster dry %, and the bottleneck relay. A `--json` mode feeds a test pinning that no bundled ship has an unlinked weapon |

---

## 7. Hangar energy overlay and HUD

- **Simulation:** `energyView(d, tuning, {fire, thrust, boost, dodge, tools, seconds|live})`.
  - It builds an `EnergyState` and runs the **same `energyTick`** with a trace array and synthetic controls. Fire means
    every gun's trigger is held, with the fire models stepped through `stepGuns` energy-only.
  - It keeps EMA flows per link, the per-part level, and per-part status: full ≥ 97%, part ≥ 50%, starve, idle,
    unlinked. A relay is a bottleneck when it is at its Gives or Takes limit with EMA > 0.6 while something is short.
    Generator waste is shown only when something elsewhere is short.
  - It also returns the sustained fire rate per gun and thruster endurance ("full for X s, then Y%").
- **Live mode:** while the hangar is open **and** the energy overlay is on, the overlay steps the view each frame via a
  `HangarLitView.onFrame` hook. It does not run its own requestAnimationFrame. The hook is unsubscribed on close or
  toggle-off.
- **Overlay draws** (prototype `draw()`):
  - liquid level in every relay, weapon and thruster;
  - moving dots on each link (count and speed from the EMA);
  - wire runs coloured per run, with dead segments dashed red;
  - an amber pulse on bottleneck relays;
  - status outlines on consumers, and a "no power" bolt on unlinked parts;
  - Diode arrows;
  - toggles for Fire / Thrust / Boost / Dodge / Tools.
- **POWER panel** (`energyPanel.ts`):
  - per run or touch cluster, its sources and sinks;
  - generation, charge and waste;
  - a line per gun: "needs X E/s, gets Y%, a shot every N s";
  - thruster endurance;
  - warnings (`whereOnShip`).
- **Tooltips and cards:** `energyFacts` through `describePart`, so partTip, modelCards and the field guide share it.
  partTip's hand-written energy rows (:24-45, :168-229) are deleted.
- **HUD:** the gauge, the store bars (BankBars rewritten), and the gun ring's buffer fill plus LATCH "locked" pips.
  The DodgeIndicator shows the strafer buffer.
- **Panels:** capture before and after shots for the overlay, the HUD and the re-routed starters in
  `docs/panels/<date>/energy/` (the house rule).

---

## 8. Phases and work packages

Model column: **O** means Opus (hot path or parity); **S** means Sonnet (routine).

Commands:
- Test: `npx vitest run <paths>`.
- Goldens: `UPDATE_GOLDEN=1 npx vitest run server/src/golden common/src/ships/golden`.
- Snapshots: `npx vitest run -u <file>`.

Each phase ends green on `npm test` and `npm run typecheck`.

### P0: data and types (no behaviour change; additive)

| WP | Model | Files | Acceptance |
|---|---|---|---|
| P0.1 | S | models.mjs (ENERGY table, store and thruster columns, strafer `intake`/`buffer`; old fields kept), `npm run models` | models.json has `fire.shot`/`intake`/`buffer`, store `intake` and engine `intake`/`buffer`. models.test passes; regenerate its snapshot only if pinned |
| P0.2 | S | types.ts (optional new fields with doc comments), validateGameData.ts (schema), tuning.json (`coreIntake`, `wireRate`, `relight`) | validateGameData.test passes |

### P1: the common power core (pure; nothing calls it yet)

| WP | Model | Files | Acceptance |
|---|---|---|---|
| P1.1 | O | `power/units.ts`, `layout.ts`, `runs.ts`, `state.ts`; wires.ts `autoWireForest` (new function, `wiresOf` unchanged) | layout.test: touch-only edges (no diagonals), bespoke joins, a run as a hyper-edge with a budget, touch beating a run, the diode's one-way pairs and its out-side source, the diode never on a run, CSR order and determinism (built twice, equal) |
| P1.2 | O | `power/tick.ts` | tick.test ports the prototype scenarios: Generator > Battery > Pip (Takes and Gives limits); a gun on an engine's store starving it (local priority); a diode guarding an engine bank; the Ion boost giving ~1.8 s then the better of cruise and boost; strafer one dodge then 6% then a 3.5 s refill; the clip LATCH whole refill; a beam burst/rest at relight; the charge gate; dynamos. Two runs of 10k ticks are bit-identical. A microbench shows no heap growth over 100k ticks (`--expose-gc` check in the bench, not CI) |
| P1.3 | O | `power/wire.ts` | pack/unpack round-trip is exact, sparse omits full parts, and a sig mismatch is ignored |

### P2: switch-over (one commit gate; WPs in parallel against the P1 API, merged then goldens)

**Merge gate (D1, P1 review):** P2 does not merge until every bundled ship is routed by touch: P4 (Conduit, Diode) and
P6 (`routeCheck`, `bundledRouting.test.ts`, the re-routes) land first, and P2 must pass `bundledRouting` (no bundled ship
has an unpowered weapon). P2.1 also: drops the `/ satisfaction` term from the interval it passes as
`EnergyWeaponInput.interval` (a starved gun must not shrink its own intake), passes `geoms` (or no Diode gives), lands
the §5.2 store numbers and drops `pool`/`bank`. P2.4 pays Flash with `drawFromRelays(L, e, part, eu, true)`; P2.5 folds
`energyDigest(L, e)` into stateHash.

| WP | Model | Files | Acceptance |
|---|---|---|---|
| P2.1 | O | rebuild.ts, `wiresOf` → forest, delete circuits.ts and `wireNetworks`, energy.ts shrink, features/plan.ts, features/types.ts | rebuild tests. `powered` for shields and scanners. Legacy guns get their default buffers |
| P2.2 | O | flight.ts, physics.ts, strafer feature (common), tow `want` | strafer.test, feature.test and contract tests rewritten. flightTraces regenerated |
| P2.3 | O | guns.ts, state.ts, rating.ts, partStats.ts | fireModels, cannons and railguns tests rewritten to the buffer rules: no-scale cooldown, LATCH, beam rest, charge gate, semi, stagger unchanged at full supply |
| P2.4 | O | server bridge (flight, weapons, pilotless, rebuild, sync), Flash.ts, flight.ts:269 shield regen | ships.engine, devTestShips, structure and tickOrder tests. `shipBridgeApi.json` is regenerated if the `chargeOf` type text changes |
| P2.5 | O | wire.ts slot in SnapshotBuilder, GameState reconcile, ShipClient + SpendLog, gunSync narrowing, wireHash, `wire:bump` | replication.test (the pilot's guns fire on the same ticks as the server), gunSync.test, protocol.test. A parity scenario with a gun and an engine sharing a Battery shows zero pilot corrections over 600 ticks |
| P2.6 | S | BankBars, Game.ts gauge, gunHud, ChargeFx, WeaponRing, ShipRenderer, PartFx, shipSummary, partTip (minimal), HangarUI `powerHtml` (minimal: stub view), DodgeIndicator, client strafer | client tests compile and pass. gunHud.test and bankTips.test are rewritten |
| P2.7 | S | the 4 parity pilot blueprints re-routed (§6). Rewrite circuits.test → `power/*.test`, ships.test energy parts, load.test | **Regenerate:** `UPDATE_GOLDEN=1` for parity.golden.json, frameHash.golden.json, flightTraces.golden.json; `-u` for model and circuit snapshots. Review the diffs: keyframe spam on boost is expected until P3 |

### P3: replica thruster buffers

| WP | Model | Files | Acceptance |
|---|---|---|---|
| P3.1 | O | replica.ts (`stepThrustersFree`), replication.ts keyframe tail, Replication.ts shadow, flightSignature (fold in `L.sig`), wireHash, `wire:bump` | The parity goldens drive-bank-boost and strafer-energy-short no longer keyframe every other tick (regenerate). The replication bit-exact test passes |

### P4: Conduit and Diode parts

| WP | Model | Files | Acceptance |
|---|---|---|---|
| P4.1 | S | models.mjs `LATE_POWER` block + recipes, wire-dictionary append, `wire:sync`, `wire:bump`, models regenerated | wireDictionary and protocol tests |
| P4.2 | S | blueprint.ts `partFacingRule` + validation, migrate `fitModels`, HangarUI `pickFacing`/`placementProblem` (one call each), mounting tests | A diode without a joined out edge is rejected server-side. T cycles only joined sides |

### P5: hangar overlay, panel, facts

| WP | Model | Files | Acceptance |
|---|---|---|---|
| P5.1 | S | `power/view.ts`, `power/facts.ts`, describe.ts (one call) | view.test: statuses, bottleneck, sustained rate on the prototype scenarios |
| P5.2 | S | overlays/registry.ts, energyOverlay.ts, energyPanel.ts, HangarUI (registry call; delete drawPower/drawBanks/boltGlyph/`Overlay` union), HangarLitView `onFrame`, wireEdit adapter | wireEdit.test and the overlay draw test with a stub ctx. No rAF left after close (a test with fake timers). HangarUI shrinks by about 150 lines |
| P5.3 | S | partTip → facts, modelCards, fieldGuide prose (touch routing, runs, diodes, buffers, whole clip, strafer) | modelCards, partPresentation, fieldGuide and componentGuide tests (`-u` where they snapshot) |

### P6: bundled routing

| WP | Model | Files | Acceptance |
|---|---|---|---|
| P6.1 | S | `scripts/ships/routeCheck.mjs` + `bundledRouting.test.ts` | Pins: no unlinked weapon on any bundled ship |
| P6.2 | S | the 12 remaining player ships (sparrow-t is done in P2), the 4 remaining dev ships (annihilator, guest-sparrow-t, test-brownout, test-support) | routeCheck passes. Panels captured |
| P6.3 | S | flagged enemies and bosses (batches by family) | routeCheck passes. Goldens regenerate only if a golden scenario uses one |

### P7: balance pin and docs

| WP | Model | Files | Acceptance |
|---|---|---|---|
| P7.1 | S | docs/audits/weapons-balance-calc.ts on `energyView` and pinned as a test. Singularity, Longbarrel and Blackout checked | calc test |
| P7.2 | S | docs/areas/energy.md, weapons.md, flight.md, networking.md, features/README.md; the energy-economy proposal marked built | — |

Parallelism:
- P0 runs alongside P1.
- The P2 WPs run in parallel (disjoint files, shared P1 API). P2.7 goes last.
- P4 and P6 run before the P2 merge (its gate above): P4 alongside P2's WPs, P6 after P4, since it uses Conduits and
  Diodes and `routeCheck` runs on the P1 core (it needs nothing from P2).
- P3 and P5 run in parallel after P2.

---

## 9. Risks
1. **Prediction parity (P2.5).**
   - Weapon intake shares stores with thrusters, so replays must re-apply logged spends, or store levels and thrust
     drift.
   - Flash's server-only write and unpredicted server shots cost a correction. Watch the self-row rate in
     `bench:net`.
2. **NPC difficulty and CPU.**
   - Enemies become energy-limited (thrust and guns). Auto runs at 200 E/s may starve big enemies until P6.
   - Cost per ship is O(links) per tick. This needs a bench on a crowded sector before P2 merges.
3. **Golden churn.** parity, frameHash and flightTraces all move in P2 and again in P3. Review the diffs by scenario,
   not by hash.
4. **Balance shift.**
   - Intake bands bite hard: Singularity is 1,680 E a shot, and Bastion's clip is 660 E.
   - Enemy and bundled ships tuned against the pool lose sustained fire.
   - routeCheck and the balance calculator are the guard.
5. **Thrust semantics.** Burn is charged in full whenever a thruster pushes at all (today's rule). With small buffers,
   off-axis engines drain fast. This is accepted for now and can be tuned via buffer numbers.
6. **Hangar CPU.** The live overlay steps the tick at 60 Hz, which is cheap. `energyView` caching per derived
   (`bothTest`) must follow `designSig`.
7. **Hand-wired player designs** change meaning (rate caps). The banner and overlay make it visible; nothing is
   rewritten.

## 10. Owner questions (only these block numbers, not structure)

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | Wire run throughput: one budget per run at `wireRate` 200 E/s (the same as a Conduit)? Should a hand wire cost spools while the auto runs stay free? | 200 E/s per run; spools as today |
| Q2 | NPCs and enemies energy-limited, thrust included (the full tick server-side)? | Yes |
| Q3 | Clip guns: a true magazine (no top-up while firing; a partial clip idle 60 ticks then reloads whole)? | Yes |
| Q4 | Keep the game's beats and damage and derive Shot from Intake (§5.1), instead of the prototype's cycle and shot values? | Yes (the prototype cycles differ for 6 clip/spin guns) |
| Q5 | Rustjaw's Hive: does the whole-clip rule apply (8 seekers refilled together over 6 s), or stay one at a time as a legendary exception? | Whole clip |
