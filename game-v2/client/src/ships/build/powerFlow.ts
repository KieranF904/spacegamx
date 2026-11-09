/**
 * @contract client.ships.build-power-flow
 * owns:       the power flow overlay's data for a design, shared by the hangar and the world build view: the line each link
 *             draws and how hard it is carrying, a marker per port (and a tick or cross for how it meets), the parts that
 *             get less power than they draw, and where the moving pulses sit on a line at a time
 * needs:      common portsView / PS_* port states (the ports core's own link resolution), PortsLoadResult (its flows), SIDE_NORMAL;
 *             portsReport (which consumers nothing feeds)
 * invariants: it reads the ports core's links and the load test's flows and adds no routing rule of its own — client/src/ships/build/powerFlow.test.ts
 *             a link with a good meeting gets a tick, an out facing nothing, an in with no source or a clash gets a cross — client/src/ships/build/powerFlow.test.ts
 *             pulses stay on their line and move with time — client/src/ships/build/powerFlow.test.ts
 * extend:     a new thing to flag is one more PortMark kind in portMarks(); how it is drawn is powerFlowView.ts
 */

import type { PortsLoadResult, ShipDerived, Side, Vec2 } from '@space-game/common';
import { PS_CLASH, PS_LINKED, PS_OPEN, PS_WASTE, SIDE_NORMAL, portsView } from '@space-game/common';
import { portsReport } from '../portsReport';

/** How deep a port glyph reaches into its cell from the edge (cells) */
const DEPTH = 0.2, HALF_W = 0.17;

/** One link's line, in grid cells, from the out port into the in port's cell */
export interface FlowSegment {
  id: number;
  from: number;
  to: number;
  x0: number; y0: number; x1: number; y1: number;
  /** E/s it carried in the test (or its cap with no test), and its cap */
  flow: number;
  cap: number;
  /** 0..1 how full the link ran */
  load: number;
  /** Carries something at all */
  live: boolean;
  aug: boolean;
  /** A touch link (part to part, no ports) */
  touch: boolean;
}

export type MarkKind = 'port' | 'tick' | 'cross';
export interface PortMark {
  kind: MarkKind;
  part: number;
  /** Where it sits (grid cells): a port's glyph centre, a tick on the edge two ports meet at, a cross over the bad port */
  x: number;
  y: number;
  side: Side;
  dir: 0 | 1;
  /** The port's state (PS_*) */
  state: number;
  aug: boolean;
}

export interface PartTint {
  part: number;
  /** Share of what it draws it gets (0 for nothing feeds it) */
  share: number;
  none: boolean;
}

export interface PowerFlow {
  segments: FlowSegment[];
  marks: PortMark[];
  tints: PartTint[];
  /** Counts for the legend: good meetings, bad ports, parts short */
  ticks: number;
  crosses: number;
  short: number;
}

/** A port's glyph centre (grid cells): in its cell, just inside the edge */
export function glyphAt(x: number, y: number, side: Side): Vec2 {
  const n = SIDE_NORMAL[side], k = 0.5 - DEPTH / 2;
  return [x + 0.5 + n[0] * k, y + 0.5 + n[1] * k];
}

/** The middle of a cell's edge (grid cells) */
export function edgeAt(x: number, y: number, side: Side): Vec2 {
  const n = SIDE_NORMAL[side];
  return [x + 0.5 + n[0] * 0.5, y + 0.5 + n[1] * 0.5];
}

/** A port glyph's three corners (grid cells), scaled: an out port points out of the part, an in port points in */
export function portTriangle(m: Pick<PortMark, 'x' | 'y' | 'side' | 'dir'>, scale = 1): [Vec2, Vec2, Vec2] {
  const n = SIDE_NORMAL[m.side], tx = -n[1], ty = n[0];
  const e = edgeAt(m.x, m.y, m.side), d = DEPTH * scale, w = HALF_W * scale;
  const apex: Vec2 = m.dir === 1 ? [e[0] + n[0] * 0.02, e[1] + n[1] * 0.02] : [e[0] - n[0] * d, e[1] - n[1] * d];
  const b: Vec2 = m.dir === 1 ? [e[0] - n[0] * d, e[1] - n[1] * d] : [e[0] - n[0] * 0.02, e[1] - n[1] * 0.02];
  return [apex, [b[0] + tx * w, b[1] + ty * w], [b[0] - tx * w, b[1] - ty * w]];
}

/**
 * The flow of a ports design. `r` is a load test's result for it (its per-link flows and per-part shares), or null for
 * the design's ratings alone. Null for a design with no ports layout.
 */
export function powerFlow(d: ShipDerived | null, r: PortsLoadResult | null): PowerFlow | null {
  const L = d?.ports;
  if (!L) return null;
  const pv = portsView(L);
  const segments: FlowSegment[] = [];
  for (const l of pv.links) {
    const f = r ? r.flow[l.id] ?? 0 : l.cap, cap = l.cap;
    let x0: number, y0: number, x1: number, y1: number, touch = false;
    if (l.at) {
      const n = SIDE_NORMAL[l.at.side];
      x0 = l.at.x + 0.5 - n[0] * 0.15; y0 = l.at.y + 0.5 - n[1] * 0.15; x1 = l.at.x + 0.5 + n[0] * 1.15; y1 = l.at.y + 0.5 + n[1] * 1.15;
    } else {
      // (a touch link has no ports: part to part, between the parts' centres, which the drawer supplies)
      x0 = y0 = x1 = y1 = NaN; touch = true;
    }
    segments.push({ id: l.id, from: l.from, to: l.to, x0, y0, x1, y1, flow: f, cap, load: cap > 0 ? Math.min(1, f / cap) : 0, live: f > 0.05, aug: !!l.aug, touch });
  }
  const marks: PortMark[] = [];
  let ticks = 0, crosses = 0;
  for (const p of pv.ports) {
    const g = glyphAt(p.x, p.y, p.side);
    marks.push({ kind: 'port', part: p.part, x: g[0], y: g[1], side: p.side, dir: p.dir, state: p.state, aug: !!p.aug });
    // (one tick per link, on the out port's edge; a cross on every port that meets nothing useful)
    if (p.state === PS_LINKED && p.dir === 1) {
      const e = edgeAt(p.x, p.y, p.side);
      marks.push({ kind: 'tick', part: p.part, x: e[0], y: e[1], side: p.side, dir: 1, state: PS_LINKED, aug: false });
      ticks++;
    } else if (p.state === PS_OPEN || p.state === PS_WASTE || p.state === PS_CLASH) {
      const e = edgeAt(p.x, p.y, p.side);
      marks.push({ kind: 'cross', part: p.part, x: e[0], y: e[1], side: p.side, dir: p.dir, state: p.state, aug: false });
      crosses++;
    }
    // (a store's or a line's port facing nothing is harmless: no verdict)
  }
  const tints: PartTint[] = [];
  const seen = new Set<number>();
  for (const i of portsReport(L).unfed) { tints.push({ part: i, share: 0, none: true }); seen.add(i); }
  if (r) for (let i = 0; i < L.n; i++) if (!seen.has(i) && r.used[i] && r.end[i] < 0.995) tints.push({ part: i, share: Math.max(0, r.end[i]), none: false });
  return { segments, marks, tints, ticks, crosses, short: tints.length };
}

/** Where the moving pulses sit on a line at time `t` (s): fewer and slower on a light link, more and faster on a full one. Empty for a dead or touch link */
export function pulsesOn(s: FlowSegment, t: number): Vec2[] {
  if (!s.live || s.touch) return [];
  const n = 1 + Math.round(s.load * 2), speed = 0.7 + 1.3 * s.load, len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) || 1;
  const out: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const u = (((t * speed) / len + k / n) % 1 + 1) % 1;
    out.push([s.x0 + (s.x1 - s.x0) * u, s.y0 + (s.y1 - s.y0) * u]);
  }
  return out;
}
