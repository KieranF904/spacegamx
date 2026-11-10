/**
 * Gun shape rules (gunFacing.ts): a model gun's barrel is on a fixed side of its piece, so facing follows the turn and
 * mirror, a gun's power inputs are the same however it is turned, and the old designs keep their barrels where they were.
 */

import { describe, it, expect } from 'vitest';
import type { Blueprint, PlacedPart, Rot, Side } from './types.js';
import { facingEdges, placeGeometry } from './grid.js';
import { previewPorts } from './power/portStates.js';
import { validateBlueprint } from './blueprint.js';
import { barrelSide, fixGunFacing, gunFacing, hasFixedBarrel, migrateGunFacings } from './gunFacing.js';
import { migrateProfileGunFacings, newProfile, type StarterKit } from '../econ/profile.js';
import { readShipJson, testCatalog } from './testData.js';
import type { ShipTuning } from './tuning.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const p = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const bp = (parts: PlacedPart[]): Blueprint => ({ name: 'test', catalogVersion: catalog.version, parts });
const SIDES: Side[] = ['N', 'E', 'S', 'W'];
const ROTS: Rot[] = [0, 1, 2, 3];
const gunModels = [...catalog.functions.values()].filter((f) => f.model && f.weapon);

describe("a model gun's barrel is fixed to its piece", () => {
  it("is the piece's north edge (the long edge of a rectangle), or the first straight one where north is curved", () => {
    expect(barrelSide(catalog, 'sq')).toBe('N');
    expect(barrelSide(catalog, 'rect2')).toBe('N');
    expect(barrelSide(catalog, 'block2')).toBe('N');
    expect(barrelSide(catalog, 'round')).toBe('W');
    for (const f of gunModels) {
      const piece = f.pieces[0] as string;
      const g = placeGeometry(catalog, p(0, piece, f.id, 0, 0));
      expect(facingEdges(g, barrelSide(catalog, piece)).length, f.id).toBeGreaterThan(0);
    }
  });

  it('legacy weapons, engines and other parts keep a free facing', () => {
    expect(hasFixedBarrel(catalog, 'weapon')).toBe(false);
    expect(hasFixedBarrel(catalog, 'hull')).toBe(false);
    expect(hasFixedBarrel(catalog, 'engine_ion_drive')).toBe(false);
    expect(hasFixedBarrel(catalog, 'cannon_hammer')).toBe(true);
    expect(gunFacing(catalog, { fn: 'weapon', piece: 'sq', rot: 1, flip: false })).toBeNull();
  });

  it('follows the turn: turning a part turns its barrel a quarter each time, for every gun model', () => {
    for (const f of gunModels) {
      for (const flip of [false, true]) {
        const seen = ROTS.map((rot) => gunFacing(catalog, { fn: f.id, piece: f.pieces[0] as string, rot, flip })!);
        expect(new Set(seen).size, f.id).toBe(4);
        for (let i = 0; i < 4; i++) expect(SIDES.indexOf(seen[(i + 1) % 4]), `${f.id} ${flip}`).toBe((SIDES.indexOf(seen[i]) + 1) % 4);
      }
    }
  });

  it('a mirror never moves a north barrel, and swaps east and west on a round piece', () => {
    for (const flip of [false, true]) {
      expect(gunFacing(catalog, { fn: 'cannon_hammer', piece: 'rect2', rot: 0, flip })).toBe('N');
      expect(gunFacing(catalog, { fn: 'cannon_hammer', piece: 'rect2', rot: 1, flip })).toBe('E');
      expect(gunFacing(catalog, { fn: 'cannon_hammer', piece: 'rect2', rot: 2, flip })).toBe('S');
      expect(gunFacing(catalog, { fn: 'cannon_hammer', piece: 'rect2', rot: 3, flip })).toBe('W');
    }
    // (The round piece's barrel is its west edge: mirrored it is east)
    expect(gunFacing(catalog, { fn: 'laser_searchlight', piece: 'round', rot: 0, flip: false })).toBe('W');
    expect(gunFacing(catalog, { fn: 'laser_searchlight', piece: 'round', rot: 0, flip: true })).toBe('E');
  });

  it('the placed barrel edge is a real straight edge of the placed piece, whatever the turn and mirror', () => {
    for (const f of gunModels) for (const flip of [false, true]) for (const rot of ROTS) {
      const part = p(0, f.pieces[0] as string, f.id, 0, 0, { rot, flip });
      const side = gunFacing(catalog, part)!;
      expect(facingEdges(placeGeometry(catalog, part), side).length, `${f.id} ${rot} ${flip}`).toBeGreaterThan(0);
    }
  });

  it("validation refuses a gun whose facing is not its turn's, and a saved ship (mounting: false) still loads", () => {
    const wrong = bp([p(0, 'rect2', 'core', 0, 0), p(1, 'sq', 'cannon_pip', 0, -1, { facing: 'W' })]);
    const strict = validateBlueprint(catalog, wrong, tuning, null);
    expect(strict.errors.map((e) => e.code)).toContain('facingFixed');
    expect(validateBlueprint(catalog, wrong, tuning, null, { mounting: false }).errors.map((e) => e.code)).not.toContain('facingFixed');
    const right = bp([p(0, 'rect2', 'core', 0, 0), p(1, 'sq', 'cannon_pip', 0, -1, { facing: 'N' })]);
    expect(validateBlueprint(catalog, right, tuning, null).errors).toEqual([]);
    // (A server takes a client's design with the facing its turn gives)
    expect(fixGunFacing(catalog, wrong).parts[1].facing).toBe('N');
  });
});

describe("a gun's power inputs are its back, however it is turned", () => {
  const OPP: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };
  /** The in ports a gun placed with this turn and mirror has: how many, and the sides they face (the preview a builder sees) */
  const inputsOf = (fn: string, piece: string, rot: Rot, flip: boolean) => {
    const part = p(1, piece, fn, 0, 0, { rot, flip, facing: gunFacing(catalog, { fn, piece, rot, flip })! });
    const ins = previewPorts(undefined, part, catalog.functions.get(fn)!, placeGeometry(catalog, part).cells, () => -1).filter((q) => q.dir === 0);
    return { n: ins.length, sides: ins.filter((q) => !q.aug).map((q) => q.side).sort().join(''), facing: part.facing as Side };
  };

  it('the same number of inputs in every turn and mirror, for every gun', () => {
    for (const f of gunModels) {
      const piece = f.pieces[0] as string;
      const counts = new Set<number>();
      for (const flip of [false, true]) for (const rot of ROTS) counts.add(inputsOf(f.id, piece, rot, flip).n);
      expect([...counts], f.id).toHaveLength(1);
    }
  });

  it('a back-input gun takes its power through the side opposite its barrel, in every turn', () => {
    let checked = 0;
    for (const f of gunModels) {
      const piece = f.pieces[0] as string;
      if (!f.ports?.length || !f.ports.every((q) => q.side === 'S')) continue;
      for (const flip of [false, true]) for (const rot of ROTS) {
        const r = inputsOf(f.id, piece, rot, flip);
        expect(r.sides, `${f.id} ${rot} ${flip}`).toBe(OPP[r.facing].repeat(r.sides.length));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("a Hammer has its model's inputs (its main one and its augment) in every turn", () => {
    const f = catalog.functions.get('cannon_hammer')!;
    const want = (f.ports ?? []).filter((q) => q.dir === 'in').length + (f.augment ? 1 : 0);
    expect(want).toBeGreaterThan(0);
    for (const rot of ROTS) expect(inputsOf('cannon_hammer', 'rect2', rot, false).n).toBe(want);
  });
});

describe('existing designs keep their barrels where they were', () => {
  const core = p(0, 'rect2', 'core', 0, 0);
  const cells = (q: PlacedPart) => placeGeometry(catalog, q).cells.map((c) => c.join(',')).sort();

  it('a gun turned on the spot: a square gun facing west is turned west, the same cell, the same inputs', () => {
    const b = bp([core, p(1, 'sq', 'autocannon_rattler', -1, 0, { facing: 'W' })]);
    const m = migrateGunFacings(catalog, b);
    expect(m.changed).toBe(true);
    expect(m.changes).toMatchObject([{ uid: 1, how: 'rotated', moved: false, wiring: 'same', to: { x: -1, y: 0, facing: 'W' } }]);
    const q = m.blueprint.parts[1];
    expect(gunFacing(catalog, q)).toBe('W');
    expect(q.facing).toBe('W');
    expect(validateBlueprint(catalog, m.blueprint, tuning, null).errors).toEqual([]);
    // (Already right: left alone, the very same object)
    expect(migrateGunFacings(catalog, m.blueprint).blueprint).toBe(m.blueprint);
  });

  it('a long gun that must turn half a turn keeps its cells', () => {
    // A Hammer under the core's south edge, facing south, as drawn at rot 0
    const b = bp([core, p(1, 'rect2', 'cannon_hammer', 0, 1, { facing: 'S' })]);
    const m = migrateGunFacings(catalog, b);
    expect(m.changes[0]).toMatchObject({ how: 'rotated', moved: false });
    // (Half a turn about its origin cell: the cells are the same, the origin is the far one)
    expect(m.blueprint.parts[1]).toMatchObject({ rot: 2, facing: 'S' });
    expect(cells(m.blueprint.parts[1])).toEqual(cells(b.parts[1]));
    expect(validateBlueprint(catalog, m.blueprint, tuning, null).errors).toEqual([]);
  });

  it('a long gun standing on end, barrel along its short side, lies down where there is room and keeps its barrel', () => {
    const b = bp([core, p(1, 'rect2', 'cannon_hammer', 0, -2, { rot: 1, facing: 'N' })]);
    expect(validateBlueprint(catalog, b, tuning, null, { mounting: false }).errors).toEqual([]);
    const m = migrateGunFacings(catalog, b);
    expect(m.changes[0]).toMatchObject({ how: 'rotated', moved: true });
    expect(m.changes[0].to.facing).toBe('N');
    expect(validateBlueprint(catalog, m.blueprint, tuning, null).errors).toEqual([]);
  });

  it('a design that would be worse for moving its guns is left as it was (they stay flagged)', () => {
    // A row of long guns on end side by side: none can lie down without blocking the next one's barrel
    const row = [0, 1, 2, 3].map((i) => p(1 + i, 'rect2', 'cannon_hammer', i, -2, { rot: 1, facing: 'N' }));
    const b = bp([p(0, 'block2', 'core', 0, 0), ...row]);
    const m = migrateGunFacings(catalog, b);
    const broken = (x: Blueprint) => validateBlueprint(catalog, x, tuning, null, { mounting: false }).errors.length;
    expect(broken(m.blueprint)).toBeLessThanOrEqual(broken(b));
    for (const c of m.changes) if (c.how === 'stuck') expect(m.blueprint.parts.find((q) => q.uid === c.uid)).toMatchObject({ x: c.from.x, y: c.from.y, rot: c.from.rot, facing: c.from.facing });
  });

  it('a side mount keeps its barrel, so the side it faces does not change', () => {
    const b = bp([core, p(1, 'rect2', 'flak_cloudmaker', 2, 0, { rot: 0, flip: false, facing: 'E' })]);
    const m = migrateGunFacings(catalog, b);
    const q = m.blueprint.parts[1];
    expect(q.facing).toBe('E');
    expect(gunFacing(catalog, q)).toBe('E');
  });

  it('a profile loads with its ships and designs migrated, and loading again changes nothing', () => {
    const kit: StarterKit = { blueprint: bp([core]), planFile: 'x', credits: 0, storage: {}, home: 'sol_station_central', position: { system: 'sol', x: 0, y: 0 } };
    const prof = newProfile(kit);
    const old = bp([core, p(1, 'sq', 'autocannon_rattler', -1, 0, { facing: 'W' })]);
    prof.ship = { ...prof.ship, blueprint: old };
    prof.hangar = [prof.ship, null, null, null, null];
    prof.activeSlot = 0;
    prof.designs = [old, null];
    migrateProfileGunFacings(prof, catalog);
    for (const b of [prof.ship.blueprint, prof.hangar[0]!.blueprint, prof.designs[0]!]) {
      expect(b.parts[1]).toMatchObject({ rot: 3, facing: 'W' });
    }
    expect(prof.ship).toBe(prof.hangar[0]);
    const again = prof.ship.blueprint;
    migrateProfileGunFacings(prof, catalog);
    expect(prof.ship.blueprint).toBe(again);
  });
});
