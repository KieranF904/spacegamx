import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { createShipState, rateShip, regrade, partDemand, weaponStrength, partThrust, boostOf, parseBlueprint, type Blueprint } from '@space-game/common';
import { readFileSync } from 'fs';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const gameData = new GameData(readGameDataFiles(dataDir));
  const server = new GameServer({
    gameData, userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)),
  });
  return { server, gameData, ships: server.getShips() };
}

describe('grades, sizes and ship ratings', () => {
  it('a starter ship rates about 10, and each grade rates it higher', () => {
    const { ships } = world();
    const rate = (bp: Blueprint) => rateShip(ships.catalog, ships.tuning, createShipState(ships.catalog, ships.tuning, 0, bp, 0)).rating;
    const starter = rate(ships.playerBlueprint);
    expect(starter).toBeGreaterThan(8);
    expect(starter).toBeLessThan(12);
    let last = starter;
    for (let g = 2; g <= 5; g++) {
      const r = rate(regrade(ships.catalog, ships.playerBlueprint, g));
      expect(r, `Mk ${g}`).toBeGreaterThan(last);
      last = r;
    }
  });

  it('better and bigger weapons hit harder, and draw more power for it', () => {
    const { ships } = world();
    const cat = ships.catalog, cannon = cat.functions.get('weapon')!, alloy = cat.materials.get('alloy'), ti = cat.materials.get('titanium');
    expect(weaponStrength(cat, cannon, 1, alloy)).toBeCloseTo(1, 6);
    expect(weaponStrength(cat, cannon, 1, ti)).toBeGreaterThan(1.5);
    expect(partDemand(cannon, 1, ti)).toBeGreaterThan(partDemand(cannon, 1, alloy));
    // A 2×2 cannon: four cells' power, a bit more than four cannons' punch
    const big = weaponStrength(cat, cannon, 4, alloy);
    expect(big).toBeGreaterThan(4);
    expect(big / partDemand(cannon, 4, alloy)).toBeGreaterThan(1 / partDemand(cannon, 1, alloy));
    // Railguns come two cells long at their smallest: that's their base size
    expect(weaponStrength(cat, cat.functions.get('railgun')!, 2, alloy)).toBeCloseTo(1, 6);
  });

  it('engines: bigger ones push more for their size, better grades push harder, and each kind boosts its own way', () => {
    const { ships } = world();
    const cat = ships.catalog, alloy = cat.materials.get('alloy'), ti = cat.materials.get('titanium');
    const ion = cat.functions.get('thruster')!, burner = cat.functions.get('afterburner')!, plasma = cat.functions.get('plasma_drive')!;
    expect(partThrust(cat, ion, 4, alloy) / 4).toBeGreaterThan(partThrust(cat, ion, 1, alloy));
    expect(partThrust(cat, ion, 1, ti)).toBeGreaterThan(partThrust(cat, ion, 1, alloy));
    // A plasma drive out-pushes an ion thruster its size, and draws more power for it
    expect(partThrust(cat, plasma, 2, alloy)).toBeGreaterThan(partThrust(cat, ion, 2, alloy));
    expect(partDemand(plasma, 2, alloy)).toBeGreaterThan(partDemand(ion, 2, alloy));
    // The starter's boost is its Ion Drives' (on the ports core, each engine's own: energy.ts boostOf)
    const starter = createShipState(ships.catalog, ships.tuning, 0, ships.playerBlueprint, 0).derived;
    expect(boostOf(starter)).toBeCloseTo(cat.functions.get('engine_ion_drive')!.boost!, 6);
    // An afterburner ship's kicks harder and drains faster: the pool core's ship-wide boost and drain, on the pool-era
    // starter (a fixture)
    const pool: Blueprint = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/fixtures/sparrow-t.json'), 'utf-8'));
    expect(createShipState(ships.catalog, ships.tuning, 0, pool, 0).derived.boostFactor).toBeCloseTo(cat.functions.get('engine_ion_drive')!.boost!, 6);
    const swapped = { ...pool, parts: pool.parts.map((p) => (p.fn === 'engine_ion_drive' ? { ...p, fn: 'engine_afterburner' } : p)) };
    const d = createShipState(ships.catalog, ships.tuning, 0, swapped, 0).derived;
    expect(d.boostFactor).toBeGreaterThan(3);
    expect(d.boostDrain).toBeGreaterThan(2);
    expect(burner.boost).toBeGreaterThan(ion.boost!);
  });

  it('systems get harder the further out they are, and so do the siege moons', () => {
    const { server, gameData } = world();
    const threats = server.threats();
    const danger = (id: string) => gameData.getSystem(id)!.danger ?? 1;
    const worlds = Object.keys(threats).filter((id) => !gameData.getSystem(id)!.surface).sort((a, b) => danger(a) - danger(b));
    const moons = Object.keys(threats).filter((id) => gameData.getSystem(id)!.surface?.bastion)
      .sort((a, b) => (gameData.getSystem(a)!.surface!.bastion!.grade ?? 1) - (gameData.getSystem(b)!.surface!.bastion!.grade ?? 1));
    console.log('threats', worlds.map((id) => `${id} ${threats[id]}`).join(', '), '| moons', moons.map((id) => `${id} ${threats[id]}`).join(', '));
    expect(worlds.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < worlds.length; i++) expect(threats[worlds[i]], worlds[i]).toBeGreaterThanOrEqual(threats[worlds[i - 1]]);
    expect(moons.length).toBe(5);
    for (let i = 1; i < moons.length; i++) expect(threats[moons[i]], moons[i]).toBeGreaterThan(threats[moons[i - 1]]);
  });

  it('a system builds its hostiles in its grade, and names them for it', () => {
    const { server, gameData } = world();
    const num = gameData.getSystemNum('cinder_reach');
    const [eid] = server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_skiff'] }, 1000, 1000);
    const info = server.enemies.info(eid)!;
    expect(info.grade).toBe(3);
    expect(info.name).toContain('Mk III');
    expect(server.getShips().get(eid)!.blueprint.parts.every((p) => p.material === 'titanium')).toBe(true);
    expect(info.rating).toBeGreaterThan(0);
  });
});
