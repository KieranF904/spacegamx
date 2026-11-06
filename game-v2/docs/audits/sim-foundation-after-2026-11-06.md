# Sim foundation: after (2026-11-06)

The "after" numbers for the sim foundation plan, against `docs/audits/sim-foundation-baseline-2026-11-06.md`. Taken
once on Stage 3b's branch (refactor/split aa2775f, the debris fix 253ef88, Stage 3b 64f7865 and 813f2cd). Same
machine and commands as the baseline. Windows desktop, Node 26.5, with nothing else benching.

Two "before" columns are given:

- **Baseline**: the baseline doc's own numbers (refactor/split 1f4849b + Stage 0, protocol 53).
- **Pre-3b**: the same commands run on 253ef88 (Stages 1, 2 and the debris fix merged; protocol 55). This is the
  fair before for Stage 3b. The baseline bench couldn't run seven scenarios, and its crowd probes ran caps 511, not the
  full set.

## Netcode table

`cd game-v2/server && npm run bench:table` (protocol 55, caps 8388607, FakeHitsClient, 3 ticks latency each way;
wire = payload + 66 B per WebSocket message). All values are B/s except msgs/s.

| scenario | baseline payload | pre-3b payload | **after payload** | pre-3b msgs/s | **after msgs/s** | pre-3b wire | **after wire** | up (pre-3b / after) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| idle | 125 | 106 | **113** | 1.25 | **1.30** | 189 | **199** | 2 / 3 |
| cruise | 610 | 634 | **317** | 9.50 | **3.55** | 1261 | **551** | 125 / 108 |
| crowd-20 | - | 1228 | **980** | 9.63 | **8.57** | 1864 | **1545** | 139 / 137 |
| crowd-50 | - | 1209 | **958** | 9.63 | **8.00** | 1845 | **1486** | 141 / 138 |
| crowd-100 | - | 1433 | **1223** | 10.17 | **10.07** | 2104 | **1887** | 107 / 107 |
| rock-starter | 280 | 201 | **201** | 4.75 | **4.75** | 515 | **515** | 54 / 54 |
| rock-gale | 567 | 271 | **271** | 6.95 | **6.95** | 730 | **730** | 60 / 60 |
| map | 172 | 153 | **160** | 1.25 | **1.30** | 235 | **245** | 2 / 3 |
| mother | - | 1899 | **2233** | 15.15 | **15.25** | 2899 | **3239** | 618 / 620 |
| pyreclast | - | 327 | **327** | 0.75 | **0.75** | 376 | **376** | 341 / 341 |
| pirates | - | 634 | **634** | 8.35 | **8.35** | 1185 | **1185** | 683 / 683 |
| custom | - | 1180 | **1448** | 10.85 | **10.85** | 1896 | **2165** | 571 / 571 |
| reentry | 113 | 98 | **104** | 1.68 | **1.71** | 209 | **217** | 1 / 1 |

What moved:

- **cruise −50% payload, −63% messages; crowd −15 to −20%.** The server's own control rows used to go whenever the
  pilot's engines ran short of power or a boost was refused. The client now steps its stores itself, so it works out
  those bits, and the rows carry only held keys, aim and hazard bits (Replication `OWN_DERIVED_BITS`). A cruising pilot
  on boost legs was getting a control row in nearly every snapshot.
- **idle, map, reentry +6 to +7 B/s.** This is the head hash's floor: a snapshot with the head hash at least about
  once a second (`HEAD_HASH_TICKS`). It rides the frame that carries the HUD numbers, so it adds a few bytes but almost
  no messages (+0.05/s).
- **mother +18%, custom +23%.** These are corrections that the full-state hash now finds. In the Scrap Mother fight,
  something server-side keeps four of the pilot's ports and one augment buffer empty from about tick 790. The client's
  step doesn't model it. A shield taking hits from its stores is the likely cause; it isn't confirmed. Each correction
  is an own keyframe plus an `ownSync`. OwnChecks makes them at most once a second (`FIX_GAP`), so mother gets 9 in
  20 s rather than 42. Before Stage 3b the client's stores were simply wrong there and never put right.
- The rock, pirates and pyreclast rows are unchanged to the byte.

## Crowd: server tick and client CPU

`cd game-v2/server && npx tsx --tsconfig ../scripts/net/tsconfig.json src/bench/crowdBench.ts --layouts ball,cruise --out f.json`.
This is the quick mode (n 20 and 50), with bulk sockets and 4 probe clients on the full caps set (DEFAULT_CAPS) and
3 ticks latency.

The client figure is `probeClientMsPerTick`: one probe client's tick layer per tick (replicas, its own ship, hits,
contacts, bodies). It is the mean of the 4 probes.

| layout | n | server tick ms mean / p95 (pre-3b) | **after** | client ms/tick: baseline (caps 511) | pre-3b (full caps) | **after** | capable wire B/s (pre-3b / **after**) |
|---|---:|---|---|---:|---:|---:|---|
| ball | 20 | 1.37 / 3.48 | **1.50 / 4.09** | 0.237 | 0.435 | **0.450** | 2538 / **2529** |
| ball | 50 | 5.93 / 15.24 | **6.27 / 16.05** | 0.890 | 1.807 | **1.833** | 14380 / **14380** |
| cruise | 20 | 1.43 / 2.87 | **1.43 / 3.09** | 0.083 | 0.126 | **0.129** | 1881 / **1637** |
| cruise | 50 | 2.51 / 5.39 | **2.68 / 5.96** | 0.144 | 0.170 | **0.179** | 2571 / **2294** |

What moved:

- **Client CPU: +1 to +5% against pre-3b.** The probe now does what a game client does. It steps its own ship ahead
  to the current tick every tick, with the whole step (guns included), and steps it again when a snapshot moves it.
  Before, the fake client never predicted; the real client's prediction was a second step that no probe measured.
  The own ship's ahead ticks find no contact pairs, so the "pairs found once a tick" property holds.
- **The near-doubling against the baseline is the caps, not this stage.** The baseline probes ran caps 511, without
  causes, contacts, bodies or waypoints. The full set costs the same on 253ef88 as after.
- **Server tick: +0 to +9% mean, within run-to-run noise here.** The server now hashes each pilot's full state once
  per snapshot round (`SnapshotBuilder.ownNow`).
- Agreement and debris checks are identical in both runs: 0 disagreements; ball-50 has 29 other disagreements and
  21 debris offs, the same in both.

## Golden frame hash (server/src/golden/frameHash.test.ts)

The driver now sends its inputs with a target tick, as a client's do. Before, every input arrived "late", which marked
the pilot's own ship off every tick: an own row and a keyframe every round. Over all 900 ticks:

- All 9 world hashes, the probes and the faults are identical.
- WebSocket messages per pilot drop from ~311 to ~163 (−48%).
- Snapshots stay at 299-300 per pilot. Four pilots flying close with changing controls have something to say each round.

## Parity

- `server/src/golden/parity.test.ts`: server vs the client's own step, flown through `stepOwnShip` (what
  OwnTick.step runs), tick by tick, on body, charge and guns, for every script and the five firing models.
- New in the same file: a lost input's missed shots. The full-state hash finds them at the first snapshot after, and
  the server's `ownSync` (packed and unpacked as the wire carries it) puts guns and stores back exactly from there.
- `common/src/sim/a-callers.test.ts`: stepMovement, the own layer, replicaStep and stepShip agree tick by tick,
  hazards and priming in play.
- `server/src/net/own/ownSim.test.ts`: the fake client's own layer is checked against the server at every snapshot's
  head hash (full state), with 0 misses.

## Follow-up: the mother and custom corrections (2026-11-06)

Stage 3b left mother at +18% and custom at +23% against pre-3b. The full-state head hash was finding real
differences between the server and the client's own step. Found by diffing the server's `ownExtras` against the fake
client's `OwnTick` extras at every snapshot tick in the net table's own scenarios. There were three causes, and none
of them was a Scrap Mother attack or a shield.

**mother, cause 1: a heal that skipped the rebuild.** From tick 792 the server held the plasma drive, four ion drives
and one augment buffer at 0, while its own HP for those parts was full. The bench keeps the pilot alive with
`ships.scaleHp(A, 1)` once a second. That set every part's HP back to full but left the structure alone: parts that had
been shot off stayed dead in `derived.alive`, so the server flew with dead engines and never refilled their stores. The
client got the full HP through its HP check, rebuilt from it, and found the engines alive. Its step refilled them, the
hash missed, and an ownSync put them back to 0, about once a second (`FIX_GAP`).

- Fix: `bridge/damage.ts scaleHp` marks a rebuild when it brings back a part that was down, as a repair does.
- All the game's own callers use it at spawn, where nothing is down, so nothing changes for them.

**mother, cause 2: generator output from exact HP against the client's tenths.** With cause 1 fixed, one miss was
left: an augment buffer 1 unit off after a rebuild. A rebuild works out a damaged generator's output from its HP
(`healthFactor`). The server used exact HP, and the client used the HP its shipSync carried, which `hpWire` rounds to a
tenth. So the generator rates and link caps came out a hair apart, and the stores they fed drifted.

- Fix: `common/ships/tuning.ts partHealth`. Both ends now derive from the wire's tenths (`hpWire`, moved there from
  hitRules.ts, which re-exports it).

**custom: hazard ownSyncs.** custom had no head misses. Its extra bytes were ownSyncs sent for the hazards, and each one
carried the Sunspear's whole ports state (about 1.8 KB).

- Each EMP got two: one when it landed and one when it ran out. The end is no change, because the client runs the
  hazard out itself on the same tick. The server compared a key in which an EMP that had run out read as 0.
  SnapshotBuilder now carries the told hazards forward to the current tick before comparing.
- The one that is needed, the EMP landing, is now a hazards-only ownSync (`packOwnHazards`: `t` and `h`, no stores or
  guns). It is the server's decision. The ticks already flown under it come with the control row's hazard bits, and the
  client's `OwnTick` sets that tick's hazards and steps again from the next tick.
- The own-shell window is not reopened for a hazards-only sync. The wire tables are unchanged (protocol.test green). A
  protocol-56 client would choke on a hazards-only ownSync. Nothing is deployed (the deploy freeze), so no bump was
  made.

Reproduction (`net/own/ownSim.test.ts`): "its hull restored over parts it lost" (Halberd, engines shot off, then
`scaleHp`) has 0 head misses and 0 ownSyncs. Before the fix it fails. The EMP test now also expects 0 head misses, 0
full ownSyncs and exactly 1 hazards-only one. Cause 2 is pinned in `common/ships/power/ports.test.ts` "a damaged
generator on both ends": the Halberd rebuilt from exact HP and from its wire HP gives the same layout, rates and link
caps. Before the fix it fails.

In the net table, measured with the same probe as Stage 3b:

- **mother:** 123 head misses, 9 state fixes and 100 "cooling" checks before. After: 0 head misses, 0 state fixes,
  and no ownSync after the two at first sight.
- **custom:** the 2 EMP-end ownSyncs are gone, and the 2 EMP onsets are hazards-only.
- **pirates and pyreclast:** 0 head misses.

`cd game-v2/server && npm run bench:table`. Before is refactor/split bf16c1a, run from a git archive. After is this
fix. B/s except msgs/s:

| scenario | pre-3b payload | before payload | **after payload** | before msgs/s | **after msgs/s** | before wire | **after wire** | up (before / after) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mother | 1899 | 2233 | **1653** | 15.25 | **15.15** | 3239 | **2653** | 620 / 580 |
| custom | 1180 | 1448 | **1190** | 10.85 | **10.90** | 2165 | **1910** | 571 / 561 |
| pyreclast | 327 | 327 | **330** | 0.75 | **0.75** | 376 | **380** | 341 / 342 |
| pirates | 634 | 634 | **639** | 8.35 | **8.25** | 1185 | **1184** | 683 / 685 |

All other rows (idle, cruise, crowd-20/50/100, rock-starter, rock-gale, map, reentry) are unchanged to the byte.

- **mother: −26% against before, and now −13% below pre-3b.** Before Stage 3b, the client's stores there were wrong and
  were never put right. Now they are right and cost nothing.
- **custom: back to pre-3b.** The +10 B/s left is the head-hash floor.
- **pyreclast and pirates** move by a few bytes because the fights play out a little differently. Those pilots' rebuilt
  generators now make what the wire's tenths say.

## Track D: own-shell hits matched and told by one name (2026-11-06)

The Stage 4 overlay's *hit agreement* (drawn strikes of your shells against told hits for them, client
dev/predict/hitTally.ts) read 10-35 % in every mode and about 45 % on a still dummy. It was measuring the telling, not
the prediction. Causes found (reproduction: `server/src/net/hits/rebuiltHits.test.ts` on the hitsFight testkit, now with
a `pack` scenario):

1. **Hits told the old way went under the wrong name.** HitLedger.write named a projectileHit with `nameFor` after the
   snapshot's removals had let a spent own shell's shot-id name go (OwnShotLog.removed), so it went under the server's
   entity id. The client has the shell only by shot id: its drawn shell never heard of the hit (WeaponFx orphan), and
   its tick layer flew the shell on. Of the shooter's own hits: freighter shot apart 22 of 78, Helios drones 61 of 85.
   Fix: the name is taken as the hit is planned (`legacyNames`). After: 0.
2. **Every hit on a ship that rebuilt in the window was told.** Hits up to the rebuild went the old way ('rebuilt'),
   hits after were told records ('synced': the ship was synced this window; 'keyframed': its REBUILD cause). Drones
   lose a part most windows. Fix: a rebuild sync of a ship the client had, stamped with its tick (CAPS.STRUCTS), keeps
   the ship as it was before it on both sides (client `ShipStore.asOf`; server `conn.hpBefore` with StructLog's
   `derived`, `HitLedger.before`). A hit up to the rebuild is worked out on that structure and HP copy, and the sync's
   HP stands; the client finds the window's hits on each structure by tick. A REBUILD cause no longer makes a ship
   that isn't a pilot told (`net/hits/toldShips.ts`, client SelfHits.onCaused): it is hit-tested at its pose from the
   tick before, exact either side of the rebuild. Pilots keep the old rule (their pose on the rebuild's tick is
   already recentred).
3. **The breaking hit needed its number.** It deals what the part had left, which the client's tenth-rounded HP copy
   gets a hair wrong, so every one carried a d10. A record whose number rounds to the same tenth needs none now.
4. **The overlay dropped the hit point.** PredictController forwarded tally events without x, y, so a told hit with no
   shell ("orphan") could never be matched to the drawn strike nearest it.

Hit ledger counters (hitsFight testkit, both clients; `legacy` = told the old way, `told why` = reasons records were
sent instead of found):

| scenario | own hits (shooter) | found by the shooter before → after | legacy before → after | told why before → after |
|---|---:|---:|---|---|
| still freighter, 600 ticks | 80 | 78 → 78 | 0 → 0 | oldWay 4 (start-up) → same |
| freighter at 10 % HP (shot apart), 900 | 78 | 37 → 52 | rebuilt 40, view 4 → rebuilt 10 (as it died), view 4 | keyframed 30, debris 48 → debris 48 |
| freighter coasting across the fire, 600 | 80 | 56 → 76 | rebuilt 40 → 0 | synced 28, keyframed 16 → 0 |
| 3 Helios drones, 900 | 85 | 20 → 75 | rebuilt 122 → 4 (debris) | synced 94, keyframed 32 → 0 |

0 corrections (hitFix) and 0 HP mismatches in every run, before and after. What's left told on drones is the quiet
rule (a key's sum of the client's numbers rounds otherwise than the server's: its records go with d10 0) and hits on
debris.

**Overlay check** (one run, worktree dev stack, `predict-demo-steps.mjs` with TARGETS=dummy (a Halberd), netSim
100 ms + 10 ms jitter, 15 s a mode; the headless browser measured 150-250 ms pings):

| mode | agreed | drawn only | told only | on shields (left out) | agreement (totals) |
|---|---:|---:|---:|---:|---:|
| A | 90 | 1 | 1 | 4 | 98 % (was ~45 %) |
| B | 2 | 0 | 4 | 0 | too few strikes to read |
| C3 | 74 | 6 | 0 | 11 | 92.5 % (window 100 %) |

Mode B drew only 2 strikes in its 15 s, so this run doesn't settle B. Its 4 told-only fit the ordering noted at Stage 4:
the hit is told before the shell is drawn that far.

Bytes (`cd server && npm run bench:table`, before = refactor/split c2ce196, after = this track):

| scenario | before payload | **after payload** | before wire | **after wire** |
|---|---:|---:|---:|---:|
| mother | 1653 | **1612** | 2653 | **2616** |
| pirates | 639 | **619** | 1184 | **1164** |
| custom | 1190 | **1179** | 1910 | **1898** |

Every other row is the same to the byte. A record is about 3 B, against a projectileHit + damage + effects told the
old way; most derived hits now send nothing at all.

Open: crowd dilation. The server's tick and a system's tick differ there, and a rebuild sync's `at` is the system's,
so a hit's tick and `at` would be compared across clocks. Both sides make the same comparison, so it's safe, but it
may fall back to told. Mode B ordering is open too.

## Hit numbers: one rounding on both ends (2026-11-06)

What was left told on drones after Track D was the quiet rule: a key's sum (target, source, glancing) of the client's
hit numbers rounded to another tenth than the server's, so its records went with d10 0 and the server's damage
message carried the number.

**Cause.** The hit that breaks a part deals what the part had left. The server knows that exactly (say 1.84). The
client's copy of the HP is to the wire's tenth (hpWire: 1.8). Each record's own number was in the same tenth, so it
carried no d10, but the sums drifted apart. In the pack run one key summed to 3.565 on the server (3.6) and 3.525 on
the client (3.5).
On top of that both ends summed floats, so the order the hits were added in could also move a sum that sat on a .x5.

**Fix.** One scheme, the same on both ends:

1. A hit's number (common `hitRules.ts` partHit `shown`) is what the shield took, plus what got through to the hull,
   capped at the HP the part *showed* (hpWire of its HP, above its ruin floor). It depends only on the shell's amount
   and the part's HP to the tenth, and a client in step has exactly that, so both ends get the same float. The hit that
   breaks a 1.84 part shows 1.8, the HP the player saw it had. deriveShellHit returns this number. The server's HP
   maths is untouched: the part still loses its exact HP and dies, and bosses and arenas still count the exact damage.
2. Numbers are summed in fixed point (`tuning.ts` damageUnits: 1/65536ths, so the sum is an integer and the order
   doesn't matter). The sum is rounded once, to the tenth, when it's shown (damageTenths). This happens on the server
   (Outbox.addDamage / flushDamage, using a shell hit's `shown` passed through notifyDamage) and on the client
   (ConfirmedHits.messages). HitLedger compares the two sums in the same units.

The quiet rule stays as a safety net for real differences: other damage in the same sum (a blast, a burn, a hit told
the old way), a shield's records (they carry their tenths), or a client whose HP copy is off. Per-tick damage
(burns, beams, mining lasers, contact) is still summed exactly. Only its addition is fixed point.

I didn't make the HP itself whole tenths. That would round every per-tick hurt (a burn's 0.03 a tick) to nothing.

World and frame hashes, the hit-rules golden and parity tests are unchanged: no damage maths changed, only the numbers
shown. hitRules.test.ts has a new case: a view with HP to the tenth shows the server's number, breaking hits included.
rebuiltHits.test.ts now pins `quiet` at 0 on the drone pack.

Hit ledger counters (hitsFight testkit, both clients; `quiet` = records sent with d10 0):

| scenario | records | found (own) before → after | told before → after | quiet before → after |
|---|---:|---:|---:|---:|
| still freighter, 600 ticks | 160 | 156 → 156 | 4 → 4 (start-up) | 0 → 0 |
| freighter shot apart, 900 | 142 | 104 → 104 | 38 → 38 (debris) | 0 → 0 |
| freighter coasting, 600 | 160 | 156 → 156 | 4 → 4 | 0 → 0 |
| **3 Helios drones, 600** | 112 | **104 → 112** | **8 → 0** | **8 → 0** |
| **3 Helios drones, 900** | 162 | **146 → 162** | **16 → 0** | **16 → 0** |
| shielded freighter, 600 | 160 | 0 → 0 | 160 → 160 (the shield's) | 0 → 0 |

0 corrections and 0 HP mismatches throughout.

Bytes (`npm run bench:table`, before = refactor/split f242485, both run alone): mother wire 2616 → **2615**, custom
payload 1179 → **1178**. Every other row is the same to the byte. crowd-100 moves between runs with machine load
(1071-1223 on the same code), so it isn't a result. The drone fights in the benches are few, so the saving there is
small. Each quiet record was a told record (about 3 B) plus a damage message.
