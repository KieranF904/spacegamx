/**
 * @contract client.ships.build-drag-paint
 * owns:       the drag-to-paint walk shared by the hangar and the world build view: the grid cells a cursor passes between two
 *             points, and the once-per-cell rule for one held-button drag
 * needs:      common Vec2 (a type only)
 * invariants: a cell is handed out at most once per drag, in path order, and a fast drag skips none — client/src/ships/build/dragPaint.test.ts
 *             it only walks cells; whether a part can go or be taken there stays with each editor's own rules — none pinned
 * extend:     an editor starts a DragPaint on mouse down (after acting on the clicked cell) and calls visit() on each mouse move
 */

import type { Vec2 } from '@space-game/common';

/** A drag longer than this many cells in one step is cut short (a runaway guard, not a limit anyone meets) */
const MAX_STEP_CELLS = 400;
/** How far inside a cell its entry point is nudged, so flooring it can't land in the cell before */
const INSIDE = 1e-6;

/**
 * The cells a straight segment crosses, in order from `a`'s cell to `b`'s, each as a point on the segment inside that cell
 * (the first is `a` itself, the last `b`). Grid cells are unit squares, a point's cell is Math.floor of each coordinate.
 */
export function cellsAlong(a: Vec2, b: Vec2): Vec2[] {
  let cx = Math.floor(a[0]), cy = Math.floor(a[1]);
  const ex = Math.floor(b[0]), ey = Math.floor(b[1]);
  const out: Vec2[] = [[a[0], a[1]]];
  if (cx === ex && cy === ey) return out;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const sx = Math.sign(dx), sy = Math.sign(dy);
  // t (0..1 along the segment) at the next vertical / horizontal grid line, and the t between lines
  let tx = sx === 0 ? Infinity : ((sx > 0 ? cx + 1 : cx) - a[0]) / dx;
  let ty = sy === 0 ? Infinity : ((sy > 0 ? cy + 1 : cy) - a[1]) / dy;
  const stx = sx === 0 ? Infinity : Math.abs(1 / dx);
  const sty = sy === 0 ? Infinity : Math.abs(1 / dy);
  for (let n = 0; n < MAX_STEP_CELLS && (cx !== ex || cy !== ey); n++) {
    let t: number;
    if (tx < ty) { t = tx; tx += stx; cx += sx; }
    else if (ty < tx) { t = ty; ty += sty; cy += sy; }
    else { t = tx; tx += stx; ty += sty; cx += sx; cy += sy; } // exactly through a corner
    const px = Math.min(cx + 1 - INSIDE, Math.max(cx + INSIDE, a[0] + dx * t));
    const py = Math.min(cy + 1 - INSIDE, Math.max(cy + INSIDE, a[1] + dy * t));
    out.push([px, py]);
  }
  // (The last cell holds the true end point)
  if (Math.floor(out[out.length - 1][0]) === ex && Math.floor(out[out.length - 1][1]) === ey) out[out.length - 1] = [b[0], b[1]];
  else out.push([b[0], b[1]]);
  return out;
}

/** One held-button drag: remembers the cells it has been over so each is handed out once */
export class DragPaint {
  private seen = new Set<string>();
  private last: Vec2;

  /** `start` is the cell the press landed on: the editor has already acted there, so it counts as visited */
  constructor(start: Vec2) {
    this.last = [start[0], start[1]];
    this.seen.add(key(start));
  }

  /** The points (one per cell) the cursor passed over since the last call, never a cell seen before in this drag */
  visit(to: Vec2): Vec2[] {
    const path = cellsAlong(this.last, to);
    this.last = [to[0], to[1]];
    const fresh: Vec2[] = [];
    for (const p of path) {
      const k = key(p);
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      fresh.push(p);
    }
    return fresh;
  }
}

function key(p: Vec2): string {
  return `${Math.floor(p[0])},${Math.floor(p[1])}`;
}
