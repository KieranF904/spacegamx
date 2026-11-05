/**
 * A skeleton (a piece's `skeleton`: a boss's wing under its carapace) as lit geometry, in its ship's frame (centred on
 * its centre of mass, cells × cell size), drawn under the hull. Nothing fills its gaps: the ground shows through.
 *
 *   plates   its frames, each cast whole as designed (the generator closes its bars, bosses and rim into one plate
 *            with holes): a flat top with a dark seam round every edge, outer and hole alike, the surface rolling
 *            over at it; the finer frame beneath darker, its edges tighter; a lava channel glowing along the bones
 *            that carry one
 *   parts    its inner workings beneath the plates: conduits (a glowing slit down each, collars along them), a pump
 *            (a bolted drum, molten in its middle), a coiled feed, a rack of glowing pods, heat-exchanger fins, cables
 *   (bones alone, without plates: forged bars, a boss at each joint)
 */

import type { PieceSkeleton, SkeletonPart, Vec2 } from '@space-game/common';
import { LitGeometry } from '../rendering/lighting/LitGeometry';

const mix = (a: number, b: number, t: number) => { const c = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t); return (c(16) << 16) | (c(8) << 8) | c(0); };
/** Its colours: the Pyreclast's (cast dark glass, lava), unless its skeleton says otherwise (PieceSkeleton `palette`) */
const PALETTE = { bone: 0x5a4e66, fine: 0x2c2535, part: 0x2e2638, edge: 0x463b52, bolt: 0x7a6c86, hot: 0xff7a2a, hotCore: 0xffd8a0 };

export function buildSkeleton(g: LitGeometry, sk: PieceSkeleton, com: readonly number[], cs: number): void {
  const own = sk.palette ?? {}, pick = (k: keyof typeof PALETTE) => (own[k] ? parseInt(own[k]!.slice(1), 16) : PALETTE[k]);
  const BONE = pick('bone'), BONE_FINE = pick('fine'), PART = pick('part'), PART_EDGE = pick('edge'), BOLT = pick('bolt'), HOT = pick('hot'), HOT_CORE = pick('hotCore');
  const P = ([x, y]: Vec2): Vec2 => [(x - com[0]) * cs, (y - com[1]) * cs];

  /** A bar from a to b, w0 to w1 wide (world units): a flat crest, its shoulders rolling away (`lean` how far) */
  const tube = (a: Vec2, b: Vec2, w0: number, w1: number, color: number, lean = 0.85, glow = 0) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-3) return;
    const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len, first = g.vertexCount;
    const across = [-1, -0.82, -0.55, 0, 0.55, 0.82, 1];
    for (const [p, w] of [[a, w0], [b, w1]] as [Vec2, number][]) for (const t of across) {
      // (flat across the middle half, the shoulders turning over towards the edge)
      const k = Math.max(0, (Math.abs(t) - 0.45) / 0.55), tilt = Math.sign(t) * k * k * lean, nz = Math.sqrt(Math.max(0.05, 1 - tilt * tilt));
      g.vertex(p[0] + nx * t * w / 2, p[1] + ny * t * w / 2, nx * tilt, ny * tilt, nz, color, glow);
    }
    for (let k = 0; k < across.length - 1; k++) { const i = first + k, j = first + across.length + k; g.tri(i, i + 1, j + 1); g.tri(i, j + 1, j); }
  };
  /** A dome (a joint, a boss, a pod): flat on top, rolling over at its edge */
  const dome = (c: Vec2, r: number, color: number, lean = 0.85, sides = 12, glow = 0) => {
    const top = g.vertex(c[0], c[1], 0, 0, 1, color, glow);
    const rings = [0.6, 1], starts: number[] = [];
    for (const f of rings) {
      starts.push(g.vertexCount);
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2, tilt = (f === 1 ? 1 : 0.15) * lean, nz = Math.sqrt(1 - tilt * tilt);
        g.vertex(c[0] + Math.cos(a) * r * f, c[1] + Math.sin(a) * r * f, Math.cos(a) * tilt, Math.sin(a) * tilt, nz, color, glow);
      }
    }
    for (let k = 0; k < sides; k++) {
      const n = (k + 1) % sides;
      g.tri(top, starts[0] + k, starts[0] + n);
      g.tri(starts[0] + k, starts[1] + k, starts[1] + n);
      g.tri(starts[0] + k, starts[1] + n, starts[0] + n);
    }
  };
  /** A line of points as a tube, its width going from w[0] to w[last] along it (in pieces, so it tapers smoothly) */
  const run = (pts: Vec2[], w: number[], color: number, lean: number, glow = 0, joints = true) => {
    const W = pts.map((_, i) => w[Math.min(i, w.length - 1)] * cs);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = P(pts[i]), b = P(pts[i + 1]), n = pts.length > 6 ? 1 : 6;
      for (let k = 0; k < n; k++) {
        const f0 = k / n, f1 = (k + 1) / n;
        tube([a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0], [a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1], W[i] + (W[i + 1] - W[i]) * f0, W[i] + (W[i + 1] - W[i]) * f1, color, lean, glow);
      }
    }
    // (a broad boss at each joint, filling the corners between the bars that meet there)
    // (only at its ends and where it turns: not down a gentle bow)
    const turns = (i: number) => {
      if (i === 0 || i === pts.length - 1) return true;
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const d = Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]);
      return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) > 0.2;
    };
    if (joints) pts.forEach((q, i) => turns(i) && dome(P(q), (W[i] / 2) * (pts.length === 1 ? 1 : 1.3), color, lean, 16, glow));
  };

  // Beneath: the inner workings, then the finer frame
  for (const part of sk.parts) buildPart(part);
  // The frames: the finer beneath, then the main (cast plates; or, without them, their bars)
  const plates = sk.plates ?? [];
  if (plates.length) {
    for (const pl of plates) if (pl.layer === 1) plate(pl.outer, pl.holes, BONE_FINE, 0.14 * cs, 0.7);
    for (const pl of plates) if (pl.layer === 0) plate(pl.outer, pl.holes, BONE, 0.22 * cs, 0.85);
  } else {
    for (const b of sk.bones) if (b.layer === 1) run(b.pts, b.w, BONE_FINE, 0.6);
    run([...sk.rim, sk.rim[0]], [sk.rimW], BONE, 0.85);
    for (const b of sk.bones) if (b.layer === 0) run(b.pts, b.w, BONE, 0.85);
  }
  // Lava down the bones that carry it: a glowing channel along their crest, a hot core in it
  for (const b of sk.bones) if (b.lava) {
    run(b.pts, b.w.map((v) => v * 0.34), HOT, 0, 1, false);
    run(b.pts, b.w.map((v) => v * 0.12), HOT_CORE, 0, 1, false);
  }

  /**
   * A plate with holes: filled flat (cut into slabs between its corners' heights, each slab's spans paired off), then
   * a bevel inside every edge (`b` wide: the seam dark at the edge, the surface leaning out towards it by `lean`)
   */
  function plate(outerC: Vec2[], holesC: Vec2[][], color: number, b: number, lean: number): void {
    const outer = outerC.map(P), holes = holesC.map((h) => h.map(P)), rings = [outer, ...holes];
    const inPoly = (x: number, y: number, pg: Vec2[]) => { let c = false; for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) if ((pg[i][1] > y) !== (pg[j][1] > y) && x < ((pg[j][0] - pg[i][0]) * (y - pg[i][1])) / (pg[j][1] - pg[i][1]) + pg[i][0]) c = !c; return c; };
    const inside = (x: number, y: number) => inPoly(x, y, outer) && !holes.some((h) => inPoly(x, y, h));
    // The fill
    const edges: [number, number, number, number][] = [];
    for (const r of rings) for (let i = 0; i < r.length; i++) { const a = r[i], c = r[(i + 1) % r.length]; if (a[1] !== c[1]) edges.push(a[1] < c[1] ? [a[0], a[1], c[0], c[1]] : [c[0], c[1], a[0], a[1]]); }
    const ys = [...new Set(rings.flat().map((q) => q[1]))].sort((u, v) => u - v);
    for (let k = 0; k < ys.length - 1; k++) {
      const ya = ys[k], yb = ys[k + 1], ym = (ya + yb) / 2;
      const xs = edges.filter((e) => e[1] <= ya && e[3] >= yb).map((e) => { const t0 = (ya - e[1]) / (e[3] - e[1]), t1 = (yb - e[1]) / (e[3] - e[1]); return { xa: e[0] + (e[2] - e[0]) * t0, xb: e[0] + (e[2] - e[0]) * t1 }; }).sort((u, v) => (u.xa + u.xb) - (v.xa + v.xb));
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const l = xs[i], r = xs[i + 1];
        const v0 = g.vertex(l.xa, ya, 0, 0, 1, color), v1 = g.vertex(r.xa, ya, 0, 0, 1, color), v2 = g.vertex(r.xb, yb, 0, 0, 1, color), v3 = g.vertex(l.xb, yb, 0, 0, 1, color);
        g.tri(v0, v1, v2); g.tri(v0, v2, v3);
      }
      void ym;
    }
    // The bevel inside every edge: the ring, and the ring drawn in by `b` (less for a small hole), as a strip
    const seam = mix(color, 0x07050a, 0.72), nz = Math.sqrt(1 - lean * lean);
    for (const r of rings) {
      const n = r.length;
      let area = 0;
      for (let i = 0; i < n; i++) { const a = r[i], c = r[(i + 1) % n]; area += a[0] * c[1] - c[0] * a[1]; }
      const bw = Math.min(b, 0.55 * Math.sqrt(Math.abs(area) / Math.PI));
      // (which way is in: tried on the first edge)
      const e0 = r[0], e1 = r[1 % n], el = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]) || 1, px = -(e1[1] - e0[1]) / el, py = (e1[0] - e0[0]) / el;
      const sgn = inside((e0[0] + e1[0]) / 2 + px * bw * 0.5, (e0[1] + e1[1]) / 2 + py * bw * 0.5) ? 1 : -1;
      const inw: Vec2[] = r.map((q, i) => {
        const a = r[(i + n - 1) % n], c = r[(i + 1) % n];
        const d0 = Math.hypot(q[0] - a[0], q[1] - a[1]) || 1, d1 = Math.hypot(c[0] - q[0], c[1] - q[1]) || 1;
        let nx = (-(q[1] - a[1]) / d0 - (c[1] - q[1]) / d1) * sgn, ny = ((q[0] - a[0]) / d0 + (c[0] - q[0]) / d1) * sgn;
        const l = Math.hypot(nx, ny) || 1;
        nx /= l; ny /= l;
        return [nx, ny];
      });
      const outerV = r.map((q, i) => g.vertex(q[0], q[1], -inw[i][0] * lean, -inw[i][1] * lean, nz, seam));
      const innerV = r.map((q, i) => g.vertex(q[0] + inw[i][0] * bw, q[1] + inw[i][1] * bw, -inw[i][0] * lean * 0.35, -inw[i][1] * lean * 0.35, Math.sqrt(1 - lean * lean * 0.1225), color));
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; g.tri(outerV[i], outerV[j], innerV[j]); g.tri(outerV[i], innerV[j], innerV[i]); }
    }
  }

  function buildPart(q: SkeletonPart): void {
    switch (q.kind) {
      case 'pipe':
        run(q.pts, [q.w], PART, 0.8);
        if (q.glow) run(q.pts, [q.w * 0.22], HOT, 0, 1, false);
        // collars along it
        for (let i = 0; i < q.pts.length - 1; i++) {
          const a = q.pts[i], b = q.pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
          for (let t = 1.2; t < len - 0.6; t += 2.2) {
            const c: Vec2 = [a[0] + ux * t, a[1] + uy * t];
            tube(P([c[0] - ux * 0.12, c[1] - uy * 0.12]), P([c[0] + ux * 0.12, c[1] + uy * 0.12]), q.w * 1.25 * cs, q.w * 1.25 * cs, PART_EDGE, 0.8);
          }
        }
        return;
      case 'cable':
        run(q.pts, [q.w], PART_EDGE, 0.7, 0, false);
        return;
      case 'drum': {
        const c = P(q.at), r = q.r * cs;
        dome(c, r, PART, 0.5, 20);
        dome(c, r * 0.7, PART_EDGE, 0.3, 20);
        dome(c, r * 0.48, HOT, 0, 16, 1);
        dome(c, r * 0.22, HOT_CORE, 0, 12, 1);
        for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; dome([c[0] + Math.cos(a) * r * 0.85, c[1] + Math.sin(a) * r * 0.85], r * 0.07, BOLT, 0.8, 6); }
        return;
      }
      case 'coil': {
        tube(P(q.a), P(q.b), 0.6 * cs, 0.6 * cs, PART, 0.8);
        const pts: Vec2[] = [], n = q.turns * 2;
        const ux = q.b[0] - q.a[0], uy = q.b[1] - q.a[1], l = Math.hypot(ux, uy), nx = -uy / l, ny = ux / l;
        for (let t = 0; t <= n; t++) { const f = t / n, o = (t % 2 ? 1 : -1) * q.amp; pts.push([q.a[0] + ux * f + nx * o, q.a[1] + uy * f + ny * o]); }
        run(pts, [0.24], HOT, 0.4, 1, false);
        return;
      }
      case 'rack': {
        const pts = q.poly.flatMap((v) => P(v));
        g.panel(pts, PART, { bevel: 0.25 * cs, edge: PART_EDGE });
        for (const pod of q.pods) { const c = P(pod); dome(c, q.r * cs, PART_EDGE, 0.8, 6); dome(c, q.r * 0.42 * cs, HOT, 0, 8, 1); }
        return;
      }
      case 'fins': {
        g.panel(q.poly.flatMap((v) => P(v)), PART, { bevel: 0.2 * cs, edge: PART_EDGE });
        const [a, b, c, d] = q.poly;
        for (let k = 1; k <= q.n; k++) {
          const f = k / (q.n + 1), from: Vec2 = [a[0] + (d[0] - a[0]) * f, a[1] + (d[1] - a[1]) * f], to: Vec2 = [b[0] + (c[0] - b[0]) * f, b[1] + (c[1] - b[1]) * f];
          k % 2 ? run([from, to], [0.16], HOT, 0, 1, false) : run([from, to], [0.2], PART_EDGE, 0.7, 0, false);
        }
        return;
      }
    }
  }
}
