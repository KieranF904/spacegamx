import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadCatalog } from '../ships/catalog.js';
import { parseBlueprint } from '../ships/blueprint.js';
import type { Blueprint } from '../ships/types.js';
import { Economy } from './economy.js';
import { partItemId } from './items.js';
import { addTo, removeFrom, removeAll, shortfall, cleanStacks, countOf } from './stacks.js';
import { newProfile, migrateProfile, PROFILE_VERSION, StarterKit } from './profile.js';

const data = join(__dirname, '../../../data');
const json = (p: string) => JSON.parse(readFileSync(join(data, p), 'utf-8'));
const ships = loadCatalog({ pieces: json('ships/pieces.json'), functions: json('ships/functions.json'), materials: json('ships/materials.json'), models: json('ships/models.json') });
const plans: Record<string, Blueprint> = {};
for (const f of readdirSync(join(data, 'ships/blueprints')).filter((n) => n.endsWith('.json'))) plans[f.slice(0, -5)] = parseBlueprint(readFileSync(join(data, 'ships/blueprints', f), 'utf-8'));
const econ = new Economy(json('items.json'), json('recipes.json'), ships, plans);

describe('item catalogue', () => {
  it('has every listed item and a part for every allowed combination (ship plans are not items)', () => {
    expect(econ.items.get('iron_ore')?.category).toBe('mineral');
    expect(econ.items.get('part:alloy:hull:sq')?.category).toBe('part');
    expect(econ.items.get('part:steel:armor:block2')?.part).toEqual({ material: 'steel', fn: 'armor', piece: 'block2' });
    // A model is one item a piece it comes in, in its own material
    expect(econ.items.get('part:alloy:engine_ion_drive:sq')?.part).toEqual({ material: 'alloy', fn: 'engine_ion_drive', piece: 'sq' });
    expect(econ.items.get('part:alloy:engine_ion_drive:sq')?.name).toBe('Ion Drive');
    expect(econ.items.has('part:steel:engine_ion_drive:sq')).toBe(false);
    expect(econ.items.has('part:alloy:engine_ion_drive:rect2')).toBe(false);
    expect(econ.items.has('part:steel:plating_reactive_armour:sq') && econ.items.has('part:steel:plating_reactive_armour:rect2')).toBe(true);
    // The legacy functions models replaced are never items (enemies still fly them: their salvage comes as models)
    expect(econ.items.has('part:alloy:thruster:sq')).toBe(false);
    expect(econ.items.has('part:steel:conduit:sq')).toBe(false);
    // Hull can't be a bespoke boss piece, so there's no such part
    expect([...econ.ships.pieces.values()].some((pc) => pc.bespoke && econ.items.has(`part:alloy:hull:${pc.id}`))).toBe(false);
    expect(econ.items.has('plan:lancer')).toBe(false);
  });

  it('every item referenced by recipes, drops and quests exists', () => {
    const recipes = json('recipes.json');
    const ids = new Set<string>();
    for (const r of recipes.refining) { ids.add(r.id); Object.keys(r.inputs).forEach((i) => ids.add(i)); }
    for (const r of recipes.craft) { Object.keys(r.inputs).forEach((i) => ids.add(i)); Object.keys(r.out).forEach((i) => ids.add(i)); }
    for (const f of Object.values(json('factions.json').factions) as { loot?: { item: string }[] }[]) for (const l of f.loot ?? []) ids.add(l.item);
    for (const id of ids) expect(econ.items.has(id), id).toBe(true);
  });

  it('prices parts from what they cost to make', () => {
    const hull = econ.items.get('part:alloy:hull:sq')!.value;
    const armor = econ.items.get('part:alloy:armor:sq')!.value;
    const big = econ.items.get('part:alloy:hull:block3')!.value;
    expect(hull).toBeGreaterThan(0);
    expect(armor).toBeGreaterThan(hull);
    expect(big).toBeGreaterThan(hull);
  });
});

describe('recipes and costs', () => {
  it('a part costs plates of its material per cell, plus its function\'s extras; a model its own recipe', () => {
    expect(econ.recipes.partInputs({ material: 'alloy', fn: 'hull', piece: 'sq' })).toEqual({ alloy_plate: 1 });
    expect(econ.recipes.partInputs({ material: 'steel', fn: 'armor', piece: 'rect2' })).toEqual({ steel_plate: 4 });
    // (A legacy part, as an enemy's salvage is worked out)
    expect(econ.recipes.partInputs({ material: 'alloy', fn: 'generator', piece: 'sq' })).toEqual({ alloy_plate: 1, copper_wire: 2 });
    const models = json('recipes.json').models;
    expect(econ.recipes.partInputs({ material: 'alloy', fn: 'cannon_pip', piece: 'sq' })).toEqual(models.cannon_pip.inputs);
    expect(econ.recipes.recipeFor('part:steel:cannon_twinlink:rect2')!.inputs).toEqual(models.cannon_twinlink.inputs);
    // Plating comes in two sizes: per cell
    const plate = models.plating_reactive_armour.inputs;
    expect(econ.recipes.partInputs({ material: 'steel', fn: 'plating_reactive_armour', piece: 'rect2' }).steel_plate).toBe(plate.steel_plate * 2);
    // Never in another material, never a legacy part
    expect(econ.recipes.recipeFor('part:steel:cannon_pip:sq')).toBeNull();
    expect(econ.recipes.recipeFor('part:alloy:thruster:sq')).toBeNull();
    // The new components are made from what the spec says
    expect(econ.recipes.recipeFor('wire_spool')!.inputs).toEqual({ copper_wire: 4, insulated_polymer: 1 });
    expect(econ.items.get('barrel_assembly')?.category).toBe('component');
  });

  it('refined materials expand back to their ores', () => {
    expect(econ.recipes.raw({ alloy_plate: 2 })).toEqual({ iron_ore: 4, nickel_ore: 2 });
    expect(econ.recipes.raw({ copper_wire: 4 })).toEqual({ copper_ore: 2 });
  });

  it('a rebuild bill is a share of the common minerals only, never components', () => {
    const core = econ.recipes.rebuildCost({ material: 'alloy', fn: 'core', piece: 'rect2' }, econ.items);
    expect(Object.keys(core).length).toBeGreaterThan(0);
    for (const id of Object.keys(core)) expect(econ.items.get(id)!.category).toBe('mineral');
    expect(core.power_coupling).toBeUndefined();
    const full = econ.recipes.rebuildCost({ material: 'alloy', fn: 'core', piece: 'rect2' }, econ.items, 1);
    expect(core.iron_ore).toBeLessThan(full.iron_ore);
  });

  it('small parts are instant to fabricate; big ones and cores take time', () => {
    expect(econ.recipes.recipeFor('part:alloy:hull:sq')!.time).toBe(0);
    expect(econ.recipes.recipeFor('part:alloy:hull:block3')!.time).toBeGreaterThan(0);
    expect(econ.recipes.recipeFor('part:alloy:core:rect2')!.time).toBeGreaterThan(econ.recipes.recipeFor('part:alloy:hull:rect2')!.time);
    expect(econ.recipes.recipeFor('pack_hull')!.time).toBeGreaterThan(0);
    expect(econ.recipes.recipeFor('repair_kit')).toBeNull();
    expect(econ.recipes.recipeFor('nonsense')).toBeNull();
  });

  it('a design lists the parts it uses', () => {
    const bag = econ.designParts(plans['sparrow-t']);
    expect(bag[partItemId({ material: 'alloy', fn: 'core', piece: 'rect2' })]).toBe(1);
    expect(Object.values(bag).reduce((a, b) => a + b, 0)).toBe(plans['sparrow-t'].parts.length);
  });
});

describe('stacks', () => {
  it('add, remove, pay a bill all or nothing, and report shortfalls', () => {
    const l: { id: string; n: number }[] = [];
    addTo(l, 'iron_ore', 5);
    addTo(l, 'iron_ore', 3);
    expect(countOf(l, 'iron_ore')).toBe(8);
    expect(removeFrom(l, 'iron_ore', 10)).toBe(8);
    expect(l).toEqual([]);
    addTo(l, 'iron_ore', 4);
    expect(removeAll(l, { iron_ore: 3, nickel_ore: 1 })).toBe(false);
    expect(countOf(l, 'iron_ore')).toBe(4);
    expect(shortfall(l, { iron_ore: 6, nickel_ore: 1 })).toEqual({ iron_ore: 2, nickel_ore: 1 });
    expect(cleanStacks([{ id: 'a', n: 2 }, { id: 'a', n: 1.7 }, { id: 'b', n: -1 }] as any)).toEqual([{ id: 'a', n: 3 }]);
  });
});

describe('profiles', () => {
  const kit: StarterKit = { blueprint: plans['sparrow-t'], planFile: 'sparrow-t', credits: 300, storage: { iron_ore: 10 }, home: 'sol_station_central', position: { system: 'sol', x: 1, y: 2 } };

  it('a new pilot starts with the starter kit and only the Sparrow plan', () => {
    const p = newProfile(kit);
    expect(p.version).toBe(PROFILE_VERSION);
    expect(p.plans).toEqual(['sparrow-t']);
    expect(p.storage).toEqual([{ id: 'iron_ore', n: 10 }]);
    expect(p.ship.blueprint.name).toBe('Sparrow T');
  });

  it('migration keeps good fields, repairs broken ones, and never throws', () => {
    const saved = { ...newProfile(kit), credits: 999, cargo: [{ id: 'crystal', n: 2 }, { id: 'x', n: 'lots' }], plans: 'nope', position: { system: 'borealis', x: 5, y: 6 } };
    const p = migrateProfile(JSON.parse(JSON.stringify(saved)), kit);
    expect(p.credits).toBe(999);
    expect(p.cargo).toEqual([{ id: 'crystal', n: 2 }]);
    expect(p.plans).toEqual(['sparrow-t']);
    expect(p.position).toEqual({ system: 'borealis', x: 5, y: 6 });
    expect(migrateProfile(null, kit).credits).toBe(300);
    expect(migrateProfile('garbage', kit).plans).toEqual(['sparrow-t']);
  });
});
