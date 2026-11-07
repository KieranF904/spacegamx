/**
 * The v5 design update (designUpdate.ts, run by profile.ts migrateProfile): mapped ships swapped for their remakes,
 * the rest broken down into storage (the ship wipe), only ships changing. Accounts here are made up; the shapes
 * follow production's five saves (2026-11-07), anonymised.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { loadCatalog } from '../ships/catalog.js';
import { parseBlueprint } from '../ships/blueprint.js';
import { registerAmmo } from '../ships/launch.js';
import type { Blueprint, PlacedPart } from '../ships/types.js';
import type { ShipTuning } from '../ships/tuning.js';
import { Economy } from './economy.js';
import { salvageParts } from './salvage.js';
import { countOf, type Bag } from './stacks.js';
import { xpToReach } from './levels.js';
import { migrateProfile, newProfile, PROFILE_VERSION, starterKit, type ShipRecord } from './profile.js';
import { resolveDesignUpdate, type DesignUpdate, type DesignUpdateFile, type DesignUpdateReport } from './designUpdate.js';

const data = join(__dirname, '../../../data');
const json = (p: string) => JSON.parse(readFileSync(join(data, p), 'utf-8'));
const catalog = loadCatalog({ pieces: json('ships/pieces.json'), functions: json('ships/functions.json'), materials: json('ships/materials.json'), models: json('ships/models.json') });
const tuning = json('ships/tuning.json') as ShipTuning;
const readDir = (dir: string): Record<string, Blueprint> => Object.fromEntries(readdirSync(join(data, 'ships/blueprints', dir)).filter((n) => n.endsWith('.json')).map((f) => [f.slice(0, -5), parseBlueprint(readFileSync(join(data, 'ships/blueprints', dir, f), 'utf-8'))]));
const plans = readDir('.');
const remakes = readDir('remakes');
const items = json('items.json');
registerAmmo(items.items);
const econ = new Economy(items, json('recipes.json'), catalog, plans);
const kit = starterKit(plans['sparrow-t']);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const rec = (plan: string, extra: Partial<ShipRecord> = {}): ShipRecord => ({ blueprint: clone(plans[plan]), hp: {}, ghosts: [], plan, ...extra });
/** A saved ship of `n` parts named `name` (a library design, cut down or padded with copies of its hull) */
function custom(name: string, n: number, from = 'prospector', extra: Partial<ShipRecord> = {}): ShipRecord {
  const bp = clone(plans[from]);
  bp.name = name;
  const hull = bp.parts.find((q) => q.fn === 'hull' || q.fn === 'armor') ?? bp.parts[bp.parts.length - 1];
  let uid = Math.max(...bp.parts.map((q) => q.uid)) + 1;
  while (bp.parts.length < n) bp.parts.push({ ...clone(hull), uid: uid++, x: 40 + bp.parts.length, y: 40 });
  bp.parts = bp.parts.slice(0, n);
  return { blueprint: bp, hp: {}, ghosts: [], plan: from, ...extra };
}

/** A save as the game wrote it at `version`, with these hangar slots (the first is flown) */
function save(version: number, hangar: (ShipRecord | null)[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const p = clone(newProfile(kit)) as unknown as Record<string, unknown>;
  const slots = [...hangar];
  while (slots.length < 5) slots.push(null);
  const active = typeof extra.activeSlot === 'number' ? extra.activeSlot : 0;
  return { ...p, version, xp: 5000, credits: 777, hangar: slots, ship: slots[active], activeSlot: active, storage: [{ id: 'iron_ore', n: 3 }], ...extra };
}
const v4 = (hangar: (ShipRecord | null)[], extra: Record<string, unknown> = {}) => save(4, hangar, extra);

function update(raw: unknown, opts: { map?: DesignUpdate; user?: string } = {}) {
  let report: DesignUpdateReport | null = null;
  const p = migrateProfile(clone(raw), kit, catalog, { econ, tuning, designUpdate: opts.map, username: opts.user, onDesignUpdate: (r) => { report = r; } });
  return { p, r: report as DesignUpdateReport | null };
}
const wipe = (raw: unknown) => update(raw);

/** A mapping over made-up accounts, its blueprints found the way loadShipConfig finds them */
const mapping = (accounts: DesignUpdateFile['accounts']): DesignUpdate =>
  resolveDesignUpdate({ accounts }, (id) => (id.startsWith('remakes/') ? remakes[id.slice(8)] : plans[id]));

const add = (into: Bag, bag: Bag) => { for (const [id, n] of Object.entries(bag)) into[id] = (into[id] ?? 0) + n; return into; };

describe('v5 design update: the wipe (an account to wipe, or not in the mapping)', () => {
  it('a built ship comes back as its materials in full; the pilot gets a fresh starter in slot 1, at home', () => {
    const prospector = rec('prospector');
    const { p, r } = wipe(v4([rec('sparrow-t'), prospector], { position: { system: 'borealis', x: 5000, y: 0 } }));
    expect(PROFILE_VERSION).toBe(6);
    expect(p.version).toBe(6);
    expect(r!.mode).toBe('wipe');
    expect(r!.slotsDeleted).toBe(2);
    expect(r!.wiped.map((w) => w.why)).toEqual(['not mapped', 'not mapped']);
    expect(r!.freshStarter).toBe(true);
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
    // The one-time notice lists the refund, in the wipe's words
    // (The design update's notice, then the v6 field update's)
    expect(p.notices).toHaveLength(2);
    expect(p.notices![1].text).toMatch(/Repair kits and insurance are gone/);
    expect(p.notices![0].items).toEqual(r!.refund);
    expect(p.notices![0].text).toMatch(/hangar has been reset: you have a fresh Sparrow T in slot 1/);
    expect(p.notices![0].text).not.toMatch(/rebuilt for the new power system:/);
  });

  it('"wipe" in the mapping wipes that account (its reason says so)', () => {
    const map = mapping({ boss: 'wipe' });
    const { r } = update(v4([rec('prospector')]), { map, user: 'boss' });
    expect(r).toMatchObject({ mode: 'wipe', freshStarter: true, swapped: [] });
    expect(r!.wiped).toEqual([{ slot: 0, from: { name: 'Prospector', parts: plans.prospector.parts.length }, why: 'account wiped' }]);
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
    const extra: PlacedPart = { ...(s.blueprint.parts.find((q) => q.fn === 'hull' || q.fn === 'armor') ?? s.blueprint.parts[1]), uid: 900, x: 9, y: 9 };
    s.blueprint.parts.push(extra);
    const { r } = wipe(v4([s]));
    expect(r!.refund).toEqual(salvageParts(econ, [extra], 1));
    // Only once: a second Sparrow T was paid for in full
    const { r: r2 } = wipe(v4([rec('sparrow-t'), rec('sparrow-t')]));
    expect(r2!.refund).toEqual(salvageParts(econ, plans['sparrow-t'].parts, 1));
  });

  it('socketed gems come back as themselves; parts at 0 HP (and their gems) give nothing', () => {
    const ship = rec('prospector');
    const [gun, dead] = ship.blueprint.parts.filter((q) => q.fn !== 'core');
    gun.gems = ['gem_ruby_1', 'gem_ruby_1'];
    dead.gems = ['gem_sapphire_2'];
    ship.hp = { [dead.uid]: 0, [gun.uid]: 0.4 };
    const { r } = wipe(v4([ship]));
    const alive = ship.blueprint.parts.filter((q) => q !== dead);
    expect(r!.refund).toEqual(add(salvageParts(econ, alive, 1), { gem_ruby_1: 2 }));
    expect(r!.refund.gem_sapphire_2).toBeUndefined();
  });

  it('designs, the wreck, loadouts and ship-bound jobs go; jobs keep running for storage; the hold moves to storage', () => {
    const ship = rec('prospector', { ammo: { load: { slug_crate: 2 } } });
    const raw = v4([ship], {
      designs: [clone(plans.arrow), null, clone(plans.halberd)],
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

  it('forgives rebuild debt and drops plan items; the plans known are kept', () => {
    const raw = v4([rec('sparrow-t')], {
      debt: 450,
      cargo: [{ id: 'plan:arrow', n: 1 }, { id: 'iron_ore', n: 1 }],
      storage: [{ id: 'plan:lancer', n: 2 }],
      quickbar: ['repair_kit', 'plan:arrow', null, null, null],
      plans: ['sparrow-t', 'prospector', 'drum', 'arrow'],
    });
    const { p, r } = wipe(raw);
    expect(r!.debtForgiven).toBe(450);
    expect(p.debt).toBeUndefined();
    expect(r!.planItemsDropped).toEqual({ 'plan:arrow': 1, 'plan:lancer': 2 });
    expect([...p.cargo, ...p.storage].some((s) => s.id.startsWith('plan:'))).toBe(false);
    // (The v6 field update clears the retired repair kits from the quick bar too)
    expect(p.quickbar).toEqual([null, null, null, null, null]);
    expect(p.plans).toEqual(['sparrow-t', 'prospector', 'drum', 'arrow']);
    expect(p.notices![0].text).toMatch(/450 credits/);
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
    const again = update(p);
    expect(again.r).toBeNull();
    expect(again.p.storage).toEqual(p.storage);
    expect(again.p.ship).toEqual(p.ship);
    expect(again.p.notices).toEqual(p.notices);
    const waiting = migrateProfile(v4([rec('prospector')]), kit, catalog);
    expect(waiting.version).toBe(4);
    expect(waiting.ship.plan).toBe('prospector');
    expect(waiting.notices).toBeUndefined();
    // A new pilot starts at the current version: nothing to update
    expect(newProfile(kit).version).toBe(PROFILE_VERSION);
  });
});

describe('v5 design update: the swap', () => {
  // (Shapes after production's: a pilot with a custom Sparrow T flying a custom Prospector, a stock Prospector, a saved design)
  const map = mapping({
    pilotA: { slots: { 0: { blueprint: 'remakes/player-xire-sparrow', was: { name: 'Sparrow T', parts: 30 } }, 1: { blueprint: 'remakes/player-xire-prospector', was: { name: 'Prospector', parts: 40 } } } },
    pilotB: {
      slots: { 0: { blueprint: 'remakes/player-pigbenis-sparrow', was: { name: 'Sparrow T', parts: 24 } }, 1: { blueprint: 'prospector', stock: true, was: { name: 'Prospector', parts: 17 } } },
      designs: { 0: { blueprint: 'remakes/player-pigbenis-pooper', was: { name: 'Pooper', parts: 30 } } },
    },
    pilotC: { slots: { 0: { blueprint: 'sparrow-t', stock: true, was: { name: 'Sparrow T', parts: 14 } } } },
  });

  it('every blueprint the real mapping names is found (remakes ship in blueprints/remakes, stock ones in the library)', () => {
    const file = json('ships/designUpdate.json') as DesignUpdateFile;
    const real = resolveDesignUpdate(file, (id) => (id.startsWith('remakes/') ? remakes[id.slice(8)] : plans[id]));
    expect(real.missing).toEqual([]);
    expect(Object.keys(real.blueprints).length).toBeGreaterThanOrEqual(6);
    for (const [id, bp] of Object.entries(real.blueprints)) expect(bp.power, id).toBe('ports');
    // Never a dev-only blueprint (the deploy leaves dev/ out), and remakes aren't library ships
    expect(Object.keys(real.blueprints).some((id) => id.startsWith('dev/'))).toBe(false);
    for (const id of Object.keys(remakes)) expect(plans[id]).toBeUndefined();
  });

  it('swaps each mapped slot for its remake in place: its name, full HP, the flown slot kept; nothing refunded', () => {
    const sparrow = custom('Sparrow T', 30, 'sparrow-t');
    sparrow.hp = { [sparrow.blueprint.parts[1].uid]: 0.2 };
    const raw = v4([sparrow, custom('Prospector', 40)], { activeSlot: 1, cargo: [{ id: 'iron_ore', n: 2 }], position: { system: 'borealis', x: 1, y: 2 } });
    const { p, r } = update(raw, { map, user: 'pilotA' });
    expect(r).toMatchObject({ mode: 'swap', wiped: [], refund: {}, freshStarter: false, activeSlot: 1 });
    expect(r!.swapped).toEqual([
      { slot: 0, from: { name: 'Sparrow T', parts: 30 }, to: 'remakes/player-xire-sparrow', name: remakes['player-xire-sparrow'].name },
      { slot: 1, from: { name: 'Prospector', parts: 40 }, to: 'remakes/player-xire-prospector', name: remakes['player-xire-prospector'].name },
    ]);
    expect(p.hangar[0]!.blueprint).toEqual(remakes['player-xire-sparrow']);
    expect(p.hangar[0]!.blueprint).not.toBe(remakes['player-xire-sparrow']);
    expect(p.hangar[0]).toMatchObject({ hp: {}, ghosts: [], plan: 'sparrow-t' });
    expect(p.hangar[0]!.lost).toBeUndefined();
    expect(p.activeSlot).toBe(1);
    expect(p.ship).toBe(p.hangar[1]);
    expect(p.ship.blueprint.name).toBe(remakes['player-xire-prospector'].name);
    // Docked at home, the hold in storage; the notice in the swap's words, no wipe wording and no item list
    expect(p.position).toEqual(kit.position);
    expect(p.cargo).toEqual([]);
    expect(countOf(p.storage, 'iron_ore')).toBe(5);
    expect(p.notices).toHaveLength(2);
    expect(p.notices![0].text).toMatch(/^Your ships have been rebuilt for the new power system: your Sparrow T in slot 1 is now the .+ and your Prospector in slot 2 is now the .+\./);
    expect(p.notices![0].text).not.toMatch(/reset|broken down/);
    expect(p.notices![0].items).toBeUndefined();
  });

  it('a stock ship becomes the current library ship (its plan the library id); a saved design is remade in its place', () => {
    const raw = v4([custom('Sparrow T', 24, 'sparrow-t'), custom('Prospector', 17)], {
      activeSlot: 1, designs: [custom('Pooper', 30, 'prospector').blueprint, clone(plans.arrow)],
    });
    const { p, r } = update(raw, { map, user: 'pilotB' });
    expect(p.hangar[1]!.blueprint).toEqual(plans.prospector);
    expect(p.hangar[1]!.plan).toBe('prospector');
    expect(p.hangar[0]!.blueprint).toEqual(remakes['player-pigbenis-sparrow']);
    expect(p.designs).toEqual([remakes['player-pigbenis-pooper'], null]);
    expect(r!.swapped.map((s) => s.design ?? `slot${s.slot}`)).toEqual(['slot0', 'slot1', 0]);
    expect(r!.wiped).toEqual([{ design: 1, from: { name: 'Arrow', parts: plans.arrow.parts.length }, why: 'not mapped' }]);
    expect(r!.designsDeleted).toBe(1);
    expect(p.notices![0].text).toMatch(/saved design was remade too: Pooper is now/);
    expect(p.notices![0].text).toMatch(/saved design Arrow could not be remade and was removed/);
  });

  it('a save that changed since its remake was made is wiped instead (refunded in full: no fresh starter while another ship is left)', () => {
    const changed = custom('Sparrow T', 25, 'sparrow-t');
    const raw = v4([changed, custom('Prospector', 17)], { activeSlot: 0 });
    const { p, r } = update(raw, { map, user: 'pilotB' });
    expect(r!.wiped).toEqual([{ slot: 0, from: { name: 'Sparrow T', parts: 25 }, why: 'changed since' }]);
    expect(r!.refund).toEqual(salvageParts(econ, changed.blueprint.parts, 1));
    expect(p.hangar[0]).toBeNull();
    // The flown slot went: the next flyable ship is flown
    expect(p.activeSlot).toBe(1);
    expect(p.ship).toBe(p.hangar[1]);
    expect(r!.freshStarter).toBe(false);
    expect(p.notices![0].text).toMatch(/The Sparrow T could not be rebuilt, so it was broken down into storage/);
    expect(p.notices![0].items).toEqual(r!.refund);
    // Renamed since: also wiped
    const renamed = custom('Sparrow X', 24, 'sparrow-t');
    expect(update(v4([renamed, custom('Prospector', 17)]), { map, user: 'pilotB' }).r!.wiped[0].why).toBe('changed since');
  });

  it('checks `was` against the save as written, before older saves are migrated (a v2 save)', () => {
    const raw = save(2, [custom('Sparrow T', 14, 'sparrow-t')]);
    const { p, r } = update(raw, { map, user: 'pilotC' });
    expect(p.version).toBe(6);
    expect(r!.swapped).toHaveLength(1);
    expect(p.ship.blueprint).toEqual(plans['sparrow-t']);
    expect(p.ship.plan).toBe('sparrow-t');
  });

  it('a lost or unfinished ship comes back whole (Kieran: give them built ships), nothing refunded for it, flown if nothing else flies', () => {
    const lost = custom('Sparrow T', 30, 'sparrow-t', { lost: true, auto: true });
    lost.ghosts = lost.blueprint.parts.slice(2).map((q) => q.uid);
    const loaner = rec('sparrow-t', { loaner: true });
    const { p, r } = update(v4([lost, loaner], { activeSlot: 1 }), { map, user: 'pilotA' });
    const bp = remakes['player-xire-sparrow'];
    expect(r!.swapped).toEqual([{ slot: 0, from: { name: 'Sparrow T', parts: 30 }, to: 'remakes/player-xire-sparrow', name: bp.name }]);
    expect(r!.wiped).toEqual([{ slot: 1, from: { name: 'Sparrow T', parts: plans['sparrow-t'].parts.length }, why: 'loaner' }]);
    expect(r!.refund).toEqual({});
    const swapped = p.hangar[0]!;
    expect(swapped.lost).toBeUndefined();
    expect(swapped.ghosts).toEqual([]);
    expect(swapped.blueprint.parts).toHaveLength(bp.parts.length);
    // Whole now: it's the ship flown (no loaners any more)
    expect(r).not.toHaveProperty('loaner');
    expect(p.ship).toBe(swapped);
    expect(p.activeSlot).toBe(0);
    expect(p.notices![0].text).not.toMatch(/still being built/);
  });

  it('keeps an ammo loadout where the new guns take it, and drops crates for guns it no longer has', () => {
    // (The Pooper remake fires missiles: its crate stays; railgun slugs go)
    const designs = remakes['player-pigbenis-pooper'];
    expect(designs.parts.some((q) => q.fn === 'missile_dart')).toBe(true);
    const mapP = mapping({ pilotD: { slots: { 0: { blueprint: 'remakes/player-pigbenis-pooper', was: { name: 'Pooper', parts: 30 } } } } });
    const ship = custom('Pooper', 30, 'prospector', { ammo: { load: { missile_crate: 3, railgun_slugs: 4 }, first: { missile: 'missile_crate', railgun: 'railgun_slugs' } } });
    const { p } = update(v4([ship]), { map: mapP, user: 'pilotD' });
    expect(p.ship.ammo).toEqual({ load: { missile_crate: 3 }, first: { missile: 'missile_crate' } });
    // Nothing left of it: no loadout (the new guns' standard crates)
    const none = custom('Pooper', 30, 'prospector', { ammo: { load: { railgun_slugs: 4 } } });
    expect(update(v4([none]), { map: mapP, user: 'pilotD' }).p.ship.ammo).toBeUndefined();
  });

  it('a missing remake, or an account not in the mapping, is wiped (never an error)', () => {
    const broken = mapping({ pilotE: { slots: { 0: { blueprint: 'remakes/nothing-here', was: { name: 'Prospector', parts: 17 } } } } });
    expect(broken.blueprints).toEqual({});
    const { r } = update(v4([custom('Prospector', 17)]), { map: broken, user: 'pilotE' });
    expect(r!.wiped[0].why).toBe('remake missing');
    expect(r!.freshStarter).toBe(true);
    expect(update(v4([rec('prospector')]), { map, user: 'someoneElse' }).r!.mode).toBe('wipe');
    expect(update(v4([rec('prospector')]), { map }).r!.mode).toBe('wipe');
  });

  it('swapped saves run once too', () => {
    const { p } = update(v4([custom('Sparrow T', 30, 'sparrow-t'), custom('Prospector', 40)]), { map, user: 'pilotA' });
    const again = update(p, { map, user: 'pilotA' });
    expect(again.r).toBeNull();
    expect(again.p.hangar).toEqual(p.hangar);
  });
});

describe('v5 design update: progress is kept, wipe or swap', () => {
  /** An anonymised copy of the owner's production shape: level 24, flying a loaner (slot 4), a lost Arrow being rebuilt, two custom ships (one with a loadout), six bays */
  function ownerShape(): Record<string, unknown> {
    const arrow = rec('arrow', { lost: true, auto: true });
    arrow.ghosts = arrow.blueprint.parts.slice(-5).map((q) => q.uid);
    const big = custom('New ship', 50, 'prospector', { plan: undefined, ammo: { load: { cannon_hv: 81 } } });
    const small = custom('New ship', 23, 'prospector', { plan: undefined });
    const loaner = rec('sparrow-t', { loaner: true });
    return save(4, [arrow, big, small, loaner, null, null], {
      activeSlot: 3, xp: xpToReach(24) + 1234, skillPoints: 7, credits: 98_765,
      skills: { mining: 3, gunnery: 2 }, recipes: ['alloy_plate'], licences: ['sol_gate'], reputation: { sol_patrol: 9 },
      plans: ['sparrow-t', 'prospector', 'drum', 'arrow'],
      quests: { active: { main_05: { stage: 1, progress: 2 } }, done: ['main_01', 'main_02'], known: ['main_01', 'main_02', 'main_05'], flags: ['starter_bonds'] },
      codex: { found: ['sol_central'], fresh: [] }, stats: { kills: 120 },
      storage: [{ id: 'iron_ore', n: 500 }, { id: 'crystal', n: 4 }],
    });
  }

  it("the owner's account (wiped): only the ships go; XP, level, skill points, credits and the rest are unchanged", () => {
    const raw = ownerShape();
    const { p, r } = update(raw, { map: mapping({ owner: 'wipe' }), user: 'owner' });
    expect(r!.mode).toBe('wipe');
    expect(r!.freshStarter).toBe(true);
    expect(p.xp).toBe(raw.xp);
    expect(p.level).toBe(24);
    expect(p.skillPoints).toBe(7);
    expect(p.credits).toBe(98_765);
    expect(p.skills).toEqual({ mining: 3, gunnery: 2 });
    expect(p.recipes).toEqual(['alloy_plate']);
    expect(p.licences).toEqual(['sol_gate']);
    expect(p.reputation).toEqual({ sol_patrol: 9 });
    expect(p.plans).toEqual(['sparrow-t', 'prospector', 'drum', 'arrow']);
    expect(p.quests).toEqual((raw as any).quests);
    expect(p.codex).toEqual({ found: ['sol_central'], fresh: [] });
    expect(p.stats).toEqual({ kills: 120 });
    // Storage: what was there, plus the ships broken down (the lost Arrow only what was rebuilt, the loaner nothing)
    expect(countOf(p.storage, 'crystal')).toBe(4 + (r!.refund.crystal ?? 0));
    expect(countOf(p.storage, 'iron_ore')).toBe(500 + (r!.refund.iron_ore ?? 0));
    expect(r!.wiped.map((w) => w.why)).toEqual(['account wiped', 'account wiped', 'account wiped', 'loaner']);
    expect(p.hangar.slice(1).every((s) => s === null)).toBe(true);
    expect(p.ship.blueprint).toEqual(kit.blueprint);
  });

  it('a swapped account keeps the same', () => {
    const raw = ownerShape();
    const map = mapping({ owner: { slots: { 1: { blueprint: 'remakes/player-xire-prospector', was: { name: 'New ship', parts: 50 } } } } });
    const { p, r } = update(raw, { map, user: 'owner' });
    expect(r!.mode).toBe('swap');
    expect(p.xp).toBe(raw.xp);
    expect(p.level).toBe(24);
    expect(p.skillPoints).toBe(7);
    expect(p.credits).toBe(98_765);
    expect(p.plans).toEqual(['sparrow-t', 'prospector', 'drum', 'arrow']);
    expect(p.quests).toEqual((raw as any).quests);
    // Its slot kept (and its six bays); the loaner went, so the remake is flown
    expect(p.hangar).toHaveLength(6);
    expect(p.activeSlot).toBe(1);
    expect(p.ship.blueprint.name).toBe(remakes['player-xire-prospector'].name);
  });
});
