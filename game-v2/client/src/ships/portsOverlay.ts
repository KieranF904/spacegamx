/**
 * The hangar's energy overlay for a ports design (docs/design/energy-ports-2026-11.md §5): every port drawn at its
 * edge (an out port a filled triangle pointing out, an in port a hollow notch pointing in; amber out, blue in, bright
 * when linked, red open or clashing, orange a generator's wasted line, grey a store's spare), each link a line whose
 * thickness is the E/s it carried in the load test (labelled when zoomed in), each store's fill, and the consumers the
 * load test left short outlined with their share. The part in hand shows its ports and the parts they would link to.
 *
 * Fast on a big ship: the whole layer is drawn once into its own canvas and only blitted while the mouse moves; it is
 * redrawn when the design, the load test's scenario or the view changes. Port states and links come from common
 * (power/portStates.ts), the flows and shares from the load test (power/portsLoadTest.ts); nothing here is a rule.
 */

import type { PlacedGeom, PortPreview, PortsLoadResult, PortsView, ShipDerived, Side, Vec2 } from '@space-game/common';
import { PS_CLASH, PS_LINKED, PS_OPEN, PS_WASTE, SIDE_NORMAL, portsView } from '@space-game/common';
import { portsReport } from './portsReport';

export interface OverlayView { px: number; cx: number; cy: number; w: number; h: number; dpr: number }

/** How deep a glyph reaches into its cell from the edge (cells) */
const DEPTH = 0.2;
const OUT = '#fbbf24', IN = '#60a5fa', RED = '#ef4444', ORANGE = '#fb923c', GREY = '#64748b';
const DARK = 'rgba(3, 5, 10, 0.85)';

/** Where a port's glyph sits (grid units): in its cell, just inside the edge */
export function glyphCentre(x: number, y: number, side: Side): Vec2 {
  const n = SIDE_NORMAL[side], k = 0.5 - DEPTH / 2;
  return [x + 0.5 + n[0] * k, y + 0.5 + n[1] * k];
}
/** The port whose glyph is under a grid point (within `reach` cells), or -1; the nearest wins */
export function portNear(v: PortsView, gx: number, gy: number, reach = 0.28): number {
  let best = -1, bd = reach * reach;
  for (let k = 0; k < v.ports.length; k++) {
    const p = v.ports[k], c = glyphCentre(p.x, p.y, p.side), dx = c[0] - gx, dy = c[1] - gy, d2 = dx * dx + dy * dy;
    if (d2 < bd) { bd = d2; best = k; }
  }
  return best;
}
/** A port's colour by its state and way */
export function portColor(state: number, dir: 0 | 1): string {
  if (state === PS_LINKED) return dir === 1 ? OUT : IN;
  if (state === PS_OPEN || state === PS_CLASH) return RED;
  if (state === PS_WASTE) return ORANGE;
  return GREY;
}
/** The words under the part in hand: which parts its ports would link to, and what stays open or clashes */
export function ghostHint(pv: readonly PortPreview[], name: (i: number) => string): { text: string; tone: 'ok' | 'warn' | 'bad' } | null {
  if (!pv.length) return null;
  const to = [...new Set(pv.filter((p) => p.state === PS_LINKED).map((p) => name(p.to)))];
  const clash = pv.filter((p) => p.state === PS_CLASH).length, waste = pv.filter((p) => p.state === PS_WASTE).length;
  const open = pv.filter((p) => p.state === PS_OPEN).length;
  const bits: string[] = [];
  if (to.length) bits.push(`links to ${to.join(', ')}`);
  if (clash) bits.push(`${clash} clash${clash > 1 ? 'es' : ''}`);
  if (waste) bits.push(`${waste} line${waste > 1 ? 's' : ''} wasted`);
  if (open) bits.push(`${open} in port${open > 1 ? 's' : ''} unfed`);
  if (!bits.length) bits.push('no links yet');
  return { text: bits.join(' · '), tone: clash || (!to.length && (waste || open)) ? 'bad' : waste || open ? 'warn' : 'ok' };
}

type Tx = { sx: (x: number) => number; sy: (y: number) => number; px: number };

/** One port glyph: out a filled triangle pointing out of the part, in a hollow notch pointing in */
function glyph(ctx: CanvasRenderingContext2D, t: Tx, x: number, y: number, side: Side, dir: 0 | 1, color: string, state: number, aug: 0 | 1, scale = 1): void {
  const n = SIDE_NORMAL[side], tx = -n[1], ty = n[0];
  const ex = x + 0.5 + n[0] * 0.5, ey = y + 0.5 + n[1] * 0.5;
  const d = DEPTH * scale, wdt = 0.17 * scale;
  // (out: apex on the edge, base inside; in: base on the edge, apex inside)
  const apex: Vec2 = dir === 1 ? [ex + n[0] * 0.02, ey + n[1] * 0.02] : [ex - n[0] * d, ey - n[1] * d];
  const b0 = dir === 1 ? [ex - n[0] * d, ey - n[1] * d] : [ex - n[0] * 0.02, ey - n[1] * 0.02];
  const A: Vec2 = [t.sx(apex[0]), t.sy(apex[1])], B: Vec2 = [t.sx(b0[0] + tx * wdt), t.sy(b0[1] + ty * wdt)], C: Vec2 = [t.sx(b0[0] - tx * wdt), t.sy(b0[1] - ty * wdt)];
  ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(C[0], C[1]); ctx.closePath();
  const lw = Math.max(1.25, t.px * 0.05);
  if (state === PS_LINKED) {
    // (a linked port glows: a wide soft stroke under it)
    ctx.strokeStyle = color; ctx.globalAlpha = 0.3; ctx.lineWidth = lw * 3.2; ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = DARK; ctx.lineWidth = lw + 2; ctx.stroke();
  if (dir === 1) { ctx.fillStyle = color; ctx.fill(); }
  else { ctx.fillStyle = 'rgba(3, 5, 10, 0.55)'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke(); }
  if (aug) { ctx.fillStyle = '#c084fc'; ctx.beginPath(); ctx.arc((A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, Math.max(1.5, t.px * 0.04), 0, Math.PI * 2); ctx.fill(); }
  if (state === PS_CLASH) {
    const cx = (A[0] + B[0] + C[0]) / 3, cy = (A[1] + B[1] + C[1]) / 3, r = Math.max(2.5, t.px * 0.08);
    ctx.strokeStyle = '#fee2e2'; ctx.lineWidth = Math.max(1.25, lw * 0.8);
    ctx.beginPath(); ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r); ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r); ctx.stroke();
  }
}

function outline(ctx: CanvasRenderingContext2D, t: Tx, g: PlacedGeom): void {
  ctx.beginPath();
  g.polygon.forEach(([x, y], k) => (k ? ctx.lineTo(t.sx(x), t.sy(y)) : ctx.moveTo(t.sx(x), t.sy(y))));
  ctx.closePath();
}

function tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fs: number, color: string, border?: string): void {
  ctx.font = `700 ${fs}px 'Segoe UI', sans-serif`;
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = DARK; ctx.fillRect(x - w / 2, y - fs * 0.7, w, fs * 1.4);
  if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.strokeRect(x - w / 2, y - fs * 0.7, w, fs * 1.4); }
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}

export class PortsOverlay {
  private layer: HTMLCanvasElement | null = null;
  private key = '';
  private forD: ShipDerived | null = null;
  private forR: PortsLoadResult | null = null;
  /** Times the layer was redrawn (a check that it isn't redrawn per mouse move) */
  redraws = 0;

  /** Blit the overlay, redrawing its layer first if the design, the result or the view changed */
  draw(ctx: CanvasRenderingContext2D, d: ShipDerived, geoms: readonly PlacedGeom[], r: PortsLoadResult | null, label: string, v: OverlayView): void {
    if (!d.ports) return;
    const key = `${label}|${v.px}|${v.cx}|${v.cy}|${v.w}|${v.h}|${v.dpr}`;
    const W = Math.round(v.w * v.dpr), H = Math.round(v.h * v.dpr);
    if (!this.layer) this.layer = document.createElement('canvas');
    if (key !== this.key || d !== this.forD || r !== this.forR || this.layer.width !== W || this.layer.height !== H) {
      this.key = key; this.forD = d; this.forR = r;
      if (this.layer.width !== W || this.layer.height !== H) { this.layer.width = W; this.layer.height = H; }
      const lc = this.layer.getContext('2d')!;
      lc.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      lc.clearRect(0, 0, v.w, v.h);
      this.paint(lc, d, geoms, r, label, v);
      this.redraws++;
    }
    ctx.drawImage(this.layer, 0, 0, v.w, v.h);
  }

  private paint(ctx: CanvasRenderingContext2D, d: ShipDerived, geoms: readonly PlacedGeom[], r: PortsLoadResult | null, label: string, v: OverlayView): void {
    const L = d.ports!, pv = portsView(L), t = tx(v), px = v.px;
    const fs = Math.max(9, Math.min(12, Math.round(px * 0.34)));
    // 1. Consumers the routing leaves unfed, and those the load test left short (with the share they settle to)
    const rep = portsReport(L), unfed = new Set(rep.unfed);
    for (let i = 0; i < L.n; i++) {
      const g = geoms[i];
      if (!g) continue;
      const short = r && r.used[i] && r.end[i] < 0.995;
      if (!unfed.has(i) && !short) continue;
      const bad = unfed.has(i) || (r !== null && r.end[i] < 0.5);
      outline(ctx, t, g);
      ctx.fillStyle = bad ? 'rgba(239, 68, 68, 0.16)' : 'rgba(251, 146, 60, 0.13)'; ctx.fill();
      ctx.setLineDash(unfed.has(i) ? [4, 3] : []);
      ctx.strokeStyle = bad ? RED : ORANGE; ctx.lineWidth = 2; ctx.stroke();
      ctx.setLineDash([]);
      const txt = unfed.has(i) ? 'no power' : `${Math.round(r!.end[i] * 100)}%${r!.brownAt[i] > 0.05 ? ` after ${r!.brownAt[i].toFixed(r!.brownAt[i] < 10 ? 1 : 0)}s` : ''}`;
      tag(ctx, txt, t.sx(g.centroid[0]), t.sy(g.centroid[1]), fs, bad ? '#fca5a5' : '#fdba74', bad ? RED : ORANGE);
    }
    // 2. Links: thickness by the E/s each carried in the load test (dim when it carried nothing)
    ctx.lineCap = 'round';
    const labels: [string, number, number, number, number][] = [];
    let tan: Vec2 = [0, 0];
    for (const l of pv.links) {
      const f = r ? r.flow[l.id] : l.cap, u = l.cap > 0 ? Math.min(1, f / l.cap) : 0;
      let x0: number, y0: number, x1: number, y1: number;
      if (l.at) {
        const n = SIDE_NORMAL[l.at.side];
        tan = [-n[1], n[0]];
        x0 = l.at.x + 0.5 - n[0] * 0.15; y0 = l.at.y + 0.5 - n[1] * 0.15; x1 = l.at.x + 0.5 + n[0] * 1.15; y1 = l.at.y + 0.5 + n[1] * 1.15;
      } else {
        const a = geoms[l.from]?.centroid, b = geoms[l.to]?.centroid;
        if (!a || !b) continue;
        [x0, y0, x1, y1] = [a[0], a[1], b[0], b[1]];
        tan = [0, 0];
      }
      const live = f > 0.05;
      const wdt = live ? Math.max(1.5, px * (0.04 + 0.11 * u)) : Math.max(1, px * 0.035);
      ctx.strokeStyle = DARK; ctx.lineWidth = wdt + 2.5;
      ctx.beginPath(); ctx.moveTo(t.sx(x0), t.sy(y0)); ctx.lineTo(t.sx(x1), t.sy(y1)); ctx.stroke();
      ctx.strokeStyle = !live ? GREY : l.aug ? '#c084fc' : u > 0.98 ? '#fde68a' : '#f59e0b';
      ctx.globalAlpha = live ? 0.95 : 0.6; ctx.lineWidth = wdt;
      if (!l.at) ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(t.sx(x0), t.sy(y0)); ctx.lineTo(t.sx(x1), t.sy(y1)); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (r && px >= 22 && live) labels.push([`${f < 10 ? f.toFixed(1) : Math.round(f)}`, (x0 + x1) / 2, (y0 + y1) / 2, tan[0], tan[1]]);
    }
    ctx.lineCap = 'butt';
    // 3. Stores: how full each is at the end of the test
    for (const s of L.relays) {
      const g = geoms[s];
      if (!g) continue;
      const fill = r ? Math.max(0, r.fill[s]) : 1, bw = Math.max(12, px * 0.62), bh = Math.max(5, px * 0.2);
      const cx = t.sx(g.centroid[0]), cy = t.sy(g.centroid[1]) - px * 0.18;
      ctx.fillStyle = DARK; ctx.fillRect(cx - bw / 2 - 2, cy - bh / 2 - 2, bw + 4, bh + 4);
      const col = fill > 0.5 ? '#4ade80' : fill > 0.15 ? '#fbbf24' : '#f87171';
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(cx - bw / 2, cy - bh / 2, bw, bh);
      ctx.fillStyle = col; ctx.fillRect(cx - bw / 2 + 1.5, cy - bh / 2 + 1.5, Math.max(0, (bw - 3) * fill), bh - 3);
    }
    // 4. The ports, then the flow labels on the edges they cross: over the glyph pair zoomed out (the number says it's
    // linked), beside it zoomed in
    for (const p of pv.ports) glyph(ctx, t, p.x, p.y, p.side, p.dir, portColor(p.state, p.dir), p.state, p.aug);
    const lf = Math.max(9, Math.round(px * 0.28));
    ctx.font = `700 ${lf}px 'Segoe UI', sans-serif`;
    for (const [text, x, y, ux, uy] of labels) {
      const off = px >= 40 ? 0.17 * px + ctx.measureText(text).width / 2 + 7 : 0;
      tag(ctx, text, t.sx(x) + ux * off, t.sy(y) + uy * off, lf, '#fde68a');
    }
    // 5. The legend: what's drawn, and which test the flows are from
    const lines = [`ENERGY · ${r ? `${label} test` : 'ports'}`, '▲ out  ▽ in  · line width = E/s carried', 'red: open or clash · orange: wasted · grey: spare'];
    ctx.font = "600 11px 'Segoe UI', sans-serif";
    const lw = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 14, lh = 15, by = v.h - lines.length * lh - 12;
    ctx.fillStyle = 'rgba(7, 11, 20, 0.86)'; ctx.fillRect(10, by - 4, lw, lines.length * lh + 8);
    ctx.strokeStyle = '#2a3a5a'; ctx.lineWidth = 1; ctx.strokeRect(10, by - 4, lw, lines.length * lh + 8);
    lines.forEach((s, k) => { ctx.fillStyle = k ? '#8ea0bd' : '#ffb547'; ctx.fillText(s, 17, by + 11 + k * lh); });
  }

  /** The port under the mouse: a ring round it, its link bright, the part across outlined */
  drawHover(ctx: CanvasRenderingContext2D, d: ShipDerived, geoms: readonly PlacedGeom[], k: number, v: OverlayView): void {
    if (!d.ports) return;
    const pv = portsView(d.ports), p = pv.ports[k], t = tx(v);
    if (!p) return;
    if (p.to >= 0 && geoms[p.to]) { outline(ctx, t, geoms[p.to]); ctx.strokeStyle = p.state === PS_CLASH ? RED : '#22d3ee'; ctx.lineWidth = 2.5; ctx.stroke(); }
    const c = glyphCentre(p.x, p.y, p.side);
    ctx.strokeStyle = '#e5ecf7'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(t.sx(c[0]), t.sy(c[1]), Math.max(6, v.px * 0.24), 0, Math.PI * 2); ctx.stroke();
  }

  /** The part in hand's ports, and the parts they would link to (cyan) or clash with (red) */
  drawGhost(ctx: CanvasRenderingContext2D, geoms: readonly PlacedGeom[], pv: readonly PortPreview[], v: OverlayView): void {
    const t = tx(v);
    for (const p of pv) {
      if (p.to < 0 || !geoms[p.to]) continue;
      outline(ctx, t, geoms[p.to]);
      const link = p.state === PS_LINKED;
      ctx.fillStyle = link ? 'rgba(34, 211, 238, 0.18)' : 'rgba(239, 68, 68, 0.18)'; ctx.fill();
      ctx.strokeStyle = link ? '#22d3ee' : RED; ctx.lineWidth = 2.5; ctx.stroke();
    }
    for (const p of pv) glyph(ctx, t, p.x, p.y, p.side, p.dir, portColor(p.state, p.dir), p.state, p.aug, 1.25);
  }
}

function tx(v: OverlayView): Tx {
  return { sx: (x) => (x - v.cx) * v.px + v.w / 2, sy: (y) => (y - v.cy) * v.px + v.h / 2, px: v.px };
}
