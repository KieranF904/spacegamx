/**
 * Live looks for the power parts (rework 2026-11 section 5), drawn additively over the hull in each ship's own container,
 * one Graphics per ship that has any such part (nothing is made for a ship without):
 *
 *   Cell Reactor      cyan core, pulsing; flickers red below 30% HP (a "shoot me" tell)
 *   Isotope Pile      dull green, slow and calm
 *   Fusion Plant      white-gold core inside a slowly turning ring; red flicker when damaged
 *   Overclock Reactor fast, jittery red-white pulse
 *   Battery           a green charge bar (the ship pool's charge)
 *   Heavy Bank        four dim bars that fill one after another
 *   Capacitor         amber straps to the parts it feeds; an arc to them while it's discharging
 *   Drive Cell        the same in blue
 *   Pulse Dynamo      a violet ring spinning, with small arcs to the bank it charges
 *   Rustjaw's Hive    a honeycomb of seven cells, one lit per clip round held; the next to regrow breathes
 *
 * Charge is only known for your own ship (the pilot row: state.charge); other ships show their parts full. The banks'
 * glow by charge on the parts themselves is ShipRenderer.drawBankGlow.
 */

import { Graphics, type Container } from 'pixi.js';
import type { Charge, PlacedGeom, ShipState } from '@space-game/common';
import './utilityLooks';

type Kind = 'coil' | 'heavycoil' | 'cell' | 'pile' | 'fusion' | 'overclock' | 'battery' | 'bank' | 'cap' | 'drive' | 'dynamo' | 'hive';
const KINDS: Record<string, Kind> = {
  utility_jump_coil: 'coil', utility_heavy_coil: 'heavycoil', power_cell_reactor: 'cell', power_isotope_pile: 'pile', power_fusion_plant: 'fusion', power_overclock_reactor: 'overclock',
  power_battery: 'battery', power_heavy_bank: 'bank', power_capacitor: 'cap', power_drive_cell: 'drive', power_pulse_dynamo: 'dynamo', legendary_hive: 'hive',
};

interface Item { i: number; kind: Kind; x: number; y: number; r: number; seed: number; w: number; h: number }
interface View { g: Graphics; ship: ShipState | null; rebuilds: number; items: Item[]; lastB: number[]; arcUntil: number[]; visible: boolean }

const AMBER = 0xf59e0b, BLUE = 0x3b82f6, VIOLET = 0xb57cff, RED = 0xff3b30;

/** Is a flicker "on" this moment (fast, irregular) */
const flick = (t: number, seed: number): boolean => Math.sin(t * 0.083 + seed) * Math.sin(t * 0.047 + seed * 1.7) > -0.25;

export class PartFx {
  private views = new WeakMap<Container, View>();

  /**
   * `before`: the child of `c` to draw under (the guns); `charge`: your own charge, else null. `now`: ms
   */
  draw(c: Container, before: Container, ship: ShipState, geoms: PlacedGeom[], cs: number, now: number, charge: Charge | null): void {
    let v = this.views.get(c);
    if (!v) {
      const g = new Graphics();
      g.blendMode = 'add';
      v = { g, ship: null, rebuilds: -1, items: [], lastB: [], arcUntil: [], visible: false };
      this.views.set(c, v);
    }
    if (ship !== v.ship || ship.rebuilds !== v.rebuilds) {
      v.ship = ship; v.rebuilds = ship.rebuilds;
      const [cx, cy] = ship.derived.com;
      v.items = [];
      ship.blueprint.parts.forEach((p, i) => {
        const kind = KINDS[p.fn], geom = geoms[i];
        if (!kind || !geom) return;
        const k = Math.sqrt(Math.max(1, geom.area));
        v!.items.push({ i, kind, x: (geom.centroid[0] - cx) * cs, y: (geom.centroid[1] - cy) * cs, r: k * cs * 0.3, seed: i * 1.37, w: 0.5 * k * cs, h: 0.3 * k * cs });
      });
      const want = v.items.length > 0;
      if (want && !v.g.parent) c.addChildAt(v.g, Math.max(0, c.getChildIndex(before)));
      v.g.visible = want;
    }
    if (!v.items.length || ship.kind !== 'ship') { if (v.g.visible) { v.g.visible = false; v.g.clear(); } return; }
    v.g.visible = true;
    const g = v.g.clear(), t = now / 1000, d = ship.derived;
    const byPart = (i: number): Item | undefined => { for (const it of v!.items) if (it.i === i) return it; return undefined; };
    const pool = charge ? Math.max(0, Math.min(1, charge.g / 100)) : 0.85;

    for (const it of v.items) {
      if (!d.alive[it.i]) continue;
      const frac = ship.maxHp[it.i] > 0 ? ship.hp[it.i] / ship.maxHp[it.i] : 1;
      const { x, y, r, seed } = it;
      switch (it.kind) {
        case 'cell': {
          const low = frac < 0.3, on = !low || flick(now, seed);
          const p = 0.5 + 0.5 * Math.sin(t * 3.2 + seed);
          const col = low ? RED : 0x22d3ee;
          if (on) { g.circle(x, y, r * (1.05 + 0.3 * p)).fill({ color: col, alpha: 0.2 + 0.22 * p }); g.circle(x, y, r * 0.5).fill({ color: low ? 0xffb4a8 : 0xcffafe, alpha: 0.55 }); }
          break;
        }
        case 'pile': {
          const p = 0.5 + 0.5 * Math.sin(t * 0.9 + seed);
          g.circle(x, y, r * (1.0 + 0.12 * p)).fill({ color: 0x4d7c3a, alpha: 0.2 + 0.08 * p });
          g.circle(x, y, r * 0.45).fill({ color: 0x9bd36a, alpha: 0.28 });
          break;
        }
        case 'fusion': {
          const low = frac < 0.5, on = !low || flick(now, seed);
          const a = t * 0.7 + seed;
          g.circle(x, y, r * 0.8).fill({ color: on && low ? RED : 0xffe9a8, alpha: on ? 0.3 : 0.08 });
          g.circle(x, y, r * 0.4).fill({ color: low && on ? 0xffc0b0 : 0xffffff, alpha: on ? 0.6 : 0.2 });
          // the slow-turning ring: three arcs
          for (let k = 0; k < 3; k++) arcAt(g, x, y, r * 1.35, a + k * 2.094, a + k * 2.094 + 1.15).stroke({ color: low && on ? RED : 0xfde68a, width: Math.max(1.2, cs * 0.07), alpha: 0.7 });
          break;
        }
        case 'overclock': {
          const j = Math.sin(t * 31 + seed) * Math.sin(t * 17.3 + seed * 2);
          const p = 0.5 + 0.5 * j;
          g.circle(x + j * r * 0.1, y - j * r * 0.08, r * (1.0 + 0.5 * p)).fill({ color: 0xff3b2a, alpha: 0.18 + 0.3 * p });
          g.circle(x, y, r * (0.35 + 0.2 * p)).fill({ color: 0xfff1ee, alpha: 0.4 + 0.5 * p });
          break;
        }
        case 'battery': {
          const w = it.w, h = it.h * 0.5;
          g.rect(x - w / 2, y - h / 2, w * pool, h).fill({ color: 0x4ade80, alpha: 0.85 });
          g.rect(x - w / 2 - 1, y - h / 2 - 1, w * pool + 2, h + 2).fill({ color: 0x4ade80, alpha: 0.18 });
          break;
        }
        case 'bank': {
          const w = it.w, bw = w / 4.6;
          for (let k = 0; k < 4; k++) {
            const fill = Math.max(0, Math.min(1, pool * 4 - k));
            const bx = x - w / 2 + k * (bw + (w - bw * 4) / 3), bh = it.h * 0.8;
            g.rect(bx, y - bh / 2, bw, bh).fill({ color: 0x2f7a4f, alpha: 0.12 });
            if (fill > 0) g.rect(bx, y + bh / 2 - bh * fill, bw, bh * fill).fill({ color: 0x3f9d63, alpha: 0.55 });
          }
          break;
        }
        case 'coil':
        case 'heavycoil': {
          // Coil rings: a pale pulse; the heavy coil's are double and thicker
          const p = 0.5 + 0.5 * Math.sin(t * 1.6 + seed), heavy = it.kind === 'heavycoil';
          g.circle(x, y, r * 1.1).stroke({ color: 0x9fd4ff, width: Math.max(1.2, cs * (heavy ? 0.1 : 0.06)), alpha: 0.2 + 0.2 * p });
          if (heavy) g.circle(x, y, r * 0.65).stroke({ color: 0xc8e6ff, width: Math.max(1.4, cs * 0.12), alpha: 0.28 + 0.25 * (1 - p) });
          break;
        }
        case 'dynamo': {
          const a = t * 2.4 + seed;
          for (let k = 0; k < 2; k++) arcAt(g, x, y, r * 1.2, a + k * Math.PI, a + k * Math.PI + 1.7).stroke({ color: VIOLET, width: Math.max(1.4, cs * 0.08), alpha: 0.85 });
          g.circle(x, y, r * 0.5).fill({ color: VIOLET, alpha: 0.3 });
          break;
        }
        case 'hive': {
          // Seven hex cells (one in the middle, six round it); each lit cell is a round held. A ship whose rounds we do
          // not know (another pilot's) shows them full
          const w = d.weapons.find((x) => x.part === it.i), clip = Math.max(1, w?.fire.clip ?? 8), held = w ? ship.rounds[it.i] ?? clip : clip;
          const lit = Math.max(0, Math.min(1, held / clip)) * 7, cr = r * 0.62, step = cr * 1.78;
          for (let k = 0; k < 7; k++) {
            const cx = k ? x + Math.cos((k - 1) * 1.0472 + 0.5236) * step : x, cy = k ? y + Math.sin((k - 1) * 1.0472 + 0.5236) * step : y;
            const on = lit >= k + 1, next = !on && lit > k;
            const a = on ? 0.55 + 0.12 * Math.sin(t * 2 + k) : next ? 0.12 + 0.4 * (lit % 1) + 0.15 * Math.sin(t * 6) : 0.05;
            g.poly(hexPoints(cx, cy, cr * 0.82)).fill({ color: on ? 0xffb42a : 0xff9a3c, alpha: a });
            if (on) g.circle(cx, cy, cr * 0.28).fill({ color: 0xfff1c8, alpha: 0.6 });
          }
          break;
        }
        default: break;
      }
    }

    // Banks: straps to what they feed (a faint line, brighter with charge), an arc while one's discharging
    const L = d.power;
    if (L && L.banks.length) {
      for (let k = 0; k < L.banks.length; k++) {
        const B = L.banks[k], col = B.kind === 'drive' ? BLUE : AMBER;
        const pct = charge ? Math.max(0, Math.min(1, (charge.b[k] ?? 100) / 100)) : 1;
        const last = v.lastB[k];
        if (charge) {
          if (last !== undefined && (charge.b[k] ?? 100) < last - 0.05) v.arcUntil[k] = now + 260;
          v.lastB[k] = charge.b[k] ?? 100;
        }
        const from = B.parts.length ? byPart(B.parts[0]) : undefined;
        if (from) {
          const arcing = (v.arcUntil[k] ?? 0) > now;
          for (let n = 0, nn = B.feeds.length + B.shields.length; n < nn; n++) {
            const fi = n < B.feeds.length ? B.feeds[n] : B.shields[n - B.feeds.length];
            const to = byPartOrCentroid(v.items, geoms, d.com, cs, fi);
            if (!to) continue;
            g.moveTo(from.x, from.y).lineTo(to[0], to[1]).stroke({ color: col, width: Math.max(1.2, cs * 0.06), alpha: 0.08 + 0.3 * pct });
            if (arcing) jag(g, from.x, from.y, to[0], to[1], now, fi, col, cs);
          }
        }
        // the Dynamos charging it
        if (from && (!charge || pct < 0.999)) {
          for (const di of B.dynamos) {
            const dy = byPart(di);
            if (!dy || !d.alive[di] || Math.floor(now / 140 + di) % 3 === 0) continue;
            jag(g, dy.x, dy.y, from.x, from.y, now, di, VIOLET, cs);
          }
        }
      }
    }
  }
}

/**
 * An arc of its own: moved to its start first. Pixi carries a path on from the last point of the shape before it (a
 * stroke or fill leaves the pen there), so a bare arc() is joined to whatever was drawn last by a straight line (the
 * Fusion Plant's ring trailed a line off to the other plant, or wherever the pen had been).
 */
export function arcAt(g: Graphics, x: number, y: number, r: number, a0: number, a1: number): Graphics {
  return g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r).arc(x, y, r, a0, a1);
}

const HEX = new Array<number>(12).fill(0);
/** A hexagon's corners (a reused array: pass it straight on) */
function hexPoints(x: number, y: number, r: number): number[] {
  for (let i = 0; i < 6; i++) { HEX[i * 2] = x + Math.cos(i * 1.0472) * r; HEX[i * 2 + 1] = y + Math.sin(i * 1.0472) * r; }
  return HEX;
}

/** A consumer's centroid in the ship's frame */
function byPartOrCentroid(items: Item[], geoms: PlacedGeom[], com: [number, number], cs: number, i: number): [number, number] | null {
  for (const it of items) if (it.i === i) return [it.x, it.y];
  const g = geoms[i];
  return g ? [(g.centroid[0] - com[0]) * cs, (g.centroid[1] - com[1]) * cs] : null;
}

/** A short jagged bolt, its shape fixed for ~50 ms at a time */
function jag(g: Graphics, x0: number, y0: number, x1: number, y1: number, now: number, seed: number, color: number, cs: number): void {
  const bucket = Math.floor(now / 50), dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
  const N = 4;
  g.moveTo(x0, y0);
  for (let s = 1; s < N; s++) {
    const f = s / N, h = Math.sin((bucket * 12.9898 + seed * 78.233 + s * 37.719) * 43758.5453);
    const o = (h - Math.floor(h) - 0.5) * cs * 0.5;
    g.lineTo(x0 + dx * f + nx * o, y0 + dy * f + ny * o);
  }
  g.lineTo(x1, y1).stroke({ color, width: Math.max(1.2, cs * 0.07), alpha: 0.85 });
}
