/**
 * A Tow Beam's tether (ships/features/tow/Towing.ts on the server): an amber line from the beam's mouth to what it tows,
 * a little slack in it, with pulses running along it towards the ship. All of a frame's tethers are drawn into one
 * Graphics, cleared once a frame (index.ts beginFrame).
 */
import type { Graphics } from 'pixi.js';
import { decorOf } from '../../partDecor';
import type { ClientFeatureHost, ShipDrawCtx } from '../types';

/** `towed`: the entity id + 1 the server says this ship tows (0: nothing) */
export function drawTether(g: Graphics, ctx: ShipDrawCtx, host: ClientFeatureHost, towed: number): void {
  const { ship, entity, cs, now } = ctx;
  const info = ship.derived.fx?.tow;
  if (!(towed > 0) || !info) return;
  const t = host.entity(towed - 1);
  if (!t) return;
  // From the beam's mouth (its first emitter), in the world
  const geoms = ctx.geometry(ship);
  const part = info.parts[0];
  const nz = part !== undefined && geoms[part] ? decorOf(geoms[part]).nozzles[0] : undefined;
  const [cx, cy] = ship.derived.com;
  const geomAt = part !== undefined && geoms[part] ? geoms[part]!.centroid : ship.derived.com;
  const lx = ((nz?.at[0] ?? geomAt[0]) - cx) * cs, ly = ((nz?.at[1] ?? geomAt[1]) - cy) * cs;
  const a = entity.renderAngle + Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
  const x0 = entity.renderX + lx * c - ly * s, y0 = entity.renderY + lx * s + ly * c;
  const x1 = t.renderX, y1 = t.renderY;
  const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy);
  if (d < 1) return;
  // A little sag (perpendicular), less the more it's stretched
  const sag = Math.max(0, 40 - d * 0.04), mx = (x0 + x1) / 2 - (dy / d) * sag, my = (y0 + y1) / 2 + (dx / d) * sag;
  g.moveTo(x0, y0).quadraticCurveTo(mx, my, x1, y1).stroke({ width: cs * 0.22, color: 0xfacc15, alpha: 0.18 });
  g.moveTo(x0, y0).quadraticCurveTo(mx, my, x1, y1).stroke({ width: cs * 0.07, color: 0xfde68a, alpha: 0.85 });
  // Pulses running in towards the ship
  for (let i = 0; i < 3; i++) {
    const u = 1 - (((now / 700) + i / 3) % 1);
    const px = (1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * mx + u * u * x1, py = (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * my + u * u * y1;
    g.circle(px, py, cs * 0.14).fill({ color: 0xfff7cc, alpha: 0.8 });
  }
  g.circle(x1, y1, cs * 0.3).stroke({ width: cs * 0.06, color: 0xfacc15, alpha: 0.6 });
}
