# Architecture audit: has the modular layout held, and should we add contracts?

Date: 2026-11-07. Audit only; no code changed. Method: git (log, diff --numstat over merge ranges), grep, line counts. No tests, builds, servers or browsers were run.

Baseline: **f3862e2** (2026-11-01 00:31, "Stage 6 registry Cut 11", the last commit of the refactor; stage plans in docs/refactor/plans, start state in docs/refactor/stage0-baseline.md and docs/audits/architecture-for-agents.md). Since then: 711 commits (80 first-parent) on refactor/split.

## Verdict

The feature-folder seam held. The three big features did not go back to 20-30 hub edits; most of their files are new files in their own folders. What drifted is narrower, and more expensive per change than the headline numbers suggest:

1. a **gun-state field has no registry**, so one per-gun field costs 11-13 files of hand-copied field lists (weapon groups);
2. the **server FeatureHost grew from 9 to 25 members**, and features still poll for events the host does not publish;
3. **protocol.ts, SnapshotBuilder.ts and ShipClient.ts are the new hubs** (+35%, +70%, +85% lines), which the refactor did not target because they were smaller then;
4. the **agent reading list** (area docs 455 KB, 80 registered worktrees) costs more than any code drift.

Suspected drift 4 (Pilots.ts) and 5 (StationWindow.ts) are mostly refuted: both barely grew.

## 1. Measurements

### 1.1 Hub and facade line counts, baseline vs now

| File | f3862e2 | now | change | commits since |
|---|---|---|---|---|
| server/src/GameServer.ts | 4,182 | 4,699 | +517 (+12%) | 81 |
| server/src/ships/ShipBridge.ts | 538 | 624 | +86 | n/a (facade) |
| client/src/Game.ts | 1,591 | 1,641 | +50 | 35 |
| client/src/rendering/Renderer.ts | 1,982 | 2,111 | +129 | 23 |
| client/src/ships/HangarUI.ts | 2,336 | 1,927 | -409 | 22 |
| server/src/game/Pilots.ts | 1,127 | 1,186 | +59 | 10 |
| client/src/ui/StationWindow.ts | 1,444 | 1,470 | +26 | 5 |
| common/src/network/protocol.ts | 1,585 | 2,133 | +548 (+35%) | 71 |
| client/src/ships/ShipClient.ts | 1,057 | 1,956 | +899 (+85%) | 109 |
| server/src/net/SnapshotBuilder.ts | 839 | 1,430 | +591 (+70%) | 72 |
| common/src/ships/rebuild.ts | 608 | 756 | +148 | n/a |

Reading: the facades the refactor cut (ShipBridge, Game, HangarUI, and GameServer vs its pre-refactor 5,762) stayed cut. The files that grew a lot are the ones every netcode and weapons change goes through (ShipClient 109 commits in a week, protocol 71, SnapshotBuilder 72), mostly from the netcode rounds, not from the three features. They are now the biggest "load the whole file" costs after GameServer.

### 1.2 Special-case branches in hubs (feature words: clamp, minebay, fabricat, machine, weaponGroup; and `kind|type|id === 'literal'` branches)

| File | feature words | literal branches |
|---|---|---|
| GameServer.ts | 3 -> 9 | 10 -> 12 |
| ShipBridge.ts | 0 -> 3 | 0 -> 0 |
| Game.ts | 0 -> 0 | 1 -> 1 |
| Renderer.ts | 1 -> 1 | 5 -> 5 |
| HangarUI.ts | 16 -> 10 | 6 -> 6 |
| ShipClient.ts | 0 -> 2 | 6 -> 9 |
| SnapshotBuilder.ts | 0 -> 0 | 5 -> 13 |
| Pilots.ts | 1 -> 15 | 6 -> 7 |
| protocol.ts | 0 -> 14 | 8 -> 8 |

Renderer, Game, HangarUI: clean, no new feature branches. GameServer gained two `features.get('support'|'machines') as unknown as X` casts (the hub knows two feature classes by id, lines ~816 and ~846), a ~70-line inline FeatureHost adapter (lines ~779-846: bank, hold, party, canDamage lambdas), and the `registerBankHandlers` / `registerWeaponGroupsHandlers` lines (the registry-style seam working as intended). SnapshotBuilder's literal-branch growth (5 -> 13) is netcode (row kinds), not features. Pilots.ts feature words 1 -> 15 are the bank and field hooks.

### 1.3 Files touched per feature

Hub files: GameServer, ShipBridge, Game, Renderer, HangarUI, protocol, ShipClient, SnapshotBuilder, Pilots, StationWindow, ShipRenderer, rebuild.

| Feature (range) | Files | New files | Lines +/- | Hub files touched (lines +/-) |
|---|---|---|---|---|
| Field fabrication (93af25f^..e148157) | 131 (41 server, 36 client, 34 common, 8 data, 8 docs) | 48 | 8,324 / 970 | 8: Pilots 225/197, StationWindow 33/7, ShipClient 24/6, GameServer 22/23, protocol 8/17, ShipBridge 7/13, HangarUI 4/5, Game 1/0 |
| Groups, mines, docking (3fb7019^..e472d0a) | 127 (51 common, 38 client, 28 server) | 45 | 6,684 / 169 | 6: protocol 37/12, ShipClient 16/4, GameServer 7/0, HangarUI 5/1, ShipBridge 4/1, Game 1/1 |
| of which weapon groups alone (39f87dd) | 41 | about 9 | 957 / 68 | 5, all under 20 lines (ShipClient 13/4) |
| Heavier shots (17545d4^..fc5cf74) | 65 (48 client, mostly text snapshots; 9 common, 3 server) | 2 | 1,276 / 337 | 0 |

Reading: fabrication and groups are 130-file diffs because they are whole features (45-48 new files, tests, data, docs). The hub edits are small and mostly wiring, except one: **fabrication moved 225 added / 197 removed lines inside Pilots.ts** (bank and hold logic reshaped in the hub, F6). Heavier shots touched no hub, which is the refactor's promise kept.

## 2. Findings, ranked by token cost impact

### F1. Per-gun state has no registry: one field costs 11-13 files (suspected drift 1: CONFIRMED, but located in common/sim, not the weapons feature)

Evidence: the optional per-gun fields added over the last week (`trig`, `minePaid`, `mineUntil`, `mineShare`, `heldDist`) each appear in 10-13 non-test files. For `trig` the hand-copied sites are: ships/state.ts (declaration and init), ships/guns.ts (2), sim/state.ts (declaration and two copy functions at lines 104 and 130), sim/guns.ts (view in at 134, out at 167), sim/otherGuns.ts (view in 183, out 207, constructor 257, serialise 326, positional deserialise 349), sim/ownStep.ts (60 and 177), sim/headHash.ts (80), sim/ring.ts (70, the hash), sim/a-adapt.ts (71), ShipClient.ts (1949). That is 8 separate copy-lists of one field set, one of them positional serialisation. The weapon-groups commit shows it: 41 files, about 12 of them common/sim and ships files that exist only to carry one field through.

Cost: a gun-state change is the most likely place for a silent desync (a missed copy site shows up as a replica or ring mismatch, found only by the golden parity runs). An agent must read otherGuns.ts, state.ts and ownStep.ts to be sure it found every list. Highest token cost per change of anything audited.

Missing seam: a `GUN_FIELDS` table (name, default, hashed?, serialised?, ring-copied?) that `gunStateOf`, view in/out, serialise, headHash and ring iterate. Array fields (`cooldown`, `rounds`...) and scalar fields (`trig`, `heldDist`...) differ, so two small tables. The sim is the determinism-critical hot path, so do it with the golden hashes (`frameHash.golden.json`, `parity.golden.json`) as the oracle: they must not move.

### F2. FeatureHost is widening toward a god interface (suspected drift 2: CONFIRMED, moderate)

| Interface | f3862e2 | now |
|---|---|---|
| server FeatureHost (server/src/ships/features/types.ts) | 9 members | 25 members (+16) |
| client ClientFeatureHost | 12 | 16 (+4: entities, cellSize, tick, systemId) |
| common PartFeature members | 73 | 75 |
| server FeatureInstance hooks | 7 | 8 (+onShieldBreak) |
| server types.ts length | 73 | 109 lines |

New server members fall into three families: hold and bank (`econ`, `send`, `profile`, `markDirty`, `holdCount`, `holdTake`, `holdGive`, `holdRoom`, `freeBuild?`, `bankSpare?`, `spendBankSpare?`), world queries (`pilotsIn?`, `effect`, `shipView?`), and rules (`canDamage?`, `sameParty?`). Eight are optional, so a feature must guard each call and a test host must decide whether to implement it. Features also reach past the host: `host.ships` is the whole ShipBridge (Clamps uses `host.ships.clamps`, `get`, `has`, `chargeOf`, `slowedTicksLeft`...), so the header's "narrow object" is no longer true in practice. The hub is in this too: a 70-line inline adapter in GameServer builds it.

It is not yet a god interface (25 is manageable), but each new feature adds 2-8 members and the doc comment ("a feature that needs more gets it added here") has no brake. A clamp feature needs about 6 of the 25, a machines feature about 14, and each is shown all of them.

### F3. No event hooks: features poll for died / jumped / berthed (suspected drift 3: CONFIRMED)

FeatureInstance has `tick, messages, cargoMass, wire, status, onShipRebuilt, onShieldBreak, onLeave`. Nothing for death, jump, berth or system change. server/src/ships/features/clamp/Clamps.ts (233 lines) therefore re-derives them every tick in one break check (lines ~200-208): `hasComponent(world, Dead, ...)` ('death'), `host.isDocked(...)` ('station'), `Input.jump[...]` ('jump'), `pilotsIn` membership ('gone'). The header comment (lines 10-11) documents these as prose. So the clamp knows the ECS `Dead` component, the raw jump input array and the dock predicate. Jump has already changed shape once ("jump destination locked at initiation", protocol 62); if it becomes server state rather than a key, Clamps breaks silently with no type error. Minebay and machines have the same shape (`onLeave`, `isClaimed` through a cast).

Cost: moderate per change, high per bug, because the coupling is invisible until you read the feature's source. Fix: `onDied(eid)`, `onBerthed(eid)`, `onJumpStart(eid)`, `onSystemChange(eid)` on FeatureInstance, fired once by the code that already knows (Docking.ts, the jump code, the death handler).

### F4. Agent reading cost: area docs and worktrees (suspected drift 6: CONFIRMED, larger than any code drift)

- docs/areas/*.md: 16 files, 2,073 lines, **455 KB (about 110k tokens)** in total. networking.md alone is 102 KB (610 lines, about 25k tokens), weapons.md 40 KB, ops-tools.md 36 KB, economy-quests.md 30 KB, ship-parts.md 17 KB. The 5-line CONTEXT.md routers correctly send an agent to one guide, but a single networking or weapons guide is 10-25k tokens, and fabrication and groups each have a design doc (556 and 371 lines in docs/design) on top.
- common/src/ships/features/README.md (124 lines) is good: one how-to, one table. Its status line is out of date (it lists tow, strafer, support, flash as converted; clamp, minebay, machines, gyro and weaponry exist too).
- Worktrees: `git worktree list` shows 80, and `.claude/worktrees` has 82 `agent-*` directories. Each is a full checkout; grep or glob from the repo root can wander into them and return duplicate hits the agent must disambiguate. Disk size not measured (a du over them timed out on this machine, which is itself telling).

### F5. protocol.ts, SnapshotBuilder.ts, ShipClient.ts are the new hubs

See 1.1. protocol.ts has begun the right split (clampProtocol.ts, minesProtocol.ts, weaponGroupsProtocol.ts, inputCompact*.ts, inputFields.ts) but still gained 548 lines and 14 feature-word lines. ShipClient (1,956) is touched by almost every client-side ship change (109 commits) and by every feature in the ranges above (16-24 lines each). The refactor plans (docs/refactor/plans) had no cut for it; it is the next "load the whole file" cost (about 24k tokens).

### F6. Pilots.ts (suspected drift 4: mostly REFUTED, one real spot)

1,127 -> 1,186 lines (+5%), 67 -> 72 methods, 10 commits, 6 sections. Not a regrown hub. The real spot: the fabrication range rewrote 225/197 lines there (bank deposit, spend, rebuild, `devBank`, `sendBank`, wreck recovery hooks, around lines 882-1140). It already delegates to game/RepairBank.ts, so the next bank change should land there, not in Pilots. GameServer wires `fieldHooks` into it by casting a feature instance (line ~846), which is a leak, not a growth problem.

### F7. StationWindow.ts (suspected drift 5: PARTIALLY CONFIRMED, stable)

1,444 -> 1,470 lines; 60 `innerHTML` uses before and after; 5 commits. `render()` is a 9-way `if (this.tab === ...)` chain that clears the body (`replaceChildren`) and rebuilds it, with scroll positions saved and restored by hand (added in 205e6d8, a symptom of whole-tab re-rendering). `renderFabricator` alone is about 390 lines (835-1227). The seam has started: ui/station/ has BankPanel.ts (131), bankStore.ts, packs.ts, devBank.ts (400 lines in total). The cost is per UI change in that window (read 1,470 lines, or find the right 390-line method), not a growing cross-file fan-out. Lower priority than F1-F4.

## 3. What the refactor still gets right (keep)

- Feature-folder generation: `registry.test.ts` fails if `features:gen` output is stale, and the README's 5-step how-to is accurate for a new part.
- `runPartContract` (common features/contract.ts, 216 lines) pins plan, catalogue, describe, energy, parity, replicate and hot-path rules; 10 `contract.test.ts` files use it, including the new clamp, minebay and machines.
- Golden pins (server/src/golden): tickOrder.json, clientMessages.json, serverMessages.json, shipBridgeApi.json (117 lines), frameHash and parity goldens. serverMessages/shipBridgeApi changed in 30 commits since the baseline, each deliberately.
- Heavier shots (65 files, 0 hubs) shows data-driven changes stay cheap.

## 4. Contracts advice

### 4.1 What "contract" should mean here

You already have the strongest kind: executable contracts (runPartContract, structure pins, golden hashes). What is missing is the cheap reading-side half: a way to know, before opening a file, what it owns, what it may depend on, and what else must change with it. Three kinds, in order of value per cost:

1. **Table contracts where fan-out is real** (F1). If a field list is copied in 8 places, make it one table and make tsc or a test fail when a field exists in the type but not the table. That removes the need to document the fan-out at all.
2. **Narrow typed capability interfaces** instead of one wide host (F2, F3). For example `type ClampHost = Pick<FeatureHost, 'world'|'ships'|'tuning'|'getTick'|'tell'|'send'|'pilotsIn'>` and `create(host: ClampHost)`. The reader sees a feature's whole dependency surface in one line, and tsc enforces it. Add event hooks to FeatureInstance so "when X happens" is a declared hook, not a poll.
3. **A short header on the modules agents open first** (the hubs and each feature's index.ts), in a fixed, checkable form with four fields: `owns`, `needs` (capabilities it may use), `invariants` (one line each, naming the test that pins it), `extend` (the one place to add a case). Not history, not prose about design.

### 4.2 Where it pays off first

1. Gun state (F1): a table kills a 12-file fan-out and the silent-desync risk. Biggest win.
2. Feature host capabilities and event hooks (F2/F3): turns an implicit 25-member host into per-feature declarations; every future feature touches this interface.
3. Headers on the hubs that grew (protocol.ts, SnapshotBuilder.ts, ShipClient.ts, GameServer.ts, Pilots.ts, StationWindow.ts): sections, and "do not add here, add in <folder>". This is the section map CONTEXT.md already promises for HangarUI and ShipRenderer; extend it.
4. A generated per-area index to replace the hand-written file tables in the largest area docs (networking.md, weapons.md).

### 4.3 What it costs and how to stop it going stale

Rule: **nothing hand-written that a tool can generate or a test can check.**

- Table contracts: no upkeep beyond the table; `satisfies Record<keyof GunState, Spec>` makes tsc the staleness check, free.
- Capability interfaces: tsc enforces them (a feature using an undeclared member does not compile). Zero prose.
- Headers: only `owns` and `extend` are prose. Add a small script (like scripts/features/gen.mjs) that checks the header exists on a listed set of files, compares `needs` against actual host usage, and emits a generated index (exports, line counts, section ranges). Run it as `npm run contracts:check` beside `features:check`, and as a vitest like registry.test.ts so it rides in the existing gate. Hand-written line ranges rot at once: generate them.
- Docs: put section ranges and line counts in the generated index and cut prose from the area docs (target: networking.md at 102 KB).

Rough cost: table plus test about half a day each; capability types about a day; header checker about half a day; headers on six hubs about two hours.

### 4.4 Example for one real module: server/src/ships/features/clamp/Clamps.ts

Today the break reasons are prose in the header (lines 10-11) and the code reaches for `Dead`, `Input.jump`, `host.isDocked`, `host.pilotsIn`. Contracted form:

```ts
/**
 * @contract clamp (server half of features/clamp)
 * owns:       the pair decisions (dock, swap, undock, breaks); ships/bridge/clamp.ts owns the flight of a joined pair
 * needs:      ClampHost = Pick<FeatureHost, 'world'|'ships'|'tuning'|'getTick'|'tell'|'send'|'pilotsIn'>
 * events:     onDied, onBerthed, onJumpStart, onLeave (the break reasons map 1:1 to these hooks)
 * invariants: a clamped pair never jumps (contract test 'jump breaks'); a berth breaks the link the same tick
 * extend:     a new break reason is a new hook on FeatureInstance plus a case in client clampView.ts (text)
 */
export const serverFeature: ServerFeature<ClampHost> = { id: 'clamp', create: (host) => new Clamps(host) };
export class Clamps implements FeatureInstance {
  onDied(eid) { this.breakFor(eid, 'death'); }
  onBerthed(eid) { this.breakFor(eid, 'station'); }
  onJumpStart(eid) { this.breakFor(eid, 'jump'); }
}
```

The per-tick poll of the Dead component, the Input.jump array and isDocked disappears, and the feature no longer needs `isDocked` in its host.

## 5. Prioritised actions

| # | Action | Effort | Why |
|---|---|---|---|
| 1 | **Gun-field table** (common/src/sim and ships/state): one spec table for GunState fields; `gunStateOf`, view in/out, serialise, headHash and ring iterate it; a type-level check so a new field fails tsc if missing. Gate: frameHash and parity goldens unchanged. Hot path, so Opus. | 1-2 days | F1: 12 files per field today |
| 2 | **Split FeatureHost into capabilities** (hold/bank, party/view, world); each feature declares the subset it needs; stop passing the whole ShipBridge (expose a narrow `FeatureShips` view). GameServer builds capabilities from small modules, replacing the 70-line inline adapter. | 1 day | F2 |
| 3 | **Event hooks on FeatureInstance** (onDied, onBerthed, onJumpStart, onSystemChange) fired by the code that already knows; convert Clamps (4.4); existing contract and clamp parity tests are the oracle. | 1 day | F3 |
| 4 | **Prune the reading list**: remove finished worktrees (80 registered; `git worktree remove` each after checking nothing is unmerged, never force); split networking.md (102 KB) into an index plus per-topic files; fix the features README status line; add a "start here, max 3 files" list per task type. | half a day (worktrees 1 hour) | F4 |
| 5 | **`contracts:check` script and header convention** on the six growing hubs, derived `needs`, generated section and line index, in the same gate as `features:check`. | half a day | 4.3 |
| 6 | **Cut ShipClient.ts** like the earlier cuts (own/ and guns/ folders are the start): prediction, replicas, feature plumbing into modules, target under 1,000 lines. Same for protocol.ts (finish the per-feature `*Protocol.ts` pattern) and SnapshotBuilder.ts (row kinds into a registry). | 2-3 days, three parallel worktrees | F5 |
| 7 | **StationWindow tab registry**: tabs as `{id, label, render, badge}` entries in ui/station/, `render()` loops over them; move `renderFabricator` (390 lines) to ui/station/FabricatorPanel.ts. Skip the re-render rewrite unless it hurts. | half a day | F7 |
| 8 | **Pilots bank section**: next bank change goes into game/RepairBank.ts; move `bank*`, `devBank`, `sendBank` there, and pass the casted `fieldHooks` through a typed machines capability (from action 2). | half a day | F6 |

## 6. Minimal first step

Do action 1 first, in its smallest form: add `GUN_FIELDS` for the scalar optional fields (`trig`, `minePaid`, `mineUntil`, `mineShare`, `heldDist`, `tow`), make the copy sites in sim/state.ts, guns.ts, otherGuns.ts and ownStep.ts iterate it, and run only the frameHash and parity goldens. If the goldens do not move and the next per-gun field takes 3 files instead of 12, extend it to the array fields, then do actions 2 and 3. It needs no new tooling, proves "table over prose" on the highest-cost fan-out, and leaves the docs problem (action 4) independent, so it can run in parallel.
