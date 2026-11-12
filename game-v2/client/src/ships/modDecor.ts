/**
 * @contract client.ships.mod-decor
 * owns:       the hardware drawn on weapon modifier parts (docs/design/weapon-modifiers-2026-11.md): a Mount's line, rings
 *             and sockets, each modifier block's own shape in its effect's colour, a hopper's tank, the collars and core of
 *             tier II and III line parts, and the lit contact of a socket with a block on it
 * needs:      common frameOf / placeEdge (where the ports core puts a part's ports and sockets), shipFunctionData
 * invariants: every modifier part and every tier II / III line part has hardware, a tier I line part none of it, and the
 *             same part gives the same shapes — client/src/ships/modDecor.test.ts
 * extend:     a new modifier kind is one entry in BLOCKS (its `plug` kind); a part with `modMount`, `hopper` or
 *             `lineTier` needs nothing here
 *
 * - The shape is chosen by what the part is (FunctionDef.modMount / plug / hopper / lineTier), its colour by the model's
 *   `glow`: a model's `decor` stays 'none' (or 'battery' for the banks), so no model's look fields change.
 * - Grid units, as partDecor.ts. Called by partDecor() for one part; modSocketDecor() is the only whole-ship piece.
 */
import { frameOf, placeEdge, SIDE_NORMAL, transformPoint, type FunctionDef, type PlacedGeom, type PlacedPart, type Side, type Vec2 } from '@space-game/common';
import type { DecorDisc, DecorPoly } from './partDecor';
import { shipFunction } from './shipFunctionData';
import { hexToNum, mix } from './shipColors';

interface Out { polys: DecorPoly[]; discs: DecorDisc[] }

const METAL = 0x4b5563, STEEL = 0x7b8494, DARK = 0x1c2230, BOLT = 0x262c38;
/** A Mount's own light when the model names none, and a line's core by tier (II, III) */
const MOUNT_GLOW = 0x9db4ff, LINE_CORE = [0xffc46b, 0xffe6b0];

/** A box from a to b (axis-aligned points), `hw` either side of the line and `cap` past b */
function bar(a: Vec2, b: Vec2, hw: number, cap = 0): number[] {
  const dx = Math.sign(b[0] - a[0]), dy = Math.sign(b[1] - a[1]), px = -dy * hw, py = dx * hw;
  const ax = a[0], ay = a[1], bx = b[0] + dx * cap, by = b[1] + dy * cap;
  return [ax + px, ay + py, bx + px, by + py, bx - px, by - py, ax - px, ay - py];
}

/** A port or socket of a part, placed: its cell's centre, the middle of its edge, and the way out */
interface Edge { c: Vec2; at: Vec2; n: Vec2 }
function edgeOf(part: PlacedPart, geom: PlacedGeom, side: Side, cell: number): Edge {
  const e = placeEdge(part, frameOf(part, geom.cells), side, cell), n = SIDE_NORMAL[e.side];
  return { c: [e.x + 0.5, e.y + 0.5], at: [e.x + 0.5 + n[0] * 0.5, e.y + 0.5 + n[1] * 0.5], n: [n[0], n[1]] };
}
/** A point `d` in from an edge's middle */
const inFrom = (e: Edge, d: number): Vec2 => [e.at[0] - e.n[0] * d, e.at[1] - e.n[1] * d];

/** A socket's contact, just inside its edge (dark when empty; modSocketDecor lights it) */
const contact = (e: Edge): number[] => bar(inFrom(e, 0.035), inFrom(e, 0.105), 0.085);

/** A power line through a part: a sunk bed from each in port to each out port by the cells' centres, and a lit core */
function lineThrough(out: Out, part: PlacedPart, geom: PlacedGeom, fn: FunctionDef, bed: number, core: number, color: number, glow: number): Edge[] {
  const ports = (fn.ports ?? []).map((q) => ({ dir: q.dir, e: edgeOf(part, geom, q.side, q.cell ?? 0) }));
  const ins = ports.filter((q) => q.dir === 'in'), outs = ports.filter((q) => q.dir === 'out');
  const legs: [Vec2, Vec2][] = [];
  for (const q of ports) legs.push([q.e.at, q.e.c]);
  for (const a of ins) for (const b of outs) if (a.e.c[0] !== b.e.c[0] || a.e.c[1] !== b.e.c[1]) legs.push([a.e.c, b.e.c]);
  // (each leg runs a little past the centre it ends on, so a corner's two meet square)
  for (const [a, b] of legs) out.polys.push({ pts: bar(a, b, bed, bed), color: DARK, sunk: true, bevel: 0.02 });
  for (const [a, b] of legs) out.polys.push({ pts: bar(a, b, core, core), color, glow });
  return ports.map((q) => q.e);
}

/** A Mount: the line through it, a treatment ring on each socket's cell, and an arm out to each socket with its jaws */
function mount(out: Out, part: PlacedPart, geom: PlacedGeom, fn: FunctionDef, glow: number): void {
  lineThrough(out, part, geom, fn, 0.13, 0.045, glow, 0.55);
  const rings = new Map<string, Vec2>();
  for (const s of fn.modMount!.sockets) {
    const e = edgeOf(part, geom, s.side, s.cell ?? 0), t: Vec2 = [-e.n[1], e.n[0]];
    rings.set(`${e.c[0]},${e.c[1]}`, e.c);
    out.polys.push({ pts: bar(e.c, inFrom(e, 0.02), 0.075), color: METAL, bevel: 0.02 });
    // (the jaws either side of the contact, on the edge)
    for (const k of [-1, 1]) {
      const a: Vec2 = [e.at[0] + t[0] * 0.15 * k - e.n[0] * 0.16, e.at[1] + t[1] * 0.15 * k - e.n[1] * 0.16];
      out.polys.push({ pts: bar(a, [a[0] + e.n[0] * 0.16, a[1] + e.n[1] * 0.16], 0.045), color: STEEL, bevel: 0.015 });
    }
    out.polys.push({ pts: contact(e), color: BOLT });
  }
  for (const c of rings.values()) {
    out.discs.push({ x: c[0], y: c[1], r: 0.2, color: STEEL, bevel: 0.035 });
    out.discs.push({ x: c[0], y: c[1], r: 0.135, color: DARK });
    out.discs.push({ x: c[0], y: c[1], r: 0.075, color: glow, glow: 0.8 });
  }
}

/** A part's own frame for a one-cell block: the unit square (x right, y down, its N side y = 0) placed as the part is */
type Local = { p: (x: number, y: number) => Vec2; rect: (x0: number, y0: number, x1: number, y1: number) => number[]; poly: (...xy: number[]) => number[] };
function local(part: PlacedPart, geom: PlacedGeom): Local {
  const F = frameOf(part, geom.cells);
  const p = (x: number, y: number): Vec2 => { const q = transformPoint([x, y], F.rot, F.flip); return [q[0] + part.x, q[1] + part.y]; };
  const poly = (...xy: number[]) => { const o: number[] = []; for (let i = 0; i < xy.length; i += 2) o.push(...p(xy[i], xy[i + 1])); return o; };
  return { p, poly, rect: (x0, y0, x1, y1) => poly(x0, y0, x1, y0, x1, y1, x0, y1) };
}
/** A box with its corners cut by `c` */
const cut = (l: Local, x0: number, y0: number, x1: number, y1: number, c: number) => l.poly(x0 + c, y0, x1 - c, y0, x1, y0 + c, x1, y1 - c, x1 - c, y1, x0 + c, y1, x0, y1 - c, x0, y0 + c);
/** A thin strip from a to b in the block's frame */
function strip(l: Local, ax: number, ay: number, bx: number, by: number, w: number): number[] {
  const d = Math.hypot(bx - ax, by - ay) || 1, px = (-(by - ay) / d) * w, py = ((bx - ax) / d) * w;
  return l.poly(ax + px, ay + py, bx + px, by + py, bx - px, by - py, ax - px, ay - py);
}

type Block = (out: Out, l: Local, glow: number) => void;
/**
 * Each modifier block, by its `plug` kind. The four plain ones are one shape each; the specials (they need a hopper or a
 * power line) are built up of more
 */
const BLOCKS: Record<string, Block> = {
  /** Coil: a lit bar through a row of windings */
  coil(out, l, glow) {
    out.polys.push({ pts: l.rect(0.12, 0.44, 0.88, 0.56), color: glow, glow: 0.7 });
    for (const x of [0.19, 0.325, 0.46, 0.595, 0.73]) out.polys.push({ pts: l.rect(x, 0.29, x + 0.08, 0.71), color: STEEL, bevel: 0.018 });
  },
  /** Resonator: rings inside rings */
  resonator(out, l, glow) {
    const [x, y] = l.p(0.5, 0.5);
    out.discs.push({ x, y, r: 0.35, color: METAL, bevel: 0.035 }, { x, y, r: 0.275, color: glow, glow: 0.45 }, { x, y, r: 0.215, color: DARK },
      { x, y, r: 0.15, color: glow, glow: 0.6 }, { x, y, r: 0.095, color: DARK }, { x, y, r: 0.05, color: glow, glow: 0.9 });
  },
  /** Chamber: a bolted eight-sided pressure vessel with a lit charge */
  chamber(out, l, glow) {
    const [x, y] = l.p(0.5, 0.5);
    out.discs.push({ x, y, r: 0.38, color: METAL, bevel: 0.045, sides: 8 }, { x, y, r: 0.24, color: DARK, sides: 8 }, { x, y, r: 0.13, color: glow, glow: 0.8, sides: 8 });
    for (let i = 0; i < 8; i++) { const a = (i + 0.5) * Math.PI / 4; out.discs.push({ x: x + Math.cos(a) * 0.3, y: y + Math.sin(a) * 0.3, r: 0.028, color: BOLT, sides: 6 }); }
  },
  /** Prism: a lit triangle on a dark bed, a beam in at its point and two out of its base */
  prism(out, l, glow) {
    out.polys.push({ pts: cut(l, 0.13, 0.13, 0.87, 0.87, 0.1), color: DARK, sunk: true, bevel: 0.02 });
    out.polys.push({ pts: l.rect(0.475, 0.13, 0.525, 0.3), color: mix(glow, 0xffffff, 0.5), glow: 0.6 });
    out.polys.push({ pts: strip(l, 0.38, 0.68, 0.24, 0.86, 0.022), color: glow, glow: 0.6 }, { pts: strip(l, 0.62, 0.68, 0.76, 0.86, 0.022), color: glow, glow: 0.6 });
    out.polys.push({ pts: l.poly(0.5, 0.24, 0.78, 0.72, 0.22, 0.72), color: glow, glow: 0.55, bevel: 0.035 });
    out.polys.push({ pts: l.poly(0.5, 0.4, 0.64, 0.64, 0.36, 0.64), color: mix(glow, 0xffffff, 0.45), glow: 0.75 });
  },
  /** Arc Module: two electrodes on insulator stacks, an arc between them */
  arc(out, l, glow) {
    out.polys.push({ pts: cut(l, 0.1, 0.2, 0.9, 0.8, 0.08), color: DARK, sunk: true, bevel: 0.02 });
    for (const x of [0.13, 0.2, 0.74, 0.81]) out.polys.push({ pts: l.rect(x, 0.3, x + 0.05, 0.7), color: STEEL, bevel: 0.012 });
    out.polys.push({ pts: l.rect(0.22, 0.1, 0.78, 0.17), color: METAL, bevel: 0.015 }, { pts: l.rect(0.22, 0.83, 0.78, 0.9), color: METAL, bevel: 0.015 });
    const z = [0.33, 0.5, 0.42, 0.39, 0.5, 0.58, 0.58, 0.41, 0.67, 0.5];
    for (let i = 0; i + 3 < z.length; i += 2) out.polys.push({ pts: strip(l, z[i], z[i + 1], z[i + 2], z[i + 3], 0.022), color: mix(glow, 0xffffff, 0.35), glow: 0.9 });
    for (const x of [0.29, 0.71]) { const [cx, cy] = l.p(x, 0.5); out.discs.push({ x: cx, y: cy, r: 0.115, color: STEEL, bevel: 0.03 }, { x: cx, y: cy, r: 0.055, color: glow, glow: 0.85 }); }
  },
  /** Condenser Module: a cold core in a block with cooling fins down both sides */
  condenser(out, l, glow) {
    for (let i = 0; i < 6; i++) { const y = 0.15 + i * 0.125; out.polys.push({ pts: l.rect(0.08, y, 0.92, y + 0.075), color: STEEL, bevel: 0.012 }); }
    out.polys.push({ pts: cut(l, 0.29, 0.1, 0.71, 0.9, 0.06), color: METAL, bevel: 0.035 });
    out.polys.push({ pts: l.rect(0.43, 0.2, 0.57, 0.8), color: DARK }, { pts: l.rect(0.46, 0.23, 0.54, 0.77), color: glow, glow: 0.7 });
    for (const y of [0.16, 0.84]) { const [cx, cy] = l.p(0.5, y); out.discs.push({ x: cx, y: cy, r: 0.035, color: BOLT, sides: 6 }); }
  },
  /** Brand Module: a burner, its flame in a crucible held by four lugs */
  brand(out, l, glow) {
    for (const [x, y] of [[0.1, 0.1], [0.74, 0.1], [0.1, 0.74], [0.74, 0.74]]) out.polys.push({ pts: l.rect(x, y, x + 0.16, y + 0.16), color: STEEL, bevel: 0.02 });
    const [cx, cy] = l.p(0.5, 0.5);
    out.discs.push({ x: cx, y: cy, r: 0.37, color: METAL, bevel: 0.045 }, { x: cx, y: cy, r: 0.28, color: DARK }, { x: cx, y: cy, r: 0.2, color: mix(glow, 0x000000, 0.45), glow: 0.35 });
    const [fx, fy] = l.p(0.5, 0.53), [hx, hy] = l.p(0.5, 0.57);
    out.discs.push({ x: fx, y: fy, r: 0.13, color: glow, glow: 0.85, sides: 5 }, { x: hx, y: hy, r: 0.065, color: mix(glow, 0xffe9a8, 0.7), glow: 1, sides: 5 });
  },
  /** Rail Driver Module: two rails over a lit slot, a capacitor bank down each side, its power stub at its in port (S) */
  rail(out, l, glow) {
    out.polys.push({ pts: l.rect(0.09, 0.14, 0.27, 0.86), color: DARK, sunk: true, bevel: 0.015 }, { pts: l.rect(0.73, 0.14, 0.91, 0.86), color: DARK, sunk: true, bevel: 0.015 });
    for (const x of [0.115, 0.755]) for (const y of [0.19, 0.42, 0.65]) out.polys.push({ pts: l.rect(x, y, x + 0.13, y + 0.16), color: glow, glow: 0.45 });
    out.polys.push({ pts: l.rect(0.42, 0.06, 0.58, 0.9), color: DARK }, { pts: l.rect(0.455, 0.08, 0.545, 0.88), color: mix(glow, 0xffffff, 0.3), glow: 0.85 });
    out.polys.push({ pts: l.rect(0.32, 0.05, 0.42, 0.92), color: STEEL, bevel: 0.022 }, { pts: l.rect(0.58, 0.05, 0.68, 0.92), color: STEEL, bevel: 0.022 });
    out.polys.push({ pts: l.rect(0.3, 0.88, 0.7, 0.98), color: METAL, bevel: 0.02 });
  },
};

/** A hopper: a strapped tank, its window the colour of what it holds, a filler cap on top */
function hopper(out: Out, l: Local, glow: number): void {
  out.polys.push({ pts: cut(l, 0.1, 0.17, 0.9, 0.83, 0.15), color: METAL, bevel: 0.045 });
  out.polys.push({ pts: cut(l, 0.17, 0.25, 0.83, 0.75, 0.11), color: DARK });
  out.polys.push({ pts: cut(l, 0.2, 0.28, 0.8, 0.72, 0.09), color: glow, glow: 0.5 });
  out.polys.push({ pts: l.rect(0.2, 0.28, 0.8, 0.4), color: mix(glow, 0xffffff, 0.35), glow: 0.6 });
  for (const x of [0.3, 0.64]) out.polys.push({ pts: l.rect(x, 0.15, x + 0.06, 0.85), color: STEEL, bevel: 0.014 });
  const [cx, cy] = l.p(0.5, 0.5);
  out.discs.push({ x: cx, y: cy, r: 0.1, color: STEEL, bevel: 0.025 }, { x: cx, y: cy, r: 0.05, color: BOLT });
}

/**
 * A tier II or III line part, over what its tier I has: a collar at each port (two at tier III, with a lit pip), and on
 * a part with no hardware of its own a lit core down its line (wider and brighter at tier III) with a hub on it
 */
function lineTier(out: Out, part: PlacedPart, geom: PlacedGeom, fn: FunctionDef, tier: number, bare: boolean): void {
  const three = tier >= 3, core = LINE_CORE[three ? 1 : 0];
  const edges = bare ? lineThrough(out, part, geom, fn, three ? 0.12 : 0.09, three ? 0.06 : 0.032, core, three ? 0.85 : 0.5) : (fn.ports ?? []).map((q) => edgeOf(part, geom, q.side, q.cell ?? 0));
  const seen = new Set<string>();
  for (const e of edges) {
    const key = `${e.at[0]},${e.at[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hw = three ? 0.27 : 0.22;
    out.polys.push({ pts: bar(inFrom(e, 0.03), inFrom(e, 0.11), hw), color: STEEL, bevel: 0.02 });
    if (!three) continue;
    out.polys.push({ pts: bar(inFrom(e, 0.16), inFrom(e, 0.23), hw - 0.05), color: STEEL, bevel: 0.018 });
    out.polys.push({ pts: bar(inFrom(e, 0.05), inFrom(e, 0.09), 0.05), color: core, glow: 0.9 });
  }
  if (!bare) return;
  const hubs = new Map<string, Vec2>(edges.map((e) => [`${e.c[0]},${e.c[1]}`, e.c]));
  for (const c of hubs.values()) {
    out.discs.push({ x: c[0], y: c[1], r: three ? 0.17 : 0.12, color: STEEL, bevel: 0.03, sides: three ? 8 : 6 });
    if (three) out.discs.push({ x: c[0], y: c[1], r: 0.11, color: DARK, sides: 8 });
    out.discs.push({ x: c[0], y: c[1], r: three ? 0.065 : 0.05, color: core, glow: three ? 0.95 : 0.6, sides: 8 });
  }
}

/**
 * A weapon modifier part's hardware, added to `out`. True when the part is one and wants nothing else drawn (a Mount, a
 * block, a hopper, a bare line part of tier II or III). A tier II or III part with hardware of its own (`own`: the
 * banks' charge cells) gets only its collars, over them, and false comes back for the caller to carry on
 */
export function modDecor(out: Out, geom: PlacedGeom, part: PlacedPart, glow: number | undefined, own = false): boolean {
  const fn = shipFunction(part.fn);
  if (!fn) return false;
  if (fn.modMount) { mount(out, part, geom, fn, glow ?? MOUNT_GLOW); return true; }
  if (fn.plug && BLOCKS[fn.plug]) { BLOCKS[fn.plug](out, local(part, geom), glow ?? MOUNT_GLOW); return true; }
  if (fn.hopper) { hopper(out, local(part, geom), glow ?? MOUNT_GLOW); return true; }
  if ((fn.lineTier ?? 0) >= 2) { lineTier(out, part, geom, fn, fn.lineTier!, !own); return !own; }
  return false;
}

/** The modifier kinds with a shape here (the test checks every `plug` in the models has one) */
export const MOD_BLOCK_KINDS: readonly string[] = Object.keys(BLOCKS);

/**
 * The whole ship's part: the contact of each Mount socket with a modifier block on it, lit in the block's colour (by
 * mount part index). A hull is built with these over the mounts' own hardware; a mount alone shows its sockets dark
 */
export function modSocketDecor(parts: readonly PlacedPart[], geoms: readonly PlacedGeom[], alive: readonly boolean[]): Map<number, DecorPoly[]> | undefined {
  let any = false;
  for (const p of parts) if (shipFunction(p.fn)?.modMount) { any = true; break; }
  if (!any) return undefined;
  const occ = new Map<string, number>();
  geoms.forEach((g, i) => { if (alive[i]) for (const c of g.cells) occ.set(`${c[0]},${c[1]}`, i); });
  const out = new Map<number, DecorPoly[]>();
  parts.forEach((part, m) => {
    const mm = shipFunction(part.fn)?.modMount;
    if (!mm || !alive[m]) return;
    for (const s of mm.sockets) {
      const e = edgeOf(part, geoms[m], s.side, s.cell ?? 0);
      const j = occ.get(`${Math.floor(e.at[0] + e.n[0] * 0.5)},${Math.floor(e.at[1] + e.n[1] * 0.5)}`);
      const block = j === undefined || j === m ? undefined : shipFunction(parts[j].fn);
      if (!block?.plug) continue;
      const list = out.get(m) ?? [];
      list.push({ pts: contact(e), color: block.glow ? hexToNum(block.glow) : MOUNT_GLOW, glow: 0.9 });
      out.set(m, list);
    }
  });
  return out;
}
