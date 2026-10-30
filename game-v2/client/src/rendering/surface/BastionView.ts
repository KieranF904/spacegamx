/**
 * A moon siege's bastion ground: the crater it stands in, a stepped platform
 * under it (each moon's its own shape), ramparts where the moon has them, and
 * the turret pads round it, each ringed with lights (the pads glow brighter at
 * night, when they're what you're flying home to). The bastion and its
 * turrets themselves are ships (wards) drawn as ships.
 *
 * Lighting is worked out per vertex, so the big flat parts are cut into rings
 * and segments: headlights and the pads' lamps light the ground where they
 * fall, not just at its far corners.
 */

import { Container } from 'pixi.js';
import { LitGeometry } from '../lighting/LitGeometry';
import { Lighting, LitMesh } from '../lighting/Lighting';

const DEG = Math.PI / 180;

export class BastionView {
  readonly container = new Container();
  private lit: LitMesh;
  private pads: { x: number; y: number }[];

  constructor(b: { x: number; y: number; slots: { x: number; y: number }[]; platform?: { sides: number; radius: number }; walls?: { from: number; to: number; radius: number }[] }, private lighting: Lighting) {
    const g = new LitGeometry();
    this.pads = b.slots;
    const reach = Math.max(1250, ...b.slots.map((p) => Math.hypot(p.x, p.y) + 260), ...(b.walls ?? []).map((w) => w.radius + 160));
    // The crater: a wide bowl, its rim lit on the far side
    g.bowl(0, 0, reach * 1.5, 0x6d6a66, { rings: 7 }, 36);
    g.disc(0, 0, reach, 0x5d5a57, { bevel: 90, edge: 0x4a4744, rings: 6 }, 36);
    // Platform: two stepped polygons, the moon's own shape
    const sides = b.platform?.sides ?? 8, size = b.platform?.radius ?? 820;
    const poly = (r: number, color: number, edge: number, bevel: number, rings: number) => {
      const pts: number[] = [];
      for (let k = 0; k < sides; k++) { const a = (k / sides) * Math.PI * 2 + Math.PI / sides; pts.push(Math.cos(a) * r, Math.sin(a) * r); }
      g.panel(pts, color, { bevel, edge, rings, split: Math.max(1, Math.round(24 / sides)) });
    };
    poly(size, 0x5c6470, 0x3a4048, 40, 6);
    poly(size * 0.44, 0x6a737f, 0x434b56, 28, 3);
    // Ramparts: low walls of rock in arcs, cut into blocks
    for (const w of b.walls ?? []) {
      const span = (((w.to - w.from) % 360) + 360) % 360 || 360, n = Math.max(2, Math.round(span / 7));
      for (let k = 0; k < n; k++) {
        const a0 = (w.from + (span * k) / n) * DEG, a1 = (w.from + (span * (k + 0.92)) / n) * DEG;
        const r0 = w.radius - 55, r1 = w.radius + 55;
        g.panel([Math.cos(a0) * r0, Math.sin(a0) * r0, Math.cos(a1) * r0, Math.sin(a1) * r0, Math.cos(a1) * r1, Math.sin(a1) * r1, Math.cos(a0) * r1, Math.sin(a0) * r1],
          0x7a7570, { bevel: 30, edge: 0x4f4b47, split: 2 });
      }
    }
    // Spokes out to the pads
    for (const p of b.slots) g.bar(0, 0, p.x, p.y, 70, 0x4d555f, { bevel: 14, split: Math.max(1, Math.round(Math.hypot(p.x, p.y) / 160)) });
    for (const p of b.slots) {
      g.disc(p.x, p.y, 120, 0x6a737f, { bevel: 26, edge: 0x7dd3fc }, 12);
      g.disc(p.x, p.y, 74, 0x3a4250, { bevel: 10 }, 12);
      for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; g.disc(p.x + Math.cos(a) * 100, p.y + Math.sin(a) * 100, 6, 0x7dd3fc, { glow: 1 }, 5); }
    }
    // Landing lights round the platform's rim
    for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; g.disc(Math.cos(a) * size * 0.95, Math.sin(a) * size * 0.95, 9, 0xffd890, { glow: 1 }, 6); }
    this.lit = new LitMesh(g.toGeometry());
    this.lit.radius = reach * 1.5;
    this.container.position.set(b.x, b.y);
    this.container.addChild(this.lit.mesh);
    lighting.add(this.lit);
    lighting.addSource(this.lights);
  }

  /** The pads' and rim's lamps: they matter at night */
  private lights = (L: Lighting): void => {
    if (!this.container.visible) return;
    const x0 = this.container.x, y0 = this.container.y;
    for (const p of this.pads) L.point(x0 + p.x, y0 + p.y, 0x7dd3fc, 520, 0.7, 120);
    L.point(x0, y0, 0xffd890, 1500, 0.6, 500);
  };

  dispose(): void {
    this.lighting.removeSource(this.lights);
    this.lighting.remove(this.lit);
    this.container.destroy({ children: true });
  }
}
