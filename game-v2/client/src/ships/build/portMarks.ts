/**
 * @contract client.ships.port-marks
 * owns:       build-view port marks shared by the hangar and the world build view: where a placed part's power ports and feed
 *             points sit (cell edge, outward direction) and the small OUT / IN / feed glyphs for them, as pure grid-space geometry
 * needs:      common frameOf / placeEdge (the ports core's own port placement), registeredFunction
 * invariants: every mark sits where buildPortsLayout puts the port (same rot / flip / facing frame) — client/src/ships/build/portMarks.test.ts
 *             marks only draw, never change a design — none pinned
 * extend:     a new kind of port is one more case in portMarks(); a canvas or pixi drawer reuses PortMark.poly and PORT_COLOR
 */

import { frameOf, placeEdge, registeredFunction, SIDE_NORMAL, type PlacedPart, type PlacedGeom, type Side, type Vec2 } from '@space-game/common';

export type PortKind = 'out' | 'in' | 'feed';
/** A port glyph in grid cells: the cell it sits on, the world side of that cell, the unit direction out of that side, the edge midpoint and the glyph's points */
export interface PortMark { kind: PortKind; cell: Vec2; side: Side; dir: Vec2; at: Vec2; poly: Vec2[] }

/** OUT warm, IN cool, feed green */
export const PORT_COLOR: Record<PortKind, number> = { out: 0xffa24a, in: 0x5fb8ff, feed: 0x6ee7a0 };

const LEN = 0.3, HALF = 0.15;

function glyph(kind: PortKind, at: Vec2, dir: Vec2): Vec2[] {
  const [ax, ay] = at, [dx, dy] = dir, px = -dy, py = dx;
  // (OUT: base on the edge, tip outside, pointing out of the part)
  if (kind === 'out') return [[ax + px * HALF, ay + py * HALF], [ax + dx * LEN, ay + dy * LEN], [ax - px * HALF, ay - py * HALF]];
  // (IN: inside the cell, base on the edge, tip pointing into the part)
  if (kind === 'in') { const k = 0.8; return [[ax + px * HALF * k, ay + py * HALF * k], [ax - dx * LEN * k, ay - dy * LEN * k], [ax - px * HALF * k, ay - py * HALF * k]]; }
  // (a feed point: a small diamond sitting on the edge)
  const r = 0.12;
  return [[ax + dx * r, ay + dy * r], [ax + px * r, ay + py * r], [ax - dx * r, ay - dy * r], [ax - px * r, ay - py * r]];
}

/**
 * The marks of a placed part's ports: out ports (power leaves), in ports (power arrives; a gun's augment input too) and feed
 * points, placed by the ports core's own frame. Touch-routed parts (legacy enemy functions) have none.
 */
export function portMarks(part: PlacedPart, geom: PlacedGeom): PortMark[] {
  const fn = registeredFunction(part.fn);
  if (!fn || fn.touch) return [];
  const specs: { kind: PortKind; side: Side; cell: number }[] = [];
  for (const q of fn.ports ?? []) specs.push({ kind: q.dir, side: q.side, cell: q.cell ?? 0 });
  if (fn.augment) specs.push({ kind: 'in', side: fn.augment.side, cell: fn.augment.cell ?? 0 });
  for (const q of fn.feedPoints ?? []) specs.push({ kind: 'feed', side: q.side, cell: q.cell ?? 0 });
  if (fn.feedPort) specs.push({ kind: 'feed', side: fn.feedPort.side, cell: fn.feedPort.cell ?? 0 });
  if (!specs.length) return [];
  const F = frameOf(part, geom.cells);
  const out: PortMark[] = [];
  for (const s of specs) {
    const e = placeEdge(part, F, s.side, s.cell);
    // (a port past the piece's side lands on its last cell: a second one there is the same port, once)
    if (out.some((o) => o.cell[0] === e.x && o.cell[1] === e.y && o.side === e.side && o.kind === s.kind)) continue;
    const n = SIDE_NORMAL[e.side];
    const at: Vec2 = [e.x + 0.5 + n[0] * 0.5, e.y + 0.5 + n[1] * 0.5];
    out.push({ kind: s.kind, cell: [e.x, e.y], side: e.side, dir: [n[0], n[1]], at, poly: glyph(s.kind, at, [n[0], n[1]]) });
  }
  return out;
}

/** Port glyphs on a pixi Graphics (`toScreen` maps grid to screen); `alpha` low for placed parts, high for the one in hand or hovered */
export function drawPortMarks(g: import('pixi.js').Graphics, part: PlacedPart, geom: PlacedGeom, toScreen: (gx: number, gy: number) => { x: number; y: number }, scale: number, alpha: number): void {
  for (const m of portMarks(part, geom)) {
    const flat: number[] = [];
    for (const [x, y] of m.poly) { const p = toScreen(x, y); flat.push(p.x, p.y); }
    g.poly(flat).fill({ color: PORT_COLOR[m.kind], alpha }).stroke({ color: 0x0b1220, width: Math.max(1, scale * 0.025), alpha: alpha * 0.6 });
  }
}
