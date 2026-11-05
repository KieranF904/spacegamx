# Architecture audit: making the game easier for parallel agents

Date: 2026-10-31. Audit only; nothing was changed. Goal (Kieran): make areas self-contained and partly procedural so each agent loads only its own area's context.

## 1. What I measured

Size of the code: 146,805 lines of TypeScript (123 test files among them), about 270k lines counting JSON data. At roughly 12 tokens a line, one big file is a lot of context on its own.

### 1.1 The god-files

| File | Lines | Approx. tokens to read it all | What is mixed into it |
|---|---|---|---|
| server/src/GameServer.ts | 5,762 | 70k | 90-case message switch (340 lines inline), the tick order, join/auth/login, docking, input queue, snapshots and per-client views, map dots, derelicts, person craft, boss-fight bookkeeping, tow glue, perf metrics, HTTP auth. 50 imports, ~160 methods, ~240 fields. |
| client/src/sandbox.ts | 4,860 | 55k | Dev sandbox (not on the live path; ignore for agents unless working on it). |
| client/src/Game.ts | 2,505 | 30k | Boot, ~40 UI windows constructed in one constructor (74 imports), key handling (140 lines), input send (210), the whole server-message switch (400 lines), chat, auth, settings, admin/contributor modes. |
| server/src/ships/ShipBridge.ts | 2,453 | 30k | Ship sim host: flight step, weapons and firing, shields, damage and breakage, rebuilds, anchor/brace, strafer dodge, tow glue, replicas, pilotless AI flight. Has section banners but one class. |
| client/src/ships/HangarUI.ts | 2,342 | 28k | Whole hangar: grid editing, parts panel, wires, previews, summary. |
| client/src/rendering/Renderer.ts | 1,982 | 24k | World, ships, FX and layers in one class (73 methods). |
| common/src/network/protocol.ts | 1,593 | 20k | Every message type, the compact tables, snapshot packing, wire hash inputs, the PROTOCOL_VERSION history. |
| client/src/ships/ShipClient.ts | 1,154 | 14k | Client ship state, prediction, replicas. |
| server/src/data/validateGameData.ts | 1,165 | 14k | Hand-written schema for every data file plus cross-checks. |
| client/src/ui/fieldGuide.ts | 555 | 7k | Hand-written prose that embeds model numbers. |
| scripts/econ/models.mjs | 543 | 8k | All 73 player part models as inline tables, one section per batch of parts. |

The client sandbox aside, the 5 files that nearly every part or system change touches (GameServer, ShipBridge, Game, ShipClient/ShipRenderer, protocol) add up to roughly 13,000 lines (about 160k tokens).

### 1.2 What a "new part" touches today

Real evidence, counted by searching the repo for each part's key word (non-test files plus tests):

| Part | Files that mention it | Notes |
|---|---|---|
| Stabiliser Anchor | 62 (49 code/data, 13 docs) | common 14, client 19, server 5 plus data |
| Burst Strafer | 36 | common 14, client 9, server 4, data 2, docs 4 |
| Tow Beam | 33 | common 9, client 10, server 5, data and script 2, docs 5 |
| Commit 5896116 (Energy phase 1 + cargo mass + Anchor) | 60 files, 2,821 lines added | one commit |
| Working tree right now (Strafer, Tow, Repair Beam, Point Defence, Pulse Dynamo...) | 58 modified files | hot ones: ShipBridge 183 lines, ShipClient 142, GameServer 118, models.mjs 106, ShipRenderer 90 |

The recurring touch-list for one part (the "fan-out"):

| Step | Files | Kind of edit |
|---|---|---|
| 1. Define the numbers | scripts/econ/models.mjs (then regenerate data/ships/models.json, data/recipes.json, data/items.json), data/ships/tuning.json, common/src/ships/tuning.ts | append a table section; "appended last so no other model's order moves" |
| 2. Derived stats | common/src/ships/types.ts (FunctionDef field), rebuild.ts (ShipDerived field and a hand-coded `if (fns[i].tow)` block), partStats.ts, index.ts exports | one block per feature in a shared function |
| 3. Energy | energy.ts, circuits.ts (`burst`, `isEngine` style checks by name) | name-based checks |
| 4. Behaviour | flight.ts / guns.ts / launch.ts / state.ts / physics.ts, plus a new feature file (anchor.ts, strafer.ts, tow.ts are good examples) | feature file is clean, but the call sites are scattered |
| 5. Server | ShipBridge.ts (calls into the feature), GameServer.ts (input fields, message case, tick, instance), server/src/net/Replication.ts, a game/<Feature>.ts, LootPods/Pilots/Weapons as needed | 4-6 files |
| 6. Protocol | protocol.ts (message, input bits, snapshot slot), binaryCodec.ts (DICTIONARY entry), replication.ts, components.ts (Input fields), bump PROTOCOL_VERSION and the PROTOCOL_WIRE_HASH pin, add a comment to the version history | the hash test fails until all are done |
| 7. Client state | GameState.ts, ShipClient.ts (prediction and replicas), Game.ts (key, message, indicator), keybindings.ts, a new ui/<Indicator>.ts | 4-5 files |
| 8. Client look | ShipRenderer.ts, partDecor.ts / gunDecor.ts, ThrusterFx or other Fx, componentSprites | 2-4 files |
| 9. Words | partTip.ts, modelCards.ts (a family label, a one-line blurb per model, a stat line), shipSummary.ts (a field plus a flags table), fieldGuide.ts (a prose section with hard-coded model lookups), ComponentGuideUI, HangarUI (ratings) | 5-6 files, each with its own idea of "what the part does" |
| 10. Tests | models.test.ts count pin (`models.length).toBe(73)`, `weapons.length).toBe(40)`), protocol.test.ts hash, a feature test, ships.test.ts | pins other agents break |
| 11. Docs | DEVELOPMENT.md paragraph, docs/engine-map.md, docs/panels/index.md, design docs | 3 shared docs |

So "add a part" is realistically 25-35 files, and an agent has to find them by searching. Seven of those files are shared, giant and edited by all agents at once.

### 1.3 Fan-out for other changes (from reading the code, not guessed)

| Change | Files today | Shared hot files hit |
|---|---|---|
| Add a ship part (above) | 25-35 | GameServer, ShipBridge, protocol, binaryCodec, Game, ShipClient, models.mjs, partTip, modelCards, fieldGuide, shipSummary |
| Add a weapon kind (a gun family, e.g. a new beam) | 15-25: models.mjs W table, tuning.json weapons, common guns.ts / shot.ts, ShipBridge fire code, Weapons.ts, binaryCodec DICTIONARY (family name), gunDecor.ts, sfx manifest, modelCards, fieldGuide | ShipBridge, binaryCodec, models.mjs |
| Add a boss | 8-12 and well documented: bosses.json, blueprint JSON via scripts/bespoke, brains/ (staged.ts), Bosses.ts, tests, docs/boss-design.md, DICTIONARY entries for its materials (the dictionary has 20+ boss material strings), bosses.test | binaryCodec (optional), Bosses.ts. Best-contained area today: it has a guide and mostly data. |
| Add a UI window | 4-6: new ui/X.ts using GameWindow (windowKit), construct it in Game.ts's constructor (74 imports, one big wiring block), a keybinding in keybindings.ts, a toggle in handleKeyPress, an update call in updateUI, a server-message case in handleServerMessage if it has data | Game.ts 3-4 separate places |
| Add a protocol message | 5-7: protocol.ts (type plus union entry), possibly COMPACT table, GameServer handleMessage case, client handleServerMessage case, protocol.test.ts (hash if COMPACT changed), PROTOCOL_VERSION bump, rate limiter table | protocol.ts, GameServer, Game, hash pin |
| Add a quest | 1-2: quests.json (+ people.json / dialogue); validateGameData cross-checks run on load. Already well contained. | none |
| Add an item/recipe | 2-3 data files + validation; items get icons by rule | none |
| Add a replicated field on the pilot's own row | data[13], data[14], data[15] are positional slots in `state.data` (warmth, anchor, cargo, ...); each is written in server/src/net/Replication.ts and read in GameState.ts by magic index. 150 `data[N]` reads exist. A new field means picking the next free index in the right place and the hash pin | Replication.ts, GameState.ts, protocol.ts |

### 1.4 Co-edited hot files

The git history is small and in big checkpoints (about 30 commits, most of the work lands in one huge uncommitted tree), so git log alone understates collisions. Most-touched files across the last 12 commits: DEVELOPMENT.md (5), docs/panels/index.md (3), GameServer.ts, validateGameData.ts, Game.ts, Renderer.ts, ShipBridge.ts. In the current working tree, the files with the most lines changed are exactly the god-files in 1.1. Collisions are mainly: GameServer.ts, ShipBridge.ts, ShipClient.ts, ShipRenderer.ts, HangarUI.ts, protocol.ts (+ the hash), models.mjs, DEVELOPMENT.md, docs/panels/index.md, and count pins in models.test.ts.

### 1.5 Brittle things I found

1. **Wire hash pin:** `protocol.test.ts` hashes COMPACT, SNAP_FIELDS, DICTIONARY, the binary input layout and a sample frame, and compares with `PROTOCOL_WIRE_HASH`. Any new part model id that an agent adds to DICTIONARY (the dictionary has 73 part ids appended by hand, in order) changes the hash. The dictionary is only compression: ids not in it are sent as plain strings (binaryCodec.ts line ~115), so most of these bumps are not needed for correctness, only for the pin. The comment block above PROTOCOL_VERSION is a hand-kept changelog that two agents edited for versions 14 and 15 in the same session.
2. **Count pins:** `models.length).toBe(73)` and `weapons.length).toBe(40)` and `legendaries.length).toBe(6)` in models.test.ts, plus comments listing who added what ("66, then the Pulse Dynamo, Flash Screen and Rail Driver..."). Every new part breaks this for the next agent. About 190 numeric `toBe(NN)` expectations exist across tests; most are fine but a handful pin data counts.
3. **Positional replication:** `data[8]`, `data[13..15]` and compact tuples: no names, no schema, no single table of what each slot means; the meaning lives in comments in GameState.ts, Warmth.ts, warmth.ts.
4. **Name-based special cases in shared derivation:** rebuild.ts has per-feature `if (fns[i].anchor)`, `.strafe`, `.tow` blocks; energy.ts has `burst = isEngine || weapon || miner || strafe || tow`; the same list exists in more than one place.
5. **Hand-written part words in 5+ places:** partTip.ts (row per feature), modelCards.ts (family labels, per-model blurb map `utility_tow_beam: '...'`, stat chips), shipSummary.ts (per-feature field plus flags table), fieldGuide.ts (prose with `MODELS.find(m => m.tow)` lookups), ComponentGuideUI. All read the same `FunctionDef` but each decides what to print.
6. **Appended-order coupling:** models.mjs sections say "Appended last, so no other model's order moves". Order matters because `fabOrder`, `guide.order` and DICTIONARY order are positional.
7. **Docs as append logs:** DEVELOPMENT.md (377 lines) and docs/engine-map.md (606 lines) are growing logs of feature paragraphs (the top of DEVELOPMENT.md has the Cold and Cargo mass paragraphs inline before the Quick Start finishes). Every agent edits them, none reads them all. docs/panels/index.md is a single 185-line table with one section per date; 3 of the last 12 commits touched it.
8. **Good news:** keybindings.ts is already a declarative `ACTIONS` table. Server subsystems such as Towing, Warmth, Party, Trade, Quests, Codex, Hazards already follow "class with tick(), constructed in GameServer, given a narrow host object". models.json is one model per line, so merges are clean. validateGameData is a real schema layer. Per-feature common files (anchor.ts, strafer.ts, tow.ts, surge.ts, support.ts) are a decent pattern. The architecture just needs the next step: make the integration points tables, not edits.

## 2. How things flow today (short)

- Data: data/*.json → server/src/data/GameData.ts and validateGameData.ts (shape + cross-reference) → registries in common (catalog.ts, tuning.ts, items.ts, partStats.ts) → server (ShipBridge, Pilots...) and client (imports the same JSON via vite; shipFunctionData.ts).
- Ship parts: scripts/econ/models.mjs (source of truth) → data/ships/models.json + recipes.json + items.json. Models carry fields such as `decor`, `guide`, `weaponMods`, `demand`, `strafe`, `tow`, `anchor`. `functions.json` (1,075 lines) holds legacy functions.
- Ship sim: common/src/ships (pure, shared: rebuild.ts derives ShipDerived; flight.ts steps motion; energy/circuits/surge power) is run by the server's ShipBridge and by the client's ShipClient for prediction and replicas. This sharing is the strongest part of the design.
- Network: protocol.ts (types, COMPACT tables, packSnapshot) + binaryCodec.ts (DICTIONARY, varints) + replication.ts (common, deltas) + server/src/net/Replication.ts + client NetworkManager and GameState.
- UI: windowKit.ts (`GameWindow`, tooltips, menus, ItemGrid; used by 13 files) + one class per window, all constructed in Game.ts.

## 3. Proposals, prioritised

Priority = payoff / (effort × risk). "Tokens" are the context an agent needs to read for a typical task of that kind, my estimate.

### P1. A part-feature registry: one folder per part feature (biggest payoff)

**Fixes:** the 25-35 file fan-out of §1.2, and most collisions in ShipBridge, rebuild.ts, GameServer, ShipClient, Game.

**Idea:** a `PartFeature` interface that a folder registers. Start in common (where logic is shared) and add server/client halves:

```
common/src/ships/features/tow/
  index.ts        // registerFeature({ id:'tow', fn:'tow', ... })
  tow.ts          // pure logic (already exists)
  tow.test.ts
  README.md       // 20 lines: what, invariants, wire fields
server/src/ships/features/tow/        // optional hooks: onTick, onInput, onMessage
client/src/ships/features/tow/        // optional: look, key, indicator, tooltip rows
```

The interface (all optional hooks, the registry calls them; shared code stops knowing about `tow`, `anchor`, `strafe`):

| Hook | Replaces today's | Side |
|---|---|---|
| `derive(fn, partIndex, ctx) → partial of ShipDerived` and `derivedKeys` | the `if (fns[i].tow)` blocks in rebuild.ts, fields in ShipDerived | common |
| `drawsEnergy(fn)`: `burst` / `continuous` classification | energy.ts name list | common |
| `flightMods(body, derived, tuning)` | flight.ts / guns.ts special cases | common |
| `inputs: ['dodge','brace']` (name, bit, key, label, hint) | Input components, protocol input bits, binary input, keybindings.ts entries, GameServer input copy lines (the ~12 hand lists of `'strafeLeft','strafeRight','jump'`) | common |
| `replicate: [{ name:'brace', bits, who:'self'|'all' }]` | positional `data[14]`, ctl bits, keyframe fields | common |
| `serverTick(host)`, `onMessage('tow')` | GameServer instance + tick line + switch case | server |
| `describe(fn, tuning) → rows[]` (label, value, tier) | partTip rows, modelCards chips, shipSummary field, Component Guide row, field guide numbers | common/client |
| `draw(ship, part, fx)`, `indicator()` | ShipRenderer special cases, `*Indicator.ts` constructed in Game.ts | client |
| `contract` (see P5) | per-feature tests | tests |

Features are loaded by a generated barrel (`features/index.ts` produced by a 20-line script that globs `features/*/index.ts`), so adding a feature adds files and never edits a shared file.

**Effort:** M-L overall, but incremental. Step 1 (1-2 days): define the interface and registry and convert ONE existing feature (Tow Beam: self-contained, 33 files, newest). Step 2: convert the others one per PR (Anchor, Strafer, Surge, Support, Warmth). Existing code keeps working; unmigrated parts still use old paths.
**Risk:** medium: prediction parity (client and server must run the same hooks in the same order) and perf in the ship step (use arrays of hook functions resolved at startup, not per-tick lookups). Add a parity test per feature (P5).
**Context saving:** adding a part today: read about 8-12 slices of the god-files, ~60-100k tokens (or ~250k if reading whole files). After: read the feature README, one existing feature folder as the template, and the interface file: ~10-15k tokens. About 5-8x less.

### P2. Procedural words: one `describe()` per part, rendered everywhere

**Fixes:** §1.5 item 5 (partTip, modelCards, shipSummary, fieldGuide, ComponentGuide, HangarUI summary each decide separately; fieldGuide.ts hard-codes model lookups and numbers in prose).

**Idea:** extend `partStats.ts` (141 lines, already the shared "what does this part do") into a `describePart(fn, tuning) → Fact[]` where Fact = `{ key, label, value, unit, importance, group }`, generated from model data plus the feature's `describe` hook. The tooltip, model card, Component Guide row and ship-summary field list are then different *views* of the same fact list (tooltip: all; card: top 2-3 by importance; summary: sums of group). A part needs only a `guide.blurb` in models.json (already exists: `guide: {name, blurb, order}`) and optionally `description`. The per-model blurb map in modelCards.ts is deleted. Field guide prose that quotes numbers uses template tokens (`{{tow.range}}`) resolved from the same tuning, or is generated from a short markdown file per feature beside the feature code.

**Effort:** M (3-5 days); do it before P1 or with it. **Risk:** low-medium (UI text changes; screenshot a few tooltips before/after). **Context saving:** a new part touches 1 file for words instead of 5-6 (about 2,500 lines of partTip/modelCards/shipSummary/fieldGuide/ComponentGuideUI → 0 unless the part has an unusual fact).

### P3. Generated wire layer: derive the dictionary and hash pin; schema-driven fields

**Fixes:** the hash pin collisions, positional `data[N]`, hand-bumped PROTOCOL_VERSION and its hand-written changelog.

Three steps, in order of payoff:

1. **Dictionary from data (S, immediate):** move the ~110 model/material/piece strings out of DICTIONARY into `data/wire-dictionary.json`, an append-only manifest. A script (`npm run wire:sync`) appends ids that are in models.json/materials.json/pieces.json but not in the manifest, never reorders. binaryCodec reads it. Dictionary growth then changes the hash legitimately but automatically, with no hand edit in binaryCodec.ts. Better still, exclude data-derived strings from the pinned hash if the order is guaranteed append-only (a test checks that the manifest is a prefix-preserving superset of the previous committed one).
2. **Version tool (S):** `npm run wire:bump "short reason"` runs the hash computation, increments PROTOCOL_VERSION, writes PROTOCOL_WIRE_HASH, and appends the reason line to `common/src/network/PROTOCOL_CHANGELOG.md` (one line each, append-only). The test message still says what to do, but agents run one command instead of hand-editing three places. Resolves "agents re-pin the hash for each other": if the hash is the only conflict, the tool re-run is idempotent (it takes the max of both versions plus one).
3. **Named pilot-row fields (M):** replace `state.data[N]` with a declared list `PILOT_FIELDS = [{name:'warmth', index:13, scale:1}, ...]` in one file, with typed accessors on both sides (`row.warmth`). Features register entries (P1). Wire format unchanged at first (same indices), so no client break; the table is then also the input to the hash.
4. **Message registry (M):** `defineMessage('tow', {fields…, compact?})` in per-feature files; protocol.ts keeps only the core messages. The ClientMessage/ServerMessage unions are assembled from the registry types. Do this last: it is the riskiest part (type inference across packages).

**Effort:** 1 and 2 are half a day each. **Context saving:** a protocol change today is reading protocol.ts slices, binaryCodec, replication.ts, the pin test, and the version comment (~15k tokens, and two sources of merge conflict). After 1+2: the agent runs a command.

### P4. Split GameServer.ts and ShipBridge.ts by area (mechanical, safe)

**Fixes:** 5,762 and 2,453-line files owned by everyone.

**GameServer.ts** (plan, in order of lowest risk):
- Message router: `server/src/net/handlers/*.ts` each exporting `{ type → handler(ctx, conn, msg) }` per area (trade, party, quests, crafting, dev, admin, ship-edit, social). `handleMessage` becomes a dispatch table (type → handler) plus the rate limiter and pre-join check. The 90-case switch (340 lines) shrinks to ~40. Handlers get a narrow `ServerCtx` interface (send, getPilot, getShip, now) instead of `this`.
- Move out in this order: join/auth/profile handlers (`handleJoin`, `handleAuthLogin`, `handleAuthRegister`, `handleHttpAuth`: ~300 lines), snapshot building and per-client view (`sendSnapshots`, `sendShipUpdates`, `updateShipView`, `sendMapDots`, `sendPlayerState`, `sendSystemInfo`: ~900 lines, becomes `net/SnapshotBuilder.ts`), docking and ship edit (`handleDock`, `handleShipEdit`, `handleSlot*`), derelicts and pilotless-ship events, perf metrics.
- Tick order as a data list: `systems: Array<{name, every?, when?, run}>` assembled in one small file `server/src/tickOrder.ts`, with systems pushed by modules (`towing`, `warmth`) instead of the 40 hand-written `this.guard('x', () => ...)` lines. Order stays explicit with named phases ('pilots-move', 'combat', 'world', 'persist').

**ShipBridge.ts** into `server/src/ships/bridge/`: flight.ts (movement step), weapons.ts (fire and cool down), damage.ts (hits, shield, breakage), rebuild.ts (regrow, replicas), pilotless.ts (AI flight, `flyToward`), sync.ts (keyframes). Keep the `ShipBridge` class as a thin facade so the rest of the server (and tests) does not change. It already has section banners at lines 483, 652, 1225, 1527, 2099, 2237, 2346, which give the cut lines.

**Client Game.ts** likewise: `client/src/app/` with `windows.ts` (construction table), `serverMessages.ts` (type → handler table registered by each UI/feature), `keys.ts` (action id → handler registered by the owner of the action), `inputSend.ts`, `boot.ts`. The big `handleServerMessage` and `handleKeyPress` switches become registries that UI classes register into (`ui.onMessage('questUpdate', ...)`, `ui.onAction('map', toggle)`), so adding a window means one file and one line in a list (or none with a barrel).

**Renderer.ts**: split by layer: `WorldLayers`, `ShipLayer` (already ShipRenderer), `FxLayer`, `Overlay` with a Layer interface (`update(frame)`, `draw()`). Do last.

**Effort:** L in total, but each cut is a 1-2 hour mechanical PR. **Risk:** low (behaviour-preserving, tests cover a lot: 123 test files) as long as agents are not editing the same lines at that moment; do each cut while that file is quiet, announce it, and let one agent do the whole split in a single worktree. **Context saving:** GameServer from 70k tokens to ~8k for the router + whichever 300-600-line handler file the task needs.

### P5. Per-feature contract tests, and replace count pins

**Fixes:** broken pins (`toBe(73)`, `toBe(40)`, `toBe(6)`), hash re-pins, forgetting prediction parity.

- **Pin removal (S, do now):** replace `expect(models.length).toBe(73)` with invariants: every model has pieces, material, recipe, tier, unlock, guide entry, a dictionary or no-dictionary decision, a fabOrder that is unique, and every `weapon` model has a mount (the tests already check these per model, the count is redundant). Keep a *floor* (`>= 73`) if worried about silent deletion, or snapshot ids into a committed `models.ids.json` that the sync tool updates (like the dictionary manifest); the test fails only if an id disappears (rename) not when one appears.
- **`runPartContract(featureId)` (M):** a shared vitest helper a feature opts into with one line. It checks: the model validates; recipe and item exist; `describePart` returns facts with no NaN; the server ShipBridge and client ShipClient reach the same body state after the same input script (prediction parity); the replicated fields round-trip through pack/unpack; energy draw is non-negative and matches `demand`; and the tooltip renders. New parts then get 8 checks for free and the author writes only their specific behaviour test.
- Per-feature test files already exist (anchor.test.ts, strafer.test.ts, tow.test.ts); move them into the feature folder (P1).

**Context saving:** an agent stops reading ships.test.ts (1,075 lines) and models.test.ts (~500 lines) to find which pin to bump.

### P6. Scaffolds: `npm run new:part <id>`, `new:window`, `new:message`, `new:boss`

**Effort:** S once P1/P2/P3 exist (each scaffold is 50-100 lines of template output). Before P1 they would only generate more scatter, so wait. `new:boss` can be done now since bosses are already well contained (docs/boss-design.md). `new:window` can be done now too if Game.ts gets the registry from P4.

### P7. Area CONTEXT.md files and a router

**Fixes:** agents load whole DEVELOPMENT.md (377 lines of feature paragraphs) and engine-map.md (606 lines) to find their area; paragraphs about cold, cargo, anchor sit before the Quick Start finishes.

- Add `CONTEXT.md` (about 40-80 lines) in each area's root folder. Template: purpose; files and what each owns; public interface (types and functions other areas may call); invariants (e.g. "common/ships must be deterministic; no Date.now"); how to extend (steps); tests to run (`npx vitest run common/src/ships`); related areas.
- Turn DEVELOPMENT.md into a router: Quick Start, services, env vars, and a table "area → CONTEXT.md". Move the feature paragraphs (cold, cargo mass, etc.) into the area files they belong to. The same for the 600-line engine-map.md: split by the `###` headings into the CONTEXT.md files; keep the file as the index or delete the duplicates.
- Add a short root `AGENTS.md`/CLAUDE.md: "read the router, then only your area's CONTEXT.md; never open a god-file whole; use grep".
- **Effort:** S-M (a day). **Risk:** none. **Context saving:** an agent reads ~60 lines + the router (~40) instead of up to ~1,000 lines of DEVELOPMENT.md/engine-map.md (about 12k tokens → 2k).

### P8. Sharded docs for collision-prone files

- `docs/panels/index.md`: one file per entry or per date (`docs/panels/2026-10-31/index.md`, rows appended by feature: `docs/panels/entries/<topic>.md` with front matter), and an `npm run panels:index` script that builds the table. Agents add a file, never edit a shared one.
- DEVELOPMENT.md/engine-map.md paragraphs: move per area (P7); new notes go in the area's CONTEXT.md "Recent changes" or in an append-only `CHANGES.md` per area with date-prefixed lines.
- PROTOCOL_VERSION history: `PROTOCOL_CHANGELOG.md` (P3).
- **Effort:** S. **Risk:** none.

### P9. Models source: split models.mjs by family and make it order-independent

**Fixes:** 543-line single file, "appended last" coupling, every agent adds a section in the same place (the Strafer/Tow, Support, Surge sections are already stacked in one file).

- `scripts/econ/models/<family>.mjs` (weapons, engines, power, utility, shields, plating, support, strafer-tow ...) each exporting a list; models.mjs imports all by glob and assigns `fabOrder`/`guide.order` from a stable key (`family` rank + explicit `order` field in the part), not array position.
- Better: a part declares itself in its feature folder (`features/tow/model.mjs`) so P1's one-folder promise is real. models.mjs becomes the generator only.
- Keep the generated models.json one-model-per-line (already merge-friendly).
- **Effort:** M. **Risk:** low-medium: the generated output must be identical before and after (diff models.json, recipes.json, items.json must be empty); make that the acceptance test.

### P10. Smaller wins

| Item | Evidence | Effort |
|---|---|---|
| Typed `Input` bundle: one list of input fields instead of 3 hand lists (`['forward','backward',...,'jump']` at GameServer.ts lines 2843 and 3292, plus the lines at 3459-3463 and 3918) | Anchor/Strafer each added a copy site; easy to miss one (a bug source for new controls) | S |
| One "part-kind" predicate module (`isEngine`, `isMiner`, `isWeapon`, ...) used by rebuild.ts and energy.ts instead of re-deriving lists | rebuild.ts line 319 | S |
| Barrel exports: `common/src/ships/index.ts` re-exports everything by name; every new file is another edit to index.ts. Use `export *` per feature folder | index.ts changed in all three part commits | S |
| validateGameData.ts (1,165 lines): split per data file into `server/src/data/validate/<file>.ts`, each registered; new data files bring their own validator | 5 of last 40 commits touched it | M |
| Move tooltips' `itemTipHtml`, `partStatsHtml` out of windowKit.ts (429 lines, window frame + item grid + tip + menus) into `ui/tips.ts` and `ui/ItemGrid.ts` | windowKit changed in the Tow commit just for a part tip | S |
| `client/src/sandbox.ts` (4,860 lines) and `client/src/rendering/legacy/*`: confirm whether they are live; if dev-only, mark so in CONTEXT.md and exclude from agent reading, or move to `client/dev/` | largest client file; legacy SunRenderer 1,321 lines | S |
| Dead code and duplicates: `functions.json` (1,075 lines) legacy functions vs models; `docs/rendering/*prototype*` and `sun-sky-proto`/`planet-proto` scripts could live under `labs/` | grep shows two sun renderers (rendering/SunRenderer.ts, legacy/SunRenderer.ts) | S |
| Prediction parity: server `ShipBridge.step` and client `ShipClient` both build a `FlightBody` by hand (ShipBridge.ts ~line 1235-1272 copies inputs, cargo, brace, dodge). Extract `buildFlightInputs(entityLike)` into common so the two sides cannot drift | cargo/brace/dodge were each added in both places | S-M |
| Circular imports: I did not run a graph tool (no new tool installs). Quick grep found no `from '../index'` loops inside common; `windowKit` ↔ `fieldGuide` ↔ `partTip` link through the shared data. Recommend adding `madge --circular` or `dependency-cruiser` as an optional script and a rule "common imports nothing from client/server" | not measured | S |

## 4. Suggested area map

An agent owns one row. "Contract" is what other areas may rely on; changing it needs a note in the area's CONTEXT.md and a heads-up.

| # | Area | Owns (today's files) | Public interface / contract | Biggest god-file pressure |
|---|---|---|---|---|
| 1 | **Ship parts and models** | scripts/econ/models.mjs, data/ships/{models,functions,materials,pieces}.json, data/recipes.json (models/craft), data/items.json (parts), common/src/ships/{types,catalog,partStats,grades,rebuild(derive part)}.ts, feature files (anchor, strafer, tow, surge, support) | `FunctionDef` (model fields), `describePart()`, `ShipDerived` keys, feature registry | models.mjs, rebuild.ts |
| 2 | **Energy and circuits** | energy.ts, circuits.ts, surge.ts, wires.ts, client wireEdit.ts, CircuitBars.ts, docs/design/energy-system.md | `PowerUse`, `CHARGE_GROUPS`, `drawsEnergy(fn)`; `ShipDerived.circuits` | energy.ts (486 lines changed in one commit) |
| 3 | **Flight and physics** | flight.ts, physics.ts, load.ts, collide.ts, launch.ts, jumpFields.ts, stages.ts, FlightBody; prediction in ShipClient | `stepFlight(body, input, derived, tuning)`: deterministic, no I/O. `FlightBody` fields. | ShipBridge flight step, ShipClient prediction |
| 4 | **Weapons and combat** | guns.ts, shot.ts, damage.ts, hazards.ts, server game/Weapons.ts, Ammo.ts, gunDecor.ts, MiningBeamFx, DamageFx; weapons in models.mjs | `fireBaseShot`, `WeaponMods`, damage events, `partWeaponDef` | ShipBridge fire/damage |
| 5 | **Bosses, enemies and AI** | server game/{Bosses,Enemies,Mobs,brains/*}.ts, data/bosses.json, mobs.json, ships/bespoke + blueprints/enemy, scripts/bespoke, docs/boss-design.md, BossUI/BossFx | Boss stage schema, `brains/ids.ts`, boss-design guide; already the best contained | Enemies.ts 1,371 lines |
| 6 | **Economy, items and quests** | data/{items,recipes,quests,people,factions,unlocks,achievements,codex}.json, server game/{Market,Quests,Pilots,Hangar,Operations,Outpost,People,Codex,Achievements,StationServices}.ts, common/econ, client Station/Trade/Quest/Inventory UIs | Item/recipe/quest schemas validated by validateGameData; economy messages in econProtocol.ts | Pilots.ts 1,127, StationWindow 1,444 |
| 7 | **Networking and protocol** | common/src/network/*, server net/*, client network/*, wire manifest and tools (P3) | Message registry, pilot-row fields, PROTOCOL_VERSION tool, `wire:bump` | protocol.ts, GameServer snapshots |
| 8 | **Server core** | server GameServer.ts (post-split: router, tickOrder, join/auth), index.ts, AdminServer, profile/*, auth/* | `ServerCtx`, tick phase list, handler tables | GameServer.ts |
| 9 | **World, systems and sim LOD** | data/{systems,stations,world,terrain,hazards,mining,status}.json, common/{world,asteroid,terrain,starfield}, server game/{Roaming,Arenas,Hazards,Mining,Sieges,Events,AsteroidOrbits,HomeStations}.ts, ships/SimLod.ts | System/Station schemas, `InSystem`, spatial grid | Sieges.ts 1,001 |
| 10 | **Rendering: ships and hangar look** | client ships/{ShipRenderer,hull*,frameBuild,partDecor,gunDecor,ThrusterFx,*Fx}.ts, scripts/render, native-render | `ShipLook`, decor registry (`decor` id → draw function), render API | ShipRenderer, partDecor 670, gunDecor 623 |
| 11 | **Rendering: world, sky, planets, FX** | client rendering/*, particles, trails, settings/quality, scripts/{sun-sky-proto,planet-proto,surface-art}, docs/rendering | `Layer` interface (`update`, `draw`), quality tiers | Renderer.ts 1,982 |
| 12 | **Hangar and ship editing UI** | HangarUI.ts, hullPreview2d, wireEdit, modelCards, partTip, ComponentGuideUI, shipSummary, ShipStore, blueprintApi, server game/Hangar.ts | `describePart()` facts; `ShipEdit` messages | HangarUI 2,342 |
| 13 | **UI, HUD and input** | client ui/* (except hangar), windowKit.ts, input/*, Game.ts (post-split: windows table, keys, message registry), Tutorial, GuideUI/fieldGuide, audio | `GameWindow`, `ui.onMessage`, `ui.onAction`, keybindings `ACTIONS` | Game.ts, windowKit.ts |
| 14 | **Website, lobby and accounts** | site/, server-browser/*, client LoginUI/ServerBrowserUI, DB scripts, Postgres docs | HTTP routes, user store interface (JSON/Postgres) | small and contained |
| 15 | **Ops, deploy and tools** | deploy/*, scripts/{vpsmon,profile,db,gen-sfx,notify,...}, bench, docs/audits, docs/ops | Deploy script, monitor | none |


Cross-area contracts worth writing down once (each as a short section in the area CONTEXT.md):
1. `FunctionDef` → `ShipDerived` (areas 1, 2, 3, 4, 12): who may add fields, and that derive is pure.
2. `FlightBody` + input bundle (areas 3, 7, 8, 13): the same struct on server and client prediction.
3. Pilot row fields and message registry (areas 7, 8, 13).
4. Data schemas and validation (areas 1, 5, 6, 9): every new data file gets a validator.
5. Render look interfaces (areas 10, 11, 12).

## 5. First-steps plan (do these first)

| # | Change | Effort | Why first |
|---|---|---|---|
| 1 | **Pin hygiene + wire tooling:** replace `models.length` / `weapons.length` / `legendaries.length` pins with invariants; add `data/wire-dictionary.json` append-only manifest + `wire:sync`; add `wire:bump "reason"` and a `PROTOCOL_CHANGELOG.md`. | 1 day | Removes the two daily collisions (count pins, hash re-pins) with almost no risk. |
| 2 | **Docs as routers:** CONTEXT.md per area (the 15 above, start with the 6 most active: parts, energy, flight, weapons, network, hangar UI); shrink DEVELOPMENT.md into a router; shard docs/panels/index.md; put engine-map.md sections into area files. Add an `AGENTS.md` rule: never open god-files whole. | 1-2 days (docs only) | Immediate token saving for every agent, zero code risk, and it makes the later refactors easier to brief. |
| 3 | **Split by cutting along existing seams:** (a) GameServer: message dispatch table + `net/handlers/*` + `SnapshotBuilder` + tickOrder; (b) ShipBridge: flight/weapons/damage/rebuild files behind the facade; (c) Game.ts: `windows.ts`, `serverMessages` table, `keys` table. One agent per file, one at a time, behaviour-preserving, `npm test` green. | 4-6 days total, each cut 2-6 hours | Takes the 12,000-line collision zone down to files of 300-800 lines owned by area. |
| 4 | **Part feature registry (pilot with Tow Beam), plus `describePart()`:** define `PartFeature`, convert the Tow Beam (newest, 33 files), generate tooltip/card/guide rows from facts. Then convert Anchor and Strafer. Add `runPartContract`. | 3-5 days for interface + 3 conversions | Turns "add a part" from ~30 files to one folder, and enables `new:part`. |
| 5 | **Split models.mjs by family/feature folder with an identical-output check; named pilot-row fields; `new:part` scaffold.** | 3-4 days | Finishes the part workflow and the protocol side. |

Suggested order of operations to avoid collisions: do 1 and 2 immediately (they touch almost nothing agents are editing); schedule 3 as a short "quiet window" per file (announce, merge fast); do 4 and 5 after the first cuts of 3, because the feature registry is much easier to land in the smaller files.

## 6. Estimated token cost for a typical task, before and after

| Task | Today (reads) | After P1-P5, P7 |
|---|---|---|
| Add a part with a new behaviour | GameServer slices, ShipBridge slices, rebuild.ts, energy.ts, flight.ts, protocol.ts, binaryCodec, Game.ts, ShipClient, ShipRenderer, 5 UI word files, tests, docs: about 60-100k tokens with targeted reads (up to 250k if whole files) | feature README + interface + one example feature folder: about 10-15k |
| Add a part that is only numbers (new variant of a family) | models.mjs section, models.test pin, dictionary, recipes: ~10-15k, plus a hash fix | one entry in a family file: ~3k, no pins |
| Add a protocol message | protocol.ts, GameServer switch, Game.ts switch, hash test: ~25-30k | message definition file + handler file: ~5k |
| Add a UI window | Game.ts (3 places), keybindings, windowKit, an example window: ~25k | example window + registry doc: ~6k |
| Change a boss | already good: bosses.json, Bosses.ts, brains, boss-design.md: ~15-20k | about the same (area CONTEXT.md added) |
| Orient in a new area | DEVELOPMENT.md + engine-map.md: ~12k | area CONTEXT.md: ~1-2k |

These are estimates from file sizes at about 12 tokens a line. The point is the order of magnitude: most of the cost is reading shared god-files for a few relevant lines, and that goes away when the lines live in their own folder.

## 7. Risks and cautions

- Prediction parity (client and server run the same common code) is the strongest guarantee in the codebase; the feature registry must call hooks in a fixed order on both sides. Keep the contract test (P5) as the gate.
- Do not start P4 while four agents are editing the same god-files. Coordinate one big-file cut at a time.
- The wire format is user-visible (old clients must reload). Keep the existing version check; the tooling only automates the bump, it does not remove it.
- Procedural tooltips will make all parts read in the same voice. Keep a per-model `description` for flavour and let facts be generated.
- Several areas have uncommitted trees in flight (Burst Strafer/Tow Beam, Repair Beam/Point Defence). Convert Tow Beam to the registry only after those commits land.

## 8. What I did not do

No code, data or test changes, no server or browser, no git write commands. The git history is sparse (about 30 commits, with the real work in one huge uncommitted tree), so the "co-edited files" numbers lean on the last commit's stat (60 files), the current diff (58 files), and keyword searches across the repo rather than a long log. Circular dependencies were not mapped with a graph tool.
