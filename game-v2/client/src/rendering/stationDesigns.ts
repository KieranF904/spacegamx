/**
 * Station designs. Each builds a station's lit geometry from its radius and
 * seed: the fixed structure, a part that turns, its blinking and chasing
 * lights, its lamps, and the hardpoints where defence turrets mount
 * (StationView adds the turrets themselves).
 *
 *   ring         a hub, a habitat ring on spokes, solar arrays, docking pylons
 *   outpost      modules strung along a truss, tanks, cargo, one solar wing
 *   observatory  a hub with a great dish, lab wings and an antenna boom
 *   bastion      an armoured hexagonal keep with gun platforms on its arms
 *   shipyard     a gantry frame round a hull being built, welders sparking
 *   refinery     a glowing furnace ringed by tanks, stacks and hot radiators
 */

import { LitGeometry, ShapeOpts } from './lighting/LitGeometry';
import { StationGeometry } from './stations/StationGeometry';

export const HULL = 0xb8c2cf;
export const HULL_DARK = 0x7f8a99;
export const HULL_EDGE = 0x4d5766;
const HULL_MID = 0xa6b1bf;
const STRUT = 0x6b7584;
const PANEL = 0x1c3557;
const PANEL_GRID = 0x4f78a8;
const WINDOW = 0xffd890;
const RED = 0xff4040;
const GREEN = 0x40ff70;
const WHITE = 0xf2f6ff;

export interface NavTip { x: number; y: number; color: number; phase: number }
export interface Lamp { x: number; y: number; color: number; radius: number; power: number; height: number }

export interface StationLayout {
  /** (Built as StationGeometry, which remembers each shape drawn, for the station look: stations/) */
  body: LitGeometry;
  /** The part that turns, about `spinAt` (empty: nothing turns) */
  spin: LitGeometry;
  spinAt: { x: number; y: number };
  spinRate: number;
  spinRadius: number;
  navTips: NavTip[];
  /** Lights chased round in turn */
  chase: { x: number; y: number }[];
  chaseColor?: number;
  /** Where turrets mount, best first; `rest` is the way one faces when idle */
  hardpoints: { x: number; y: number; rest: number }[];
  lamps: Lamp[];
  /** How far the structure reaches from the centre */
  reach: number;
}

interface Ctx { R: number; r: () => number; accent: number; turrets: number; axis: number }

type Pt = [number, number];

/** Coordinates along an axis: u along it, v across */
const along = (axis: number) => {
  const c = Math.cos(axis), s = Math.sin(axis);
  return (u: number, v: number): Pt => [c * u - s * v, s * u + c * v];
};

/** A rectangle in (u, v), corners cut by `chamfer` */
function box(g: LitGeometry, P: (u: number, v: number) => Pt, u0: number, v0: number, u1: number, v1: number, color: number, o: ShapeOpts, chamfer = 0): void {
  const c = chamfer;
  const uv = c > 0
    ? [u0 + c, v0, u1 - c, v0, u1, v0 + c, u1, v1 - c, u1 - c, v1, u0 + c, v1, u0, v1 - c, u0, v0 + c]
    : [u0, v0, u1, v0, u1, v1, u0, v1];
  const pts: number[] = [];
  for (let i = 0; i < uv.length; i += 2) pts.push(...P(uv[i], uv[i + 1]));
  g.panel(pts, color, o);
}

/** A regular polygon */
function ngon(g: LitGeometry, x: number, y: number, r: number, sides: number, turn: number, color: number, o: ShapeOpts): void {
  const pts: number[] = [];
  for (let k = 0; k < sides; k++) { const a = turn + (k / sides) * Math.PI * 2; pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  g.panel(pts, color, o);
}

const outward = (x: number, y: number) => Math.atan2(y, x);

function layout(R: number, accent: number): StationLayout {
  return {
    body: new StationGeometry(), spin: new StationGeometry(), spinAt: { x: 0, y: 0 }, spinRate: 0, spinRadius: 0,
    navTips: [], chase: [], hardpoints: [], reach: R * 2.5,
    lamps: [{ x: 0, y: 0, color: accent, radius: R * 3.2, power: 0.55, height: R * 1.2 }],
  };
}

// ---------------------------------------------------------------------------

function ring({ R, r, accent, axis }: Ctx): StationLayout {
  const L = layout(R, accent);
  const body = L.body, spin = L.spin;
  const bevel = R * 0.035;

  // Solar arrays along the station's axis (they don't spin with the ring)
  for (const dir of [-1, 1]) {
    const c = Math.cos(axis) * dir, s = Math.sin(axis) * dir;
    const nx = -s, ny = c;
    const from = R * 1.75, to = R * 3.1, half = R * 0.32;
    body.bar(c * R * 0.5, s * R * 0.5, c * from, s * from, R * 0.07, HULL_DARK, { bevel: R * 0.02 });
    const corner = (d: number, w: number): Pt => [c * d + nx * w, s * d + ny * w];
    // Each cell its own panel, so light runs across the array cell by cell
    const cells = 6;
    for (let k = 0; k < cells; k++) {
      const d0 = from + ((to - from) * k) / cells, d1 = from + ((to - from) * (k + 1)) / cells;
      for (const [w0, w1] of [[-half, 0], [0, half]]) {
        body.panel([...corner(d0, w0), ...corner(d1, w0), ...corner(d1, w1), ...corner(d0, w1)], PANEL, { bevel: R * 0.018, edge: PANEL_GRID });
      }
    }
    body.bar(...corner(from, -half), ...corner(from, half), R * 0.035, 0x8a96a6, { bevel: R * 0.01 });
    body.bar(...corner(to, -half), ...corner(to, half), R * 0.035, 0x8a96a6, { bevel: R * 0.01 });
    L.hardpoints.push({ x: c * R * 1.66, y: s * R * 1.66, rest: axis + (dir < 0 ? Math.PI : 0) });
  }

  // Docking pylons, perpendicular to the arrays, with nav lights on the tips
  for (const dir of [-1, 1]) {
    const a = axis + Math.PI / 2;
    const c = Math.cos(a) * dir, s = Math.sin(a) * dir;
    const tip = R * 2.0;
    body.bar(0, 0, c * tip, s * tip, R * 0.14, HULL, { bevel: R * 0.04, edge: HULL_DARK });
    const nx = -s * R * 0.22, ny = c * R * 0.22;
    body.panel([c * tip + nx, s * tip + ny, c * (tip + R * 0.18) + nx, s * (tip + R * 0.18) + ny,
      c * (tip + R * 0.18) - nx, s * (tip + R * 0.18) - ny, c * tip - nx, s * tip - ny], HULL, { bevel, edge: HULL_EDGE });
    L.navTips.push({ x: c * (tip + R * 0.18) + nx, y: s * (tip + R * 0.18) + ny, color: dir < 0 ? RED : GREEN, phase: r() });
    L.navTips.push({ x: c * (tip + R * 0.18) - nx, y: s * (tip + R * 0.18) - ny, color: dir < 0 ? RED : GREEN, phase: r() });
    L.hardpoints.splice(dir < 0 ? 0 : 1, 0, { x: c * R * 1.78, y: s * R * 1.78, rest: a + (dir < 0 ? Math.PI : 0) });
  }

  // Habitat ring on spokes (this part turns)
  const spokes = r() < 0.5 ? 3 : 4;
  const ro = R * 1.55, ri = R * 1.28;
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2;
    spin.bar(Math.cos(a) * R * 0.45, Math.sin(a) * R * 0.45, Math.cos(a) * ri, Math.sin(a) * ri, R * 0.11, HULL_DARK, { bevel: R * 0.03 });
  }
  const segs = 24;
  for (let k = 0; k < segs; k++) {
    const a0 = (k / segs) * Math.PI * 2, a1 = ((k + 1) / segs) * Math.PI * 2 - 0.02;
    const p = (rad: number, a: number) => [Math.cos(a) * rad, Math.sin(a) * rad];
    // Curved: a few corners along each edge, so the rim's tilt turns with the ring
    const pts: number[] = [];
    for (let t = 0; t <= 2; t++) pts.push(...p(ro, a0 + ((a1 - a0) * t) / 2));
    for (let t = 2; t >= 0; t--) pts.push(...p(ri, a0 + ((a1 - a0) * t) / 2));
    spin.panel(pts, k % 2 ? HULL : HULL_MID, { bevel: R * 0.04, edge: HULL_EDGE });
    // Lit windows along the outer rim (they glow by themselves)
    if (r() < 0.8) {
      const am = (a0 + a1) / 2;
      for (const off of [-0.035, 0.035]) {
        spin.disc(Math.cos(am + off) * (ro - R * 0.07), Math.sin(am + off) * (ro - R * 0.07), R * 0.025, WINDOW, { glow: 1 }, 6);
      }
    }
  }
  L.spinRate = (r() < 0.5 ? -1 : 1) * (0.04 + r() * 0.04);
  L.spinRadius = R * 1.6;

  // Hub
  ngon(body, 0, 0, R * 0.55, 8, Math.PI / 8, HULL, { bevel: R * 0.06, edge: HULL_EDGE });
  body.disc(0, 0, R * 0.36, 0x3a4250, { bevel: R * 0.04, edge: accent });
  body.disc(0, 0, R * 0.16, 0x252b36, { bevel: R * 0.03 });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    L.chase.push({ x: Math.cos(a) * R * 0.27, y: Math.sin(a) * R * 0.27 });
  }
  L.reach = R * 3.2;
  return L;
}

// ---------------------------------------------------------------------------

const CARGO = [0xb5523b, 0x3b7fb5, 0xd0a23a, 0x4f9a5a, 0x8c8f96];

function outpost({ R, r, accent, axis }: Ctx): StationLayout {
  const L = layout(R, accent);
  const g = L.body;
  const P = along(axis);
  const len = R * (1.7 + r() * 0.5);

  // Truss spine
  g.bar(...P(-len, 0), ...P(len, 0), R * 0.1, HULL_DARK, { bevel: R * 0.025 });
  for (let u = -len + R * 0.15; u < len; u += R * 0.28) g.bar(...P(u, -R * 0.12), ...P(u, R * 0.12), R * 0.035, STRUT, { bevel: R * 0.01 });

  // One solar wing across the far end
  const wu = -len - R * 0.05;
  g.bar(...P(wu, -R * 1.5), ...P(wu, R * 1.5), R * 0.06, HULL_DARK, { bevel: R * 0.015 });
  for (const side of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const v0 = side * (R * 0.16 + k * R * 0.34), v1 = side * (R * 0.16 + (k + 1) * R * 0.34 - R * 0.035);
      box(g, P, wu - R * 0.28, Math.min(v0, v1), wu + R * 0.28, Math.max(v0, v1), PANEL, { bevel: R * 0.018, edge: PANEL_GRID });
    }
  }

  // Tanks on struts to one side, cargo racked on the other
  const tankSide = r() < 0.5 ? -1 : 1;
  for (let k = 0; k < 2; k++) {
    const u = (k - 0.5) * R * 0.5 - len * 0.2;
    const [x, y] = P(u, tankSide * R * 0.62);
    g.bar(...P(u, 0), x, y, R * 0.06, HULL_DARK, { bevel: R * 0.015 });
    g.disc(x, y, R * 0.18, k ? 0xd8dde4 : 0xc9b48a, { bevel: R * 0.07, edge: 0x6d6556 }, 14);
  }
  const cs = -tankSide;
  g.bar(...P(len * 0.12, cs * R * 0.43), ...P(len * 0.88, cs * R * 0.43), R * 0.05, STRUT, { bevel: R * 0.012 });
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      if (r() > 0.8) continue;
      const u = len * 0.16 + col * R * 0.2, v = cs * (R * 0.52 + row * R * 0.12);
      box(g, P, u, v - R * 0.05, u + R * 0.17, v + R * 0.05, CARGO[Math.floor(r() * CARGO.length)], { bevel: R * 0.014 });
    }
  }

  // Modules along the spine, windows lit
  const n = 3 + Math.floor(r() * 2);
  const span = len * 2 - R * 1.1;
  let radarAt: Pt = [0, 0];
  for (let k = 0; k < n; k++) {
    const u = -len + R * 0.55 + (span * (k + 0.5)) / n;
    const w = Math.min(span / n - R * 0.08, R * (0.38 + r() * 0.2)), h = R * (0.26 + r() * 0.14);
    const off = r() < 0.35 ? 0 : (k % 2 ? 1 : -1) * R * 0.14;
    box(g, P, u - w / 2, off - h / 2, u + w / 2, off + h / 2, k % 2 ? HULL : HULL_MID, { bevel: R * 0.035, edge: HULL_EDGE }, R * 0.06);
    const lit = r() < 0.5 ? WINDOW : 0xcfe9ff;
    for (let q = -1; q <= 1; q += 2) {
      for (let wx = -w / 2 + R * 0.1; wx < w / 2 - R * 0.07; wx += R * 0.09) {
        if (r() < 0.75) g.disc(...P(u + wx, off + q * h * 0.28), R * 0.02, lit, { glow: 1 }, 6);
      }
    }
    if (k === 1) radarAt = P(u, off);
    // An antenna mast off the last one
    if (k === n - 1) {
      const tip = P(u, off - tankSide * R * 0.7);
      g.bar(...P(u, off), ...tip, R * 0.025, 0x9aa5b4, { bevel: R * 0.006 });
      L.navTips.push({ x: tip[0], y: tip[1], color: WHITE, phase: r() });
    }
  }

  // Docking cap at the near end, nav lights on its corners; landing lights run out along the spine
  box(g, P, len - R * 0.06, -R * 0.36, len + R * 0.12, R * 0.36, HULL, { bevel: R * 0.03, edge: HULL_EDGE });
  for (const s of [-1, 1]) {
    const [x, y] = P(len + R * 0.1, s * R * 0.34);
    L.navTips.push({ x, y, color: s < 0 ? RED : GREEN, phase: r() });
  }
  for (let u = -len + R * 0.2; u <= len; u += R * 0.3) { const [x, y] = P(u, 0); L.chase.push({ x, y }); }

  // A radar turning on the second module
  L.spinAt = { x: radarAt[0], y: radarAt[1] };
  L.spin.bar(-R * 0.2, 0, R * 0.2, 0, R * 0.04, 0x9aa5b4, { bevel: R * 0.01 });
  L.spin.bowl(R * 0.2, 0, R * 0.08, 0xdfe5ee, {}, 8);
  L.spin.disc(0, 0, R * 0.06, HULL_DARK, { bevel: R * 0.015 });
  L.spinRate = 0.9 * (r() < 0.5 ? -1 : 1);
  L.spinRadius = R * 0.3;

  for (const [u, v] of [[len * 0.5, 1], [-len * 0.45, -1], [len * 0.5, -1], [-len * 0.45, 1]]) {
    const [x, y] = P(u, v * R * 0.32);
    L.hardpoints.push({ x, y, rest: outward(x, y) });
  }
  L.lamps[0].radius = R * 2.6;
  L.lamps[0].power = 0.45;
  L.reach = Math.max(len, R * 1.5) + R * 0.35;
  return L;
}

// ---------------------------------------------------------------------------

function observatory({ R, r, accent, axis }: Ctx): StationLayout {
  const L = layout(R, accent);
  const g = L.body;
  const P = along(axis);

  // Antenna boom out the back, fins shortening along it
  const boom = R * 2.3;
  g.bar(...P(-R * 0.4, 0), ...P(-boom, 0), R * 0.09, HULL_DARK, { bevel: R * 0.02 });
  for (let k = 0; k < 6; k++) {
    const u = -R * 0.95 - k * R * 0.24, w = R * (0.55 - k * 0.07);
    g.bar(...P(u, -w), ...P(u, w), R * 0.03, 0x9aa5b4, { bevel: R * 0.008 });
  }
  const tip = P(-boom, 0);
  L.navTips.push({ x: tip[0], y: tip[1], color: WHITE, phase: r() });

  // Lab wings across the hub
  const lab = r() < 0.5 ? 0xcfe9ff : WINDOW;
  for (const s of [-1, 1]) {
    box(g, P, -R * 0.24, s > 0 ? R * 0.45 : -R * 1.2, R * 0.24, s > 0 ? R * 1.2 : -R * 0.45, s > 0 ? HULL : HULL_MID, { bevel: R * 0.04, edge: HULL_EDGE }, R * 0.08);
    for (let v = R * 0.58; v < R * 1.1; v += R * 0.1) {
      for (const u of [-R * 0.12, R * 0.12]) if (r() < 0.8) g.disc(...P(u, s * v), R * 0.022, lab, { glow: 1 }, 6);
    }
    const [x, y] = P(0, s * R * 1.24);
    L.navTips.push({ x, y, color: s < 0 ? RED : GREEN, phase: r() });
  }

  // The great dish on its arm
  const dc = R * 1.45, dr = R * 0.85;
  g.bar(...P(R * 0.3, 0), ...P(dc - dr * 0.7, 0), R * 0.2, HULL, { bevel: R * 0.045, edge: HULL_EDGE });
  const [dx, dy] = P(dc, 0);
  g.disc(dx, dy, dr, 0x8d98a8, { bevel: R * 0.06, edge: HULL_EDGE }, 22);
  g.bowl(dx, dy, dr * 0.9, 0xe4e9f0, {}, 20);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    g.bar(dx + Math.cos(a) * dr * 0.2, dy + Math.sin(a) * dr * 0.2, dx + Math.cos(a) * dr * 0.88, dy + Math.sin(a) * dr * 0.88, R * 0.02, 0xb2bccb);
  }
  for (let k = 0; k < 3; k++) {
    const a = axis + Math.PI / 2 + (k / 3) * Math.PI * 2;
    g.bar(dx + Math.cos(a) * dr * 0.86, dy + Math.sin(a) * dr * 0.86, dx, dy, R * 0.028, 0x7f8a99, { bevel: R * 0.006 });
  }
  g.disc(dx, dy, R * 0.1, 0x3a4250, { bevel: R * 0.025, edge: accent });
  g.disc(dx, dy, R * 0.04, accent, { glow: 1 }, 8);

  // Hub
  ngon(g, 0, 0, R * 0.62, 8, Math.PI / 8, HULL, { bevel: R * 0.06, edge: HULL_EDGE });
  g.disc(0, 0, R * 0.42, 0x3a4250, { bevel: R * 0.04, edge: accent });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    L.chase.push({ x: Math.cos(a) * R * 0.5, y: Math.sin(a) * R * 0.5 });
  }

  // A sensor crown turning on the hub
  for (let k = 0; k < 6; k++) {
    const a0 = (k / 6) * Math.PI * 2 + 0.08, a1 = ((k + 1) / 6) * Math.PI * 2 - 0.08;
    const pts = [Math.cos(a0) * R * 0.2, Math.sin(a0) * R * 0.2, Math.cos(a0) * R * 0.34, Math.sin(a0) * R * 0.34,
      Math.cos(a1) * R * 0.34, Math.sin(a1) * R * 0.34, Math.cos(a1) * R * 0.2, Math.sin(a1) * R * 0.2];
    L.spin.panel(pts, k % 2 ? HULL_MID : 0x8d98a8, { bevel: R * 0.02, edge: HULL_EDGE });
  }
  L.spin.bar(0, 0, R * 0.36, 0, R * 0.08, 0x5a6472, { bevel: R * 0.02 });
  L.spin.disc(0, 0, R * 0.12, 0x252b36, { bevel: R * 0.03, edge: accent });
  L.spinRate = 0.12 * (r() < 0.5 ? -1 : 1);
  L.spinRadius = R * 0.4;

  for (const [u, v] of [[0, R * 1.0], [0, -R * 1.0], [-R * 0.75, R * 0.42], [-R * 0.75, -R * 0.42]]) {
    const [x, y] = P(u, v);
    L.hardpoints.push({ x, y, rest: outward(x, y) });
  }
  L.lamps.push({ x: dx, y: dy, color: 0xcfe9ff, radius: R * 1.4, power: 0.35, height: R * 0.6 });
  L.reach = R * 2.45;
  return L;
}

// ---------------------------------------------------------------------------

const GUNMETAL = 0x8d96a3;
const GUN_DARK = 0x6a737f;
const GUN_EDGE = 0x434b56;

function bastion({ R, r, accent, axis, turrets }: Ctx): StationLayout {
  const L = layout(R, accent);
  const g = L.body;
  const arms = turrets === 3 || (turrets < 3 && r() < 0.5) ? 3 : 4;

  // Arms out to the gun platforms (beneath the keep)
  const end = R * 1.95;
  for (let k = 0; k < arms; k++) {
    const a = axis + (k / arms) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    g.bar(c * R * 0.6, s * R * 0.6, c * end, s * end, R * 0.34, GUN_DARK, { bevel: R * 0.06, edge: GUN_EDGE });
    // Hazard stripes across each arm, past the keep's skirt
    const P = along(a);
    for (let q = 0; q < 3; q++) {
      const u = R * (1.32 + q * 0.11);
      g.flat([...P(u, -R * 0.15), ...P(u + R * 0.05, -R * 0.15), ...P(u + R * 0.11, R * 0.15), ...P(u + R * 0.06, R * 0.15)], 0xd9a640);
    }
    ngon(g, c * end, s * end, R * 0.4, 8, a + Math.PI / 8, GUNMETAL, { bevel: R * 0.07, edge: GUN_EDGE });
    g.disc(c * end, s * end, R * 0.26, GUN_DARK, { bevel: R * 0.03 }, 12);
    L.hardpoints.push({ x: c * end, y: s * end, rest: a });
    const [nx, ny] = P(end + R * 0.4, R * 0.18), [mx, my] = P(end + R * 0.4, -R * 0.18);
    L.navTips.push({ x: nx, y: ny, color: RED, phase: r() }, { x: mx, y: my, color: WHITE, phase: r() });
  }

  // The keep: an armoured hexagon skirted with plates
  const turn = axis + Math.PI / 6;
  const corner = (k: number, rad: number): Pt => [Math.cos(turn + (k / 6) * Math.PI * 2) * rad, Math.sin(turn + (k / 6) * Math.PI * 2) * rad];
  const lerp = (a: Pt, b: Pt, t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  for (let k = 0; k < 6; k++) {
    const i0 = corner(k, R * 1.0), i1 = corner(k + 1, R * 1.0), o0 = corner(k, R * 1.22), o1 = corner(k + 1, R * 1.22);
    g.panel([...lerp(i0, i1, 0.06), ...lerp(o0, o1, 0.1), ...lerp(o0, o1, 0.9), ...lerp(i0, i1, 0.94)], k % 2 ? GUN_DARK : 0x7a838f, { bevel: R * 0.035, edge: GUN_EDGE });
  }
  ngon(g, 0, 0, R * 1.05, 6, turn, GUNMETAL, { bevel: R * 0.09, edge: GUN_EDGE });
  ngon(g, 0, 0, R * 0.66, 6, turn, 0x5c6470, { bevel: R * 0.05, edge: accent });
  g.disc(0, 0, R * 0.3, 0x2a2f38, { bevel: R * 0.04 }, 12);

  // Hangar bays in the keep's faces between the arms, their lips lit amber
  for (let k = 0; k < arms; k++) {
    const a = axis + ((k + 0.5) / arms) * Math.PI * 2;
    const P = along(a);
    box(g, P, R * 0.7, -R * 0.22, R * 0.9, R * 0.22, 0x14181e, { bevel: R * 0.02, edge: 0x2a2f38 });
    g.flat([...P(R * 0.69, -R * 0.22), ...P(R * 0.72, -R * 0.22), ...P(R * 0.72, R * 0.22), ...P(R * 0.69, R * 0.22)], 0xffb547, { glow: 1 });
    // Spare hardpoints over the bays, if the battery outnumbers the arms
    const [x, y] = P(R * 1.12, 0);
    L.hardpoints.push({ x, y, rest: a });
  }
  for (let k = 0; k < 6; k++) { const [x, y] = corner(k, R * 0.52); L.chase.push({ x, y }); }
  L.chaseColor = 0xff5a4a;

  // A radar sweeping over the keep
  L.spin.bar(-R * 0.45, 0, R * 0.45, 0, R * 0.08, 0x9aa5b4, { bevel: R * 0.02 });
  L.spin.bowl(R * 0.45, 0, R * 0.12, 0xdfe5ee, {}, 9);
  L.spin.bowl(-R * 0.45, 0, R * 0.12, 0xdfe5ee, {}, 9);
  L.spin.disc(0, 0, R * 0.14, GUN_DARK, { bevel: R * 0.03, edge: accent });
  L.spinRate = 0.35;
  L.spinRadius = R * 0.6;

  L.lamps[0].power = 0.45;
  L.reach = end + R * 0.5;
  return L;
}

// ---------------------------------------------------------------------------

function shipyard({ R, r, accent, axis }: Ctx): StationLayout {
  const L = layout(R, accent);
  const g = L.body;
  const P = along(axis);
  const half = R * 1.75, W = R * 0.95;

  // The frame: two rails, cross members, diagonal bracing
  const bays = 6;
  for (let k = 0; k < bays; k++) {
    const u0 = -half + (k * 2 * half) / bays, u1 = -half + ((k + 1) * 2 * half) / bays;
    g.bar(...P(u0, k % 2 ? -W : W), ...P(u1, k % 2 ? W : -W), R * 0.035, STRUT, { bevel: R * 0.008 });
  }
  for (let k = 0; k <= bays; k++) {
    const u = -half + (k * 2 * half) / bays;
    g.bar(...P(u, -W), ...P(u, W), R * 0.06, STRUT, { bevel: R * 0.015 });
  }
  for (const v of [-W, W]) g.bar(...P(-half, v), ...P(half, v), R * 0.14, HULL_DARK, { bevel: R * 0.035, edge: HULL_EDGE });

  // The hull on the slip: keel and ribs, plated from the stern up to where the welders are
  const hl = R * 1.3, hw = R * 0.52;
  const width = (u: number) => {
    const t = (u + hl) / (2 * hl);
    return t < 0.12 ? hw * (0.72 + t * 2.3) : hw * Math.pow(Math.max(0, 1 - (t - 0.12) / 0.88), 0.6);
  };
  g.bar(...P(-hl, 0), ...P(hl, 0), R * 0.08, 0x5d6573, { bevel: R * 0.02 });
  const plated = 0.3 + r() * 0.35;
  const step = R * 0.16;
  let frontier = -hl;
  for (let u = -hl; u < hl - step * 0.5; u += step) {
    const t = (u + hl) / (2 * hl);
    const w0 = width(u), w1 = width(u + step);
    if (t < plated) {
      g.panel([...P(u, -w0), ...P(u + step, -w1), ...P(u + step, w1), ...P(u, w0)], t < plated - 0.1 ? HULL : HULL_MID, { bevel: R * 0.02, edge: HULL_EDGE });
      frontier = u + step;
    } else {
      g.bar(...P(u, -w0), ...P(u, w0), R * 0.03, 0x8a94a3, { bevel: R * 0.006 });
    }
  }
  // Welders' sparks along the frontier
  for (let k = 0; k < 4; k++) {
    const v = (r() * 2 - 1) * width(frontier) * 0.9;
    const [x, y] = P(frontier + (r() - 0.5) * step, v);
    L.navTips.push({ x, y, color: r() < 0.5 ? WHITE : 0x9fe8ff, phase: r() });
  }

  // Gantry cranes spanning the rails, their trolleys over the work
  for (const du of [-step * 1.5, step * 2.5]) {
    const u = Math.max(-half + R * 0.2, Math.min(half - R * 0.2, frontier + du));
    g.bar(...P(u, -W - R * 0.08), ...P(u, W + R * 0.08), R * 0.15, 0xd9a640, { bevel: R * 0.035, edge: 0x7a5a1c });
    const tv = (r() * 2 - 1) * W * 0.5;
    box(g, P, u - R * 0.12, tv - R * 0.1, u + R * 0.12, tv + R * 0.1, 0x4a4f58, { bevel: R * 0.025, edge: 0x2a2f38 });
  }

  // Yard office at the stern end
  box(g, P, -half - R * 0.62, -R * 0.42, -half - R * 0.05, R * 0.42, HULL, { bevel: R * 0.04, edge: HULL_EDGE }, R * 0.08);
  g.disc(...P(-half - R * 0.34, 0), R * 0.18, 0x3a4250, { bevel: R * 0.03, edge: accent });
  for (let v = -R * 0.32; v <= R * 0.32; v += R * 0.08) if (Math.abs(v) > R * 0.2) g.disc(...P(-half - R * 0.14, v), R * 0.02, WINDOW, { glow: 1 }, 6);
  for (const s of [-1, 1]) { const [x, y] = P(-half - R * 0.62, s * R * 0.42); L.navTips.push({ x, y, color: s < 0 ? RED : GREEN, phase: r() }); }
  // Guide lights along both rails
  for (let u = -half; u <= half; u += R * 0.35) { const [x, y] = P(u, W); L.chase.push({ x, y }); }

  for (const [u, v] of [[half, W], [-half, -W], [half, -W], [-half, W]]) {
    const [x, y] = P(u, v);
    L.hardpoints.push({ x, y, rest: outward(x, y) });
  }
  const [fx, fy] = P(frontier, 0);
  L.lamps.push({ x: fx, y: fy, color: 0xe6f4ff, radius: R * 1.8, power: 0.6, height: R * 0.5 });
  L.reach = half + R * 0.75;
  return L;
}

// ---------------------------------------------------------------------------

function refinery({ R, r, accent, axis }: Ctx): StationLayout {
  const L = layout(R, accent);
  const g = L.body;
  const P = along(axis);

  // Radiator banks fore and aft, glowing dull red with waste heat
  for (const dir of [-1, 1]) {
    g.bar(...P(dir * R * 0.5, 0), ...P(dir * R * 2.75, 0), R * 0.09, HULL_DARK, { bevel: R * 0.02 });
    for (let k = 0; k < 5; k++) {
      const u = dir * (R * 1.6 + k * R * 0.26);
      g.bar(...P(u, -R * 0.62), ...P(u, R * 0.62), R * 0.11, 0x7a2c1e, { bevel: R * 0.025, edge: 0x3a1a14, glow: 0.35 });
    }
  }

  // Tanks round the furnace, piped to it
  const n = r() < 0.5 ? 4 : 6;
  const tr = n === 4 ? R * 0.36 : R * 0.3;
  const step = (Math.PI * 2) / n;
  for (let k = 0; k < n; k++) {
    const a = axis + step * (k + 0.5);
    g.bar(0, 0, Math.cos(a) * R * 1.15, Math.sin(a) * R * 1.15, R * 0.08, 0x7a6f66, { bevel: R * 0.02 });
  }
  for (let k = 0; k < n; k++) {
    const a = axis + step * (k + 0.5);
    const x = Math.cos(a) * R * 1.15, y = Math.sin(a) * R * 1.15;
    g.disc(x, y, tr, k % 2 ? 0x9aa3ad : 0xc2ae8e, { bevel: tr * 0.32, edge: k % 2 ? 0x56606b : 0x6d6150 }, 16);
    g.disc(x, y, R * 0.07, HULL_DARK, { bevel: R * 0.02 }, 8);
  }

  // Stacks between the tanks, embers in their throats
  for (let k = 0; k < n; k += 2) {
    const a = axis + step * (k + 1);
    if (Math.abs(Math.sin(a - axis)) < 0.3) continue;
    const x = Math.cos(a) * R * 0.8, y = Math.sin(a) * R * 0.8;
    g.disc(x, y, R * 0.13, 0x2c2624, { bevel: R * 0.04, edge: 0x4a403b }, 10);
    g.disc(x, y, R * 0.07, 0xff9a3a, { glow: 1 }, 8);
  }

  // The furnace
  ngon(g, 0, 0, R * 0.6, 8, axis + Math.PI / 8, 0x4a403b, { bevel: R * 0.08, edge: 0x2a2320 });
  for (let k = 0; k < 8; k++) {
    const a = axis + (k / 8) * Math.PI * 2;
    g.bar(Math.cos(a) * R * 0.36, Math.sin(a) * R * 0.36, Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, R * 0.05, 0xff7a2a, { glow: 0.8 });
    L.chase.push({ x: Math.cos(a) * R * 0.55, y: Math.sin(a) * R * 0.55 });
  }
  g.disc(0, 0, R * 0.3, 0xff7a2a, { glow: 1 }, 16);
  g.disc(0, 0, R * 0.16, 0xffd27a, { glow: 1 }, 12);
  L.chaseColor = 0xffb547;

  // A crane arm turning slowly over the tanks
  L.spin.bar(R * 0.2, 0, R * 1.35, 0, R * 0.07, 0xd9a640, { bevel: R * 0.02, edge: 0x7a5a1c });
  L.spin.disc(R * 0.2, 0, R * 0.1, 0x4a4f58, { bevel: R * 0.025 }, 10);
  L.spin.panel([R * 1.25, -R * 0.08, R * 1.42, -R * 0.08, R * 1.42, R * 0.08, R * 1.25, R * 0.08], 0x4a4f58, { bevel: R * 0.02 });
  L.spinRate = 0.07 * (r() < 0.5 ? -1 : 1);
  L.spinRadius = R * 1.45;

  // Guns between the tanks, then out on the radiator booms
  for (let k = 0; k < n; k++) {
    const a = axis + step * k;
    if (Math.abs(Math.sin(a - axis)) < 0.3) continue;
    L.hardpoints.push({ x: Math.cos(a) * R * 1.5, y: Math.sin(a) * R * 1.5, rest: a });
  }
  for (const dir of [1, -1]) { const [x, y] = P(dir * R * 1.3, 0); L.hardpoints.push({ x, y, rest: outward(x, y) }); }
  for (const dir of [-1, 1]) { const [x, y] = P(dir * R * 2.75, 0); L.navTips.push({ x, y, color: dir < 0 ? RED : GREEN, phase: r() }); }

  // The furnace lamp sits low, in its well, so it rakes across the housing and the tanks (StationView pulses it)
  L.lamps[0] = { x: 0, y: 0, color: 0xff8a3a, radius: R * 2.6, power: 1.0, height: R * 0.2 };
  L.reach = R * 2.85;
  return L;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

/**
 * A capital station (Sol Central): a layered hub with a command spire, a
 * habitat ring that turns, a fixed docking ring on trusses with lit berths,
 * four long arms of modules and cargo ending in docking pylons, two great
 * solar wings on lattice booms, radiator fins and a comms dish.
 */
function citadel({ R, r, accent, axis }: Ctx): StationLayout {
  const L = layout(R, accent);
  const body = L.body, spin = L.spin;
  const P = (rad: number, a: number): Pt => [Math.cos(a) * rad, Math.sin(a) * rad];
  const arc = (g: LitGeometry, ri: number, ro: number, a0: number, a1: number, color: number, o: ShapeOpts) => {
    const pts: number[] = [];
    for (let t = 0; t <= 3; t++) pts.push(...P(ro, a0 + ((a1 - a0) * t) / 3));
    for (let t = 3; t >= 0; t--) pts.push(...P(ri, a0 + ((a1 - a0) * t) / 3));
    g.panel(pts, color, o);
  };

  // Four arms of modules out to the docking pylons (along the axis and across it)
  const armEnd = R * 3.3;
  for (let k = 0; k < 4; k++) {
    const a = axis + (k * Math.PI) / 2;
    const c = Math.cos(a), s = Math.sin(a), nx = -s, ny = c;
    const at = (d: number, w: number): Pt => [c * d + nx * w, s * d + ny * w];
    body.bar(c * R * 0.5, s * R * 0.5, c * armEnd, s * armEnd, R * 0.09, HULL_DARK, { bevel: R * 0.02, split: 8 });
    // Modules strung along it, cargo racks between
    for (let m = 0; m < 5; m++) {
      const d = R * 2.25 + m * R * 0.2;
      if (m % 2 === 0) body.panel([...at(d, -R * 0.13), ...at(d + R * 0.16, -R * 0.13), ...at(d + R * 0.16, R * 0.13), ...at(d, R * 0.13)], HULL, { bevel: R * 0.025, edge: HULL_EDGE });
      else for (const side of [-1, 1]) body.panel([...at(d, side * R * 0.05), ...at(d + R * 0.16, side * R * 0.05), ...at(d + R * 0.16, side * R * 0.17), ...at(d, side * R * 0.17)], CARGO[Math.floor(r() * CARGO.length)], { bevel: R * 0.012, edge: HULL_EDGE });
    }
    // The pylon: a T at the end with nav lights and a lit berth
    body.panel([...at(armEnd, -R * 0.3), ...at(armEnd + R * 0.14, -R * 0.3), ...at(armEnd + R * 0.14, R * 0.3), ...at(armEnd, R * 0.3)], HULL, { bevel: R * 0.03, edge: HULL_EDGE, split: 3 });
    for (const side of [-1, 1]) {
      const tip = at(armEnd + R * 0.14, side * R * 0.3);
      L.navTips.push({ x: tip[0], y: tip[1], color: side < 0 ? RED : GREEN, phase: r() });
      const w = at(armEnd + R * 0.07, side * R * 0.15);
      body.disc(w[0], w[1], R * 0.022, WINDOW, { glow: 1 }, 6);
    }
    L.lamps.push({ x: c * armEnd, y: s * armEnd, color: WINDOW, radius: R * 0.9, power: 0.5, height: R * 0.3 });
    L.hardpoints.push({ x: c * R * 2.1, y: s * R * 2.1, rest: a });
  }

  // Solar wings on the diagonals: lattice booms, then a grid of cells
  for (const dir of [-1, 1]) {
    const a = axis + Math.PI / 4 + (dir < 0 ? Math.PI : 0);
    const c = Math.cos(a), s = Math.sin(a), nx = -s, ny = c;
    const at = (d: number, w: number): Pt => [c * d + nx * w, s * d + ny * w];
    const from = R * 2.3, to = R * 3.6, half = R * 0.42;
    for (const w of [-R * 0.05, R * 0.05]) body.bar(...at(R * 0.5, w), ...at(to, w), R * 0.025, STRUT, { split: 10 });
    for (let t = 0; t < 10; t++) {
      const d0 = R * 0.5 + ((to - R * 0.5) * t) / 10, d1 = R * 0.5 + ((to - R * 0.5) * (t + 1)) / 10;
      body.bar(...at(d0, -R * 0.05), ...at(d1, R * 0.05), R * 0.015, STRUT, {});
    }
    const cells = 8;
    for (let k = 0; k < cells; k++) {
      const d0 = from + ((to - from) * k) / cells + R * 0.01, d1 = from + ((to - from) * (k + 1)) / cells - R * 0.01;
      for (const [w0, w1] of [[-half, -R * 0.07], [R * 0.07, half]]) {
        const wm = (w0 + w1) / 2;
        for (const [u0, u1] of [[w0, wm], [wm, w1]]) body.panel([...at(d0, u0), ...at(d1, u0), ...at(d1, u1), ...at(d0, u1)], PANEL, { bevel: R * 0.01, edge: PANEL_GRID });
      }
    }
    for (const d of [from, to]) body.bar(...at(d, -half), ...at(d, half), R * 0.025, 0x8a96a6, { bevel: R * 0.008, split: 4 });
  }

  // The docking ring: fixed, on eight trusses, berths lit round its outside
  const dri = R * 1.72, dro = R * 1.92;
  for (let k = 0; k < 8; k++) {
    const a = axis + Math.PI / 8 + (k / 8) * Math.PI * 2;
    body.bar(...P(R * 0.6, a), ...P(dri, a), R * 0.05, STRUT, { bevel: R * 0.012, split: 5 });
  }
  const dsegs = 32;
  for (let k = 0; k < dsegs; k++) {
    const a0 = (k / dsegs) * Math.PI * 2, a1 = ((k + 1) / dsegs) * Math.PI * 2 - 0.012;
    arc(body, dri, dro, a0, a1, k % 4 === 0 ? HULL_DARK : HULL_MID, { bevel: R * 0.025, edge: HULL_EDGE });
    if (k % 2 === 0) {
      const am = (a0 + a1) / 2;
      const b = P(dro + R * 0.05, am);
      body.panel([...P(dro, am - 0.04), ...P(dro + R * 0.1, am - 0.03), ...P(dro + R * 0.1, am + 0.03), ...P(dro, am + 0.04)], 0x2c333f, { bevel: R * 0.01, edge: accent });
      body.disc(b[0], b[1], R * 0.016, WINDOW, { glow: 1 }, 6);
    }
    L.chase.push({ x: Math.cos((a0 + a1) / 2) * (dri + R * 0.02), y: Math.sin((a0 + a1) / 2) * (dri + R * 0.02) });
  }

  // Habitat ring on six spokes (this part turns)
  const ro = R * 1.45, ri = R * 1.15;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    spin.bar(...P(R * 0.62, a), ...P(ri, a), R * 0.08, HULL_DARK, { bevel: R * 0.02, split: 3 });
  }
  const segs = 36;
  for (let k = 0; k < segs; k++) {
    const a0 = (k / segs) * Math.PI * 2, a1 = ((k + 1) / segs) * Math.PI * 2 - 0.015;
    arc(spin, ri, ro, a0, a1, k % 2 ? HULL : HULL_MID, { bevel: R * 0.035, edge: HULL_EDGE });
    // Rows of lit windows
    for (const rr of [ro - R * 0.06, ri + R * 0.06]) {
      if (r() < 0.25) continue;
      for (const off of [-0.03, 0, 0.03]) {
        const w = P(rr, (a0 + a1) / 2 + off);
        spin.disc(w[0], w[1], R * 0.012, WINDOW, { glow: 1 }, 5);
      }
    }
  }
  L.spinRate = (r() < 0.5 ? -1 : 1) * 0.03;
  L.spinRadius = ro;

  // Radiator fins off the hub, between the arms
  for (let k = 0; k < 4; k++) {
    const a = axis + Math.PI / 4 + (k * Math.PI) / 2 + 0.32;
    const c = Math.cos(a), s = Math.sin(a), nx = -s, ny = c;
    const at = (d: number, w: number): Pt => [c * d + nx * w, s * d + ny * w];
    body.panel([...at(R * 0.62, -R * 0.06), ...at(R * 1.05, -R * 0.09), ...at(R * 1.05, R * 0.09), ...at(R * 0.62, R * 0.06)], 0xd9dde4, { bevel: R * 0.01, edge: 0x9aa3b0, split: 2 });
  }

  // The hub: three stepped octagons, a command spire and its dish
  ngon(body, 0, 0, R * 0.68, 8, Math.PI / 8, HULL_DARK, { bevel: R * 0.05, edge: HULL_EDGE, rings: 3, split: 2 });
  ngon(body, 0, 0, R * 0.52, 8, 0, HULL, { bevel: R * 0.05, edge: HULL_EDGE, rings: 2 });
  for (let k = 0; k < 16; k++) {
    const w = P(R * 0.6, (k / 16) * Math.PI * 2 + Math.PI / 16);
    body.disc(w[0], w[1], R * 0.014, WINDOW, { glow: 1 }, 5);
  }
  body.disc(0, 0, R * 0.34, 0x3a4250, { bevel: R * 0.04, edge: accent, rings: 2 });
  body.disc(0, 0, R * 0.16, 0x252b36, { bevel: R * 0.03 });
  const dishAt = P(R * 0.42, axis + Math.PI * 0.75);
  body.disc(dishAt[0], dishAt[1], R * 0.13, 0xc9d0da, { bevel: R * 0.05, edge: 0x7a8494 }, 14);
  body.disc(dishAt[0], dishAt[1], R * 0.03, accent, { glow: 0.6 }, 8);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    L.chase.push({ x: Math.cos(a) * R * 0.26, y: Math.sin(a) * R * 0.26 });
  }
  // The hub lamps low: the accent lamp dimmer, the warm one off-centre, so they rake across the hub rather than wash it
  L.lamps[0] = { x: 0, y: 0, color: accent, radius: R * 2.4, power: 0.28, height: R * 0.35 };
  L.lamps.push({ x: -R * 0.55, y: R * 0.3, color: WINDOW, radius: R * 1.9, power: 0.8, height: R * 0.16 });
  L.chaseColor = accent;
  L.reach = R * 3.8;
  return L;
}

const BUILDERS = { ring, outpost, observatory, bastion, shipyard, refinery, citadel };
export type StationDesign = keyof typeof BUILDERS;

/** Build a station's look (`design` from STATION_DESIGNS; unknown ones get the ring) */
export function buildStation(design: string, R: number, r: () => number, accent: number, turrets: number): StationLayout {
  const axis = r() * Math.PI;
  const build = BUILDERS[design as StationDesign] ?? ring;
  return build({ R, r, accent, turrets, axis });
}

// ---------------------------------------------------------------------------
// Defence turrets

export interface TurretLook {
  /** The head (facing +x), turning on its mount (a StationGeometry) */
  head: LitGeometry;
  /** The mount beneath it (part of the station's body) */
  mountRadius: number;
  /** Muzzle distance from the pivot */
  muzzle: number;
  /** Colour of its shots and flash */
  color: number;
}

/** A turret head for a weapon ('laser', 'flak', 'lance'), `T` its size */
export function turretLook(weapon: string, T: number): TurretLook {
  const g = new StationGeometry();
  if (weapon === 'flak') {
    // A squat block with four short barrels
    for (const v of [-0.55, -0.2, 0.2, 0.55]) g.bar(T * 0.3, v * T, T * 1.35, v * T, T * 0.17, 0x3d4048, { bevel: T * 0.04 });
    g.panel([-T * 0.7, -T * 0.72, T * 0.5, -T * 0.72, T * 0.68, -T * 0.4, T * 0.68, T * 0.4, T * 0.5, T * 0.72, -T * 0.7, T * 0.72],
      0x7c806c, { bevel: T * 0.14, edge: 0x3f4236 });
    g.disc(-T * 0.15, 0, T * 0.22, 0x50543f, { bevel: T * 0.06 }, 8);
    return { head: g, mountRadius: T * 1.05, muzzle: T * 1.4, color: 0xffc070 };
  }
  if (weapon === 'lance') {
    // A long heavy barrel through glowing coils, a capacitor housing behind
    g.bar(T * 0.2, 0, T * 2.3, 0, T * 0.34, 0x4a4f5c, { bevel: T * 0.08, edge: 0x2a2d36 });
    for (const u of [0.8, 1.25, 1.7]) g.bar(u * T, -T * 0.3, u * T, T * 0.3, T * 0.12, 0x9f8cff, { glow: 0.6 });
    g.disc(T * 2.3, 0, T * 0.12, 0xd6ccff, { glow: 1 }, 8);
    g.panel([-T * 0.85, -T * 0.6, T * 0.35, -T * 0.6, T * 0.6, -T * 0.3, T * 0.6, T * 0.3, T * 0.35, T * 0.6, -T * 0.85, T * 0.6],
      0x8d96a3, { bevel: T * 0.14, edge: 0x434b56 });
    g.disc(-T * 0.25, 0, T * 0.22, 0x6a5acd, { glow: 0.7 }, 10);
    return { head: g, mountRadius: T * 1.1, muzzle: T * 2.4, color: 0xb79cff };
  }
  // Laser: a round head with twin barrels, red emitters at their tips
  for (const v of [-0.3, 0.3]) {
    g.bar(T * 0.2, v * T, T * 1.7, v * T, T * 0.2, 0x4a4f5c, { bevel: T * 0.05 });
    g.disc(T * 1.7, v * T, T * 0.09, 0xff6a5a, { glow: 1 }, 6);
  }
  g.disc(0, 0, T * 0.75, 0xa6b1bf, { bevel: T * 0.16, edge: 0x4d5766 }, 14);
  g.disc(0, 0, T * 0.3, 0x3a4250, { bevel: T * 0.06 }, 10);
  return { head: g, mountRadius: T * 0.95, muzzle: T * 1.75, color: 0xff5a4a };
}
