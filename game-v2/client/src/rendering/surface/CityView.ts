/**
 * A city on a planet's surface, seen from above: a block on every cell of the
 * ground's street grid (640 world units, the same grid the ground shader
 * draws), its roof a lit panel, taller and glassier towards the centre, with
 * rooftop plant, a few landmark towers, parks, and a spaceport at the heart.
 * One lit mesh for the lot, built once.
 */

import { Container, Graphics } from 'pixi.js';
import { LitGeometry } from '../lighting/LitGeometry';
import { Lighting, LitMesh } from '../lighting/Lighting';

const CELL = 640;
const STREET = 64;
const ROOFS = [0x9aa2ac, 0x8a929c, 0xb4bac2, 0x7d858f, 0xa7a196, 0x8f8a80];
const GLASS = [0x4f6f8f, 0x3f5f7f, 0x5a7d9c];
const PARK = 0x4c7a3a;

function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CitySpec { name: string; x: number; y: number; radius: number; pylons: { x: number; y: number }[] }

export class CityView {
  readonly container = new Container();
  private lit: LitMesh;

  constructor(city: CitySpec, seed: number, private lighting: Lighting) {
    const r = rng(seed * 977 + 13);
    const g = new LitGeometry();
    const R = city.radius;
    const n = Math.ceil(R / CELL) + 1;
    const keepClear = (x: number, y: number, pad: number) =>
      Math.hypot(x, y) < 900 + pad || city.pylons.some((p) => Math.hypot(p.x - x, p.y - y) < 520 + pad);

    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        // Block centres sit between the ground's streets (which run along multiples of CELL)
        const cx = i * CELL + CELL / 2, cy = j * CELL + CELL / 2;
        const d = Math.hypot(cx, cy);
        // Thinning out towards the edge
        if (d > R * 1.05 || r() < Math.max(0, (d / R - 0.55) * 1.6)) continue;
        if (keepClear(cx, cy, 0)) continue;
        const half = CELL / 2 - STREET / 2;
        if (r() < 0.08) {
          // A park
          g.panel(box(cx, cy, half - 10, half - 10), PARK, { bevel: 14, edge: 0x3c6a2c });
          for (let t = 0; t < 4; t++) g.disc(cx + (r() - 0.5) * half * 1.4, cy + (r() - 0.5) * half * 1.4, 26 + r() * 22, 0x2f5a28, { bevel: 10 }, 7);
          continue;
        }
        // Centre: taller (wider bevel catches more light), glassier
        const core = 1 - Math.min(1, d / R);
        const lots = r() < 0.4 ? 2 : 1;
        for (let k = 0; k < lots; k++) {
          const w = lots === 2 ? half * 0.46 : half * (0.7 + r() * 0.25);
          const h = lots === 2 ? half * (0.75 + r() * 0.2) : half * (0.7 + r() * 0.25);
          const ox = lots === 2 ? (k ? 1 : -1) * half * 0.48 : (r() - 0.5) * (half - w) * 2;
          const oy = lots === 2 ? 0 : (r() - 0.5) * (half - h) * 2;
          const glass = r() < 0.15 + core * 0.45;
          const color = glass ? GLASS[Math.floor(r() * GLASS.length)] : ROOFS[Math.floor(r() * ROOFS.length)];
          const bevel = 14 + core * 46 + r() * 14;
          g.panel(box(cx + ox, cy + oy, w, h), color, { bevel, edge: shade(color, 0.7) });
          // Rooftop plant and lit windows on the tall ones
          if (!glass && r() < 0.6) g.panel(box(cx + ox + (r() - 0.5) * w * 0.8, cy + oy + (r() - 0.5) * h * 0.8, 22, 16), 0x6b7078, { bevel: 6 });
          if (core > 0.5 && r() < 0.5) {
            for (let q = 0; q < 6; q++) g.disc(cx + ox + (r() - 0.5) * w * 1.4, cy + oy + (r() - 0.5) * h * 1.4, 5, 0xffe2a0, { glow: 1 }, 5);
          }
        }
      }
    }

    // Landmark towers near the centre
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.5, d = 1500 + r() * 600;
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      if (keepClear(x, y, -200)) continue;
      const sides = 6 + Math.floor(r() * 3);
      const pts: number[] = [];
      for (let s = 0; s < sides; s++) { const b = (s / sides) * Math.PI * 2; pts.push(x + Math.cos(b) * 170, y + Math.sin(b) * 170); }
      g.panel(pts, 0x5a7d9c, { bevel: 80, edge: 0x2e4258 });
      g.disc(x, y, 34, 0xff5a4a, { glow: 1 }, 8);
    }

    // The shield pylons stand on lit platforms (what the city's defenders gather round)
    for (const p of city.pylons) {
      const pts: number[] = [];
      for (let s = 0; s < 6; s++) { const b = (s / 6) * Math.PI * 2 + Math.PI / 6; pts.push(p.x + Math.cos(b) * 330, p.y + Math.sin(b) * 330); }
      g.panel(pts, 0x5c6470, { bevel: 40, edge: 0x7dd3fc });
      g.disc(p.x, p.y, 210, 0x3a4250, { bevel: 18 }, 18);
      for (let s = 0; s < 6; s++) { const b = (s / 6) * Math.PI * 2; g.disc(p.x + Math.cos(b) * 280, p.y + Math.sin(b) * 280, 10, 0x7dd3fc, { glow: 1 }, 6); }
    }

    // The spaceport: a ring of pads round a control tower
    g.disc(0, 0, 820, 0x6a7078, { bevel: 30, edge: 0x4a5058 }, 32);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const x = Math.cos(a) * 520, y = Math.sin(a) * 520;
      g.disc(x, y, 150, 0x4d535b, { bevel: 12 }, 16);
      g.disc(x, y, 112, 0x3a3f46, {}, 16);
      for (let s = 0; s < 4; s++) { const b = (s / 4) * Math.PI * 2 + a; g.disc(x + Math.cos(b) * 128, y + Math.sin(b) * 128, 7, 0x7dd3fc, { glow: 1 }, 5); }
    }
    g.disc(0, 0, 210, 0xb4bac2, { bevel: 60, edge: 0x6a7078 }, 12);
    g.disc(0, 0, 70, 0x7dd3fc, { glow: 0.8 }, 10);

    this.lit = new LitMesh(g.toGeometry());
    this.lit.radius = R * 1.1;
    this.container.position.set(city.x, city.y);
    this.container.addChild(this.lit.mesh);
    lighting.add(this.lit);

    // The city's name on the ground (seen from far up)
    const ring = new Graphics();
    ring.circle(0, 0, R * 1.08).stroke({ color: 0x7dd3fc, width: 6, alpha: 0.12 });
    this.container.addChildAt(ring, 0);
  }

  dispose(): void {
    this.lighting.remove(this.lit);
    this.container.destroy({ children: true });
  }
}

function box(cx: number, cy: number, hw: number, hh: number): number[] {
  return [cx - hw, cy - hh, cx + hw, cy - hh, cx + hw, cy + hh, cx - hw, cy + hh];
}

function shade(c: number, k: number): number {
  return (Math.round(((c >> 16) & 255) * k) << 16) | (Math.round(((c >> 8) & 255) * k) << 8) | Math.round((c & 255) * k);
}
