/**
 * The weapon ring round the crosshair (docs/design/rework-2026-11.md §3.4): one arc segment per gun group (a model),
 * all predicted from your own gun state (ships/gunHud.ts). On a segment:
 *   clip pips        round dots along the arc, one a round; grey while a reload waits on power, a sweep while it runs
 *   charge arc       fills as a charge gun charges, flashes white at full and after the shot; cooldown drains dim
 *   ammo count       the rounds left in the open crate (red when out), by the segment
 *   spin arc         a thin inner arc for a spinning gun
 *   bank bar         a thin arc outside the segment when a Capacitor bank feeds the group
 * Cycle and beam guns show a plain readiness arc. A transparent canvas that follows the mouse; nothing in it is
 * allocated per frame.
 */

import type { RingGroup } from '../ships/gunHud';

const SIZE = 150, C = SIZE / 2;
const R = 36;
const GAP = 0.16;
/** Most pips drawn on a segment (a bigger clip is drawn scaled down to this many) */
const MAX_PIPS = 14;
const TAU = Math.PI * 2;

/** A segment's accent, by firing model */
const ACCENT: Record<string, string> = {
  clip: '#fbbf24', charge: '#f87171', ammo: '#9ca3af', beam: '#67e8f9', cycle: '#93c5fd', auto: '#a7f3d0',
};

export class WeaponRing {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private shown = false;
  private sweep = 0;

  constructor() {
    const c = document.createElement('canvas');
    this.canvas = c;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = Math.round(SIZE * dpr);
    c.style.cssText = `position: fixed; left: 0; top: 0; width: ${SIZE}px; height: ${SIZE}px; z-index: 850; pointer-events: none; display: none;`;
    this.ctx = c.getContext('2d');
    this.ctx?.scale(dpr, dpr);
    document.body.appendChild(c);
  }

  /** Draw the ring at the cursor (x, y in CSS pixels); hidden when `show` is false or there is nothing to show */
  update(groups: readonly RingGroup[], x: number, y: number, show: boolean): void {
    const ctx = this.ctx;
    const on = show && !!ctx && groups.length > 0;
    if (on !== this.shown) { this.shown = on; this.canvas.style.display = on ? 'block' : 'none'; }
    if (!on || !ctx) return;
    this.canvas.style.transform = `translate(${Math.round(x - C)}px, ${Math.round(y - C)}px)`;
    this.sweep = (this.sweep + 0.12) % TAU;
    ctx.clearRect(0, 0, SIZE, SIZE);
    const n = groups.length, span = TAU / n;
    for (let i = 0; i < n; i++) {
      // Segment i starts at the top and runs clockwise
      const a0 = -Math.PI / 2 + i * span + GAP / 2, a1 = -Math.PI / 2 + (i + 1) * span - GAP / 2;
      this.segment(ctx, groups[i], a0, n === 1 ? a0 + TAU - GAP : a1);
    }
  }

  private segment(ctx: CanvasRenderingContext2D, g: RingGroup, a0: number, a1: number): void {
    const accent = ACCENT[g.model] ?? '#93c5fd';
    const arc = (r: number, from: number, to: number, color: string, width: number, alpha = 1): void => {
      if (to <= from) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(C, C, r, from, to);
      ctx.stroke();
    };
    const mid = (a0 + a1) / 2;
    // The track
    arc(R, a0, a1, '#0b1220', 4.5, 0.35);
    const len = a1 - a0;
    if (g.model === 'clip') {
      this.pips(ctx, g, a0, a1);
    } else if (g.model === 'charge' || (g.model === 'beam' && g.charge > 0)) {
      // Fills as it charges; white at full and for a moment after the shot
      if (g.cooling > 0 && g.charge <= 0) arc(R, a0, a0 + len * (1 - g.cooling), '#64748b', 3, 0.7);
      arc(R, a0, a0 + len * g.charge, g.flash > 0 ? '#ffffff' : accent, 3.5 + g.flash * 1.5, 0.95);
      if (g.flash > 0) arc(R, a0, a1, '#ffffff', 7, g.flash * 0.4);
    } else {
      arc(R, a0, a0 + len * g.ready, accent, 2.5, g.ready >= 1 ? 0.9 : 0.5);
    }
    // The spin arc: thin, inside
    if (g.spin > 0.005) arc(R - 6, a0, a0 + len * g.spin, '#fde68a', 1.6, 0.9);
    // The bank bar: thin, outside
    if (g.bank >= 0) {
      arc(R + 6, a0, a1, '#fbbf24', 1.5, 0.18);
      arc(R + 6, a0, a0 + len * g.bank, g.bank < 0.12 ? '#ef4444' : '#fbbf24', 1.5, 0.85);
    }
    // The ammo count, outside the segment's middle (red when out)
    if (g.ammo >= 0) {
      const tx = C + Math.cos(mid) * (R + 15), ty = C + Math.sin(mid) * (R + 15);
      ctx.globalAlpha = 1;
      ctx.font = "700 10px 'Segoe UI', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = g.ammo > 0 || g.crates > 0 ? '#e5e7eb' : '#f87171';
      ctx.fillText(g.ammo > 0 || g.crates > 0 ? String(g.ammo) : '0', tx, ty);
    }
    ctx.globalAlpha = 1;
  }

  /** Clip pips along the arc: lit for each round, grey (not lit) while a reload waits on power, sweeping while it runs */
  private pips(ctx: CanvasRenderingContext2D, g: RingGroup, a0: number, a1: number): void {
    const total = Math.max(1, g.clip), shown = Math.min(MAX_PIPS, total);
    const full = Math.round((g.rounds / total) * shown);
    const r = shown > 10 ? 1.8 : 2.4;
    for (let k = 0; k < shown; k++) {
      const a = shown === 1 ? (a0 + a1) / 2 : a0 + ((a1 - a0) * k) / (shown - 1);
      const lit = k < full;
      ctx.globalAlpha = 1;
      ctx.fillStyle = lit ? ACCENT.clip : g.starved ? '#6b7280' : '#334155';
      if (g.reloading && !lit && !g.starved) {
        // A reload running: the empty pips breathe in sequence
        ctx.globalAlpha = 0.35 + 0.35 * Math.max(0, Math.cos(this.sweep - k * 0.5));
        ctx.fillStyle = '#fde68a';
      } else if (!lit) ctx.globalAlpha = g.starved ? 0.9 : 0.6;
      ctx.beginPath();
      ctx.arc(C + Math.cos(a) * R, C + Math.sin(a) * R, r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  dispose(): void {
    this.canvas.remove();
  }
}
