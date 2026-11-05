/**
 * Builds lit geometry (see litShader.ts): triangles whose vertices carry a
 * position, a normal and a base colour. Shapes:
 *   panel   a flat polygon facing the camera, with a bevelled rim: a band
 *           round its edge tilted outward, so it catches light from that side
 *   disc    a round panel
 *   bar     a thick line (struts, pylons) as a bevelled panel
 *   flat    a polygon with no bevel (markings drawn over a panel)
 *   bowl    a crater: rim tilted inward, so it's lit on the far side
 *   rock    an asteroid: 'fan' is flat facets from the centre to each edge;
 *           'rings' is concentric rings with jittered normals, shaded smoothly;
 *           'facets' and 'dome' give the rock a real shape (a lumpy dome:
 *           heights at the centre, an inner ring and the rim) and light each
 *           triangle by its actual slope; `smooth` (0..1) blends each corner's
 *           light between its own facet's and its neighbours' ('dome' is fully smooth)
 */

import { Geometry } from 'pixi.js';

export type RockMesh = 'fan' | 'rings' | 'facets' | 'dome';

/** How tilted bevels and rims are (0 flat, 1 edge-on) */
const BEVEL_TILT = 0.72;

function rgb(c: number): [number, number, number] {
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

export interface ShapeOpts {
  /** Bevel width (world units) */
  bevel?: number;
  /** Colour of the bevel band (defaults to the panel's) */
  edge?: number;
  /** 0 lit … 1 glows by itself */
  glow?: number;
  slot?: number;
  /**
   * Lights are worked out at the vertices, so a big flat shape catches a lamp
   * near its middle only if it has vertices there: `rings` concentric rings
   * towards its centre, each edge cut into `split` (and its bevel with it).
   */
  rings?: number;
  split?: number;
}

/** A polygon's outline with each edge cut into `split` */
function splitEdges(pts: number[], split: number): number[] {
  if (split <= 1) return pts;
  const n = pts.length / 2, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    for (let k = 0; k < split; k++) {
      const t = k / split;
      out.push(pts[i * 2] + (pts[j * 2] - pts[i * 2]) * t, pts[i * 2 + 1] + (pts[j * 2 + 1] - pts[i * 2 + 1]) * t);
    }
  }
  return out;
}

export class LitGeometry {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  slot: number[] = [];
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 2;
  }

  /** One vertex; returns its index */
  vertex(x: number, y: number, nx: number, ny: number, nz: number, color: number, glow = 0, slot = 0): number {
    const [r, g, b] = rgb(color);
    this.pos.push(x, y);
    this.nrm.push(nx, ny, nz);
    this.col.push(r, g, b, glow);
    this.slot.push(slot);
    return this.pos.length / 2 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** A convex (or star-shaped) polygon, flat, no bevel (in rings round its middle, if asked) */
  flat(pts: number[], color: number, o: ShapeOpts = {}): void {
    if (pts.length / 2 < 3) return;
    const rings = Math.max(1, Math.round(o.rings ?? 1));
    if (rings > 1 || (o.split ?? 1) > 1) return this.flatRings(splitEdges(pts, Math.round(o.split ?? 1)), color, rings, o);
    const n = pts.length / 2;
    const first = this.vertexCount;
    for (let i = 0; i < n; i++) this.vertex(pts[i * 2], pts[i * 2 + 1], 0, 0, 1, color, o.glow ?? 0, o.slot ?? 0);
    for (let i = 1; i < n - 1; i++) this.tri(first, first + i, first + i + 1);
  }

  /** A flat shape as a fan round its middle and rings out to its outline */
  private flatRings(pts: number[], color: number, rings: number, o: ShapeOpts): void {
    const n = pts.length / 2, g = o.glow ?? 0, s = o.slot ?? 0;
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += pts[i * 2]; cy += pts[i * 2 + 1]; }
    cx /= n; cy /= n;
    const centre = this.vertex(cx, cy, 0, 0, 1, color, g, s);
    let prev = -1;
    for (let r = 1; r <= rings; r++) {
      const t = r / rings, row = this.vertexCount;
      for (let i = 0; i < n; i++) this.vertex(cx + (pts[i * 2] - cx) * t, cy + (pts[i * 2 + 1] - cy) * t, 0, 0, 1, color, g, s);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (prev < 0) this.tri(centre, row + i, row + j);
        else { this.tri(prev + i, row + i, row + j); this.tri(prev + i, row + j, prev + j); }
      }
      prev = row;
    }
  }

  /** A flat panel with a bevelled rim */
  panel(pts: number[], color: number, o: ShapeOpts = {}): void {
    if (pts.length / 2 < 3) return;
    const bevel = o.bevel ?? 0;
    if (bevel <= 0) { this.flat(pts, color, o); return; }
    // Cut the edges first, so the bevel's cut with them
    if ((o.split ?? 1) > 1) { pts = splitEdges(pts, Math.round(o.split!)); o = { ...o, split: 1 }; }
    const n = pts.length / 2;
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += pts[i * 2]; cy += pts[i * 2 + 1]; }
    cx /= n; cy /= n;
    // Inset each corner towards the middle by the bevel (never past halfway)
    const inner: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      const d = Math.hypot(cx - x, cy - y) || 1;
      const k = Math.min(0.45, (bevel * 1.3) / d);
      inner.push(x + (cx - x) * k, y + (cy - y) * k);
    }
    this.flat(inner, color, o);
    // Winding, so "outward" is the right side of each edge
    let area = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]; }
    const sgn = area >= 0 ? 1 : -1;
    const edge = o.edge ?? color;
    const tz = Math.sqrt(1 - BEVEL_TILT * BEVEL_TILT);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = pts[j * 2] - pts[i * 2], ey = pts[j * 2 + 1] - pts[i * 2 + 1];
      const len = Math.hypot(ex, ey) || 1;
      const ox = (ey / len) * sgn, oy = (-ex / len) * sgn;
      const nx = ox * BEVEL_TILT, ny = oy * BEVEL_TILT;
      const g = o.glow ?? 0, s = o.slot ?? 0;
      const a = this.vertex(pts[i * 2], pts[i * 2 + 1], nx, ny, tz, edge, g, s);
      const b = this.vertex(pts[j * 2], pts[j * 2 + 1], nx, ny, tz, edge, g, s);
      const c = this.vertex(inner[j * 2], inner[j * 2 + 1], nx, ny, tz, color, g, s);
      const d = this.vertex(inner[i * 2], inner[i * 2 + 1], nx, ny, tz, color, g, s);
      this.tri(a, b, c);
      this.tri(a, c, d);
    }
  }

  disc(x: number, y: number, r: number, color: number, o: ShapeOpts = {}, sides = 16): void {
    const pts: number[] = [];
    for (let i = 0; i < sides; i++) { const a = (i / sides) * Math.PI * 2; pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    this.panel(pts, color, o);
  }

  bar(x0: number, y0: number, x1: number, y1: number, width: number, color: number, o: ShapeOpts = {}): void {
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = (-(y1 - y0) / len) * width / 2, ny = ((x1 - x0) / len) * width / 2;
    this.panel([x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny], color, o);
  }

  /** A crater: a rim tilted inward round a flat floor (curving up through `o.rings` rings) */
  bowl(x: number, y: number, r: number, color: number, o: ShapeOpts = {}, sides = 7): void {
    const s = o.slot ?? 0, rings = Math.max(1, Math.round(o.rings ?? 1));
    const c = this.vertex(x, y, 0, 0, 1, color, 0, s);
    let prev = -1;
    for (let k = 1; k <= rings; k++) {
      const t = k / rings, tilt = 0.6 * t * t, tz = Math.sqrt(1 - tilt * tilt), row = this.vertexCount;
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        this.vertex(x + Math.cos(a) * r * t, y + Math.sin(a) * r * t, -Math.cos(a) * tilt, -Math.sin(a) * tilt, tz, color, 0, s);
      }
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides;
        if (prev < 0) this.tri(c, row + i, row + j);
        else { this.tri(prev + i, row + i, row + j); this.tri(prev + i, row + j, prev + j); }
      }
      prev = row;
    }
  }

  /**
   * An asteroid's body from its outline (local coordinates around 0, 0).
   * `jitter` (from the rock's seed) roughens the rings' normals.
   */
  rock(outline: { x: number; y: number }[], color: number, edge: number, mode: RockMesh, jitter: () => number, slot = 0, smooth = 0): void {
    const n = outline.length;
    if (mode === 'fan') {
      // Flat facets: each runs from the centre to one edge, tilted out over that edge
      for (let i = 0; i < n; i++) {
        const p = outline[i], q = outline[(i + 1) % n];
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, ml = Math.hypot(mx, my) || 1;
        const nx = (mx / ml) * 0.62, ny = (my / ml) * 0.62, nz = Math.sqrt(1 - 0.62 * 0.62);
        const a = this.vertex(0, 0, nx, ny, nz, color, 0, slot);
        const b = this.vertex(p.x, p.y, nx, ny, nz, edge, 0, slot);
        const c = this.vertex(q.x, q.y, nx, ny, nz, edge, 0, slot);
        this.tri(a, b, c);
      }
      return;
    }
    if (mode === 'facets' || mode === 'dome') { this.shapedRock(outline, color, edge, mode === 'dome' ? 1 : smooth, jitter, slot); return; }
    // Rings: centre facing up, a middle ring tilting a little, the rim tilting a lot; normals shared, so shading is smooth
    const RINGS = [{ at: 0.55, tilt: 0.38 }, { at: 1, tilt: 0.86 }];
    const centre = this.vertex(0, 0, 0, 0, 1, color, 0, slot);
    const rows: number[][] = [];
    for (const ring of RINGS) {
      const row: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = outline[i];
        const l = Math.hypot(p.x, p.y) || 1;
        const t = Math.min(0.95, ring.tilt + (jitter() - 0.5) * 0.25);
        const ja = (jitter() - 0.5) * 0.5;
        const ux = p.x / l, uy = p.y / l;
        const nx = (ux * Math.cos(ja) - uy * Math.sin(ja)) * t, ny = (ux * Math.sin(ja) + uy * Math.cos(ja)) * t;
        row.push(this.vertex(p.x * ring.at, p.y * ring.at, nx, ny, Math.sqrt(1 - t * t), ring.at < 1 ? color : edge, 0, slot));
      }
      rows.push(row);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.tri(centre, rows[0][i], rows[0][j]);
      this.tri(rows[0][i], rows[1][i], rows[1][j]);
      this.tri(rows[0][i], rows[1][j], rows[0][j]);
    }
  }

  /**
   * A rock with a real 3D shape: heights at a centre point, an inner ring and
   * the rim, lit by each triangle's true slope. Every triangle keeps its own
   * corners; `smooth` blends each corner's normal from its facet's (0: crisp
   * crystal facets) to the average of the facets meeting there (1: one smooth surface).
   */
  private shapedRock(outline: { x: number; y: number }[], color: number, edge: number, smooth: number, jitter: () => number, slot: number): void {
    const n = outline.length;
    let size = 0;
    for (const p of outline) size = Math.max(size, Math.hypot(p.x, p.y));
    // Points: a centre (nudged off the middle), an inner ring between each pair of rim points, the rim
    type P = { x: number; y: number; z: number; c: number };
    const centre: P = { x: (jitter() - 0.5) * size * 0.2, y: (jitter() - 0.5) * size * 0.2, z: size * (0.75 + jitter() * 0.3), c: color };
    const inner: P[] = [];
    for (let i = 0; i < n; i++) {
      const p = outline[i], q = outline[(i + 1) % n];
      const t = 0.42 + jitter() * 0.22;
      inner.push({ x: ((p.x + q.x) / 2) * t + centre.x * (1 - t), y: ((p.y + q.y) / 2) * t + centre.y * (1 - t), z: size * (0.45 + jitter() * 0.35), c: color });
    }
    const rim: P[] = outline.map((p) => ({ x: p.x, y: p.y, z: size * jitter() * 0.12, c: edge }));
    const tris: [P, P, P][] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tris.push([centre, inner[(i + n - 1) % n], inner[i]]);
      tris.push([inner[(i + n - 1) % n], rim[i], inner[i]]);
      tris.push([inner[i], rim[i], rim[j]]);
    }
    const normal = (a: P, b: P, c: P): [number, number, number] => {
      const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1;
      return [nx / l, ny / l, nz / l];
    };
    const faces = tris.map((t) => normal(t[0], t[1], t[2]));
    // Each point's average normal (of the facets meeting there)
    const avg = new Map<P, [number, number, number]>();
    if (smooth > 0) {
      tris.forEach((t, i) => {
        for (const p of t) { const a = avg.get(p) ?? [0, 0, 0]; a[0] += faces[i][0]; a[1] += faces[i][1]; a[2] += faces[i][2]; avg.set(p, a); }
      });
      for (const a of avg.values()) { const l = Math.hypot(a[0], a[1], a[2]) || 1; a[0] /= l; a[1] /= l; a[2] /= l; }
    }
    tris.forEach((t, i) => {
      const f = faces[i];
      const idx = t.map((p) => {
        let nx = f[0], ny = f[1], nz = f[2];
        if (smooth > 0) {
          const a = avg.get(p)!;
          nx += (a[0] - nx) * smooth; ny += (a[1] - ny) * smooth; nz += (a[2] - nz) * smooth;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
        }
        return this.vertex(p.x, p.y, nx, ny, nz, p.c, 0, slot);
      });
      this.tri(idx[0], idx[1], idx[2]);
    });
  }

  /** Append another builder's output (its slots replaced by `slot`) */
  append(o: LitGeometry, slot: number): void {
    const base = this.vertexCount;
    for (const v of o.pos) this.pos.push(v);
    for (const v of o.nrm) this.nrm.push(v);
    for (const v of o.col) this.col.push(v);
    for (let i = 0; i < o.slot.length; i++) this.slot.push(slot);
    for (const i of o.idx) this.idx.push(i + base);
  }

  /** Into a Pixi geometry (or refill `into`) */
  toGeometry(into?: Geometry, extra: Record<string, { buffer: Float32Array; format: 'float32' | 'float32x2' | 'float32x3' | 'float32x4' }> = {}): Geometry {
    const pos = new Float32Array(this.pos), nrm = new Float32Array(this.nrm), col = new Float32Array(this.col), slot = new Float32Array(this.slot);
    const idx = new Uint32Array(this.idx);
    if (into) {
      into.getBuffer('aPosition').data = pos;
      into.getBuffer('aNormal').data = nrm;
      into.getBuffer('aColor').data = col;
      into.getBuffer('aSlot').data = slot;
      into.indexBuffer.data = idx;
      return into;
    }
    return new Geometry({
      attributes: {
        aPosition: { buffer: pos, format: 'float32x2' },
        aNormal: { buffer: nrm, format: 'float32x3' },
        aColor: { buffer: col, format: 'float32x4' },
        aSlot: { buffer: slot, format: 'float32' },
        ...extra,
      },
      indexBuffer: idx,
    });
  }
}
