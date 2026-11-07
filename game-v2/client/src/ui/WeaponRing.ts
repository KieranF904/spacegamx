/**
 * The weapon ring round the crosshair (docs/design/rework-2026-11.md §3.4): one arc segment per gun group (a model),
 * all predicted from your own gun state (ships/gunHud.ts). On a segment:
 *   clip pips        round dots along the arc, one a round; grey while a reload waits on power, a sweep while it runs
 *   charge arc       fills as a charge gun charges, flashes white at full and after the shot; cooldown drains dim
 *   ammo count       the rounds left in the open crate (red when out), by the segment
 *   spin arc         a thin inner arc for a spinning gun
 *   bank bar         a thin arc outside the segment when a Capacitor bank feeds the group
 *   beam pieces      a beam in pieces (power/ports.ts): one short arc a piece, lit when whole, the one burning white and
 *                    shrinking, a part-filled one as a dim amber sliver (it can't fire), and the cooldown a thin grey arc inside
 *   mining pulse     a ports ship's mining lasers: the pulse sweeping along the segment, cyan when fully fed and dimming to red
 *                    as its fulfilment drops (the share of its draw it gets), its buffer a thin arc inside
 * Weapon groups (ships/weaponGroups.ts): a group outside both buttons' selected groups is dim, and with a group selected a
 * dot by each segment in the left group shows its state (green ready, amber reloading, red short of power); a small chip under
 * the ring says the selection ("L: 2  R: all"). With both on "all" the ring is as it always was.
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
  /** The alpha scale of the segment being drawn (a dim group) */
  private mul = 1;

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
  update(groups: readonly RingGroup[], x: number, y: number, show: boolean, chip = ''): void {
    const ctx = this.ctx;
    const on = show && !!ctx && groups.length > 0;
    if (on !== this.shown) { this.shown = on; this.canvas.style.display = on ? 'block' : 'none'; }
    if (!on || !ctx) return;
    const tx = Math.round(x - C), ty = Math.round(y - C);
    if (tx !== this.tx || ty !== this.ty) { this.tx = tx; this.ty = ty; this.canvas.style.transform = `translate(${tx}px, ${ty}px)`; }
    this.sweep = (this.sweep + 0.12) % TAU;
    // Redrawn only when what it shows changed (or a reload's pips are breathing): idle guns at the ready draw nothing
    if (!this.changed(groups, chip)) return;
    ctx.clearRect(0, 0, SIZE, SIZE);
    const n = groups.length, span = TAU / n;
    for (let i = 0; i < n; i++) {
      // Segment i starts at the top and runs clockwise
      const a0 = -Math.PI / 2 + i * span + GAP / 2, a1 = -Math.PI / 2 + (i + 1) * span - GAP / 2;
      this.segment(ctx, groups[i], a0, n === 1 ? a0 + TAU - GAP : a1);
    }
    if (chip) {
      ctx.globalAlpha = 0.9;
      ctx.font = "600 10px 'Segoe UI', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(chip, C, C + R + 30);
      ctx.globalAlpha = 1;
    }
  }

  /** The cursor's last place (CSS px) and what the ring last drew from (the groups' drawn fields, in order) */
  private tx = NaN;
  private ty = NaN;
  private drawn: (number | string | boolean)[] = [];

  /** Whether the groups differ from what was last drawn (remembering them if so); always while a reload sweeps */
  private changed(groups: readonly RingGroup[], chip: string): boolean {
    this.at = 0; this.diff = false;
    let sweeping = false;
    this.put(groups.length); this.put(chip);
    for (const g of groups) {
      if (g.reloading && !g.starved) sweeping = true;
      this.put(g.model); this.put(g.clip); this.put(g.rounds); this.put(g.reloading); this.put(g.starved); this.put(g.charge);
      this.put(g.cooling); this.put(g.flash); this.put(g.ready); this.put(g.spin); this.put(g.bank); this.put(g.ammo); this.put(g.crates);
      this.put(g.minePhase < 0 ? -1 : Math.round(g.minePhase * 30)); this.put(Math.round(g.mineFill * 20)); this.put(Math.round(g.mineBuffer * 20));
      this.put(g.dim); this.put(g.showState && g.inLeft ? g.state : -1);
      this.put(g.pieces); this.put(g.piecesFull); this.put(Math.round(g.piecePart * 40)); this.put(Math.round(g.pieceBurn * 40)); this.put(Math.round(g.pieceCool * 40));
    }
    this.drawn.length = this.at;
    return this.diff || sweeping;
  }
  private at = 0;
  private diff = false;
  private put(v: number | string | boolean): void {
    if (this.drawn[this.at] !== v) { this.drawn[this.at] = v; this.diff = true; }
    this.at++;
  }

  private segment(ctx: CanvasRenderingContext2D, g: RingGroup, a0: number, a1: number): void {
    const accent = ACCENT[g.model] ?? '#93c5fd';
    this.mul = g.dim ? 0.28 : 1;
    const arc = (r: number, from: number, to: number, color: string, width: number, alpha = 1): void => {
      if (to <= from) return;
      ctx.globalAlpha = alpha * this.mul;
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
    if (g.mine) {
      // The pulse sweeps the segment; its colour is the fulfilment (cyan fed, red starved); the buffer inside
      arc(R, a0, a1, '#1e293b', 3, 0.8);
      if (g.minePhase >= 0) arc(R, a0, a0 + len * g.minePhase, g.mineFill > 0.9 ? '#22d3ee' : g.mineFill > 0.4 ? '#facc15' : '#ef4444', 3.5, 0.35 + 0.6 * g.mineFill);
      arc(R - 6, a0, a0 + len * g.mineBuffer, g.mineBuffer < 0.15 ? '#ef4444' : '#67e8f9', 1.5, 0.75);
    } else if (g.pieces > 0) {
      this.pieceArcs(arc, g, a0, a1, accent);
    } else if (g.model === 'clip') {
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
    // The group's state, when a group is selected and this one is in the left button's: a dot inside the segment's middle
    if (g.showState && g.inLeft && !g.mine) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = g.state === 2 ? '#f87171' : g.state === 1 ? '#fbbf24' : '#4ade80';
      ctx.beginPath();
      ctx.arc(C + Math.cos(mid) * (R - 13), C + Math.sin(mid) * (R - 13), 2.6, 0, TAU);
      ctx.fill();
    }
    // The ammo count, outside the segment's middle (red when out)
    if (g.ammo >= 0) {
      const tx = C + Math.cos(mid) * (R + 15), ty = C + Math.sin(mid) * (R + 15);
      ctx.globalAlpha = this.mul;
      ctx.font = "700 10px 'Segoe UI', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = g.ammo > 0 || g.crates > 0 ? '#e5e7eb' : '#f87171';
      ctx.fillText(g.ammo > 0 || g.crates > 0 ? String(g.ammo) : '0', tx, ty);
    }
    ctx.globalAlpha = 1;
  }

  /** A beam's pieces: one arc each, a small gap between; the cooldown draining inside */
  private pieceArcs(arc: (r: number, from: number, to: number, color: string, width: number, alpha?: number) => void, g: RingGroup, a0: number, a1: number, accent: string): void {
    const N = g.pieces, gap = Math.min(0.08, (a1 - a0) / (N * 4)), each = (a1 - a0 - gap * (N - 1)) / N;
    const burning = g.pieceBurn > 0 ? 1 : 0;
    for (let k = 0; k < N; k++) {
      const s = a0 + k * (each + gap), e = s + each;
      arc(R, s, e, '#1e293b', 3.5, 0.8);
      if (k < g.piecesFull) arc(R, s, e, accent, 3.5, 0.95);
      else if (burning && k === g.piecesFull) arc(R, s, s + each * g.pieceBurn, '#ffffff', 4.5, 0.95);
      else if (k === g.piecesFull + burning && g.piecePart > 0) arc(R, s, s + each * g.piecePart, '#f59e0b', 2, 0.55);
    }
    if (g.pieceCool > 0) arc(R - 6, a0, a0 + (a1 - a0) * g.pieceCool, '#94a3b8', 1.6, 0.85);
  }

  /** Clip pips along the arc: lit for each round, grey (not lit) while a reload waits on power, sweeping while it runs */
  private pips(ctx: CanvasRenderingContext2D, g: RingGroup, a0: number, a1: number): void {
    const total = Math.max(1, g.clip), shown = Math.min(MAX_PIPS, total);
    const full = Math.round((g.rounds / total) * shown);
    const r = shown > 10 ? 1.8 : 2.4;
    for (let k = 0; k < shown; k++) {
      const a = shown === 1 ? (a0 + a1) / 2 : a0 + ((a1 - a0) * k) / (shown - 1);
      const lit = k < full;
      ctx.globalAlpha = this.mul;
      ctx.fillStyle = lit ? ACCENT.clip : g.starved ? '#6b7280' : '#334155';
      if (g.reloading && !lit && !g.starved) {
        // A reload running: the empty pips breathe in sequence
        ctx.globalAlpha = (0.35 + 0.35 * Math.max(0, Math.cos(this.sweep - k * 0.5))) * this.mul;
        ctx.fillStyle = '#fde68a';
      } else if (!lit) ctx.globalAlpha = (g.starved ? 0.9 : 0.6) * this.mul;
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
