/**
 * The focus grid (CAPS.FOCUS, protocol 38; docs/design/awareness-model.md section 0): each system is cut into fixed
 * square cells, CELL_SIZE a side, origin at the system's centre. Every ship has one home cell (where it is, changed only
 * once it is CELL_HOME_SLACK past the border). A client's **focus** is every cell whose nearest point is within
 * FOCUS_RANGE of its ship (one flat threshold, no hysteresis, whatever the zoom): the ships homed there are on its tick
 * layer. Its **ring** is every other cell within RING_RANGE: ghosts only (map-dot legs), nothing simulated.
 *
 * A ship leaving a client's view (its cell left the focus, or it left the cell) is remembered at both ends for minutes
 * (AwayShips): when it comes back the client is sent only what changed since it left (a keyframe always, its row, HP and
 * structure only if they changed), never replayed. Nothing here is on a simulation path: it is what is sent, never how
 * anything moves.
 */
/** A cell's side (world units): 2^13 */
export const CELL_SIZE = 8192;
/** A cell is in a client's focus when its nearest point is within this of the client's ship */
export const FOCUS_RANGE = 19000;
/** ...and in its ring (ghosts) within this */
export const RING_RANGE = 35000;
/** The client draws ships as ghosts from here out (by distance, drawing only: nothing on the wire depends on it) */
export const GHOST_FADE_FROM = 18000;
/** ...fully a ghost from here */
export const GHOST_FADE_TO = 19000;
/** A ship's home cell changes only once it is this far into the next */
export const CELL_HOME_SLACK = 256;

/** Cell coordinates are offset by this in a key (a system is far smaller than ±4096 cells: ±33,000 km) */
const OFF = 4096;
const SPAN = 8192;

/** A cell's key (one number: cheap to put in a set or on the wire) */
export function focusCellKey(cx: number, cy: number): number {
  return (cx + OFF) * SPAN + (cy + OFF);
}

/** A key's cell coordinates */
export function focusCellXY(key: number): [number, number] {
  return [Math.floor(key / SPAN) - OFF, (key % SPAN) - OFF];
}

/** The cell a coordinate is in (along one axis) */
export function cellCoord(v: number): number {
  return Math.floor(v / CELL_SIZE);
}

/** The cell a point is in */
export function cellAt(x: number, y: number): number {
  return focusCellKey(cellCoord(x), cellCoord(y));
}

/**
 * A ship's home cell now, given the one it had (undefined: none yet): the same while it is within CELL_HOME_SLACK of
 * that cell, otherwise the cell it is in
 */
export function homeCell(prev: number | undefined, x: number, y: number): number {
  if (prev !== undefined) {
    const [cx, cy] = focusCellXY(prev);
    const x0 = cx * CELL_SIZE - CELL_HOME_SLACK, y0 = cy * CELL_SIZE - CELL_HOME_SLACK, s = CELL_SIZE + 2 * CELL_HOME_SLACK;
    if (x >= x0 && x < x0 + s && y >= y0 && y < y0 + s) return prev;
  }
  return cellAt(x, y);
}

/** How far (squared) a point is from a cell's nearest point (0 inside it) */
export function cellDist2(key: number, x: number, y: number): number {
  const [cx, cy] = focusCellXY(key);
  const x0 = cx * CELL_SIZE, y0 = cy * CELL_SIZE;
  const dx = x < x0 ? x0 - x : x > x0 + CELL_SIZE ? x - x0 - CELL_SIZE : 0;
  const dy = y < y0 ? y0 - y : y > y0 + CELL_SIZE ? y - y0 - CELL_SIZE : 0;
  return dx * dx + dy * dy;
}

/** Every cell whose nearest point is within `range` of (x, y), in key order (`out` is cleared and returned) */
export function cellsNear(x: number, y: number, range: number, out: number[] = []): number[] {
  out.length = 0;
  const r2 = range * range;
  const cx0 = cellCoord(x - range), cx1 = cellCoord(x + range), cy0 = cellCoord(y - range), cy1 = cellCoord(y + range);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const k = focusCellKey(cx, cy);
      if (cellDist2(k, x, y) <= r2) out.push(k);
    }
  }
  return out;
}

/** A client's focus cells round its ship (`range`: its focus radius, less than FOCUS_RANGE in a crowd: network/crowd.ts) */
export function focusCells(x: number, y: number, out?: number[], range = FOCUS_RANGE): number[] {
  return cellsNear(x, y, range, out);
}

/** ...and its ring: within RING_RANGE and not in the focus (of radius `range`) */
export function ringCells(x: number, y: number, out: number[] = [], range = FOCUS_RANGE): number[] {
  cellsNear(x, y, RING_RANGE, out);
  const f2 = range * range;
  let n = 0;
  for (const k of out) if (cellDist2(k, x, y) > f2) out[n++] = k;
  out.length = n;
  return out;
}

/**
 * How much of a ghost a ship this far from the client's own is drawn as (0 not at all, 1 fully): drawing only. `focus`:
 * the focus radius in effect (a crowd shrinks it, network/crowd.ts); the fade runs over the last km inside it
 */
export function ghostWeight(dist: number, focus = FOCUS_RANGE): number {
  const to = focus - FOCUS_RANGE + GHOST_FADE_TO, from = focus - FOCUS_RANGE + GHOST_FADE_FROM;
  return dist <= from ? 0 : dist >= to ? 1 : (dist - from) / (to - from);
}

// ---- Ships away: out of a client's view and remembered at both ends ----

/** A ship that left a client's view is remembered (both ends) this long after it left (ticks: 5 minutes) */
export const AWAY_TICKS = 5 * 60 * 60;
/** ...and at most this many at once (the one that left first is let go first) */
export const AWAY_CAP = 256;

/**
 * Ships out of a client's view that both ends remember (CAPS.FOCUS): the client keeps each one's structure and status
 * row, the server what it last sent of it (its sync, part HP, row, name). Both keep the same list by the same rule, fed
 * the same changes in the same order (the `cells` message before a snapshot: `b` back, then `k` kept; the snapshot's
 * removals), so neither has to tell the other what it let go: each sweeps by age (`sweep`, at the tick of the round or
 * message) and caps by count (`leave`), the oldest first. Insertion order is leaving order, so ages run oldest first.
 */
export class AwayShips<T> {
  private m = new Map<number, { tick: number; v: T }>();

  get size(): number {
    return this.m.size;
  }

  has(id: number): boolean {
    return this.m.has(id);
  }

  get(id: number): T | undefined {
    return this.m.get(id)?.v;
  }

  ids(): IterableIterator<number> {
    return this.m.keys();
  }

  /** Left its view with the snapshot of `tick`; past the cap the oldest go (`gone` each) */
  leave(id: number, tick: number, v: T, gone?: (id: number, v: T) => void): void {
    this.m.delete(id);
    this.m.set(id, { tick, v });
    while (this.m.size > AWAY_CAP) {
      const [first, e] = this.m.entries().next().value as [number, { tick: number; v: T }];
      this.m.delete(first);
      gone?.(first, e.v);
    }
  }

  /** Back in view, or gone: no longer away (what was kept of it) */
  take(id: number): T | undefined {
    const e = this.m.get(id);
    if (!e) return undefined;
    this.m.delete(id);
    return e.v;
  }

  /** Let go of what left more than AWAY_TICKS before `tick` (`gone` each) */
  sweep(tick: number, gone?: (id: number, v: T) => void): void {
    for (const [id, e] of this.m) {
      if (tick - e.tick <= AWAY_TICKS) break;
      this.m.delete(id);
      gone?.(id, e.v);
    }
  }

  clear(gone?: (id: number, v: T) => void): void {
    if (gone) for (const [id, e] of this.m) gone(id, e.v);
    this.m.clear();
  }
}

