/**
 * The preview's target dummy as a real surface (no Pixi, no DOM): a turned octagon of hull plate whose edges are both
 * what is drawn and what rounds hit. `cast` finds where a shell's line first meets it and `normalAt` the edge's normal
 * facing the shell, the way the game's drawn world answers WeaponFx.castHit and surfaceAt (ships/drawnHit.ts,
 * ships/hitSurface.ts), so impacts throw off the plate as they do off a ship.
 */

import { SurfaceProbe, type SurfaceNormal } from '../../rendering/weapons/impactAim';

/** The dummy's entity id for the impact anchors (it is a pose the preview's state answers for) */
export const DUMMY_ID = 7_000_001;
/** The octagon is turned this far, so no flat face meets the line of fire square on and rebounds read */
const TURN = (15 * Math.PI) / 180;
/** As hitSurface: how far back along the line and on past the hit its edges are looked for, and the nearest edge's reach */
const BACK = 48, ON = 24, REACH = 36;

/** The octagon's corners about (cx, 0), flat as x, y pairs */
export function dummyPoly(cx: number, r: number): number[] {
  return Array.from({ length: 8 }, (_, i) => [cx + Math.cos((i + 0.5) * Math.PI / 4 + TURN) * r, Math.sin((i + 0.5) * Math.PI / 4 + TURN) * r]).flat();
}

const probe = new SurfaceProbe();

/** The first `t` (0..1) along (x0, y0) -> (x1, y1) that meets the polygon's edge (0 if it starts inside), or null */
export function castPoly(poly: readonly number[], x0: number, y0: number, x1: number, y1: number): number | null {
  const n = poly.length / 2, dx = x1 - x0, dy = y1 - y0;
  // Inside a convex polygon: on one side of every edge
  let pos = 0, neg = 0, best = Infinity;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2], ay = poly[i * 2 + 1], bx = poly[((i + 1) % n) * 2], by = poly[((i + 1) % n) * 2 + 1];
    const ex = bx - ax, ey = by - ay;
    const side = ex * (y0 - ay) - ey * (x0 - ax);
    if (side > 0) pos++; else if (side < 0) neg++;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const qx = ax - x0, qy = ay - y0;
    const t = (qx * ey - qy * ex) / den, u = (qx * dy - qy * dx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < best) best = t;
  }
  if (pos === 0 || neg === 0) return 0;
  return best === Infinity ? null : best;
}

/** The normal of the edge a shell flying (dx, dy) (a unit vector) struck at (x, y), facing it, and the dummy as its target */
export function normalAt(poly: readonly number[], x: number, y: number, dx: number, dy: number, out: SurfaceNormal): SurfaceNormal | null {
  probe.begin(x - dx * BACK, y - dy * BACK, x + dx * ON, y + dy * ON, x, y, REACH);
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) probe.edge(poly[i * 2], poly[i * 2 + 1], poly[((i + 1) % n) * 2], poly[((i + 1) % n) * 2 + 1], DUMMY_ID);
  return probe.result(out);
}
