import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, accelAlong, createShipState, type Blueprint } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = makeServer();
  const t = new LocalTransport(server);
  t.connect();
  t.send({ type: 'join', username: 'rookie' } as any);
  return { server, pid: t.getPlayerId(), ships: server.getShips() };
}

const hold = (pid: number, x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };

describe('the Drift (outer Sol)', () => {
  it('Scrapborn launch from their nests out in the ring, never in inner Sol', () => {
    const { server, pid, ships } = world();
    const scrap = () => [...ships.bodies.keys()].filter((e) => server.enemies.factionOf(e) === 'scrapborn' && !server.enemies.info(e)?.boss);
    // Inner Sol: none
    for (let i = 0; i < 60 * 30; i++) { hold(pid, 40000, 0); server.step(); }
    expect(scrap().length).toBe(0);
    // Out in the Drift, near a nest (but out of its drones' sight): they come out of it and stay round it
    const num = InSystem.systemId[pid];
    const nest = () => server.enemies.nest(num, 'sol_nest_drift_east')!;
    for (let i = 0; i < 60 * 40 && scrap().length < 6; i++) { const n = nest(); hold(pid, n.x + 15000, n.y); server.step(); }
    const found = nest().packs.flat();
    expect(found.length).toBeGreaterThanOrEqual(3);
    // Its packs are always out (populations): a loose pack's ghost keeps 0.6-1.8× the nest's roam off it, each ship a
    // pack spacing (380) off its lead, and it's loaded right there, so that's how far round the nest they are
    const roam = (server.gameData.factionsFile as any).spawns.sol.nests.find((q: any) => q.id === 'sol_nest_drift_east').roam as number;
    for (const e of found) {
      expect(Math.hypot(Position.x[e], Position.y[e])).toBeGreaterThan(90000);
      expect(Math.hypot(Position.x[e] - nest().x, Position.y[e] - nest().y)).toBeLessThan(roam * 1.8 + 380 + 500);
      // Junk: flimsy for its weight
      const s = ships.get(e)!;
      expect(s.maxHp.reduce((a, b) => a + b, 0)).toBeLessThan(800);
    }
    expect(InSystem.systemId[found[0]]).toBe(num);
  });

  it('Scrapborn fly at most half as fast as a starter ship', () => {
    const { server, ships } = world();
    // Top speed goes with forward acceleration (drag is the same for every ship), so compare that
    const forward = (bp: Blueprint) => accelAlong(createShipState(ships.catalog, ships.tuning, 0, bp, 0).derived, [0, -1]);
    const starter = forward(ships.playerBlueprint);
    // As Sol builds them (its grade: Mk I); bosses are built as designed
    const sol = server.enemies.gradeOf(server.gameData.getSystemNum('sol'));
    for (const t of ['scrap_mite', 'scrap_spitter', 'scrap_crawler', 'boss_scrap_mother']) {
      const bp = t.startsWith('boss_') ? ships.enemyDesigns[t] : server.enemies.design(t, sol)!;
      expect(forward(bp), t).toBeLessThanOrEqual(starter / 2);
    }
  });

  it('the Scrap Mother waits in her lair, at the heart of her nest (its way in out in the Drift)', () => {
    const { server } = world();
    const gd = server['gameData'];
    const eid = server.bosses.spawn('boss_scrap_mother');
    expect(eid).toBeGreaterThanOrEqual(0);
    expect(InSystem.systemId[eid]).toBe(gd.getSystemNum('sol_scrap_nest'));
    expect(Math.hypot(Position.x[eid], Position.y[eid])).toBeLessThan(500);
    const e = gd.getSystem('sol_scrap_nest')!.pocket!.entrance;
    expect(Math.hypot(e.x, e.y)).toBeGreaterThan(96000);
    expect(Math.hypot(e.x, e.y)).toBeLessThan(120000);
  });
});
