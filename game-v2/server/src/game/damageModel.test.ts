import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  hitMultiplier, penetrationMul, weaponHit, partArmour, partDemand, partSupply, partMass, weaponStrength, buildPoints, partBuildPoints, regrade, rateShip, createShipState, lookFn,
  type Blueprint, type PlacedPart,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);
const ships = createShipBridge(loadShipConfigCached(dataDir));
const cat = ships.catalog, tun = ships.tuning;
const part = (fn: string, material: string, piece = 'sq'): PlacedPart => ({ uid: 0, piece, fn, material, x: 0, y: 0, rot: 0, flip: false });
const cannon = (grade: number) => weaponHit('cannon', tun.weapons.cannon, grade);
/** The starter as enemies fly it: its models as the legacy, material-graded parts they grew from (what `regrade` grades) */
const legacyStarter = (): Blueprint => ({ ...ships.playerBlueprint, parts: ships.playerBlueprint.parts.map((p) => ({ ...p, fn: lookFn(p.fn) })) });

describe('damage: penetration, armour and materials', () => {
  it('the tier ladder: a Mk I gun does full damage to Mk I, about half through plate or Mk II, a quarter to Mk II plate, and barely scratches Mk III', () => {
    const m = (p: PlacedPart) => hitMultiplier(cat, tun, p, cannon(1));
    expect(m(part('generator', 'alloy'))).toBeCloseTo(1, 5);
    expect(m(part('armor', 'alloy'))).toBeCloseTo(0.55, 5);
    expect(partArmour(cat, part('armor', 'alloy'))).toBe(2);
    // (Steel takes less from shells: × its kinetic resist)
    expect(m(part('generator', 'steel'))).toBeCloseTo(0.55 * 0.85, 5);
    expect(m(part('armor', 'steel'))).toBeCloseTo(0.25 * 0.85, 5);
    expect(m(part('generator', 'titanium'))).toBeLessThan(0.3);
    expect(m(part('armor', 'titanium'))).toBeLessThan(0.12);
    // Equals fight evenly; a better gun gets through a little better
    expect(hitMultiplier(cat, tun, part('generator', 'titanium'), cannon(3))).toBeCloseTo(0.95, 5);
    expect(penetrationMul(1)).toBeCloseTo(1.15, 5);
    expect(penetrationMul(-0.5)).toBeCloseTo(0.775, 5);
  });

  it('weapons differ: railguns pierce, flak bursts on plate, and each material shrugs off some damage types and takes more of others', () => {
    const rail = weaponHit('railgun', tun.weapons.railgun, 1), flak = weaponHit('flak', tun.weapons.flak, 1);
    expect(rail.type).toBe('kinetic');
    expect(hitMultiplier(cat, tun, part('armor', 'alloy'), rail)).toBeGreaterThan(1);
    expect(flak.type).toBe('explosive');
    expect(hitMultiplier(cat, tun, part('armor', 'alloy'), flak)).toBeLessThan(0.3);
    // Ceramic laminate: shrugs off heat, cracks under shells
    const laser = weaponHit('laser', tun.weapons.laser, 3), shell = cannon(3);
    expect(hitMultiplier(cat, tun, part('hull', 'ceramic_laminate'), laser)).toBeLessThan(0.5);
    expect(hitMultiplier(cat, tun, part('hull', 'ceramic_laminate'), shell)).toBeGreaterThan(1.3);
    // Insulated polymer turns energy, melts in heat
    const pulse = weaponHit('pulse', tun.weapons.pulse, 2);
    expect(pulse.type).toBe('energy');
    expect(hitMultiplier(cat, tun, part('hull', 'insulated_polymer'), pulse)).toBeLessThan(0.4);
    expect(hitMultiplier(cat, tun, part('hull', 'insulated_polymer'), weaponHit('laser', tun.weapons.laser, 2))).toBeGreaterThan(1.3);
  });

  it('a better gun draws more power by as much as it hits harder: never worse for the power it takes', () => {
    const gun = cat.functions.get('weapon')!, gen = cat.functions.get('generator')!;
    const alloy = cat.materials.get('alloy'), steel = cat.materials.get('steel');
    const mk1Gun = partDemand(gun, 1, alloy), mk2Gun = partDemand(gun, 1, steel);
    const mk1Gen = partSupply(gen, 1, alloy), mk2Gen = partSupply(gen, 1, steel);
    expect(mk2Gun).toBeGreaterThan(mk1Gun);
    // Damage per unit of power: a Mk II gun on the same generators does at least as much
    expect(weaponStrength(cat, gun, 1, steel) / mk2Gun).toBeGreaterThanOrEqual(weaponStrength(cat, gun, 1, alloy) / mk1Gun - 1e-9);
    // And an all-Mk II ship has power to spare over an all-Mk I one
    expect(mk2Gen / mk2Gun).toBeGreaterThan(mk1Gen / mk1Gun);
  });

  it('armour plate is heavy', () => {
    expect(partMass(cat, part('armor', 'alloy'))).toBeCloseTo(partMass(cat, part('hull', 'alloy')) * 2.5, 5);
  });

  it('build points: every cell counts, and better grades count for more', () => {
    expect(partBuildPoints(cat, part('hull', 'alloy'))).toBe(1);
    expect(partBuildPoints(cat, part('hull', 'alloy', 'block2'))).toBe(4);
    expect(partBuildPoints(cat, part('hull', 'steel'))).toBeCloseTo(1.6, 5);
    expect(partBuildPoints(cat, part('hull', 'neutronium', 'block3'))).toBeCloseTo(9 * 5.5, 5);
    const starter = legacyStarter();
    expect(buildPoints(cat, starter)).toBeLessThanOrEqual(15);
    expect(buildPoints(cat, regrade(cat, starter, 3))).toBeGreaterThan(buildPoints(cat, starter) * 2);
    // A model counts its own points a cell, whatever it's made of; the starter's level-0 models as little as Mk I parts
    expect(partBuildPoints(cat, { piece: 'block2', fn: 'cannon_bastion', material: 'cobalt' })).toBeCloseTo(4 * cat.functions.get('cannon_bastion')!.points!, 5);
    expect(buildPoints(cat, ships.playerBlueprint)).toBe(buildPoints(cat, starter));
  });

  it('ratings show the tiers: a Mk III starter rates far above a Mk I one', () => {
    const rate = (bp: Blueprint) => rateShip(cat, tun, createShipState(cat, tun, 0, bp, 0)).rating;
    const one = rate(legacyStarter()), three = rate(regrade(cat, legacyStarter(), 3));
    // (The starter of models rates as the legacy one did)
    expect(rate(ships.playerBlueprint)).toBeCloseTo(one, 0);
    expect(one).toBeGreaterThan(8);
    expect(one).toBeLessThan(12);
    expect(three / one).toBeGreaterThan(3);
  });

  it('in a fight: the same shells hurt a Mk III hull far less than a Mk I one', () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = makeServer();
    const bridge = server.getShips();
    const a = bridge.spawnDummy(legacyStarter(), 0, 300000, 0, 0), b = bridge.spawnDummy(regrade(bridge.catalog, legacyStarter(), 3), 2000, 300000, 0, 0);
    const sa = bridge.get(a)!, sb = bridge.get(b)!;
    const gen = (s: typeof sa) => s.blueprint.parts.findIndex((p) => p.fn === 'generator');
    const hit = { hit: cannon(1) };
    const da = bridge.hurt(a, sa, gen(sa), 50, -1, hit), db = bridge.hurt(b, sb, gen(sb), 50, -1, hit);
    expect(da).toBeCloseTo(50, 3);
    expect(db).toBeLessThan(15);
    // Without a weapon behind it (a collision), damage is as it was
    expect(bridge.hurt(b, sb, gen(sb), 10, -1)).toBeCloseTo(10, 3);
  });

  it("a pilot's ship must fit their build points (a plan builds as designed)", () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = makeServer();
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'builder' } as any);
    const conn = server.pilots.connOf(t.getPlayerId())!;
    const big = server.getShips().library.get('sunspear')!;
    const why = server.hangar.save(conn, 1, JSON.parse(JSON.stringify(big)));
    expect(why.join(' ')).toContain('build points');
  });
});
