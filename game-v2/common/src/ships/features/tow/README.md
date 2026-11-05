# Tow Beam feature (Cut 4 of docs/refactor/plans/part-registry.json)

The first converted part feature. A Tow Beam latches onto a wreck, debris or a loot pod and pulls it on a tether
(rules in `tow.ts`'s header). Its pieces, one folder per half:

| Half | File | What |
|---|---|---|
| shared | `common/src/ships/features/tow/tow.ts` | tuning, `canTow`, `towLoad`, `towPull`, `TowInfo`, `TowKind` (was `ships/tow.ts`; exported by the `ships` barrel) |
| shared | `.../tow/index.ts` | the `PartFeature`: `applies` (`fn.tow`), `burst` (draws by the tick), `derive` (`derived.fx.tow`), `load` (draws while `ship.tow` is set), `describe` (the Tows tooltip row, card chip, compact row), `replicate` (pilotExtra slot 2, status slot 8, pinned in `features.wire.json`) |
| server | `server/src/ships/features/tow/Towing.ts` | the tether, the request, the delivery to a station; a `FeatureInstance`: `tick`, `messages.tow`, `cargoMass` (the load), `wire`/`status` (the snapshot rows) |
| client | `client/src/ships/features/tow/` | `index.ts` (the U key, `parsePilot` into `entity.fx.tow`, `beginFrame`/`drawShip` for the tether, the chip), `tether.ts`, `TowIndicator.ts` |

Unchanged on purpose: `fns[i].tow` (the data flag `applies` reads), `ShipState.tow` (what the server says it tows; `load`
reads it), `PartStats.tow` (the golden raw partStats snapshot pins it; no text reads it now), the `{type:'tow', on}`
message and the wire (protocol 16). The Hangar summary's Tow Beam row still reads `ShipSummary.tow` (live ready/no-power
text and key name are not static facts), and the field guide's prose still reads `towTuning`.
