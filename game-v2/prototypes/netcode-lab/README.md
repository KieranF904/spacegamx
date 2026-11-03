# Netcode Lab

A small standalone 2D space game that runs the same ship and the same inputs under three network styles, so you can
feel and measure the input delay of each. It runs entirely in the page: a pretend server, a pretend network with
latency, jitter and loss, and two clients (you, plus a scripted second player). It has nothing to do with the game's
build and imports nothing from `client/`, `server/` or `common/`.

## Run it

Open `index.html` in a browser. It uses plain scripts, so a file:// page works and no server is needed.
If you'd rather serve it:

```
cd game-v2/prototypes/netcode-lab
python -m http.server 8090      # then open http://localhost:8090
```

Checks (no browser): `node test.mjs`. This runs every style on a fake clock, checks that the lockstep hashes agree,
that the measured delays match the settings and that an injected one-unit error is caught, and prints a table of
delay and bandwidth at 10, 40, 75 and 150 ms.

## Controls

The controls work like the game's default mouse-steer scheme:

| | |
|---|---|
| W A S D | thrust in screen directions; the ship turns towards the mouse (the game's `steerSpin`, 0.1 rad a tick at most) |
| Shift | boost (x2.2, drains a meter) |
| Left mouse | fixed gun on the nose; it swivels ±2° and fires only when the nose is on the cursor (`fixedGun.gimbalDeg`) |
| Right mouse | turret; it slews to the cursor at 0.09 rad a tick within ±90° of the nose |
| Space | both guns |
| H | helm controls: A/D turn, W/S thrust along the nose, Q/E strafe |
| 1 2 3 / 7 8 9 | left / right pane: current, lockstep, rollback |
| V, G, R | side by side, server ghost, reset |
| Wheel | zoom |

Blue is you, orange is the other player (a bot that circles you and shoots in bursts) and red are two drones (AI
inside the simulation, with slow, dodgeable shells). The other player's latency has its own slider; tick "same" to
keep it equal to yours.

## The three styles

All three run the same simulation (`sim.js`). Only who runs it, and what crosses the network, changes.

### 1. Current: server-authoritative with prediction (the game today)

* The server runs the world. You send an input only when it changes (the game's 11-byte binary input, stamped with
  the tick it is meant for). The server sends a snapshot to each client 20 times a second.
* Your own ship is predicted. Your client runs ahead of the server by the trip plus a jitter margin (the game's
  `leadTicks` formula), steps your ship at once from your input after the input delay (2 ticks, the game's
  `inputDelayTicks`), and checks each snapshot against what it predicted for that tick. If they differ, it rewinds
  to the server's state and replays your inputs. That is a correction: eased in, or a snap above 260 units.
* Other ships are drawn in the past, between snapshots, `max(80/110, rtt × 0.7 + jitter × 4 + 90)` ms behind the
  server (the game's interpolation delay).
* Your shots are predicted: they appear at once and use the same shell ids as the server's. Other people's shots
  come as fire events and are drawn on the same delayed timeline as their ships.
* Snapshots carry your ship exactly (Q16) and the others quantised. The game sends even less: control rows plus
  keyframes only when a ship goes off its predicted path. It also resends your own state only when it would have
  been wrong.

### 2. Lockstep (pure, no prediction)

* Every client runs the whole world. Only inputs travel, one per player per tick, through the server, which relays
  them and runs a copy itself.
* The input you sample at tick T is used at tick T + D by everyone, you included. A client steps a tick only once it
  has every player's input for that tick. The screen shows confirmed ticks and nothing else.
* D is set automatically from the round trips: your half of the trip, plus the other player's half (their input
  comes through the server to you), plus 2 × jitter, plus a tick. You can also set it by hand. When D changes, the
  gap is filled with your current input, or the delay comes down one tick at a time, so every player always has
  exactly one input per tick and nobody needs to agree on anything.
* If an input is late (jitter, loss, D set too low), everyone freezes. That is a stall.
* Each tick's state hash is compared across both clients and the server. A mismatch shows **DESYNC**. The
  "Inject desync" button moves your ship one unit (1/65536 of it would do) in the other player's copy, to show that
  the check works.

### 3. Rollback (GGPO style)

* Lockstep inputs, but your client runs ahead to the present by guessing the other player's missing inputs (the last
  known one, repeated). When a real input arrives that differs from the guess, it rewinds to the last confirmed tick
  and replays. Your own input applies after a small fixed delay (2 ticks by default).
* "max guess" caps how far past the confirmed tick it will guess. Beyond that it stalls, like lockstep.
* Hashes are compared on confirmed ticks only.

## What to try

* **Set 150 ms (Overseas), side by side, current vs lockstep, and try to dodge the red drone shells.** On the left
  the ship answers in about 50 ms. On the right it answers about a third of a second later, every time.
* **Same 150 ms, turn on the server ghost (G).** In the current style, the dashed outline of your ship trails your
  predicted ship by the lead (about 170 ms), and the other ships sit ahead of where they are drawn by the
  interpolation delay (about 300 ms). Those two gaps are why a shot that looked like a hit isn't one. In lockstep
  the ghost sits right on top of everything: what you see is the truth, but it is a third of a second old.
* **Rollback at 80 ms vs lockstep.** Rollback feels like the current style for your own ship. Watch the orange ship:
  the bot aims with the mouse, so its input changes almost every tick, and the guess "same as last tick" is wrong
  almost every tick. That gives about 60 rewinds a second, replaying 8 to 16 ticks each, and the ship visibly pops
  (115 units at 150 ms).
* **Add jitter 25 and loss 2%.** The current style shrugs it off: a few corrections, the lead grows. Lockstep's
  automatic D jumps to around 25 to 30 ticks (each lost packet looks like a 200 ms spike) and it still stalls: the
  game freezes for everyone whenever one packet is lost.
* **Set the lockstep delay by hand below the round trip** (e.g. 3 ticks at 80 ms). It doesn't make the game any
  quicker. The client falls behind the clock and stays there (one long STALLED, "N ticks behind"), because a tick
  can't run until the other player's input has arrived. Your input still shows about 175 ms later, the round trip,
  and any jitter now turns straight into stutter.
* **Tick rate 20.** Every style's delay grows by the tick. Lockstep's D shrinks in ticks but not in milliseconds.
* **Current input delay 0.** The current style drops to about 13 ms. In this model nothing else changes, even with
  jitter, because the lead already gets inputs to the server in time. The game's 2 ticks (33 ms) may be covering for
  something not modelled here, such as its clock estimate drifting (here the clocks are perfect).
* **Other player at 250 ms, you at 10 ms.** In the current style only your view of them suffers. In lockstep your own
  ship gets their latency too: the slowest player sets everyone's delay.

## The readouts

* **Input to screen**: from the key or mouse event (its own timestamp) to the first frame drawn from a simulation
  state that has used that input. Thrust = a movement key change, turn = the aim moving more than 6° (or A/D in
  helm), fire = a button press. It includes waiting for the next tick (half a tick on average) and for the next
  frame. "ticks" is the same time divided by the tick length.
* **Server has your input** (current style): from the event to the snapshot that shows the server has used it. Hits
  and kills can't be confirmed sooner than this.
* **Bandwidth**: the bytes of the encoded messages (each one really is encoded to a `Uint8Array` and decoded on the
  other side). "w/ headers" adds IPv4 + TCP (40) and WebSocket framing (2, or 6 with the client's mask) per
  message. TCP acks and TLS are left out.
* **Corrections / snaps / late inputs** (current), **stalls** (lockstep, rollback), **rollbacks / depth / pops /
  re-sim** (rollback), **hashes** (lockstep, rollback).

## Measured (headless Chrome, 60 Hz, scripted play, both players at the same latency, no jitter or loss)

| one-way each | current: thrust / turn / fire | current: server has it | lockstep D | lockstep: thrust / turn / fire | rollback (delay 2) |
|---|---|---|---|---|---|
| 10 ms | 51 / 51 / 48 ms | 91 ms | 3 | 67 / 66 / 65 ms | 50 ms, no rewinds |
| 40 ms | 52 / 54 / 47 ms | 150 ms | 6 | 117 / 119 / 115 ms | 51 ms, ~60 rewinds/s, pops ≤ 5 u |
| 80 ms | 51 / 49 / 50 ms | 241 ms | 11 | 206 / 208 / 199 ms | 51 ms, pops ≤ 32 u |
| 150 ms | 50 / 51 / 51 ms | 379 ms | 19 | 335 / 335 / 335 ms | 50 ms, pops ≤ 115 u |
| 80 ms, jitter 0–25, loss 2% | 58 / 54 / 55 ms | 305 ms | 28 (auto) | 482 / 488 / 479 ms, 15 stalls (1 s frozen in 12 s) | |

Lockstep delay ≈ D ticks ≈ your one-way + their one-way + margin, because inputs go through the server. With both
players at L each way, that is about the round trip (2L), not L. Peer-to-peer lockstep would be about L + L between the
two players as well, unless they are closer to each other than to the server.

Bandwidth per client (payload / with headers):

| | up | down |
|---|---|---|
| current | ~75 B/s / ~390 B/s with occasional mouse moves; ~700 B/s / ~3.4 KB/s while the mouse moves every tick (one 11-byte input per tick) | ~2.1 KB/s / ~3.0 KB/s (20 snapshots/s of ~100 bytes) |
| lockstep, rollback | ~740 B/s / ~3.6 KB/s (one 12-byte input every tick, always) | ~810 B/s / ~3.4 KB/s (the other player's inputs, relayed) |

With two players, lockstep's payload is smaller, but at 60 packets a second each way the headers make it cost about
the same as the current style. Lockstep's download grows with the number of players (one input stream each).
Snapshots grow with the number of things in view.

## How the simulation stays deterministic

* All state is integers: positions and velocities in Q16 fixed point, angles as 16-bit binary angles.
* No `Math.sin/cos/atan2/sqrt/pow`. Those are not specified tightly enough to match across browsers. Instead there
  is a 4096-entry sine table built from a Taylor series, a polynomial atan2 and a Newton integer square root. All of
  them use only `+ - * /`, which IEEE requires to round the same everywhere, and then round to integers. The physics
  for each tick rate is derived the same way (friction^k by repeated multiplication).
* A seeded xorshift RNG lives in the state (drone manoeuvres, respawn points).
* Fixed update order: ships by id, then shells in spawn order. Shell ids come from (tick, owner, gun), so a predicting
  client and the server name the same shell the same.
* The FNV hash covers every field of every ship and shell, plus the tick and the RNG.

## Simplifications (vs the game)

* One clock for everyone: clients know the server's tick exactly. The game estimates it from pongs.
* The network is a WebSocket over TCP like the game's: in order, with loss turned into a resend about one round trip
  later, and everything behind it waits (head-of-line blocking). UDP with redundant inputs isn't modelled.
* Ships are circles with no ship-to-ship collisions, no energy beyond a boost meter, and one gun of each kind.
* Snapshots are full (all ships, every snapshot). See the current style above for how the game slims them down.
* Frames show the newest tick; nothing is drawn between ticks. The game draws your ship half a tick back, between
  its last two steps.
* There is no real two-window WebSocket server. Everything is in one page, which keeps the comparison exact.

## Files

| file | what |
|---|---|
| `sim.js` | the deterministic world: fixed-point maths, flight (mouse-steer and helm), guns, turret, shells, drone AI, hash |
| `net.js` | the pretend link (latency, jitter, loss, in-order resend), byte meters, binary message codec |
| `styles.js` | the three styles (server and client for each), the bot, the delay meter, and `World` (runs it all in time order) |
| `app.js` | input recording with timestamps, drawing, readouts, controls |
| `index.html` | layout and styles |
| `test.mjs` | `node test.mjs`: determinism and style checks without a browser |
| `shots/` | screenshots |
