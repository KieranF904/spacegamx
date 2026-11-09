import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadCatalog } from '../../ships/catalog.js';
import { parseBlueprint } from '../../ships/blueprint.js';
import { computeJoins, placeGeometry } from '../../ships/grid.js';
import { Economy } from '../economy.js';
import { partItemId } from '../items.js';
import {
  CORE_TIER, FIELD, canFabricate, canRefine, fabWork, attachWork, jobTicks, jobEu, recycleReturn, repairBill, repairWork, scaleBill, refineGrade, tierRule,
} from './rules.js';
import { bankPay, fieldPay, packDefs, packShare } from './packs.js';
import { nextFieldTarget, nextRearm, payCoreOutward, placeFinished, recycleCandidates, joinDepths, type FieldPartView } from './order.js';
import { BANK, bankCap, bankFill, bankFullIn, cleanBank, depositable, freeSpare, freeWhole, newBank, refillBank, spendDeposits, spendFree } from './bank.js';
import { jobAt, jobFraction, stepJob, type FieldJob } from './jobs.js';
import { cleanFieldRecord } from './record.js';

const data = join(__dirname, '../../../../data');
const json = (p: string) => JSON.parse(readFileSync(join(data, p), 'utf-8'));
const ships = loadCatalog({ pieces: json('ships/pieces.json'), functions: json('ships/functions.json'), materials: json('ships/materials.json'), models: json('ships/models.json') });
const starter = parseBlueprint(readFileSync(join(data, 'ships/blueprints/sparrow-t.json'), 'utf-8'));
const econ = new Economy(json('items.json'), json('recipes.json'), ships, { 'sparrow-t': starter });
const part = (fn: string, material = 'alloy', piece = 'sq') => ({ fn, material, piece });

describe('field rules: what each machine can make', () => {
  it('the core makes starter parts and the Field Fabricator, never itself', () => {
    expect(canFabricate(ships, CORE_TIER, part('cannon_pip'))).toBe(true);
    expect(canFabricate(ships, CORE_TIER, part('hull'))).toBe(true);
    expect(canFabricate(ships, CORE_TIER, part('fabricator_field', 'alloy', 'rect2'))).toBe(true);
    expect(canFabricate(ships, CORE_TIER, part('hull', 'steel'))).toBe(false);
    expect(canFabricate(ships, CORE_TIER, part('autocannon_rattler'))).toBe(false);
    expect(canFabricate(ships, CORE_TIER, part('refiner_field'))).toBe(false);
    for (let t = 0; t <= 3; t++) expect(canFabricate(ships, t, part('core', 'alloy', 'rect2'))).toBe(false);
  });

  it('tiers make parts up to their grade cap, and each tier can make the next', () => {
    expect(canFabricate(ships, 1, part('hull', 'steel'))).toBe(true);
    expect(canFabricate(ships, 1, part('hull', 'titanium'))).toBe(false);
    expect(canFabricate(ships, 1, part('fabricator_bay', 'steel', 'block2'))).toBe(true);
    expect(canFabricate(ships, 2, part('fabricator_forge', 'titanium', 'block2'))).toBe(true);
    expect(canFabricate(ships, 2, part('hull', 'cobalt'))).toBe(false);
    expect(canFabricate(ships, 3, part('hull', 'neutronium'))).toBe(true);
    // (Legacy functions, enemy parts, are never made)
    expect(canFabricate(ships, 3, part('thruster'))).toBe(false);
  });

  it('refiners by grade: the core alloy, a Field Refiner steel, a Smelter Forge anything', () => {
    expect(refineGrade(econ, 'alloy_plate')).toBe(1);
    expect(refineGrade(econ, 'steel_plate')).toBe(2);
    expect(refineGrade(econ, 'titanium_plate')).toBe(3);
    expect(canRefine(econ, 0, 'alloy_plate')).toBe(true);
    expect(canRefine(econ, 0, 'steel_plate')).toBe(false);
    expect(canRefine(econ, 1, 'steel_plate')).toBe(true);
    expect(canRefine(econ, 1, 'titanium_plate')).toBe(false);
    expect(canRefine(econ, 3, 'neutronium_plate')).toBe(true);
    expect(canRefine(econ, 3, 'no_such_recipe')).toBe(false);
  });

  it('speeds rise with tier and the core is the slowest', () => {
    for (const k of ['fabricator', 'refiner'] as const) for (let t = 1; t <= 3; t++) {
      expect(tierRule(k, t).speed).toBeGreaterThan(tierRule(k, t - 1).speed);
      expect(tierRule(k, t).gradeCap).toBeGreaterThanOrEqual(tierRule(k, t - 1).gradeCap);
    }
  });
});

describe('field rules: work, costs and time', () => {
  it('a part takes fabrication then attachment; bigger and higher grade takes longer', () => {
    expect(fabWork(econ, part('cannon_pip'))).toBe(FIELD.fabSecondsPerCell);
    expect(fabWork(econ, part('hull', 'alloy', 'rect2'))).toBeGreaterThan(fabWork(econ, part('hull')));
    expect(fabWork(econ, part('hull', 'titanium'))).toBeGreaterThan(fabWork(econ, part('hull', 'steel')));
    expect(attachWork(ships, part('hull', 'alloy', 'rect2'))).toBe(2 * FIELD.attachSecondsPerCell);
  });

  it('ticks follow speed, and packs make it 60% faster', () => {
    expect(jobTicks(6, 1)).toBe(360);
    expect(jobTicks(6, 0.25)).toBe(1440);
    expect(jobTicks(6, 1, 1)).toBe(Math.ceil(360 / 1.6));
    expect(jobTicks(0, 1)).toBe(0);
    expect(jobEu(6, 1, 10)).toBe(3600);
  });

  it('recycling gives back half, in whole units (largest remainders)', () => {
    expect(scaleBill({ alloy_plate: 2, copper_wire: 1 }, 0.5)).toEqual({ alloy_plate: 1, copper_wire: 1 });
    expect(scaleBill({ a: 3, b: 3 }, 0.5)).toEqual({ a: 2, b: 1 });
    const back = recycleReturn(econ, part('cannon_pip'));
    const total = Object.values(back).reduce((s, n) => s + n, 0);
    expect(total).toBe(Math.round(3 * FIELD.recycleReturn + 1e-9));
  });

  it('repairs cost by the HP missing, at least one unit', () => {
    expect(repairBill(econ, part('hull'), 0)).toEqual({});
    const small = repairBill(econ, part('cannon_pip'), 0.05);
    expect(Object.values(small).reduce((s, n) => s + n, 0)).toBe(1);
    expect(repairBill(econ, part('cannon_pip'), 1)).toEqual(scaleBill(econ.recipes.partInputs(part('cannon_pip')), FIELD.repairCost));
  });

  it("mending the core is free (the bank cap leaves its inputs out) and takes an ordinary part's time", () => {
    const core = part('core', 'alloy', 'rect2');
    expect(repairBill(econ, core, 1)).toEqual({});
    expect(repairWork(econ, core, 0.5)).toBeGreaterThan(0);
    expect(repairWork(econ, core, 0.5)).toBeLessThan(fabWork(econ, core) * FIELD.repairTime * 0.5);
  });
});

describe('packs', () => {
  const packs = packDefs(econ.items);

  it('every pack is six materials, and is made from exactly them at a station', () => {
    expect(packs.length).toBeGreaterThanOrEqual(6);
    for (const p of packs) {
      expect(Object.values(p.covers).reduce((s, n) => s + n, 0)).toBe(6);
      expect(econ.recipes.craft.get(p.id)?.inputs).toEqual(p.covers);
      for (const id of Object.keys(p.covers)) expect(econ.items.has(id)).toBe(true);
    }
  });

  it('in the field a pack pays one unit; fill uses loose first, prefer packs first', () => {
    const hold: Record<string, number> = { alloy_plate: 1, pack_hull: 5 };
    const have = (id: string) => hold[id] ?? 0;
    const need = { alloy_plate: 3 };
    expect(fieldPay(need, have, packs, 'off').short).toEqual({ alloy_plate: 2 });
    const fill = fieldPay(need, have, packs, 'fill');
    expect(fill).toMatchObject({ take: { alloy_plate: 1 }, packs: { pack_hull: 2 }, packUnits: 2, units: 3, short: {} });
    const prefer = fieldPay(need, have, packs, 'prefer');
    expect(prefer).toMatchObject({ take: {}, packs: { pack_hull: 3 }, packUnits: 3, short: {} });
    expect(packShare(prefer)).toBe(1);
    expect(packShare(fill)).toBeCloseTo(2 / 3);
  });

  it('in the bank a pack gives all it can to the part, and the rest is wasted', () => {
    const r = bankPay({ alloy_plate: 2, copper_wire: 1 }, { pack_hull: 3, copper_wire: 1 }, packs);
    expect(r.used).toEqual({ copper_wire: 1, pack_hull: 1 });
    expect(r.paid).toEqual({ copper_wire: 1, alloy_plate: 2 });
    expect(r.wasted).toEqual({ composite_sheet: 2, steel_plate: 2 });
    expect(r.short).toEqual({});
    // (Nothing to pay with: short, nothing used)
    expect(bankPay({ titanium_plate: 1 }, { pack_hull: 3 }, packs)).toMatchObject({ used: {}, short: { titanium_plate: 1 } });
  });
});

describe('job order and placement', () => {
  const geoms = starter.parts.map((p) => placeGeometry(ships, p));
  const joins = computeJoins(geoms);
  const n = starter.parts.length;
  const root = starter.parts.findIndex((p) => p.fn === 'core');
  const view = (f: (i: number) => Partial<FieldPartView>): FieldPartView[] =>
    starter.parts.map((_, i) => ({ alive: true, missing: 0, wanted: false, recycle: false, blocked: false, makeable: true, ...f(i) }));

  it('damaged first, then recycling, then missing parts nearest the core', () => {
    const depth = joinDepths(n, root, joins);
    const far = [...depth.keys()].sort((a, b) => depth[b] - depth[a])[0];
    expect(nextFieldTarget(n, root, joins, view((i) => (i === far ? { missing: 0.5 } : {})))).toEqual({ kind: 'repair', part: far });
    const gone = view((i) => (i === far ? { alive: false, wanted: true } : {}));
    expect(nextFieldTarget(n, root, joins, gone)).toEqual({ kind: 'build', part: far });
    expect(nextFieldTarget(n, root, joins, view(() => ({})))).toBeNull();
  });

  it('a planned part nothing joins to the core is never picked; payCoreOutward passes it by too', () => {
    // (One more part, far from the rest: joined to nothing)
    const nn = n + 1;
    const lone = (i: number) => i === n;
    const v: FieldPartView[] = [...view(() => ({})), { alive: false, missing: 0, wanted: true, recycle: false, blocked: false, makeable: true }];
    expect(nextFieldTarget(nn, root, joins, v)).toBeNull();
    const built = Array.from({ length: nn }, (_, i) => !lone(i));
    expect(payCoreOutward(nn, root, joins, built, lone, () => ({ alloy_plate: 1 }), { alloy_plate: 9 }).paid).toEqual([]);
  });

  it('a missing part waits while nothing standing joins it', () => {
    const v = view((i) => (i === root ? {} : { alive: false, wanted: true }));
    const t = nextFieldTarget(n, root, joins, v);
    expect(t?.kind).toBe('build');
    expect(joinDepths(n, root, joins)[t!.part]).toBe(1);
  });

  it('recycling never strands a standing part; leaves go first; never the core', () => {
    const alive = starter.parts.map(() => true);
    const all = recycleCandidates(n, root, joins, alive, starter.parts.map(() => true));
    expect(all).not.toContain(root);
    const depth = joinDepths(n, root, joins);
    for (let k = 1; k < all.length; k++) expect(depth[all[k - 1]]).toBeGreaterThanOrEqual(depth[all[k]]);
    // Just the core's neighbours queued: each one that holds something else up must wait
    const holds = joins.filter(([a, b]) => a === root || b === root).map(([a, b]) => (a === root ? b : a));
    const queued = starter.parts.map((_, i) => holds.includes(i));
    for (const r of recycleCandidates(n, root, joins, alive, queued)) {
      const left = starter.parts.map((_, i) => i !== r);
      const reach = new Set([root]);
      for (let grow = true; grow;) { grow = false; for (const [a, b] of joins) for (const [x, y] of [[a, b], [b, a]]) if (reach.has(x) && left[y] && !reach.has(y)) { reach.add(y); grow = true; } }
      for (let i = 0; i < n; i++) if (i !== r) expect(reach.has(i)).toBe(true);
    }
  });

  it('a finished part: its own spot if open and joined, else another wanting it, else the hold', () => {
    const item = partItemId(part('cannon_pip'));
    expect(placeFinished(item, 1, [{ part: 1, item, open: true, joined: true }])).toEqual({ to: 'spot', part: 1 });
    expect(placeFinished(item, 1, [{ part: 1, item, open: true, joined: false }, { part: 2, item, open: true, joined: true }])).toEqual({ to: 'spot', part: 2 });
    expect(placeFinished(item, 1, [{ part: 1, item, open: true, joined: false }, { part: 2, item: 'other', open: true, joined: true }])).toEqual({ to: 'cargo' });
    expect(placeFinished(item, 1, [])).toEqual({ to: 'cargo' });
  });

  it('a respawn pays core outward while the purse lasts', () => {
    const built = starter.parts.map((_, i) => i === root);
    const bill = (i: number) => econ.recipes.partInputs(starter.parts[i]);
    const full = payCoreOutward(n, root, joins, built, (i) => i !== root, bill, bankCap(econ, starter));
    expect(full.paid.length).toBe(n - 1);
    const none = payCoreOutward(n, root, joins, built, (i) => i !== root, bill, {});
    expect(none.paid).toEqual([]);
    const depth = joinDepths(n, root, joins);
    const some = payCoreOutward(n, root, joins, built, (i) => i !== root, bill, { alloy_plate: 3, copper_wire: 2 });
    for (const i of some.paid) expect(depth[i]).toBeGreaterThan(0);
    expect(some.paid.length).toBeGreaterThan(0);
    expect(some.paid.length).toBeLessThan(n - 1);
  });
});

describe('the repair bank', () => {
  const cap = bankCap(econ, starter);

  it('holds a starter ship (but its core) and starts full', () => {
    expect(Object.keys(cap).length).toBeGreaterThan(0);
    const b = newBank(cap, 0);
    expect(bankFill(b, cap)).toBe(1);
    expect(bankFullIn(b, cap)).toBe(0);
  });

  it('refills by itself, up to its cap, at its pace', () => {
    const b = newBank(cap, 0);
    for (const id of Object.keys(b.free)) b.free[id] = 0;
    refillBank(b, cap, (BANK.refillSeconds * 1000) / 2);
    expect(bankFill(b, cap)).toBeCloseTo(0.5);
    refillBank(b, cap, BANK.refillSeconds * 1000 * 5);
    expect(bankFill(b, cap)).toBe(1);
    for (const [id, c] of Object.entries(cap)) expect(b.free[id]).toBe(c);
  });

  it('spends whole units, all or nothing; only its top quarter pays repairs', () => {
    const b = newBank(cap, 0);
    const id = Object.keys(cap).sort((x, y) => cap[y] - cap[x])[0];
    expect(freeSpare(b, cap)[id]).toBe(Math.floor(cap[id] * BANK.spareShare + 1e-9));
    expect(spendFree(b, { [id]: cap[id] + 1 })).toBe(false);
    expect(spendFree(b, { [id]: 1 })).toBe(true);
    expect(freeWhole(b)[id]).toBe(cap[id] - 1);
  });

  it('deposits: packs, refined materials and components only; spent all or nothing', () => {
    expect(depositable(econ, 'pack_hull')).toBe(true);
    expect(depositable(econ, 'steel_plate')).toBe(true);
    expect(depositable(econ, 'iron_ore')).toBe(false);
    expect(depositable(econ, partItemId(part('cannon_pip')))).toBe(false);
    const b = newBank(cap, 0);
    b.deposits = { pack_hull: 2 };
    expect(spendDeposits(b, { pack_hull: 3 })).toBe(false);
    expect(spendDeposits(b, { pack_hull: 2 })).toBe(true);
    expect(b.deposits).toEqual({});
  });

  it('a saved bank is cleaned, never trusted', () => {
    expect(cleanBank(null)).toBeUndefined();
    expect(cleanBank({ free: { alloy_plate: 2.5, x: -1, y: 'a' }, deposits: { pack_hull: 2.7 }, at: 5 })).toEqual({ free: { alloy_plate: 2.5 }, deposits: { pack_hull: 2 }, at: 5 });
  });
});

describe('jobs', () => {
  const job = (): FieldJob => ({ id: 1, kind: 'build', uid: 3, item: 'x', held: {}, need: 100, done: 0, attachNeed: 50, attachDone: 0, phase: 'make', packShare: 0 });

  it('make then attach, with the leftover returned only when done', () => {
    const j = job();
    expect(stepJob(j, 60)).toBe(0);
    expect(j.phase).toBe('make');
    expect(stepJob(j, 60)).toBe(0);
    expect(j).toMatchObject({ phase: 'attach', done: 100, attachDone: 20 });
    expect(stepJob(j, 40)).toBe(10);
    expect(j.phase).toBe('done');
    expect(jobFraction(j)).toBe(1);
  });

  it('a part from the hold starts at attach; the client works progress out from the clock', () => {
    const j: FieldJob = { ...job(), need: 0, phase: 'attach' };
    const now = jobAt(j, 1000, 1025);
    expect(now).toMatchObject({ phase: 'attach', attachDone: 25 });
    expect(j.attachDone).toBe(0);
  });
});

describe('saved field state', () => {
  it('a ship record keeps its field work, cleaned; a profile keeps its bank', async () => {
    const { cleanFieldRecord } = await import('./record.js');
    const { migrateProfile, newProfile, starterKit } = await import('../profile.js');
    expect(cleanFieldRecord(undefined)).toEqual({});
    expect(cleanFieldRecord({ fabOn: true, packs: 'bogus', recycle: [3, 3, 'x'], held: { alloy_plate: 2.9, bad: 0 }, waiting: [{ uid: 9 }] }))
      .toEqual({ field: { fabOn: true, recycle: [3], held: { alloy_plate: 2 } } });
    const kit = starterKit(starter);
    const p = newProfile(kit);
    p.ship.field = { refOn: true, packs: 'fill', recipe: 'alloy_plate' };
    p.bank = { free: { alloy_plate: 3.5 }, deposits: { pack_hull: 1 }, at: 7 };
    const back = migrateProfile(JSON.parse(JSON.stringify(p)), kit, ships, { econ });
    expect(back.ship.field).toEqual({ refOn: true, packs: 'fill', recipe: 'alloy_plate' });
    expect(back.bank).toEqual({ free: { alloy_plate: 3.5 }, deposits: { pack_hull: 1 }, at: 7 });
  });
});

describe('field fabrication: rearming Mine Bays', () => {
  const bays = [{ uid: 5, capacity: 12 }, { uid: 9, capacity: 12 }];
  it('picks the bay that lacks the most (ties: part order), a job of at most perJob', () => {
    expect(nextRearm(bays, undefined, 4)).toEqual({ uid: 5, count: 4 });
    expect(nextRearm(bays, { 5: 10, 9: 4 }, 4)).toEqual({ uid: 9, count: 4 });
    expect(nextRearm(bays, { 5: 11, 9: 12 }, 4)).toEqual({ uid: 5, count: 1 });
    expect(nextRearm(bays, { 5: 12, 9: 99 }, 4)).toBeNull();
    expect(nextRearm([], undefined, 4)).toBeNull();
  });
  it('magazines are saved with the record, cleaned', () => {
    expect(cleanFieldRecord({ mines: { 5: 8, 9: 0, x: 3, 7: 2.7, 8: 'a', 11: 500 } })).toEqual({ field: { mines: { 5: 8, 7: 2, 11: 64 } } });
    expect(cleanFieldRecord({ mines: [] })).toEqual({});
  });
});
