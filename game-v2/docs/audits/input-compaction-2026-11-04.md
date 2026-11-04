# Compact inputs (2026-11-04)

The input package agreed with Kieran: inputs that send only what changed, send rules that add no latency, nothing sent
where the server already knows the controls, the server's input rules checked, and measured before and after. Protocol
35, behind `CAPS.INPUTS` (128): on for the dev server and dev clients (`?compact=0|1`), the base layout everywhere else
and still read by every server.

## What was there before

- **An input was 11 bytes**: type, seq (2), target tick (2), flags, aim (2, the 13-bit grid), cursor distance (2, 4-unit
  steps), flags2, then any hit report, own check and debris acks. With ~66 B of IP/TCP/TLS/WebSocket headers each, the
  headers were 6 times the payload.
- **Sent on any change** of a key, the 13-bit aim (0.044 deg) or the cursor distance (4 units). With the camera easing
  after the ship, a still mouse still moves over the world, so a pilot holding only the keys sent ~57 inputs a second.
- **Sent while berthed**: the mouse over the station's screen was aim, and its clicks were fire (the server didn't fire
  them only because the ship was inside the station).
- **The server's rules** (net/handlers/flight.ts): a late input (its tick already stepped) went on the next step and the
  client was corrected (`selfLate`); one stamped more than 64 ticks ahead was dropped; 32 at most waited; 16 at most a
  tick. Inputs were applied while berthed. A respawned ship's controls were whatever its ECS slot held.

## What was built

1. **The compact layout** (common/src/network/inputCompact.ts, tables in inputCompactTables.ts). One byte, `0x80 |` the
   groups that follow, then only those groups:

   | group | bytes | what |
   |---|---|---|
   | EXTRA | 1 | what rides along: a seq that isn't the next one, a hit report (3), an own check (3), debris acks |
   | TICK | 1 (or 3) | the target tick as the step from the last input's; absent = +1; 0 = the full low 16 bits follow |
   | KEYS | 1 | forward, backward, left, right, boost, fire left, fire right, jump |
   | MODES | 1 | strafe left, strafe right, helm, dodge |
   | AIM | 1 (or 2) | a signed step: fine (2 grid units, 0.088 deg, up to 11.2 deg) or coarse (16, 0.70 deg, up to 89 deg); both bits: the 13-bit aim itself |
   | DIST | 1 (or 3) | the cursor distance's step on its log grid (4-unit steps to 1,024, then 1/256 of the distance, to 200,000: integer steps, the same table on both ends); -128 = the grid index follows |

   No seq (implied by the socket's order). Both ends keep the last input on the socket (`InputRef`): the server's
   `InputDecoder` (one per socket, SocketTransport) reads every input, the base layout's too, and the client's
   `InputEncoder` (one per socket, NetworkManager) writes through its own decoder, so what it steps from is what the
   server has, by construction. The encoder is exact: what it can't say compactly (an off-grid distance, no target tick)
   goes in the base layout. A mouse-steer tick is 2 bytes; a key 2-3.
2. **The send rules** (client/src/app/inputCompactSend.ts), no batching, no added latency:
   - a key or fire change goes at once;
   - the aim goes once it is 16 grid units (0.70 deg) off what was sent. Why 16: mouse-steer eases in on whatever angle
     is left (common ships/flight.ts `steerSpin`, `turnGain` 0.5 in tuning.json), so a drag of 16 units a tick, the
     slowest that sends every tick, already has the ship about that far behind it; slower drags get no more lag than
     that. Probe: 8 units sent 24 inputs/s holding keys, 16 sent 13, 32 sent 7.5;
   - when the mouse stops (2 ticks without the aim changing) the exact aim goes once, so a one-pixel nudge still turns
     the ship;
   - firing or spooling a jump, every tick the aim or distance changed goes;
   - pending aim and distance ride along on anything that goes; the distance alone goes only while firing or jumping
     (only guns, mining lasers and the jump read it; the tow reads it when it takes hold);
   - a big flick goes as a coarse step and the rest the next tick (or the aim itself past 89 deg). The client predicts
     with exactly what it sent, or what the server holds.
3. **States the server already knows**: nothing is sent while berthed (`ShipClient.berthed()`; the dock let go of the
   controls) or dead (a new ship starts with none). The client's last-sent state goes the same way (berthed: every held
   key up; dead: back to a new ship's, aim 0), so the first input after is the change from there and no resync is
   needed. Clicks on the station's screen are never fire. A system change needs nothing: the controls carry on. These
   rules apply in both layouts.
4. **The server's rules** (flight.ts `handleInput`, tested in net/handlers/inputRules.test.ts): unchanged for late (the
   next step, `selfLate`: nothing stepped is rewritten) and too far ahead (more than 64 ticks: dropped; at 64 it lands on
   its tick exactly). New: berthed, inputs are dropped (their seq still taken) and whatever waited for a tick is dropped
   at the dock (Docking.handleDock); a respawned ship's controls start neutral, aim and distance 0 (`neutralInput`), and
   nothing from before waits.
5. **Control rows (downstream): not changed.** The probe shows where their bytes are: with every aim step free, the base
   layout's rows would be only 10% smaller (the row's id and first control byte are most of it, at the snapshot rate)
   and the packed rows 30% smaller (25 B/s). A scale bit for the now-even aim steps would save about one bit a step,
   ~4 B/s per observer: not worth a protocol change. They shrank anyway, from fewer control changes (below).

## Measured (scripts/net/inputProbe.ts, `npm run net:inputs`)

The probe drives the client's real input path (inputSend.ts `tickInput`, the compact rules, the client's encoder) with
a scripted mouse (eased strokes in whole pixels, still spells between) and keys, through the server's decoder into a real
GameServer, 20 s a scenario, the camera easing after the ship as Renderer's does. Down: the bytes of this pilot's
control rows to a base-format observer and a packed observer 860 units away (packed: a bit-cost model of
packedCodec `controlsIO`). Wire = payload + 66 B a message. Before = the tree at 9aaa1dc (protocol 34); after = caps
with `INPUTS`. Raw numbers: input-compaction-2026-11-04.json (before, after, and after in the base layout).

### Up (the pilot's inputs)

| scenario | inputs/s | payload B/s | wire B/s | bytes an input |
|---|---|---|---|---|
| Idle | 0 -> 0 | 0 -> 0 | 0 -> 0 | - |
| Keys only | 56.9 -> **15.3** | 625 -> **56** | 4,378 -> **1,063** (-76%) | 11 -> 3.7 |
| Mouse steering | 54.9 -> **29.6** | 604 -> **92** | 4,227 -> **2,045** (-52%) | 11 -> 3.1 |
| Fight (mouse + fire) | 55.5 -> **42.4** | 610 -> **115** | 4,270 -> **2,913** (-32%) | 11 -> 2.7 |
| Docked, mouse on the station's screen | 34.0 -> **0** | 374 -> **0** | 2,614 -> **0** (-100%) | - |

What still goes in a fight: 632 of 848 inputs in 20 s are aim changes while firing (every changed tick goes, by rule),
150 aim past the threshold or settling, 36 keys, 30 the distance alone.

### Down (this pilot's controls, to each nearby pilot)

| scenario | control changes/s | control rows, base layout B/s | control rows, packed B/s |
|---|---|---|---|
| Keys only | 56.4 -> 15.3 | 177 -> **99** (-44%) | 114 -> **59** (-48%) |
| Mouse steering | 54.1 -> 29.5 | 161 -> **110** (-32%) | 117 -> **83** (-29%) |
| Fight | 54.2 -> 40.6 | 160 -> **131** (-18%) | 111 -> **93** (-16%) |
| Docked | 0 -> 0 | 0 -> 0 | 0 -> 0 |

Per observer, so a pilot with ten others nearby saves ten times this. Its status row (cursor state, distance, charge) is
unchanged (16-69 B/s): it goes on its own schedule.

- **Parity**: in every scenario the server flew exactly the controls the client predicted for that tick (1,200 of 1,200
  ticks each, before and after).
- The base layout with the new code (caps without `INPUTS`): identical to before, except docked (0: those rules apply to
  both layouts).

## Tests

- common/src/network/inputCompact.test.ts: the first input in full then only changes; a 4,000-input seeded round trip
  with both layouts mixed in; the escapes (far, same and earlier ticks, the 16-bit wrap, coarse steps, flicks, odd aims,
  seq); the distance grid, its steps and index escape and the base-layout fallback; switching layouts mid-run; riders;
  undecodable without the last input; `planAim` (fine, coarse, a flick landing in two ticks).
- client/src/app/inputCompactSend.test.ts: a slow drag in threshold steps, the settle send, a one-pixel nudge; the
  heading lag following drags of 0.25 to 16 units a tick; every changed tick while firing; the distance only when
  firing or riding along; a flick split over two ticks and steered by what went; berthed, station clicks and dead; a
  seeded scramble where the server flies exactly what the client predicted every tick.
- client/src/app/inputSend.test.ts: berthed and the station's screen in the base layout.
- server/src/net/handlers/inputRules.test.ts: late, too far ahead, berthed, respawned, and compact inputs through a real
  server landing on their ticks with the controls sent.

## Left

- A fight still sends ~42 inputs a second: while firing every changed tick goes. Holding the aim for a tick or two while
  firing would halve it but adds latency to the guns; not done (Kieran: no added latency for now).
- The headers are now nearly all of an input's cost (66 B against ~3). Fewer messages is what's left to win, and that is
  batching ticks, which adds latency.

---

## The last two days of network work, for the dev log

Everything measured by probes on a real GameServer with fake clients; wire = payload + ~66 B of headers a message.
Sources: network-fixes-impact-2026-11-03.md, netcode-phase2-3-impact-2026-11-04.md, docs/design/packed-frames.md
(follow-ups), the own-ship commit 9aaa1dc, and this audit.

### Down: what a fighting pilot is sent (B/s)

| scenario | 2026-11-03, before the fixes | after the fixes | legacy (2026-11-04) | packed + coalesced | shooters coalesced too |
|---|---|---|---|---|---|
| Hammerhead (12 Rattlers + 6 Pips), parked target | 5,017 | 2,905 | 4,420 wire | 1,961 wire | **1,595 wire** |
| Debris-heavy (4 freighters broken up) | 7,578 | 3,697 | 6,429 wire | 3,471 wire | **2,945 wire** |
| 2 Pips | 1,236 | 835 | 2,024 wire | 1,040 wire | **874 wire** |
| Ports Heron short of drive power | 4,490 | **628** | | | |
| Gale (Sparks) | | | 5,633 wire | 2,280 wire | **1,756 wire** |
| Cruising, no fight | | | 1,046 wire | **646 wire** | 646 wire |

(The 2026-11-03 columns are payload B/s; the 2026-11-04 ones the wire estimate, headers included.)

- A far pilot in the same system: Hammerhead fight 2,192 -> 448 B/s, Spark fight 3,249 -> 570 (effects by distance).
- Shooter wire estimate down 34-60% across nine scenarios from confirmed hits, client-detected hits, bit-packing and
  coalescing; the base-format observer unchanged in every run.
- Own ship (CAPS.OWN_SIM): echoed control rows of your own ship gone (pirates fight 1,191 a minute -> 0, own keyframes
  12 -> 0 a minute; own-ship bytes 122 -> 2 B/s).

### Up: what a pilot sends (B/s, wire)

| scenario | before | after |
|---|---|---|
| Keys only | 4,378 | **1,063** (-76%) |
| Mouse steering | 4,227 | **2,045** (-52%) |
| Fight | 4,270 | **2,913** (-32%) |
| Docked | 2,614 | **0** |

And each nearby pilot is sent 16-48% less of your control rows.
