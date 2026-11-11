/**
 * The host adapters (gameServer/hosts/*.ts), on the shared test world: hostiles and bosses only see pilots who are alive,
 * visible and flying (not docked, dead or hidden by an admin); a wreck the pilot host spawns is kept for its account;
 * whereIs answers only for a live pilot; the comet follows the clock.
 */
import { describe, it, expect } from 'vitest';
import { addComponent } from 'bitecs';
import { Dead, InSystem, Lifetime, Position } from '@space-game/common';
import { createEnemyHost } from './world.js';
import { createBossHost } from './boss.js';
import { createPilotHost } from './pilots.js';
import { whereIs } from './places.js';
import { cometNow, isGas } from './mining.js';
import { joinPilot, makeEmptyServer, resetGlobals } from '../../testkits/world.testkit.js';

function rig(clock?: () => number) {
  resetGlobals();
  const server = makeEmptyServer(clock ? { clock } : {});
  const pilots = ['A', 'B', 'C', 'D'].map((n) => {
    const p = joinPilot(server, n);
    return { ...p, conn: [...server.clients.values()].find((c) => c.playerId === p.pid)! };
  });
  const num = InSystem.systemId[pilots[0].pid];
  for (const p of pilots) { InSystem.systemId[p.pid] = num; Position.x[p.pid] = 90000; Position.y[p.pid] = 90000; }
  return { server, pilots, num };
}

describe('hosts: who a hostile or a boss sees', () => {
  it('only living, visible, undocked pilots in the system', () => {
    const { server, pilots, num } = rig();
    const [a, b, c, d] = pilots;
    const enemy = createEnemyHost(server), boss = createBossHost(server);
    expect(enemy.players(num).sort()).toEqual(pilots.map((p) => p.pid).sort());
    // (B dead, C docked, D hidden by an admin)
    addComponent(server.world, Dead, b.pid);
    server.dockedShips.add(c.pid);
    server.admin.hidden.add(d.conn as never);
    expect(enemy.players(num)).toEqual([a.pid]);
    expect(boss.players(num)).toEqual([a.pid]);
    expect(enemy.players(num + 1)).toEqual([]);
    expect(enemy.docked(c.pid)).toBe(true);
    expect(enemy.docked(a.pid)).toBe(false);
  });
});

describe('hosts: wrecks, places and the comet', () => {
  it('the pilot host keeps a wreck it spawns for its key until its seconds run out (in ticks)', () => {
    const { server, num } = rig();
    const host = createPilotHost(server);
    const keep: unknown[][] = [];
    server.pods.keep = ((...a: unknown[]) => { keep.push(a); }) as never;
    const eid = host.spawnWreck!(num, 90000, 90000, 0, 0, { steel_plate: 3 }, 'u:7', 90, 200);
    expect(eid).toBeGreaterThanOrEqual(0);
    expect(keep).toEqual([[eid, 'u:7', server.currentTick + 90 * 60]]);
    // (It lasts its whole life: kept, then open to anyone)
    expect(Lifetime.remaining[eid]).toBe(200 * 60);
  });

  it('whereIs gives a live pilot\'s system and place, and nothing for a dead one', () => {
    const { server, pilots, num } = rig();
    const p = pilots[0];
    expect(whereIs(server, p.conn)).toEqual({ system: server.gameData.getSystemByNum(num)!.id, x: 90000, y: 90000 });
    addComponent(server.world, Dead, p.pid);
    expect(whereIs(server, p.conn)).toBeNull();
  });

  it('the comet passes for `hours` of every `days` of the clock, and a belt rock is not gas', () => {
    let now = 0;
    const { server } = rig(() => now);
    const c = server.gameData.miningTable.comet!;
    expect(c).toBeDefined();
    expect(cometNow(server)).toBe(true);
    now = c.hours * 3_600_000;
    expect(cometNow(server)).toBe(false);
    now = c.days * 86_400_000 + 1000;
    expect(cometNow(server)).toBe(true);
    const rock = [...server.asteroidIndexById.keys()][0];
    expect(isGas(server, rock)).toBe(false);
  });
});
