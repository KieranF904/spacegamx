/**
 * The v5 ship wipe (profile.ts migrateProfileShips): every ship broken down into storage, a fresh starter.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadCatalog } from '../ships/catalog.js';
import { parseBlueprint } from '../ships/blueprint.js';
import type { Blueprint, PlacedPart } from '../ships/types.js';
import { Economy } from './economy.js';
import { salvageParts } from './salvage.js';
import { countOf, type Bag } from './stacks.js';
import { migrateProfile, newProfile, PROFILE_VERSION, starterKit, type ShipRecord, type ShipWipeReport } from './profile.js';

const data = join(__dirname, '../../../data');
const json = (p: string) => JSON.parse(readFileSync(join(data, p), 'utf-8'));
const catalog = loadCatalog({ pieces: json('ships/pieces.json'), functions: json('ships/functions.json'), materials: json('ships/materials.json'), models: json('ships/models.json') });
const plans: Record<string, Blueprint> = {};
for (const f of readdirSync(join(data, 'ships/blueprints')).filter((n) => n.endsWith('.json'))) plans[f.slice(0, -5)] = parseBlueprint(readFileSync(join(data, 'ships/blueprints', f), 'utf-8'));
const econ = new Economy(json('items.json'), json('recipes.json'), catalog, plans);
const kit = starterKit(plans['sparrow-t']);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const rec = (plan: string, extra: Partial<ShipRecord> = {}): ShipRecord => ({ blueprint: clone(plans[plan]), hp: {}, ghosts: [], plan, ...extra });

/** A v4 save as the game wrote it, with these hangar slots (the first is flown) */
function v4(hangar: (ShipRecord | null)[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const p = clone(newProfile(kit)) as unknown as Record<string, unknown>;
  const slots = [...hangar];
  while (slots.length < 5) slots.push(null);
  return { ...p, version: 4, xp: 5000, credits: 777, hangar: slots, ship: slots[0], activeSlot: 0, storage: [{ id: 'iron_ore', n: 3 }], ...extra };
}

function wipe(raw: unknown) {
  let report: ShipWipeReport | null = null;
  const p = migrateProfile(clone(raw), kit, catalog, { econ, onShipWipe: (r) => { report = r; } });
  return { p, r: report as ShipWipeReport | null };
}

const add = (into: Bag, bag: Bag) => { for (const [id, n] of Object.entries(bag)) into[id] = (into[id] ?? 0) + n; return into; };

describe('v5 ship wipe', () => {
  it('a built ship comes back as its materials in full; the pilot gets a fresh starter in slot 1, at home', () => {
    const prospector = rec('prospector');
    const { p, r } = wipe(v4([rec('sparrow-t'), prospector], { position: { system: 'borealis', x: 5000, y: 0 } }));
    expect(PROFILE_VERSION).toBe(5);
    expect(p.version).toBe(5);
    expect(r!.slotsDeleted).toBe(2);
    // The stock Sparrow gives nothing: the Prospector all of its parts, broken down
    expect(r!.refund).toEqual(salvageParts(econ, prospector.blueprint.parts, 1));
    for (const [id, n] of Object.entries(r!.refund)) expect(countOf(p.storage, id)).toBe(n + (id === 'iron_ore' ? 3 : 0));
    // A fresh starter, the kit's own design (a copy), in slot 1; every other slot empty
    expect(p.activeSlot).toBe(0);
    expect(p.ship).toBe(p.hangar[0]);
    expect(p.ship.blueprint).toEqual(kit.blueprint);
    expect(p.ship.blueprint).not.toBe(kit.blueprint);
    expect(p.ship).toMatchObject({ hp: {}, ghosts: [], plan: 'sparrow-t' });
    expect(p.hangar.slice(1).every((s) => s === null)).toBe(true);
    expect(p.position).toEqual(kit.position);
    // Kept: level, credits, storage
    expect(p.credits).toBe(777);
    expect(p.xp).toBe(5000);
    expect(p.level).toBeGreaterThan(1);
    // The one-time notice lists the refund
    expect(p.notices).toHaveLength(1);
    expect(p.notices![0].items).toEqual(r!.refund);
  });

  it('a loaner gives nothing back', () => {
    const { r } = wipe(v4([rec('sparrow-t', { loaner: true })]));
    expect(r!.refund).toEqual({});
    const { r: r2 } = wipe(v4([rec('prospector', { loaner: true })]));
    expect(r2!.refund).toEqual({});
  });

  it('a lost ship being rebuilt gives back only what was rebuilt', () => {
    const lost = rec('prospector', { lost: true, auto: true });
    const parts = lost.blueprint.parts;
    const rebuilt = parts.slice(0, 3);
    lost.ghosts = parts.slice(3).map((q) => q.uid);
    const { r } = wipe(v4([rec('sparrow-t', { loaner: true }), lost]));
    expect(r!.refund).toEqual(salvageParts(econ, rebuilt, 1));
    // (A lost Sparrow is a paid rebuild too: no stock parts taken off it)
    const sparrow = rec('sparrow-t', { lost: true });
    sparrow.ghosts = sparrow.blueprint.parts.slice(2).map((q) => q.uid);
    expect(wipe(v4([rec('sparrow-t', { loaner: true }), sparrow])).r!.refund).toEqual(salvageParts(econ, sparrow.blueprint.parts.slice(0, 2), 1));
  });

  it('the stock starter gives back only the parts added to it', () => {
    const s = rec('sparrow-t');
    const extra: PlacedPart = { ...s.blueprint.parts.find((q) => q.fn === 'hull' && q.piece === 'sq')!, uid: 900, x: 9, y: 9 };
    s.blueprint.parts.push(extra);
    const { r } = wipe(v4([s]));
    expect(r!.refund).toEqual(salvageParts(econ, [extra], 1));
    // Only once: a second Sparrow T was paid for in full
    const { r: r2 } = wipe(v4([rec('sparrow-t'), rec('sparrow-t')]));
    expect(r2!.refund).toEqual(salvageParts(econ, plans['sparrow-t'].parts, 1));
  });

  it('socketed gems come back as themselves; parts at 0 HP (and their gems) give nothing', () => {
    const ship = rec('prospector');
    const guns = ship.blueprint.parts.filter((q) => q.fn === 'cannon_pip');
    expect(guns.length).toBeGreaterThan(0);
    guns[0].gems = ['gem_ruby_1', 'gem_ruby_1'];
    const dead = ship.blueprint.parts.find((q) => q !== guns[0] && q.fn !== 'core')!;
    dead.gems = ['gem_sapphire_2'];
    ship.hp = { [dead.uid]: 0, [guns[0].uid]: 0.4 };
    const { r } = wipe(v4([ship]));
    const alive = ship.blueprint.parts.filter((q) => q !== dead);
    expect(r!.refund).toEqual(add(salvageParts(econ, alive, 1), { gem_ruby_1: 2 }));
    expect(r!.refund.gem_sapphire_2).toBeUndefined();
  });

  it('designs, the wreck, loadouts and ship-bound jobs go; jobs keep running for storage; the hold moves to storage', () => {
    const ship = rec('prospector', { ammo: { load: { slug_crate: 2 } } });
    const raw = v4([ship], {
      designs: [clone(plans.arrow), null, clone(plans.lancer)],
      wreck: { system: 'sol', x: 1, y: 2, until: Date.now() + 60_000 },
      cargo: [{ id: 'iron_ore', n: 5 }, { id: 'crystal', n: 2 }],
      jobs: [
        { id: 1, recipe: 'r', station: 'sol_station_central', out: { copper_wire: 1 }, count: 2, done: 0, unitMs: 1000, startedAt: 0, readyAt: 2000, for: 'Prospector', slot: 0 },
        { id: 2, recipe: 'r', station: 'sol_station_central', out: { copper_wire: 1 }, count: 1, done: 0, unitMs: 1000, startedAt: 0, readyAt: 1000 },
      ],
    });
    const { p, r } = wipe(raw);
    expect(r!.designsDeleted).toBe(2);
    expect(p.designs).toBeUndefined();
    expect(p.wreck).toBeUndefined();
    expect(p.ship.ammo).toBeUndefined();
    expect(p.roster).toEqual([]);
    expect(r!.jobsDetached).toBe(1);
    expect(p.jobs).toHaveLength(2);
    expect(p.jobs[0].for).toBeUndefined();
    expect(p.jobs[0].slot).toBeUndefined();
    expect(p.jobs[0].count).toBe(2);
    expect(r!.cargoMoved).toEqual({ iron_ore: 5, crystal: 2 });
    expect(p.cargo).toEqual([]);
    expect(countOf(p.storage, 'crystal')).toBe(2 + (r!.refund.crystal ?? 0));
    expect(countOf(p.storage, 'iron_ore')).toBe(3 + 5 + (r!.refund.iron_ore ?? 0));
  });

  it('forgives rebuild debt, drops plan items, and trims the plans to the starter (and the Prospector if known)', () => {
    const raw = v4([rec('sparrow-t')], {
      debt: 450,
      cargo: [{ id: 'plan:arrow', n: 1 }, { id: 'iron_ore', n: 1 }],
      storage: [{ id: 'plan:lancer', n: 2 }],
      quickbar: ['repair_kit', 'plan:arrow', null, null, null],
      plans: ['sparrow-t', 'prospector', 'arrow'],
    });
    const { p, r } = wipe(raw);
    expect(r!.debtForgiven).toBe(450);
    expect(p.debt).toBeUndefined();
    expect(r!.planItemsDropped).toEqual({ 'plan:arrow': 1, 'plan:lancer': 2 });
    expect([...p.cargo, ...p.storage].some((s) => s.id.startsWith('plan:'))).toBe(false);
    expect(p.quickbar).toEqual(['repair_kit', null, null, null, null]);
    expect(p.plans).toEqual(['sparrow-t', 'prospector']);
    expect(r!.plansDropped).toEqual(['arrow']);
    expect(p.notices![0].text).toMatch(/450 credits/);
    // Never knew the Prospector: not given it
    expect(wipe(v4([rec('sparrow-t')], { plans: ['sparrow-t', 'arrow'] })).p.plans).toEqual(['sparrow-t']);
  });

  it('keeps quests (main_02 in progress), reputation and skills as they were', () => {
    const quests = { active: { main_02: { stage: 2, progress: 0 } }, done: ['main_01'], known: ['main_01', 'main_02'], flags: ['starter_bonds'] };
    const { p } = wipe(v4([rec('sparrow-t'), rec('prospector')], { quests, reputation: { sol_patrol: 3 }, skills: { mining: 2 }, plans: ['sparrow-t', 'prospector'] }));
    expect(p.quests.active).toEqual(quests.active);
    expect(p.quests.done).toEqual(['main_01']);
    expect(p.reputation).toEqual({ sol_patrol: 3 });
    expect(p.skills).toEqual({ mining: 2 });
    // The Prospector can still be started for main_02 (Quests rewinds its step at login: quests.test.ts)
    expect(p.plans).toContain('prospector');
  });

  it('runs once: a v5 save is left as it is, notice and all; without the economy a v4 save keeps its ships', () => {
    const { p } = wipe(v4([rec('prospector')], { cargo: [{ id: 'crystal', n: 1 }] }));
    let again: ShipWipeReport | null = null;
    const twice = migrateProfile(clone(p), kit, catalog, { econ, onShipWipe: (r) => { again = r; } });
    expect(again).toBeNull();
    expect(twice.storage).toEqual(p.storage);
    expect(twice.ship).toEqual(p.ship);
    expect(twice.notices).toEqual(p.notices);
    const waiting = migrateProfile(v4([rec('prospector')]), kit, catalog);
    expect(waiting.version).toBe(4);
    expect(waiting.ship.plan).toBe('prospector');
    expect(waiting.notices).toBeUndefined();
    // A new pilot starts at v5: nothing to wipe
    expect(newProfile(kit).version).toBe(5);
  });
});
