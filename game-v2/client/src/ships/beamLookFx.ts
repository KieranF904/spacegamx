/**
 * The parts of a BEAM_LOOKS entry (rendering/weapons/weaponStyles.ts) that PulseFx, MiningFx and the held beams in
 * MiningBeamFx all draw the same way: a cone of light spreading from the muzzle, strands wound round the beam, and the
 * flicker of a beam short of power. Plain Graphics calls; nothing is kept between frames.
 */

import type { Graphics } from 'pixi.js';

/** A wedge of light from (x, y) along (ux, uy) for `len`, spreading to `deg` degrees either side, brighter at the muzzle */
export function drawCone(g: Graphics, x: number, y: number, ux: number, uy: number, len: number, deg: number, color: number, alpha: number): void {
  if (deg <= 0 || alpha <= 0.005) return;
  const t = Math.tan((deg * Math.PI) / 180), nx = -uy, ny = ux;
  // Three nested wedges stand in for a gradient
  for (let i = 0; i < 3; i++) {
    const l = len * (1 - i * 0.25), w = l * t;
    g.moveTo(x, y).lineTo(x + ux * l + nx * w, y + uy * l + ny * w).lineTo(x + ux * l - nx * w, y + uy * l - ny * w).closePath().fill({ color, alpha: alpha * 0.4 });
  }
}

/** `strands` threads wound round a beam of half-width `wid` out to `len`, turning with `t` (seconds); `seed` offsets the turn */
export function drawStrands(g: Graphics, x: number, y: number, ux: number, uy: number, len: number, wid: number, strands: number, color: number, alpha: number, t: number, seed: number): void {
  const nx = -uy, ny = ux, period = 70, n = Math.max(6, Math.min(48, Math.round(len / 18))), amp = Math.max(2.5, wid * 1.5);
  for (let s = 0; s < strands; s++) {
    const phase = (s / strands) * Math.PI * 2;
    g.moveTo(x, y);
    for (let i = 1; i <= n; i++) {
      const d = (len * i) / n, off = Math.sin((d / period) * Math.PI * 2 - t * 14 + phase + seed) * amp * Math.min(1, d / 40);
      g.lineTo(x + ux * d + nx * off, y + uy * d + ny * off);
    }
    g.stroke({ color, width: Math.max(1, wid * 0.3), alpha: 0.85 * alpha });
  }
}

/** x a beam's brightness this instant for a look with `sputter` (0: steady): short dropouts, deterministic in `t` and `seed` */
export function sputterGain(sputter: number | undefined, t: number, seed: number): number {
  if (!sputter) return 1;
  const s = Math.sin(t * 61 + seed * 7.3) + Math.sin(t * 37 + seed * 3.1);
  return s > 1.1 ? 1 - Math.min(0.9, 0.7 * sputter) : 1 - 0.15 * sputter;
}
