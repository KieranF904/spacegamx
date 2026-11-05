/**
 * What each port of a ports design is doing (docs/design/energy-ports-2026-11.md §1.1, §5): linked (and to which part),
 * open, a generator's line wasted, or clashing (two outs or two ins face each other). The hangar draws a glyph per port
 * from this and lists the links. Pure, built once per layout (no per-tick work), so the overlay redraws only when the
 * design changes. A port that might be (a part in hand, not placed yet) is judged against the same index: previewPorts.
 */

import type { FunctionDef, PlacedPart, Side, Vec2 } from '../types.js';
import { SIDE_NORMAL } from '../catalog.js';
import { EU } from './units.js';
import { isEngine } from '../grades.js';
import { P_GEN, P_RELAY, P_THRUSTER, P_TOOL, P_WEAPON, frameOf, placeEdge, type PortSpec, type PortsLayout } from './ports.js';

/** Linked: power crosses here */
export const PS_LINKED = 0;
/** An in port on a gun, engine or tool with nothing feeding it: the part is short that port's rate */
export const PS_OPEN = 1;
/** A generator's out port facing nothing: that line's power is lost */
export const PS_WASTE = 2;
/** Two outs or two ins face each other: nothing crosses (a warning) */
export const PS_CLASH = 3;
/** A store's or a line's port facing nothing: harmless, power stays where it is */
export const PS_SPARE = 4;
export type PortState = typeof PS_LINKED | typeof PS_OPEN | typeof PS_WASTE | typeof PS_CLASH | typeof PS_SPARE;

export interface PortView {
  part: number;
  dir: 0 | 1;
  /** Its cell and the side of that cell it sits on (grid coordinates) */
  x: number;
  y: number;
  side: Side;
  /** E/s it is rated for */
  rate: number;
  aug: 0 | 1;
  state: PortState;
  /** The part across: what it links to (linked), or what it clashes with (clash); -1 none */
  to: number;
  /** Its link's id (linked), else -1 */
  link: number;
}
export interface LinkView {
  id: number;
  from: number;
  to: number;
  /** E/s the link carries at most (the lower of its two ports' rates) */
  cap: number;
  aug: 0 | 1;
  /** Where it crosses: the out port's cell and side; null for a touch link (legacy functions: no ports, part to part) */
  at: { x: number; y: number; side: Side } | null;
}
export interface PortsView {
  ports: PortView[];
  links: LinkView[];
  /** Ports by part (indexes into `ports`) */
  byPart: number[][];
  /** Counts: linked ports (each end), open consumer ins, wasted generator outs, clashing ports */
  linked: number;
  open: number;
  waste: number;
  clash: number;
}

const OPP: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };
const edgeKey = (x: number, y: number, side: Side) => `${x},${y},${side}`;
const isConsumer = (r: number) => r === P_WEAPON || r === P_THRUSTER || r === P_TOOL;

/** An open port's state by its part's role: a consumer's in is short, a generator's out is wasted, a store's is spare */
function openState(role: number, dir: 0 | 1): PortState {
  if (dir === 0) return isConsumer(role) ? PS_OPEN : PS_SPARE;
  return role === P_GEN ? PS_WASTE : PS_SPARE;
}

const views = new WeakMap<PortsLayout, PortsView>();
/** Every port's state and every link, once per layout */
export function portsView(L: PortsLayout): PortsView {
  let v = views.get(L);
  if (v) return v;
  const at = new Map<string, number>();
  L.ports.forEach((p, k) => at.set(edgeKey(p.x, p.y, p.side), k));
  const byPart: number[][] = Array.from({ length: L.n }, () => []);
  let linked = 0, open = 0, waste = 0, clash = 0;
  const ports: PortView[] = L.ports.map((p, k) => {
    byPart[p.part].push(k);
    const l = p.l ?? -1;
    if (l >= 0) { linked++; return { part: p.part, dir: p.dir, x: p.x, y: p.y, side: p.side, rate: p.rate, aug: p.aug, state: PS_LINKED, to: p.dir === 1 ? L.linkTo[l] : L.linkFrom[l], link: l }; }
    const n = SIDE_NORMAL[p.side], q = at.get(edgeKey(p.x + n[0], p.y + n[1], OPP[p.side]));
    const other = q === undefined ? undefined : L.ports[q];
    let state: PortState, to = -1;
    if (other && other.part !== p.part && other.dir === p.dir) { state = PS_CLASH; to = other.part; clash++; }
    else { state = openState(L.role[p.part], p.dir); if (state === PS_OPEN) open++; else if (state === PS_WASTE) waste++; }
    return { part: p.part, dir: p.dir, x: p.x, y: p.y, side: p.side, rate: p.rate, aug: p.aug, state, to, link: -1 };
  });
  const links: LinkView[] = [];
  const outAt = new Map<number, PortView>();
  for (const p of ports) if (p.link >= 0 && p.dir === 1) outAt.set(p.link, p);
  for (let l = 0; l < L.links; l++) {
    const o = outAt.get(l);
    links.push({ id: l, from: L.linkFrom[l], to: L.linkTo[l], cap: (L.linkCap[l] * 60) / EU, aug: L.linkAug[l] as 0 | 1, at: o ? { x: o.x, y: o.y, side: o.side } : null });
  }
  v = { ports, links, byPart, linked, open, waste, clash };
  views.set(L, v);
  return v;
}

/** A port of a part in hand, placed where it would go, and what it would do there */
export interface PortPreview {
  dir: 0 | 1;
  x: number;
  y: number;
  side: Side;
  rate: number;
  aug: 0 | 1;
  /** Linked (it would link to `to`), clash (it faces a port going the same way on `to`), or open */
  state: PortState;
  to: number;
  /** For an open port: whether a part sits across it (a port facing a part's bare side: nothing crosses) */
  blocked: boolean;
}

/**
 * The ports a part in hand would have (its own frame turned and flipped as it would be placed: frameOf/placeEdge, as
 * buildPortsLayout does) and what each would meet on the design as it is: an existing port facing it the other way
 * links, the same way clashes. `cells` are its cells as placed; `occupant(x, y)` the part on a cell of the design (-1 none).
 * A touch-routed function (FunctionDef.touch) has no ports and gets none
 */
export function previewPorts(L: PortsLayout | undefined, part: PlacedPart, fn: FunctionDef, cells: readonly Vec2[], occupant: (x: number, y: number) => number): PortPreview[] {
  if (fn.touch) return [];
  const specs: (PortSpec & { aug?: 1 })[] = [...(fn.ports ?? [])];
  if (fn.augment && fn.weapon) specs.push({ dir: 'in', side: fn.augment.side, cell: fn.augment.cell, rate: fn.augment.rate, aug: 1 });
  if (!specs.length) return [];
  const F = frameOf(part, cells as Vec2[]);
  const at = new Map<string, number>();
  if (L) L.ports.forEach((p, k) => at.set(edgeKey(p.x, p.y, p.side), k));
  // (its role as buildPortsLayout gives it: a store first, then a gun or an engine, then a generator, then a tool)
  const role = part.fn === 'core' || ((fn.store ?? 0) > 0 && !fn.tank) ? P_RELAY : fn.weapon || isEngine(fn) ? P_TOOL : (fn.produce ?? 0) > 0 ? P_GEN : (fn.demand ?? 0) > 0 ? P_TOOL : P_RELAY;
  const out: PortPreview[] = [];
  for (const q of specs) {
    const e = placeEdge(part, F, q.side, q.cell ?? 0), dir = q.dir === 'out' ? 1 : 0;
    // (Two on one cell are one port; an engine's rated for both, as buildPortsLayout makes it)
    const same = out.find((o) => o.x === e.x && o.y === e.y && o.side === e.side && o.dir === dir);
    if (same) { if (isEngine(fn) && !q.aug) same.rate += q.rate; continue; }
    const k = at.get(edgeKey(e.nx, e.ny, OPP[e.side]));
    const other = k === undefined || !L ? undefined : L.ports[k];
    let state: PortState, to = -1;
    if (other) { state = other.dir !== dir ? PS_LINKED : PS_CLASH; to = other.part; }
    else state = openState(role, dir as 0 | 1);
    out.push({ dir: dir as 0 | 1, x: e.x, y: e.y, side: e.side, rate: q.rate, aug: q.aug ? 1 : 0, state, to, blocked: !other && occupant(e.nx, e.ny) >= 0 });
  }
  return out;
}
