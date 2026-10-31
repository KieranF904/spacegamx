# Part features (registry, CUT 1 of docs/refactor/plans/part-registry.json)

A **part feature** is one behaviour a part gives a ship (a Tow Beam's tow, a Burst Strafer's dodge), declared once as a
`PartFeature` object instead of special cases spread over `rebuild.ts`, `energy.ts`, `flight.ts` and the UI.
Status: the seam exists and is wired; **no feature is converted yet** (`registry.ts` lists none), so every ship
rebuilds, draws and flies exactly as before. Tow is CUT 4, Strafer CUT 6.

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
- **describe** (`featureFacts(ctx)`): facts of the features a function gives. `describePart()` and the renderers are CUT 3.
- **flight signature** (`replica.ts`): a ship's features that have flight hooks are folded in (`|fx<mask>`).
- **flight / inputs / replicate**: typed and compiled and validated (per-phase sorted arrays, unique keys and control
  bits, slots pinned in `features.wire.json`), **not called yet**: stepFlight's phases and the input tables are CUT 5.

## Rules

- Feature number = position in `plan.features` sorted by `(order, id)`; at most 31 (`fxMask` is an int32).
- rebuild/energy/replica import only `plan.ts` (and `types.ts` as types) and call `getPlan()` inside functions, never
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
  `keybindings.ts` ACTIONS, `onKey`, `parsePilot` into `entity.fx`, `drawShip`, `indicator`). `ClientFeatures`
  (host.ts) is owned by ShipClient; ShipRenderer gets it for the draw loop.
- `npm run features:gen` writes all three lists; `--check` (run by registry.test.ts) fails if any is stale.
- Not yet used: `FeatureInstance.wire`/`status` (SnapshotBuilder still calls `towing.wireOf`; Cut 4 switches it).
