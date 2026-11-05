/**
 * Asteroid geometry with what the rock shaders need as well
 * (RockMaterials.ts): each vertex also carries its place on the surface
 * (aSurf: u, v ÷ size, height ÷ size, and the rock's size), the smooth normal
 * there (aSmooth) and aMat: the rock's material, seed, greyseam, and which
 * of its two meshes the vertex belongs to (0 the full one, 1 the light one
 * for when it's small on screen). Both meshes go in; the shader keeps one per
 * rock, by how big that rock is on screen, so chunks still draw in one go.
 */

import { Geometry } from 'pixi.js';
import { LitGeometry } from '../lighting/LitGeometry';

export class RockGeometry extends LitGeometry {
  surf: number[] = [];
  smo: number[] = [];
  mat: number[] = [];

  /** A vertex with its surface place `s` (u, v ÷ size, height ÷ size, size), smooth normal `sm` and `m` (material, seed, greyseam, light mesh) */
  rockVertex(x: number, y: number, n: readonly number[], color: number, s: readonly number[], sm: readonly number[], m: readonly number[]): number {
    this.surf.push(s[0], s[1], s[2], s[3]);
    this.smo.push(sm[0], sm[1], sm[2]);
    this.mat.push(m[0], m[1], m[2], m[3]);
    return this.vertex(x, y, n[0], n[1], n[2], color);
  }

  override append(o: LitGeometry, slot: number): void {
    if (!(o instanceof RockGeometry)) throw new Error('RockGeometry: append another RockGeometry');
    super.append(o, slot);
    for (const v of o.surf) this.surf.push(v);
    for (const v of o.smo) this.smo.push(v);
    for (const v of o.mat) this.mat.push(v);
  }

  /** Into a Pixi geometry with every attribute (or refill `into`) */
  toRockGeometry(into?: Geometry): Geometry {
    const g = this.toGeometry(into);
    const surf = new Float32Array(this.surf), smo = new Float32Array(this.smo), mat = new Float32Array(this.mat);
    if (into) {
      g.getBuffer('aSurf').data = surf;
      g.getBuffer('aSmooth').data = smo;
      g.getBuffer('aMat').data = mat;
      return g;
    }
    g.addAttribute('aSurf', { buffer: surf, format: 'float32x4' });
    g.addAttribute('aSmooth', { buffer: smo, format: 'float32x3' });
    g.addAttribute('aMat', { buffer: mat, format: 'float32x4' });
    return g;
  }
}
