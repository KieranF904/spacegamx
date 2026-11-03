/**
 * Hostiles at night, so they read as more than headlights: four corner
 * brackets round each in its role's colour, its role's glyph above it (sapper,
 * runner, artillery, escort; the boss a crown), the same size on screen at any
 * zoom; and a cyan reticle on the hostile the turrets are focused on. Drawn
 * over the ships (BastionView.top), one Graphics redrawn each frame.
 */

import { Graphics } from 'pixi.js';
import { EntityType, type ServerSiegeStateMessage } from '@space-game/common';
import { hostileLook, type Glyph } from './siegeLook';

export interface MarkEntity { id: number; type: number; data?: number[]; name?: string; renderX: number; renderY: number }
/** The world on screen: the camera (x, y) and the half extents of the box round the turned view */
export interface ViewBox { x: number; y: number; hw: number; hh: number }

type Draw = (g: Graphics, x: number, y: number, s: number, c: number, sn: number, color: number, a: number) => void;
/** Each glyph, `s` its half size, (c, sn) the screen's upright turn */
const GLYPHS: Record<Glyph, Draw> = {
  dot: (g, x, y, s, _c, _sn, color, a) => { g.circle(x, y, s * 0.45).fill({ color, alpha: a }); },
  diamond: (g, x, y, s, c, sn, color, a) => { g.poly(turn([0, -s, s * 0.8, 0, 0, s, -s * 0.8, 0], x, y, c, sn)).fill({ color, alpha: a }); },
  chevron: (g, x, y, s, c, sn, color, a) => {
    for (const o of [-0.45, 0.35]) g.poly(turn([-s, (o - 0.5) * s, 0, (o + 0.3) * s, s, (o - 0.5) * s, s, (o - 0.1) * s, 0, (o + 0.7) * s, -s, (o - 0.1) * s], x, y, c, sn)).fill({ color, alpha: a });
  },
  cross: (g, x, y, s, c, sn, color, a) => {
    g.circle(x, y, s * 0.8).stroke({ color, width: s * 0.28, alpha: a });
    g.poly(turn([-s * 0.12, -s * 1.1, s * 0.12, -s * 1.1, s * 0.12, s * 1.1, -s * 0.12, s * 1.1], x, y, c, sn)).fill({ color, alpha: a });
    g.poly(turn([-s * 1.1, -s * 0.12, s * 1.1, -s * 0.12, s * 1.1, s * 0.12, -s * 1.1, s * 0.12], x, y, c, sn)).fill({ color, alpha: a });
  },
  shield: (g, x, y, s, c, sn, color, a) => { g.poly(turn([-s * 0.85, -s * 0.9, s * 0.85, -s * 0.9, s * 0.85, 0, 0, s, -s * 0.85, 0], x, y, c, sn)).fill({ color, alpha: a }); },
  crown: (g, x, y, s, c, sn, color, a) => {
    g.poly(turn([-s * 1.2, s * 0.6, -s * 1.2, -s * 0.6, -s * 0.6, 0, 0, -s, s * 0.6, 0, s * 1.2, -s * 0.6, s * 1.2, s * 0.6], x, y, c, sn)).fill({ color, alpha: a });
  },
};

/** The brackets' four corners */
const CORNERS: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/** Local points (x right, y down on screen) turned upright on screen and placed at (x, y) */
function turn(pts: number[], x: number, y: number, c: number, sn: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push(x + c * pts[i] - sn * pts[i + 1], y + sn * pts[i] + c * pts[i + 1]);
  return out;
}

export class SiegeMarks {
  readonly g = new Graphics();
  private t = 0;

  /**
   * `night` 0..1 (marks fade in after dusk), `zoom` the camera's, `angle` its turn (marks stay upright); (ox, oy) this
   * Graphics' place in the world (the bastion's); `view` the world box on screen (camera and half extents): hostiles
   * whose marks would fall wholly outside it aren't drawn (a night's hostiles spread round the moon, most off screen)
   */
  update(dt: number, entities: Iterable<MarkEntity>, msg: ServerSiegeStateMessage | null, night: number, zoom: number, angle: number, tick: number, ox = 0, oy = 0, view?: ViewBox): void {
    this.t += dt;
    const g = this.g;
    g.clear();
    const show = Math.max(0, Math.min(1, (night - 0.25) / 0.5));
    if (!msg || show <= 0) return;
    const px = 1 / Math.max(0.05, zoom), c = Math.cos(angle), sn = Math.sin(angle);
    const focus = msg.focus?.target !== undefined && (msg.focus.until ?? 0) > tick ? msg.focus.target : -1;
    // (the most a mark reaches from its hostile: the boss's bracket, its glyph above and the focus reticle round it)
    const reach = Math.max(30 * px, 150) + 30 * px;
    for (const e of entities) {
      if (e.type !== EntityType.ShipBody || e.data?.[0] !== 3) continue;
      if (view && (Math.abs(e.renderX - view.x) > view.hw + reach || Math.abs(e.renderY - view.y) > view.hh + reach)) continue;
      const look = hostileLook(e.name, msg.tonight);
      const r = Math.max((look.boss ? 30 : 19) * px, look.boss ? 150 : 70), arm = r * 0.45, w = 2.2 * px, a = 0.85 * show, x = e.renderX - ox, y = e.renderY - oy;
      // The four brackets as one stroke (each its own open subpath: the same lines, one stroke to build, no arrays)
      for (const [sx, sy] of CORNERS) {
        const ax = sx * r, ay = sy * (r - arm), bx = sx * r, by = sy * r, cx = sx * (r - arm), cy = sy * r;
        g.moveTo(x + c * ax - sn * ay, y + sn * ax + c * ay).lineTo(x + c * bx - sn * by, y + sn * bx + c * by).lineTo(x + c * cx - sn * cy, y + sn * cx + c * cy);
      }
      g.stroke({ color: look.color, width: w, alpha: a, join: 'miter' });
      const [gx, gy] = turn([0, -(r + 11 * px)], x, y, c, sn);
      GLYPHS[look.glyph](g, gx, gy, (look.boss ? 8 : 5.5) * px, c, sn, look.color, a);
      if (e.id === focus) {
        const R = r + 9 * px, spin = this.t * 2.2;
        for (let k = 0; k < 4; k++) {
          const a0 = spin + (k * Math.PI) / 2;
          g.moveTo(x + Math.cos(a0) * R, y + Math.sin(a0) * R).arc(x, y, R, a0, a0 + 0.9).stroke({ color: 0x7dd3fc, width: 2.6 * px, alpha: 0.95 });
        }
      }
    }
  }
}
