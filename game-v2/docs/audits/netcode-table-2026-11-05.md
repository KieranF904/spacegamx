# The network cost table: 3 Nov, before the netcode run, now (2026-11-05)

One pilot's download in thirteen fixed scenes, measured on three builds with the same bench file
(`server/src/bench/netTable.ts`). Every cell was re-measured. None is quoted from an older audit.

- **3 Nov** is `3eeec9d` (protocol 24): the network audit commit (network-weapons-lockstep-2026-11-03.md), before any
  optimisation pass. There are no caps on that build, so the pilot is a plain socket.
- **Pre-run** is `9d59fc8` (protocol 36): the parent of `78cf555`, which started the netcode-all run
  (netcode-all-2026-11.md). The pilot is the client's tick layer with every cap that build has (511, up to BODIES).
- **Now** is `refactor/split` at `024c944` (protocol 53). The pilot announces `DEFAULT_CAPS` (1048575, every cap).

**Payload** is what the server's encoder produced for the pilot. **Wire** = payload + 66 B per WebSocket message (the
IP, TCP, TLS and WS headers the earlier audits used). All figures are B/s. Message rates are in the second table.

## The table

| Scenario | 3 Nov payload | 3 Nov wire | Pre-run payload | Pre-run wire | Now payload | Now wire | Wire, 3 Nov to now |
|---|--:|--:|--:|--:|--:|--:|--:|
| Idle in Sol (Sparrow T parked, alone) | 1,579 | 2,664 | 663 | 1,303 | 121 | 240 | -91% |
| Cruise (Sparrow T flying 24 km legs, alone) | 1,641 | 2,724 | 717 | 1,331 | 295 | 523 | -81% |
| Crowd cruise, 20 pilots | 6,293 | 7,613 | 2,514 | 3,176 | 859 | 1,405 | -82% |
| Crowd cruise, 50 pilots | 9,146 | 10,466 | 3,222 | 3,884 | 1,426 | 1,962 | -81% |
| Crowd cruise, 100 pilots | 10,313 | 11,668 | 3,868 | 4,533 | 1,655 | 2,231 | -81% |
| Starter (Sparrow T, 2 Pips) firing at a rock | 953 | 2,056 | 458 | 1,052 | 266 | 689 | -66% |
| Gale (2 Sparks, 2 Chainsaws) firing at a rock | 2,198 | 4,036 | 914 | 1,686 | 564 | 1,224 | -70% |
| System map open (idle in Sol) | 1,696 | 2,798 | 756 | 1,399 | 168 | 287 | -90% |
| Scrap Mother (Hammerhead) | 4,657 | 6,036 | 1,398 | 2,239 | 810 | 1,437 | -76% |
| Pyreclast (Hammerhead) | 3,864 | 5,243 | 1,052 | 1,818 | 1,193 | 1,813 | -65% |
| Pirates (Corsair vs two packs) | 651 | 1,929 | 378 | 1,021 | 514 | 1,023 | -47% |
| Custom enemies (Corsair vs two packs) | 1,070 | 2,351 | 800 | 1,470 | 237 | 520 | -78% |
| A ship re-entering the focus | 380 | 1,331 | 288 | 885 | 119 | 258 | -81% |

WebSocket messages a second (3 Nov / pre-run / now): idle 16.5 / 9.7 / 1.8; cruise 16.4 / 9.3 / 3.5; crowd 20 /
10.0 / 8.3, 50 20 / 10.0 / 8.1, 100 20.5 / 10.1 / 8.7; starter at a rock 16.7 / 9.0 / 6.4; Gale at a rock 27.9 /
11.7 / 10.0; map 16.7 / 9.8 / 1.8; Scrap Mother 20.9 / 12.8 / 9.5; Pyreclast 20.9 / 11.6 / 9.4; pirates 19.4 / 9.8 /
7.7; custom 19.4 / 10.2 / 4.3; re-entry 14.4 / 9.1 / 2.1. On the 3 Nov build the headers were most of the wire. Now a
quiet pilot gets about two messages a second.

Raw results, including upload, notes and the 3 Nov build's bytes by message type: `netcode-table-2026-11-05.json`.

## What changed, row by row

- **Idle**: on 3 Nov the pilot got a snapshot of everything within 40 km, 1.5 KB/s of the ambient traffic near the
  spot, 16 times a second. Pre-run: packed frames and coalescing (optimisation-before-after-2026-11-04.md). Now: the
  19 km focus grid (focus-grid-2026-11-04.md, netcode-all-2026-11.md). The client also runs AI ships, ships and debris
  on its own tick layer, so a quiet pilot gets almost nothing. Hostile packs nobody is near are ghosts and cost nothing
  (populations, `1b06041`).
- **Cruise**: as idle, plus the ships the pilot flies past. Now the focus grid drops cells behind and loads cells ahead
  (focus-grid-2026-11-04.md). Own-ship simulation (OWN_SIM) means its own row isn't echoed back.
- **Crowd cruise 20/50/100**: on 3 Nov every pilot within 40 km went as a full row, 20 times a second. Pre-run: packed
  frames, coalescing and the dev caps (crowd-baseline.md). Now: blocks, focus, causes and pilots (netcode-all-2026-11.md
  crowd tables; focus-reentry-deltas-2026-11-05.md for ships that come back into view). The cost per extra pilot fell
  more than the cost at 20.
- **Starter / Gale at a rock**: 3 Nov sent an `effect` spark and a `projectileHit` for every strike on the rock, plus a
  full row for each shell. Pre-run: confirmed and self-found hits and exact own shells (confirmed-hits-impact-2026-11-04.md,
  optimisation-before-after-2026-11-04.md). Now: no spark or `projectileHit` for a client finding its own hits, and the
  augmented flag as one bit (rock-bytes-2026-11-05.md). What is left is mostly the own fire records.
- **Map open**: the `mapDots` feed on top of idle: +117 B/s on 3 Nov, +93 pre-run, +47 now. Hostiles now go as places
  at distance tiers, once moved (populations `1b06041`; `server/src/bench/mapBench.ts` showed 248 to 13 B/s alone).
- **Scrap Mother**: on 3 Nov this was `detonation`, `damage`, `projectileHit`, boss keyframes and telegraphs. Pre-run:
  confirmed hits and BODIES decisions (decisions-2026-11-04.md). Now: causes, own status rows and own hits worked out
  on the client (boss-bytes-2026-11-05.md). Her moves' telegraphs and shots are still on the wire.
- **Pyreclast**: the same work as the Scrap Mother. Now is no lower than pre-run, but the fights differ: the pre-run
  Hammerhead was in range for 32% of ticks and now for 92%. Now fires three times as much into the same boss
  (boss-bytes-2026-11-05.md has the like-for-like split: 682 to 459 payload within refactor/split).
- **Pirates**: 3 Nov to pre-run is coalescing and packing. Now has more payload than pre-run (514 vs 378) but the same
  wire. The scene isn't like for like: hostile populations now load the nest packs near the spot (17 hostiles at the
  end now, 29 pre-run, 35 on 3 Nov). The AI pilots now go as orders (PILOTS), and the pirates' guns still send fire
  records. For a like-for-like cut, boss-bytes-2026-11-05.md has pirate fight 778 to 649 payload within refactor/split.
- **Custom enemies** (Cinder Zealot, Maw Lurker, Frost Shard, two Helios Drones, Scrap Crawler; on the two older builds
  the same ships flew the older AI): now the custom AI's decisions run on the client, with EMP and slowing as causes
  (boss-bytes-2026-11-05.md custom A/B, `customFight.ts`).
- **Re-entry**: another pilot (Wasp) spends 5 s parked 1.5 km off and 5 s 60 km away, 24 times. That takes it out of
  the 19 km focus and the old 40 km circle. Now it comes back as a keyframe plus only what changed while it was away,
  with its design remembered (focus-reentry-deltas-2026-11-05.md: 477 to 269 B per re-entry on the crowd bench). Pre-run
  it went through the dropped-cell cache. On 3 Nov it came back as a new ship.

## How the scenes are set up

- **The world:** a real `GameServer` (sectors scene, injected clock) with `Math.random` seeded. Each scenario runs in
  its own process, with a 3 s warm-up, then 20 s measured (crowd 15 s, re-entry 240 s). A rerun gives the same bytes.
- **The pilot:**
  - It flies by input messages with 3 ticks of latency each way.
  - Its hit reports, own and body checks, and debris acks ride its inputs.
  - Its frames reach its tick layer late, as a real client's would.
- **The spot:** every single-pilot scene sits at the pilot's join point + (30 km, 30 km) in Sol.
  - Rock scenes: the lone rock nearest that spot (size 50-90, no ship within 9 km), the pilot parked 350 units off it
    and firing at its centre.
  - Boss scenes: the boss is spawned 1.8 km off. The pilot holds 1.3-1.7 km off and fires inside 1.8 km.
  - Pirate and custom scenes: two packs at 1.5 km, topped up when fewer than 4 hostiles are left.
- **Keeping the pilot alive:** in fights the pilot's hull is restored once a second (`scaleHp`), the same rule on
  every build. Without it, the Pyreclast and the custom enemies kill it partway through.
- **Crowd scenes:** the crowd bench's cruise layout (`bench/crowd/world.ts`): a 12 km grid, 24 km out-and-back legs,
  the same ship pool, two pirate packs. Two pilots are measured (index 0 and n/2) and the table gives their mean. The
  rest are plain sockets whose controls go straight onto the ECS.

## Caveats

- **The world isn't the same on each build.** Ambient traffic, nests and populations, the asteroid layout and AI
  behaviour all changed between these commits. The 3 Nov build picked a different rock (size 89 against 62). Each cell
  is the same scene setup on that build's world, not the same world. That is most of the spread in the idle and
  re-entry rows on 3 Nov (1,579 B/s over 20 s idle against 380 over 240 s).
- **The fights are not like for like either.** The boss AI and arenas differ: the Hammerhead was in range for 27-51%
  of ticks on the older builds and 92-99% now. Within-branch splits by category are in boss-bytes-2026-11-05.md and
  rock-bytes-2026-11-05.md.
- **This differs from the older audits' own figures.** They used three pilots (a shooter, an observer, a far pilot)
  and parked freighters. This table uses one pilot alone, so it gives no observer column. For example, the 11-04 audit's
  3 Nov-era Scrap Mother payload was 5,372, against 4,657 here.
- **No upload columns.** Upload is in the JSON (`upBps`). In fights it is about 600-680 B/s on every build, because
  the probe sends on every aim change. Use `scripts/net/inputProbe.ts` for the real send rule.
- **No deflate.** Since BLOCKS, packed frames go undeflated, so wire is the honest figure for now. On 3 Nov,
  permessage-deflate roughly halved the payload of shell fights (optimisation-before-after-2026-11-04.md has the
  deflated columns).

## Re-running it

```
cd game-v2/server
npm run bench:table                       # every scenario, about a minute
npm run bench:table -- --only idle,mother --secs 10 --out table.json
npx tsx --tsconfig ../scripts/net/tsconfig.json src/bench/netTable.ts --case pyreclast   # one scene, one JSON line
```

The file looks up everything build-specific at run time, so the same file runs on an older tree. To run it there:

1. `git archive <commit> game-v2 | tar -x -C <dir>`
2. Link the main tree's node_modules into `<dir>/game-v2` (server, common and root; junctions, removed with rmdir
   after).
3. Write a tsconfig mapping `@space-game/common` to that tree's `common/src`.
4. Copy `netTable.ts` into its `server/src/bench`.
5. Run `npx tsx --tsconfig <that tsconfig> src/bench/netTable.ts --out <file>`.

The 3 Nov and pre-run columns here were made that way. They don't need re-running when this table is refreshed.
Refresh only the "now" column, and add a new column when a milestone lands.

## Still landing (these will move the "now" column)

- **Boss moves into shared code** (decision-inputs.md stage 4): telegraphs, move shots, `taken`/`invulnerable` and
  blow-aways run on the client from `MOVE` decisions with seeds. That should take most of what is left in the Scrap
  Mother, Pyreclast and custom enemy rows (boss-bytes-2026-11-05.md "Gaps still open": telegraphs, move-shot rows,
  hits on a staged boss).
- **Contacts on the tick layer** (decision-inputs.md 11.6 item 1): the boss's half of a contact, pulls, `contact` FX
  and contact damage are derived instead of sent. That moves the boss, pirate and custom rows.
- **Ships switching to the ports core** (energy-ports-2026-11.md): power and guns on the shared ports model changes
  what a fire record and an own-ship check carry. Expect it to move the rock and fight rows, either way.

After each one, run `npm run bench:table -- --out <file>` and replace the "now" columns, or add a dated column.
