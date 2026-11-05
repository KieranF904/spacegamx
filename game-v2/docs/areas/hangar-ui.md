# Hangar and ship-edit UI
The station hangar where a pilot designs and refits ships: a canvas grid editor (place/pick up/rotate parts), the part palette and model cards, mounting and power/circuit feedback, the load test, ship summary stats, part tooltips, saved designs and hangar slots, plus the Component Guide window. Server side: `shipEdit` / `slotSave` validation and `Hangar.save`. All rules live in `common` (mounting, blueprint validation, derive, energy); this area only presents them and sends `ShipEdit` messages.

## Files (what each owns)
| path | lines | owns |
|---|---|---|
| client/src/ships/HangarUI.ts | 2342 | `HangarUI` class + `HangarDeps`; sections below |
| client/src/ships/portsGrid.ts, portsOverlay.ts, portsReport.ts | 105/235/150 | ports designs: `PortsGrid` (overlay, hover, ghost ports, scenario) and `portsPanelHtml` (load test rows); `PortsOverlay` (cached layer, glyphs, `portNear`, `ghostHint`); `portsReport`/`portsWarnings` (unfed, open, wasted, clashing), `loadRow`, `portTipHtml` |
| client/src/ships/wireEdit.ts | 299 | `pruneWires` (saved wire dropped as parts go) and the power report (`powerReport`, `weakLinks`, `PowerReport`, `PartPower`, net colours) |
| client/src/ships/modelCards.ts | 210 | model card text: `familyLabel`, `mountBadge`, `mountingText`, `keyStats`, `sizeText`, `tradeOff`, `modelLock` (what a locked model waits on) |
| client/src/ships/partTip.ts | 228 | `partTipHtml(part, PartTipCtx)`, `PART_TIP_CSS`, `resistText`, `modsText` |
| client/src/ships/shipSummary.ts | 114 | `shipSummary(catalog, tuning, econ, bp)` -> `ShipSummary` (stats shown/compared), `BIGGER_IS_BETTER`, `jumpRatioNote` |
| client/src/ships/ShipStore.ts, blueprintApi.ts | 122/31 | live ship source; blueprint file list/load/save (`listBlueprints, loadBlueprint, saveBlueprint`) |
| client/src/ships/HangarLitView.ts, hullPreview2d.ts | 102/26 | lit WebGL layer under the grid (render-ships); 2D part colours |
| client/src/ui/ComponentGuideUI.ts | 399 | Component Guide window (`ComponentGuideUI`, `ComponentGuideDeps`) |
| client/src/ui/componentGuide.ts | 199 | pure data for it: tabs (`COMP_TABS`, `tabOf`), `guideRows`, `rowsOf`, `rowGates`/`requirementLine` (unlock gates), `questTeaches`, `bossDrops`, `rareParts` |
| client/src/ui/componentSprites.ts | 130 | part sprites for the guide: `partSprite`, `peekSprite`, `PART_SPRITES_VERSION` (asset cache) |
| common/src/ships/{mounting,blueprint,energy,circuits,wires}.ts | | the rules: `checkMounting`, `partMountingProblems`, `mountingWords`, blueprint validation (`badMounting` etc.), `loadTest`/`BROWNOUT` |
| server/src/net/handlers/shipEdit.ts | 145 | `registerShipEditHandlers`: dock, undock, shipEdit, slotSave/Fly/Clear, designSave, shareDesign, pilotInfo; `clientBlueprint` (the untrusted blueprint parse), `handleShipEdit`, `handleSlotSave`. Registered from GameServer's `buildMessageHandlers()` |
| server/src/GameServer.ts | 4168 | `freeBuild(conn)` (dev free-build check), reached from shipEdit.ts through `ServerCtx` |
| server/src/ships/ShipBridge.ts | 540 | `validate(bp, {mounting?})` (one-line delegator to bridge/rebuild.ts `validate`): shared by both handlers |
| server/src/game/Hangar.ts | | `save(conn, slot, bp, {plan, grantAll})`: costs, ghosts vs built parts, gem handling, loaner rule, returns `string[]` errors |
| server/src/game/AdminTools.ts | | admin free-build toggle (`freeBuild`, and its admin command) |

### HangarUI.ts sections (read only the slice)
63-102 `HangarDeps` | 105-307 fields + constructor (DOM, canvas, lit view at 255) | 308-408 open/close/slots/keys | 409-535 editing: `candidate, pickFacing, placementProblem, candidateMounting, mountLine, place, pickUp, remove` | `onHull` (saved-wire pruning) | 603-676 new/load blueprint | 677-764 saved designs | 765-817 `saveAndLaunch`, `remaining`, ghosts, status | 818-889 derive: `refresh, rederive, showLit` | 890-1303 panels: palette (`renderPalette` 908), `handCard` 1000, filters, `partListsHtml` 1115, `renderSlots` | 1304-1460 `buildHtml`, `ammoHtml`, button binding | 1461-1528 `powerHtml` (load test UI) | 1529-1659 `summaryHtml`, `renderStats` | 1660-1719 tooltips | 1720-2188 canvas: `draw` 1729, `drawPower` 1925, `drawCircuits` 2013, `drawMounting` 2122, `drawFacing` 2162 | 2189-2342 module helpers (`ruleText, esc, button, chip, energyHtml`...).

## Public interface
- `new HangarUI(deps: HangarDeps)` (HangarUI.ts:63/105): `toggle()`, `open(slot?)`, `close(launch)`, `onHangarUpdate()`, `handleKey(code)`. Deps supply catalog, tuning, econ, `owned(slot)`, `hangarState()`, `canMake`, `have`, `coming`, `send(ClientMessage)`, `knownPlans`, `grantAll`, `getBlueprint`, `liveShip`, `onOpen/onClose`.
- Messages sent: `shipEdit` (blueprint) and `slotSave` (slot, blueprint, optional plan); reply `shipEditResult {ok, errors}`; hangar state via `ServerHangarMessage` (has `freeBuild` flag, Hangar.ts ~730).
- `describePart()` facts (ship-parts) feed tooltips/cards; `ShipDerived` feeds summary/power/circuit views.

## Invariants
- No game rules in the UI: mounting/validity/power math come from `common` and are shown, never re-derived. Add a rule in common (with the server using it via `ships.validate`), then surface it.
- The server is authoritative: `handleShipEdit`/`handleSlotSave` (net/handlers/shipEdit.ts) always re-run `ships.validate` and `Hangar.save`; a client check is feedback only. Both require being docked (or `shipEditAnywhere`).
- Free build (no parts or licence needed) is dev only: proto mode (everyone admin + `shipEditAnywhere`) or an admin with `freeBuild` toggled where the server was started with `freeBuild` (index.ts: `DEV_MODE`) and `NODE_ENV !== 'production'`. `grantAll` must never be reachable in production.
- Gun gems/mods are the server's to give: `Hangar.save` strips client-supplied `mods/gems`.
- Generated art here (part sprites, item icons) uses the asset cache with `PART_SPRITES_VERSION`; bump on change.
- Editor look matches flight: built parts are drawn by `HangarLitView`; ghosts (not built yet) are faint flat shapes in `draw()`.
- Before/after panels for UI changes: docs/panels/README.md (category `ui`, images in docs/panels/<date>/ui/, one entry file in docs/panels/entries/, then `npm run panels:index`).

## How to extend
1. **Add a hangar warning/mounting message**: put the rule in `common/src/ships/mounting.ts` (`partMountingProblems`, text via `MountingProblem.message`/`mountingWords`); the editor shows it through `candidateMounting` (478) and `drawMounting` (2122) with `ruleText` (2189); add a test in `common/src/ships/mounting.test.ts` and `server/src/game/mounting.test.ts`.
2. **Add a placement refusal**: `placementProblem` (451); the same rule must be in blueprint validation (`common/src/ships/blueprint.ts` ~206) or the server will not agree.
3. **Add a stat to the summary**: field in `ShipSummary` + `shipSummary()` (shipSummary.ts), a `BIGGER_IS_BETTER` entry, row in `summaryHtml` (1529) / `renderStats` (1610).
4. **Add a power/circuit indicator**: compute in `powerReport`/`weakLinks` (wireEdit.ts 176-260, test in wireEdit.test.ts), show in `powerHtml` (1461) and `drawPower`/`drawCircuits`.
5. **Add a model card line or lock reason**: modelCards.ts (`keyStats`, `modelLock`); tooltip line in `partTipHtml`; test in modelCards.test.ts.
6. **Add a palette category/filter**: `categoryOf`/`filterCat` (2219-2238), `partListsHtml` (1115), `FAMILY_LABEL` in modelCards.ts.
7. **Component Guide**: new tab = `CompTab`/`COMP_TABS` and `tabOf` in componentGuide.ts; new unlock gate = `rowGates`; test in `client/src/ui/componentGuide.test.ts`.
8. **New message or server validation rule**: validation in `ShipBridge.validate` / `common/src/ships/blueprint.ts`; costs and ghosts in `Hangar.save`; reply errors as plain strings. Changing message shapes touches networking (PROTOCOL_VERSION).

## Tests
- `npx vitest run client/src/ships client/src/ui/componentGuide.test.ts` (wireEdit, modelCards, partPresentation); there is no HangarUI test (DOM/canvas), so keep logic in pure modules you can test.
- Server: `npx vitest run server/src/game/hangar.test.ts server/src/game/freeBuild.test.ts server/src/game/mounting.test.ts server/src/game/guestAdmin.test.ts`; common: `npx vitest run common/src/ships/mounting.test.ts common/src/ships/ships.test.ts`.
- UI shots: live-game only (shoot.mjs, one headless browser at a time, closed after; game server 3000 + Vite 5273; free build on a dev server). Stills of ship looks use `npm run render` (render-ships), but that does not draw the editor chrome.

## Gotchas
- `designSig` (HangarUI.ts:103) decides whether the load test result is stale: include any new blueprint field that affects power in it.
- The editor derives with `rederive()` on every edit; keep `refresh` cheap (HangarUI is 2.3k lines, avoid touching the constructor unless needed).
- HTML panels are built as strings: escape names with `esc()`.
- `owned(slot)` includes that slot's built parts; ghosts are what you could not pay for. A loaner slot refuses saves unless `grantAll`.
- Z-order: tooltips use z-index 2100 (`PART_TIP_CSS`); new overlays must sit below or above deliberately.
- Every design is a ports design (2026-11-05): `rederive` sets `power: 'ports'`, New makes one, and `powerHtml` shows `portsHtml` (client/src/ships/portsReport.ts: generation, stores, unfed parts, open in ports, wasted generator lines). The energy overlay (overlay `energy`, key E, or the panel's "On grid" button; client/src/ships/portsGrid.ts is HangarUI's one entry point, portsOverlay.ts draws): port glyphs (out a filled triangle, in a hollow notch; amber/blue linked, red open or clash, orange wasted, grey spare), links as thick as the E/s they carried in the chosen load test (labelled at px >= 22), stores' fill, short consumers with their share; the part in hand's ports and the parts they'd link to (`previewPorts`, cached per position/turn/flip); a tooltip per port (`portTipHtml`). The whole layer is drawn into its own canvas once per design/scenario/view and blitted on mouse moves (Sunspear: 0.3 ms a move, about 30 ms an edit with the three load tests). The POWER panel's LOAD TEST rows (firing while cruising, boosting, both; `portsLoadTest` in common/src/ships/power/portsLoadTest.ts, cached per layout) pick the overlay's scenario. Port states: common/src/ships/power/portStates.ts (`portsView`). The old `power` overlay (networks, banks) draws only for pool designs.
- Wiring is retired (energy-routing-impl.md D1): no wire tool, no wire drawn on the grid, no spools billed (server `Hangar.save`); a saved `bp.wires` is kept and pruned as parts go, for the old energy system until the switch-over. The power panel/overlay show the old system's networks until P5's energy overlay replaces them. `stored()` in deps is now unused.

## Related areas
[energy](energy.md) (circuits, load test, `PowerUse`), [ship-parts](ship-parts.md) (`describePart`, models, mounting data), [render-ships](render-ships.md) (HangarLitView, decor), [economy-quests](economy-quests.md) (fabrication, licences, Hangar slots), [networking](networking.md) (ShipEdit messages), [server-core](server-core.md) (GameServer handlers, net/handlers/shipEdit.ts), [ui-hud-input](ui-hud-input.md) (window kit, Component Guide placement).

## Notes (moved from DEVELOPMENT.md and the old engine-map)
- **Refit flow**: the hangar sends `shipEdit`; the server checks docking (`STATION_INTERACT_RADIUS`) and validation, replies `shipEditResult`, and keeps the blueprint per connection across respawns (proto sets `shipEditAnywhere`). Saved ships (the active one and the hangar) live in the pilot's profile; guests' refits last the session.
- **Dev tooling**: `client/shipsDevApi.ts` is a Vite dev-server middleware (`shipsDevApi()` in `vite.config.ts`, serve-only, never in a build) so the hangar can list/read/write `data/ships/blueprints/*.json`. The hangar's Load list has a "Pre-made ships" group (the capital ships, bundled into the build) and fits big ships to the view; the inventory stub was raised to cover them. Proto (`npm run proto`, `/?proto`): H hangar, K damage the part under the cursor, U repair (J is the jump drive), B spawn a dummy (blueprint picked in the admin panel), V switch mouse-steer / helm, R respawn. Helm controls: A/D turn, W/S thrust along the nose, Q/E strafe, mouse aims turrets (ships with turrets start in helm mode). Interact is X.
- **Hangar keys and rebinding**: `HangarUI` keys stay live with `InputManager.raw` (translation off), so rebinding never breaks the hangar's own keys.
