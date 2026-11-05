# Scheduled waypoints: measurements (2026-11-04)

Stage "Waypoints" of the awareness-model work (docs/design/awareness-model.md 6.3, phase 6). Homing shells and mobs fly
by one shared law (common guidance/) on the server and on a `CAPS.WAYPOINTS` (4096, protocol 40) client's tick layer:
derived there when it holds the target, from the server's waypoint records when it doesn't. How it works:
docs/areas/networking.md, "Scheduled waypoints".

## Scenes (server/src/bench/guides/guideScene.testkit.ts)

A real GameServer, 10 s each. Client A is the one measured: `BASE` caps (HITS, SELF_HITS, PACKED, COALESCE, OWN_SHOTS,
ROUGH, OWN_SIM, CAUSES, FOCUS, BLOCKS) against `BASE | WAYPOINTS`. A legacy observer B is beside it.

- **inFocus**: a dummy 3.7 km off fires a missile every 12 ticks, alternately at A and at a dummy near A (both held:
  derived).
- **outside**: missiles from 2 km off at a pilot 33 km away (never held: sent).
- **switching**: missiles every 15 ticks at a pilot who jumps from 24 km into the focus after about 4 s, and back out after 8 s.
- **mobs**: scrap mites every 20 ticks; their brain picks A or a pilot beside it, who jumps out of the focus and back.
- **quiet**: one missile, nothing else.

| scene | A raw B/s before | after | shell/mob rows before | after | SYNCs | MODE switches | WP/NEXT sent | shell-ticks checked | off | own checks agreed |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| inFocus | 2,168 | 657 | 630 | 50 | 50 | 0 | 0 | 4,191 | 0 | 97/97 |
| outside | 1,572 | 610 | 471 | 40 | 40 | 0 | 159 | 6,396 | 0 | 97/97 |
| switching | 2,189 | 509 | 675 | 40 | 40 | 45 | 13 | 5,006 | 0 | 97/97 |
| mobs | 1,544 | 479 | 1,181 | 30 | 30 | 8 | 5 | 2,900 | 0 | 97/97 |
| quiet | 195 | 180 | 12 | 1 | 1 | 0 | 0 | 106 | 0 | 31/31 |

- Every shell and mob A runs matches the server's exactly on every tick it steps (x, y, vx, vy, a mob's heading),
  through every derived/sent switch.
- A shell costs its first row plus one SYNC (about 25 B) and then nothing while derived; in sent mode about 16 waypoint
  records a second over 40 shells in flight, about 6 B each. A mob is sent again only when its HP changes.
- Rows per shell before: one per snapshot while it turns (every 3 ticks). After: one.

## Live-scene probes (scratchpad/net/waypoints: the effects probe, 20 s, 3 ticks of latency)

| scene | caps 4095 raw B/s | caps 8191 | SYNCs | records | plans on the client | blind | own-check resyncs |
|---|--:|--:|--:|--:|--:|--:|--:|
| boss (Scrap Mother launching mites, hammerhead pilot) | 1,953 | 1,457 | 24 | 46 | 398 | 0 | 0 |
| npcfight, the pilot in a pirate gunship firing missiles | 740 | 710 | 6 | 0 | 28 | 0 | 0 |

Hit records, own-ship and window agreement are identical between the two cap sets in both.

## Crowd bench

`npm run bench:crowd -- --caps 4095|8191 --n 50 --layouts ball,boss,spread --bulk focus`: bytes and agreement
identical (no homing shells or mobs in its scenes); tick times within noise. The bench's server now allows every cap.

## Behaviour changes (on purpose)

- Missiles plan a waypoint and fly at it instead of turning toward the lead point every tick: a little more dodgeable
  far out (a point held up to 48 ticks), replanned every 4 ticks close in. hitRules.golden 'shells' damage moved
  43,646,001 → 43,646,018 (same rows). Mobs likewise (spacing 32 down to 4).
- State on the 1/256 grid (velocity, spawn position), kind values on 1/65536; a mob's heading on 1/65536.
- A mob whose target is gone lets go at once (it used to fly at the old position until its next pick, up to 15 ticks).

## Known gaps

- AI ships keep their control rows (already exact on the tick layer). Moving their pilot to the waypoint law needs the
  commander/pilot split (decision-inputs stage 7).
- Guided shells (cursor-steered) still go as rows.
- "In focus" for a shell or mob is the projectile range (12 km around the ship), not the focus cells.
- A shell's first row and its SYNC overlap (the row's rounded position, the SYNC's exact one).
- Arrivals (a shell entering the range comes as a row, then a SYNC) and spawn quantisation for straight shells: not
  this stage.
