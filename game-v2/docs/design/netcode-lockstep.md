# Server-paced deterministic lockstep (netcode design)

Status: **prototype**, running in the netcode lab (`prototypes/netcode-lab/`, live at https://space.brotherk3d.com/netlab/).
Nothing in the game uses it yet. This file is the spec the lab implements, the decisions taken while building it, what
the lab measured, and what is still open. Background: [the 2026-11-03 network audit](../audits/network-weapons-lockstep-2026-11-03.md),
which compared the current style with classic lockstep and rollback.

## The idea in one paragraph

The server runs the authoritative world on its own 60 Hz clock and never waits for anyone. Clients run the **same
deterministic simulation**, but only on the part of the world the server says they are aware of. What travels is
**inputs** (each stamped with the server tick it is for), **AI orders** (what each AI is after, when that changes),
**entry snapshots** when something comes into a client's awareness, and **corrections** when a client shows it has gone
wrong. A client finds out it has gone wrong because it
**reports what it saw happen** (a 2-3 byte hash per event) and, every 2 s, a 1-byte hash of each thing it tracks. Your
own ship is predicted from your own inputs and re-simulated from the last confirmed tick, so it answers at once.

## The design

### 1. Server-paced ticks
- The server ticks at 60 Hz on its own clock (tick n at start + n × 16.67 ms). It never waits for a client. A client that
  is behind only falls behind itself.
- If the server process itself stalls, it catches up at most 10 ticks a wakeup and skips ahead after a second (the
  clients' clocks follow through the pongs).

### 2. Tick-scheduled inputs
- Each client keeps an estimate of the server clock from pings (2 a second; the offset comes from the lowest-round-trip
  recent sample, slewed 3 ms at a time, jumping only when more than 60 ms out).
- An input is stamped for the tick it will arrive at: `floor(server tick now + RTT/2 in ticks) + 1 + margin`. Inputs are
  sent only when they change; a player holds its last input. A change of aim or cursor distance alone goes out at most
  every 2 ticks (30 Hz; a button change goes at once): the ship steers towards the aim and brakes on the way, so 30 Hz
  flies the same.
- An input is sent as what changed since the one before it (buttons whole, aim and distance as signed steps: a mouse
  nudge is one byte), and its stamp as a step from the last one. It has no sequence number: inputs arrive in order, so
  the server counts them.
- The server applies each input on its stamped tick. **Late** (that tick already simulated): it is applied on the next
  tick and the client is told (`LATE` record: sequence number, how many ticks late). The client raises its margin by
  that much at once.
- The server also reports, in every pong, the smallest lead (stamped tick minus its tick on arrival) since the last pong.
  After 3 s of leads of 3 ticks or more, the client lowers its margin by one. On a 10 ms link it settles at 1 tick; at
  250 ms ±60 jitter, at 2-3 ticks.

### 3. Inputs relayed, not world state
- Each tick that has something to say, the server sends each client a **bundle** stamped with that tick. A bundle holds
  the inputs used that tick by the players in that client's awareness (only those that changed), plus the other records
  below. With nothing to say, a 3-byte heartbeat goes out every 4 ticks (15 Hz). An option sends a bundle every tick.
- A gap in tick numbers therefore means "nothing changed in between": the client steps those ticks with held inputs.
- Your own input isn't echoed. You know what you sent and which tick it is stamped for, and the server uses it on that
  tick unless it arrives late, which `LATE` reports. The one other thing you need is whether it had arrived in time:
  bundles that go out anyway carry `RCV`, the count of your inputs the server had by that tick (low byte), only when it
  moved. A tick is only confirmed once a bundle for it or a later tick has arrived, and by then every late notice up to
  it has too, so for each confirmed tick the client knows exactly which of its inputs was used: the newest one counted
  in `RCV` stamped (or re-stamped by `LATE`) for that tick or before. No bundle is ever sent just for this.

### 4. Own-ship prediction
- The screen shows the confirmed world (every tick the server has sent a bundle for) run forward to "now". With own
  prediction **on**, "now" is the tick your next input would be stamped for, and your own unconfirmed inputs are applied
  at their stamped ticks. Other people hold their last confirmed input; AIs hold their last order and fly it.
- When new confirmed ticks arrive, the displayed world is rebuilt from the confirmed one: a rollback of only the
  ticks since confirmation, about one round trip plus the margin (3-4 ticks on a 10 ms link, 12-13 at 137 ms).
- With prediction **off**, the screen shows the confirmed world, extrapolated with held inputs only if bundles are late.
  You see your input one round trip plus the margin later.

### 5. No freezing
- Bundles queue on arrival. Each frame the client simulates as many confirmed ticks as have arrived, at most 30 (so a
  client that fell behind catches up at up to 30x speed). The screen keeps moving from the prediction in the meantime.
- Measured: messages held back for 500 ms put the client 29 ticks behind; it was caught up in the first frame after they
  arrived, and the screen didn't stop.

### 6. Deterministic simulation
- The lab's rules: integers only (Q16 fixed point, 16-bit binary angles), a sine table and polynomial `atan2` built from
  `+ - * /`, a Newton integer square root, and no `Math.sin/cos/atan2/sqrt/pow`.
- One RNG per entity, kept in its state, so a client holding part of the world draws the same numbers.
- A fixed order: ships by uid, shells by (fire tick, owner, gun), loot by uid. The browser and the Node server load the
  same files.
- Things that had to be added for a world that clients only partly hold:
  - **Ships come back from the dead at the end of a tick**, so nothing can see a respawned ship before the server has
    put it in everyone's awareness at its new spot.
  - **AI pilots output on the wire's grid** (aim 13 bits, distance in 4s), so the input an AI holds survives an entity
    snapshot exactly.
  - **AI pilots think at 15 Hz** (every 4 ticks, staggered by uid) and hold their output in between.

### 6a. AI: a commander on the server, a pilot everywhere (2026-11-03)
- Every AI (drone, freighter, the server's bots) is split in two. The **commander** runs on the server only and decides
  what the AI is after: its target. It can see the whole world and needn't be deterministic. It runs at the end of a
  tick; when its decision changes, that is an **order**, used from the next tick, sent to every client holding the AI
  (`ORD`: AI slot, target slot + 1, 3 bytes).
- The **pilot** runs on every copy: from the AI's own state and its target's, it makes the controls (circle the target,
  lead the aim, fire when lined up, fly a waypoint). It reads nothing else, so a client that holds an AI and its target
  flies it exactly.
- The commanders: a drone takes the nearest non-drone within 1,600 (rechecked every 2 s, or at once if its target dies
  or leaves that range); a freighter's turret the nearest drone within 900 (every second); a bot the target it was given,
  else the nearest ship within 2,500 (every 2 s).
- This replaced puppets (a pulled-in AI flown from its brain's output relayed at up to 15 Hz) and the bots' inputs
  (bots used to be players whose input the server made up, relayed like a person's).

### 7. Server-defined awareness, with interaction pull-in
- A ship or loot is in your set when it is within **1,500** units of you (view 1,200 + 300 margin). It stays until it is
  past **1,700** (no flapping at the edge). Rocks are tracked within 1,700 / 1,900.
- **Entry**: a snapshot of the entity's full state after tick T, effective from T, with its held input, its order and
  its live shells. **Exit**: at tick T, its shells go with it.
- **Pull-in (no limit, since 2026-11-03)**: each tick the server works out what each entity *needs* a client to hold
  along with it:
  - an AI needs its order's target (its pilot flies against it);
  - a ship, or a live rock, needs the shooter of every live shell whose line can still reach it (ships within radius +
    150, rocks within radius + 40); the shooter comes with its live shells;
  - a shooter needs the rocks its shells can reach (destroyed ones too), and a player the loot within 300.

  Starting from what is in your radius (and your nearby rocks), everything needed is added, then everything *that*
  needs, and so on, with no cap. A pulled-in entity stays at least 1 s. An entity enters stamped with the tick the need
  appeared, ahead of the interaction itself (a gun shell at 500 units is seen ~15 ticks before it lands), and is
  applied at that tick on the confirmed timeline, so nothing needs correcting.
- **Hits from outside** ("unseen"): if something you hold is hit by something you don't, the server knows at once
  (the target is in your set, the shooter isn't), and the correction goes in **that tick's bundle**, never
  rate-limited (held back, things inside your set react to the stale copy and the error spreads). With one hop of
  pull-in this happened about once a second around a fight at the edge; with the closure, none were seen in the runs
  below.
- **Shells that hit something you don't hold**: the server names the shell (shooter slot + shot number, 3-4 bytes,
  `GONE`) so your copy drops it too, with a kill flag for the shooter's score.

### 8. Slots
- Each tracked ship or loot gets a **slot** on entry: the lowest free one (yours is 0), varint-encoded, kept until exit.
- Freed slots are **quarantined** for `max(60 ticks, largest recent RTT + 250 ms)` before reuse.
- The server keeps 15 s of slot history per client; a report is resolved against whoever held the slot in that report's
  window.
- Non-slot ids: a **rock** is its index in the seeded field. A **shell** is (shooter slot, shot number), from the fire.
  Static objects would have a fixed id. In a report id the kind is the low 2 bits of the varint (`id × 4 + kind`): one
  byte for ids under 32, two up to 4,095.

### 9. Event reports (client to server)
- For every event the client simulates on its confirmed timeline, it sends **[kind + id][8-bit hash]** in its next
  message. Events covered: hits on ships or rocks (with damage, HP after and kill), and pickups. The hash covers the tick,
  what, by whom, the damage, the HP after and the kill. Each client message carries **ack** = its confirmed tick, and
  its reports are exactly those for ticks after its previous ack.
- The server knows which events that client should have seen in that window: those whose target and shooter (or picker)
  were both in its set at that tick, or any rock hit by a shooter in its set.
  - **Mismatch**: a report for that id, wrong hash. The server snapshots the entity and whatever it interacted with
    since that tick.
  - **Missing**: no report for it. The server snapshots the entities in its own version of the event.
  - **Spurious**: a report the server can't match. It snapshots the entity named.
- A correction already on its way, or one sent after that tick, suppresses repeats. Corrections are capped at 30 a
  second per client, and one per entity per 15 ticks ("unseen" ones excepted, see 7).

### 10. Rock overrides
- Rocks follow the seed: position, size and HP. The server keeps an override table of rocks not in their default state
  (damaged: HP; destroyed: the tick).
- A rock entering a client's set comes with its override, if any. A destruction goes to every client not already
  simulating that rock as **rock id** (the tick is the bundle's): 2-3 bytes.
- A destroyed rock comes back 90 s later. Every copy works that out from the destruction tick; nothing is sent.

### 11. Background check
- Every 120 ticks (2 s) the client sends a 1-byte hash of each tracked entity's state (a ship's includes its live
  shells), in slot order, for that exact tick. The server compares them with its own for that tick; a mismatch gets a
  correction.
- This is what catches drift that hasn't caused an event yet. It costs about 1 byte per tracked entity per 2 s.

## Wire format (as built)

All binary and little-endian; varints are LEB128.

| message / record | bytes | category |
|---|---|---|
| bundle header: type, tick (16 bits) | 3 | ticks |
| `IN` another person's changed input: type, slot × 8 + which fields changed, the changed fields (against the input that ship flew with last tick) | 3-6 (aim nudge 3) | inputs |
| `ORD` an AI's new order from the end of this tick: type, AI slot, target slot + 1 (0: none) | 3 | orders |
| `RCV` how many of your inputs the server had (low byte), on a bundle going out anyway, when it moved | 2 | inputs |
| `ENTER` type, slot, pulled flag, entity (kind byte + 4 for a bot): ship ~58 + 22 per live shell; loot 23 | ~60-130 | entries |
| `EXIT` type, slot | 2 | entries |
| `PULL` type, slot, flag (in/out of the radius; only for the page's display) | 3 | entries |
| `ROCK` rock override on entry: type, id, HP (+ 2 if destroyed) | 4-6 | entries |
| `CORR` type, slot, reason, ticks since the event, entity | ~64+ | corrections |
| `RCORR` rock correction | 7-9 | corrections |
| `RDEAD` rock destroyed: type, id | 2-3 | overrides |
| `GONE` a shell hit something you don't hold: type, shooter slot, shot number, kill | 4 | shells |
| `LATE` your input was late: type, sequence, ticks | 3 | ticks |
| up: header (type, ack, flags incl. which input fields changed) | 4 | acks |
| up: input (stamp as a step from the last, the changed fields) | 2-5 (aim nudge 2) | inputs |
| up: reports: count, then [kind + id][hash] each | 1 + 2-3 each | reports |
| up: hashes: tick, count, 1 byte per tracked entity | 3 + n | hashes |
| ping 11 / pong 22 (pong carries the server clock and the smallest input lead) | | ping |

## Measured

Message rates (msg/s) recorded before 2026-11-03's last change include the page's own info panel, 2 a second down;
its bytes were never in the payload or wire figures. It is no longer metered.

### Over the real connection (lab server on the VPS, clients on Kieran's PC, `node server/probe.js`)
A lockstep client and a current-style client fly the same scripted pattern: thrust flips every 450 ms, aim steps every
150 ms, fire bursts. They fly next to a bot fight at the lockstep client's awareness edge, plus 4 bots and the world's
drones and freighters. 15 s with own prediction on, then 15 s off, then one of each drift injected.

| | RTT 10 ms (real link) | RTT 137 ms (+60 ms each way added) |
|---|---|---|
| lockstep, own prediction **on**: thrust / turn / fire | 0 / 0 / 0 ms (plus a frame in the browser: 3-17 ms) | 0 / 0 / 0 ms |
| lockstep, own prediction **off** | 48 / 38 / 50 ms (browser: 49-61 ms) | 178 / 176 / 180 ms |
| current style (its 2-tick input delay) | 31 / 30 / 31 ms (browser: 43-53 ms); server has it after 66 ms | 35 / 34 / 36 ms; server has it after 217 ms |
| lockstep margin, late inputs | 1 tick, 2 late in 45 s | 1 tick, 0 late |
| lockstep down, payload / with headers | 2.74 / 6.7 KB/s, 64 msg/s | 2.66 / 6.6 KB/s |
| current down, payload / with headers | 7.56 / 9.0 KB/s, 24 msg/s | 5.78 / 7.2 KB/s |
| lockstep up / current up (with headers) | 0.30 (2.3) / 0.11 (0.7) KB/s | 0.23 (1.8) / 0.11 (0.7) KB/s |
| desyncs in normal play (30 s) | 37 hits from outside the set, nothing else | 8 hits from outside the set, nothing else |

Lockstep down by category (10 ms run, B/s): inputs 2,167, entries 288, ticks 180, corrections 65, ping 43, overrides
and shells ~1. Up: acks 108, reports 96, inputs 60, ping 22, hashes 18.
Current down: others 5,149, own row 1,220, shells 723, hits 234, header 140, rocks 49, ping 43.

Detection, injected drift (time from the event that shows it to the server catching it; then until your screen is
corrected):

| drift | RTT 10 ms | RTT 137 ms |
|---|---|---|
| HP off by 7 on a ship under fire | it wasn't hit again before the next hash tick: hash, corrected 1.8 s after injection | mismatch, 10 ticks (167 ms) after its next hit; corrected 203 ms after injection |
| ship moved 400 units | missing, 1 tick (17 ms); corrected 67 ms after injection | missing, 9 ticks (150 ms); 186 ms |
| ship put in front of a shell | spurious, 4 ticks (67 ms); corrected 44 ms after | spurious, 9 ticks (150 ms); 176 ms |
| quiet entity moved 1 unit (no events) | hash, 1 tick after the hash tick; corrected 785 ms after | hash, 10 ticks; 776 ms after |
| a bundle with inputs thrown away | hash, 1 tick; corrected 198 ms after (an earlier run) | hash, 10 ticks; 774 ms after |

Detection takes about one round trip after the event (the report has to come back). The silent kind waits up to 2 s
for the next hash tick.

### Headless (`node test.mjs`; one process, pretend links of 40 ms each way, 30 s after a 5 s warm-up)

| per client, B/s | down payload (wire, msg/s) | down by category | up payload (wire) |
|---|---|---|---|
| 2 players fighting, lockstep | 1,028 (4,406, 55) | inputs 614, entries 197, ticks 152, ping 44, corrections 20 | 336 (2,268): inputs 155, acks 106, reports 47, ping 22, hashes 7 |
| 2 players fighting, current | 3,806 (5,245, 24) | others 1,973, own 1,220, shells 258, header 140, hits 126, rocks 45 | 233 (1,473) |
| 8-bot fight, watched, lockstep | 2,946 (6,899, 64) | inputs 2,264, entries 376, ticks 179, corrections 79 | 298 (2,295): acks 109, reports 93, inputs 60, hashes 14 |
| 8-bot fight, watched, current | 6,412 (7,860, 24) | others 4,254, own 1,220, shells 527, hits 184, header 140 | 109 (698) |

Also checked headlessly:
- Two servers fed the same inputs stay bit-identical for 3,000 ticks.
- Three clients (40 ms; 80 ms ±10; 250 ms ±40) matched the server entity by entity on every confirmed tick for 30 s
  (over 100,000 entity-ticks, none different).
- Slot maps match the server's history on every tick, and no slot is reused inside its quarantine.
- A bot fighting at the edge is pulled in from more than 1,500 units away.
- Each drift is caught for its own reason: mismatch, missing, spurious, hash.
- A late joiner into a world with half its rocks destroyed sees no desyncs.

### Input changes (2026-11-03: no own-input echo, inputs as changes, aim at 30 Hz, cursor distance in 32s)
Lockstep, 30 s headless, mouse moving the whole time (aim and distance change every tick), W held, fire bursts; B/s of
payload for one client:

| | inputs up | inputs down | messages up / down | wire up + down |
|---|---|---|---|---|
| alone, before | 537 | 274 | 62 / 64 | 9.5 KB/s |
| alone, after | 64 | 127 | 33 / 27 | 4.4 KB/s |
| 1 other player, before | 537 | 760 | 62 / 64 | 10.0 KB/s |
| 1 other player, after | 64 | 249 | 34 / 40 | 5.5 KB/s |

Most of the wire saving is messages: with no echo, your own input changing no longer makes the server send a bundle,
so a moving mouse costs one up message every 2 ticks and nothing extra down. `node test.mjs` still shows no desyncs
other than hits from outside the set (0 in the 3-client run); the 2-player headless fight went from 975 to 601 B/s
down, the 8-bot fight from 2,009 to 1,831.

### AI orders and unlimited pull-in (2026-11-03)
Headless, one lockstep client at 40 ms each way, 30 s after a 5 s warm-up. Before = commit c279133 (puppets, bot inputs
relayed, one hop of pull-in), after = orders and the closure. "Held" is the client's set (sampled twice a second);
"world" is every ship and loot on the server.

| scenario | down payload, B/s | wire, B/s (msg/s) | held avg (pulled), max, of world | entries/s | desyncs in 30 s |
|---|---|---|---|---|---|
| 8 bots around you | 2,026 → **444** | 5,991 (62) → **2,232** (28) | 36.6 (8.8), 56 of 53 → 34.0 (12.5), 50 of 49 | 4.6 → 4.8 | 32 unseen → **0** |
| 3 bot fights at the edge + 4 bots | 1,826 → **402** | 5,777 (62) → **2,240** (29) | 34.0 (10.9), 46 of 52 → 34.9 (15.9), 56 of 48 | 4.0 → 4.3 | 38 unseen → **0** |
| 24 bots around you | 4,336 → **881** | 8,314 (62) → **3,483** (41) | 41.4 (17.9), 58 of 94 → 62.2 (33.7), 80 of 95 | 11.4 → 12.7 | 114 unseen + 1 spurious → **0** |
| 16-bot brawl 2,200 away, you still | 3,476 → **667** | 7,450 (62) → **2,876** (35) | 38.0 (16.1), 56 of 65 → 46.9 (22.5), 71 of 73 | 8.3 → 9.9 | 72 unseen → **0** |

After, by category (B/s): 8 bots around you: entries 287, ticks 78, ping 44, orders 21, inputs 13 (the RCV count).
24 bots: entries 668, ticks 116, ping 44, orders 37, inputs 13, shells 3. Before, the same runs had inputs 1,403 and
2,842 (bot and puppet inputs) and corrections 50 and 454.

- **Inputs from AIs are gone.** Orders cost 20-37 B/s for 8-24 bots plus the world's drones and freighters.
- **Unseen hits went to zero.** The last ones after the first version of the closure were all rocks hit by shooters the
  client didn't hold; adding "a live rock needs the shooters that can reach it" removed them.
- **Messages per second halved** (62 → 28-41), because AI decisions rarely change: most ticks have nothing to say.
- **The cost is a bigger set.** Unlimited pull-in holds most of a fight: with 24 bots around you the client holds 62 of
  95 entities on average (was 41), and entries rose slightly. Entries are now most of the payload. It never pulled in
  the whole world in these runs, but this is a small world; a crowded one is the test that matters.
- `node test.mjs`: the 3-client run had 0 desyncs of any kind (was 31/20/47 unseen); the 8-bot fight went from 1,831 to
  418 B/s down, the 2-player fight from 601 to 328.
- **Real link** (`node server/probe.js`, VPS, RTT 9 ms, 30 s, same script as "Measured" above): lockstep down 429 B/s
  payload, ~2,262 with headers, 29 msg/s (entries 243, ticks 80, inputs 43, ping 43, orders 17); the current style
  6,881 / ~8,327 at 22 msg/s. Before this change the same probe gave lockstep 2,740 / 6,700 at 64 msg/s. Normal play:
  1 spurious report, 0 unseen; all four injected drifts caught and corrected.
- Not measured yet: the client's CPU for the bigger set.

### Estimates for the game
- **The payload is mostly other players' inputs.** Each tracked player costs about 8 B per input change. A mouse-aiming
  human changes 15-60 times a second, so 120-480 B/s per tracked player, whatever they are doing. In the current style,
  each tracked entity costs a row every snapshot (~17-25 B at 20 Hz = 340-500 B/s) plus every shell and hit near you.
  Lockstep wins most where the current style is worst: heavy fire. Shells and hits cost nothing on the wire, because
  every copy simulates them.
- **AI costs an order when its decision changes** (3 bytes; a few a minute per AI in the lab), inside your radius or at
  the edge, plus its entry. Only the pilot half has to be deterministic and shared; the commander stays on the server.
- **Entries**: ~60-130 B each. A client flying fast through a busy area pays for every entry: about 300 B/s in these runs.
- **Corrections**: hits from outside the set, ~0.3-1.5 a second around a fight at the edge, ~65 B each.
- **Headers dominate the wire.** At 64 messages a second down and ~30 up, IP/TCP/TLS/WebSocket headers (~66 B each)
  are ~4 KB/s down and ~2 KB/s up: more than the payload. With headers the two styles cost about the same. Without the
  per-message cost (UDP / WebTransport datagrams, or coalescing ticks) lockstep is 2.5-3x cheaper.

## Decisions taken while building it (beyond the brief)
1. ~~Pulled-in AIs are puppets~~ (replaced 2026-11-03 by commander and pilot, 6a: the server decides the target, so a
   client only needs that target, not everything the AI could see).
2. **Pull-in has no limit** (2026-11-03, Kieran's call: "even if it pulled in every entity on the map it may still be
   less overhead"). It used to be one hop from the radius, with rocks and loot as leaves.
3. **Destroyed rocks on a shell's line are pulled in too.** Without this, a late joiner's shells hit rocks that are no
   longer there (23 spurious reports in 30 s in a test before the fix, none after).
4. **"Unseen" corrections go at once**, never rate-limited (see 7).
5. **`GONE` records** for shells that hit something the client doesn't hold, so a pulled-in shooter's shells don't fly
   on into things the client does hold.
6. **AI pilots at 15 Hz on the wire grid.** Earlier, when brain outputs were relayed, this cut input traffic around a
   fight by about 45%; now it only keeps the held input exact through an entity snapshot.
7. **Your own input isn't echoed** (2026-11-03; before that, a 2-byte sequence echo on every change). `RCV` on bundles
   going out anyway plus `LATE` tell the client which tick each input was used on (section 3).
8. **Bundles on change, 15 Hz heartbeat.** Quiet stretches cost 3 bytes per 4 ticks. Every tick is an option (it raises
   the message rate, not the payload).

## Open questions
1. **How big does the closure get in a crowded world?** With no limit, unseen hits are gone, but a client holds most of
   any fight it touches (62 of 95 entities with 24 bots around it). The lab's world is small; a stress test with many
   separate fights linked by long shots is still to do, along with the client CPU for the bigger set.
2. **The per-message cost.** On WebSocket/TCP/TLS the headers are bigger than the payload. Coalescing two ticks per
   message halves that and adds 8 ms. UDP or WebTransport would remove most of it.
3. **Cross-browser determinism isn't tested yet.** Node and Chrome are both V8. The lab's maths avoids
   transcendental functions, but Firefox and Safari should each be connected to the VPS lab for a while, watching the
   hash and mismatch counters.
4. **8-bit hashes** let 1 in 256 wrong events through. The 2-second state hash catches what follows. Is that window
   acceptable for damage and kills, or should a kill's report carry 16 bits?
5. **A rare spurious rock report**: about one per 90 client-seconds in the headless runs, with no entity state
   wrong. Not yet explained (probably the window or ordering of a rock hit next to a correction). It is caught and
   corrected like any other.
6. **The current game is far from this.** The audit's list stands: about 600 transcendental call sites, server-only
   collisions, damage, part loss, debris and every NPC brain (~4,600 lines) would all have to become deterministic
   and shared, and bitecs ids would have to become stable uids.
7. **Cheating and information.** Clients still only get their awareness set (no whole-system maphack). But they get
   other players' inputs at full precision, and reports are only evidence: the server stays authoritative and never
   applies a client's event.
8. **Margin policy.** It rises on each late input and falls one tick after 3 s of slack. Under bursty jitter
   (Wi-Fi), a percentile of recent leads may beat "the smallest since the last pong".
9. **Hash coverage**: rocks aren't in the 2-second hash (only their events are). A rotating slice instead of everything
   every 2 s would spread the bytes.
