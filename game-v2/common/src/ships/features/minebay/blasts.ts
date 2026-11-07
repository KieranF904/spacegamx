/**
 * Mine detonations worked out on every end (docs/design/groups-mines-docking.md 2.4, stage M2). The server decides
 * them and deals the damage (server ships/features/minebay/Minefield.ts); a client finds the ones it can find exactly
 * on its tick-faithful layer, from the drop records (minebay.ts minePos, mineArmed) and the ships' exact poses, and
 * the server tells it only the rest. Both ends use these rules, so they agree:
 *
 *   who      a ship a client may find setting a mine off: one a pilot may hurt that is not a pilot
 *            (`mineFindable`: hitRules.ts sidesHurt is 1). A pilot setting one off (PvP zones, parties) is the
 *            server's to tell; so is anything the server alone knows (a dormant or jumping ship, a berthed owner)
 *   where    an armed mine at rest (armed mines are always at rest: armTicks > slideTicks), a ship's bounding circle
 *            within triggerReach (minebay.ts mineTouches), the ship where it is on the tick's trigger pass: a pilot
 *            after its move that tick, any other ship at the end of the tick before (as the collision step has them)
 *   which    on one tick each mine is set off by the touching ship with the lowest id
 *
 * Pure, and allocation-light per tick (MineBuckets reuses its cells).
 */

import { SIDE, sidesHurt } from '../../hitRules.js';
import { MINES, mineArmed, mineId, minePos, mineTouches, type MineDrop } from './minebay.js';

/**
 * The longest snapshot window a client searches itself (client ships/hits/SelfHits.detect: its hits and its mines'
 * blasts); in a longer one (a stall, a lull with nothing to send) the server tells everything that happened in it
 */
export const SEARCH_WINDOW_MAX = 120;

/**
 * May a client find a ship of side `side` (hitRules.ts SIDE bits, as that client knows it) setting off a pilot's mine?
 * Only a ship a pilot may hurt that isn't a pilot: not another pilot (the server's PvP zones and parties), a ward, a
 * berthed ship or a person's craft
 */
export function mineFindable(side: number): boolean {
  return sidesHurt(SIDE.PILOT, side) === 1;
}

/** Where mine i of a drop rests (where an armed mine is) */
export function mineRest(d: Readonly<MineDrop>, i: number, out: [number, number] = [0, 0]): [number, number] {
  return minePos(d, i, d.tick + MINES.slideTicks, out);
}

/** Buckets of world units the trigger pass files armed mines in */
const CELL = 256;
/** A bucket's key from its cell coordinates (each within +-2^20 cells) */
const cellKey = (cx: number, cy: number) => (cx + 0x100000) * 0x200000 + (cy + 0x100000);

/**
 * Armed mines filed by where they rest, so a ship finds the ones it could touch without walking them all. The one
 * trigger geometry both ends use: `touching` visits each mine a ship's bounding circle is within reach of
 */
export class MineBuckets<T> {
  private readonly cells = new Map<number, { ref: T; x: number; y: number }[]>();
  private readonly spare: { ref: T; x: number; y: number }[][] = [];
  size = 0;

  clear(): void {
    for (const b of this.cells.values()) { b.length = 0; this.spare.push(b); }
    this.cells.clear();
    this.size = 0;
  }

  add(ref: T, x: number, y: number): void {
    const key = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
    let b = this.cells.get(key);
    if (!b) this.cells.set(key, (b = this.spare.pop() ?? []));
    b.push({ ref, x, y });
    this.size++;
  }

  /** Each mine filed here that a ship (centre, bounding radius) touches (mineTouches), in the order filed per bucket */
  touching(x: number, y: number, radius: number, visit: (ref: T) => void): void {
    if (!this.size) return;
    const reach = radius + MINES.triggerReach;
    const c0 = Math.floor((x - reach) / CELL), c1 = Math.floor((x + reach) / CELL);
    const r0 = Math.floor((y - reach) / CELL), r1 = Math.floor((y + reach) / CELL);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cy = r0; cy <= r1; cy++) {
        const b = this.cells.get(cellKey(cx, cy));
        if (!b) continue;
        for (let k = 0; k < b.length; k++) if (mineTouches(b[k].x, b[k].y, x, y, radius)) visit(b[k].ref);
      }
    }
  }
}

/** A drop as a client's search sees it: its record, and the tick each mine was known gone on (undefined: live) */
export interface SearchDrop {
  readonly d: Readonly<MineDrop>;
  /** Mine i is out of the search from this tick on (gone, told or found; or told to this client only: -Infinity) */
  goneFrom(i: number): number;
}

/** What a search needs of the ships: their ids, and each one's side, bounding radius and exact pose on a tick */
export interface SearchShips {
  /** The ships whose poses are exact this window (the tick layer's: SelfHits' targets) */
  readonly ids: readonly number[];
  side(id: number): number;
  /** Its bounding radius on tick k (its structure then); undefined: none */
  radius(id: number, k: number): number | undefined;
  /** Its exact pose at the end of tick t; null: none */
  at(id: number, t: number): { x: number; y: number } | null;
}

/** A blast a search found: mine i of a drop went off on `tick`, set off by `by` */
export interface FoundBlast { drop: SearchDrop; i: number; id: number; tick: number; by: number }

/**
 * A client's search of one window (ticks from+1 .. to), in tick order: each armed live mine a findable ship touches
 * on a tick goes off then, set off by the lowest id touching it. A mine found goes from the search (it went off once)
 */
export function findMineBlasts(drops: readonly SearchDrop[], from: number, to: number, ships: SearchShips, out: FoundBlast[] = []): FoundBlast[] {
  out.length = 0;
  if (!drops.length || !ships.ids.length || to <= from) return out;
  const grid = SEARCH_GRID as MineBuckets<number>;
  const refs: { drop: SearchDrop; i: number; x: number; y: number; by: number; done: boolean }[] = [];
  for (const drop of drops) {
    for (let i = 0; i < drop.d.n; i++) {
      const [x, y] = mineRest(drop.d, i);
      refs.push({ drop, i, x, y, by: -1, done: false });
    }
  }
  if (!refs.length) return out;
  const findable = ships.ids.filter((id) => mineFindable(ships.side(id)));
  if (!findable.length) return out;
  for (let k = from + 1; k <= to; k++) {
    grid.clear();
    for (let r = 0; r < refs.length; r++) {
      const m = refs[r];
      if (m.done || !mineArmed(m.drop.d, k) || k >= m.drop.goneFrom(m.i)) continue;
      m.by = -1;
      grid.add(r, m.x, m.y);
    }
    if (!grid.size) continue;
    for (const id of findable) {
      // (not a pilot: where it was at the end of the tick before, as the server's pass has it)
      const p = ships.at(id, k - 1), radius = p ? ships.radius(id, k) : undefined;
      if (!p || radius === undefined) continue;
      grid.touching(p.x, p.y, radius, (r) => {
        const m = refs[r];
        if (id !== m.drop.d.owner && (m.by < 0 || id < m.by)) m.by = id;
      });
    }
    for (let r = 0; r < refs.length; r++) {
      const m = refs[r];
      if (m.done || m.by < 0 || !mineArmed(m.drop.d, k) || k >= m.drop.goneFrom(m.i)) continue;
      m.done = true;
      out.push({ drop: m.drop, i: m.i, id: mineId(m.drop.d.owner, m.drop.d.tick, m.i), tick: k, by: m.by });
      m.by = -1;
    }
  }
  return out;
}
const SEARCH_GRID = new MineBuckets<number>();
