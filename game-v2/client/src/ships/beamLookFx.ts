/**
 * The parts of a BEAM_LOOKS entry (rendering/weapons/weaponStyles.ts) that PulseFx, MiningFx and the held beams in
 * MiningBeamFx all draw the same way: a cone of light spreading from the muzzle, a shaft of light with dust glittering
 * in it, strands wound round the beam, and the
 * flicker of a beam short of power; and what every beam shares whatever its look: its soft-edged body, the emitter at
 * its muzzle and a soft glow (the hangar preview draws these too, so it shows the game's beam). Plain Graphics calls;
 * nothing is kept between frames.
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

/**
 * A shaft of light round a beam from (x, y) along (ux, uy) for `len`: `wid` wide at the muzzle and `deg` degrees wider
 * either side as it goes, in three soft layers; dust glittering in it (x `dust`), each mote drifting down the beam and
 * twinkling on its own beat (placed from `t` (seconds) and `seed`, so nothing is kept); and with `spot` a pool of light
 * where it lands
 */
export function drawShaft(g: Graphics, x: number, y: number, ux: number, uy: number, len: number, wid: number, deg: number, color: number, alpha: number, t: number, seed: number, dust: number, spot: boolean): void {
  if (alpha <= 0.005 || len <= 0) return;
  const k = Math.tan((deg * Math.PI) / 180), nx = -uy, ny = ux, ex = x + ux * len, ey = y + uy * len;
  const half = (d: number) => wid * 1.4 + d * k;
  for (let i = 0; i < 3; i++) {
    const m = 1 - i * 0.3, w0 = half(0) * m, w1 = half(len) * m;
    g.moveTo(x + nx * w0, y + ny * w0).lineTo(ex + nx * w1, ey + ny * w1).lineTo(ex - nx * w1, ey - ny * w1).lineTo(x - nx * w0, y - ny * w0).closePath()
      .fill({ color, alpha: alpha * (0.05 + i * 0.035) });
  }
  const n = Math.round(Math.max(6, Math.min(46, len / 40)) * dust);
  for (let i = 0; i < n; i++) {
    const h = Math.sin((i + 1) * 127.1 + seed * 3.7) * 43758.5453, r0 = h - Math.floor(h), h2 = Math.sin((i + 1) * 269.5 + seed) * 24634.6345, r1 = h2 - Math.floor(h2);
    const along = (r0 + t * (0.05 + 0.1 * r1)) % 1, d = along * len;
    const off = Math.sin(t * (0.6 + r1 * 1.4) + i * 2.1) * half(d) * (0.25 + 0.7 * r0);
    const tw = 0.5 + 0.5 * Math.sin(t * (5 + r1 * 9) + i * 1.3), edge = Math.min(1, along * 8, (1 - along) * 8);
    g.circle(x + ux * d + nx * off, y + uy * d + ny * off, 0.9 + r1 * 1.3).fill({ color: 0xffffff, alpha: alpha * 0.75 * tw * tw * edge });
  }
  if (spot) {
    const r = Math.max(wid * 5, half(len) * 1.8) * (0.94 + 0.06 * Math.sin(t * 9 + seed));
    softGlow(g, ex, ey, r * 1.9, color, 0.55 * alpha);
    softGlow(g, ex, ey, r, 0xffffff, 0.5 * alpha);
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

/** A soft glow at (x, y) out to `r`: five stepped discs, fainter outward (a flat disc reads as a sticker) */
export function softGlow(g: Graphics, x: number, y: number, r: number, color: number, alpha: number): void {
  if (alpha <= 0.005 || r <= 0) return;
  for (let i = 0; i < 5; i++) g.circle(x, y, r * (1 - i * 0.17)).fill({ color, alpha: alpha * (0.07 + i * 0.045) });
}

/** A held beam's body from (x0, y0) to (x1, y1), `wid` its width: five strokes falling off outward, so its edge is soft */
export function drawBeamBody(g: Graphics, x0: number, y0: number, x1: number, y1: number, wid: number, outer: number, mid: number, core: number, gain: number): void {
  g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color: outer, width: wid * 3.2, alpha: 0.07 * gain });
  g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color: outer, width: wid * 2.3, alpha: 0.1 * gain });
  g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color: mid, width: wid * 1.5, alpha: 0.26 * gain });
  g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color: mid, width: wid * 0.95, alpha: 0.3 * gain });
  g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color: core, width: wid * 0.45, alpha: 0.95 * gain });
}

/**
 * A beam's emitter at its muzzle (x, y), the beam leaving along (ux, uy) at width `wid`: a soft glow round a hot core, a
 * thin flare across the muzzle that flickers with `t` (seconds; `seed` offsets it), and for `ign` above 0 (1 the instant
 * the beam lights, falling to 0) a ring thrown off the muzzle as it catches
 */
export function drawEmitter(g: Graphics, x: number, y: number, ux: number, uy: number, wid: number, mid: number, core: number, gain: number, t: number, seed: number, ign = 0): void {
  if (gain <= 0.01) return;
  const fl = 0.8 + 0.2 * Math.sin(t * 47 + seed * 3.7) * Math.sin(t * 29 + seed), nx = -uy, ny = ux;
  softGlow(g, x, y, wid * (2.5 + 1.4 * ign), mid, 0.85 * gain);
  // The flare: a long faint bar and a short bright one, crossing the muzzle
  const l = wid * (1.9 + 0.6 * fl + 1.6 * ign);
  g.moveTo(x - nx * l, y - ny * l).lineTo(x + nx * l, y + ny * l).stroke({ color: mid, width: Math.max(1, wid * 0.22), alpha: 0.3 * gain * fl });
  g.moveTo(x - nx * l * 0.45, y - ny * l * 0.45).lineTo(x + nx * l * 0.45, y + ny * l * 0.45).stroke({ color: core, width: Math.max(1, wid * 0.3), alpha: 0.75 * gain * fl });
  g.circle(x + ux * wid * 0.2, y + uy * wid * 0.2, wid * 0.62).fill({ color: core, alpha: 0.9 * gain });
  if (ign > 0.02) g.circle(x, y, wid * (1.4 + 3.6 * (1 - ign))).stroke({ color: core, width: Math.max(1, wid * 0.25 * ign), alpha: 0.5 * ign * gain });
}

/** How lit a beam's ignition still is (1 to 0) `on` seconds after it lit */
export function ignition(on: number): number {
  return Math.max(0, 1 - on / 0.2);
}

/** How wide beam `r` of a split beam's fan (tuning.ts beamFan) is drawn beside its strongest: by its share of the burn, never a thread */
export function fanWidth(share: readonly number[], r: number): number {
  let top = 0;
  for (const s of share) if (s > top) top = s;
  return top > 0 ? Math.max(0.55, Math.sqrt(share[r] / top)) : 1;
}
