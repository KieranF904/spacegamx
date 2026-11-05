# Shooting a rock: bytes by category (2026-11-05)

Kieran, on the dev server (protocol 50, every cap on, one client), flying the dev Gale
(`data/ships/blueprints/dev/ports-gale.json`: 2 Chainsaw autocannons, 2 Arc Sparks, ports power core): standing still
and firing at an asteroid put about 2.4-2.5 kB/s on his download, and nothing visible changed. The bar: deterministic
things send no fire or hit records; a pilot shooting a rock should cost about the idle baseline plus their own control
rows.

## How it was measured

- **Probe** (scratchpad, copied into `server/src/bench` while it ran, not committed): a real `GameServer` (sectors scene,
  `Math.random` seeded, injected clock) with `netCaps` 1048575; pilot A is the crowd bench's `Probe`
  (`bench/crowd/probe.ts`: a `FakeHitsClient` with every cap, flown by input messages, 3 ticks of latency each way, its
  own and body checks riding its inputs). The ship is respawned as the Gale or the Sparrow T and parked, still, by a
  lone rock in Sol (no other ship within 9 km), aiming at its centre with both triggers held. 3 s warm-up, 20 s measured.
- **By category**: every message in A's packed frames is measured in bits as the encoder writes it (a wrapper on its
  `PackedEncoder.message`); a snapshot by its encode-once parts (`blockBits`: head, intros, status rows `e`, shell rows
  `p`, removals `r`, keyframes `k`, control rows `c`, fire records `f`, the rest `nd`), so the parts add up to the
  bytes sent but for the frame headers. **Payload** is what the encoder made; **wire** adds 66 B per WebSocket message.
- **Before** is `refactor/split` at 15a7198 (protocol 50), exported with `git archive` and run with the same probe;
  **after** is this branch (protocol 51). The scene is seeded: the bytes repeat run to run.
- Scenarios: (a) the Gale at a mid rock (size 85, 435 units off: about 40% of its shells strike), (a') the Gale close to
  a big rock (size 159, 120 off: nearly every shell strikes; Kieran's case), (b) and (b') the same with the Sparrow T,
  (c) the Gale firing into empty space, (d) the Gale idle.

## The headline (A's download)

| scenario | payload before | after | WS msgs/s before | after | wire before | after | change |
|---|--:|--:|--:|--:|--:|--:|--:|
| (a') Gale, big rock close | 1,459 | 439 | 12.75 | 9.90 | 2,300 | 1,093 | -52% |
| (a) Gale, mid rock | 978 | 464 | 11.90 | 9.95 | 1,763 | 1,121 | -36% |
| (b') Sparrow T, big rock close | 424 | 157 | 6.40 | 5.80 | 847 | 540 | -36% |
| (b) Sparrow T, mid rock | 433 | 180 | 6.20 | 5.55 | 843 | 546 | -35% |
| (c) Gale, empty space | 514 | 442 | 10.00 | 10.00 | 1,174 | 1,102 | -6% |
| (d) Gale, idle | 58 | 58 | 1.80 | 1.80 | 176 | 176 | 0 |

Every run, before and after: the own ship's tick layer agreeing with the server's on every snapshot (Gale 390-401
checks, Sparrow 149-151, none off), no own keyframes (corrections), no hit corrections. A check with a hauler parked
behind the rock (BEHIND: shells that miss the rock strike the ship) found the same 258 hits on it itself before and
after (Gale), 32 (Sparrow), with no `hitFix`: shells ended by the rock without a `projectileHit` never found a hit
behind it.

## By category (payload, B/s)

### (a') The Gale close to a big rock

| category | before | after |
|---|--:|--:|
| `effect` LaserHit: sparks on the rock, every hit, to the whole system | 768.0 | 0 |
| fire records: own volleys (34.7 a second, 16 snapshots a second carry them) | 313.1 | 242.1 |
| `projectileHit`: each shell that struck the rock | 188.0 | 0 |
| snapshot head (19.6 snapshots a second; idle 1.35) | 54.8 | 54.8 |
| removals: own shells (rock hits and life expiries) | 39.7 | 58.0 |
| own status row (the 2 s safety copy only: 0.5 a second, firing or not) | 32.1 | 32.1 |
| snapshot code, intros | 12.2 | 12.3 |
| `toast` (the comet's, once), `mapDots`, `netCaps`, `playerState` | 14.9 | 14.8 |
| packed message codes and frame ends | 36.1 | 25.2 |
| **payload** | **1,459** | **439** |
| WebSocket messages/s | 12.75 | 9.90 |
| **wire** | **2,300** | **1,093** |

### (a) The Gale, mid rock

| category | before | after |
|---|--:|--:|
| `effect` LaserHit | 376.7 | 0 |
| fire records: own volleys | 313.1 | 241.4 |
| `projectileHit` | 83.5 | 0 |
| snapshot head | 54.6 | 54.6 |
| removals | 37.9 | 63.4 |
| own status row | 30.9 | 30.9 |
| `mapDots` (ships beyond view) | 27.1 | 27.1 |
| snapshot code, intros | 12.4 | 12.4 |
| `toast`, `netCaps`, `playerState` | 9.4 | 9.4 |
| packed message codes and frame ends | 32.4 | 25.2 |
| **payload** | **978** | **464** |
| WebSocket messages/s | 11.90 | 9.95 |
| **wire** | **1,763** | **1,121** |

### (b') and (b) The Sparrow T

| category | big rock before | after | mid rock before | after |
|---|--:|--:|--:|--:|
| `effect` LaserHit | 217.8 | 0 | 212.2 | 0 |
| fire records: own volleys (8 a second) | 56.5 | 57.5 | 56.5 | 57.5 |
| `projectileHit` | 52.3 | 0 | 46.9 | 0 |
| snapshot head | 24.6 | 24.7 | 23.0 | 23.0 |
| own status row | 16.2 | 16.2 | 15.0 | 15.0 |
| `profile` (once, at the respawn) | 13.4 | 13.4 | 13.4 | 13.4 |
| removals | 7.4 | 12.2 | 3.1 | 12.2 |
| `mapDots` | 5.4 | 5.4 | 33.0 | 32.7 |
| the rest (`toast`, code, intros, `playerState`, `netCaps`) | 14.7 | 14.7 | 14.7 | 14.6 |
| packed message codes and frame ends | 15.8 | 12.6 | 15.6 | 11.7 |
| **payload** | **424** | **157** | **433** | **180** |
| WebSocket messages/s | 6.40 | 5.80 | 6.20 | 5.55 |
| **wire** | **847** | **540** | **843** | **546** |

### (c) The Gale into empty space, (d) idle

| category | (c) before | after | (d) before | after |
|---|--:|--:|--:|--:|
| fire records: own volleys | 312.2 | 240.7 | 0 | 0 |
| removals: own shells at the end of their life | 60.5 | 60.5 | 0 | 0 |
| snapshot head | 54.9 | 54.9 | 4.8 | 4.8 |
| own status row | 30.1 | 30.1 | 14.6 | 14.6 |
| snapshot code, intros, `nd` (decisions), keyframes | 18.1 | 18.1 | 10.1 | 10.1 |
| `toast`, `mapDots`, `netCaps`, `playerState`, `cells` | 12.7 | 12.7 | 24.5 | 24.5 |
| packed message codes and frame ends | 25.5 | 25.4 | 3.6 | 3.6 |
| **payload** | **514** | **442** | **58** | **58** |
| WebSocket messages/s | 10.00 | 10.00 | 1.80 | 1.80 |
| **wire** | **1,174** | **1,102** | **176** | **176** |

## Root causes, and what was done

1. **A spark effect for every shell that struck a rock, to everyone in the system** (`GameServer.hurtAsteroid`:
   `effect` LaserHit with the rock, the point and the damage, ~28 B packed, through `broadcastToSystem`, so not even
   limited to clients near it). Pure cosmetics the client already had the means to draw: every drawn shell stops at the
   first drawn surface it touches, rocks included (`WeaponFx.touch`, ships/drawnHit.ts). Now `WeaponFx.onStruck` says
   what the shell struck as drawn, and `ShipClient.struckFx` throws the same sparks (`Renderer.showEffect` LaserHit,
   sized by the shell's gun damage) when it was a rock. The effect goes only for a stuck mining charge blowing (no shell
   is seen striking then). 768 B/s in Kieran's case; also every other pilot mining in the same system paid it.
2. **A `projectileHit` for every shell that struck a rock** (~7 B each). For a client finding its own hits
   (`CAPS.SELF_HITS`) it's redundant: its drawn shell stops at the drawn rock by itself, and on its tick layer the
   snapshot's `removed` list ends the shell (a removed shell sits its last window out in SelfHits; the server tells any
   hit in that window, HitLedger `removing`). It now goes only to clients without SELF_HITS, and for a stuck charge to
   everyone; such a client plays the hit sound from the drawn strike (`struckFx`). The removal list gets a little dearer
   without the id just named (removals +18-25 B/s in the Gale's runs), well under what the messages cost.
3. **The augmented flag in fire records** (packed encode-once fire block, `blocks.ts fireBody`): the part field is
   `part + 256 × ammo + 65536` for a ports ship's augmented shot, and as one number the 65536 took three more varint
   chunks: 25 bits for "part 2". Nearly every shot a Gale fires is augmented. It is now a bit of its own ahead of the
   part: 313 -> 241 B/s for the Gale; one bit more per record for a ship that isn't augmented (Sparrow 56.5 -> 57.5).
   The wire hash now covers a fire block too (`wireHash.ts`), so a change there bumps the protocol: 51.

Suspects ruled out: Arc Sparks fire straight shells sent as fire records like the cannons' (no beam or arc rows, no
`detonation` against a rock); no own shells went as rows (`p` 0); a rock's HP and cracks are never sent; no chunk was
thrown in 20 s (the Sparrow mined 6 units of a Sol rock, the Gale's augmented autocannon about none: guns only chip it)
and mining's own messages are already batched (XP once a second, warnings once in 6 s); the own status row goes only
as its 2 s safety copy, firing or idle (energy isn't in its key); the HUD (`playerState`) is once a second either way.

## What remains, and why

Firing still costs the Gale about 900 B/s of wire over idle, the Sparrow about 360. All of it is the pilot's own
volleys and what they drive:

| what | Gale (a') | Sparrow (b') | why it is still sent | what closes it |
|---|--:|--:|---|---|
| fire records: own volleys | 242 | 58 | Whether a gun fires on a tick is the server's gun state (energy and the ports core's augment, the Chainsaw's spin, clips, charge, ammunition from the hold), which the client's tick layer doesn't hold exactly (its prediction does, roughly, with corrections); and a record names the shells' server entity ids (bitecs recycles them), which hit records, removals, the hit chain's hash and the client's reports all use | own guns on the tick layer: `stepGuns` and the power tick on the confirmed own ship, bit-exact, with the gun and energy state hashed into the own check (fire records only on a mismatch), and shell ids derived on both sides (a per-pilot shot counter mapped to entity ids in records, removals and reports). lockstep-alignment-2026-11-04.md item "Own volleys", size L |
| the snapshots and WebSocket messages they make | head 55 + ~8 messages/s (~530 B/s of headers) | head 25 + ~4 messages/s (~260) | A snapshot goes on every tick something is in it; a volley every 3 ticks keeps ~16-20 snapshots a second coming (idle: 1.35), coalesced into ~10 WebSocket messages | goes with the fire records. Short of that, Kieran's call: frames holding only the pilot's own volleys and removals could wait 6 ticks instead of 3 (about 3 fewer messages a second, ~200 B/s), at ~50 ms more before its own hits' HP numbers show |
| removals of own shells | 58 | 12 | A shell that strikes a rock ends on the server's collision test with the rock (orbit params and HP are f32, its outline spins), which the tick layer doesn't run; a shell at the end of its life could be dropped on both sides alike, but both ends' pass counts and the told-hit rules (HitLedger `removing`) would have to agree on its last tick | expiry: the shell's life on the tick layer, pass counts dropped at it on both sides; rock strikes: rocks on the tick layer (lockstep-alignment "Shell hits on asteroids", blocked on the f32 rule) |

The visual cost of (2): a pilot's own shell grazing a rock where the drawn rock and the server's differ by a unit or
two used to be stopped at the server's point by its `projectileHit`; now it stops only if its drawn line meets the
drawn rock, else it flies its life out after its removal. Rocks move slowly and are drawn on their orbits, so this
should be rare; worth a look in a playtest.

## Tests run

Targeted: `server/src/net/own`, `server/src/net/hits`, `server/src/net/causes`, `server/src/net/snapshot` (packed
frames, own shots), `common/src/network` (protocol, packed codec, wire hash), `server/src/game/mining.test.ts`,
`server/src/golden`, `client/src/rendering/weapons`, `client/src/ships/drawnHit.test.ts`; server and client
`tsc --noEmit`. Golden regenerated on purpose: `frameHash.golden.json` (the pilots' frame streams only; the world
hashes are unchanged).
