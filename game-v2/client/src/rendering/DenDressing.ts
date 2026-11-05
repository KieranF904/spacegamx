/**
 * What's in and on a den's rock that isn't rock (TerrainFile `dressing`; the Scrap Mother's Nest Rock,
 * scripts/terrain/scrap_nest.mjs). Look only, drawn over the rock:
 *
 *   plates   scrap plates welded over the rock face round a way in: dull steel, a darker seam, rivets
 *   cables   slung across a chamber: a dark line with a faint sheen along it
 *   belts    conveyors over a chamber's floor: a dark bed, its rails, cross-slats running the way it goes
 *   veins    greyseam in the rock's cracks: a faint green glow, slowly breathing
 *   lamps    amber work lamps on the walls: a hot point, a soft glow round it, and a light every few lamps
 *
 * The static parts are drawn once; the belts' slats and the veins' breath move.
 */

import { Container, Graphics } from 'pixi.js';
import type { TerrainFile, Vec2 } from '@space-game/common';
import type { Lighting } from './lighting/Lighting';

type Dressing = NonNullable<TerrainFile['dressing']>;

const AMBER = 0xffa53a, SEAM = 0x7affd2;
/** A light at every this many lamps (the rest only glow) */
const LIGHT_EVERY = 3;
/** Belt slats: this far apart, running this fast (world units a second) */
const SLAT = 160, BELT_SPEED = 90;

const hash = (i: number) => { const s = Math.sin(i * 91.3 + 7.1) * 43758.5453; return s - Math.floor(s); };

export class DenDressing {
  readonly container = new Container();
  private still = new Graphics();
  private glow = new Graphics();
  private moving = new Graphics();
  private t = 0;
  private lit: Vec2[];
  private source = (L: Lighting) => {
    for (let i = 0; i < this.lit.length; i++) {
      const [x, y] = this.lit[i], flick = 0.92 + 0.08 * Math.sin(this.t * (5 + hash(i) * 4) + i);
      L.point(x, y, AMBER, 900, 0.32 * flick, 160);
    }
  };

  constructor(private d: Dressing, private lighting: Lighting) {
    this.glow.blendMode = 'add';
    this.container.addChild(this.still, this.moving, this.glow);
    this.lit = (d.lamps ?? []).filter((_, i) => i % LIGHT_EVERY === 0);
    this.drawStill();
    lighting.addSource(this.source);
  }

  private drawStill(): void {
    const g = this.still, d = this.d;
    for (const p of d.plates ?? []) {
      g.poly(p.flat()).fill({ color: 0x4a4d52 }).stroke({ color: 0x24262a, width: 18 });
      // (a seam across it, and rivets in its corners)
      const [a, b, c, e] = p;
      g.moveTo((a[0] + e[0]) / 2, (a[1] + e[1]) / 2).lineTo((b[0] + c[0]) / 2, (b[1] + c[1]) / 2).stroke({ color: 0x2e3034, width: 10 });
      for (const q of p) {
        const cx = (a[0] + b[0] + c[0] + e[0]) / 4, cy = (a[1] + b[1] + c[1] + e[1]) / 4;
        g.circle(q[0] + (cx - q[0]) * 0.18, q[1] + (cy - q[1]) * 0.18, 14).fill({ color: 0x8a8d92 });
      }
      // (rust bleeding from its lower edge)
      g.poly([a[0], a[1], b[0], b[1], b[0] + (c[0] - b[0]) * 0.25, b[1] + (c[1] - b[1]) * 0.25, a[0] + (e[0] - a[0]) * 0.25, a[1] + (e[1] - a[1]) * 0.25]).fill({ color: 0x6f4632, alpha: 0.45 });
    }
    for (const b of d.belts ?? []) {
      if (b.pts.length < 2) continue;
      const pts = b.pts.flat();
      g.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      g.stroke({ color: 0x1b1a19, width: b.w, cap: 'butt', join: 'round' });
      // (its rails either side)
      for (const side of [-1, 1]) {
        const rail = offset(b.pts, (side * b.w) / 2);
        g.moveTo(rail[0][0], rail[0][1]);
        for (const [x, y] of rail.slice(1)) g.lineTo(x, y);
        g.stroke({ color: 0x6a6258, width: 22 });
      }
    }
    for (const c of d.cables ?? []) {
      g.moveTo(c[0][0], c[0][1]);
      for (const [x, y] of c.slice(1)) g.lineTo(x, y);
      g.stroke({ color: 0x0c0c0d, width: 26, alpha: 0.9 });
      g.moveTo(c[0][0], c[0][1] - 6);
      for (const [x, y] of c.slice(1)) g.lineTo(x, y - 6);
      g.stroke({ color: 0x5a5a5e, width: 5, alpha: 0.5 });
    }
    // Lamps: a housing on the wall, and its hot face
    for (const [x, y] of d.lamps ?? []) {
      g.circle(x, y, 34).fill({ color: 0x1e1d1c });
      g.circle(x, y, 18).fill({ color: 0xffe2b0 });
    }
  }

  /** The glow (lamps' halos, the veins) is redrawn a few times a second: a slow breath and a lamp's odd flicker */
  private drawGlow(k: number): void {
    const g = this.glow, d = this.d;
    g.clear();
    for (const v of d.veins ?? []) {
      if (v.length < 2) continue;
      g.moveTo(v[0][0], v[0][1]);
      for (const [x, y] of v.slice(1)) g.lineTo(x, y);
      g.stroke({ color: SEAM, width: 70, alpha: 0.05 + 0.03 * k, join: 'round', cap: 'round' });
      g.moveTo(v[0][0], v[0][1]);
      for (const [x, y] of v.slice(1)) g.lineTo(x, y);
      g.stroke({ color: SEAM, width: 14, alpha: 0.35 + 0.15 * k, join: 'round', cap: 'round' });
    }
    (d.lamps ?? []).forEach(([x, y], i) => {
      // (now and then one stutters)
      const f = hash(i + Math.floor(this.t * 3)) < 0.03 ? 0.35 : 1;
      g.circle(x, y, 260).fill({ color: AMBER, alpha: 0.08 * f });
      g.circle(x, y, 90).fill({ color: AMBER, alpha: 0.28 * f });
    });
  }

  /** The belts' slats, running along them */
  private drawBelts(): void {
    const g = this.moving;
    g.clear();
    for (const b of this.d.belts ?? []) {
      const pts = b.pts;
      let run = 0;
      const shift = (this.t * BELT_SPEED) % SLAT;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i], l = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / l, uy = (by - ay) / l;
        for (let s = ((SLAT - ((run - shift) % SLAT)) % SLAT); s < l; s += SLAT) {
          const x = ax + ux * s, y = ay + uy * s, hx = -uy * (b.w * 0.42), hy = ux * (b.w * 0.42);
          g.moveTo(x - hx, y - hy).lineTo(x + hx, y + hy).stroke({ color: 0x4a4540, width: 26 });
        }
        run += l;
      }
    }
  }

  update(dt: number): void {
    this.t += dt;
    this.drawBelts();
    const step = Math.floor(this.t * 6);
    if (step !== Math.floor((this.t - dt) * 6) || dt === 0) this.drawGlow(0.5 + 0.5 * Math.sin(this.t * 0.9));
  }

  destroy(): void {
    this.lighting.removeSource(this.source);
    this.container.destroy({ children: true });
  }
}

/** A line moved `d` to its left (each point along its own normal) */
function offset(pts: Vec2[], d: number): Vec2[] {
  return pts.map(([x, y], i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
    return [x - (ey / l) * d, y + (ex / l) * d] as Vec2;
  });
}
