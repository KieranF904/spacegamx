/**
 * A Burst Strafer's burst (was ShipRenderer.drawDodge): from each strafer firing (those pushing the dodge's way, each by
 * how much of its push goes that way), a hot pink-white jet out of its nozzle (long at first, shrinking as the burst
 * runs out) with a flash at the mouth, and speed streaks trailing off the hull away from the dodge. Redrawn every frame
 * while it runs (a fifth of a second); nothing otherwise. One Graphics per ship, in the ship's own container, made on
 * its first burst (kept by container, so it goes with the ship's view).
 */
import { Graphics, type Container } from 'pixi.js';
import { dodgePhase, dodgeVec } from '@space-game/common';
import { decorOf } from '../../partDecor';
import type { ShipDrawCtx } from '../types';

const jets = new WeakMap<Container, Graphics>();

/** `counter`, `dir`: the ship's dodge counter and way (the pilot's predicted, everyone else's replica's) */
export function drawJets(ctx: ShipDrawCtx, counter: number | undefined, dir: number | undefined): void {
  const { ship, container, cs, now } = ctx;
  const s = ship.derived.fx?.strafe;
  const ph = s ? dodgePhase(counter, s) : null;
  let g = jets.get(container);
  if (!s || !ph || ph.phase !== 'burst' || !dir) {
    if (g?.visible) g.visible = false;
    return;
  }
  if (!g) { g = new Graphics(); container.addChild(g); jets.set(container, g); }
  g.visible = true;
  g.clear();
  const k = 1 - ph.progress, flicker = 0.85 + 0.15 * Math.sin(now / 23);
  const [cx, cy] = ship.derived.com;
  const geoms = ctx.geometry(ship);
  const [ux, uy] = dodgeVec(dir);
  for (const p of s.parts) {
    const geom = geoms[p.part], f = Math.hypot(p.push[0], p.push[1]);
    const share = f > 0 ? (p.push[0] * ux + p.push[1] * uy) / f : 0;
    if (!geom || share <= 0.05) continue;
    for (const nz of decorOf(geom).nozzles) {
      const bx = (nz.at[0] - cx) * cs, by = (nz.at[1] - cy) * cs;
      const hw = (nz.width / 2) * cs * (1.1 + 0.6 * k), len = cs * (1.4 + 4.2 * k) * flicker * (0.4 + 0.6 * share);
      const tip = [bx + nz.n[0] * len, by + nz.n[1] * len];
      const l = [bx + nz.t[0] * hw, by + nz.t[1] * hw], r = [bx - nz.t[0] * hw, by - nz.t[1] * hw];
      g.poly([l[0], l[1], tip[0], tip[1], r[0], r[1]]).fill({ color: 0xf472b6, alpha: 0.75 * (0.4 + 0.6 * k) });
      const core = [bx + nz.n[0] * len * 0.6, by + nz.n[1] * len * 0.6];
      g.poly([bx + nz.t[0] * hw * 0.45, by + nz.t[1] * hw * 0.45, core[0], core[1], bx - nz.t[0] * hw * 0.45, by - nz.t[1] * hw * 0.45]).fill({ color: 0xffffff, alpha: 0.85 * k });
      g.circle(bx, by, hw * (1.3 + 1.2 * k)).fill({ color: 0xfbcfe8, alpha: 0.65 * k });
    }
  }
  // Afterimage: three fading pink copies of the hull strung out behind, so the dodge reads as a jump
  const R0 = ship.derived.radius;
  for (let i = 3; i >= 1; i--) {
    const off = R0 * 0.32 * i * (0.5 + 0.5 * (1 - k * 0.6)), ox = -ux * off, oy = -uy * off, a = 0.2 * (1 - (i - 1) * 0.28) * (0.3 + 0.7 * k);
    for (let j = 0; j < geoms.length; j++) {
      const poly = geoms[j]?.polygon;
      if (!poly || !ship.derived.alive[j]) continue;
      for (let v = 0; v < poly.length; v++) {
        const x = (poly[v][0] - cx) * cs + ox, y = (poly[v][1] - cy) * cs + oy;
        if (v) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.closePath();
    }
    g.fill({ color: 0xf9a8d4, alpha: a });
  }
  // Speed streaks: off the hull's trailing side (opposite the push), fading with the burst
  const R = ship.derived.radius, nx = -uy, ny = ux;
  for (let i = -1; i <= 1; i++) {
    const o = i * R * 0.45, a = R * 0.7, b = R * 0.9 + cs * (1.5 + 3 * k);
    g.moveTo(nx * o - ux * a, ny * o - uy * a).lineTo(nx * o - ux * b, ny * o - uy * b).stroke({ width: cs * 0.14, color: 0xf9a8d4, alpha: 0.6 * k });
  }
}
