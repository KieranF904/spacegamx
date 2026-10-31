# Stage 0 baseline (refactor/split)

Recorded 2026-10-31 on the pre-refactor tree (HEAD ad8862a plus the uncommitted Stage 0 safety nets). Machine-specific: float hashes and timings are for this machine.

## Gate commands (from game-v2/)

    npm run build:common && npx tsc --noEmit -p server && npx tsc --noEmit -p common && npx tsc --noEmit -p client && npx vitest run
    node --test scripts/refactor/moveCheck.test.mjs     # not in the vitest config; 4 tests
    npm run wire:sync                                   # must say "wire dictionary is up to date."

## Results

- tsc server / common / client: clean (the client run first failed on the new textSnapshots.test.ts with 3 type errors, `config.library`/`config.dev` possibly undefined; fixed in that new test only by typing the param as `Blueprint` and using `?? {}`; snapshots unchanged, 94 pass).
- vitest full run: **135 files passed, 1304 tests passed, 1 skipped, 0 failed** (about 200 s).
- Flaky tests: none seen. All new golden tests were run twice in a row (5 files, 146 tests, both runs identical and green); moveCheck 4/4.
- Wire: PROTOCOL_VERSION = 16, PROTOCOL_WIRE_HASH = 4a951b59; wire:sync reports no change.

## Benchmarks (two runs each, run from server/, never alongside vitest)

Byte and message figures are deterministic. Timings vary run to run (net bench mean tick moved 0.341 to 0.408 ms between runs, so the 3% rule is only meaningful on the deterministic numbers, or on timings averaged over several runs).

| Bench | Run 1 | Run 2 |
|---|---|---|
| `npm run bench:net` | 3.07 KB/s total, 5.4 keyframes/s/pilot, server 0.408 ms/tick, snapshots 0.258 ms | 3.07 KB/s, 5.4 kf/s, 0.341 ms/tick, snapshots 0.212 ms |
| `npm run bench:net -- --spread` | 2.06 KB/s total, 2.4 kf/s, 0.304 ms/tick, snapshots 0.149 ms | 2.06 KB/s, 2.4 kf/s, 0.309 ms/tick, snapshots 0.148 ms |
| `npx tsx src/bench/tickBench.ts` | 10 pilots, 3600 ticks: mean 0.46 p50 0.35 p95 0.95 p99 1.61 ms; sent 21.4 KiB/s; entities live 4326 | mean 0.47 p50 0.35 p95 0.96 p99 1.64; 21.4 KiB/s; 4326 |
| `npx tsx src/bench/bulletHellBench.ts` (boss_pyreclast, 1/4/8 pilots) | mean 0.189 / 0.418 / 0.673 ms; 1-pilot net 5.78 KiB/s | mean 0.188 / 0.416 / 0.679 ms; 5.78 KiB/s |

Deterministic values to match exactly: netBench bytes and keyframe reasons (`{"Drift:pos":169,"Pilotless:pos":256,"rebuild":47,"mode":9,...}`), tickBench lod/by-type KiB/s/entity counts, bulletHell projectile peaks (149) and rows/s.
Not run: collisionBench.ts, profileBench.ts (not requested).

## Safety-net files

Regenerate any pin only deliberately, and review the diff.

| File | Pins | Regenerate |
|---|---|---|
| server/src/golden/frameHash.test.ts + frameHash.golden.json | 900-tick, 4-pilot whole-server run: running SHA-256 of frame bytes per pilot and a canonical world dump every 100 ticks, message counts, tow/dodge/gun coverage probes | `UPDATE_GOLDEN=1 npx vitest run server/src/golden/frameHash.test.ts` |
| common/src/ships/golden/flightTraces.test.ts + .golden.json (+ testData.ts helpers) | 9 scripted flight scenarios through the shared pilot step: body/charge trace hashes and final state | `UPDATE_GOLDEN=1 npx vitest run common/src/ships/golden/flightTraces.test.ts server/src/golden/parity.test.ts` |
| server/src/golden/parity.test.ts + parity.golden.json | server vs client prediction vs replica, tick by tick; where replicas need keyframes; the known float32-aim divergence (client Game.ts passes unrounded aim) | same command as above |
| server/src/golden/structure.test.ts + tickOrder.json, clientMessages.json, shipBridgeApi.json, serverMessages.json | order of `guard` names in a tick, client message cases of handleMessage, public ShipBridge API, server message cases in Game.ts. Source-text extractions fail (by design) when a switch moves; compare to the pinned list | `UPDATE_GOLDEN=1 npx vitest run server/src/golden/structure.test.ts` |
| client/src/ships/golden/textSnapshots.test.ts + __snapshots__ (92 files) | tooltip, stats rows, model-card text per model (72) and shipSummary per library/dev blueprint (20) | `UPDATE_SNAPSHOT=1 npx vitest run client/src/ships/golden/textSnapshots.test.ts` |
| scripts/refactor/moveCheck.mjs + moveCheck.test.mjs | tool: verifies functions moved between files kept identical bodies (`node scripts/refactor/moveCheck.mjs [ref] [--receivers ctx,b,s]`) | n/a |

## Rule for later stages

- Pass count must equal this baseline (1304 passed, 1 skipped, 135 files) plus the tests the stage adds; no new failures or skips.
- All golden pins unchanged (no UPDATE_GOLDEN / UPDATE_SNAPSHOT diffs) unless the stage deliberately changes behaviour and says so.
- tsc clean on all three projects; wire:sync no change (protocol 16 / 4a951b59) unless intended.
- Benchmarks: deterministic numbers identical; timings within 3% of the mean of repeated runs on the same machine.
