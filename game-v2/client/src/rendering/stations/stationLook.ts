/**
 * Geometry changes the station look makes to a design's layout before it's
 * baked (stations/stationBake.ts):
 *   domes    large hub cores become panelled glass domes: ribs, mullions, a
 *            lit ring round a metal cap, each pane its own tint
 *   refinery its radiator banks become joined, framed and braced amber solar
 *            arrays with a warm waste-heat edge; a broad plated hull disc
 *            underneath everything
 */

import type { StationLayout } from '../stationDesigns';
import { StationGeometry, shapeCircle as circle } from './StationGeometry';
import { isWindow, LOOK_COLORS, type StationDome, type StationShape } from './stationBake';

const { DOME_C, FRAME_C, BODY_C, SEAM_C, MULL_C, CAP_C, AMBER_P } = LOOK_COLORS;

/**
 * Large hub cores become glass domes: the core disc (and anything small drawn on it straight after) loses its
 * triangles; a finer mesh takes its place in the draw order, in a thin metal frame. Returns each dome's centre,
 * radius and its panes' tints (by vertex).
 */
export function domeify(g: StationGeometry, R: number): StationDome[] {
  const list = g.shapes;
  const out: StationDome[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!(s.call === 'disc' && s.color === 0x3a4250 && s.r >= R * 0.2)) continue;
    const cx = s.pts[0] - s.r, cy = s.pts[1], rho = s.r;
    // drop it and what sits inside it, drawn just after
    let j = i + 1;
    while (j < list.length && list[j].call === 'disc' && list[j].r < rho * 0.8 && Math.hypot(list[j].pts[0] - list[j].r - cx, list[j].pts[1] - cy) < rho * 0.3 && !isWindow(list[j], R)) j++;
    const gone = list.slice(i, j), inGone = (v: number) => gone.some((q) => v >= q.v0 && v < q.v1);
    const first = g.idx.findIndex((v) => inGone(v));
    const kept: number[] = [];
    for (let t = 0; t < g.idx.length; t += 3) if (!inGone(g.idx[t])) kept.push(g.idx[t], g.idx[t + 1], g.idx[t + 2]);
    // the frame: a bevelled band, tilted outward
    const SEG = 48, IN = 0.88, add: number[] = [], pane: number[] = [];
    const f0 = g.vertexCount;
    for (let k = 0; k < SEG; k++) {
      const a = (k / SEG) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      g.vertex(cx + ca * rho * IN, cy + sa * rho * IN, -ca * 0.45, -sa * 0.45, 0.89, FRAME_C);
      g.vertex(cx + ca * rho, cy + sa * rho, ca * 0.6, sa * 0.6, 0.8, 0x5d6673);
    }
    for (let k = 0; k < SEG; k++) { const k2 = (k + 1) % SEG; add.push(f0 + k * 2, f0 + k * 2 + 1, f0 + k2 * 2 + 1, f0 + k * 2, f0 + k2 * 2 + 1, f0 + k2 * 2); }
    const f1 = g.vertexCount;
    const rd = rho * IN;
    /** A point on the dome (q 0 centre … 1 rim, angle a) with its domed normal, lifted a little for metal on top */
    const dv = (q: number, a: number, color: number, lift = 0, glow = 0) => {
      const lean = q * 0.85 * (1 - lift), nz = Math.sqrt(1 - lean * lean);
      return g.vertex(cx + Math.cos(a) * rd * q, cy + Math.sin(a) * rd * q, Math.cos(a) * lean, Math.sin(a) * lean, nz, color, glow);
    };
    const recs: StationShape[] = [];
    const d0 = g.vertexCount;
    // glass panes between RIBS radial ribs and the rings at BANDS: each pane its own vertices (a sub-grid), so each
    // can carry its own slight tint and reflection
    const RIBS = 10, BANDS = [0.17, 0.46, 0.73, 1.0], SUBR = 3, SUBA = 4;
    for (let b = 0; b < 3; b++) for (let r = 0; r < RIBS; r++) {
      const q0 = BANDS[b], q1 = BANDS[b + 1], a0 = (r / RIBS) * Math.PI * 2 + 0.2, a1 = ((r + 1) / RIBS) * Math.PI * 2 + 0.2;
      let hsh = ((b * 92821 + r * 68917 + 7) * 2654435761) >>> 0; hsh = Math.imul(hsh ^ (hsh >>> 15), 2246822519) >>> 0;
      const pv = hsh / 4294967296, p0 = g.vertexCount;
      for (let y = 0; y <= SUBR; y++) for (let x = 0; x <= SUBA; x++) { const v = dv(q0 + ((q1 - q0) * y) / SUBR, a0 + ((a1 - a0) * x) / SUBA, DOME_C); pane.push(v, pv); }
      for (let y = 0; y < SUBR; y++) for (let x = 0; x < SUBA; x++) {
        const v00 = p0 + y * (SUBA + 1) + x, v01 = v00 + 1, v10 = v00 + SUBA + 1, v11 = v10 + 1;
        add.push(v00, v10, v11, v00, v11, v01);
      }
    }
    recs.push({ call: 'disc', v0: d0, v1: g.vertexCount, color: DOME_C, glow: 0, pts: circle(cx, cy, rd), r: rd });
    // the mullions: thin metal over the joins (radial ribs, then the rings), shaped to the dome
    const m0 = g.vertexCount, w = Math.max(rd * 0.022, R * 0.006);
    for (let r = 0; r < RIBS; r++) {
      const a = (r / RIBS) * Math.PI * 2 + 0.2, base = g.vertexCount, STEPS = 8;
      for (let k = 0; k <= STEPS; k++) {
        const q = BANDS[0] + ((1 - BANDS[0]) * k) / STEPS, da = w / 2 / (rd * q);
        dv(q, a - da, MULL_C, 0.3); dv(q, a + da, MULL_C, 0.3);
      }
      for (let k = 0; k < STEPS; k++) add.push(base + k * 2, base + k * 2 + 2, base + k * 2 + 3, base + k * 2, base + k * 2 + 3, base + k * 2 + 1);
    }
    for (const qr of [BANDS[1], BANDS[2]]) {
      const base = g.vertexCount, n = 64, dq = w / 2 / rd;
      for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; dv(qr - dq, a, MULL_C, 0.3); dv(qr + dq, a, MULL_C, 0.3); }
      for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; add.push(base + k * 2, base + k2 * 2, base + k2 * 2 + 1, base + k * 2, base + k2 * 2 + 1, base + k * 2 + 1); }
    }
    recs.push({ call: 'panel', v0: m0, v1: g.vertexCount, color: MULL_C, glow: 0, pts: circle(cx, cy, rd), r: rd });
    // the cap: a lit ring round a small bevelled metal boss
    const l0 = g.vertexCount, n = 40;
    for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; dv(BANDS[0] - 0.012, a, 0x7fe8f0, 0, 1); dv(BANDS[0] + 0.012, a, 0x7fe8f0, 0, 1); }
    for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; add.push(l0 + k * 2, l0 + k2 * 2, l0 + k2 * 2 + 1, l0 + k * 2, l0 + k2 * 2 + 1, l0 + k * 2 + 1); }
    recs.push({ call: 'panel', v0: l0, v1: g.vertexCount, color: 0x7fe8f0, glow: 1, pts: circle(cx, cy, rd * BANDS[0]), r: rd * BANDS[0] });
    const c0 = g.vertexCount, cr = rd * (BANDS[0] - 0.015);
    g.vertex(cx, cy, 0, 0, 1, CAP_C);
    for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; g.vertex(cx + Math.cos(a) * cr * 0.6, cy + Math.sin(a) * cr * 0.6, Math.cos(a) * 0.15, Math.sin(a) * 0.15, 0.99, CAP_C); }
    for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; g.vertex(cx + Math.cos(a) * cr * 0.62, cy + Math.sin(a) * cr * 0.62, Math.cos(a) * 0.62, Math.sin(a) * 0.62, 0.78, CAP_C); }
    for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; g.vertex(cx + Math.cos(a) * cr, cy + Math.sin(a) * cr, Math.cos(a) * 0.62, Math.sin(a) * 0.62, 0.78, 0x5d6673); }
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n, A = c0 + 1, B = c0 + 1 + n, C = c0 + 1 + 2 * n;
      add.push(c0, A + k, A + k2, B + k, C + k, C + k2, B + k, C + k2, B + k2);
    }
    recs.push({ call: 'disc', v0: c0, v1: g.vertexCount, color: CAP_C, glow: 0, pts: circle(cx, cy, cr), r: cr });
    // (in the draw order where the core was: nothing before `first` was dropped)
    const at = Math.min(kept.length, first < 0 ? kept.length : first);
    g.idx = [...kept.slice(0, at), ...add, ...kept.slice(at)];
    list.splice(i, j - i, { call: 'disc', v0: f0, v1: f1, color: FRAME_C, glow: 0, pts: circle(cx, cy, rho), r: rho }, ...recs);
    out.push({ cx, cy, r: rd, pane });
    i += recs.length;
  }
  return out;
}

/**
 * The refinery's radiator banks as joined solar arrays: the separate glowing bars go; on each boom a framed array
 * of amber cells (two columns, either side of the boom) between rails, end bars and a cross strut to the boom
 */
export function amberArrays(L: StationLayout, R: number): void {
  const g = L.body as StationGeometry, list = g.shapes;
  const bars = list.filter((s) => s.color === 0x7a2c1e);
  if (!bars.length) return;
  const inBar = (v: number) => bars.some((q) => v >= q.v0 && v < q.v1);
  const kept: number[] = [];
  for (let t = 0; t < g.idx.length; t += 3) if (!inBar(g.idx[t])) kept.push(g.idx[t], g.idx[t + 1], g.idx[t + 2]);
  g.idx = kept;
  for (const side of [1, -1]) {
    let ax = 0, ay = 0;
    const d0x = (bars[0].pts[0] + bars[0].pts[4]) / 2, d0y = (bars[0].pts[1] + bars[0].pts[5]) / 2;
    for (const b of bars) { const cx = (b.pts[0] + b.pts[4]) / 2, cy = (b.pts[1] + b.pts[5]) / 2; if ((cx * d0x + cy * d0y) * side > 0) { ax += cx; ay += cy; } }
    const l = Math.hypot(ax, ay) || 1, ux = ax / l, uy = ay / l, vx = -uy, vy = ux;
    const P = (u: number, v: number): [number, number] => [ux * u + vx * v, uy * u + vy * v];
    const u0 = R * 1.5, u1 = R * 2.72, half = R * 0.64, rows = 6;
    for (let k = 0; k < rows; k++) {
      const a = u0 + ((u1 - u0) * k) / rows + R * 0.008, b = u0 + ((u1 - u0) * (k + 1)) / rows - R * 0.008;
      for (const [w0, w1] of [[-half, -R * 0.05], [R * 0.05, half]]) g.panel([...P(a, w0), ...P(b, w0), ...P(b, w1), ...P(a, w1)], AMBER_P, { bevel: R * 0.012, edge: 0x9a6a30 });
    }
    for (const v of [-half - R * 0.02, half + R * 0.02]) g.bar(...P(u0 - R * 0.02, v), ...P(u1 + R * 0.02, v), R * 0.045, 0x6b7584, { bevel: R * 0.012 });
    for (const u of [u0 - R * 0.02, u1 + R * 0.02]) g.bar(...P(u, -half - R * 0.04), ...P(u, half + R * 0.04), R * 0.05, 0x8a3a1e, { bevel: R * 0.012, edge: 0x3a1a14, glow: 0.35 });
    g.bar(...P(u0 - R * 0.02, -half), ...P(R * 1.2, -R * 0.06), R * 0.06, 0x353c46, { bevel: R * 0.016, edge: 0x2a2f38 });
    g.bar(...P(u0 - R * 0.02, half), ...P(R * 1.2, R * 0.06), R * 0.06, 0x353c46, { bevel: R * 0.016, edge: 0x2a2f38 });
  }
}

/** The refinery's broad hull disc beneath everything: drawn first, plated, with radial seams */
export function underBody(L: StationLayout, R: number): void {
  const nb = new StationGeometry();
  nb.disc(0, 0, R * 0.95, BODY_C, { bevel: R * 0.07, edge: 0x5d6673, rings: 4, split: 2 }, 48);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 + 0.17, c = Math.cos(a), s = Math.sin(a), w = R * 0.008;
    nb.flat([c * R * 0.3 - s * w, s * R * 0.3 + c * w, c * R * 0.86 - s * w, s * R * 0.86 + c * w, c * R * 0.86 + s * w, s * R * 0.86 - c * w, c * R * 0.3 + s * w, s * R * 0.3 - c * w], SEAM_C);
  }
  nb.appendShapes(L.body as StationGeometry, 0);
  L.body = nb;
}

/** A design's layout changed for the station look; returns the domes in its body and its turning part */
export function applyStationLook(design: string, L: StationLayout, R: number): { body: StationDome[]; spin: StationDome[] } {
  if (design === 'refinery') { underBody(L, R); amberArrays(L, R); }
  return { body: domeify(L.body as StationGeometry, R), spin: domeify(L.spin as StationGeometry, R) };
}
