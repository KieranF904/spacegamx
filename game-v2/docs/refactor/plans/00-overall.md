# Refactor workflow plan: splitting the giant files, then the part registry

Checked against the tree at `3c936b7`. Nothing is uncommitted, so the "commit the Strafer/Tow work first" rule from the plans is already met. Some work is shared between the five plans, so I merged it:
- **Input fields (one merged step):** the plans for GameServer Cut 3, the ShipBridge `flightInputs`, the Game.ts `inputFields` and registry Cut 5 all touch the same hand-copied input lists. They become one step.
- **Golden tests (built once):** the frame-hash test, the flight traces and the parity harness are each built once, in Stage 0.

## 1. Stages

All agents work in their own git copy (a worktree) on a branch taken from a `refactor/split` branch, which starts at the current HEAD. One integrator agent merges the branches back one at a time. A "lane" is one file, so a lane never runs two cuts at once.

**Gate G**, run after every cut and again after every merge (from `game-v2/`):
`npm run build:common && npx tsc --noEmit -p server && npx tsc --noEmit -p common && npx tsc --noEmit -p client && npx vitest run`
- The pass count must equal the Stage 0 baseline, with no edits to existing tests.
- `npm run wire:sync` must report no change, and `common/src/network/protocol.test.ts` must pass with the hash pin unchanged.
- The golden frame-hash test and the parity tests from Stage 0 must still pass.
- A move-check script must show that moved code is textually identical apart from `this.` becoming `ctx.`/`b.`.
- A grep test must show that nothing under `net/` or `bridge/` imports `GameServer` or `ShipBridge` at runtime.

**Hot-path gate** (on top of G): `cd server && npm run bench:net` (also with `--spread`), plus `npx tsx server/src/bench/tickBench.ts` and `npx tsx server/src/bench/bulletHellBench.ts`. Results must be within 3% of the baseline. Client-side cuts also need `npm run build:client` to pass (it checks that `serverOutOfMain` still holds).

| # | Stage | Lanes / agents | Models | Extra gate | Tokens |
|---|---|---|---|---|---|
| 0 | **Safety nets first, behaviour unchanged.** Golden 900-tick LocalTransport frame-hash test. Golden flight traces covering anchor, strafer, tow and surge. Parity harness comparing server ShipBridge, client ShipClient and replicaStep. Frozen tick-order list. The old switch's message types, taken from git. Snapshot of ShipBridge's method names. Text snapshots of every model's tooltip, card and summary. Pass-count and bench baselines. | 4 parallel worktrees (they only add test files) | Opus: frame hash and parity harness. Sonnet: the rest. Haiku: the text snapshots | Each new test passes on today's tree, twice in a row (it must be deterministic) | 0.4–0.6M |
| 1 | **Foundations, one lane per file, lanes in parallel.** A: GameServer Cut 0 (tickOrder), then Cut 1 (ServerCtx and dispatch). B: ShipBridge `flightInputs`, then `types`/`core`, then `sync`. C: Game.ts `keys` and `serverMessages`, which touch different line ranges. D: HangarUI `hangarHelpers`, then `hangarCanvas`/`hangarCanvasPower`. | 4 lanes, about 7 agents | Sonnet. Opus for ServerCtx and `flightInputs` | Parity harness for lane B. Handler-table completeness for lane A. Before/after hangar shots for lane D (`shoot.mjs`, one browser at a time) | 1.2–1.6M |
| 2 | **Merged input-fields step, on its own.** One shared `INPUT_FIELDS` table in common replaces the four GameServer input lists, the ShipBridge controls literal and the `bulletHellBench` copy. The dodge-latch fix on dock and linger is a separate commit, so it can be bisected. | 1 | Opus | Frame hash unchanged. The parity harness is the only test allowed to change, and only in the dodge-on-dock commit, which is made on purpose | 0.15–0.25M |
| 3 | **Mostly mechanical moves, in parallel.** GameServer Cuts 2, 4, 5 and 6 in 4 worktrees. ShipBridge `damage`, then `weapons`, then `rebuild` (one lane, run in order). Game.ts `inputSend`. HangarUI panels, then designs/wires. | about 9 agents | Haiku: Cut 2. Opus: `inputSend`. Sonnet: the rest | Cut 4: guestAdmin, safeguards and socketTransport tests. Cut 5: docking/shipEdit tests. Cut 6: tow, drift and nests tests | 1.6–2.1M |
| 4 | **Prediction-sensitive moves, one at a time.** GameServer Cut 3 (a verbatim move only, since the dedupe was done in Stage 2). Then ShipBridge `flight` plus `pilotless`, then the facade. Then the Game.ts windows registry, done last in its lane because it renames the most fields. | 3 agents, run in order | Opus. Sonnet for the windows registry | Hot-path gate, frame hash, parity harness, replay determinism | 0.8–1.1M |
| 5 | **Snapshot path:** GameServer Cut 7a, then 7b, then 7c. | 1 agent | Opus | Hot-path gate. Frames sent must be bit-identical | 0.4–0.6M |
| 6 | **Part registry.** Cut 1 → (Cut 2 alongside Cut 3) → Cut 4 (Tow) → Cut 10 (contract tests) → Cut 5 (Anchor) → Cut 6 (Strafer) → (Cut 7 alongside Cut 9) → Cut 8 → Cut 11. | About 11 agents, at most 2 at a time | As the plans suggest. Opus: Cuts 1, 5 and 6 | `runPartContract`, golden traces, a microbench (within 2% with no features, within 10% with all), no wire change | 2.0–3.0M (cheaper than the 2.8M plan, because it now edits small files) |
| 7 | Renderer split, kept optional. Do only `worldFx` now and defer the rest. | 1–3 | Sonnet. Opus for `entityLayer` | Before/after shots, frame time in ms | 0.15–0.35M |

**Why these lanes:**
- GameServer, ShipBridge, Game.ts and HangarUI are separate files, so lanes on different files run safely side by side.
- Inside GameServer, everything depends on Cuts 0 and 1, because the tick loop and message dispatch are what the other cuts plug into.
- The Stage 3 cuts touch different method ranges. They only collide on the import block, the constructor and the field block, so one integrator can resolve those merges.
- The prediction-sensitive cuts (Stages 4 and 5) run one at a time, so if a desync appears it points to a single commit.
- The registry comes last, so it lands in small files and can reuse the dispatch table, tickOrder and the input table.

**Review step:** each stage has one adversarial reviewer. It reads only the diff plus the stage checklist (verbatim move, coercions kept, guard granularity, no new per-tick allocation, import cycles). Reviewers run on Sonnet, or Opus for Stages 2, 4, 5 and registry Cuts 1, 5 and 6. Reviews add about 10–15% to each stage's tokens; the totals above include them.

**Running it:**
- Each worktree needs `npm run build:common` and its `node_modules` linked (a Windows junction) before tsc or vitest will run.
- The workflow saves its progress after each stage, so a run can be resumed: every merged cut is one commit on `refactor/split`.

## 2. Total for a normal run

- **About 6.5M–9.5M tokens** (most likely around 8M).
  - The splits are roughly 4.5–6.5M.
  - The part registry is 2–3M.
- **Calendar:** about 6–9 working days of agent time with the lanes above, compared with about 15 days if every cut ran in order.

## 3. What ultracode would change

**In practice:** every stage would turn into finder pools, then implementers, then reviewers with 3–5 lenses each, run until nothing new turns up, then a completeness critic. Stage 0 would grow, and simple renames would get the same treatment as hard cuts.

**Cost:** about **3–5×**, so **roughly 25–40M tokens** for this plan. The largest growth would be in Stages 3 and 6, because they have the most agents.

**Where it would likely do better:**
- **Prediction drift (Stage 2, Stage 4 Cut 3 and ShipBridge `flight`, registry Cuts 5 and 6).** Separate reviewers for input order, `recordSelfHashes` placement, quantisation and `body.cargo` summing would catch drift that a scripted parity test can miss: input mixes the test never plays, emp and jump together, and timing at the 16-per-tick input cap.
- **Missed call sites, found by repeating the search until nothing new turns up.** This covers `(server as any).` spies in tests, outside use of ShipBridge fields that were private, stray `Input.*` lists (`bulletHellBench` was already found by hand), and `derived.tow` readers in the client UI.
- **The per-tick snapshot path (Cut 7c).** A reviewer focused only on allocations, plus one focused only on the 40-pilot frame time, beats a single bench run, because the 3% bench noise can hide a slow leak of garbage-collection work.
- **Hostile input and auth (Cuts 1, 2 and 4).** A completeness critic comparing every old `Number()`/`String()`/`.slice` against the new handlers, and checking the silent drop of unknown messages.
- **HangarUI and Renderer.** These have no tests, so several reviewers are the only safety net besides screenshots. Here the extra reviewers really do add something.

**Where it mostly costs more for the same outcome:**
- GameServer Cuts 0 and 2, `hangarHelpers`, the Renderer backdrop and overlays, docs and line-number updates, and Stage 0's text snapshots. The frozen-order test, the completeness test, tsc and the golden frame hash already catch the likely mistakes, so 4 reviewers agreeing that a verbatim move is verbatim adds nothing.
- Larger finder pools add little in Stage 3 either: the plans already list the line ranges, so there is nothing left to discover.

**Middle option:** a normal run, but with ultracode-style review only on Stages 2, 4 and 5 and registry Cuts 1, 5 and 6. That costs **about 11–14M** and gets most of the benefit.

## 4. Risks and merge strategy

**Merging:**
- One integrator merges into `refactor/split` in a fixed order: Stage 0 → lane A → B → C → D, then each Stage 3 branch one at a time.
- Each later branch is rebased onto the new branch tip before it merges. Gate G runs again after every merge, and the hot-path gate runs after Stages 4 and 5.
- Conflicts are resolved by editing. Never use checkout, restore, stash, reset or clean. Worktrees are removed with `git worktree remove` only after their branch has merged.

**Feature freeze:**
- During a wave, no feature work may touch that wave's files (GameServer, ShipBridge, ShipClient, Game.ts, HangarUI).
- Your playtest of the new parts should come before Stage 1. Fixes found in it should go in before the freeze, or onto `proto/modular-ships`, merged into `refactor/split` between waves.

**Main risks:**
- **Line references go stale after the first merge.** Agents must find code by symbol name, never by line number.
- **Worktree setup cost on Windows** (installs and builds in each worktree).
- **The full server test run uses up to 6 GB.** Do not run more than about 2 vitest processes at once.
- **Stray test file.** If `_tmp_join.test.ts` still exists, it changes the baseline pass count, so record whether it is counted in Stage 0.
- **Gaps in the refactor plans themselves:** the audit's "pilotless" file barely exists and the "flyToward" it names was not found in ShipBridge, and HangarUI and Renderer have no tests.
- **Wire safety:** if the wire hash changes in any cut, that cut is rejected rather than bumped.
- **Docs drift:** after each merge, a Haiku pass updates `docs/areas/*` and the router, then runs the link check.

## 5. Recommendation

1. Run Stage 0 now as a normal workflow. It is cheap, about 0.5M tokens.
2. Then run Stages 1–5 as normal workflows, with the extra review only on Stages 2, 4 and 5. That is the middle option above, about 6–7M for the splits.
3. Do the part registry as a separate run afterwards, again with extra review on its Cuts 1, 5 and 6.
4. Defer most of the Renderer split.

Full ultracode would spend an extra 15–25M tokens. It would mainly add safety on the five or so prediction-sensitive and per-tick cuts, and the middle option already covers those.