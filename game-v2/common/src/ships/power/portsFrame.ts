/**
 * @contract power.ports-frame
 * owns:       the frame a part's ports, sockets and feed points are given in (frameOf) and an edge point placed on the
 *             grid (placeEdge). A leaf: portsBuild and portsMods both read it
 * needs:      common/ships catalog (transformPoint, transformSide)
 * invariants: a placed port sits where the layout joins it — common/src/ships/power/ports.test.ts
 * extend:     nothing here knows a part's role; a new port kind is portsBuild's
 */
import type { PlacedPart, Rot, Side, Vec2 } from '../types.js';
import { SIDE_NORMAL, transformPoint, transformSide } from '../catalog.js';

const SIDE_ORDER: readonly Side[] = ['N', 'E', 'S', 'W'];

/**
 * The frame a part's ports and feed points are given in: its piece's own (rot, flip), or, for a part with a facing (a gun,
 * an engine), the frame whose N is that facing, so "S" is always its back. `cells` are the part's cells in that frame
 * (the piece's cells, un-placed: a rectangle from its own origin for the rectangular pieces)
 */
export interface PartFrame { rot: Rot; flip: boolean; cells: Vec2[] }
export function frameOf(part: PlacedPart, placed: readonly Vec2[]): PartFrame {
  const rot = (part.facing ? SIDE_ORDER.indexOf(part.facing) : part.rot) as Rot, flip = part.flip, inv = ((4 - rot) % 4) as Rot;
  const cells: Vec2[] = placed.map((c) => {
    const p = transformPoint([c[0] - part.x + 0.5, c[1] - part.y + 0.5], inv, false);
    return [Math.floor(flip ? 1 - p[0] : p[0]), Math.floor(p[1])];
  });
  return { rot, flip, cells };
}
/** A part's edge point (its frame) placed: the cell it sits on, its side and the cell across, in grid coordinates */
export function placeEdge(part: PlacedPart, F: PartFrame, side: Side, cell: number): { x: number; y: number; side: Side; nx: number; ny: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of F.cells) { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; }
  const k = Math.max(0, cell);
  const lx = side === 'W' ? x0 : side === 'E' ? x1 : Math.min(x1, x0 + k), ly = side === 'N' ? y0 : side === 'S' ? y1 : Math.min(y1, y0 + k);
  const c = transformPoint([lx + 0.5, ly + 0.5], F.rot, F.flip);
  const x = Math.floor(c[0]) + part.x, y = Math.floor(c[1]) + part.y;
  const ws = transformSide(side, F.rot, F.flip), nrm = SIDE_NORMAL[ws];
  return { x, y, side: ws, nx: x + nrm[0], ny: y + nrm[1] };
}
