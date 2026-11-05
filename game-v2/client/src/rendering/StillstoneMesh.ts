/**
 * A stillstone's constants, its turn, and the one kind still drawn as lit
 * polygons (Scenery.ts LodestoneView): a shattered stone, a loose ring of
 * fragments, a few still stepped like the carving they came from. Whole
 * stones are drawn from their surface map (stillstoneMap.ts, StillstoneShader.ts).
 * Pure (no Pixi display objects).
 */

import { hashString, mulberry32, type LodestoneData } from '@space-game/common';
import { LitGeometry } from './lighting/LitGeometry';

/** How far past its size a stillstone reaches (the map's edge, a shattered stone's fragments) */
export const STILLSTONE_REACH = 1.2;

export const STONE = {
  rock: 0x4a4d54, rim: 0x5e626b, floor: 0x33363c, ridge: 0x767b85,
  glow: 0xbcd8ea, warm: 0xe8cfa0, field: 0xa3c2cf,
};

const TAU = Math.PI * 2;

function mul(c: number, k: number): number {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (f((c >> 16) & 255) << 16) | (f((c >> 8) & 255) << 8) | f(c & 255);
}

/** Its slow turn (from its id: everyone sees it at the same angle), and its grooves' colour (warm on a rough new one) */
export function stillstoneSpin(data: LodestoneData, R: number): { phase: number; rate: number } {
  const rnd = mulberry32(hashString(data.id));
  return { phase: rnd() * TAU, rate: (0.012 + rnd() * 0.01) * (rnd() < 0.5 ? 1 : -1) * Math.min(1.5, 1000 / R) };
}
export const stillstoneGlowColor = (data: LodestoneData) => (data.rough ? STONE.warm : STONE.glow);

/** Shattered: a loose ring of fragments, a few still stepped like the carving they came from */
export function stillstoneShards(data: LodestoneData, R: number): LitGeometry {
  const rnd = mulberry32(hashString(data.id) ^ 0x2545f491), g = new LitGeometry();
  const n = 18 + Math.floor(rnd() * 8);
  for (let i = 0; i < n; i++) {
    const a = ((i + rnd() * 0.6) / n) * TAU, r = R * (0.5 + 0.45 * rnd()), sz = R * (0.06 + 0.09 * rnd());
    const cx = Math.cos(a) * r, cy = Math.sin(a) * r, k = 5 + Math.floor(rnd() * 3), pts: number[] = [];
    for (let j = 0; j < k; j++) { const t = ((j + rnd() * 0.5) / k) * TAU, rr = sz * (0.6 + 0.4 * rnd()); pts.push(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr); }
    g.panel(pts, mul(STONE.rock, 0.55 + rnd() * 0.25), { bevel: sz * 0.2, edge: mul(STONE.rim, 0.7) });
    if (rnd() < 0.3) g.panel(pts.map((v, j) => (j % 2 === 0 ? cx + (v - cx) * 0.55 : cy + (v - cy) * 0.55)), mul(STONE.floor, 0.8), { bevel: sz * 0.1, edge: mul(STONE.ridge, 0.6) });
  }
  return g;
}
