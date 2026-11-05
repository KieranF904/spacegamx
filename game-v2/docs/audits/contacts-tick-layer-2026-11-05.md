# Contacts on the tick layer (2026-11-05)

The bar: what the client can derive from shared rules isn't sent. Until now a client applied contacts it was told of
(an own row for its own ship, a pair record for every other ship it holds, a `contact` message for the sparks); it
didn't find them. This round puts the contact pass's pair finding on the shared tick layer, so a client finds every
pair between ships it holds in step itself, works it out with the very function it already used, and is told only the
pairs it can't find. `CAPS.CONTACTS` (1048576, with CAUSES), on by default (`?contacts=0` turns it off).

## What moved

- **One sweep, one order** (common ships/contactPass.ts). The server's pass (bridge/flight.ts `resolveContacts`) now
  takes its pairs from `contactCandidates`: the same padded bounding-circle sweep as before, but with the bodies sorted
  by id, so a pair's first body is its lower id and pairs go in (lower id, higher id) order. Before, the order followed
  the bodies Map's insertion order (lockstep-alignment-2026-11-04.md, "contact pairs by eid"), which no client can know.
  The pass's sparks threshold and cooldown are `contactFxDue`. This changes which body of a pair is "first", so
  simulations that grind ships together move by a last bit here and there (the goldens and behaviour tests still pass).
- **The client's pass** (client ships/causes/ContactWorld.ts). On each tick, over the ships it held before the
  snapshot's window and holds in step through it, from each one's step at that tick before its causes
  (`ShipReplicaSet.preAt`, now `stepPre`: worked out once, whoever asks first), it runs the same sweep. Each candidate
  is a row on both ships (`CONTACT_FLAG.CHECK`: the pass's centre-distance test, then `contactPair`), placed among the
  ship's told causes by its place in the pass (`CAUSE_PLACE`, `pairPlace`, `placeRows`): pulls before the pass, pairs by
  ids, a rebuild's recentring after. ShipCauses (`rowsAt`) and OwnTick (`rowsAt`, `midAt`) work the merged list out with
  `applyOwnCauses`, the other ship read just before the pair (`midOf`/`midAt`), as the pass had it. A tick's pairs are a
  memo; a ship stepped again from a tick (a late control row, a decision, a cause, a keyframe, removal: the replica set
  tells it, `ReplicaRewinds`) has the pairs from then on worked out again and every ship that took part stepped again.
  A step worked out ahead goes with any rewind from its tick, even one past where the ship has been stepped to (the
  crowd bench's ball of 100 found it: an AI ship's step at a tick, read ahead by the pass, kept after a late decision
  for that tick, 13 ticks off); each ship part way through a tick's causes is kept once (`MidCursors`, see Crowd).
- **The server's mirror** (server net/causes/contactLog.ts, contactsFor.ts; Replication `found`). The pass notes, per
  tick and system, its ships (and their rebuild counts), the pinned ones, its candidate pairs and where it began among
  the tick's causes. Per client and window (since its last snapshot), Replication works out the same set of ships the
  client takes (held before, not keyframed now, in view, in step) and, from the log, which of the window's contacts it
  finds. Those go as no own row, no pair record and no `contact` message; their ships' hits are told that window as for
  a told cause (`out.caused`, client `SelfHits.onTouched`), exactly as before. A snapshot always goes when the client
  found a pair in its window (so a window's ships left out are always told for that window).
- **Left out** (a CONTACT record naming one ship twice, `[0, 1, id, id, 0]`, common `isLeftOut`): a ship the server can't
  vouch the client takes as its pass did. It is then left out of the client's pass for the window and its pairs come as
  records, as before. Reasons: out of the pass but not docked (mid-jump), pinned with a candidate among them (a pinned
  body doesn't give; the client can't know a pin), its structure that tick not one the client has, or pulled after the
  pass began (never seen; pulls are all before the pass). Measured: 0 or 1 a fight.
- **Sparks**: a client draws the sparks of a pair it found itself (the pass's threshold and cooldown); the rest go to it
  with its snapshot (`Replication.contactFxFor`), everyone else gets them at once as before.
- **Protocol**: no wire change (the left-out record is an existing CONTACT record; `npm run wire:bump` found the hash
  unchanged, protocol stays 53). The cap is new.

## How it was measured

The session's scenario probe (scratchpad, as for boss-bytes-2026-11-05.md), copied into `server/src/bench` while it ran
and not committed: a real `GameServer`, `Math.random` seeded, 3 s warm-up, 20 s measured, 3 ticks of latency each way.
Pilot A is a `FakeHitsClient` (the client's own ShipStore, ShipReplicaSet, OwnTick, ShipCauses, BodyRunner and now
ContactWorld) flying by input messages; B a legacy observer. Every number is A's download.

**Before and after are the same tree and the same fight**: before is CAPS 1048575 (CONTACTS off, the server allowing
262143 as in the boss-bytes round), after is CAPS 2097151 with the server allowing CONTACTS too. Pair order by id is in
both, so the simulation is identical run to run and only the netcode differs. (Against the boss-bytes round's numbers
the fights differ: pair order, and the pacing and population work merged since.)

## The headline (A's download, B/s)

| scenario | payload before | after | change | wire before | after | change | WS msgs/s | deflated before | after |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Scrap Mother | 820 | 704 | -14% | 1490 | 1374 | -8% | 10.2 / 10.2 | 739 | 623 |
| Pyreclast | 503 | 494 | -2% | 734 | 725 | -1% | 3.5 / 3.5 | 271 | 260 |
| Rustjaw | 627 | 627 | 0% | 1261 | 1261 | 0% | 9.6 / 9.6 | 539 | 539 |
| Brood Mother | 628 | 545 | -13% | 1291 | 1208 | -6% | 10.1 / 10.1 | 558 | 484 |
| Pirate fight | 396 | 396 | 0% | 1019 | 1019 | 0% | 9.4 / 9.4 | 379 | 379 |
| Custom enemies A | 717 | 604 | -16% | 1459 | 1346 | -8% | 11.3 / 11.3 | 683 | 574 |
| Custom enemies B | 511 | 500 | -2% | 706 | 695 | -2% | 3 / 3 | 279 | 267 |
| Hookboat reel (3 Hookboats) | 1083 | 1056 | -2% | 1687 | 1660 | -2% | 9.2 / 9.2 | 876 | 849 |
| Pips (control) | 240 | 240 | 0% | 557 | 557 | 0% | 4.8 / 4.8 | 194 | 194 |

Rustjaw (an AI-flown boss that keeps its distance), the pirate fight (5 pairs found in 20 s) and the Pips control had
next to no contacts: nothing to save. Pyreclast and custom B end early in this tree (A doesn't last the 20 s: 3 to 3.5
messages a second), before and after alike.

## Contacts, by scenario

The tick-layer section (own causes, other ships' causes, decisions, guide records) is exact (its encoded bits); the
contact and pull records inside it are the probe's base-format estimates scaled to it (the decisions' estimate rises
after only because the section's scale changes: the decision rows are the same). "Cause rows taken in" counts the rows
the client's ShipCauses and OwnTick applied over the whole run (warm-up included).

| scenario | tick-layer section B/s before (exact) | after | contact records B/s before (est.) | after | pull records B/s before (est.) | after | `contact` msgs B/s before | after | cause rows taken in before (others + own) | after | pairs found here | ships left out (windows) | sparks drawn here / sent |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Scrap Mother | 167.5 | 63.6 | 64.6 | 0.8 | 26.8 | 26.7 | 12.3 | 0.0 | 611 + 545 | 101 + 97 | 479 | 1 | 29 / 2 |
| Pyreclast | 13.3 | 4.0 | 5.4 | 0.0 | 0.0 | 0.0 | 0.6 | 0.0 | 67 + 70 | 1 + 4 | 66 | 0 | 5 / 1 |
| Rustjaw | 32.3 | 32.3 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0 + 5 | 0 + 5 | 0 | 1 | 0 / 2 |
| Brood Mother | 76.8 | 11.0 | 44.0 | 0.0 | 0.0 | 0.0 | 18.7 | 1.3 | 408 + 305 | 2 + 5 | 353 | 1 | 40 / 4 |
| Pirate fight | 26.9 | 26.9 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 10 + 1 | 0 + 1 | 5 | 0 | 3 / 0 |
| Custom enemies A | 120.7 | 42.0 | 86.5 | 0.0 | 0.0 | 0.0 | 34.2 | 0.0 | 1966 + 7 | 4 + 7 | 987 | 1 | 73 / 0 |
| Custom enemies B | 40.0 | 30.4 | 6.7 | 0.0 | 0.0 | 0.0 | 1.8 | 0.0 | 94 + 184 | 1 + 163 | 57 | 0 | 6 / 0 |
| Hookboat reel (3 Hookboats) | 79.3 | 63.9 | 17.7 | 0.1 | 0.0 | 0.0 | 10.9 | 0.0 | 323 + 114 | 1 + 108 | 164 | 1 | 21 / 0 |
| Pips (control) | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.6 | 0.6 | 0 + 0 | 0 + 0 | 0 | 0 | 0 / 3 |

What's left of the section after is pulls (Scrap Mother's magnets 27 B/s as B's records and ~20 as A's own rows; the
Hookboats' reel ~22 own; custom B's pulls ~20 own), decisions and guide records. The `contact` messages left are sparks
of pairs with a ship A doesn't hold or holds out of step (Brood Mother 1.3 B/s).

### Agreement

Every scenario, before and after alike: every own check agreed (bodyOff 0, hpOff 0), the own ship on the tick layer
off on 0 ticks, every body check agreed, no hit fixes, no cause the client failed to work out, and the same keyframe
corrections per second (0, Pyreclast 0.05). The probe's count of other ships' window ticks off without a keyframe is
the same before and after (Pyreclast 26 of 1,211, custom B 1, Hookboat 2, the rest 0): not this change's (it was
there with the cap off).

## Crowd

`npm run bench:crowd -- --n 50,100 --layouts cruise,ball --secs 10 --bulk blocks`, the four probes with every cap
(`--caps 524287` before, `--caps 1572863` after: CONTACTS added; the bench's server now allows CONTACTS). Bytes and
agreement are deterministic run to run; the timing columns of this table were taken while other agents loaded the
machine (see below for the alternated timing runs).

| case | probe raw B/s before | after | probe wire B/s before | after | msgs/s | own-check / held disagreements (no keyframe) before | after | other ships off before | after | kf corrections/s before | after | hit fixes before | after | probe client ms/tick before | after | server tick ms before | after |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| cruise 50 | 2048 | 2046 | 2667 | 2665 | 9.4 / 9.4 | 0 | 0 | 0/1671 | 0/1671 | 0 | 0 | 0 | 0 | 0.075 | 0.194 | 1.80 | 3.08 |
| cruise 100 | 2000 | 1993 | 2637 | 2629 | 9.7 / 9.7 | 0 | 0 | 0/636 | 0/636 | 0.025 | 0.025 | 0 | 0 | 0.071 | 0.136 | 2.97 | 4.95 |
| ball 50 | 16984 | 16177 | 17742 | 16935 | 11.5 / 11.5 | 0 | 0 | 8/33345 | 8/33345 | 1.725 | 1.725 | 6 | 6 | 1.395 | 2.74 | 5.23 | 7.26 |
| ball 100 | 31593 | 26816 | 32397 | 27619 | 12.2 / 12.2 | 0 | 0 | 17/58055 | 17/58055 | 4.7 | 4.7 | 4 | 4 | 3.637 | 13.293 | 13.31 | 24.76 |

Cruise (pilots flying out and back over 24 km) has almost no contacts: nothing moves. The ball (every ship within a few
km) is where contacts are: -5% (50) and -15% (100) of the probes' download. Agreement is the same before and after in
every case: no own-check or held-ship disagreement without a keyframe, the same other-ship and debris offs (8 and 17,
unchanged), the same keyframe corrections and hit fixes.

Timing, ball only, before and after alternated twice on a machine shared with other agents (server tick ms and the
probes' client ms a tick; same columns as above):

| case | probe raw B/s before | after | probe wire B/s before | after | msgs/s | own-check / held disagreements (no keyframe) before | after | other ships off before | after | kf corrections/s before | after | hit fixes before | after | probe client ms/tick before | after | server tick ms before | after |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ball 50 | 16984 | 16177 | 17742 | 16935 | 11.5 / 11.5 | 0 | 0 | 8/33345 | 8/33345 | 1.725 | 1.725 | 6 | 6 | 1.353 | 2.025 | 5.03 | 5.00 |
| ball 100 | 31593 | 26816 | 32397 | 27619 | 12.2 / 12.2 | 0 | 0 | 17/58055 | 17/58055 | 4.7 | 4.7 | 4 | 4 | 3.612 | 6.302 | 13.33 | 13.42 |
| ball 50 | 16984 | 16177 | 17742 | 16935 | 11.5 / 11.5 | 0 | 0 | 8/33345 | 8/33345 | 1.725 | 1.725 | 6 | 6 | 1.319 | 2.059 | 4.65 | 5.22 |
| ball 100 | 31593 | 26816 | 32397 | 27619 | 12.2 / 12.2 | 0 | 0 | 17/58055 | 17/58055 | 4.7 | 4.7 | 4 | 4 | 3.538 | 6.226 | 12.57 | 12.94 |

The server's tick is unchanged (the pass log, the sort by id, the per-client windows: within noise). The client's tick
layer costs more in a dense ball: +0.7 ms a tick a probe at 50 ships, +2.7 ms at 100 (from 3.6 to 6.3). Each pair is
worked out by each side (both ships' pieces each time) and again for its sparks, and a late row for a tick already
stepped steps every ship in that tick's pairs again. The first version was far worse (a ship's state part way through
its causes was rebuilt from scratch for every pair that read it, squared and worse in a crowd: ball 100 did not finish);
`MidCursors` keeps each one once. Follow-ups if a 100-ship melee matters on the client: resolve each pair once for both
sides (one `contactPair`, both results kept), and keep each ship's pieces per pose.

## What is left, and why

| left | where (B/s after) | why | what closes it |
|---|---|---|---|
| Pulls: a boss's magnets, a Hookboat's reel, the custom B pack's pulls, a collapsing star | Scrap Mother ~27 (other ships' pulls) + ~20 own, Hookboat ~22 own, custom B ~20 own | A pull is a move's (boss brains, custom moves) or a weapon's (a held orb's pull) step on the server; the client has no such step to run. They stay as `PULL` causes | the moves in common (the boss and custom moves agent's work: stage 4) and held orbs on the tick layer; then a pull is derived as the step runs |
| Contact damage | in `damage`, `shipHps`, the own row's HP key | Clients don't work HP out at all yet (every HP change is told); the contact's damage needs the server's `hurt` (shields, armour, brittle, glancing) on the client | HP derivation (audit group D); the contact's closing speed and touching parts are already the same on both ends |
| Pairs with a ship it doesn't hold, holds out of step (keyframed now), or is told to leave out | the few records left (Scrap Mother 0.8, the rest ~0) | the client can't work out a ship it doesn't have | nothing: these are the bar's corrections |
| Ship-rock contacts | none | The server has none: ships pass through rocks and stations (`resolveContacts` takes ships only; lockstep-alignment-2026-11-04.md "Contacts with rocks or stations: not simulated"). Nothing to move, and if they are ever added they are blocked on the rocks' f32 orbit parameters (the client's rock positions are f64) | the orbit sweep and the f32 rule first, then a rock pass after the ship pass in the same shared step |
| hitPoints.test.ts's tolerance | | Not made exact by this: that test's client takes CAPS.HITS only (no own tick layer); the hits drawn off are on its own ship, drawn from its prediction (the server's pose at the tick's end) after a pull or contact moved it. Deriving the contact on the tick layer doesn't change the drawn pose; drawing own-ship hits from the tick layer's pose before the tick's causes (`preAt`) would, for an OWN_SIM client | own-ship hit points from the tick layer (ConfirmedHits' pose for its own ship), a separate change |

## Tests

Targeted, from game-v2/ (`npx vitest run ...`):

- `server/src/net/causes` (causes.test.ts, with a new case: a client finding its own pairs holds every ship exactly on
  every tick, every check agreeing, records 1,099 -> 33, sparks its own), `server/src/net/own`, `server/src/net/decisions`
  (bodies, pilots, custom enemies, Pyreclast, Scrap Darter), `server/src/net/hits` (hitPoints unchanged), `server/src/net/crowd`,
  `server/src/golden` (frame hash and parity unchanged; ShipBridge's API pin rewritten for `contactLog`), `server/src/tickOrder.test.ts`.
- `server/src/ships`, `common/src/bodies`, `common/src/ships`, `common/src/network`, `client/src/network` (netCaps: every
  cap in DEFAULT_CAPS), `client/src/ships`, `server/src/net/replication.test.ts`, `server/src/net/debris`, `server/src/net/snapshot`,
  `server/src/game/hitRules.golden.test.ts`: all pass but one, packedFrames.test.ts "the shooter finds its own hits"
  (sub-frames 208 against more than 220.8), which fails the same on the merged base without this change (checked on a
  `git archive` of it).
- Typechecks: client (`tsc --noEmit`) and server (with `@space-game/common` mapped to common/src), both clean; common clean.
- `npm run wire:bump`: hash unchanged, nothing to bump (protocol 53).
