/**
 * The pure halves of field fabrication's server side: the build view save (plan.ts: live parts kept, standing ones left
 * out queued for recycling, new parts appended as missing parts, the blueprint always valid) and the refiner's choice (refine.ts).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import { Economy, loadCatalog, validateBlueprint, type Blueprint, type PlacedPart, type Rot, type ShipTuning } from '@space-game/common';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { admitLegacy, planDiff, removeParts, samePlacement } from './plan.js';
import { pickRefine } from './refine.js';

const dataDir = join(__dirname, '../../../../data');
const config = loadShipConfigCached(dataDir);
const catalog = loadCatalog(config.catalog);
const tuning = config.tuning as ShipTuning;
const json = (p: string) => JSON.parse(readFileSync(join(dataDir, p), 'utf-8'));
const econ = new Economy(json('items.json'), json('recipes.json'), catalog, {});
const validate = (bp: Blueprint) => validateBlueprint(catalog, bp, tuning, null, { mounting: false });

const part = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const ship = (...more: PlacedPart[]): Blueprint => ({
  name: 'Plan', catalogVersion: catalog.version,
  parts: [part(0, 'rect2', 'core', 0, 0), part(1, 'sq', 'cannon_pip', 0, -1, { facing: 'N' }), part(2, 'sq', 'cannon_pip', 1, -1, { facing: 'N' }), ...more],
});
const live = (bp: Blueprint, ghosts: number[] = [], dead: number[] = []) => ({ blueprint: bp, ghosts: new Set(ghosts), alive: (u: number) => !ghosts.includes(u) && !dead.includes(u) });

describe('plan diff (the build view save: new parts are missing parts)', () => {
  it('keeps live parts in place and order, queues the standing ones left out, appends the new ones', () => {
    const bp = ship();
    expect(validate(bp).ok).toBe(true);
    const target = { ...bp, parts: [bp.parts[0], bp.parts[1], part(10, 'sq', 'hull', 2, 0), part(11, 'sq', 'cannon_pip', 2, -1, { facing: 'N' })] };
    const r = planDiff(validate, catalog, live(bp), target);
    if ('error' in r) throw new Error(r.error);
    // (Pip 2 still stands while it is recycled: it stays in the blueprint)
    expect(r.blueprint.parts.slice(0, 3)).toEqual(bp.parts);
    expect(r.blueprint.parts.slice(3).map((p) => p.uid)).toEqual([10, 11]);
    expect(r.added).toEqual([10, 11]);
    expect(r.recycle).toEqual([2]);
    expect(validate(r.blueprint).ok).toBe(true);
  });

  it('a new part keeps what it is: an alloy cargo hold goes in as a cargo hold', () => {
    const bp = ship();
    const r = planDiff(validate, catalog, live(bp), { ...bp, parts: [...bp.parts, part(10, 'sq', 'cargo', 0, 1, { material: 'alloy' })] });
    if ('error' in r) throw new Error(r.error);
    expect(r.blueprint.parts.find((p) => p.uid === 10)).toMatchObject({ fn: 'cargo', material: 'alloy', piece: 'sq' });
    expect(r.added).toEqual([10]);
  });

  it('a standing part moved gets a fresh uid (the old one recycled); a new part on a recycling part\'s cells is refused', () => {
    const bp = ship(part(3, 'sq', 'hull', 2, 0));
    // Hull 3 moved to the left of the core
    const r = planDiff(validate, catalog, live(bp), { ...bp, parts: [bp.parts[0], bp.parts[1], bp.parts[2], { ...bp.parts[3], x: -1 }] });
    if ('error' in r) throw new Error(r.error);
    expect(r.recycle).toEqual([3]);
    const moved = r.blueprint.parts.find((p) => p.x === -1 && p.y === 0)!;
    expect(moved.uid).not.toBe(3);
    expect(r.added).toEqual([moved.uid]);
    expect(validate(r.blueprint).ok).toBe(true);
    // A hull where Pip 2 stands: not while Pip 2 is still there
    const over = planDiff(validate, catalog, live(bp), { ...bp, parts: [bp.parts[0], bp.parts[1], bp.parts[3], part(12, 'sq', 'hull', 1, -1)] });
    expect(over).toHaveProperty('error');
    expect((over as { error: string }).error).toMatch(/still being recycled/);
    // Pip 2 recycled: the hull goes in
    const off = removeParts(validate, bp, new Set([2]), () => true)!;
    const again = planDiff(validate, catalog, live(off.blueprint), { ...bp, parts: [bp.parts[0], bp.parts[1], bp.parts[3], part(12, 'sq', 'hull', 1, -1)] });
    if ('error' in again) throw new Error(again.error);
    expect(again.added).toEqual([12]);
  });

  it('missing parts kept stay missing (planned or shot off, the same); missing parts left out simply go', () => {
    const bp = ship(part(3, 'sq', 'hull', 2, 0), part(4, 'sq', 'hull', -1, 0));
    // Hull 3 shot off and kept, hull 4 shot off and left out
    const target = { ...bp, parts: bp.parts.filter((p) => p.uid !== 4) };
    const r = planDiff(validate, catalog, live(bp, [], [3, 4]), target);
    if ('error' in r) throw new Error(r.error);
    expect(r.recycle).toEqual([]);
    expect(r.added).toEqual([]);
    expect(r.blueprint.parts.map((p) => p.uid)).toEqual([0, 1, 2, 3]);
  });

  it('hangar placeholders kept stay as they are, and are never recycled', () => {
    const bp = ship(part(3, 'sq', 'hull', 2, 0));
    const r = planDiff(validate, catalog, live(bp, [3]), { ...bp, parts: bp.parts.filter((p) => p.uid !== 3) });
    if ('error' in r) throw new Error(r.error);
    expect(r.recycle).toEqual([]);
    expect(r.blueprint.parts.map((p) => p.uid)).toEqual([0, 1, 2]);
  });

  it('refuses a plan that moves or drops the core', () => {
    const bp = ship();
    expect(planDiff(validate, catalog, live(bp), { ...bp, parts: bp.parts.slice(1) })).toHaveProperty('error');
    expect(planDiff(validate, catalog, live(bp), { ...bp, parts: bp.parts.map((p) => (p.fn === 'core' ? { ...p, y: 3 } : p)) })).toHaveProperty('error');
  });

  it('taking a part out keeps the missing parts it held on (planned, not connected); a standing one is never left', () => {
    const bp = ship(part(3, 'sq', 'hull', 2, 0), part(4, 'sq', 'hull', 3, 0));
    const r = removeParts(validate, bp, new Set([3]), (u) => u !== 4)!;
    expect(r.blueprint.parts.map((p) => p.uid)).toEqual([0, 1, 2, 4]);
    expect(r.dropped).toEqual([]);
    expect(validate(r.blueprint).unreachable).toEqual([4]);
  });

  it('a part that joins nothing is planned: saved as a missing part, listed unreachable, last in the build order', () => {
    const bp = ship();
    const target = { ...bp, parts: [...bp.parts, part(10, 'sq', 'hull', 20, 20), part(11, 'sq', 'hull', 2, 0)] };
    const r = planDiff(validate, catalog, live(bp), target);
    if ('error' in r) throw new Error(r.error);
    expect(r.added).toEqual([11, 10]); // (nearest the core first; the unconnected one after)
    const v = validate(r.blueprint);
    expect(v.ok).toBe(true);
    expect(v.unreachable).toEqual([10]);
    // Overlaps and the like are still refused
    expect(planDiff(validate, catalog, live(bp), { ...bp, parts: [...bp.parts, part(10, 'sq', 'hull', 20, 20), part(12, 'sq', 'hull', 20, 20)] })).toHaveProperty('error');
    // Joined later (a part between): it is connected, nothing unreachable
    const joined = { ...r.blueprint, parts: [...r.blueprint.parts, ...Array.from({ length: 17 }, (_, k) => part(20 + k, 'sq', 'hull', 3 + k, 0)), ...Array.from({ length: 20 }, (_, k) => part(40 + k, 'sq', 'hull', 20, k))] };
    expect(validate(joined).unreachable).toEqual([]);
  });

  it('an old save\'s waiting parts go in as far as the design stays valid', () => {
    const bp = ship();
    const r = admitLegacy(validate, bp, [part(11, 'sq', 'hull', 3, 0), part(10, 'sq', 'hull', 2, 0), part(12, 'sq', 'hull', 9, 9)]);
    expect(r.added.sort()).toEqual([10, 11, 12]);
    expect(validate(r.blueprint).ok).toBe(true);
    expect(validate(r.blueprint).unreachable).toEqual([12]);
  });

  it('samePlacement reads piece, function, material, place, turn, flip, facing and mount', () => {
    const a = part(1, 'sq', 'cannon_pip', 0, -1, { facing: 'N' });
    expect(samePlacement(a, { ...a })).toBe(true);
    for (const d of [{ x: 1 }, { rot: 1 as Rot }, { flip: true }, { facing: 'E' as const }, { material: 'steel' }, { mount: 'turret' as const }]) expect(samePlacement(a, { ...a, ...d })).toBe(false);
  });
});

describe("the refiner's choice", () => {
  const have = (bag: Record<string, number>) => (id: string) => bag[id] ?? 0;

  it('a chosen recipe runs while the hold has its inputs, within the grade cap', () => {
    expect(pickRefine(econ, 0, 'alloy_plate', {}, have({ iron_ore: 2, nickel_ore: 1 }))).toMatchObject({ recipe: 'alloy_plate', out: { alloy_plate: 1 } });
    expect(pickRefine(econ, 0, 'alloy_plate', {}, have({ iron_ore: 1 }))).toEqual({ blocked: 'materials' });
    expect(pickRefine(econ, 0, 'steel_plate', {}, have({ iron_ore: 40, nickel_ore: 40 }))).toEqual({ blocked: 'grade' });
    expect(pickRefine(econ, 1, 'steel_plate', {}, have({ iron_ore: 40, nickel_ore: 40 }))).toMatchObject({ recipe: 'steel_plate' });
  });

  it('on auto it refines what the fabricator is short of, from the ore in the hold, else nothing', () => {
    expect(pickRefine(econ, 0, undefined, { alloy_plate: 2 }, have({ iron_ore: 2, nickel_ore: 1 }))).toMatchObject({ recipe: 'alloy_plate' });
    expect(pickRefine(econ, 0, undefined, {}, have({ iron_ore: 2, nickel_ore: 1 }))).toEqual({ blocked: 'idle' });
    expect(pickRefine(econ, 0, undefined, { steel_plate: 1 }, have({ iron_ore: 40, nickel_ore: 40 }))).toEqual({ blocked: 'grade' });
    expect(pickRefine(econ, 0, undefined, { alloy_plate: 1 }, have({}))).toEqual({ blocked: 'idle' });
  });

  it("on auto, once the plan needs nothing it can make, it runs the pilot's list in order (FieldRecord.refine)", () => {
    const ore = have({ iron_ore: 2, nickel_ore: 1 });
    expect(pickRefine(econ, 0, undefined, {}, ore, ['alloy_plate'])).toMatchObject({ recipe: 'alloy_plate' });
    // (Past the grade: skipped for the next one; nothing the hold can make: waiting for materials)
    expect(pickRefine(econ, 0, undefined, {}, ore, ['steel_plate', 'alloy_plate'])).toMatchObject({ recipe: 'alloy_plate' });
    expect(pickRefine(econ, 0, undefined, {}, have({}), ['alloy_plate'])).toEqual({ blocked: 'materials' });
    expect(pickRefine(econ, 0, undefined, {}, have({ iron_ore: 40, nickel_ore: 40 }), ['steel_plate'])).toEqual({ blocked: 'grade' });
    // (A chosen recipe still wins, and so does what the plan is short of)
    expect(pickRefine(econ, 0, 'alloy_plate', {}, ore, ['steel_plate'])).toMatchObject({ recipe: 'alloy_plate' });
  });
});
