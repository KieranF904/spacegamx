/**
 * The v6 field update (fieldUpdate.ts, run by profile.ts migrateProfile): repair kits and insurance bonds become repair-bank
 * deposits, loaners go, the free part starts full, the quick bar's kit slots clear, one notice. Idempotent; junk never throws.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadCatalog } from '../ships/catalog.js';
import { parseBlueprint } from '../ships/blueprint.js';
import { registerAmmo } from '../ships/launch.js';
import type { Blueprint } from '../ships/types.js';
import { Economy } from './economy.js';
import { countOf } from './stacks.js';
import { migrateProfile, newProfile, PROFILE_VERSION, starterKit, type ShipRecord, type PlayerProfile } from './profile.js';
import { fieldUpdate, RETIRED_KITS, isRetiredKit } from './fieldUpdate.js';
import { bankCap, freeWhole } from './field/bank.js';

const data = join(__dirname, '../../../data');
const json = (p: string) => JSON.parse(readFileSync(join(data, p), 'utf-8'));
const catalog = loadCatalog({ pieces: json('ships/pieces.json'), functions: json('ships/functions.json'), materials: json('ships/materials.json'), models: json('ships/models.json') });
const plans: Record<string, Blueprint> = Object.fromEntries(readdirSync(join(data, 'ships/blueprints')).filter((n) => n.endsWith('.json')).map((f) => [f.slice(0, -5), parseBlueprint(readFileSync(join(data, 'ships/blueprints', f), 'utf-8'))]));
const items = json('items.json');
registerAmmo(items.items);
const econ = new Economy(items, json('recipes.json'), catalog, plans);
const kit = starterKit(plans['sparrow-t']);
const NOW = 1_700_000_000_000;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const rec = (extra: Partial<ShipRecord> = {}): ShipRecord => ({ blueprint: clone(plans['sparrow-t']), hp: {}, ghosts: [], plan: 'sparrow-t', ...extra });

/** A profile as v5 wrote it: kits and bonds about, flying the ship in slot `active` */
function v5(hangar: (ShipRecord | null)[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const p = clone(newProfile(kit)) as unknown as Record<string, unknown>;
  const slots = [...hangar];
  while (slots.length < 5) slots.push(null);
  const active = typeof extra.activeSlot === 'number' ? extra.activeSlot : 0;
  return { ...p, version: 5, hangar: slots, ship: slots[active], activeSlot: active, ...extra };
}
const migrate = (raw: unknown) => migrateProfile(clone(raw), kit, catalog, { econ, now: NOW });

describe('the retired kits', () => {
  it('every kit and bond has the inputs its recipe had, and none is an item any more', () => {
    expect(RETIRED_KITS.repair_kit).toEqual({ alloy_plate: 2, copper_wire: 2 });
    expect(RETIRED_KITS.insurance_bond).toEqual({ steel_plate: 6, scrap_electronics: 4 });
    for (const id of Object.keys(RETIRED_KITS)) {
      expect(isRetiredKit(id)).toBe(true);
      expect(econ.items.has(id)).toBe(false);
      expect(econ.recipes.recipeFor(id)).toBeNull();
      for (const input of Object.keys(RETIRED_KITS[id])) expect(econ.items.has(input)).toBe(true);
    }
    expect(isRetiredKit('pack_hull')).toBe(false);
    expect(isRetiredKit(undefined)).toBe(false);
  });

  it('a new pilot starts with Hull Packs, not repair kits', () => {
    const p = newProfile(kit);
    expect(countOf(p.storage, 'pack_hull')).toBe(2);
    expect(countOf(p.storage, 'repair_kit')).toBe(0);
    expect(p.quickbar).not.toContain('repair_kit');
    expect(p.version).toBe(PROFILE_VERSION);
  });
});

describe('v6 field update', () => {
  it('kits and bonds in storage and the hold become deposits (their craft inputs); the free part starts full', () => {
    const raw = v5([rec()], {
      storage: [{ id: 'repair_kit', n: 2 }, { id: 'insurance_bond', n: 1 }, { id: 'iron_ore', n: 5 }],
      cargo: [{ id: 'field_repair_kit', n: 1 }, { id: 'nanite_repair_kit', n: 1 }],
    });
    const p = migrate(raw);
    expect(p.version).toBe(6);
    expect(p.bank!.deposits).toEqual({
      alloy_plate: 4, copper_wire: 4 + 4, steel_plate: 6 + 3, scrap_electronics: 4, servo_motor: 1 + 1, titanium_plate: 2, crystal_lens: 1, power_coupling: 1,
    });
    expect([...p.storage, ...p.cargo].some((s) => isRetiredKit(s.id))).toBe(false);
    expect(countOf(p.storage, 'iron_ore')).toBe(5);
    expect(freeWhole(p.bank!)).toEqual(bankCap(econ, kit.blueprint));
    expect(p.bank!.at).toBe(NOW);
    expect(p.notices!.at(-1)!.text).toBe('Repair kits and insurance are gone: 5 items moved into your repair bank');
  });

  it('an existing bank is kept, and its deposits added to', () => {
    const bank = { free: { alloy_plate: 3 }, deposits: { copper_wire: 1 }, at: 5 };
    const p = migrate(v5([rec()], { bank, storage: [{ id: 'repair_kit', n: 1 }] }));
    expect(p.bank!.free).toEqual({ alloy_plate: 3 });
    expect(p.bank!.at).toBe(5);
    expect(p.bank!.deposits).toEqual({ copper_wire: 3, alloy_plate: 2 });
  });

  it('the quick bar loses its kit slots', () => {
    const p = migrate(v5([rec()], { quickbar: ['repair_kit', 'boost_cell', 'insurance_bond', 'nanite_repair_kit', null] }));
    expect(p.quickbar).toEqual([null, 'boost_cell', null, null, null]);
  });

  it('kits being crafted give their inputs for the runs not yet delivered; kit orders go', () => {
    const job = (recipe: string, count: number, done: number) => ({ id: 1, recipe, station: 'x', out: { [recipe]: 1 }, count, done, unitMs: 1000, startedAt: 0, readyAt: 1000 });
    const p = migrate(v5([rec()], { jobs: [job('repair_kit', 3, 1), job('alloy_plate', 2, 0)], fabOrders: [{ id: 1, item: 'repair_kit', n: 2, made: 0 }, { id: 2, item: 'alloy_plate', n: 2, made: 0 }] }));
    expect(p.bank!.deposits).toEqual({ alloy_plate: 4, copper_wire: 4 });
    expect(p.jobs.map((j) => j.recipe)).toEqual(['alloy_plate']);
    expect(p.fabOrders!.map((o) => o.item)).toEqual(['alloy_plate']);
  });

  it('a flown loaner gives way to the lost ship: lost cleared, ghosts kept (the core free, owed to the bank); loaner records go', () => {
    const lost = rec({ lost: true, auto: true, rank: 1 });
    const core = lost.blueprint.parts.find((q) => q.fn === 'core')!;
    lost.ghosts = [core.uid, ...lost.blueprint.parts.filter((q) => q !== core).map((q) => q.uid)];
    const loaner = rec({ loaner: true });
    const p = migrate(v5([lost, loaner], { activeSlot: 1 }));
    expect(p.hangar.some((r) => r?.loaner)).toBe(false);
    expect(p.hangar[1]).toBeNull();
    expect(p.ship).toBe(p.hangar[0]);
    expect(p.activeSlot).toBe(0);
    expect(p.ship.lost).toBeUndefined();
    expect(p.ship.auto).toBeUndefined();
    expect(p.ship.ghosts).toEqual(lost.blueprint.parts.filter((q) => q !== core).map((q) => q.uid));
    expect(p.ship.owed).toEqual(p.ship.ghosts);
    expect(p.ship.hp).toEqual({});
  });

  it('a flown loaner with no lost ship gives way to a fresh starter', () => {
    const p = migrate(v5([rec({ loaner: true })], { activeSlot: 0 }));
    expect(p.hangar.filter((r) => r?.loaner)).toHaveLength(0);
    expect(p.ship.blueprint).toEqual(kit.blueprint);
    expect(p.ship.loaner).toBeUndefined();
    expect(p.hangar[p.activeSlot]).toBe(p.ship);
  });

  it('a loaner that is not flown just goes', () => {
    const mine = rec();
    const p = migrate(v5([mine, rec({ loaner: true })], { activeSlot: 0 }));
    expect(p.hangar.some((r) => r?.loaner)).toBe(false);
    expect(p.ship).toBe(p.hangar[0]);
  });

  it('is idempotent: run again, nothing changes (no second notice, no second deposit)', () => {
    const raw = v5([rec({ loaner: true })], { storage: [{ id: 'repair_kit', n: 2 }], cargo: [] });
    const p = migrate(raw);
    const once = clone(p);
    fieldUpdate(p, econ, kit, NOW + 99999);
    expect(p).toEqual(once);
    // And as a saved profile at v6 it is left alone by migrateProfile
    const again = migrateProfile(clone(once), kit, catalog, { econ, now: NOW + 5 });
    expect(again).toEqual(once);
  });

  it('a save without the economy waits at v5', () => {
    const p = migrateProfile(clone(v5([rec()], { storage: [{ id: 'repair_kit', n: 1 }] })), kit, catalog);
    expect(p.version).toBe(5);
    expect(countOf(p.storage, 'repair_kit')).toBe(1);
  });

  it('junk never throws', () => {
    const junk = [
      v5([rec()], { storage: [null, 7, { id: 'repair_kit', n: 'lots' }, { id: 'repair_kit', n: -3 }, { id: 5, n: 1 }], cargo: 'no', jobs: [null, { recipe: 'repair_kit', count: 'x' }], fabOrders: [null, 3], quickbar: 'x', bank: 'nope' }),
      v5([rec()], { hangar: [null, 3, { loaner: true }, 'x'], roster: [null, { loaner: true }], activeSlot: 99 }),
      v5([]),
      { version: 5 },
    ];
    for (const raw of junk) {
      expect(() => migrate(raw)).not.toThrow();
      const p = migrate(raw);
      expect(p.version).toBe(6);
      expect(p.bank).toBeDefined();
    }
    const direct = clone(newProfile(kit)) as unknown as PlayerProfile;
    (direct as unknown as Record<string, unknown>).jobs = undefined;
    (direct as unknown as Record<string, unknown>).hangar = undefined;
    expect(() => fieldUpdate(direct, econ, kit, Number.NaN)).not.toThrow();
  });
});
