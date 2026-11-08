/**
 * The pure halves of field fabrication's server side: the plan diff (plan.ts: standing parts kept, removals queued,
 * new parts appended as ghosts or left waiting, the blueprint always valid) and the refiner's choice (refine.ts).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import { Economy, loadCatalog, validateBlueprint, type Blueprint, type PlacedPart, type Rot, type ShipTuning } from '@space-game/common';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { planDiff, promoteWaiting, removeParts, samePlacement } from './plan.js';
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
  name: 'Plan', catalogVersion: catalog.version, power: 'ports',
  parts: [part(0, 'rect2', 'core', 0, 0), part(1, 'sq', 'cannon_pip', 0, -1, { facing: 'N' }), part(2, 'sq', 'cannon_pip', 1, -1, { facing: 'N' }), ...more],
});
const live = (bp: Blueprint, ghosts: number[] = [], dead: number[] = []) => ({ blueprint: bp, ghosts: new Set(ghosts), alive: (u: number) => !ghosts.includes(u) && !dead.includes(u) });

describe('plan diff', () => {
  it('keeps standing parts in place and order, queues the ones left out, appends the new ones as ghosts', () => {
    const bp = ship();
    expect(validate(bp).ok).toBe(true);
    const target = { ...bp, parts: [bp.parts[0], bp.parts[1], part(10, 'sq', 'hull', 2, 0), part(11, 'sq', 'cannon_pip', 2, -1, { facing: 'N' })] };
    const r = planDiff(validate, catalog, live(bp), target);
    if ('error' in r) throw new Error(r.error);
    expect(r.blueprint.parts.slice(0, 3)).toEqual(bp.parts);
    expect(r.blueprint.parts.slice(3).map((p) => p.uid)).toEqual([10, 11]);
    expect(r.ghosts).toEqual([10, 11]);
    expect(r.recycle).toEqual([2]);
    expect(r.waiting).toEqual([]);
    expect(validate(r.blueprint).ok).toBe(true);
  });

  it('a standing part moved gets a fresh uid (the old one recycled); one overlapping a recycled part waits', () => {
    const bp = ship(part(3, 'sq', 'hull', 2, 0));
    // Hull 3 moved to the left of the core; a hull where Pip 2 stands now
    const target = { ...bp, parts: [bp.parts[0], bp.parts[1], { ...bp.parts[3], x: -1 }, part(12, 'sq', 'hull', 1, -1)] };
    const r = planDiff(validate, catalog, live(bp), target);
    if ('error' in r) throw new Error(r.error);
    expect(r.recycle.sort()).toEqual([2, 3]);
    const moved = r.blueprint.parts.find((p) => p.x === -1 && p.y === 0)!;
    expect(moved.uid).not.toBe(3);
    expect(r.ghosts).toContain(moved.uid);
    expect(r.waiting.map((p) => p.uid)).toEqual([12]);
    expect(validate(r.blueprint).ok).toBe(true);
    // Pip 2 recycled: hull 12 joins
    const off = removeParts(validate, r.blueprint, new Set([2]), () => true)!;
    const p = promoteWaiting(validate, off.blueprint, r.waiting);
    expect(p.added).toEqual([12]);
    expect(validate(p.blueprint).ok).toBe(true);
  });

  it('a new part nothing joins yet waits; destroyed parts left out simply go', () => {
    const bp = ship(part(3, 'sq', 'hull', 2, 0));
    const target = { ...bp, parts: [bp.parts[0], bp.parts[1], bp.parts[2], part(20, 'sq', 'hull', 5, 5)] };
    const r = planDiff(validate, catalog, live(bp, [], [3]), target);
    if ('error' in r) throw new Error(r.error);
    expect(r.recycle).toEqual([]);
    expect(r.blueprint.parts.map((p) => p.uid)).toEqual([0, 1, 2]);
    expect(r.waiting.map((p) => p.uid)).toEqual([20]);
  });

  it('refuses a plan that moves or drops the core', () => {
    const bp = ship();
    expect(planDiff(validate, catalog, live(bp), { ...bp, parts: bp.parts.slice(1) })).toHaveProperty('error');
    expect(planDiff(validate, catalog, live(bp), { ...bp, parts: bp.parts.map((p) => (p.fn === 'core' ? { ...p, y: 3 } : p)) })).toHaveProperty('error');
  });

  it('taking a part out moves the unbuilt parts it held on into waiting, never a standing one', () => {
    const bp = ship(part(3, 'sq', 'hull', 2, 0), part(4, 'sq', 'hull', 3, 0));
    const r = removeParts(validate, bp, new Set([3]), (u) => u !== 4)!;
    expect(r.blueprint.parts.map((p) => p.uid)).toEqual([0, 1, 2]);
    expect(r.waiting.map((p) => p.uid)).toEqual([4]);
    expect(removeParts(validate, bp, new Set([3]), () => true)).toBeNull();
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
});
