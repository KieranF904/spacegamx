# Part features (registry, CUT 1 of docs/refactor/plans/part-registry.json)

A **part feature** is one behaviour a part gives a ship (a Tow Beam's tow, a Burst Strafer's dodge), declared once as a
`PartFeature` object instead of special cases spread over `rebuild.ts`, `energy.ts`, `flight.ts` and the UI.
Status: the seam exists and is wired; converted: **the Tow Beam** (`tow/`, Cut 4), **the Burst Strafer** (`strafer/`,
Cut 6: the first with flight hooks and an input) and **the Repair Beam and Point Defence** (`support/`, Cut 8: weapon-kind
roles). Ships without a feature rebuild, draw and fly exactly as before. Surge and Warmth are not features (left as they are).

## Add a part feature (one folder)

A feature is one folder per half, and the generator lists them. Nothing else is registered by hand.

1. **The model.** Add the part to `scripts/econ/models.mjs` (its row or appended block, and its `RECIPES` entry), then
   `node scripts/econ/models.mjs`. The function flag the feature reads (e.g. `tow: {...}`) is set here. Full steps:
   [docs/areas/ship-parts.md](../../../../docs/areas/ship-parts.md), "How to extend".
2. **The shared half**: `common/src/ships/features/<id>/index.ts` exports `feature: PartFeature` (`types.ts`). Put its
   numbers and arithmetic in `<id>/<id>.ts` (pure, like `tow/tow.ts`; the barrel re-exports it). Fill only what the
   feature needs: `applies` (which functions it is on), `order` (unique; a new feature goes after the existing ones so
   their feature numbers do not move), `burst` (draws by the tick), `derive` (writes `derived.fx.<id>`), `load`, `flight`,
   `inputs`, `replicate`, `describe` (facts for tooltips and cards), `weapon` (a weapon-kind role).
3. **The world half** (only if it has server or client behaviour): `server/src/ships/features/<id>/index.ts` exports
   `serverFeature` (`create(host)` returning a `FeatureInstance`: `tick`, `messages`, `cargoMass`, `wire`, `status`);
   `client/src/ships/features/<id>/index.ts` exports `clientFeature` (`actions`, `controls`, `onKey`, `parsePilot`,
   `drawShip`, `indicator`). Follow `tow/` or `strafer/` for the shape.
4. **Generate**: `npm run features:gen` writes the three registries (`registry.ts`, the server and client `index.ts`).
   `npm run features:check` (`--check`) fails if one is stale; `registry.test.ts` runs the same check.
5. **Contract test**: `<id>/contract.test.ts` calls `runPartContract('<id>', { parts })` with fixture parts (see
   "The contract" below). If it has a wire slot, a control bit or an input: append the slot to `features.wire.json`
   (a wire change: `npm run wire:bump`), and a new input needs its bit pinned there (see "Rules").

The touch list in `docs/areas/ship-parts.md` is for a part with no feature folder. With a feature, the behaviour lives
in its folder and the shared files (`rebuild.ts`, `energy.ts`, `flight.ts`, `replica.ts`, the UI) do not change.

| File | What |
|---|---|
| `types.ts` | `PartFeature` and its hook contexts. Type-only (never imports a value). |
| `registry.ts` | GENERATED `FEATURES` array: `npm run features:gen` (scripts/features/gen.mjs). Never edit by hand. |
| `plan.ts` | `compilePlan()` checks and flattens; `getPlan()` memoises the registry's; `featureFacts()`. |
| `index.ts` | the public face (`export *` from `ships/index.ts`). |
| `features.wire.json` | wire slots features own, pinned at today's positions. Append-only; not in the wire hash. |
| `registry.test.ts` | registry up to date, manifest matches today's wire, plan validation, the seam, import rules. |

## What is wired (CUT 1)

- **applies / burst** (`rebuild.ts` step 4): a part whose function a `burst` feature applies to draws by the tick
  (a feed group in `circuits.ts`), like engines and guns.
- **derive** (`rebuild.ts`, after the cargo/scanner pass, before the circuits): each feature the ship has writes its own
  `derived.fx.<key>`; the key is typed by declaration merging on `FeatureDerived`. The ship also gets `derived.fxMask`
  (bit = feature number) and `derived.fxList` (`Int8Array`, plan order). All three are **absent** when a ship has no
  feature, so ships without one are byte-for-byte what they were.
- **load** (`energy.ts` `gunLoad`, per tick): each feature in `fxList` adds its draw to `out`. Must not allocate.
- **describe** (`featureFacts(ctx)`): facts of the features a function gives. `describePart()` (common ships/describe.ts) wraps it with partStats; the client renders facts in `client/src/ships/describe/` (tipRows, chips, summaryFields, guideNumber). A feature adds facts; the Tow Beam's replaced its old tooltip, card and compact-tooltip rows (a `Fact` may carry `dim`, `short`, `chip`, `drawWhen` presentation variants).
- **burst: 'engine'** (`circuits.ts`): Drive Cell banks touching the part feed it, as they do engines: a Burst Strafer's.
- **flight** (`flight.ts` stepFlight, Cut 6): five phases (`types.ts` FlightPhase: preJump, steer, thrustGate, impulse,
  damp), each the plan's hooks in (order, feature) order, sharing one module-level `FlightCtx` (reset by field, no
  allocation, not re-entrant). Every hook runs for **every** ship stepped and checks for itself (a ship that lost its
  strafers mid-dodge still winds the counter down). A thrustGate hook may ask power for the tick (`ctx.load[feature]`,
  `ctx.loads++`); `powerTick` settles it as `PowerUse.extra` (by feature number: from the bank the parts touch first,
  then as an engine) and the impulse hooks read `ctx.shares[feature]`. Hand state between a feature's hooks in
  `ctx.scratch`, written every tick the hook runs.
- **flight signature** (`replica.ts`): each feature's `flightKey(d)` (what of the rebuild its hooks read), and the
  ship's features that have flight hooks (`|fx<mask>`).
- **inputs** (Cut 6): a `held` input travels by its name through the whole chain: `flightInputs.ts`
  (`newFlightControls`, `buildFlightInputs`), `replica.ts` (`controlBits`, `flightControls`, from its `ctlBit`), the
  server's `readInputsInto` (Input component field of that name, resolved once). The wire end stays hand-packed and
  pinned (protocol.ts binary flags, `INPUT_BOOLS`, the Input component, `CTL`): a NEW input needs the longer binary
  input form first. `strafer/feature.test.ts` checks every held input round-trips the whole chain.
- **replicate**: validated against `features.wire.json`; the pilot row's extras are written by the server features'
  `wire()` in id order, which must be the manifest's slot order (server `strafer/wire.test.ts` checks it).

## Rules

- Feature number = position in `plan.features` sorted by `(order, id)`; at most 31 (`fxMask` is an int32).
- rebuild/energy/replica import only `plan.ts` (partStats and the barrel may also import a feature's pure helper file, e.g. `tow/tow.ts`, never its `index.ts`) (and `types.ts` as types) and call `getPlan()` inside functions, never
  at module scope; a feature's folder may import them back, but must not use an imported value at its module scope.
- No side-effect registration: a feature is `features/<id>/index.ts` exporting `feature`; then `npm run features:gen`.
- A feature input with a control bit must use a bit already pinned to it in `features.wire.json`: the binary input
  flags are full, so a new input needs the longer binary input form first (a protocol change). `compilePlan` refuses.
- A new replicated slot is a wire change: append to `features.wire.json`, then `npm run wire:bump`.
- Hooks are plain functions on plain data; per-tick hooks (`load`, flight) must not allocate.

## Server and client halves (Cut 2)

A feature's world side and UI side live next to the shared part, as plain folders the same generator lists:

- `server/src/ships/features/<id>/index.ts` exports `serverFeature` (`ServerFeature`: `create(host)` returns a
  `FeatureInstance` with optional `tick`, `messages`, `cargoMass`, `wire`, `status`, `onShipRebuilt`, `onLeave`).
  `ServerFeatures` (host.ts) flattens them once; GameServer ticks them inside the `towing` tick entry (same slot, so
  Tow keeps its place), adds their messages to the dispatch table (a type the game handles, or two features claim,
  throws), and ShipBridge asks `featureCargo`, `shipRebuilt`, `shipForgotten` through its host.
- `client/src/ships/features/<id>/index.ts` exports `clientFeature` (`ClientFeature`: `actions` merged into
  `keybindings.ts` ACTIONS, `controls` (a held input's value each input tick: `ClientFeatures.controlFor(name)`),
  `onKey`, `parsePilot` into `entity.fx`, `drawShip`, `indicator`). `ClientFeatures`
  (host.ts) is owned by ShipClient; ShipRenderer gets it for the draw loop.
- `npm run features:gen` writes all three lists; `--check` (run by registry.test.ts) fails if any is stale.
- `FeatureInstance.wire`/`status` feed SnapshotBuilder's pilot row and status row (the Tow Beam's `[8]`).

## Weapon-kind features (Cut 8: `support/`)

A behaviour that belongs to a weapon KIND (tuning.json `weapons.<kind>`: the Repair Beam's `heal`, the Point Defence
Turret's `pointDefence`) rather than to a function flag declares `weapon: WeaponRole[]` (id + `applies(def)`) and gives
`applies: () => false` (so it never enters `derived.fxMask`; order 40, after the others, so their feature numbers are
unchanged). The server half hangs hooks on the role ids (`ServerFeature.weapon`, `server/src/ships/features/types.ts`):
`onFire` (a held beam of that kind fires this way instead of the damaging beam; returns how far it stopped) and `onTick`
(once a tick after the guns' tick, whatever the trigger). `server/src/ships/features/weapons.ts` flattens them once, in
plan order, and the bridge's gun step (`bridge/weapons.ts`) walks the arrays: no per-kind special case, no allocation.
Hooks receive `WeaponBridge` (an alias of the bridge's ctx, `bridge/core.ts`). Not done here: describe text (the Mends /
Intercepts tooltip rows replace the Damage and Fire-rate rows, which an append-only facts seam cannot express) and the
client's repair beam / point-defence visuals (`MiningBeamFx`, `ShipClient.stepPointDefenceVisuals`, `gunDecor`).

## The contract

`contract.ts` exports `runPartContract('<id>', { parts })`, a vitest suite every feature must pass (plan and wire
slots, catalogue and recipes, describe facts, burst energy, stepShipPhysics vs replicaStep parity, keyframe and
pilot-row round-trip, hot-path emptiness). Each feature folder has a `contract.test.ts` calling it; the client half
(facts render in tooltip, chips and summary) is `client/src/ships/features/contract.test.ts`, which walks every
registered feature. A new feature adds its `contract.test.ts` with fixture parts.
