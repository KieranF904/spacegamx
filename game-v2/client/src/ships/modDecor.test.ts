/**
 * Weapon modifier hardware (modDecor.ts): every modifier part and tier II / III line part has some, a tier I line part
 * none of it, each block kind its own shape, and the same part gives the same shapes.
 */
import { describe, it, expect } from 'vitest';
import { blueprintGeometry, parseBlueprint, placeGeometry, type FunctionDef, type PlacedGeom, type PlacedPart, type Rot } from '@space-game/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { testCatalog, SHIP_DATA_DIR } from '../../../common/src/ships/testData';
import { modDecor, modSocketDecor, MOD_BLOCK_KINDS } from './modDecor';
import { partDecor, type DecorDisc, type DecorPoly } from './partDecor';

const catalog = testCatalog();
const models = [...catalog.functions.values()].filter((f) => f.model && !f.legacy);
const isMod = (f: FunctionDef) => !!(f.modMount || f.plug || f.hopper);

function own(fn: FunctionDef, rot: Rot = 0, flip = false) {
  const part: PlacedPart = { uid: 1, piece: (fn.pieces as string[])[0], fn: fn.id, material: fn.material ?? 'alloy', x: 2, y: 3, rot, flip };
  const geom = placeGeometry(catalog, part), out = { polys: [] as DecorPoly[], discs: [] as DecorDisc[] };
  const took = modDecor(out, geom, part, 0x7fd8ff, fn.decor === 'battery');
  return { part, geom, out, took };
}

describe('weapon modifier hardware', () => {
  it('there are modifier parts and tiered line parts to draw', () => {
    expect(models.filter(isMod).length).toBeGreaterThanOrEqual(14);
    expect(models.filter((f) => (f.lineTier ?? 0) >= 2).length).toBeGreaterThanOrEqual(12);
  });

  it('every modifier part and every tier II / III line part has hardware, inside its own cells', () => {
    for (const fn of models.filter((f) => isMod(f) || (f.lineTier ?? 0) >= 2)) {
      for (const rot of [0, 1, 2, 3] as Rot[]) {
        const { out, geom } = own(fn, rot);
        expect(out.polys.length + out.discs.length, fn.id).toBeGreaterThan(0);
        const xs = geom.cells.map((c) => c[0]), ys = geom.cells.map((c) => c[1]);
        const x0 = Math.min(...xs) - 1e-6, x1 = Math.max(...xs) + 1 + 1e-6, y0 = Math.min(...ys) - 1e-6, y1 = Math.max(...ys) + 1 + 1e-6;
        for (const p of out.polys) for (let k = 0; k < p.pts.length; k += 2) {
          expect(p.pts[k] >= x0 && p.pts[k] <= x1 && p.pts[k + 1] >= y0 && p.pts[k + 1] <= y1, `${fn.id} rot ${rot}`).toBe(true);
        }
      }
    }
  });

  it('a tier I line part, and a part that is none of these, gets none of it', () => {
    for (const fn of models.filter((f) => !isMod(f) && (f.lineTier ?? 0) < 2)) {
      const { out, took } = own(fn);
      expect(took, fn.id).toBe(false);
      expect(out.polys.length + out.discs.length, fn.id).toBe(0);
    }
  });

  it('every modifier kind in the models has its own shape', () => {
    const kinds = [...new Set(models.map((f) => f.plug).filter((k): k is string => !!k))];
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) expect(MOD_BLOCK_KINDS, k).toContain(k);
    const shapes = models.filter((f) => f.plug).map((f) => { const { out } = own(f); return JSON.stringify([out.polys.map((p) => p.pts.map((v) => Math.round(v * 1000))), out.discs.map((d) => [d.x, d.y, d.r, d.sides])]); });
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it('a heavier tier has more hardware than the one below', () => {
    const count = (id: string) => { const { out } = own(catalog.functions.get(id)!); return out.polys.length + out.discs.length; };
    for (const base of ['power_conduit', 'power_corner', 'power_passthrough', 'power_combiner', 'power_joiner_bank', 'power_splitter_bank']) {
      expect(count(`${base}_2`), base).toBeGreaterThan(count(base));
      expect(count(`${base}_3`), base).toBeGreaterThan(count(`${base}_2`));
    }
  });

  it('the same part gives the same shapes', () => {
    for (const fn of models.filter((f) => isMod(f) || (f.lineTier ?? 0) >= 2)) {
      const a = own(fn, 1, true), b = own(fn, 1, true);
      expect(JSON.stringify(a.out)).toBe(JSON.stringify(b.out));
      expect(JSON.stringify(partDecor(a.geom, a.part))).toBe(JSON.stringify(partDecor(b.geom, b.part)));
    }
  });

  it('on a ship, a socket with a block on it is lit in the block\'s colour; a ship with no mount has none', () => {
    const load = (name: string) => {
      const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/dev/${name}.json`), 'utf-8'));
      const geoms = blueprintGeometry(catalog, bp) as PlacedGeom[];
      return { bp, lit: modSocketDecor(bp.parts, geoms, bp.parts.map(() => true)) };
    };
    const { bp, lit } = load('mod-showcase-1');
    const mounts = bp.parts.flatMap((p, i) => (catalog.functions.get(p.fn)?.modMount ? [i] : []));
    expect([...lit!.keys()].sort((a, b) => a - b)).toEqual(mounts);
    const double = bp.parts.findIndex((p) => p.fn === 'mod_mount_double');
    expect(lit!.get(double)!.length).toBe(2 * lit!.get(mounts.find((m) => m !== double)!)!.length);
    expect(load('ports-gunship').lit).toBeUndefined();
  });
});
