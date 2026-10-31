/**
 * What engines and weapons look like on top of their part's outline, in
 * grid units (one cell = 1), shared by the ship renderer, the hangar and the
 * item icons so a part looks the same everywhere:
 *
 *   engines   a bell nozzle (or several) out of the facing edge, a dark
 *             throat and a glowing exit ring, cooling ribs across the
 *             housing. Ion thrusters glow blue, afterburners orange (longer,
 *             narrower jets), plasma drives violet (one great bell, a glowing
 *             chamber). `nozzles` gives the flame's start at each exit.
 *   weapons   the part's body is its mounting base (`base`, drawn instead of
 *             a square panel; the rest of the cell open), bolted on its attach edge
 *             (the back, or a flank for a right-angle mount): a turret's
 *             ring-mount on a pedestal, by family (turretBaseOf), a lit
 *             bearing race on it with traverse marks over its arc (its head,
 *             gunDecor.ts, turns in it); a fixed gun's family housing
 *             (housingOf): an armoured casemate sloped in to its embrasure, a
 *             mortar tub, a capsule emitter on a fork, a spinal cradle, a
 *             launcher box on lugs, a braced socket round a dish or coil.
 *             Fixed barrels are separate shapes (`barrels`, drawn under the
 *             hull) so they can recoil.
 *   miners    a crystal chamber, a focusing tube with coolant rings and a
 *             glowing lens, two claws either side.
 *
 * Bigger parts get bigger hardware (by the square root of their size, so a
 * 2×2 gun reads as a heavy gun, not four small ones).
 */

import { SIDE_NORMAL, mountOf, mountingOf, partMount, weaponSides, type Catalog, type PlacedGeom, type PlacedPart, type Vec2 } from '@space-game/common';
import { SHIP_FUNCTIONS } from './shipFunctionData';
import { functionColor, hexToNum, mix } from './shipColors';
import { fixedGun, gunId, housingOf, turretBaseOf, turretHead, type GunShape, type Housing } from './gunDecor';

/** `bevel` (cells): a raised, lit rim; `sunk`: set into the hull (its rim lit on the far side) */
export interface DecorPoly { pts: number[]; color: number; glow?: number; bevel?: number; sunk?: boolean }
export interface DecorDisc { x: number; y: number; r: number; color: number; glow?: number; bevel?: number; sunk?: boolean; sides?: number }
/**
 * A barrel, in its own frame (u out along `n`, v along `t`), set at `base` on
 * the facing edge: `parts` its shaded shapes, `outline` its silhouette, and
 * `shape` the first of that (one outline, for what wants one)
 */
export interface DecorBarrel { base: Vec2; n: Vec2; t: Vec2; shape: number[]; len: number; parts: GunShape[]; outline: number[][] }
/** Where an engine's flame starts: the centre of a nozzle's exit, and the exit's width */
export interface DecorNozzle { at: Vec2; n: Vec2; t: Vec2; width: number }

/** A piece of a weapon's mounting base: its part's own body, in its part's colour (`tone`: + lighter, - darker) */
export interface BasePoly { pts: number[]; tone: number; bevel: number }

export interface PartDecor {
  polys: DecorPoly[];
  discs: DecorDisc[];
  barrels: DecorBarrel[];
  nozzles: DecorNozzle[];
  /** A weapon's: drawn instead of its square panel (bottom up), the rest of the part open */
  base?: BasePoly[];
}

const METAL = 0x4b5563, DARK = 0x1c2230, GUNMETAL = 0x3a3f48, BELL = 0x7b8494, MINER_GLOW = 0x5eead4;

/**
 * Every hardware shape, by the `decor` key a function names in
 * data/ships/functions.json, and the routine that draws it. A new part kind
 * reuses one of these by naming it; its `glow` colours the lit bits (charge
 * cells, engine bells, emitters).
 */
export const DECOR_SHAPES = {
  none: 'none',
  battery: 'battery',
  /** The Stabiliser Anchor: a bolted hub, and a clamp pad at each corner (they swing out when braced: ShipRenderer) */
  anchor: 'anchor',
  miner: 'miner',
  // Engines: ion thrusters (steady blue), afterburners (long narrow jets), plasma drives (one great bell)
  ion: 'engine', afterburner: 'engine', plasma: 'engine',
  // Guns: their barrels, turret barrels and body hardware
  cannon: 'weapon', flak: 'weapon', laser: 'weapon', railgun: 'weapon', lance: 'weapon', missile: 'weapon', emp: 'weapon',
  /** A short tube with a glowing orb at its mouth, and a lasing core */
  exotic: 'weapon',
} as const;
export type DecorKey = keyof typeof DECOR_SHAPES;

/** Each function's decor key and glow colour (data/ships/functions.json) */
const LOOK = new Map<string, { decor: DecorKey; glow?: number }>(
  SHIP_FUNCTIONS.map((f) => [
    f.id,
    { decor: (f.decor && f.decor in DECOR_SHAPES ? f.decor : 'none') as DecorKey, glow: f.glow ? hexToNum(f.glow) : undefined },
  ]),
);
const lookOf = (fn: string) => LOOK.get(fn) ?? { decor: 'none' as DecorKey, glow: undefined };
export const ENGINE_FNS = new Set([...LOOK].filter(([, l]) => DECOR_SHAPES[l.decor] === 'engine').map(([id]) => id));

/** A model's own mount, else the part's (legacy), else fixed (partMount, over the same functions a catalogue has) */
const FNS = { functions: new Map(SHIP_FUNCTIONS.map((f) => [f.id, f])) } as unknown as Catalog;
export const isTurret = (part: PlacedPart): boolean => partMount(FNS, part) === 'turret';

/** A part's facing edge as a frame: tangent extent [lo, hi], where the edge lies along n, and how deep the part is behind it */
interface Frame { n: Vec2; t: Vec2; lo: number; hi: number; along: number; depth: number }

function frameOf(geom: PlacedGeom): Frame | null {
  // (Its facing edge, or a bespoke piece's mount)
  const m = mountOf(geom);
  if (!m) return null;
  const n = m.dir, edges = m.edges;
  const t: Vec2 = [-n[1], n[0]];
  let lo = Infinity, hi = -Infinity, along = -Infinity;
  for (const [a, b] of edges) for (const p of [a, b]) {
    const s = p[0] * t[0] + p[1] * t[1];
    lo = Math.min(lo, s); hi = Math.max(hi, s);
    along = Math.max(along, p[0] * n[0] + p[1] * n[1]);
  }
  let depth = 0;
  for (const p of geom.polygon) depth = Math.max(depth, along - (p[0] * n[0] + p[1] * n[1]));
  return { n, t, lo, hi, along, depth };
}

/** The grid point `s` along the edge, `d` out from it (negative: into the part) */
const at = (f: Frame, s: number, d: number): Vec2 => [f.t[0] * s + f.n[0] * (f.along + d), f.t[1] * s + f.n[1] * (f.along + d)];
const quad = (f: Frame, s0: number, d0: number, s1: number, d1: number, s2: number, d2: number, s3: number, d3: number): number[] =>
  [...at(f, s0, d0), ...at(f, s1, d1), ...at(f, s2, d2), ...at(f, s3, d3)];
/** An axis-aligned box in the frame: s in [s0, s1], d in [d0, d1] */
const box = (f: Frame, s0: number, s1: number, d0: number, d1: number) => quad(f, s0, d0, s1, d0, s1, d1, s0, d1);

export function partDecor(geom: PlacedGeom, part: PlacedPart = geom.part): PartDecor {
  const out: PartDecor = { polys: [], discs: [], barrels: [], nozzles: [] };
  const { decor, glow } = lookOf(part.fn);
  const kind = DECOR_SHAPES[decor];
  /** Batteries' charge cells: green for general, blue for drive, red for weapon */
  if (kind === 'battery') { battery(out, geom, glow ?? 0x4ade80); return out; }
  if (kind === 'anchor') { anchor(out, geom, glow ?? 0x7dd3fc); return out; }
  const f = frameOf(part === geom.part ? geom : { ...geom, part });
  if (!f) return out;
  const W = f.hi - f.lo, D = f.depth, mid = (f.lo + f.hi) / 2;
  const size = Math.max(1, geom.area);
  if (kind === 'engine') engine(out, f, decor, glow ?? 0x7dd3fc, W, D, mid, size);
  else if (kind === 'weapon') weaponMount(out, geom, part, glow, size, isTurret(part));
  else if (kind === 'miner') miner(out, f, W, D, mid, size);
  return out;
}

function engine(out: PartDecor, f: Frame, style: DecorKey, glow: number, W: number, D: number, mid: number, size: number): void {
  // How many bells across the edge: a plasma drive has one great bell; a 2×2 ion thruster too; jets for the rest
  const count = style === 'plasma' || size >= 4 && style === 'ion' ? 1 : Math.max(1, Math.round(W));
  const slot = W / count;
  const k = Math.sqrt(slot);
  const shape = style === 'afterburner' ? { base: 0.26, exit: 0.38, len: 0.62 } : style === 'plasma' ? { base: 0.38, exit: 0.5, len: 0.5 } : { base: 0.32, exit: 0.46, len: 0.48 };
  // Cooling ribs across the housing
  for (const k of style === 'plasma' ? [0.14, 0.86] : [0.12, 0.88]) {
    const d = -D * k;
    out.polys.push({ pts: box(f, f.lo + 0.12, f.hi - 0.12, d - 0.045, d + 0.045), color: DARK });
  }
  // The combustion chamber: a glowing core in a dark ring
  const chamber = at(f, mid, -D * 0.5), cr = Math.min(W, D) * (style === 'plasma' ? 0.26 : 0.2);
  out.discs.push({ ...pt(chamber), r: cr * 1.35, color: DARK });
  out.discs.push({ ...pt(chamber), r: cr, color: glow, glow: style === 'ion' ? 0.55 : 0.85 });
  for (let i = 0; i < count; i++) {
    const s = f.lo + slot * (i + 0.5);
    const hb = shape.base * slot, he = shape.exit * slot, len = shape.len * k;
    // Collar where the bell meets the housing
    out.polys.push({ pts: box(f, s - hb * 1.15, s + hb * 1.15, -0.1, 0.02), color: METAL });
    out.polys.push({ pts: quad(f, s - hb, 0, s - he, len, s + he, len, s + hb, 0), color: BELL });
    out.polys.push({ pts: quad(f, s - hb * 0.62, 0.02, s - he * 0.74, len, s + he * 0.74, len, s + hb * 0.62, 0.02), color: DARK });
    // The exit ring glows: hotter on afterburners and plasma drives
    out.polys.push({ pts: quad(f, s - he * 0.78, len - 0.06, s - he, len, s + he, len, s + he * 0.78, len - 0.06), color: glow, glow: style === 'ion' ? 0.45 : 0.75 });
    out.nozzles.push({ at: at(f, s, len), n: f.n, t: f.t, width: he * 2 });
  }
}

/** A chamfered plate: s in [s0, s1], d in [d0, d1] (d0 > d1), corners cut by `c` */
const plate = (f: Frame, s0: number, s1: number, d0: number, d1: number, c: number): number[] => [
  ...at(f, s0 + c, d0), ...at(f, s1 - c, d0), ...at(f, s1, d0 - c), ...at(f, s1, d1 + c),
  ...at(f, s1 - c, d1), ...at(f, s0 + c, d1), ...at(f, s0, d1 + c), ...at(f, s0, d0 - c),
];

/** A mining laser's housing: a chamfered mantlet with a vented back plate */
function housing(out: PartDecor, f: Frame, W: number, D: number, color = GUNMETAL): void {
  if (W < 0.4 || D < 0.4) return;
  const m = Math.min(0.12, W * 0.12, D * 0.12);
  out.polys.push({ pts: plate(f, f.lo + m, f.hi - m, -m * 0.6, -(D - m), Math.min(W, D) * 0.2), color });
  // Vents across the back
  const vents = Math.max(2, Math.round(W * 3));
  for (let i = 0; i < vents; i++) {
    const s = f.lo + W * 0.2 + ((W * 0.6) * (i + 0.5)) / vents;
    out.polys.push({ pts: box(f, s - 0.03, s + 0.03, -(D - m * 2.2), -(D - m * 2.2) - Math.min(0.16, D * 0.16)), color: DARK });
  }
}

/** Gun mounts: the turret race's metal, bolts */
const RACE = 0x9aa5b5, BOLT = 0x262c38;

/**
 * Where a weapon bolts on, in its fire frame: the back edge, or a flank (a
 * right-angle mount's: `lo`/`hi` along t). `p(a, b)`: `a` in from that edge,
 * `b` across it; `A` how deep the part is from it, `B` half its width; `to`
 * takes a fire-frame point (s, d) to (a, b).
 */
type Attach = 'back' | 'lo' | 'hi';
interface AF { kind: Attach; p: (a: number, b: number) => Vec2; A: number; B: number; to: (s: number, d: number) => [number, number] }
function attachFrame(f: Frame, kind: Attach): AF {
  const W = f.hi - f.lo, D = f.depth, mid = (f.lo + f.hi) / 2;
  if (kind === 'back') return { kind, A: D, B: W / 2, p: (a, b) => at(f, mid + b, -D + a), to: (s, d) => [d + D, s - mid] };
  if (kind === 'lo') return { kind, A: W, B: D / 2, p: (a, b) => at(f, f.lo + a, -D / 2 + b), to: (s, d) => [s - f.lo, d + D / 2] };
  return { kind, A: W, B: D / 2, p: (a, b) => at(f, f.hi - a, -D / 2 + b), to: (s, d) => [f.hi - s, d + D / 2] };
}
/** A trapezoid out from the attach edge: w0 wide at a0, w1 at a1 */
const afTrap = (af: AF, a0: number, a1: number, w0: number, w1: number) => [...af.p(a0, -w0 / 2), ...af.p(a0, w0 / 2), ...af.p(a1, w1 / 2), ...af.p(a1, -w1 / 2)];
/** A bar from p to q, w wide */
const strut = (p: Vec2, q: Vec2, w: number): number[] => {
  const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1, nx = (-dy / l) * w / 2, ny = (dx / l) * w / 2;
  return [p[0] + nx, p[1] + ny, q[0] + nx, q[1] + ny, q[0] - nx, q[1] - ny, p[0] - nx, p[1] - ny];
};
/** A fire-frame point's (s, d) */
const sd = (f: Frame, p: Vec2): [number, number] => [p[0] * f.t[0] + p[1] * f.t[1], p[0] * f.n[0] + p[1] * f.n[1] - f.along];

/** Clip a polygon to a convex one (Sutherland–Hodgman) */
function clipTo(pts: number[], clip: Vec2[]): number[] {
  let area = 0;
  for (let i = 0; i < clip.length; i++) { const a = clip[i], b = clip[(i + 1) % clip.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const sg = area >= 0 ? 1 : -1;
  let out = pts;
  for (let i = 0; i < clip.length && out.length >= 6; i++) {
    const [ax, ay] = clip[i], [bx, by] = clip[(i + 1) % clip.length];
    const side = (x: number, y: number) => ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) * sg;
    const src = out, n = src.length / 2;
    out = [];
    for (let j = 0; j < n; j++) {
      const px = src[j * 2], py = src[j * 2 + 1], qx = src[((j + 1) % n) * 2], qy = src[((j + 1) % n) * 2 + 1];
      const sp = side(px, py), sq = side(qx, qy);
      if (sp >= 0) out.push(px, py);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push(px + (qx - px) * t, py + (qy - py) * t); }
    }
  }
  return out;
}

/** A model turret's traverse (radians, centred on its fire axis), from its mounting rules; legacy turrets turn all round */
function arcOf(fn: string): number | undefined {
  const m = mountingOf(FNS, fn, undefined, 'turret');
  return m?.rules && m.arc > 0 && m.arc < 359.5 ? (m.arc * Math.PI) / 180 : undefined;
}

/**
 * A weapon's mounting base, which is its part's body (`base`, drawn in place
 * of the square panel; the rest of the cell is open), bolted on its
 * attach edge, and its hardware on that: a turret's ring-mount, a fixed gun's
 * family housing with its barrels out of the facing edge.
 */
function weaponMount(out: PartDecor, geom: PlacedGeom, part: PlacedPart, glow: number | undefined, size: number, turret: boolean): void {
  // (where it fires out of and bolts on: the mounting rules')
  const sides = weaponSides(FNS, part);
  // (its fire edge: its facing, unless the rules say otherwise)
  const fp = sides && sides.fire !== part.facing && !geom.mount ? { ...part, facing: sides.fire } : part;
  const f = frameOf(fp === geom.part ? geom : { ...geom, part: fp });
  if (!f) return;
  const W = f.hi - f.lo, D = f.depth;
  if (W < 0.4 || D < 0.4) return;
  let kind: Attach = 'back';
  if (sides && !geom.mount) {
    const a = SIDE_NORMAL[sides.attach], dt = a[0] * f.t[0] + a[1] * f.t[1];
    kind = dt > 0.5 ? 'hi' : dt < -0.5 ? 'lo' : 'back';
  }
  const af = attachFrame(f, kind);
  out.base = [];
  if (turret) turretMount(out, f, af, geom.centroid, part.fn, glow, size, arcOf(part.fn));
  else fixedMount(out, f, af, part.fn, glow, size);
  // (inside its part: what reaches past a cut piece's outline is cut off)
  if (geom.convex.length === 1) out.base = out.base.map((b) => ({ ...b, pts: clipTo(b.pts, geom.convex[0]) })).filter((b) => b.pts.length >= 6);
}

/** A foot along the attach edge, bolted at its ends */
function foot(out: PartDecor, af: AF, k: number, w = af.B * 2 - 0.08): void {
  const h = Math.min(0.11 * k, af.A * 0.14);
  out.base!.push({ pts: afTrap(af, 0.015, h, w, w - h * 0.6), tone: -0.14, bevel: 0.03 * k });
  for (const s of [-1, 1]) { const p = af.p(h * 0.5, s * (w / 2 - h * 0.7)); out.discs.push({ x: p[0], y: p[1], r: 0.024 * k, color: BOLT, sides: 6 }); }
}

/**
 * A turret's ring-mount, by family (turretBaseOf), on a pedestal out of its
 * attach edge: `ring` an octagon on a tapered neck (cannon); `round` a round
 * ring on twin struts (autocannon); `lugged` with four drum lugs (flak);
 * `tub` a broad round tub on a bell (mortar); `stalk` a slim ring on a stalk
 * with a flared foot (lasers, pulse, exotics); `braced` a hexagon on
 * diagonal braces (emp, arc). On it, a lit bearing race round the dark well
 * its head turns in, traverse marks over its arc (stops at its ends) or all
 * round, bolts, a paint mark aft, a glowing pip.
 */
function turretMount(out: PartDecor, f: Frame, af: AF, c: Vec2, fn: string, glow: number | undefined, size: number, arc: number | undefined): void {
  const k = Math.sqrt(Math.max(1, size)), W = f.hi - f.lo, D = f.depth;
  const R = Math.min(0.47 * k, Math.min(W, D) * 0.47), q = R / 0.47, B = af.B;
  const [ca] = af.to(...sd(f, c));
  const style = turretBaseOf(fn), accent = gunId(fn).accent;
  // (about its middle, angle 0 along its fire axis)
  const pr = (r: number, a: number): Vec2 => [c[0] + (f.n[0] * Math.cos(a) + f.t[0] * Math.sin(a)) * r, c[1] + (f.n[1] * Math.cos(a) + f.t[1] * Math.sin(a)) * r];
  const ngon = (r: number, n: number, turn = 0.5) => { const p: number[] = []; for (let i = 0; i < n; i++) p.push(...pr(r, ((i + turn) / n) * Math.PI * 2)); return p; };
  const base = (pts: number[], tone = 0, bevel = 0.055 * q) => out.base!.push({ pts, tone, bevel });
  let ringR = R, sides = 8;
  switch (style) {
    case 'ring':
      base(afTrap(af, 0, ca, Math.min(B * 2 - 0.08, R * 2), R * 1.24), -0.06, 0.04 * q);
      foot(out, af, q);
      base(ngon(R, 8));
      break;
    case 'round':
      for (const s of [-1, 1]) base(strut(af.p(0.02, s * R * 0.62), af.p(ca, s * R * 0.4), 0.17 * q), -0.08, 0.03 * q);
      foot(out, af, q, Math.min(B * 2 - 0.08, R * 1.8));
      base(ngon((ringR = R * 0.97), (sides = 12)));
      break;
    case 'lugged': {
      base(afTrap(af, 0, ca, Math.min(B * 2 - 0.08, R * 1.7), R * 1.2), -0.06, 0.04 * q);
      foot(out, af, q);
      for (let i = 0; i < 4; i++) { const p = pr(R * 0.78, ((i + 0.5) / 4) * Math.PI * 2); base([p[0] - 0.13 * q, p[1] - 0.13 * q, p[0] + 0.13 * q, p[1] - 0.13 * q, p[0] + 0.13 * q, p[1] + 0.13 * q, p[0] - 0.13 * q, p[1] + 0.13 * q], -0.1, 0.03 * q); }
      base(ngon((ringR = R * 0.9), 8, 0));
      break;
    }
    case 'tub':
      base(afTrap(af, 0, ca, B * 2 - 0.04, R * 1.96), -0.06, 0.04 * q);
      base(ngon(R, (sides = 14)));
      break;
    case 'stalk':
      base(afTrap(af, 0.015, Math.min(0.24 * q, ca * 0.5), Math.min(B * 2 - 0.1, R * 1.6), R * 0.5), -0.14, 0.03 * q);
      base(afTrap(af, 0, ca, R * 0.44, R * 0.44), -0.06, 0.025 * q);
      base(ngon((ringR = R * 0.88), (sides = 14)));
      break;
    case 'braced':
      for (const s of [-1, 1]) base(strut(af.p(0.06, s * (B - 0.12)), af.p(ca, s * R * 0.2), 0.13 * q), -0.08, 0.03 * q);
      foot(out, af, q);
      base(ngon((ringR = R * 0.92), (sides = 6), 0));
      break;
  }
  // Bolts round the ring, where there's room outside the race
  const rin = ringR * Math.cos(Math.PI / sides), n = Math.min(sides, 8);
  if (rin - 0.045 * q > 0.375 * q) for (let i = 0; i < n; i++) { const p = pr(rin - 0.05 * q, ((i + 0.5) / n) * Math.PI * 2); out.discs.push({ x: p[0], y: p[1], r: 0.024 * q, color: BOLT, sides: 6 }); }
  // A paint mark aft
  const pa = (u: number, v: number): Vec2 => [c[0] - f.n[0] * u + f.t[0] * v, c[1] - f.n[1] * u + f.t[1] * v];
  out.polys.push({ pts: [...pa(0.36 * q, -0.06 * q), ...pa(0.36 * q, 0.06 * q), ...pa(0.375 * q, 0.045 * q), ...pa(0.375 * q, -0.045 * q)], color: mix(accent, METAL, 0.2) });
  out.discs.push({ x: c[0], y: c[1], r: 0.355 * q, color: DARK, sides: 16 });
  out.discs.push({ x: c[0], y: c[1], r: 0.335 * q, color: RACE, bevel: 0.033 * q, sides: 16 });
  // Traverse marks: over its arc, a stop at each end in its paint; else all round
  const tick = (a: number, r0: number, r1: number, w: number, color: number) => {
    const p0 = pr(r0, a), p1 = pr(r1, a), tx = -Math.sin(a), ty = Math.cos(a), ox = (f.n[0] * tx + f.t[0] * ty) * w, oy = (f.n[1] * tx + f.t[1] * ty) * w;
    out.polys.push({ pts: [p0[0] - ox, p0[1] - oy, p1[0] - ox, p1[1] - oy, p1[0] + ox, p1[1] + oy, p0[0] + ox, p0[1] + oy], color });
  };
  if (arc) {
    const n = Math.max(2, Math.round(arc / (Math.PI / 8)));
    for (let i = 1; i < n; i++) tick(-arc / 2 + (arc * i) / n, 0.29 * q, (i % 2 ? 0.315 : 0.33) * q, 0.009 * q, DARK);
    for (const s of [-1, 1]) tick((s * arc) / 2, 0.26 * q, 0.355 * q, 0.016 * q, mix(accent, 0xffffff, 0.15));
  } else for (let i = 0; i < 12; i++) tick((i / 12) * Math.PI * 2, 0.29 * q, (i % 3 ? 0.315 : 0.33) * q, 0.009 * q, DARK);
  out.discs.push({ x: c[0], y: c[1], r: 0.28 * q, color: 0x151a24, sunk: true, sides: 16 });
  out.discs.push({ x: c[0], y: c[1], r: 0.09 * q, color: glow ?? 0xb45309, glow: glow ? 0.9 : 0.3, sides: 8 });
}

/**
 * A fixed gun: its family's housing as its base (housingOf), bolted on its
 * attach edge, and its barrels out of the facing edge (one gun on a model; a
 * legacy part one per cell of edge, as ever)
 */
function fixedMount(out: PartDecor, f: Frame, af: AF, fn: string, glow: number | undefined, size: number): void {
  const k = Math.sqrt(Math.max(1, size));
  const id = gunId(fn);
  const W = f.hi - f.lo, D = f.depth, mid = (f.lo + f.hi) / 2;
  const slots = !id.model && size < 4 ? Math.max(1, Math.round(W)) : 1;
  const slot = W / slots;
  const gun = fixedGun(fn, size);
  // (how far across its barrels reach: the embrasure's half-width)
  let spread = 0.06 * k;
  for (const p of gun.outline) for (let i = 1; i < p.length; i += 2) spread = Math.max(spread, Math.abs(p[i]));
  spread = Math.min(spread, slot * 0.44);
  const paint = mix(id.accent, METAL, 0.3);
  gunHousing(out, f, af, housingOf(fn), fn, glow ?? 0xff5a4a, paint, W, D, mid, k, spread, slots);
  for (let i = 0; i < slots; i++) {
    const s = f.lo + slot * (i + 0.5);
    out.barrels.push({ base: at(f, s, 0), n: f.n, t: f.t, shape: gun.outline[0] ?? [], len: gun.len, parts: gun.shapes, outline: gun.outline });
  }
}

/**
 * A fixed gun's housing, by kind, which is its base, open to the facing edge:
 *   casemate  an armoured block, its cheeks sloped in to the embrasure
 *   well      a round mortar tub on a tapered plate
 *   emitter   a rounded capsule on a forked bracket, finned, a lens at its heart
 *   spinal    a long cradle: a spine on saddles, a breech block at the back
 *   bay       a launcher box on lugs (a torpedo's rounded at its mouth), the bay sunk in it
 *   socket    a round socket on diagonal braces, its dish or coil inside
 * each on a bolted foot along its attach edge
 */
function gunHousing(out: PartDecor, f: Frame, af: AF, kind: Housing, fn: string, glow: number, paint: number, W: number, D: number, mid: number, k: number, spread: number, slots: number): void {
  const m = Math.min(0.1, W * 0.1, D * 0.1), slot = W / slots;
  const P = (pts: number[], color: number, o: Partial<DecorPoly> = {}) => out.polys.push({ pts, color, ...o });
  const C = (p: Vec2, r: number, color: number, o: Partial<DecorDisc> = {}) => out.discs.push({ ...pt(p), r, color, ...o });
  const B = (pts: number[], tone = 0, bevel = 0.06 * k) => out.base!.push({ pts, tone, bevel });
  const rivets = (s0: number, s1: number, d0: number, d1: number) => { for (const s of [s0, s1]) for (const d of [d0, d1]) C(at(f, s, d), 0.026 * k, BOLT, { sides: 6 }); };
  const fam = gunId(fn).family, model = gunId(fn).model;
  // An embrasure at the edge for each gun: a collar round a dark slot
  const embrasure = (depth: number) => {
    for (let i = 0; i < slots; i++) {
      const s = f.lo + slot * (i + 0.5), w = spread + 0.05 * k;
      P(box(f, s - w - 0.04 * k, s + w + 0.04 * k, 0, -depth - 0.05 * k), METAL, { bevel: 0.035 * k });
      P(box(f, s - w, s + w, 0, -depth), DARK);
    }
  };
  const back = -(D - m), fr = -0.015, s0 = f.lo + m, s1 = f.hi - m;
  switch (kind) {
    case 'casemate': {
      // Cheeks sloped in from halfway (less on a legacy gun with a barrel per cell)
      const nar = slots > 1 ? W * 0.04 : W * (fam === 'flak' ? 0.13 : 0.2), cc = Math.min(W, D) * 0.14;
      foot(out, af, k);
      B([...at(f, s0, back + cc), ...at(f, s0 + cc, back), ...at(f, s1 - cc, back), ...at(f, s1, back + cc), ...at(f, s1, back * 0.5), ...at(f, s1 - nar, fr), ...at(f, s0 + nar, fr), ...at(f, s0, back * 0.5)]);
      // Its paint across the back
      P(box(f, s0 + 0.14 * k, s1 - 0.14 * k, back + 0.07 * k, back + 0.12 * k), paint);
      rivets(s0 + 0.07 * k, s1 - 0.07 * k, back + 0.2 * k, back * 0.5 + 0.04 * k);
      // Recoil channels back from each slot
      for (let i = 0; i < slots; i++) { const s = f.lo + slot * (i + 0.5); P(box(f, s - 0.025 * k, s + 0.025 * k, -0.2 * k, -D * 0.62), DARK); }
      // Flak feeds from a drum
      if (fam === 'flak') { C(at(f, mid, -D * 0.6), 0.2 * k, DARK, { sides: 12 }); C(at(f, mid, -D * 0.6), 0.15 * k, METAL, { bevel: 0.03 * k, sides: 12 }); C(at(f, mid, -D * 0.6), 0.05 * k, 0xb45309, { glow: 0.3, sides: 8 }); }
      embrasure(0.17 * k);
      break;
    }
    case 'well': {
      // A round tub on a plate tapering to it
      const r = Math.min(W, D) * 0.46, c = at(f, mid, -D * 0.5);
      foot(out, af, k);
      B([...at(f, s0, back), ...at(f, s1, back), ...at(f, mid + r * 0.8, -D * 0.5), ...at(f, mid - r * 0.8, -D * 0.5)], -0.06, 0.04 * k);
      const tub: number[] = [];
      for (let i = 0; i < 12; i++) { const a = ((i + 0.5) / 12) * Math.PI * 2; tub.push(...at(f, mid + Math.cos(a) * r, -D * 0.5 + Math.sin(a) * r)); }
      B(tub);
      C(c, r * 0.6, DARK, { sunk: true, sides: 12 });
      C(c, r * 0.27, METAL, { sides: 10 });
      embrasure(0.12 * k);
      break;
    }
    case 'emitter': {
      // A capsule, round at the back, on a fork to its attach edge's corners
      const rw = Math.min(W * 0.36, D * 0.42, 0.45 * k), dc = back + rw, ch = rw * 0.25, heart = at(f, mid, dc);
      for (const s of [-1, 1]) B(strut(heart, af.p(0.04, s * (af.B - 0.13)), 0.1 * k), -0.1, 0.03 * k);
      foot(out, af, k);
      const cap = [...at(f, mid - rw + ch, fr), ...at(f, mid + rw - ch, fr), ...at(f, mid + rw, fr - ch)];
      for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI; cap.push(...at(f, mid + Math.cos(a) * rw, dc - Math.sin(a) * rw)); }
      cap.push(...at(f, mid - rw, fr - ch));
      B(cap);
      // Fins across its back, focus coils down its middle, the lens at its heart
      const fins = Math.max(3, Math.round(rw * 8));
      for (let i = 0; i < fins; i++) { const s = mid - rw * 0.55 + (rw * 1.1 * (i + 0.5)) / fins; P(box(f, s - 0.02 * k, s + 0.02 * k, dc - rw * 0.78, dc - rw * 0.42), DARK); }
      const cw = Math.min(spread * 1.3, rw * 0.8);
      for (const t of [0.35, 0.62]) { const d = dc + (fr - dc) * t; P(box(f, mid - cw, mid + cw, d + 0.03 * k, d - 0.03 * k), glow, { glow: 0.75 }); }
      C(heart, Math.min(0.14 * k, rw * 0.42), DARK, { sides: 12 });
      C(heart, Math.min(0.085 * k, rw * 0.26), glow, { glow: 0.9, sides: 10 });
      embrasure(0.12 * k);
      break;
    }
    case 'spinal': {
      // A spine on two saddles, a breech block at its back (a lance's saddles faceted)
      const w = Math.min(spread + 0.07 * k, W * 0.2), half = Math.min(W / 2 - m, w * 2.6), th = 0.07 * k, lance = fam === 'lance';
      for (const t of [0.36, 0.74]) B(plate(f, mid - half, mid + half, -D * t + th, -D * t - th, lance ? th * 0.9 : th * 0.3), -0.12, 0.035 * k);
      if (af.kind !== 'back') foot(out, af, k);
      B([...at(f, mid - w, -(D - 0.015)), ...at(f, mid + w, -(D - 0.015)), ...at(f, mid + w, -0.07 * k), ...at(f, mid + w * 0.7, fr), ...at(f, mid - w * 0.7, fr), ...at(f, mid - w, -0.07 * k)], 0, 0.05 * k);
      for (const t of [0.36, 0.74]) for (const s of [-1, 1]) C(at(f, mid + s * (half - 0.06 * k), -D * t), 0.024 * k, BOLT, { sides: 6 });
      for (const s of [-1, 1]) P(box(f, mid + s * spread * 0.75 - 0.015 * k, mid + s * spread * 0.75 + 0.015 * k, -0.05 * k, -(D - m * 3)), DARK);
      for (const t of [0.2, 0.52, 0.6]) P(box(f, mid - w * 0.85, mid + w * 0.85, -D * t + 0.026 * k, -D * t - 0.026 * k), glow, { glow: 0.7 });
      const bw = Math.min(w * 1.45, W / 2 - m);
      B(plate(f, mid - bw, mid + bw, -(D - m) + 0.17 * k, -(D - m), 0.04 * k), 0.08, 0.04 * k);
      for (const s of [-1, 1]) C(at(f, mid + s * bw * 0.75, -(D - m) + 0.085 * k), 0.026 * k, BOLT, { sides: 6 });
      break;
    }
    case 'bay': {
      // A launcher box on lugs out to its flanks (a torpedo's rounded at its mouth)
      const mb = W * 0.07 + m, b0 = f.lo + mb, b1 = f.hi - mb, bf = -m * 0.6, torp = fam === 'torpedo';
      foot(out, af, k);
      for (const [x0, x1] of [[f.lo + 0.015, b0 + 0.03], [b1 - 0.03, f.hi - 0.015]]) {
        B(box(f, x0, x1, back + D * 0.12, back + D * 0.36), -0.12, 0.025 * k);
        C(at(f, (x0 + x1) / 2, back + D * 0.24), 0.024 * k, BOLT, { sides: 6 });
      }
      if (torp) {
        const rr = Math.min(b1 - b0, D) * 0.3, cc = Math.min(W, D) * 0.08, mouth: number[] = [...at(f, b0 + cc, back), ...at(f, b1 - cc, back), ...at(f, b1, back + cc)];
        for (let i = 0; i <= 3; i++) { const a = (i / 3) * Math.PI / 2; mouth.push(...at(f, b1 - rr + Math.cos(a) * rr, bf - rr + Math.sin(a) * rr)); }
        for (let i = 0; i <= 3; i++) { const a = Math.PI / 2 + (i / 3) * Math.PI / 2; mouth.push(...at(f, b0 + rr + Math.cos(a) * rr, bf - rr + Math.sin(a) * rr)); }
        mouth.push(...at(f, b0, back + cc));
        B(mouth, 0, 0.05 * k);
      } else B(plate(f, b0, b1, bf, back, Math.min(W, D) * 0.2), 0, 0.05 * k);
      // The bay sunk into it, a blast deflector at its back
      const x0 = b0 + m, x1 = b1 - m, d0 = bf - m * (torp ? 2.4 : 1), d1 = back + m * 1.6;
      P(box(f, x0, x1, d0, d1), DARK, { sunk: true, bevel: 0.05 * k });
      P(box(f, x0, x1, d1 - 0.03 * k, d1 - 0.1 * k), paint);
      if (torp) {
        // Torpedoes in their tubes, noses to the edge
        const n = model.includes('leviathan') ? 2 : 1, tw = (x1 - x0) / n;
        for (let i = 0; i < n; i++) {
          const s = x0 + tw * (i + 0.5), r = Math.min(tw * 0.3, 0.14 * k);
          P(box(f, s - r, s + r, d0 - 0.04, d1 + 0.06 * k), METAL, { bevel: 0.03 * k });
          P(box(f, s - r * 0.6, s + r * 0.6, d0 - 0.04, d0 - 0.04 - 0.12 * k), 0xb45309, { glow: 0.25 });
        }
      } else {
        // Launch tubes: a grid of dark mouths with warm rims (a hive's: honeycomb; a swarm's many small, a hammerhead's few great)
        const BW = x1 - x0, BD = d0 - d1;
        const dens = model.endsWith('swarm') ? 3.4 : model.endsWith('hammerhead') ? 1.2 : 2.2;
        const cols = Math.max(2, Math.round(BW * dens)), rows = Math.max(1, Math.round(BD * dens * 0.9));
        const hex = fam === 'hive';
        for (let a = 0; a < cols; a++) for (let b = 0; b < rows; b++) {
          const p = at(f, x0 + (BW * (a + 0.5)) / cols, d1 + (BD * (b + 0.5)) / rows);
          const r = Math.min(BW / cols, BD / rows) * 0.38;
          C(p, r * 1.15, METAL, { sides: hex ? 6 : 10 });
          C(p, r, hex ? glow : 0xb45309, { glow: hex ? 0.5 : 0.3, sides: hex ? 6 : 10 });
          C(p, r * 0.68, 0x0b0f17, { sides: hex ? 6 : 10 });
        }
      }
      break;
    }
    case 'socket': {
      // A round socket on braces out to its attach edge's corners
      const c = at(f, mid, -D * 0.5), r = Math.min(W, D) * 0.45;
      for (const s of [-1, 1]) B(strut(c, af.p(0.05, s * (af.B - 0.12)), 0.13 * k), -0.1, 0.03 * k);
      foot(out, af, k);
      const ring: number[] = [];
      for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; ring.push(c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r); }
      B(ring);
      const rs = r * 0.76;
      C(c, rs, DARK, { sunk: true, sides: 14 });
      if (fam === 'arc') {
        // A wound coil
        for (const [kr, col] of [[0.78, METAL], [0.62, DARK], [0.48, METAL], [0.34, DARK]] as const) C(c, rs * kr, col, { sides: 12 });
        C(c, rs * 0.2, glow, { glow: 0.9, sides: 8 });
      } else for (const [kr, g] of [[0.72, 0.25], [0.5, 0.5], [0.26, 0.9]] as const) C(c, rs * kr, g > 0.6 ? glow : g > 0.4 ? 0x3b82f6 : DARK, { glow: g, sides: 12 });
      embrasure(0.08 * k);
      break;
    }
  }
}

/**
 * A mining laser: a glowing crystal chamber in its housing, a focusing tube
 * with coolant rings out of the facing edge, a lens at its tip, and two claws
 * either side that steady the rock.
 */
function miner(out: PartDecor, f: Frame, W: number, D: number, mid: number, size: number): void {
  const k = Math.sqrt(Math.max(1, size));
  housing(out, f, W, D, 0x2c3a44);
  const w = 0.1 * k, l = 0.42 * k;
  // Claws
  for (const sg of [-1, 1]) {
    const b0 = mid + sg * 0.3 * k, b1 = mid + sg * 0.17 * k, cw = 0.05 * k;
    out.polys.push({ pts: [...at(f, b0 - cw, -D * 0.2), ...at(f, b0 + cw, -D * 0.2), ...at(f, b1 + cw, l * 0.95), ...at(f, b1 - cw, l * 0.95)], color: METAL });
    out.polys.push({ pts: [...at(f, b1 - cw, l * 0.95), ...at(f, b1 + cw, l * 0.95), ...at(f, b1 - sg * 0.05 * k, l * 1.12)], color: BELL });
  }
  // The focusing tube, with coolant rings
  out.polys.push({ pts: box(f, mid - w, mid + w, l, -D * 0.5), color: METAL });
  for (const d of [0.02, l * 0.36, l * 0.66]) out.polys.push({ pts: box(f, mid - w * 1.35, mid + w * 1.35, d + 0.03 * k, d - 0.03 * k), color: DARK });
  // The emitter flares out to a glowing lens
  out.polys.push({ pts: quad(f, mid - w, l, mid - w * 1.6, l + 0.1 * k, mid + w * 1.6, l + 0.1 * k, mid + w, l), color: BELL });
  out.polys.push({ pts: box(f, mid - w * 1.25, mid + w * 1.25, l + 0.1 * k, l + 0.06 * k), color: MINER_GLOW, glow: 0.85 });
  // The crystal chamber
  const chamber = at(f, mid, -D * 0.58);
  out.discs.push({ ...pt(chamber), r: 0.25 * k, color: DARK });
  out.discs.push({ ...pt(chamber), r: 0.17 * k, color: MINER_GLOW, glow: 0.8 });
  out.discs.push({ ...pt(chamber), r: 0.07 * k, color: 0xe0fffb, glow: 1 });
}

/** A battery: a dark casing with a row of glowing charge cells (coloured by which pool it fills) and a terminal */
function battery(out: PartDecor, geom: PlacedGeom, glow: number): void {
  const k = Math.sqrt(Math.max(1, geom.area));
  const c = geom.centroid;
  const w = 0.5 * k, h = 0.3 * k;
  const rect = (x0: number, y0: number, x1: number, y1: number) => [c[0] + x0, c[1] + y0, c[0] + x1, c[1] + y0, c[0] + x1, c[1] + y1, c[0] + x0, c[1] + y1];
  out.polys.push({ pts: rect(-w / 2 - 0.05, -h / 2 - 0.05, w / 2 + 0.05, h / 2 + 0.05), color: DARK });
  const cells = Math.max(3, Math.round(3 * k));
  const cw = w / cells;
  for (let i = 0; i < cells; i++) {
    const x0 = -w / 2 + i * cw + cw * 0.15;
    out.polys.push({ pts: rect(x0, -h / 2 + 0.03, x0 + cw * 0.7, h / 2 - 0.03), color: glow, glow: 0.55 });
  }
  // The terminal
  out.polys.push({ pts: rect(w / 2 + 0.05, -h * 0.22, w / 2 + 0.05 + 0.07 * k, h * 0.22), color: METAL });
}

/** The Stabiliser Anchor: a clamp pad in each corner of its outline, struts in to a bolted hub with a lit core */
function anchor(out: PartDecor, geom: PlacedGeom, glow: number): void {
  const k = Math.sqrt(Math.max(1, geom.area));
  const c = geom.centroid;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of geom.polygon) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  const inset = 0.12, pad = 0.22 * k;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const px = sx < 0 ? x0 + inset : x1 - inset, py = sy < 0 ? y0 + inset : y1 - inset;
    // The strut, from the hub out to the pad
    const ux = px - c[0], uy = py - c[1], l = Math.hypot(ux, uy) || 1, w = 0.05 * k;
    out.polys.push({ pts: [c[0] - (uy / l) * w, c[1] + (ux / l) * w, px - (uy / l) * w, py + (ux / l) * w, px + (uy / l) * w, py - (ux / l) * w, c[0] + (uy / l) * w, c[1] - (ux / l) * w], color: GUNMETAL });
    // The pad: an L-shaped clamp hugging the corner
    const ex = px - sx * pad, ey = py - sy * pad, t = 0.08 * k;
    out.polys.push({ pts: [px, py, ex, py, ex, py - sy * t, px - sx * t, py - sy * t, px - sx * t, ey, px, ey], color: METAL, bevel: 0.03 });
  }
  out.discs.push({ x: c[0], y: c[1], r: 0.27 * k, color: DARK, bevel: 0.04, sides: 8 });
  out.discs.push({ x: c[0], y: c[1], r: 0.2 * k, color: BELL, sides: 8 });
  out.discs.push({ x: c[0], y: c[1], r: 0.09 * k, color: glow, glow: 0.6 });
}

/** A turret's silhouette (its head's outline: hit shapes, simple previews), in its own frame (x out along the barrel) */
export function turretBarrel(fn: string, len: number, size: number): number[][] {
  return turretHead(fn, len, size).outline;
}

const pt = (p: Vec2) => ({ x: p[0], y: p[1] });

/** A barrel's shape in grid units (at its base, unrecoiled) */
export function barrelPoints(b: DecorBarrel): number[] {
  return place(b.shape, b);
}
/** Points in a barrel's frame to grid units */
function place(shape: number[], b: { base: Vec2; n: Vec2; t: Vec2 }): number[] {
  const out: number[] = [];
  for (let i = 0; i < shape.length; i += 2) {
    const u = shape[i], v = shape[i + 1];
    out.push(b.base[0] + b.n[0] * u + b.t[0] * v, b.base[1] + b.n[1] * u + b.t[1] * v);
  }
  return out;
}

const cache = new WeakMap<PlacedGeom, PartDecor>();

/** partDecor, worked out once per placed part (geometries are cached per design) */
export function decorOf(geom: PlacedGeom): PartDecor {
  let d = cache.get(geom);
  if (!d) { d = partDecor(geom); cache.set(geom, d); }
  return d;
}

const css = (c: number, glow = 0) => {
  // Glowing bits read brighter on a flat canvas
  const k = 1 + glow * 0.25;
  const r = Math.min(255, ((c >> 16) & 255) * k), g = Math.min(255, ((c >> 8) & 255) * k), b = Math.min(255, (c & 255) * k);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
};

/**
 * Draw a part's hardware on a 2D canvas (the hangar, item icons): `map` takes
 * grid points to the canvas, `scale` is pixels per cell. Turrets show their
 * head along the part's facing, over their mount.
 */
export function drawDecor2d(ctx: CanvasRenderingContext2D, geom: PlacedGeom, map: (x: number, y: number) => [number, number], scale: number, alpha = 1, glowCss?: string, barrelsOnly = false): void {
  const d = decorOf(geom);
  const poly = (pts: number[], fill: string) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) { const [x, y] = map(pts[i], pts[i + 1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  ctx.save();
  ctx.globalAlpha *= alpha;
  for (const b of d.barrels) for (const s of b.parts) poly(place(s.pts, b), css(s.color));
  // (just the guns' moving parts: the rest is drawn by the hull itself, as in the hangar's lit view)
  if (!barrelsOnly) {
    // A weapon's base (the rest of its cell open)
    if (d.base) {
      const c = functionColor(geom.part.fn);
      for (const b of d.base) poly(b.pts, css(mix(c, b.tone > 0 ? 0xffffff : 0, Math.abs(b.tone))));
    }
    for (const p of d.polys) poly(p.pts, css(p.color, p.glow));
    for (const c of d.discs) {
      const [x, y] = map(c.x, c.y);
      ctx.beginPath();
      ctx.arc(x, y, c.r * scale, 0, Math.PI * 2);
      // (glowing discs in their grade's glow, if given: engines' chambers, lenses)
      ctx.fillStyle = c.glow && glowCss ? glowCss : css(c.color, c.glow);
      ctx.fill();
    }
  }
  const tm = isTurret(geom.part) ? mountOf(geom) : null;
  if (tm) {
    const n = tm.dir, t: Vec2 = [-n[1], n[0]];
    const head = turretHead(geom.part.fn, 0.8 * Math.sqrt(Math.max(1, geom.area)), geom.area);
    for (const s of head.shapes) poly(place(s.pts, { base: geom.centroid, n, t }), css(s.color));
  }
  ctx.restore();
}
