/**
 * A bespoke hull's frame (its core piece's `frame`): the metal skeleton under
 * the whole hull, drawn beneath it, so it's seen only where plating has been
 * shot away. In the ship's own frame (centred on its centre of mass, cells ×
 * cell size), as two lit meshes:
 *
 *   cold  each girder a pair of bevelled rails with a zigzag of struts between
 *         them, a bolted gusset plate where girders meet: dark gunmetal
 *   hot   the same rails' and gussets' inner lines, glowing (it's shown as
 *         the frame heats: a boss's later stage)
 */

import type { PieceFrame, Vec2 } from '@space-game/common';
import { LitGeometry } from '../rendering/lighting/LitGeometry';

const RAIL = 0x4a4f58, RAIL_EDGE = 0x666c77, STRUT = 0x383c44, GUSSET = 0x50555f, GUSSET_EDGE = 0x737a86, BOLT = 0x8a909b;
const HOT = 0xff7a2a, HOT_CORE = 0xffd6a0;

export function buildFrame(frame: PieceFrame, com: Vec2, cs: number): { cold: LitGeometry; hot: LitGeometry } {
  const cold = new LitGeometry(), hot = new LitGeometry();
  const at = (x: number, y: number): Vec2 => [(x - com[0]) * cs, (y - com[1]) * cs];
  for (const [x0, y0, x1, y1, wc] of frame.beams) {
    const [ax, ay] = at(x0, y0), [bx, by] = at(x1, y1);
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1) continue;
    const ux = (bx - ax) / len, uy = (by - ay) / len, nx = -uy, ny = ux;
    const w = wc * cs, rail = Math.max(3, w * 0.2), half = w / 2 - rail / 2;
    // The two rails
    for (const s of [-1, 1]) {
      const ox = nx * half * s, oy = ny * half * s;
      cold.bar(ax + ox, ay + oy, bx + ox, by + oy, rail, RAIL, { bevel: rail * 0.35, edge: RAIL_EDGE });
      hot.bar(ax + ox, ay + oy, bx + ox, by + oy, rail * 0.35, HOT, { glow: 1 });
    }
    // A zigzag of struts between them
    const step = Math.max(w * 1.1, 10), n = Math.max(1, Math.floor(len / step));
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * len, t1 = ((i + 1) / n) * len, s0 = i % 2 ? 1 : -1;
      cold.bar(ax + ux * t0 + nx * half * s0, ay + uy * t0 + ny * half * s0, ax + ux * t1 - nx * half * s0, ay + uy * t1 - ny * half * s0, rail * 0.6, STRUT, { bevel: rail * 0.2, edge: RAIL });
    }
  }
  // Gussets: a bolted plate where girders meet
  for (const [x, y, rc] of frame.nodes) {
    const [cx, cy] = at(x, y), r = rc * cs * 0.6;
    const pts: number[] = [];
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + Math.PI / 6; pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    cold.panel(pts, GUSSET, { bevel: r * 0.25, edge: GUSSET_EDGE });
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; cold.disc(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62, Math.max(1.5, r * 0.09), BOLT, {}, 6); }
    hot.disc(cx, cy, r * 0.42, HOT_CORE, { glow: 1 }, 6);
    hot.disc(cx, cy, r * 0.7, HOT, { glow: 1 }, 6);
  }
  return { cold, hot };
}
