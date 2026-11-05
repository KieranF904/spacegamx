# Ship rebuild speed (2026-11-06)

The large-ships audit (large-ships-2026-11-04.md) found the rebuild after a part loss was a full rebuild every time. At
1,000 parts that was 13-17 ms, two thirds of it turret windows, and it blew the tick in a fight. This round makes the
rebuild after a part loss cheap without changing what it produces.

**Result:** a rebuild after a part loss is **5-10× faster on big ships**: 1.7 → 0.33 ms at 210 parts, 4.0 → 0.76 ms
at 500 and 14.1 → 1.4 ms at 1,000. Four 1,000-part ships in a fight now average a 5.5 ms tick, down from 9.7 ms. Ticks
over budget fall from 356 to 23 of 1,200. Every result is identical to the old full computation (see Parity).

## What changed

All of it is in common/, so the server and every client get it.

1. **Turret windows** (turret.ts `castTurret`, called from rebuild.ts). Losing parts can only open a ray, never close
   one. Each turret keeps, per ray, the part that blocked it. On a rebuild where every part alive now was alive last
   time (same design, same tuning):
   - a window that is already fully open is reused as it is;
   - a closed ray whose blocker is still there stays closed (if the ray got shorter because the ship shrank, it is
     checked against that one blocker again);
   - only rays whose blocker went are cast again.

   The static part of each turret (ray angles and their cos/sin, each part's bounding circle and reach from the pivot,
   the parts it sits on) is worked out once per design.
2. **Engine exhaust**. An engine whose lanes were all clear stays clear, so it is skipped. Only engines with a share
   below 1 are checked again. The ship's cell map is only built when one of those exists.
3. **Per-design caches** (new design.ts `designOf`): placed geometry, mounts, functions, materials, areas, all joins,
   the core index, and the as-built flood fill for a ship with no ghosts.
   - They are kept in a WeakMap on the blueprint object.
   - The hangar edits its blueprint in place (moves, turns, adds parts), so each use first checks that the entry still
     holds: the same catalog, the same parts array and part objects, and each part's piece, x, y, rot, flip, facing,
     fn and material. Anything else is worked out again.
4. **One rebuild for a split** (state.ts `splitRebuild`, used by ShipBridge `rebuildNow` and by a client's crumbling
   debris, debrisLife.ts `crumbleRebuild`). The orphan groups are found first with the structure pass alone
   (rebuild.ts `structureOf`, which the rebuild itself also uses). They are detached, and the ship is rebuilt once.
   - It still counts as two rebuilds (`rebuilds` += 2), and debrisNet gets the same two `noteCom` entries. Both
     structures have the same live parts, so they have the same root and centre of mass.
   - Debris spawns, `noteSplit` (`gone`, `com`, pose, groups) and the wire are unchanged.
   - A design whose parts break by groups (custom enemies, groups.ts) still rebuilds twice. Detaching one of a group's
     parts takes the rest of the group, which changes what's left.

Where it is kept: the memo is per ship, on `ShipState.memo` (rebuild.ts `RebuildMemo`). It is non-enumerable, so it is
never copied, sent, hashed or compared. After anything that adds parts (a repair, a ghost built, a new ship), there is
no "only parts went" history to carry on from. The memo then carries on from the design's own rays and exhaust with
every part standing (design.ts `wholeTurret` / `wholeExhaust`): every ship of the design is a subset of that. So a
spawn or a repair is cheap too, after the first ship of a design. The memo only saves work, so a server and a client
with different histories get the same result.

## Per ship: rebuild after a part loss

Method: the real rebuild point (`splitRebuild`, or the old rebuild + detach + rebuild). The run starts from a whole
ship and loses one random live non-core part at a time, up to 80 losses, in 3 seeded runs. Same seeds before and after.
A, B and H are the large-ships test designs (A: Bastion tiling, B: ports-gale tiling); W30, L and M245 are library
designs. "Spawn" is `createShipState` of a design already seen.

| Design | Parts | Before mean ms | p95 | After mean ms | p95 | Speed-up | Spawn before → after ms |
|---|---|---|---|---|---|---|---|
| W30 Bulwark | 30 | 0.50 | 1.15 | 0.27 | 0.52 | 1.8× | 0.66 → 0.31 |
| L Lancer | 100 | 0.62 | 1.02 | 0.26 | 0.57 | 2.4× | 0.80 → 0.35 |
| A210 Bastion | 210 | 1.72 | 3.29 | 0.33 | 0.50 | 5.3× | 1.81 → 0.54 |
| H211 Hammerhead | 211 | 1.16 | 1.90 | 0.35 | 0.72 | 3.3× | 1.31 → 0.45 |
| M245 Maw titan (grouped) | 245 | 1.99 | 3.39 | 1.05 | 1.84 | 1.9× | 2.53 → 1.88 |
| A500 | 500 | 3.97 | 8.16 | 0.76 | 1.24 | 5.2× | 4.29 → 1.27 |
| A1000 | 1000 | 14.12 | 24.32 | 1.43 | 2.03 | 9.9× | 14.1 → 1.38 |
| B500 (ports) | 500 | 5.15 | 9.58 | 1.21 | 2.50 | 4.3× | 5.48 → 2.31 |
| B1000 (ports) | 1000 | 13.36 | 24.20 | 2.45 | 3.73 | 5.5× | 11.5 → 1.93 |

The first ship of a design ever built costs what it did before (one full cast, now kept for the design).

What's left at 1,000 parts (A1000, about 1.4 ms):

- wire networks, 0.3 ms (`layoutKey` and the union-find every rebuild);
- the structure pass, 0.2 ms (`floodFill` and `components` rebuild their adjacency on every call, and a split runs the
  pass twice: once to look ahead, once in the rebuild);
- the power layout, 0.16 ms;
- the turret recasts, 0.14 ms;
- the cell map, 0.1 ms, when an engine is blocked.

All of these are roughly linear now.

## A fight: four of them, AI-flown, against four pilots, 20 s

This is the large-ships audit's `bench2` (a full GameServer, netCaps 15). The fight is seeded, so it is the same fight
before and after: **parts lost and rebuild counts are identical**. The rebuild columns are the bridge's rebuild timer,
and `rebuildNow` wraps the whole rebuild point (debris spawns included). The old timer missed a split's second rebuild,
so the `rebuildNow` column is the fair comparison.

| Design | Parts lost | Tick mean ms before → after | p95 | p99 | Ticks over 16.7 ms | rebuildNow µs/tick | ShipBridge.tick µs |
|---|---|---|---|---|---|---|---|
| A210 | 10 | 2.08 → 2.47 (paired rerun 2.71 → 2.62) | 4.05 → 5.06 | 5.39 → 10.8 | 0 → 3 | 202 → 136 | 795 → 870 |
| A500 | 72 | 3.49 → 2.96 | 8.04 → 6.27 | 11.8 → 9.98 | 1 → 1 | 1,108 → 341 | 1,818 → 1,132 |
| **A1000** | 116 | **9.66 → 5.54** | 29.2 → 12.5 | 37.2 → 20.3 | **356 → 23** | **5,746 → 984** | 6,614 → 2,001 |
| B500 | 120 | 3.02 → 2.92 | 8.92 → 6.90 | 15.2 → 12.6 | 6 → 5 | 1,120 → 483 | 1,743 → 1,294 |
| **B1000** | 76 | **4.36 → 2.95** | 16.1 → 7.02 | 28.6 → 13.9 | **43 → 6** | 2,420 → 651 | 3,088 → 1,450 |

- At 210 parts the rebuild was already small (0.2 ms a tick), so the tick is mostly noise. In the first runs every
  system that doesn't touch rebuilds (snapshots, AI, collisions) also ran 10-25% slower in the "after" run. A paired
  rerun, before and after back to back, gave 2.71 → 2.62 ms.
- The few A210 ticks over budget after the change are single GC-like spikes. A third run had none.
- At 1,000 parts the rebuild no longer dominates. What's left of the A1000 tick is collisions (1.3 ms), snapshots
  (1.1 ms) and the hit tests.

## Parity

- **common/src/ships/rebuildMemo.test.ts** (new, about 20 s). Every design under data/ships/blueprints (about 130, up to 245
  parts) goes through seeded sequences: losses (the core too), blasts of three, sheds (detached), band hits, regrown
  parts, full repairs, ghosts on and off, and rebuilds with nothing changed.
  - Big designs get 3 runs each, and debris (`rootMode: 'largest'`) is covered too.
  - After every step, the whole ShipState is deep-equal (strict) to one rebuilt the old way: the design worked out anew,
    every ray and lane cast afresh (`fresh: true`), and a split rebuilt twice. The groups that broke off and the
    `(rebuilds, com, root)` each rebuild noted are also equal.
  - It also covers: a hand-made ship with a blocked Torch (no library design has a blocked engine); a client's
    crumbling debris; a client synced mid-fight against the server's copy; a blueprint edited in place; and each turret
    window against `computeTurretWindow`.
  - Mutations tried, each one caught: reusing any carried-on window, treating any exhaust as clear, and skipping the
    "parts only went" check.
- **The bench**: a SHA-256 of every derived structure and detached list after every loss, for all 9 designs above (A500,
  A1000, B500 and B1000 included). It is the same before and after.
- **The goldens and determinism tests**: frameHash, parity, structure, hitRules golden, flightTraces, sim (all of
  common/src/sim), debrisLives, debrisAcks, and the ships tests (common, server and client). They all pass except
  frameHash.
  - frameHash already fails on the refactor/split head, before this change: its `stream` hashes at tick 100 differ from
    the committed golden; the world hash matches.
  - I ran it with `UPDATE_GOLDEN=1` on the old code and on the new and compared the two outputs. They are
    byte-identical at every checkpoint.

## Open

- **The free side of a shortened ray isn't recast.** When the ship shrinks, its rays are cast shorter. A ray that was
  open is kept open without being recast. That is exact in arithmetic: a part inside the shorter ray was inside the
  longer one. In floating point, a different ray end could in principle flip a ray that grazes a part's corner to the
  last bit. None turned up in the tests or the benches. If one ever matters, recast the open rays whenever `reach`
  changes, which costs about a quarter of what was saved.
- **Grouped designs** (custom enemies with group pieces, such as the Maw titan) still rebuild twice on a split.
- **The server's own caches.** bridge/rebuild.ts `geometry` / `joinsOf` keep their own per-blueprint geometry and
  joins, which duplicates design.ts. I left them alone to keep the merge with the netcode work small. They could read
  `designOf` instead.
- **Memory.** Each turret's frame holds n floats and n bytes (n: the design's parts). It is kept once per design, shared by
  every ship of it, and freed with the blueprint. A debris piece's blueprint is new each time, so its first
  rebuild costs a full cast as before.
