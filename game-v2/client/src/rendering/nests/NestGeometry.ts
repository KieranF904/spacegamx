/**
 * Nest geometry: RockGeometry (so the rocks' material attributes) plus each
 * vertex's motion and its piece's centre (aOrb: centre xy, how fast it
 * circles the nest's centre, how fast it tumbles round its own centre), so a
 * knot's shards swirl in one draw, and fine pieces can shrink away into their
 * centres when the nest is small on screen (nestShader.ts).
 *
 * aMat.w says which mesh a vertex belongs to:
 *    0 / 1   a rock body's full / light mesh (picked by size on screen, as rocks are)
 *   -1       a nest piece, always drawn
 *   -2       a fine piece (chips, debris, lamp bodies, windows, crates): shrinks away when the nest is far off
 */

import { Container, Geometry } from 'pixi.js';
import type { Composition } from '@space-game/common';
import { RockGeometry } from '../rocks/RockGeometry';
import { drawAsteroid } from '../AsteroidLook';

export const rgb = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
const hex = (r: number, g: number, b: number) => (Math.min(255, Math.round(r * 255)) << 16) | (Math.min(255, Math.round(g * 255)) << 8) | Math.min(255, Math.round(b * 255));
export const mix = (a: number, b: number, t: number): number => { const x = rgb(a), y = rgb(b); return hex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t); };
/** Lit colours are multiplied by ~0.75 of light on a flat face; a base colour a touch brighter than the old flat one reads the same */
export const lift = (c: number, k = 1.3): number => { const x = rgb(c); return hex(x[0] * k, x[1] * k, x[2] * k); };

export interface Tag {
  mat: number;
  /** The piece's own seed (turns and shifts its relief; 0 on plating, whose seams line up with its edges) */
  seed?: number;
  vein?: number;
  /** Surface scale: the relief's place is the vertex's position ÷ S */
  S?: number;
  /** The smooth normal: given, or each vertex's own */
  smooth?: number[] | 'own';
  /** Circling rate and tumbling rate (radians a second) round the piece's centre */
  orb?: [number, number];
  /** The piece's size for its detail fade (world units; defaults to its radius) */
  lod?: number;
  /** A fine piece: shrinks away when the nest is small on screen */
  fine?: boolean;
  /** The surface coordinates turned by -axis round the piece's centre (plating's seams run along a turned plate) */
  axis?: number;
}

export class NestGeometry extends RockGeometry {
  orb: number[] = [];

  /** Give the vertices from v0 on their material, surface place, smooth normal and motion */
  tag(v0: number, t: Tag): void {
    const S = t.S ?? 260;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let v = v0; v < this.vertexCount; v++) {
      const x = this.pos[v * 2], y = this.pos[v * 2 + 1];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, lod = t.lod ?? Math.max(8, Math.hypot(x1 - x0, y1 - y0) / 2);
    const ca = Math.cos(-(t.axis ?? 0)), sa = Math.sin(-(t.axis ?? 0));
    for (let v = v0; v < this.vertexCount; v++) {
      const dx = this.pos[v * 2] - cx, dy = this.pos[v * 2 + 1] - cy;
      const ux = t.axis ? cx + dx * ca - dy * sa : this.pos[v * 2], uy = t.axis ? cy + dx * sa + dy * ca : this.pos[v * 2 + 1];
      this.surf.push(ux / S, uy / S, 0.3, lod);
      const sm = t.smooth === 'own' ? [this.nrm[v * 3], this.nrm[v * 3 + 1], this.nrm[v * 3 + 2]] : t.smooth ?? [0, 0, 1];
      this.smo.push(sm[0], sm[1], sm[2]);
      this.mat.push(t.mat, t.seed ?? 0.3, t.vein ?? 0, t.fine ? -2 : -1);
      this.orb.push(cx, cy, t.orb?.[0] ?? 0, t.orb?.[1] ?? 0);
    }
  }

  /** Tilt the normals from v0 on (a plate lying at a slant) */
  tilt(v0: number, tx: number, ty: number): void {
    for (let v = v0; v < this.vertexCount; v++) {
      const nx = this.nrm[v * 3] + tx * this.nrm[v * 3 + 2], ny = this.nrm[v * 3 + 1] + ty * this.nrm[v * 3 + 2], nz = this.nrm[v * 3 + 2], l = Math.hypot(nx, ny, nz);
      this.nrm[v * 3] = nx / l; this.nrm[v * 3 + 1] = ny / l; this.nrm[v * 3 + 2] = nz / l;
    }
  }

  shift(v0: number, dx: number, dy: number): void {
    for (let v = v0; v < this.vertexCount; v++) { this.pos[v * 2] += dx; this.pos[v * 2 + 1] += dy; }
  }

  /** Scale the colours from v0 on by f(x, y) */
  shade(v0: number, f: (x: number, y: number) => number): void {
    for (let v = v0; v < this.vertexCount; v++) { const k = f(this.pos[v * 2], this.pos[v * 2 + 1]); for (let c = 0; c < 3; c++) this.col[v * 4 + c] *= k; }
  }

  /** A rock body from the asteroids' own builder (both its meshes), recoloured to `color` (its relative shading kept), moved to (x, y) */
  boulder(id: number, size: number, comp: Composition, color: number, x = 0, y = 0, vein?: number, glow = 0): void {
    const rg = drawAsteroid(new Container(), id, size, comp).rock.geometry, v0 = this.vertexCount;
    this.append(rg, 0);
    const m = [0, 0, 0];
    for (let v = v0; v < this.vertexCount; v++) for (let c = 0; c < 3; c++) m[c] += this.col[v * 4 + c];
    const n = Math.max(1, this.vertexCount - v0), t = rgb(color);
    for (let v = v0; v < this.vertexCount; v++) {
      for (let c = 0; c < 3; c++) this.col[v * 4 + c] *= t[c] / Math.max(m[c] / n, 0.01);
      this.col[v * 4 + 3] = glow;
      if (vein !== undefined && this.mat[v * 4 + 3] < 0.5) this.mat[v * 4 + 2] = vein;
      this.orb.push(x, y, 0, 0);
    }
    this.shift(v0, x, y);
  }

  /** A fan of facets round (cx, cy), each tilted out over its edge by `tilt` */
  gem(pts: number[], cx: number, cy: number, tilt: number, color: number, glow: number, tag: Tag): void {
    const n = pts.length / 2, v0 = this.vertexCount;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, mx = (pts[i * 2] + pts[j * 2]) / 2 - cx, my = (pts[i * 2 + 1] + pts[j * 2 + 1]) / 2 - cy, ml = Math.hypot(mx, my) || 1;
      const nx = (mx / ml) * tilt, ny = (my / ml) * tilt, nz = Math.sqrt(1 - tilt * tilt);
      const a = this.vertex(cx, cy, nx, ny, nz, mix(color, 0xffffff, 0.15), glow), b = this.vertex(pts[i * 2], pts[i * 2 + 1], nx, ny, nz, color, glow), c = this.vertex(pts[j * 2], pts[j * 2 + 1], nx, ny, nz, color, glow);
      this.tri(a, b, c);
    }
    this.tag(v0, { smooth: [0, 0, 1], ...tag });
  }

  build(): Geometry {
    const g = this.toRockGeometry();
    g.addAttribute('aOrb', { buffer: new Float32Array(this.orb), format: 'float32x4' });
    return g;
  }
}
