/**
 * The ship schematic in the top-left HUD, as the ship's status readout: every part drawn by what it is doing.
 * Base tint = HP (destroyed: dashed, empty). Over it, per part (from source.ts `ShipStatus.parts`):
 *   stores   a liquid level rising from the bottom (charge), in the store's colour
 *   weapons  a level for reload / charge / clip (full = ready), clip ticks, a flash on a shot, a lit beam glows
 *   engines  a glow while thrusting (white-hot boosting)
 *   gens     a soft pulse; shields a level glow; short of power: a red pulsing outline; dry / down: dimmed
 * Drawn at the HUD's status rate (10 Hz) into a devicePixelRatio-sized canvas; the screen polygons are cached per
 * geometry, so a frame allocates nothing.
 */

import type { PlacedGeom, ShipState } from '@space-game/common';
import { bounds } from '@space-game/common';
import { functionColor, hpColor, mix, numToCss } from '../../ships/shipColors';
import type { PartStatus, ShipStatus } from './source';

export const LEGEND =
  'Tint: part health (green to red, dashed: lost).\n' +
  'Fill: stored charge, or a gun reloading / charging (full: ready).\n' +
  'Ticks: rounds in the clip.   Flash: a shot.   Glow: thrusting, a lit beam, a generator.\n' +
  'Red pulsing outline: short of power.   Dim: out of ammo or shield down.\n' +
  'Blue filling: the part your fabricator is building (amber: repairing).   Orange dashed: being recycled.';

/** Field work to show (client/src/ships/field/bridge.ts fieldHudMarks): the part being built or repaired (-1: none), how far, and parts being recycled */
export interface SchematicMarks { build: number; k: number; repair: boolean; recycle: ReadonlySet<number> }

const PAD = 5;
const PANEL = 0x0b101b;

export class Schematic {
  readonly canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private dpr = 1;
  private geoms: PlacedGeom[] | null = null;
  private rebuilds = -1;
  /** Per part: screen points (x, y pairs), then its bounding box top and bottom */
  private pts: Float32Array[] = [];
  private top: number[] = [];
  private bot: number[] = [];
  private fnIds: string[] = [];

  constructor(private w: number, private h: number) {
    this.canvas.style.cssText = `display: block; position: static; width: ${w}px; height: ${h}px; pointer-events: auto;`;
    this.canvas.title = LEGEND;
    this.resize();
  }

  private resize(): void {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (dpr === this.dpr && this.canvas.width === Math.round(this.w * dpr)) return;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.geoms = null;
  }

  private layout(ship: ShipState, geoms: PlacedGeom[]): void {
    this.geoms = geoms;
    this.rebuilds = ship.rebuilds;
    const b = bounds(geoms.flatMap((g) => g.polygon));
    const { w, h } = this;
    const scale = Math.min((w - PAD * 2) / (b.maxX - b.minX), (h - PAD * 2) / (b.maxY - b.minY));
    const ox = (w - (b.maxX - b.minX) * scale) / 2 - b.minX * scale;
    const oy = (h - (b.maxY - b.minY) * scale) / 2 - b.minY * scale;
    this.pts.length = geoms.length;
    geoms.forEach((g, i) => {
      const a = new Float32Array(g.polygon.length * 2);
      let lo = Infinity, hi = -Infinity;
      g.polygon.forEach(([x, y], k) => {
        a[k * 2] = ox + x * scale;
        a[k * 2 + 1] = oy + y * scale;
        lo = Math.min(lo, a[k * 2 + 1]); hi = Math.max(hi, a[k * 2 + 1]);
      });
      this.pts[i] = a; this.top[i] = lo; this.bot[i] = hi;
      this.fnIds[i] = ship.blueprint.parts[i]?.fn ?? '';
    });
  }

  private path(i: number): void {
    const { ctx } = this, a = this.pts[i];
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    for (let k = 2; k < a.length; k += 2) ctx.lineTo(a[k], a[k + 1]);
    ctx.closePath();
  }

  draw(ship: ShipState, geoms: PlacedGeom[], st: ShipStatus, nowMs: number, marks: SchematicMarks | null = null): void {
    this.resize();
    if (this.geoms !== geoms || this.rebuilds !== ship.rebuilds) this.layout(ship, geoms);
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const t = nowMs / 1000;
    const parts = st.has ? st.parts : null;
    for (let i = 0; i < geoms.length; i++) {
      const gone = ship.detached[i] || ship.hp[i] <= 0;
      const ps: PartStatus | undefined = parts?.[i];
      this.path(i);
      if (gone) {
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
        ctx.setLineDash([2, 2]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
        if (marks?.build === i) this.building(i, marks);
        continue;
      }
      const hpc = hpColor(ship.hp[i] / ship.maxHp[i]);
      const tracked = !!ps && ps.fill >= 0;
      // Base: HP tint (darker under a level so the liquid reads against it)
      // (Plain hull and armour recede, so the parts doing something stand out)
      const plain = !ps || ps.kind === 'none';
      ctx.fillStyle = numToCss(tracked ? mix(hpc, PANEL, 0.62) : plain ? mix(hpc, PANEL, 0.3) : hpc);
      ctx.globalAlpha = tracked ? 1 : 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (ps) this.overlay(i, ps, t);
      this.path(i);
      ctx.strokeStyle = 'rgba(10, 14, 24, 0.9)';
      ctx.lineWidth = 1; ctx.stroke();
      if (ps?.brown) {
        this.path(i);
        ctx.strokeStyle = `rgba(255, 70, 70, ${0.55 + 0.45 * Math.sin(t * 9)})`;
        ctx.lineWidth = 1.8; ctx.stroke();
      }
      if (marks?.build === i) this.building(i, marks);
      if (marks?.recycle.has(i)) {
        this.path(i);
        ctx.strokeStyle = 'rgba(251, 146, 60, 0.95)';
        ctx.setLineDash([2, 2]); ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }

  /** The part being built (or repaired) fills from the bottom as the job goes */
  private building(i: number, m: SchematicMarks): void {
    const { ctx } = this, lvl = Math.max(0, Math.min(1, m.k)), y = this.bot[i] - lvl * (this.bot[i] - this.top[i]);
    ctx.save();
    this.path(i); ctx.clip();
    ctx.fillStyle = m.repair ? 'rgba(251, 191, 36, 0.7)' : 'rgba(56, 189, 248, 0.75)';
    ctx.fillRect(0, y, this.w, this.bot[i] - y + 1);
    ctx.restore();
    this.path(i);
    ctx.strokeStyle = m.repair ? 'rgba(253, 230, 138, 0.95)' : 'rgba(186, 230, 253, 0.95)';
    ctx.lineWidth = 1.2; ctx.stroke();
  }

  private overlay(i: number, ps: PartStatus, t: number): void {
    const { ctx } = this;
    const fn = ps.kind;
    const col = functionColor(this.fnOf(i));
    if (ps.fill >= 0) {
      const lvl = Math.max(0, Math.min(1, ps.fill));
      const y = this.bot[i] - lvl * (this.bot[i] - this.top[i]);
      ctx.save();
      this.path(i); ctx.clip();
      const liquid = fn === 'store' ? mix(col, 0xffffff, 0.3) : fn === 'shield' ? 0x7fb4ff : mix(col, 0xffffff, 0.12);
      ctx.fillStyle = numToCss(liquid);
      ctx.globalAlpha = ps.dim ? 0.3 : fn === 'shield' ? 0.55 : 0.92;
      ctx.fillRect(0, y, this.w, this.bot[i] - y + 1);
      if (lvl > 0.02 && lvl < 0.98) {
        ctx.globalAlpha = 0.9; ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, y - 0.5, this.w, 1);
      }
      if (ps.clip > 1 && ps.clip <= 12) {
        // Clip ticks: a dark line between rounds
        ctx.globalAlpha = 0.8; ctx.fillStyle = numToCss(PANEL);
        const hgt = this.bot[i] - this.top[i];
        for (let k = 1; k < ps.clip; k++) ctx.fillRect(0, this.bot[i] - (hgt * k) / ps.clip - 0.4, this.w, 0.8);
      }
      ctx.restore();
    }
    let glow = ps.glow;
    if (fn === 'gen') glow = 0.28 + 0.14 * Math.sin(t * 4 + i);
    if (glow > 0 || ps.flash > 0) {
      this.path(i);
      if (fn === 'engine') ctx.fillStyle = glow > 0.8 ? 'rgba(255, 230, 190, 1)' : 'rgba(150, 210, 255, 1)';
      else if (fn === 'gen') ctx.fillStyle = 'rgba(255, 190, 80, 1)';
      else ctx.fillStyle = 'rgba(255, 235, 210, 1)';
      ctx.globalAlpha = Math.min(1, fn === 'gen' ? glow : Math.max(glow * 0.7, ps.flash));
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (ps.dim && ps.fill < 0) { this.path(i); ctx.fillStyle = 'rgba(8, 12, 22, 0.55)'; ctx.fill(); }
  }

  private fnOf(i: number): string { return this.fnIds[i] ?? ''; }
}
