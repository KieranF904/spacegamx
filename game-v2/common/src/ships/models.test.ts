/**
 * Models (docs/parts-redesign.md): fixed named modules with their own numbers,
 * engines that fade near their rated speed, licences by level, and the model a
 * legacy part (an enemy's) stands for.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Blueprint, PlacedPart, Rot } from './types.js';
import { parseBlueprint, validateBlueprint, partMaxHp, partMass, partMount, serializeBlueprint, fixModelMaterials } from './blueprint.js';
import { createShipState } from './state.js';
import { buildShot } from './shot.js';
import { accelAlong, ratedFade, stepFlight } from './flight.js';
import { gunDef, partWeaponDef } from './launch.js';
import { partBuildPoints, partGrade, partSupply, partThrust, weaponSizeFactor, weaponStrength } from './grades.js';
import { partArmour } from './damage.js';
import { legacyModel, migratePartItem } from './migrate.js';
import { describePart } from './describe.js';
import type { ShipTuning } from './tuning.js';
import { readShipJson, readCatalogFiles, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { loadCatalog } from './catalog.js';
import { canCraft, MATERIAL_LEVEL, modelLicensed, partLicensed } from '../econ/market.js';
import { migrateProfile, OLDEST_PROFILE_VERSION, type StarterKit } from '../econ/profile.js';
import { FRICTION, BOOST_FACTOR, WORLD_SIZE } from '../constants.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const MODELS = readShipJson<{ models: { id: string }[]; legacy: Record<string, string> }>('models.json');
const FN = (id: string) => catalog.functions.get(id)!;
const blueprint = (name: string) => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${name}.json`), 'utf-8'));
const p = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const bp = (parts: PlacedPart[]): Blueprint => ({ name: 'test', catalogVersion: 1, parts });

describe('models', () => {
  it('are in the catalogue: every one its own piece(s), material, tier and recipe', () => {
    const models = [...catalog.functions.values()].filter((f) => f.model);
    expect(models).toHaveLength(MODELS.models.length);
    // (No literal count: it changes with every part added. Ids are unique, and every one is in the models file.)
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    expect(new Set(MODELS.models.map((m) => m.id))).toEqual(new Set(models.map((m) => m.id)));
    expect(models.length).toBeGreaterThan(0);
    const recipes = JSON.parse(readFileSync(join(SHIP_DATA_DIR, '../recipes.json'), 'utf-8')).models;
    for (const m of models) {
      expect(Array.isArray(m.pieces) && m.pieces.length > 0, m.id).toBe(true);
      expect(catalog.materials.get(m.material!), m.id).toBeTruthy();
      expect(m.grade! >= 1 && m.grade! <= 5, m.id).toBe(true);
      expect(recipes[m.id], m.id).toBeTruthy();
      expect(m.name && m.description && m.category && m.family, m.id).toBeTruthy();
    }
    // Every legacy module function has its family; hull, armour, cargo and the core stay
    for (const [fn, fam] of Object.entries(MODELS.legacy)) {
      expect(FN(fn).legacy, fn).toBe(true);
      expect(catalog.families.get(fam)?.length, fam).toBeGreaterThan(0);
    }
    for (const fn of ['core', 'hull', 'armor', 'cargo']) expect(FN(fn).legacy).toBeFalsy();
    expect(FN('conduit').legacy).toBe(true);
    // A family's models, in unlock order
    expect(catalog.families.get('cannon')!.map((m) => m.name)).toEqual(['Pip', 'Hammer', 'Twinlink', 'Slurry Cannon', 'Longbarrel', 'Bastion']);
  });

  it('their material is only their HP, mass and resistances: their numbers are their own', () => {
    // A reactor's power, a gun's strength and an engine's push are what the model says, at its own size
    const reactor = FN('power_overclock_reactor');
    expect(catalog.materials.get(reactor.material!)!.output).toBeGreaterThan(1);
    expect(partSupply(reactor, 2, catalog.materials.get(reactor.material!))).toBe(reactor.produce! * 2);
    const hammer = FN('cannon_hammer');
    expect(weaponSizeFactor(catalog, hammer, 2)).toBe(1);
    expect(weaponStrength(catalog, hammer, 2, catalog.materials.get('neutronium'))).toBe(1);
    const torch = FN('engine_torch');
    expect(partThrust(catalog, torch, 2, catalog.materials.get('neutronium'))).toBeCloseTo(torch.thrust! * 2, 9);
    // Its grade is its tier (penetration, armour, build points), whatever the part says it's made of
    const q = { fn: 'cannon_bastion', material: 'alloy', piece: 'block2' };
    expect(partGrade(catalog, q)).toBe(FN('cannon_bastion').grade);
    expect(partArmour(catalog, q)).toBe(FN('cannon_bastion').grade);
    expect(partBuildPoints(catalog, q)).toBeCloseTo(4 * FN('cannon_bastion').points!, 9);
    // HP and mass from its own material
    const part = { ...p(0, 'block2', 'cannon_bastion', 0, 0), material: 'alloy' };
    const mat = catalog.materials.get(FN('cannon_bastion').material!)!;
    expect(partMaxHp(catalog, part)).toBeCloseTo(4 * mat.toughness * FN('cannon_bastion').hpScale, 6);
    expect(partMass(catalog, part)).toBeCloseTo(4 * mat.density * (FN('cannon_bastion').massScale ?? 1), 6);
    // (A design says so: a model in another material isn't valid)
    expect(validateBlueprint(catalog, bp([p(0, 'sq', 'core', 0, 0), p(1, 'block2', 'cannon_bastion', 1, 0, { facing: 'E' })]), tuning, null).errors.map((e) => e.code)).toContain('unknownMaterial');
  });

  it('a model gun fires its kind with its own changes (gems on top), not its grade\'s and size\'s', () => {
    // (A Cell Reactor beside it: plugged in)
    const b = bp([p(0, 'rect2', 'core', 0, 0), p(1, 'rect2', 'cannon_hammer', 0, -1, { facing: 'N', material: 'alloy' }), p(2, 'sq', 'power_cell_reactor', 2, -1)]);
    expect(validateBlueprint(catalog, b, tuning, null).errors).toEqual([]);
    const s = createShipState(catalog, tuning, 1, b, 0);
    const w = s.derived.weapons[0];
    expect(w.size).toBe(1);
    expect(w.grade).toBe(FN('cannon_hammer').grade);
    expect(w.model).toBe(FN('cannon_hammer').weaponMods);
    const base = tuning.weapons!.cannon;
    const def = partWeaponDef(tuning, w.kind, b.parts[1], w);
    const mods = FN('cannon_hammer').weaponMods!;
    // (Its damage is its own, set outright: heavier-shots-2026-11's 88; its speed still its kind's x its mul)
    expect(def.damage).toBeCloseTo(mods.set!.damage!, 9);
    expect(def.speed).toBeCloseTo(base.speed! * (1 + mods.mul!.speed!), 9);
    expect(def.pen).toBeCloseTo((base.pen ?? 0) + mods.add!.pen!, 9);
    // Its interval is its own: a fixed model doesn't load slower as a legacy fixed cannon does
    expect(w.mount).toBe('fixed');
    expect(w.interval).toBeCloseTo(FN('cannon_hammer').fireInterval!, 9);
    // A gem's changes go on top of the model's
    const gem = { mul: { damage: 0.1 } };
    expect(gunDef(tuning, 'cannon', { model: mods, mods: gem }).damage).toBeCloseTo(mods.set!.damage! * 1.1, 9);
    // A Coilgun needs no slugs; a Needle does
    expect(gunDef(tuning, 'railgun', { model: FN('railgun_coilgun').weaponMods }).ammo).toBeFalsy();
    expect(gunDef(tuning, 'railgun', { model: FN('railgun_needle').weaponMods }).ammo).toBeTruthy();
  });

  it('the starter built from level-0 models flies, fights and makes power as the old one did', () => {
    const sparrow = blueprint('sparrow-t');
    expect(sparrow.parts.every((q) => !FN(q.fn).legacy)).toBe(true);
    expect(sparrow.parts.filter((q) => FN(q.fn).model).every((q) => FN(q.fn).unlock?.level === 0)).toBe(true);
    expect(validateBlueprint(catalog, sparrow, tuning, null).errors).toEqual([]);
    const d = createShipState(catalog, tuning, 1, sparrow, 0).derived;
    // On the ports core, the core the hub: a Cell Reactor at each side feeds it, and it runs the Pips at its nose and the
    // Ion Drives behind it through conduits (as the old one's two reactors made power for everything)
    expect(d.ports).toBeDefined();
    expect(d.energy.supply).toBeCloseTo(2 * FN('generator').produce!, 9);
    const L = d.ports!, core = sparrow.parts.findIndex((q) => q.fn === 'core');
    expect(L.gens.length).toBe(2);
    for (const g of L.gens) expect(Array.from(L.outLink.subarray(L.outStart[g], L.outStart[g + 1]), (l) => L.linkTo[l])).toEqual([core]);
    // Its push: two ion drives, as two thrusters pushed
    expect(d.maxThrust.forward).toBeCloseTo(2 * FN('thruster').thrust!, 6);
    expect(d.weapons).toHaveLength(2);
  });

  it('the Conduit and the Diode: plain relay data (holds 10, gives and takes 200), cheap, from level 0 and 4, and say what they do', () => {
    const recipes = JSON.parse(readFileSync(join(SHIP_DATA_DIR, '../recipes.json'), 'utf-8')).models;
    const con = FN('power_conduit'), dio = FN('power_diode');
    for (const f of [con, dio]) {
      expect([f.pieces, f.material, f.store, f.discharge, f.intake, f.category, f.bank, f.pool, f.demand, f.produce])
        .toEqual([['sq'], 'alloy', 10, 200, 200, 'power', undefined, undefined, undefined, undefined]);
      expect(recipes[f.id].time).toBe(0);
    }
    expect([con.relayOnly, con.oneWay, con.unlock?.level]).toEqual([true, undefined, 0]);
    expect([dio.oneWay, dio.relayOnly, dio.unlock?.level]).toEqual([true, undefined, 4]);
    expect(recipes.power_conduit.inputs).toEqual({ alloy_plate: 1, copper_wire: 1 });
    const said = (id: string) => (describePart(catalog, tuning, { fn: id, material: 'alloy', piece: 'sq' })?.facts ?? []).map((f) => f.sentence ?? '').join(' ');
    expect(said('power_diode')).toContain('power only flows out of its front');
    expect(said('power_conduit')).toContain('passes power between the parts it touches');
    expect(said('power_battery')).toBe('');
  });
});

describe('weapon mounts: each model its own', () => {
  const weapons = [...catalog.functions.values()].filter((f) => f.model && f.weapon);
  const MOUNTS: Record<string, string> = {
    cannon_pip: 'fixed', cannon_hammer: 'fixed', cannon_twinlink: 'turret', cannon_longbarrel: 'fixed', cannon_bastion: 'fixed',
    laser_glint: 'turret', laser_cutter: 'fixed', laser_searchlight: 'turret', lance_lance: 'fixed',
    legendary_hive: 'fixed', legendary_phase: 'fixed', legendary_frostbite: 'turret', legendary_singularity: 'turret',
  };
  const BY_FAMILY: Record<string, string> = {
    autocannon: 'turret', flak: 'turret', mortar: 'turret', pulse: 'turret', missile: 'fixed', railgun: 'fixed', emp: 'turret', arc: 'turret', torpedo: 'fixed',
  };

  it('every weapon model has one, and its description says so', () => {
    // (Weapons are exactly the models whose function carries a weapon def; no literal count)
    expect(weapons.length).toBeGreaterThan(0);
    expect(weapons.every((m) => m.model)).toBe(true);
    for (const m of weapons) expect(m.family, m.id).toBeTruthy();
    for (const m of weapons) {
      expect(['fixed', 'turret'], m.id).toContain(m.mount);
      // (Point defence turns on its own, not to your aim: support.ts)
      expect(m.description, m.id).toContain(m.mount === 'fixed' ? 'Fixed: aim with the ship.' : m.family === 'point_defence' ? 'Turret: aims itself.' : 'Turret: turns to your aim.');
      const want = MOUNTS[m.id] ?? BY_FAMILY[m.family!];
      if (want) expect(m.mount, m.id).toBe(want);
    }
    // (Nothing else has one: not engines, not mining lasers, not the legacy functions)
    expect([...catalog.functions.values()].filter((f) => f.mount && !(f.model && f.weapon))).toEqual([]);
  });

  it("partMount: a model's own, whatever the part says; a legacy gun's its part's, else fixed", () => {
    expect(partMount(catalog, { fn: 'cannon_hammer', mount: 'turret' })).toBe('fixed');
    expect(partMount(catalog, { fn: 'cannon_twinlink', mount: 'fixed' })).toBe('turret');
    expect(partMount(catalog, { fn: 'cannon_pip', mount: 'turret' })).toBe('fixed');
    expect(partMount(catalog, { fn: 'cannon_pip' })).toBe('fixed');
    expect(partMount(catalog, { fn: 'weapon', mount: 'turret' })).toBe('turret');
    expect(partMount(catalog, { fn: 'weapon' })).toBe('fixed');
    expect(partMount(catalog, { fn: 'hull' })).toBe('fixed');
  });

  // A Hammer (fixed) said to be a turret, and a Rattler (turret) said to be fixed
  const mixed = () => bp([
    p(0, 'rect2', 'core', 0, 0),
    p(1, 'rect2', 'cannon_hammer', 0, -1, { facing: 'N', material: FN('cannon_hammer').material!, mount: 'turret' }),
    p(2, 'sq', 'autocannon_rattler', 2, -1, { facing: 'N', material: FN('autocannon_rattler').material!, mount: 'fixed' }),
    p(3, 'sq', 'power_cell_reactor', 0, 1, { material: FN('power_cell_reactor').material! }),
  ]);

  it("a ship's guns are mounted as their models are; the stored mount counts for nothing", () => {
    const b = mixed();
    expect(validateBlueprint(catalog, b, tuning, null).errors).toEqual([]);
    const d = createShipState(catalog, tuning, 1, b, 0).derived;
    const hammer = d.weapons.find((w) => w.uid === 1)!, rattler = d.weapons.find((w) => w.uid === 2)!;
    expect(hammer.mount).toBe('fixed');
    expect(hammer.window).toBeUndefined();
    expect(rattler.mount).toBe('turret');
    expect(rattler.window).toBeDefined();
    // A legacy gun keeps its part's
    const legacy = createShipState(catalog, tuning, 1, bp([p(0, 'rect2', 'core', 0, 0), p(1, 'sq', 'weapon', 0, -1, { facing: 'N', mount: 'turret' }), p(2, 'sq', 'weapon', 1, -1, { facing: 'N' })]), 0).derived;
    expect(legacy.weapons.map((w) => w.mount)).toEqual(['turret', 'fixed']);
  });

  it('a fixed model fires its own numbers: no legacy fixed-cannon loading or shell shaping', () => {
    const s = createShipState(catalog, tuning, 1, mixed(), 0);
    const hammer = s.derived.weapons.find((w) => w.uid === 1)!;
    expect(hammer.interval).toBeCloseTo(FN('cannon_hammer').fireInterval!, 9);
    const shot = buildShot(hammer, s, { x: 0, y: 0, angle: 0 }, 0, tuning);
    expect(shot.mount).toBe('fixed');
    expect(shot.speedScale).toBe(1);
    expect(shot.sizeScale).toBe(1);
    // A legacy fixed cannon still does (tuning.fixedGun)
    // (Beside a legacy turret on the same power: loading slower by just that)
    const l = createShipState(catalog, tuning, 1, bp([p(0, 'rect2', 'core', 0, 0), p(1, 'sq', 'weapon', 0, -1, { facing: 'N' }), p(2, 'sq', 'weapon', 1, -1, { facing: 'N', mount: 'turret' })]), 0);
    const [lw, lt] = l.derived.weapons;
    expect(lw.mount).toBe('fixed');
    expect(lw.interval / lt.interval).toBeCloseTo(tuning.fixedGun!.intervalScale!, 9);
    const ls = buildShot(lw, l, { x: 0, y: 0, angle: 0 }, 0, tuning);
    expect(ls.speedScale).toBeCloseTo(tuning.fixedGun!.speedScale!, 9);
    expect(ls.sizeScale).toBeCloseTo(tuning.fixedGun!.sizeScale!, 9);
  });

  it("a model weapon's mount is dropped when a design is parsed or fixed; a legacy one's kept", () => {
    const b = mixed();
    b.parts.push(p(4, 'sq', 'weapon', -1, 0, { facing: 'W', mount: 'turret' }));
    const parsed = parseBlueprint(serializeBlueprint(b));
    expect(parsed.parts.find((q) => q.uid === 1)!.mount).toBeUndefined();
    expect(parsed.parts.find((q) => q.uid === 2)!.mount).toBeUndefined();
    expect(parsed.parts.find((q) => q.uid === 4)!.mount).toBe('turret');
    const fixed = fixModelMaterials(catalog, mixed());
    expect(fixed.parts.every((q) => q.mount === undefined)).toBe(true);
  });

  it("the starter and library designs' fixed guns all point forward", () => {
    const dir = join(SHIP_DATA_DIR, 'blueprints');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const b = parseBlueprint(readFileSync(join(dir, f), 'utf-8'));
      // (No mount stored on a model weapon)
      expect(b.parts.filter((q) => FN(q.fn)?.mount && q.mount), f).toEqual([]);
      const d = createShipState(catalog, tuning, 1, b, 0).derived;
      for (const w of d.weapons.filter((x) => x.mount === 'fixed')) expect(w.dir[1], `${f} #${w.uid}`).toBeLessThan(-0.9);
    }
  });
});

describe('engines fade near their rated speed', () => {
  it('near full thrust until close to its rating, none past it; legacy engines never fade', () => {
    expect(ratedFade(undefined, 999)).toBe(1);
    expect(ratedFade(34, 0)).toBe(1);
    expect(ratedFade(34, 17)).toBeGreaterThan(0.98);
    expect(ratedFade(34, 30)).toBeLessThan(0.6);
    expect(ratedFade(34, 34)).toBe(0);
    expect(ratedFade(34, 50)).toBe(0);
    // (Going the other way, it pushes in full: braking never fades)
    expect(ratedFade(34, -40)).toBe(1);
  });

  it('a ship stops gaining speed at its engines\' rating (the same steps on both sides: flight.ts)', () => {
    const d = createShipState(catalog, tuning, 1, blueprint('sparrow-t'), 0).derived;
    const rated = d.thrusters[0].rated!;
    expect(rated).toBe(FN('engine_ion_drive').rated);
    expect(accelAlong(d, [0, -1], rated)).toBeCloseTo(d.maneuverForce * (d.drive ?? 1) / Math.max(d.mass, d.fullMass), 9);
    expect(accelAlong(d, [0, -1], 0)).toBeGreaterThan(accelAlong(d, [0, -1], rated * 0.9));
    // Flat out with next to no friction (and none of the core's own push): it tops out at its rating
    const free = { ...d, maneuverForce: 0 };
    const body = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0 };
    const k = { friction: 0.9999, boostFactor: BOOST_FACTOR, worldSize: WORLD_SIZE };
    const input = { forward: true, backward: false, left: false, right: false, boost: false, targetAngle: -Math.PI / 2 };
    for (let i = 0; i < 4000; i++) stepFlight(body, input, free, tuning, { charge: { g: 100, d: 100, w: 100 }, drainRate: 0 }, k);
    const speed = Math.hypot(body.vx, body.vy);
    expect(speed).toBeGreaterThan(rated * 0.95);
    expect(speed).toBeLessThan(rated);
    // A legacy engine on the same ship runs on (friction alone holds it)
    const legacy = blueprint('sparrow-t');
    for (const q of legacy.parts) if (q.fn === 'engine_ion_drive') q.fn = 'thruster';
    const dl = { ...createShipState(catalog, tuning, 1, legacy, 0).derived, maneuverForce: 0 };
    const b2 = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0 };
    for (let i = 0; i < 4000; i++) stepFlight(b2, input, dl, tuning, { charge: { g: 100, d: 100, w: 100 }, drainRate: 0 }, k);
    expect(Math.hypot(b2.vx, b2.vy)).toBeGreaterThan(rated * 2);
    void FRICTION;
  });
});

describe('licences: everything by level, nothing early', () => {
  const item = (fn: string) => {
    const m = FN(fn);
    return { id: `part:${m.material}:${fn}:${(m.pieces as string[])[0]}`, out: {}, inputs: {}, time: 0 };
  };

  it('a model is made from its unlock level on: never earlier, whatever licence a pilot holds', () => {
    const hammer = FN('cannon_hammer').unlock!.level;
    expect(canCraft(item('cannon_pip'), [], 1)).toBe(true);
    expect(canCraft(item('cannon_hammer'), [], hammer - 1)).toBe(false);
    expect(canCraft(item('cannon_hammer'), [], hammer)).toBe(true);
    // No licence teaches one early: weapons, legendaries or anything else
    const spear = FN('railgun_spear').unlock!.level;
    expect(canCraft(item('railgun_spear'), ['fn:railgun'], 1)).toBe(false);
    expect(canCraft(item('railgun_spear'), ['fn:railgun_spear'], spear - 1)).toBe(false);
    expect(canCraft(item('railgun_spear'), [], spear)).toBe(true);
    const torch = FN('engine_fusion_torch').unlock!.level;
    expect(canCraft(item('engine_fusion_torch'), ['fn:plasma_drive', 'fn:plasma', 'fn:engine_fusion_torch'], torch - 1)).toBe(false);
    expect(canCraft(item('engine_fusion_torch'), [], torch)).toBe(true);
    // Every model has its level
    for (const f of catalog.functions.values()) if (f.model) expect(f.unlock?.level, f.id).toBeTypeOf('number');
    // Legendaries: their level alone (a held schematic doesn't open one early); their gate is their boss's artefact
    const hive = FN('legendary_hive').unlock!;
    expect(canCraft(item('legendary_hive'), ['fn:hive'], hive.level - 1)).toBe(false);
    expect(canCraft(item('legendary_hive'), [], hive.level)).toBe(true);
    const legendaries = [...catalog.functions.values()].filter((f) => f.model && f.rarity === 'legendary');
    // (Exactly the legendary_* models, whatever their number)
    expect(legendaries.map((f) => f.id).sort()).toEqual([...catalog.functions.values()].filter((f) => f.model && f.id.startsWith('legendary_')).map((f) => f.id).sort());
    expect(legendaries.length).toBeGreaterThan(0);
    for (const f of legendaries) expect(f.unlock!.level, f.id).toBeGreaterThan(0);
    // Never in another material; legacy parts never
    expect(partLicensed({ fn: 'cannon_pip', material: 'steel' }, [], 99)).toBe(false);
    expect(partLicensed({ fn: 'weapon', material: 'alloy' }, ['fn:weapon'], 99)).toBe(false);
  });

  it("structure materials come by level (no licence opens one early); a job's material needs its job too", () => {
    expect(partLicensed({ fn: 'hull', material: 'alloy' }, [], 1)).toBe(true);
    expect(partLicensed({ fn: 'hull', material: 'steel' }, [], MATERIAL_LEVEL.steel - 1)).toBe(false);
    expect(partLicensed({ fn: 'hull', material: 'steel' }, [], MATERIAL_LEVEL.steel)).toBe(true);
    expect(partLicensed({ fn: 'armor', material: 'titanium' }, ['material:titanium'], MATERIAL_LEVEL.titanium - 1)).toBe(false);
    // The special materials by level too
    expect(partLicensed({ fn: 'hull', material: 'dense_ferrite' }, ['material:dense_ferrite'], MATERIAL_LEVEL.dense_ferrite - 1)).toBe(false);
    expect(partLicensed({ fn: 'hull', material: 'dense_ferrite' }, [], MATERIAL_LEVEL.dense_ferrite)).toBe(true);
    // Leestone: its level, and the Ark's job (Ark-Heavy hands you the licence)
    expect(partLicensed({ fn: 'hull', material: 'leestone' }, [], 100)).toBe(false);
    expect(partLicensed({ fn: 'hull', material: 'leestone' }, ['material:leestone'], MATERIAL_LEVEL.leestone - 1)).toBe(false);
    expect(partLicensed({ fn: 'hull', material: 'leestone' }, ['material:leestone'], MATERIAL_LEVEL.leestone)).toBe(true);
    // Every material a player builds with has a level; the bosses' own and dev's don't
    for (const m of catalog.materials.values()) expect(MATERIAL_LEVEL[m.id] !== undefined, m.id).toBe(!m.exclusive);
    // The core still needs its licence
    expect(canCraft({ id: 'part:alloy:core:sq', out: {}, inputs: {}, time: 0 }, [], 50)).toBe(false);
    expect(canCraft({ id: 'part:alloy:core:sq', out: {}, inputs: {}, time: 0 }, ['fn:core'], 1)).toBe(true);
  });
});

describe('legacy parts stand for models', () => {
  it('a legacy part becomes its family\'s model of its size (its own piece first, then the nearest size)', () => {
    expect(legacyModel(catalog, { fn: 'weapon', piece: 'sq' })!.id).toBe('cannon_pip');
    expect(legacyModel(catalog, { fn: 'weapon', piece: 'rect2' })!.id).toBe('cannon_hammer');
    expect(legacyModel(catalog, { fn: 'weapon', piece: 'block3' })!.id).toBe('cannon_bastion');
    expect(legacyModel(catalog, { fn: 'thruster', piece: 'tri' })!.id).toBe('engine_vernier');
    // (An engine whose family has none its size: the engine of that size pushing nearest what it did)
    expect(legacyModel(catalog, { fn: 'thruster', piece: 'rect2' })!.id).toBe('engine_plasma_drive');
    expect(legacyModel(catalog, { fn: 'thruster', piece: 'block2' })!.id).toBe('engine_fusion_torch');
    expect(legacyModel(catalog, { fn: 'thruster', piece: 'block2' }, 0)!.id).toBe('engine_ion_drive');
    expect(legacyModel(catalog, { fn: 'shield', piece: 'rect2' })!.id).toBe('shield_deflector');
    expect(legacyModel(catalog, { fn: 'generator', piece: 'rect2' })!.id).toBe('power_overclock_reactor');
    expect(legacyModel(catalog, { fn: 'generator', piece: 'rect2' }, 0)!.id).toBe('power_cell_reactor');
    expect(legacyModel(catalog, { fn: 'hive', piece: 'block2' })!.id).toBe('legendary_hive');
    expect(legacyModel(catalog, { fn: 'hull', piece: 'sq' })).toBeNull();
    // Items: counts kept, ids mapped; structure as it was; conduits hull
    expect(migratePartItem(catalog, 'part:steel:weapon:sq')).toBe('part:alloy:cannon_pip:sq');
    expect(migratePartItem(catalog, 'part:titanium:railgun:rect2')).toBe(`part:${FN('railgun_needle').material}:railgun_needle:rect2`);
    expect(migratePartItem(catalog, 'part:steel:conduit:rect2')).toBe('part:steel:hull:rect2');
    expect(migratePartItem(catalog, 'part:cobalt:armor:sq')).toBe('part:cobalt:armor:sq');
    expect(migratePartItem(catalog, 'iron_ore')).toBe('iron_ore');
  });

  it('the library ships run on the ports core: valid, nothing legacy, every gun, engine and tool fed through its ports', () => {
    const names = readdirSync(join(SHIP_DATA_DIR, 'blueprints')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    expect(names.sort()).toEqual(['ark-tender', 'arrow', 'bulwark', 'drum', 'halberd', 'hauler', 'prospector', 'quarry', 'sparrow-t', 'sunspear', 'wisp']);
    // (a production catalog: the ship-wide bubbles are switched off for player ships, so a library ship's old shield asks nothing)
    const prod = loadCatalog(readCatalogFiles());
    for (const name of names) {
      const b = blueprint(name);
      expect(b.power, name).toBe('ports');
      expect(b.parts.filter((q) => FN(q.fn).legacy).map((q) => q.fn), name).toEqual([]);
      expect(validateBlueprint(prod, b, tuning, null).errors, name).toEqual([]);
      const d = createShipState(prod, tuning, 1, b, 0).derived;
      expect(d.alive.every(Boolean), name).toBe(true);
      const L = d.ports!;
      const unfed = [...L.weapons, ...L.thrusters, ...L.tools].filter((i) => L.inStart[i + 1] === L.inStart[i] || L.openIn[i]).map((i) => b.parts[i].fn);
      expect(unfed, name).toEqual([]);
    }
  });


  it('a save from before models (version 3) no longer loads: it throws, never a fresh pilot', () => {
    const kit: StarterKit = { blueprint: blueprint('sparrow-t'), planFile: 'sparrow-t', credits: 300, storage: {}, home: 'sol_station_central', position: { system: 'sol', x: 0, y: 0 } };
    expect(OLDEST_PROFILE_VERSION).toBe(5);
    expect(() => migrateProfile({ version: 3, credits: 1300, xp: 1300 }, kit, catalog)).toThrow(/v3 is older than v5/);
  });
});
