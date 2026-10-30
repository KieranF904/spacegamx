import { describe, expect, it } from 'vitest';
import { STATION_DESIGNS } from '@space-game/common';
import { buildStation, turretLook } from '../stationDesigns';
import type { StationGeometry } from './StationGeometry';
import { applyStationLook } from './stationLook';
import { bakeStation, K, type BakeInput, type BakePiece } from './stationBake';
import { buildStationAtlas, STATION_ATLAS_H, STATION_ATLAS_W } from './stationTextures';

function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const piece = (g: StationGeometry, x: number, y: number, rotor: boolean, domes: BakePiece['domes'] = []): BakePiece =>
  ({ pos: new Float32Array(g.pos), nrm: new Float32Array(g.nrm), col: new Float32Array(g.col), idx: new Uint32Array(g.idx), shapes: g.shapes, x, y, rotor, domes });

/** As StationView builds it: the design, the look's changes, turret mounts and heads */
function input(design: string, R: number, turrets: number): BakeInput {
  const L = buildStation(design, R, rng(3), 0x5fd4c4, turrets);
  const domes = applyStationLook(design, L, R);
  const look = turretLook('laser', Math.max(26, Math.min(50, R * 0.18)));
  const mounts = L.hardpoints.slice(0, turrets);
  for (const h of mounts) L.body.disc(h.x, h.y, look.mountRadius, 0x5a6370, { bevel: 5 }, 10);
  const pieces = [piece(L.body as StationGeometry, 0, 0, false, domes.body)];
  if (L.spin.vertexCount) pieces.push(piece(L.spin as StationGeometry, L.spinAt.x, L.spinAt.y, true, domes.spin));
  for (const h of mounts) pieces.push(piece(look.head as StationGeometry, h.x, h.y, true));
  return { design, R, tileW: R * 0.22, pieces, navTips: L.navTips, chase: L.chase, chaseColor: 0xffb547, guns: L.hardpoints.slice(0, 4).map((h) => [h.x, h.y]) };
}

describe('station look bake', () => {
  for (const design of STATION_DESIGNS) {
    it(`bakes the ${design} into finite, sensible geometry`, () => {
      const out = bakeStation(input(design, 200, 2));
      expect(out.pieces.length).toBeGreaterThanOrEqual(3);
      for (const p of out.pieces) {
        expect(p.count % 3).toBe(0);
        for (const a of [p.pos, p.nrm, p.col, p.expo, p.mat, p.uv, p.win, p.shadow, p.bend, p.spill]) for (const v of a) expect(Number.isFinite(v)).toBe(true);
        for (let i = 0; i < p.count; i++) {
          // shadow mean and AO within 0..1, kinds known and no window disc left
          expect(p.shadow[i * 3]).toBeGreaterThanOrEqual(0);
          expect(p.shadow[i * 3]).toBeLessThanOrEqual(1.0001);
          expect(p.bend[i * 3 + 2]).toBeGreaterThanOrEqual(0.4);
          expect(p.mat[i * 4]).not.toBe(K.LEGACY);
        }
      }
      // something on the body sits in a shadow
      const body = out.pieces[0];
      let shaded = 0;
      for (let i = 0; i < body.count; i++) if (body.shadow[i * 3] < 0.85) shaded++;
      expect(shaded).toBeGreaterThan(0);
    });
  }

  it('gives the ring and citadel glass domes, and the refinery amber cells', () => {
    const kinds = (d: string) => new Set(Array.from(bakeStation(input(d, 200, 0)).pieces[0].mat.filter((_, i) => i % 4 === 0)));
    expect(kinds('ring').has(K.DOME)).toBe(true);
    expect(kinds('citadel').has(K.DOME)).toBe(true);
    const ref = bakeStation(input('refinery', 200, 0)).pieces[0];
    let amber = 0;
    for (let i = 0; i < ref.count; i++) if (ref.mat[i * 4] === K.SOLAR && ref.mat[i * 4 + 2] === 1) amber++;
    expect(amber).toBeGreaterThan(0);
  });

  it('builds the hull atlas', () => {
    const a = buildStationAtlas();
    expect(a.length).toBe(STATION_ATLAS_W * STATION_ATLAS_H * 4);
  });
});
