# Boss and custom-enemy bytes, by category (2026-11-05)

The bar (Kieran): a boss fight costs her decisions, the pilots' inputs and control rows, and corrections only when a
pilot's own check fails. Anything else the client can derive from shared rules (fire, hits, HP, removals, the old
path's messages) is a gap to close, not a cost to accept. This round measured every boss scenario and the custom
enemies by category with every CAPS bit on, closed the gaps that could be closed without the moves themselves going
into common (decision-inputs stage 4), and names what is left.

## How it was measured

- **Probe**: the session's scenario probe (scratchpad `net/debris/probe.ts`, as used for netcode-all-2026-11.md),
  copied into `server/src/bench` while it ran and not committed. A real `GameServer`, `Math.random` seeded, 3 s warm-up,
  20 s measured, 3 ticks of latency each way. Pilot A (a `FakeHitsClient` with **every cap, 1048575**) flies by input
  messages and fires at its target; B is a legacy observer near it. Every number is A's download.
- **By category**: A's frames are BLOCKS snapshots plus packed messages. Each snapshot's encode-once parts are counted
  exactly (`PackedEncoder.blockBits`: head, status rows, shells, keyframes, control rows, fire records, the rest), each
  block row by the entity it is of; the rest of the snapshot (own causes, other ships' causes, decisions, guide records)
  is split by its rows' base-format sizes, scaled to the exact bits. Every other message is counted by type at its
  packed size.
- **Before** is c172094 (`refactor/split`, protocol 48), exported with `git archive` and run with the same probe;
  **after** is this branch (protocol 49). Both trees ran with `@space-game/common` mapped to their own `common/src`.
- **Payload** is the bytes the encoder made; **wire** adds 66 B per WebSocket message (the frame and TCP/IP headers
  the earlier audits used). The scene is seeded, so bytes repeat exactly run to run.

## The headline (A's download, B/s)

| scenario | payload before | after | change | WS msgs/s before | after | wire before | after | change | wire deflated before | after |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Scrap Mother | 930 | 626 | -33% | 12.3 | 9.3 | 1,742 | 1,237 | -29% | 1,668 | 1,187 |
| Pyreclast | 682 | 459 | -33% | 11.8 | 9.7 | 1,461 | 1,096 | -25% | 1,422 | 1,062 |
| Rustjaw (AI-flown boss) | 569 | 496 | -13% | 8.9 | 8.9 | 1,157 | 1,084 | -6% | 1,146 | 1,077 |
| Brood Mother | 960 | 544 | -43% | 13.5 | 10.1 | 1,851 | 1,211 | -35% | 1,796 | 1,181 |
| Pirate fight | 778 | 649 | -17% | 11.4 | 10.1 | 1,534 | 1,316 | -14% | 1,521 | 1,307 |
| Custom enemies A | 661 | 564 | -15% | 10.6 | 10.6 | 1,357 | 1,260 | -7% | 1,353 | 1,258 |
| Custom enemies B | 860 | 786 | -9% | 12.2 | 11.5 | 1,665 | 1,545 | -7% | 1,555 | 1,436 |
| Pips on a freighter (control) | 210 | 210 | 0% | 7.8 | 7.8 | 725 | 725 | 0% | 723 | 723 |

Upload is unchanged (inputs and what rides them; Scrap Mother 4,449 -> 4,428 B/s wire, the probe sends on every aim
change). Every scenario after: zero own-ship tick-layer disagreements, every own check and body check agreeing, no
hit corrections (`hitFix`); corrections (keyframes of a ship A holds) per second: custom enemies A 5.65 -> 0.15, the
rest as before (0 to 0.45).

## What was closed

1. **The own status row after a contact or a pull** (Scrap Mother 246 -> 30, Pyreclast 173 -> 26, Brood Mother 276 ->
   27, pirates 120 -> 22 B/s). A contact or a pull moves a ship's shared keyframe version, and the own row went as a
   *correction* every time it moved, with the whole row (position, velocity, the 20-value status block), urgent: 128
   of the Scrap Mother fight's 246 messages in 20 s. A client stepping its own ship (OWN_SIM) worked that move out
   itself; it now goes by its own keyframe version (`Replication.ownVersionOf`), so the row goes only for HP and status
   changes and the 2 s safety copy. Its drawn prediction, which the row used to snap, follows its tick layer instead:
   at a snapshot whose causes moved it, it is put where the tick layer has it at that tick and its inputs since are
   replayed (`ShipClient.ownTickPose`, `GameState.followOwnTick`). Fewer urgent frames is most of the wire saving.
2. **Own contacts with a boss the client runs carried the boss's state** (5 floats each: Scrap Mother own causes
   126 -> 51, Brood Mother 180 -> 35 B/s). The stateless rule compared the client's known version of the boss with
   the shared one, which a bodied boss never matches. It now checks the bodied shadow before that tick's causes
   (`shadowCauses` `bodyPreStep`) against the client's bodied version.
3. **Hits on the client's own ship were always told** (`HitLedger` 'self'). With OWN_SIM its own ship is exact on its
   tick layer, so it finds them like any other (`SelfHits.ownExact`). Pirates: told hits 55 -> 4, records 11 -> 1 B/s.
4. **A boss's damage multiplier** (bosses.json `damage`, rage): every hit by an AI-flown boss's guns carried its damage
   as a record extra, because the client derived it unscaled. A ship's syncs now carry `dmg` when it isn't 1
   (`shipSync.dmg`, protocol 49; `gunShell` scales by `ShipState.dmg`; the server derives with what it sent).
   Rustjaw: hit records 51 -> 2, shipHps 34 -> 7 B/s, 183 of 193 hits on the pilot found by the client.
5. **EMP and slowing on AI ships the client runs** (custom enemies A: keyframes of them ~96 -> ~3 B/s, 113 -> 3
   keyframes in 20 s). An EMP'd or slowed ship flew crippled on the server while its body flew it whole, so its
   bodied shadow left the ship every window, and every pack mate whose body reads it (the pack's centroid) was keyed
   with it. Its body is now told (`DECISION.STATUS` [emp, slowed], op 7) when what it had stops being what the ship
   has, and flies `CTL.emp`/`CTL.slowed` from it (`bodyStatusBits`, common bodies/decisions.ts).

## By category, every scenario (A's payload, B/s)

Categories: snapshot parts are named by what they carry; other rows are message types. "Other pilot" is B, flown by
the server from its inputs (its control rows are its inputs: the bar's cost, not a gap).

### Scrap Mother (`boss`, Corsair against her)

| category | before B/s | after B/s |
|---|--:|--:|
| own status row (snapshot) | 245.8 | 29.9 |
| own-ship causes (contacts, pulls) | 125.8 | 50.8 |
| other pilot: control rows (its inputs) | 87.6 | 87.6 |
| other ships' causes (contact pairs, pulls) | 79.5 | 72.0 |
| shipSync | 56.4 | 56.4 |
| snapshot head | 53.7 | 53.5 |
| other pilot: status row | 40.1 | 40.1 |
| partDestroyed | 29.8 | 29.8 |
| bossTelegraph | 25.1 | 25.1 |
| mapDots | 19.4 | 19.4 |
| bossWindow | 15.5 | 15.5 |
| shipHps | 14.0 | 14.0 |
| contact | 13.5 | 13.5 |
| own volleys: fire records | 12.7 | 12.7 |
| shells as rows (brain/move shots) | 11.7 | 11.7 |
| damage | 8.9 | 8.9 |
| hits | 8.7 | 8.7 |
| section counts (and own exception rows) | 7.5 | 7.5 |
| projectileHit | 7.1 | 7.1 |
| toast | 6.4 | 6.4 |
| decisions | 4.7 | 4.6 |
| detonation | 4.2 | 4.2 |
| keyframes: Scrap Mite | 3.5 | 3.5 |
| playerState | 3.4 | 3.4 |
| status rows: Scrap Mite | 3.1 | 3.1 |
| netCaps | 1.7 | 1.7 |
| control rows: Ceres Hauler | 1.0 | 1.0 |
| removals | 0.8 | 0.8 |
| cells | 0.8 | 0.8 |
| hpCheck | 0.8 | 0.8 |
| **payload** | **930** | **626** |
| deflated | 856 | 576 |
| WebSocket messages/s | 12.3 | 9.3 |
| wire (payload + 66 B a message) | 1742 | 1237 |

### Pyreclast (`boss`, BOSS=boss_pyreclast)

| category | before B/s | after B/s |
|---|--:|--:|
| own status row (snapshot) | 173.4 | 25.8 |
| own-ship causes (contacts, pulls) | 87.7 | 20.8 |
| other pilot: control rows (its inputs) | 73.5 | 73.2 |
| snapshot head | 57.7 | 57.4 |
| shipSync | 44.5 | 44.5 |
| other ships' causes (contact pairs, pulls) | 35.1 | 30.5 |
| mapDots | 23.8 | 23.7 |
| partDestroyed | 20.3 | 20.3 |
| other pilot: status row | 14.7 | 14.7 |
| shipSync:debris | 13.5 | 13.5 |
| shells as rows (brain/move shots) | 11.3 | 11.3 |
| detonation | 9.8 | 9.8 |
| decisions | 9.3 | 9.4 |
| section counts (and own exception rows) | 8.7 | 8.6 |
| bossWindow | 7.6 | 7.6 |
| bossTelegraph | 7.6 | 7.6 |
| toast | 6.4 | 6.4 |
| contact | 5.4 | 5.4 |
| shipHps | 4.1 | 4.1 |
| keyframes: debris | 3.6 | 3.6 |
| keyframes: Scrap Mite | 3.5 | 3.5 |
| partDestroyed:debris | 3.1 | 3.1 |
| status rows: Scrap Mite | 2.9 | 2.9 |
| status rows: debris | 2.8 | 2.8 |
| debrisSplit | 2.7 | 2.7 |
| damage | 2.5 | 2.5 |
| removals | 2.0 | 2.0 |
| playerState | 2.0 | 2.0 |
| netCaps | 1.6 | 1.6 |
| control rows: Ceres Hauler | 1.3 | 1.3 |
| debrisSplit:debris | 1.0 | 1.0 |
| projectileHit | 0.8 | 0.8 |
| **payload** | **682** | **459** |
| deflated | 643 | 425 |
| WebSocket messages/s | 11.8 | 9.7 |
| wire (payload + 66 B a message) | 1461 | 1096 |

### Rustjaw (`boss`, BOSS=boss_rustjaw: AI-flown, damage 0.27)

| category | before B/s | after B/s |
|---|--:|--:|
| boss's guns: fire records | 155.8 | 155.8 |
| snapshot head | 53.3 | 54.0 |
| hits | 50.9 | 2.4 |
| shipHps | 33.7 | 7.4 |
| shipSync | 29.1 | 29.4 |
| mapDots | 27.4 | 27.5 |
| partDestroyed | 25.0 | 25.0 |
| removals | 20.9 | 20.9 |
| other pilot: status row | 20.1 | 20.1 |
| other pilot: control rows (its inputs) | 19.5 | 19.5 |
| own status row (snapshot) | 18.3 | 18.4 |
| guide records (homing shells, mobs) | 18.0 | 18.0 |
| projectileHit | 16.4 | 16.6 |
| shells as rows (brain/move shots) | 11.7 | 11.7 |
| damage | 11.7 | 11.7 |
| toast | 6.4 | 6.4 |
| section counts (and own exception rows) | 6.0 | 6.0 |
| contact | 3.7 | 3.7 |
| detonation | 3.2 | 3.2 |
| hpCheck | 2.3 | 2.3 |
| netCaps | 1.7 | 1.7 |
| playerState | 1.4 | 1.4 |
| control rows: Ceres Hauler | 1.3 | 1.3 |
| decisions | 0.6 | 0.6 |
| **payload** | **569** | **496** |
| deflated | 559 | 490 |
| WebSocket messages/s | 8.9 | 8.9 |
| wire (payload + 66 B a message) | 1157 | 1084 |

### Brood Mother (`boss`, BOSS=boss_brood_mother: her flight only)

| category | before B/s | after B/s |
|---|--:|--:|
| own status row (snapshot) | 276.3 | 27.4 |
| own-ship causes (contacts, pulls) | 180.0 | 35.3 |
| other pilot: control rows (its inputs) | 134.7 | 134.7 |
| other ships' causes (contact pairs, pulls) | 80.8 | 63.5 |
| snapshot head | 65.0 | 65.0 |
| mapDots | 36.2 | 36.2 |
| other pilot: status row | 34.7 | 34.7 |
| shipHps | 23.4 | 23.4 |
| shipSync | 22.8 | 22.8 |
| contact | 19.0 | 19.0 |
| damage | 10.0 | 10.0 |
| section counts (and own exception rows) | 9.8 | 9.8 |
| toast | 6.4 | 6.4 |
| partDestroyed | 4.6 | 4.6 |
| decisions | 4.5 | 4.4 |
| cells | 3.9 | 3.9 |
| playerState | 2.7 | 2.7 |
| netCaps | 1.6 | 1.6 |
| status rows: Ceres Hauler | 1.0 | 1.0 |
| control rows: Ceres Hauler | 0.6 | 0.6 |
| **payload** | **960** | **544** |
| deflated | 905 | 514 |
| WebSocket messages/s | 13.5 | 10.1 |
| wire (payload + 66 B a message) | 1851 | 1211 |

### Pirate fight (`npcfight`, Corsair against raiders and skiffs)

| category | before B/s | after B/s |
|---|--:|--:|
| own status row (snapshot) | 119.8 | 21.6 |
| other pilot: control rows (its inputs) | 91.3 | 91.2 |
| snapshot head | 63.3 | 63.3 |
| shipSync | 51.7 | 51.7 |
| decisions | 47.1 | 47.1 |
| own-ship causes (contacts, pulls) | 46.8 | 31.3 |
| AI guns: fire records (Pirate Skiff) | 46.1 | 46.1 |
| other ships' causes (contact pairs, pulls) | 43.9 | 41.2 |
| mapDots | 34.7 | 34.7 |
| projectileHit | 29.9 | 29.9 |
| shells as rows (brain/move shots) | 24.3 | 24.3 |
| damage | 22.0 | 22.0 |
| other pilot: status row | 18.7 | 18.7 |
| partDestroyed | 16.4 | 16.4 |
| section counts (and own exception rows) | 12.6 | 12.5 |
| hits | 11.2 | 0.9 |
| own volleys: fire records | 10.1 | 10.1 |
| shipHps | 9.0 | 9.0 |
| bossBeam | 8.2 | 8.2 |
| bossTelegraph | 7.6 | 7.6 |
| toast | 6.4 | 6.4 |
| removals | 5.2 | 5.2 |
| contact | 4.1 | 4.1 |
| hpCheck | 2.6 | 2.6 |
| debrisSplit | 2.2 | 2.2 |
| netCaps | 1.6 | 1.6 |
| playerState | 1.4 | 1.4 |
| control rows: Ceres Hauler | 1.3 | 1.3 |
| shipSync:debris | 1.2 | 1.2 |
| **payload** | **778** | **649** |
| deflated | 765 | 640 |
| WebSocket messages/s | 11.4 | 10.1 |
| wire (payload + 66 B a message) | 1534 | 1316 |

### Custom enemies A (`npcfight`, PACK=cinder_zealot,maw_lurker,hookboat,frost_shard,helios_drone)

| category | before B/s | after B/s |
|---|--:|--:|
| other pilot: control rows (its inputs) | 74.1 | 74.1 |
| own status row (snapshot) | 72.0 | 64.5 |
| snapshot head | 58.6 | 58.8 |
| shells as rows (brain/move shots) | 43.4 | 43.4 |
| decisions | 41.6 | 41.3 |
| other ships' causes (contact pairs, pulls) | 38.1 | 43.0 |
| mapDots | 28.4 | 28.4 |
| keyframes: Helios Drone | 21.6 | 0.0 |
| keyframes: Rime Bell | 21.1 | 1.2 |
| keyframes: Hookboat | 20.0 | 1.2 |
| bossTelegraph | 18.6 | 18.6 |
| keyframes: Maw Lurker | 17.3 | 1.1 |
| shipSync | 17.1 | 17.1 |
| keyframes: Censer | 16.4 | 0.0 |
| damage | 15.8 | 15.8 |
| contact | 14.8 | 14.8 |
| profile | 13.4 | 13.4 |
| shipHps | 13.1 | 13.1 |
| control rows: A | 12.0 | 12.0 |
| section counts (and own exception rows) | 9.8 | 8.9 |
| partDestroyed | 9.5 | 9.5 |
| projectileHit | 8.0 | 8.0 |
| bossBeam | 7.0 | 7.0 |
| other pilot: status row | 6.7 | 6.7 |
| toast | 6.4 | 6.4 |
| removals | 3.0 | 3.0 |
| gained | 2.9 | 2.9 |
| debrisSplit | 2.1 | 2.1 |
| playerState | 2.0 | 2.0 |
| detonation | 1.8 | 1.8 |
| netCaps | 1.6 | 1.7 |
| own-ship causes (contacts, pulls) | 1.5 | 1.1 |
| own volleys: fire records | 1.4 | 1.4 |
| control rows: Ceres Hauler | 1.3 | 1.3 |
| status rows: Maw Lurker | 1.1 | 1.1 |
| status rows: ent | 1.1 | 1.1 |
| hpCheck | 0.7 | 0.7 |
| **payload** | **661** | **564** |
| deflated | 657 | 562 |
| WebSocket messages/s | 10.6 | 10.6 |
| wire (payload + 66 B a message) | 1357 | 1260 |

### Custom enemies B (`npcfight`, PACK=scrap_crawler,rivet_sower,slag_ray,clinker,scrap_darter)

| category | before B/s | after B/s |
|---|--:|--:|
| own status row (snapshot) | 75.7 | 21.4 |
| bossTelegraph | 69.2 | 69.2 |
| items | 66.2 | 66.2 |
| shells as rows (brain/move shots) | 64.1 | 64.1 |
| other pilot: control rows (its inputs) | 63.6 | 63.9 |
| snapshot head | 63.6 | 63.6 |
| decisions | 56.0 | 55.9 |
| profile | 53.8 | 53.8 |
| shipSync | 34.6 | 34.6 |
| mapDots | 34.2 | 34.3 |
| own-ship causes (contacts, pulls) | 30.5 | 13.6 |
| partDestroyed | 28.6 | 28.6 |
| other ships' causes (contact pairs, pulls) | 28.1 | 25.8 |
| gained | 22.4 | 22.4 |
| damage | 17.5 | 17.5 |
| other pilot: status row | 10.0 | 10.0 |
| effect | 9.3 | 9.3 |
| contact | 8.8 | 8.8 |
| detonation | 8.6 | 9.2 |
| section counts (and own exception rows) | 8.1 | 8.1 |
| removals | 7.8 | 7.8 |
| status rows: ent | 7.6 | 7.6 |
| projectileHit | 7.3 | 7.3 |
| shipHps | 7.0 | 7.0 |
| debrisSplit | 6.7 | 6.7 |
| toast | 6.4 | 6.4 |
| own volleys: fire records | 4.7 | 4.7 |
| keyframes: Slag Ray | 3.5 | 3.5 |
| keyframes: Clinker | 3.1 | 3.1 |
| playerState | 2.8 | 2.8 |
| keyframes: Scrap Darter | 2.4 | 2.4 |
| netCaps | 1.6 | 1.6 |
| ribbon | 1.6 | 1.6 |
| control rows: Ceres Hauler | 1.3 | 1.3 |
| hpCheck | 1.2 | 1.2 |
| keyframes: Scrap Crawler | 1.1 | 1.1 |
| shipSync:debris | 0.8 | 0.8 |
| **payload** | **860** | **786** |
| deflated | 750 | 677 |
| WebSocket messages/s | 12.2 | 11.5 |
| wire (payload + 66 B a message) | 1665 | 1545 |

### Pips on a parked freighter (`pip`, the control)

| category | before B/s | after B/s |
|---|--:|--:|
| own volleys: fire records | 55.0 | 55.0 |
| mapDots | 50.2 | 50.2 |
| snapshot head | 32.6 | 32.6 |
| own status row (snapshot) | 14.4 | 14.4 |
| toast | 6.4 | 6.4 |
| shipHps | 4.2 | 4.2 |
| damage | 3.7 | 3.7 |
| other pilot: status row | 3.3 | 3.3 |
| partDestroyed | 3.3 | 3.3 |
| contact | 3.2 | 3.2 |
| hpCheck | 2.6 | 2.6 |
| section counts (and own exception rows) | 1.7 | 1.7 |
| netCaps | 1.6 | 1.6 |
| playerState | 1.4 | 1.4 |
| control rows: Ceres Hauler | 1.3 | 1.3 |
| shipSync | 0.6 | 0.6 |
| projectileHit | 0.5 | 0.5 |
| **payload** | **210** | **210** |
| deflated | 208 | 208 |
| WebSocket messages/s | 7.8 | 7.8 |
| wire (payload + 66 B a message) | 725 | 725 |

## What is left, and why

### Costs the bar accepts (not gaps)

- **Other pilots' inputs**: B's control rows (20-135 B/s) and its status row. Late-arriving inputs of other pilots are
  what control rows are.
- **Decisions** (5-56 B/s; the custom enemies' orders carry their moves' args and seeds) and **guide records**.
- **The snapshot head** (tick, last input; 50-65 B/s at 10-12 snapshots a second) and section counts.
- **Corrections** (own and body checks failing): none in these runs. Late joiners and packet loss get keyframes and
  SYNCs, as before.
- **Economy and UI**: `items`, `profile`, `gained`, `toast`, `ribbon`, `playerState`, `netCaps`, `cells`, `hpCheck`
  (the HP checksum is the hits' correction path).
- **`mapDots`** (19-50 B/s): ships beyond the snapshot's view (and the focus ring's ghosts), already dead-reckoned in
  closed form and resent only when a route changes; the client holds none of them, so nothing to derive them from.

### Gaps still open (deterministic, still on the wire)

| gap | where (B/s after) | why it isn't closed yet | what closes it |
|---|---|---|---|
| Boss moves: `bossTelegraph`, `bossWindow`, `bossBeam`, strike/blow `detonation`s, her shots as rows | Scrap Mother 25 + 16 + 4 + 12, Pyreclast 8 + 8 + 10 + 11, custom B 69 telegraphs + 64 rows, custom A 19 + 7 + 43 | The moves are server generators (brains/staged.ts, scrapMother.ts, pyreclast.ts; custom/moves.ts with factions.json numbers the client doesn't hold); their telegraphs and shots need the moves in common, run by the body from `MOVE` decisions with seeds, and `LAUNCH` ids for their shells | decision-inputs stage 4 (bosses) and the custom moves' steps moved to common bodies/custom with their numbers |
| Contacts: the boss's half (other ships' causes), pulls (`PULL` causes every tick a magnet holds), `contact` FX and contact `damage` | Scrap Mother 72 + 51 causes, Brood 64 + 35, pirates 41 + 31; `contact` 4-19 everywhere | The client applies contacts it is told of; it doesn't detect them (contact pairs aren't found on the tick layer), so the pair, the FX and the damage come from the server. Pulls are a move's (stage 4) | contacts found on the tick layer (common contact pass over the ships a client holds exactly: decision-inputs 11.6 item 1), the FX and collision damage derived from them |
| Hits on a staged boss (`HitLedger` 'body') and part-destroying hits | Scrap Mother `hits` 9, `shipHps` 14; everywhere `shipSync` 23-56, `partDestroyed` 5-30, legacy `damage`/`projectileHit` 8-52 | A staged boss's `taken`/`invulnerable` (brace, iris, windows, stage cover) are its brain's (stage 4). A hit that kills a part rebuilds its ship before the snapshot, so `derive` can't use it ('rebuilt': 51 of 246 hits on Rustjaw, 75 of 172 in the pirate fight) and it goes the old way, with a sync of the new structure | stage 4 for the boss; rebuild derivation (audit group D): the client rebuilds a ship at the server's rebuild point from the HP it worked out, the sync only when it can't |
| Fire records: own volleys, AI guns, an AI-flown boss's guns | own 1-55 (the Pips control 55), pirates' guns 46, Rustjaw's 156 | A fire record names the shells' server entity ids, and whether a gun fires on a tick is the server's gun state (energy, heat, cooldown, ammunition, a hostile's "likely to hit" rule) that neither tick layer holds | gun state on the tick layer (own ship: its pool and guns; AI: the body's firing rule plus pilotless guns' load) and derived shell ids (decision-inputs 6.3, way 2) |
| The own status row on an HP change | 15-65 B/s (custom A 65: Censer lances and Hookboat harpoons on A) | Its key includes the ship's HP; the client works most of that out now (its hits found) but not burns, beams, splash or contact damage, which go as `shipHps`/`damage` | drop HP from the own row's key for a client finding its own hits once splash, beams and burns are derived (group D) |
| Own exception control rows | custom A 12 B/s (`control rows: A`) | A Rime Bell's pulse EMPs the pilot: the server sends the window's real controls, as for any EMP on the own ship | the own ship's EMP as a STATUS-like own cause, worked out from the pulse once the move runs on the client (stage 4) |
| Brain-fired debris and blow-aways | Pyreclast `shipSync:debris` 14, debris keyframes 4 | a stage's blow-away sheds from the brain's schedule | `STAGE`/`DIE` decisions with seeds (stage 4), rebuild derivation |

### Named exceptions (will stay)

- Other pilots' inputs that arrive late (their control rows), late joiners and packet loss (keyframes, SYNCs, full HP).
- A pilot-against-pilot hit (`pvp`): only the server knows the zone rules.
- Shells sent as rows (homing seekers until their guides cover them, shells from ships the client only now gets).
- Server randomness: every RNG the brains and the commander draw from stays the server's; what reaches the client is
  the seed in a decision (custom moves' `seed`, personal attacks), so nothing the client runs uses unshared randomness.
  The one unshared roll found in this round: none new (the custom moves' `a.rng()` picks a side once per move and
  rides the move's `arg`).

## Tests run

Targeted only (the integrator runs the full suite once): `server/src/net/own` (with a new check: no own row rides
the causes it worked out), `server/src/net/hits`, `server/src/net/causes`, `server/src/net/decisions` (with a new
test: an AI ship EMP'd twice and another slowed mid-fight, a STATUS each, no divergence, no rekey of its pack),
`server/src/net/replication.test.ts`, `common/src/network`, `common/src/bodies`, `common/src/ships/hitRules.test.ts`,
`client/src/state`, `server/src/golden`, `server/src/game/hitRules.golden.test.ts`, `common/src/ships/golden`; server
and client `tsc --noEmit`. Goldens regenerated on purpose: `frameHash.golden.json` (the pilots' frame streams only,
world hashes unchanged: protocol 49 and the own rows that no longer go) and `shipBridgeApi.json`
(`ShipBridge.damageMulOf`).
