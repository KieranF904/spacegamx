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

## Pull fields (game-wide C3, track B)

Every pull on a pilot's ship is now part of that ship's step, on every end. A Scrap Mother's haul and intake, a Scrap
Crawler's magnet, a Hookboat's reel and a parked collapsing star are no longer sent tick by tick as `PULL` causes.

### Why the first attempt was blocked

The attempt in stage 1C had the client run the boss's move (MoveRunner) and log each pull it made, then feed those to
the pilots' steps. It hit three walls:

- **Order.** A move's pull on tick t reads the pilot after its step on t. The client runs moves on their own timeline,
  so a move could run before or after the pilot it pulls had been stepped. The two needed stepping in turn, tick by
  tick.
- **The tether.** A Hookboat's reel starts when its harpoon hits. Only the server finds that hit.
- **The star.** A collapsing star pulls from where its orb is held, and the client didn't know that point exactly.

### What was done instead

The decision and the force are now separate things.

- **The decision is a field, sent once.** A move says "I pull on the next tick", every tick it pulls
  (`MoveWork.pull` / `CustomWork.pull`, through `PullDeclarer`, common sim/pullFields.ts). A declaration that stays the
  same keeps the field open. The server sends the record when the field opens, and again only if it ends early
  (`pulls` message: `[id, from, kind, t0, t1, target, skip, ...args]`). Five shapes cover every pull: CONE (haul), LANE
  (intake), POINT (crawler), REEL (hookboat, where the tether is a field with its target) and STAR (a fixed point and
  its owner skipped).
- **The force is a pure function of state both ends hold** (`fieldPull`). It reads the puller as it ended tick t - 1
  and the pilot after its motion on tick t. That is what the server's move read before, so the arithmetic is
  unchanged. On the server, `stepMovement` passes `env.pulls`. On a client, `ShipReplicaSet` passes it into every
  pilot's step: replicas (`replicaStep`, now with the pilot's id), the own ship (`OwnTick.step`) and the dev PT layer
  (`stepAlone`). The puller comes from the replica ring at t - 1, stepped there if need be. That reading in turn is
  what lets each tick go in order without a separate scheduler.
- **Order solved by dependency, not by scheduling.** When a puller is stepped again from a tick, the ships its fields
  act on are stepped again from the next tick (`dropped` cascade). Puller poses are kept as read, so a puller that
  is removed still pulled on the ticks before it went. Pulls in a window an earlier snapshot has closed are final
  (`pullsFinal`). Without this, a boss's body stopping and its rows taking over from an old keyframe re-stepped the
  own ship 240 ticks back.
- **One arithmetic everywhere.** Every pull on a pilot is `addPull`: put on the PULL grid, then the velocity back on its
  own grid at once. It is applied after the motion and before every cause. A told `PULL` row is taken by the step's
  pull phase in place of the fields' pulls (it is a no-op among the causes after the step). The server's shadows apply
  pull rows straight after their replica step, before `pre`.

### When a pull is still told

A pull is still told as a `PULL` row in these cases. Each tick is told whole or not at all.

- **The pull is the server's alone.** A Grapple gem's moving shell, or a pull on an AI ship (that is a push, as before).
- **The client can't have the puller as the server had it.** `Replication.forClient` decides this per client:
  - the client didn't hold the puller before this snapshot, or the puller is out of its view;
  - a shadow of the puller differs from the pose the pulls read (`notePullers`, against `ServerPulls.usedAt`);
  - the puller has causes the client can't work out;
  - the puller is keyframed now, on this round's ticks.
- **A zero row.** On a tick where such a field could have pulled the ship but the server's step had no pull, a zero
  row (`[ago, 0, 0, 0]`) goes. This stops the client from working one out from the wrong place.
- **Each tick is judged once**, in the first round that covers it (`pullsJudged`). A round that sends nothing has left
  its ticks' pulls to be worked out.

### Behaviour changes (intentional)

These are why world hashes in a pull fight differ from before. The frameHash golden has no pulls, and its world
hashes are unchanged.

- A pull acts on the tick after the move decides it. The haul, intake and crawler are declared a tick early, so they
  keep their ticks. The reel starts one tick after the harpoon strikes, and a star one tick after its orb parks.
- A pull's end, when its source is lost (magnets or throat shot off, the boss gone), takes effect one tick later.
- Several pulls on one ship in a tick go in puller-id order, each rounded. A pull and a contact on the same tick now
  have the velocity rounded between them.
- An admin hidden from bosses is pulled like any pilot.

### Proof

`server/src/net/causes/pullFields.test.ts` (real GameServer, two full-caps fake clients) checks four cases. In each,
both pilots (A's own layer, A's replica of B, B's of A) and every body A runs are the server's state bit for bit at
every snapshot tick:

| case | pulls applied | told to the pilot | worked out | records |
|---|---:|---:|---:|---:|
| Mother haul + intake | 226 | 0 | 226 | 4 |
| Hookboat reel + Crawler magnet | 948 | 0 | 948 | 88 (29 fields) |
| Pullers shoved on the server alone, mid-pull | 941 | 124 | 817 | 22 |
| Collapsing star | 172 | 0 | 172 | 2 |

The shoved case drives the told path: those ticks' pulls go told and nothing goes off.

Tests re-pinned or changed:

- `structure.test`: `ShipBridge` `isPilot` and `pulls`, and the `pulls` server message.
- `scrapDarter.test`: body checks > 400 becomes > 250. The crawler's magnet no longer forces a snapshot every round:
  137 snapshots, 232 before.

The wire tables are unchanged (`wire:bump` found nothing): protocol 57. A cached 57 client would not know the `pulls`
message. Nothing is deployed (deploy freeze), so no bump was made.

### Bytes

`cd game-v2/server && npm run bench:table -- --only mother,custom,pirates,crowd-20`. Before is refactor/split c2ce196.
B/s except msgs/s:

| scenario | before payload | **after payload** | before msgs/s | **after msgs/s** | before wire | **after wire** | up (before / after) |
|---|---:|---:|---:|---:|---:|---:|---:|
| mother | 1653 | **1623** | 15.15 | **15.05** | 2653 | **2616** | 580 / 580 |
| custom | 1190 | **1164** | 10.90 | **10.75** | 1910 | **1874** | 561 / 564 |
| pirates | 639 | **621** | 8.25 | **8.45** | 1184 | **1179** | 685 / 687 |
| crowd-20 | 980 | **980** | 8.57 | **8.57** | 1545 | **1545** | 137 / 137 |

The measured pilot's own `PULL` rows over the 20 s:

- **mother:** 90 → 0, plus one record (43 B). Snapshots 307 → 297.
- **custom:** 102 → 0, plus one record (34 B). Snapshots 234 → 221.
- **pirates:** 23 → 0.

Every other count is the same or within a fight's drift: keyframes, head misses (0), fixes, hits.

These scenes pull for under 2 s in 20, so the saving is 2-3%. A fight spent in a magnet saves about 5 B per pulled
tick per pilot. It also stops the snapshot a round that each pull forced, and the PT layer's misprediction of every
pulled ship.

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

## Payout dice on a server-only secret (2026-11-06)

Kieran: clients may only work out the *odds*, which the game will show anyway. The rolls themselves come from a seed
only the server has.

**Before.** Mining's dice were seeded from the rock's entity id (`(eid * 2654435761) >>> 0`), which every client
knows. The other payout rolls drew from `mulberry32` of a constant written in the source, and kill loot shared its
generator with the AI's strafe, aim and elite rolls. A den cache's roll was seeded from `id:who:tick`.

**Now.** `server/src/game/payoutDice.ts` holds a 256-bit secret: random each boot (`crypto.getRandomValues`), or
fixed by `GameServerOptions.payoutSecret` or `PAYOUT_SECRET`. It is never sent anywhere. Each stream runs SHA-256's
compression function over the secret, the stream's name and numbers, and a counter, giving eight draws a block. The
code is plain JS because the server also runs in the browser (proto mode); a test checks it against node:crypto on
FIPS 180-4's 'abc' block. The rolls can't be worked back to the secret, and one stream's rolls say nothing of
another's. `GameServer.payout` owns it and hands it to each system.

Payout rolls moved onto it:

| where | rolls | stream |
|---|---|---|
| Mining.ts | the seam gem roll, the ore pick, the keep roll, the skill bonus roll, each chunk's size (units worked) and throw, the spill when a rock breaks | `rock`, id, registration count: each rock its own, a rock come back under the same id too |
| Enemies.ts | a kill's faction loot (chance and count, twice for elites) and each salvaged part's roll | `kill loot` |
| Bosses.ts | a boss's loot table | `boss loot` |
| Events.ts | a salvage field's pod count, goods, counts and rare find; a signal peak's pod goods and counts (their scatter stays on the events' own generator) | `event pods` |
| dens/crustCache.ts | a cracked cache's loot (its seed) | `den cache`, cache, pilot, tick |
| StationServices.ts | whether a gem cut fails | `gem cuts` |

Left as they are: rock composition and looks (`asteroidComposition`, computed on the client for looks and odds),
quest and bounty generation (offers shown before they're taken, not dice), derelict wreck shapes (seen), elite
spawns (seen, and they shape combat), loot pod scatter, and every movement or combat seed.

The rule is written in docs/areas/economy-quests.md (Invariants, "Two kinds of seed") and in common math/rng.ts. Seeds
both sides know are for anything that shapes movement, combat or visuals. The server's secret is for anything that
pays out.

Tests and benches fix the secret: vitest.config.ts sets `PAYOUT_SECRET=tests`, and netTable, customFight and
playerBot set `bench`. payoutDice.test.ts checks the SHA-256 block, that a fixed secret repeats and another differs,
that streams are independent, that no secret means a fresh one each boot, that the draws are even, and that the same
rock under another secret pays otherwise.

The world and frame hashes, parity and golden tests are unchanged, and so are the mining, bosses, dens, economy,
outliers, quests, enemies, gems, econ and bots tests (28 files).

Bytes (`npm run bench:table`, after the hit-number fix → after this): every row is the same to the byte except
these:

| scenario | payload | wire | up | why |
|---|---:|---:|---:|---|
| pirates | 619 → 1102 | 1164 → 1739 | 686 → 687 | a different fight, not more bytes per thing |
| custom | 1178 → 1154 | 1898 → 1870 | 561 → 574 | the same |
| reentry | 104 → 107 | 217 → 221 | 1 → 1 | the same |

Kill loot no longer draws from the AI's generator, so after the first kill every strafe flip and aim seed rolls
differently and the fight plays out another way. Putting the loot rolls back on `Enemies.rng` alone gives 619 / 1164
exactly. Compare pirates against this new baseline from here on.

**Found on the way (not fixed, pre-existing).** The new pirates fight produces an HP mismatch. At tick ~783 a
FakeHitsClient's copy of a Pirate Skiff's *debris* piece reads [54.6, 0, 60, 30.5] against the server's
[18.6, 0, 27.7, 30.5]: two hits on the debris never reached it. The hpCheck / hpResync safety net puts it right.
The same happens on the tree before the hit-number fix (f242485 with only the dice change), so the cause is the debris
hit path, not either change here. To reproduce: `npx tsx --tsconfig ../scripts/net/tsconfig.json
src/bench/netTable.ts --case pirates` and log ConfirmedHits.check mismatches.

That mismatch also exposed a bench bug: the up-bytes count took `.byteLength` of an hpResync, which encodes as JSON (a
string), so `up B/s` printed null. netTable counts strings by their UTF-8 length now.

## Other ships' guns stepped from their inputs (2026-11-06)

Another pilot's or an AI pilot's gunfire is now worked out on each client from the controls it holds (a pilot's control
rows plus new gun rows: triggers and cursor distance; an AI pilot's body, whose trigger rule `aiFires` moved into the
shared body). Each armed ship a client steps has a gun lane (stores and gun state) stepped beside its replica; the
server runs the same lane, tells only ticks where it differs from the real ship (fire records as before, TELL_NONE),
puts a drifted lane back (gunSync, at most once per 60 ticks), and tells point-defence shots (TELL_PD). Design and
rules: docs/areas/networking.md "Other ships' guns, stepped from their inputs".

Proof (server/src/net/guns): another pilot through every firing model (cycle cannon and pulsed laser, spinning
minigun and flak, clip turret and rail clip, charge gun and regrowing nest, coilgun cone and pulse bolts): 206 shells
built from its lane, every one the server's spawn and velocity exactly, 0 told ticks, 0 lane fixes, each lane's hash
the server lane's at the same tick (≥ 200 checks, 0 off), no told hit naming a shell the client lacked. An AI pack:
211 shells, all exact. Point defence: 41 shots told and put into the lane, 0 fixes, every lane check equal. On the PT
timeline (fake transport, 4 ticks each way): the other pilot's shells drawn on their fire tick ahead of the snapshot
for 152 of 163 (the rest a burst's first shells, which held input can't foresee), every one where the server's is;
the AI's 86 % ahead (a decision not yet told makes the rest late), none drawn wrongly left standing. World hashes are
unchanged (frameHash: streams and message counts re-pinned: gunCtl, gunSync, +1 snapshot a pilot).

Bytes (`npm run bench:table`, refactor/split 3a71b49 → after; every other row is the same to the byte):

| scenario | payload | msgs/s | wire | other ships' fire rows sent |
|---|---:|---:|---:|---:|
| pirates | 1089 → **1086** | 9.45 → **9.00** | 1713 → **1680** | 97 → **5** |

mother, custom and the crowd rows send no other ship's fire records at all at baseline (their attacks are bosses'
and custom enemies' moves, already worked out on the client; the crowd's pirates fight bots out of the measured
pilots' reach), so nothing there could drop. Before the refactor/split merge (f242485, the older pirates fight) the
same change took pirates 619 → 549 B/s and 8.25 → 7.40 msgs/s.

Crowd (`crowdBench.ts --layouts ball,cruise`, refactor/split 3a71b49 → after):

| layout | n | server tick ms mean / p95 | probe client ms/tick | capable raw B/s | bulk raw B/s |
|---|---:|---|---|---|---|
| ball | 20 | 2.34 / 6.06 → **3.46 / 8.11** | 0.838 → **1.214** | 3007 → **7749** | 3428 → **8018** |
| ball | 50 | 9.12 / 24.8 → **10.73 / 27.2** | 2.328 → **3.443** | 11917 → **26375** | 13434 → **28463** |
| cruise | 20 | 1.69 / 3.76 → **2.20 / 4.70** | 0.161 → **0.169** | 1013 → **1013** | 1966 → **1966** |
| cruise | 50 | 3.74 / 8.98 → **5.15 / 11.5** | 0.256 → **0.261** | 1663 → **1649** | 1800 → **1800** |

**The ball is a regression, and open.** Every bot there fires at a ship inside 2 km, so every client steps every
lane. In ball 20 the new bytes are gunSync 6.7 KB/s and gunCtl 3.5 KB/s (summed over the probes). Two causes:
- the bench bots write a raw cursor distance (not on the input's 4-unit grid, as a real client's is): the lane, on
  the grid, aims its turrets a hair otherwise, its hash goes off and it's put back about once a second a ship, a
  gunSync to every client. With the bots on the grid, ball 20 bulk is 5064 B/s (+48 % rather than +134 %), probe
  client 1.03 ms, server tick 2.75 ms;
- a pilot holding its cursor on a moving target changes its cursor distance every tick: a gun row event a tick a
  pilot; and every keyframe of a stepped ship costs a gunSync.

Options (Kieran's call): a coarser replicated aim distance for convergence (gameplay-visible: world hashes move), rows
that extrapolate the distance and send only misses, the distance only while a trigger is held (a burst's start told),
or keyframes not resyncing lanes. Cruise is unchanged in bytes; its server tick is +30 % from the lanes (one lane step
a pilot a tick, a second flight step for an armed pilot's stores).

### Follow-up: the ball regression (Kieran's two fixes)

1. The bench bots aim on the 4-unit cursor-distance grid real clients' inputs use (crowd/world.ts, netTable.ts bulk
   bots): bench only.
2. No gunSync on a keyframe. A ship's lane is resent only when its hash drifts (a new version), or at first sight or a
   lane start. A keyframed ship gets an empty `keep` gunSync with the start of that round's told span (`w`), and its
   client steps on from the lane state it had at the keyframe's tick.

Not chosen: the distance sent only while firing, a coarser aim distance.

Exactness tests (otherGuns, otherGunsPt) and the goldens all pass unchanged. The frameHash streams didn't move; its
pilots aren't keyframed while armed. No lane gaps. The AI on PT drew 238 of 257 ahead (was 222).

Crowd (`crowdBench.ts --layouts ball,cruise`). Before is refactor/split 3a71b49 with fix 1 applied, so the bots are the
same in both. After is ea815b8 with both fixes. The ea815b8 column is as merged, before either fix (earlier table):

| layout | n | server tick ms mean / p95 | probe client ms/tick | capable raw B/s | bulk raw B/s | bulk at ea815b8 |
|---|---:|---|---|---|---|---:|
| ball | 20 | 2.19 / 5.28 → **2.76 / 6.81** | 0.776 → **0.987** | 2988 → **4329** | 3412 → **4753** | 8018 |
| ball | 50 | 8.74 / 22.7 → **10.52 / 26.0** | 2.181 → **2.998** | 12528 → **18657** | 14251 → **20618** | 28463 |
| cruise | 20 | 1.75 / 3.84 → **2.30 / 5.27** | 0.164 → **0.167** | 1013 → **1013** | 1966 → **1966** | 1966 |
| cruise | 50 | 3.61 / 8.52 → **4.98 / 11.4** | 0.240 → **0.280** | 1663 → **1649** | 1800 → **1799** | 1800 |

gunSync is gone from the ball's byte breakdown. What's left is gunCtl: 3.6 KB/s in ball 20 and 12.9 KB/s in ball 50,
summed over the 4 probes. Every bot keeps its cursor on a moving target, so its distance changes every tick.

pirates (bench:table): 1089 → **1080** B/s, 9.45 → **9.00** msgs/s, wire 1713 → **1674**.
