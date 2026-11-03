/**
 * The siege's marks on the bastion's ground, redrawn only when the siege's
 * state changes (BastionView keys it): the approach lanes the nights come down
 * (worn ruts with chevrons pointing in, red at night), each turret's reach
 * (faint, the pad picked in the panel bright), each pad's lamps and a hull arc
 * by its turret's hull, and scorched ground where a turret was shot down.
 * Unlit vector marks: what should stay dark is dark paint; lamps and night
 * chevrons glow.
 */

import { Graphics } from 'pixi.js';
import { PAD_EMPTY, TURRET_DEFAULT, TURRET_LOOKS, padLamp } from './siegeLook';

export interface GroundState {
  pads: { x: number; y: number }[];
  /** Each pad's turret (null: empty) */
  turrets: ({ kind?: string; hull: number; range?: number } | null)[];
  lost: Set<number>;
  lanes: { angle: number; spread: number }[];
  /** Lanes run from here out to `laneTo` (world units from the bastion) */
  laneFrom: number; laneTo: number;
  /** The pad picked or hovered in the panel (-1 none) */
  focus: number;
  /** 0 day .. 1 night */
  night: number;
}

/** A small repeatable wobble per pad (the scorch's ragged edge) */
const wobble = (i: number, k: number) => Math.sin(i * 12.9898 + k * 78.233) * 43758.5453 % 1;

export function drawGround(g: Graphics, s: GroundState): void {
  g.clear();
  const n = s.night, day = 1 - n;
  // Approach lanes: a faint wedge for a wide spread, two ruts, chevrons pointing at the bastion
  for (const l of s.lanes) {
    const c = Math.cos(l.angle), sn = Math.sin(l.angle), px = -sn, py = c;
    if (l.spread > 0.25) {
      const pts: number[] = [];
      for (let k = 0; k <= 12; k++) { const a = l.angle - l.spread + (2 * l.spread * k) / 12; pts.push(Math.cos(a) * s.laneTo, Math.sin(a) * s.laneTo); }
      pts.push(Math.cos(l.angle + l.spread) * s.laneFrom, Math.sin(l.angle + l.spread) * s.laneFrom, Math.cos(l.angle - l.spread) * s.laneFrom, Math.sin(l.angle - l.spread) * s.laneFrom);
      g.poly(pts).fill({ color: n > 0.5 ? 0xff5040 : 0xffffff, alpha: 0.035 });
    }
    for (const side of [-1, 1]) {
      const o = side * 70;
      g.moveTo(c * s.laneFrom + px * o, sn * s.laneFrom + py * o).lineTo(c * s.laneTo + px * o, sn * s.laneTo + py * o)
        .stroke({ color: 0x000000, width: 34, alpha: 0.16 + 0.06 * day });
    }
    const step = 520, w = 70, len = 60;
    for (let r = s.laneFrom + 200; r < s.laneTo; r += step) {
      const fade = 1 - (r - s.laneFrom) / (s.laneTo - s.laneFrom) * 0.6;
      const tipX = c * (r - len), tipY = sn * (r - len);
      g.moveTo(c * r + px * w, sn * r + py * w).lineTo(tipX, tipY).lineTo(c * r - px * w, sn * r - py * w)
        .stroke({ color: n > 0.5 ? 0xff5a48 : 0xe9e1cf, width: 16, alpha: (0.2 + 0.45 * n) * fade, cap: 'round', join: 'round' });
    }
  }
  // Reach: every built turret's, faint in its kind's colour; the focused pad's bright (an empty one: where it would stand)
  s.turrets.forEach((t, i) => {
    if (!t?.range) return;
    const p = s.pads[i], col = TURRET_LOOKS[t.kind ?? ''] ?? TURRET_DEFAULT, on = i === s.focus;
    g.circle(p.x, p.y, t.range).stroke({ color: col, width: on ? 10 : 6, alpha: on ? 0.55 : 0.07 + 0.08 * n });
    if (on) g.circle(p.x, p.y, t.range).fill({ color: col, alpha: 0.05 });
  });
  const fp = s.pads[s.focus];
  if (fp && !s.turrets[s.focus]) {
    g.circle(fp.x, fp.y, 150).stroke({ color: PAD_EMPTY, width: 10, alpha: 0.8 });
    g.circle(fp.x, fp.y, 1400).stroke({ color: PAD_EMPTY, width: 6, alpha: 0.28 });
  }
  // Pads: scorched ground where a turret fell; lamps and a hull arc by the turret's hull
  s.pads.forEach((p, i) => {
    const t = s.turrets[i];
    if (s.lost.has(i) && !t) {
      const pts: number[] = [];
      for (let k = 0; k < 14; k++) { const a = (k / 14) * Math.PI * 2, r = 150 + 55 * Math.abs(wobble(i, k)); pts.push(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r); }
      g.poly(pts).fill({ color: 0x0b0806, alpha: 0.55 });
      g.circle(p.x, p.y, 92).fill({ color: 0x050403, alpha: 0.5 });
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + wobble(i, k + 20) * 2;
        g.moveTo(p.x + Math.cos(a) * 80, p.y + Math.sin(a) * 80).lineTo(p.x + Math.cos(a + 0.2) * 190, p.y + Math.sin(a + 0.2) * 190)
          .stroke({ color: 0x000000, width: 7, alpha: 0.5 });
      }
    }
    const lamp = t ? padLamp(t.hull) : s.lost.has(i) ? 0x3a1a12 : PAD_EMPTY;
    const lampA = t ? 0.95 : s.lost.has(i) ? 0.9 : 0.45 + 0.3 * n;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      g.circle(p.x + Math.cos(a) * 100, p.y + Math.sin(a) * 100, 9).fill({ color: lamp, alpha: lampA });
    }
    if (t) {
      const h = Math.max(0, Math.min(1, t.hull / 100)), a0 = -Math.PI / 2;
      g.circle(p.x, p.y, 136).stroke({ color: 0x000000, width: 9, alpha: 0.35 });
      if (h > 0) g.moveTo(p.x, p.y - 136).arc(p.x, p.y, 136, a0, a0 + Math.PI * 2 * h).stroke({ color: lamp, width: 9, alpha: 0.85 });
    }
  });
}
