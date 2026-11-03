# Network message catalogue (2026-11-03)

Every message the game sends, in both directions, with its size today (protocol 25, working tree) and under a proposed
compact bit-packed format. Analysis only: no game code, data or tests were changed.

- **179 message types**: 88 server -> client, 91 client -> server (`contrib` counted once; it has 7 ops).
- **14 kinds of snapshot content** (entity rows, shell rows, removals, keyframes, control rows, out-of-view, fire events).
- Companions: `network-fixes-impact-2026-11-03.md` (per-category bytes in fights), `network-weapons-lockstep-2026-11-03.md`.

## How the numbers were made

Three kinds of "today" figure. Each cell is tagged.

| tag | meaning |
|---|---|
| **(m)** | **Measured** on a real `GameServer` (working tree). Two pilots (shooter A, observer B), 10 scenarios of 20 s after a 3 s warm-up: idle, 2 Pips, Hammerhead, ports Monitor, ports Breacher, Gale (arcs + fire), Heron (beam), NPC pirates, Scrap Mother boss, 4 breaking freighters. Every frame split with `splitServerFrame`; snapshot parts sized with `encodeBinary`. Gives typical, min, max and rate. Plus a session script that sent ~55 client messages and recorded every reply. |
| **(s)** | **Synthetic.** An example with realistic values (entity ids 4244, positions 32405.3) through the real encoder: `encodeServerMessage` for server messages, `encodeMessage` for client messages (JSON text, so bytes = text length; `input` is the 11-byte binary form). |
| **(c)** | **Computed from the code** (a field list, a loop, a data file). Used when a live run was impractical. |

Other caveats on "today":
- Client messages exclude WebSocket framing (2 B header + 4 B mask each) and TCP/IP. Server frames are 2-4 B of WebSocket header, deflated when over 96 B.
- The measuring harness has no client that confirms derived debris, so debris pieces are sent the old way. Its keyframe and debris numbers run higher than in the impact report. **Fight totals and shares in the closing summary come from the impact report's probe** (with confirming clients). Per-message sizes come from either.
- My re-measure of `damage` / `projectileHit` / `shipHps` today is 13.6 / 13.0 / 14-18 B. The calibration run quoted 13.7 / 11.9 / 13.5 B. They differ by 1 B because ids and positions differ.

Scripts (throwaway, not in the repo): `C:\Users\Kieran\AppData\Local\Temp\claude\c--Users-Kieran-Desktop-Spacegame\b24c970b-6148-4883-b4f6-ab3b6971e1b5\scratchpad\catalogue\`
(`capture.ts` census, `session.ts` client-message replies, `measure.ts` / `measure2.ts` synthetic sizes, `after.mjs` bit budgets, `shares.mjs` closing table).

## The proposed format ("after")

Rules, as given, plus the assumptions I had to make.

**Frame.** All messages of a tick share one bit stream (already true server -> client). It is padded to a byte at the end (+0.5 B per frame, not counted per message). No frame-marker byte.

**Type code.** 4 bits for the 15 most frequent types, code 15 = escape + 8 bits (12 bits in all). Codes:

| 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| snapshot | damage | projectileHit | shipHps | shipSync | partDestroyed | contact | debrisSplit | detonation | ignite | effect | playerState | stationFire | intercept | death | escape |

Client -> server: 0 input, 1 ping, 2 stateHash, 15 escape.

**Slots** (per system, per entity type, announced once, adaptive width). I priced them at:

| slot | bits | note |
|---|---|---|
| ship / pilot / debris | 5 | 4 sufficed in the 2-Pip fight; 6 in a boss fight with 40+ ships |
| mob (single-body enemy) | 6 | the boss run had ~35 |
| loot pod | 5 | |
| station / portal | 4 | |
| shell | shooter slot (5) + shot counter (6) = 11 | |
| rock | seeded index, 10 | Sol has 560 rocks |
| part index | 7 | real width = ceil(log2(parts)) of that ship, which the receiver knows (Sparrow 4, hauler 7, Hammerhead 8) |

**Numbers.**
- Varints are zigzag in bits: chunk 5 (5 data + 1 continuation bit) for amounts and HP to 0.1; chunk 6 for tiny signed values.
- World position to 0.1: **21 bits per axis** (as specified). The world is +-260 km (`WORLD_SIZE`), so true absolute needs 23 bits (+0.5 B per position pair). Two ways to keep 21 or fewer:
  - effects only go to pilots within 48 km (`FX_RANGE`), so an offset from the receiver's own ship fits 20 bits;
  - mob rows only go within 12 km, so an offset from the receiver fits 18 bits.
  Both need a reference both ends agree on exactly (the last own row, rounded to 1000 units).
- Ship state (keyframes, own row) must stay **lossless**: positions 0.01, velocities 1e-4, angle 1e-5, angular velocity 1e-6 (`SHIP_PRECISION`). Prediction and replay depend on it.
- Angles 12-13 bits (aim is already 13). Booleans 1 bit. Optional fields: 1 presence bit.
- Strings: anything in a dictionary (kinds, item ids, system ids, part functions, materials, boss kinds) is a code of about 1 byte. Free text is unchanged.
- Rare UI, economy and social messages: **unchanged (rare)**, unless a cheap saving is obvious (flagged).

**"After" column honesty.** "(cal)" = calibrated: it is the measured number from re-encoding the shooter's frames of a 2-Pip fight. "(est)" = my bit count from the rules above (`after.mjs`), not measured. Bit-packed data deflates worse than byte-oriented data, so expect the real wire (deflated) to gain less than the raw numbers: the calibration run went 706 -> 383 deflated (-46%) against 855 -> 390 raw (-54%).

---

## Table 1: frequent combat and world messages

Rates are per second for one pilot, from the (m) runs. "Snapshot" means at most 20 Hz.

### 1a. What rides inside a snapshot

| message | dir | how often | must carry (ranges) | implied (receiver can work out) | bytes today | bytes after | notes |
|---|---|---|---|---|---|---|---|
| **snapshot header + frame marker** | S->C | per snapshot, 9-20/s (only sent when something changed) | tick; last processed input seq; 7 optional lists | tick = previous + 3 (20 Hz); input seq = previous + 0-7; list presence is 1 bit each | 10.6 B (7-13) (m) + 1 B marker | **2.2 B (cal)** | 22% of a 2-Pip fight (185 of 836 B/s). The tick and seq are 3-4 B varints with tags |
| **own pilot row** (entity type 1, your ship) | S->C | 0.5/s idle (safety every 120 ticks); 2-7/s in a boss fight; was 20/s on a ports ship short of power (fixed, fix 5) | x, y to 0.01 (+-260 km); vx, vy to 1e-4; angle 1e-5; angVel 1e-6; hp, maxHp (< 5000); aim + beam bits (13 + 8 + 2); charge 0-100; jump counter; shield 0-100; EMP ticks; field flags (2 bits); pool charge; prime ticks; warmth 0-100; cargo mass; one charge value per bank; gun-state tail | id, type, name (null after the first), **cursor distance (data[2]: the client sent it)**, charge-group count (from the design), jumpScale 1000 (default), maxHp when unchanged | Sparrow 54 B (m); Hammerhead / boss / NPC 60-68 B; Gale 91 B; Heron (ports ship, many charge groups) 175 B (m) | Sparrow ~28 B (est, 221 bits); Gale ~50; Heron ~95 (est: groups are packed 23-bit ints that take 5 B as varints) | 3% of a 2-Pip fight, 9% of the boss fight. maxHp, jumpScale and 8-15 zeros are repeated every time |
| **other pilot status row** (entity type 1, someone else) | S->C | 0.2-2.3/s per other pilot, whenever cursor distance / 100 or shield changes | hp, maxHp; shield % (steps of 5); EMP; mining-beam hit (tenths); weapon-beam on; mining-beam on; cursor distance / 100 (0-650); tow target; statuses (2 bits) | position and angle (replicated); hp / maxHp when unchanged | 25 B (23-25) (m) | 2.9 B for a cursor change; 4 B with shield (est) | The whole row is resent when only the cursor distance moves by 100 units. hp 300 / maxHp 300 ride along every time |
| **ship-body status row** (pilotless ship: hostile, freighter, wreck), first sight | S->C | once per ship per view; 12 in the login burst | kind (0-4), shield % (0-100), EMP, faction (0-31), rank (0-2), core % / hull % (**always sent as 0**), beam on, rating (0-255), calm, side (0-2), name | **x, y, angle: the keyframe in the same snapshot has the same values**; core / hull % (sent as 0, filled by the client from part HP) | 47-55 B with the name (m); 12 of those bytes duplicate the keyframe's pose | 4.4 B + name (est) | Later status changes (shield, EMP, beam) are ~24 B per change by the row layout (c), not seen in the runs |
| **debris status row** | S->C | once per piece, 0.1-2/s (debris-heavy) | kind marker | x, y, angle (the keyframe follows with them); the whole row is a constant `[0,0,0,-1,0,...]` | 33-35 B (m) | 1.0 B (est) | 97% duplicate. In the derived-debris path the row is skipped once confirmed |
| **mob row** (single-body enemy) | S->C | every snapshot while in 12 km: 15-63/s (boss fight) | x, y to 0.1; angle to 0.001; vx, vy to 0.1; hp, maxHp; kind index (data/mobs.json) | maxHp, kind (first row only); x, y from dead reckoning | 25.1 B (22-26) (m) | 10.0 B absolute; 7.3 B as a residual against dead reckoning (est) | 30% of the boss fight (1,586 of 5,237 B/s) |
| **loot / station / portal rows** | S->C | pod: when it appears; station and portal: once per system entry | station: 12 orbit numbers, design, name; portal: target, kind, hue | | pod 29 B; station 42-55 B (8 in the login burst); portal 17-22 B (6) (m) | unchanged (once per system) | A station row carries an orbit scale as a 9-byte float64 (`0.8519154787063599`) |
| **own shell row** (projectile, yours) | S->C | per shell you fire: 8/s (2 Pips), 30-41/s (Hammerhead, Gale, debris) | shot id; vx, vy to 0.01 (+-100); weapon type (0-30); ticks since fired (0-7); spawn x, y to 0.1; owner; optional tier, size, turret, end tick | owner (you); hue (owner * 137 % 360); spawn point (your ship's pose at that tick + muzzle) | 22.7 B (21-28) (m); 26.9 B for Gale | **10.4 B (cal)** | **17-35% of a fight** (the biggest line). A shell's flight is a straight line, so after the first row nothing more is sent |
| **other shell row** (a shell not covered by a fire event) | S->C | 0.6-4.5/s | as above | as above | 25.8 B (23-27) (m) | ~13 B (est) | Missiles carry x, y too (off the straight line) |
| **fire event** (others' shots, replicated ships) | S->C | one per shot the observer sees: 8/s (2 Pips), 21-41/s | shooter; ticks ago (0-7); part (< 245) + ammo (0-7) + augmented flag; aim step (+-4096 in 13 bits); shell id step | shell ids (consecutive); the shell itself (built from the ship pose) | 10.0 B (6-15) (m); 11-13 B in Hammerhead / Gale | 4.5 B (est: 36 bits) | The observer pays 455 B/s in the Hammerhead fight where the shooter pays 1,009 B/s for rows |
| **removed ids** | S->C | per entity that goes: 8/s (2 Pips), 41/s (Hammerhead) | the id | **for a shell: the `projectileHit` that ended it, or its range / lifetime**; for a rock, nothing (seeded) | 3.5 B per id (3.1-4.0) (m), +1 list header | **0.9 B per id (cal)**; 0 for shells (est) | In the 2-Pip fight there are 8.0 removals and 8.0 hits a second: the removal repeats what the hit said |
| **keyframe row** (ship state) | S->C | on first sight, after a rebuild, when the replica drifts: 1/s (2 Pips) to 7-17/s (Hammerhead, boss) | ship; mode (0-4); x, y 0.01; vx, vy 1e-4; angle 1e-5; angVel 1e-6; jump; jumpScale; control bits (21); aim q (13); optional cargo / dock / dodge tail | id; jump = 0, jumpScale = 1, tail (normal) | 33.1 B (23-37) (m) | 21.8 B absolute (est, 174 bits); ~15 B as a correction against the client's replica (est: assumes the error is under ~20 units) | 4-12% of fights, 23% of the NPC fight. Must stay lossless |
| **control row** (ship control changes) | S->C | per moving ship in view per snapshot: 9-19/s (2 Pips), 72/s (NPC fight) | ship; run flag; ticks ago (0-7+); control bits; aim step (+-4096) | ship id (as a step from the previous row) | 5.8 B (4-13) (m) | **3.1 B (cal)** | 11% of a 2-Pip fight, 38% of the NPC fight. The tick / bits / aim triplet is what the replica needs |
| **out of view** | S->C | when a ship leaves the view: 0.05/s | ship ids | | 4 B (m) | ~1 B (est) | rare |

### 1b. Combat and world events (each its own message)

| message | dir | how often | must carry (ranges) | implied | bytes today | bytes after | notes |
|---|---|---|---|---|---|---|---|
| **damage** | S->C | per target and source per snapshot (summed): 6/s (2 Pips), 19-31/s | target; source; amount to 0.1 (0.1-999); glancing | critical / hp / maxHp (only rocks use hp) | 12.8 B (9-15) (m) | **3.2 B (cal)** (my count 3.5) | 10% of a 2-Pip fight |
| **projectileHit** | S->C | per shell that hits: 8/s (2 Pips), 35-40/s | shell (shooter + counter); hit point to 0.1 | the shell's line | 13.0 B (fixed) (m) | **5.8 B (cal)**; 3.9 B if it sends flight time + sub-tick instead of x, y (est) | 12-18% of fights. The hit point is on the shell's own line |
| **shipHps** (batch) | S->C | per snapshot with HP changes: 5-18/s | per ship: slot; per changed part: part (< 245), HP to 0.1 (0-1000) or a fraction of max | part max HP (from the design) | 14-18 B (11-53; 135 for 4 ships x 6 parts) (m, s) | **4.8 B (cal)** | 8-9% of fights |
| **shipSync**, rebuild with design known | S->C | when a ship is rebuilt (part lost): 0.3-14/s | ship; rebuild count; changed parts: part + HP | the design (sent before) | 17-23 B (16-102) (m) | ~5.5 B (est) | 3% of the Hammerhead fight, 6% of debris-heavy |
| **shipSync**, full, design known | S->C | first sight of a ship with a design this client has | ship; design hash (13 chars); HP of every part to 0.1; detached; ghosts | max HP per part (the design) | 54 B for a 14-part ship (m) | ~18 B (est: design index 7 bits, HP as 8-bit fractions) | The 13-char hash costs 14 B; the server already tracks which designs a client has (`conn.designs`), so an index works |
| **shipSync**, first sight of a design | S->C | once per new design per client (login burst: 14 syncs, 14.5 KB) | the whole blueprint | | 512 B (14 parts) / 1,248 (36) / 2,819 (85) / 7,127 (211): **~30 B per part** (s) | ~5 B per part, positional + dictionary (est: 40 bits) | Rare, but the biggest server message. Each part is a keyed object (`uid`, `piece`, `fn`, `material`, `x`, `y`, `rot`, `flip`, `facing`) |
| **partDestroyed** | S->C | per part lost: 0.1-10/s | ship; part; how (blast / break / crumble); blast size (0-500) | **fn (it's in the design), x, y (ship pose + part cell), vx, vy (ship velocity)** | 22.4 B (21-27) (m) | 3.6 B (est) | 6% of the debris-heavy fight |
| **contact** | S->C | 0.1-1/s | point (to 0.01 today); normal; speed 0-5 | | 20.1 B (16-21) (m) | 7.8 B (est); 3.8 B if it names the two ships (est) | Today it does not say which bodies touched |
| **debrisSplit** | S->C | per ship break-up: 0.1-2/s | ship; split tick; piece ids; parts that left (runs) | | 19.3 B (15-60) (m) | 4.3 B (est) | |
| **detonation** | S->C | per burst: ~0 for plain slugs; 35/s for Gale arcs; 0.75/s boss | kind (about 25 kinds); x, y to 0.1; radius (0-500); optional `from`; optional mob kind | | 39 B (m); 41-64 B (kind string, `from`, mob) | 7.8 B; 13 B with `from` (est) | **25% of the Gale fight (1,353 B/s).** Not in COMPACT: a plain object with keys `x`, `y`, `radius` as strings |
| **ignite** | S->C | per incendiary hit: 32/s (Gale) | ship; part; ticks (150 or 180) | | **36 B for three small integers** (m) | 2.5 B (est) | **21% of the Gale fight (1,152 B/s).** Not in COMPACT: keys `bodyId`, `part`, `ticks` as strings. Putting it in COMPACT alone: 36 -> ~9 B |
| **effect** | S->C | warp, rock break, pickup, heal: 0.3-1/s | type (1-12); x, y; optional target, entity, data | rock break: x, y from the rock index | 11-22 B (16 typical) (m, s) | 2.8 B (rock break) to 6.6 B (warp) (est) | |
| **death** | S->C | per kill: 0.05-0.2/s | entity; entity type; killer | | 6-9 B (m, s) | 2.4 B (est) | |
| **stationFire** | S->C | per turret shot while hostiles are near a station: up to ~10/s | station; target; turret (0-7) | | ~7 B (s) | 2.0 B (est) | |
| **intercept** (point defence) | S->C | per interception: ~0-5/s | ship; part; shell; down | muzzle (ship pose + part), the shell's point (its line) | 70 B (s) | 3.5 B (est) | Plain object with 8 string keys and 6 coordinates |
| **playerState** | S->C | **once a second**, per pilot | hp, maxHp, boost fuel, max fuel, xp, level, credits, system | **hp / maxHp (own row), credits (profile / items), system (known)** | 17.5 B (15-19) (m) | 2.1 B when only fuel moved (est) | Mostly a copy of other messages |
| **mapDots** | S->C | once a second **while the system map is open**, only changes | per ship: id, x/10, y/10, vx, vy, wx, wy x100, thrust; routes; info; gone; names | | 78 B (5 changes); 775 B (full list of 40) (s); 754 B (m) | ~12 B per ship dot (est: 97 bits) | Rare (UI). Dots are numbers already |
| **bossTelegraph** | S->C | 0.4-1.7/s in a boss fight | shape; kind; body; offsets; angle; length; width; ticks | | 75-97 B (m) | 11.3 B (est) | 3% of the boss fight. Plain object, 9 string keys |
| **bossBeam / bossCharge / bossBlow / bossPhase / bossDefeated / bossIntro** | S->C | a few per fight | body; angles; ticks; text | | 64 / 40 / 29 / 44 / 54 / 98 B (s) | 12.4 / 3.6 / 3.0 / 2.6 B (est); intro and defeat unchanged (text) | Rare |
| **pong** | S->C | every 2 s (answer to a ping) | client time (echo); server time (ms); tick; processing | server time low 32 bits is enough | 70-73 B (m, s) | 13 B (est) | **Plain object, own frame, sent at once.** 35 B/s on an idle pilot |

### 1c. Client -> server, frequent

| message | dir | how often | must carry | implied | bytes today | bytes after | notes |
|---|---|---|---|---|---|---|---|
| **input** | C->S | whenever a key, the aim (13-bit) or the cursor distance (4-unit steps) changes: up to 60/s with the mouse moving; 0 when still | 12 key bits; aim q (13); cursor distance (0-50,000 in steps of 4: 16 bits); sequence; target tick (not in the proto) | seq (previous + 1); target tick (unused in the proto); aim and distance as steps from the last | **11 B** binary (m); +1 + 3-4 B per debris ack (21 B with 3) | ~2.4 B for a mouse move (est: 4 + 1 key-change bit + ~9 aim step + ~4 dist step) | Each input is its own WebSocket message: +6 B framing and a packet of its own. A per-tick outbox on the client would make the bit-packing real |
| **ping** | C->S | every 2 s | client time | | 42 B JSON (m) | 5 B (est) | |
| **stateHash** | C->S | **once a second** | tick; hash | tick low 16 bits | 52 B JSON (m) | 7 B (est) | 52 B/s of idle upstream. A JSON object with string keys |

---

## Table 2: everything else

Rare messages. "unchanged" = leave as is. Sizes are the full message.

### Login and session

| message | dir | when | today | after | notes |
|---|---|---|---|---|---|
| join | C->S | once | 49 B guest; 124 B with a 64-char token (s) | unchanged | |
| authLogin / authRegister | C->S | once | 68 / 100 B (s) | unchanged | |
| welcome | S->C | once per connect | 290 B (m) (62 B without the threat maps) | unchanged (rare) | `threats`: 13 systems' ratings as a keyed object; a fixed-order array would be ~15 B |
| authResult | S->C | once | 63 B (m) | unchanged | |
| profile | S->C | login; after skill, quickbar, plan changes | 263-268 B (m) | unchanged (rare) | item and plan ids are strings (no dictionary) |
| systemInfo | S->C | each system entry | 2,015 B (Sol) (m) | unchanged (rare) | Static sun / corona style numbers with long keys; the client could ship them |
| asteroidSeed | S->C | each system entry | 3,127 B (m) | ~60 B (est) | **Two lists of 400 consecutive integers** (`ids`, `indices`): a start and a count would do. Cheap saving |
| asteroidSpawn | S->C | a rock respawns | 222 B per rock (s) | unchanged (rare) | 14 keys per rock |
| news | S->C | login (this week's hunt) and broadcasts | 130 B (m) | unchanged | free text |
| codex | S->C | login (`all`), each new record | 31 B empty; ~125 B per entry (m, s) | unchanged | |
| people | S->C | login; arrival; changes | **4,021 B, sent twice at login** (m) | unchanged, but send once | 8 KB of the login burst. Static NPC records (name, title, colour, station) |
| quests | S->C | login; questSeen; dock; changes | **3,879 B** login; 3,858 on questSeen; 4,055 on dock (m) | unchanged (rare) | Resent in full on every change and on dock |
| hangar | S->C | login; job and order changes | 587 B (1 slot); 1,125-1,439 B (m) | unchanged (rare) | Embeds each slot's whole blueprint (~30 B per part) |
| error | S->C | on failure | 54 B (s) | unchanged | |
| **login burst total** | S->C | once per connect | **~35 KB in 16 frames** (m), of which: 14 shipSyncs 14.5 KB, people 8 KB, quests 3.9 KB, asteroidSeed 3.1 KB, systemInfo 2 KB | | Deflate shrinks it a lot; it is one-off |

### Station, market, economy, items

| message | dir | when | today | after | notes |
|---|---|---|---|---|---|
| stationOpen | C->S | open station window | 22 B (m) | unchanged | |
| station | S->C | station open; after every sale | 504 B; 514 B resent after each sale (m) | unchanged (rare) | Includes demand and saturation maps for every item |
| questBoard (req) / questBoard | C->S / S->C | open contracts | 21 B / **3,420 B** (m) | unchanged | |
| vendorOpen / vendors | C->S / S->C | open vendors | 21 B / 516 B (m) | unchanged | |
| marketScan | both | client asks every 20 s while it's open | 69 B / 696 B (m) | unchanged | ~38 B/s of average traffic while open |
| **items** | S->C | **every change to cargo or storage**; station open | 185 B (8 stacks); 207-299 B in the boss run (m) | ~30 B (est) | **0.55/s in the boss fight = 145 B/s, 9% of it.** Each stack is `{id, n}` with the item id as a 9-byte string. An item dictionary makes a stack ~2.8 B |
| itemMove / itemStore / itemUse / itemJettison | C->S | player action | 54 / 33 / 36 / 45 B (m, s) | unchanged | |
| marketSell / marketBuy / marketSellAll | C->S | player action | 43 / 42 / 24 B (m) | unchanged | |
| refine / craft / fabOrder / fabOrderCancel / job / gemCut / gemSocket / gemUnsocket / ammoPrefer / scrapItem / quickbarSet / restockLoadout / slotLoadout | C->S | player action | 24-55 B (m, s) | unchanged | |
| outpostCharter / outpostUpgrade / devStation | C->S | rare | ~35-50 B (c) | unchanged | |
| questAccept / questAbandon / questSeen / codexRead / skillUp / talk | C->S | player action | 20-37 B (m, s) | unchanged | |
| gained | S->C | per kill, pickup, event | 54-57 B (s) | unchanged | Items as an object keyed by item id |
| toast | S->C | notices | 43-279 B (m); the comet announcement is 127 B | unchanged | free text; 6 B/s in the fights from the comet toast alone |
| systemMessage | S->C | notices, death, arrival | 49-92 B (m, s) | unchanged | free text and a colour string |
| talk | S->C | conversation steps | 280-1,187 B (m) | unchanged | |
| wreck / repairKit / scanPulse / rebuild | S->C | rare | 16-37 / 29 / 23 / 99 B (m, s) | unchanged | |
| levelUp | S->C | level up | 34 B (s) | unchanged | **The client has no handler for it** (the level line comes as a `systemMessage`) |

### Hangar, ships, blueprints

| message | dir | when | today | after | notes |
|---|---|---|---|---|---|
| shipEdit / slotSave / designSave | C->S | saving a design | **1.4 KB (14 parts) / 3.6 KB (36) / 8.4 KB (85) / 20.9 KB (211)** JSON text (c) | ~5 B per part (70 B - 1.1 KB) (est) | **~100 B per part as JSON text**, three times the server's binary form. Cheap saving if designs are saved often |
| shipEditResult | S->C | after a save | 31 B ok; 81 B with 2 errors (s) | unchanged | |
| shipNeed | C->S | client lost a blueprint (limit 1,200 a minute) | 29 B (m) | unchanged | The reply is a shipSync (500-7,100 B) |
| dock / undock / dockResult | both | player action | 15 / 17 / 47 B (m) | unchanged | |
| slotFly / slotBuild / slotOrder / slotClear / designDelete | C->S | player action | 25-45 B (s) | unchanged | |
| respawn / tow / feedSwitch / trainingDrone | C->S | player action | 18 / 24 / 21 / 24 B (m, s) | unchanged | `tow` is handled by the Tow Beam feature |
| shareDesign / sharedDesign | C->S / S->C | share to party | blueprint JSON (see above) | unchanged | |

### Social and chat

| message | dir | when | today | after | notes |
|---|---|---|---|---|---|
| chat | C->S / S->C | per line | 64 / 98 B (m) | unchanged | free text |
| target | C->S | click a target | 27 B (s) | unchanged | |
| pilotInfo | C->S / S->C | hover another pilot | 30 / 91-113 B (m, s) | unchanged | |
| **party** | S->C | **twice a second to every member** (`Party.tick`, every 30 ticks), plus on change | 177 B (2 members) (m); 249 B (3 members) (s) | unchanged, but send on change | **~350-500 B/s per member** just for hull % and positions: 40-60% of a 2-Pip fight's bytes. Read from the code, size measured; not run for a party in flight |
| partyInvite | S->C | invite | 34 B (m) | unchanged | |
| partyInvite / partyRespond / partyLeave / partyKick / partyPromote | C->S | player action | 38 / ~37 / 21 / ~40 / ~40 B (s, c) | unchanged | |
| tradeRequest / trade / tradeOffer / tradeAccept / tradeCancel / tradeRespond | both | per trade step | 34 / 101 B down; 15-57 B up (s) | unchanged | |
| mapPing | both | player action | 68 B up / 44-56 B down (m, s) | unchanged | |
| ribbon / ribbons / rankings | S->C | earned; log opened | 31 / 718 / 284-507 B (m, s) | unchanged | |
| ops | S->C | **every 30 ticks while any operation runs**, with no change check (c) | 160+ B (s) | unchanged, but send on change | ~320 B/s while an escort / uplink runs: ~40% of a whole 2-Pip fight (836 B/s). Read from `Operations.sendViews`; not measured live |
| siegeState / objective / objectiveEnd | S->C | on change (de-duplicated by key) | 131 B objective; siegeState ~400-900 B (s, c) | unchanged | |
| worldEvent / worldEventEnd | S->C | event start / end | 104 / 21 B (s) | unchanged | |

### Contributor

| message | dir | when | today | after | notes |
|---|---|---|---|---|---|
| contrib (7 ops: overlay, list, create, update, delete, deleteMany, status) | C->S | contributor action | 45-200 B (s) | unchanged | |
| contribRank / contribNotes / contribNote / contribNoteGone / contribResult | S->C | change | 20 / ~100 per note / 111 / 27 / 37 B (s) | unchanged | |

### Admin and dev

| message | dir | when | today | after | notes |
|---|---|---|---|---|---|
| admin | C->S | command | 42 B (m) | unchanged | |
| adminStats | S->C | **once a second to every admin** | ~1,017 B with 12 players (s) | unchanged | JSON with `bytesByType` and a player list |
| adminInfo / adminAccounts / adminResult | S->C | panel open; command | adminResult 34 B (m); the lists are several KB (not measured) | unchanged | |
| devTeleport / devSpawn / devShip / devBoss / devRange | C->S | dev tools | 40-60 B (s) | unchanged | |
| rangeState | S->C | dev range, every READOUT_TICKS | 143 B per dummy (s) | unchanged | |

### In the protocol, but nothing sends or handles them

| message | dir | what |
|---|---|---|
| `inventory`, `bank`, `dialogue`, `shop`, `loot`, `shipHp`, `warp`, `asteroidDebug` | S->C | Declared in `ServerMessage`; **the server never builds them** (no `type: '...'` for them under `server/src`). The client still has a `shipHp` case |
| `pickup`, `dropItem`, `buy`, `sell`, `repair`, `refuel`, `bankDeposit`, `bankWithdraw`, `warp` | C->S | Declared in `ClientMessage`; **no server handler** (silently dropped) and the client never sends them |
| `levelUp` | S->C | Sent; the client has no handler |
| `stateHash`, `rebuild` | | Handled; fine |

---

## Surprises

1. **Plain-object messages on a hot path.** `ignite` (36 B for 3 integers), `detonation` (39-64 B), `intercept` (70 B), `bossTelegraph` (96 B), `pong` (73 B) are not in `COMPACT`, so they carry string keys (`bodyId`, `part`, `ticks`, `radius`...). Gale's `ignite` + `detonation` are **47% of its fight** (2,505 of 5,368 B/s). Moving them into `COMPACT` alone (measured with the real encoder: `ignite` 36 -> 9 B, `detonation` 39 -> 15 B, 53 -> 22 B with `from`, `intercept` 70 -> 26 B, `pong` 73 -> 22 B) takes those two from ~2,505 to ~1,050 B/s.
2. **Removals repeat the hit.** 8.0 removals and 8.0 `projectileHit` a second in the 2-Pip fight (41 and 40 in Hammerhead). A shell that hit is gone; a shell that ran out of range is gone by its lifetime. Both the client already knows.
3. **`playerState` is a copy.** hp / maxHp (own row), credits (profile, items), system (known) every second. Only boost fuel is new.
4. **A new ship's status row repeats its keyframe.** x, y, angle appear in both in the same snapshot. Debris status rows are 35 B of which ~34 B is the pose and a constant array.
5. **Other pilots' status rows resend 25 B for one changed cursor distance** (1-2 a second per pilot). hp 300 / maxHp 300 ride along each time.
6. **The own row carries data the client has.** Cursor distance came from the client's own input; maxHp, jumpScale = 1000 and 8-15 zeros are constant. 54-175 B each.
7. **Login sends `people` twice (4 KB each) and `items` twice.** `quests` (3.9 KB) goes again on `questSeen` and on dock.
8. **`ops` is resent in full twice a second** while an operation runs (read from the code).
9. **`asteroidSeed` lists 400 consecutive ids twice** (3.1 KB; two ranges would be ~60 B).
10. **Client -> server is one WebSocket message per input** (up to 60/s), plus `stateHash` (52 B) every second and `ping` (42 B) every 2 s as JSON. The "one frame per tick" saving only exists server -> client.
11. **Blueprints are ~30 B a part on the way down and ~100 B a part on the way up** (JSON text for `shipEdit` / `slotSave` / `designSave`).
12. **`party` is resent in full twice a second** to every member (positions and hull %), 177-250 B each: ~350-500 B/s a pilot in a party, whatever else is going on.
13. **Dead protocol:** 8 server types that are never built, 9 client types with no handler, `levelUp` sent into the void.

---

## Summary: where a fight's bytes go, before -> after

Raw decoded bytes per second received by the shooter. "Before" is the impact report's probe (with confirming clients), same seeded scenarios. "After" applies the per-message ratios from this document: **(cal)** ones are the measured ratios from the 2-Pip re-encode (header 0.20, own shell row 0.48, projectileHit 0.49, control row 0.54, damage 0.23, shipHps 0.36, removals 0.24); **(est)** ones use my bit counts. Computed by `shares.mjs`.

### Two Pips on a parked freighter: 836 -> ~325 B/s (-61%)

| # | message | before B/s | share | after B/s | basis |
|---|---|---|---|---|---|
| 1 | snapshot header + frame marker | 185 | 22% | 37 | cal |
| 2 | own shell rows | 182 | 22% | 87 | cal |
| 3 | projectileHit | 104 | 12% | 51 | cal |
| 4 | control rows | 96 | 11% | 52 | cal |
| 5 | damage | 82 | 10% | 19 | cal |
| 6 | shipHps | 78 | 9% | 28 | cal |
| 7 | other ships' keyframes | 35 | 4% | 23 | est |
| 8 | removed ids | 30 | 4% | 7 | cal |
| 9 | own pilot row | 27 | 3% | 13 | est |
| 10 | toast (comet) | 6 | 1% | 6 | unchanged |

### Hammerhead (12 Rattlers + 6 Pips) on a parked freighter: 2,905 -> ~1,243 B/s (-57%)

| # | message | before B/s | share | after B/s | basis |
|---|---|---|---|---|---|
| 1 | own shell rows | 1,010 | 35% | 482 | cal |
| 2 | projectileHit | 515 | 18% | 251 | cal |
| 3 | damage | 250 | 9% | 59 | cal |
| 4 | other ships' keyframes | 245 | 8% | 162 | est |
| 5 | shipHps | 240 | 8% | 85 | cal |
| 6 | snapshot header + frame marker | 207 | 7% | 43 | cal |
| 7 | removed ids | 139 | 5% | 33 | cal |
| 8 | control rows | 106 | 4% | 58 | cal |
| 9 | shipSync rebuilds | 94 | 3% | 28 | est |
| 10 | own pilot row | 30 | 1% | 14 | est |

### Where the big fights differ

| fight | before -> after B/s | what dominates before | after |
|---|---|---|---|
| 2 Sparks + 2 Chainsaws (parked) | 5,368 -> ~1,609 (-70%) | detonation 1,353 (25%), ignite 1,152 (21%), own shell rows 932 (17%) | detonation 271, ignite 96, shell rows 445 (est, est, cal) |
| Scrap Mother boss | 5,237 -> ~2,226 (-57%) | mob rows 1,586 (30%), other keyframes 602 (12%), target keyframes 582 (11%), own row 473 (9%) | mob rows 634, keyframes 397 + 384, own row 222 (est) |
| 5-7 pirates (NPC fight) | 1,202 -> ~551 (-54%) | control rows 462 (38%), keyframes 271 (23%), header 241 (20%) | 251, 179, 44 (cal, est, cal) |
| 4 breaking freighters (debris-heavy) | 3,697 -> ~1,549 (-58%) | own shell rows 757, keyframes 518, projectileHit 515, damage 388 | 361, 342, 251, 91 |

Reading it:
- **Own shell rows, projectileHit and the header are 40-55% of an ordinary fight**, and bit-packing roughly halves them. They are also the three lines with calibrated numbers.
- **After packing, the shell rows are still the largest line** (27% of the 2-Pip fight). The shooter's own shells are the only shells sent as rows; observers get fire events at 4.5 B each (est) instead of 10.4. Sending the shooter's shells as fire events too would save another ~6 B a shot (not done here, and the own ship is predicted rather than replicated, so it is a design question).
- **COMPACT-only changes (no bit packing)** would already take Gale's `ignite` + `detonation` from 2,505 to ~1,050 B/s (measured: 9 B and 15-22 B per message). Bit packing takes them to ~370.
- Add ~0.5 B per frame for byte padding (+8-10 B/s). Deflated, expect about -45% rather than -55 to -60%.

## What I could not measure

- **Estimates** (marked "est"): everything in the "after" columns except the seven calibrated lines. They follow the stated bit prices; real code would differ by a bit or two per field.
- **Own pilot row, keyframes as corrections, mob residuals:** the savings from sending corrections against the client's replica or dead reckoning depend on how far off the replica is. I did not run a client to measure that.
- **Debris keyframes and syncs:** my census had no confirming client, so the live numbers for these categories are the impact report's.
- **adminInfo, adminAccounts, contribNotes (a long list), siegeState, a party of four:** no live example; sizes are synthetic or "several KB".
- **Real-wire cost:** I measured payload bytes. Frame and TCP / TLS headers (about 50 B a packet at ~17-20 frames a second) are of the same order as a 2-Pip fight's payload; I did not measure them here.
- **`ops`, `levelUp`, dead types:** read from the code, not seen live.
