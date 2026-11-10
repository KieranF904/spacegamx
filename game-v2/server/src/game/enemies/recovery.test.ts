/**
 * Every enemy's recovery (docs/bosses/rework-2026-11.md 8): out of combat LIFE.idle ticks, then healed to full over
 * LIFE.heal, lost parts regrown at the end; damage stops it. The pure clock first, then a grid pack and a custom enemy
 * on the server (their last combat set back in time rather than waiting minutes).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { InSystem, Position, LIFE } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { EnemyRecovery } from './recovery.js';
import { makeServer } from '../../testkits/world.testkit.js';

describe('enemy recovery (the clock)', () => {
  it('waits LIFE.idle quiet ticks, heals in steps to full over LIFE.heal, then regrows once; combat restarts it', () => {
    let now = 0, last = 0;
    const healed: number[] = [], restored: number[] = [];
    const r = new EnemyRecovery({
      tick: () => now, heals: () => true, active: () => true, custom: () => false, lastCombat: () => last,
      heal: (_e, s) => healed.push(s), restore: (e) => restored.push(e),
    });
    r.hurt(7);
    for (now = 1; now < LIFE.idle; now++) r.tick();
    expect(healed.length).toBe(0);
    for (; now < LIFE.idle + 600; now++) r.tick();
    expect(healed.length).toBe(19);
    // Hit again: it waits the whole idle again
    last = now;
    const was = healed.length;
    for (const end = now + LIFE.idle; now < end; now++) r.tick();
    expect(healed.length).toBe(was);
    for (const end = now + LIFE.heal + 1; now <= end; now++) r.tick();
    expect(healed.reduce((a, b) => a + b, 0)).toBeGreaterThan(1);
    expect(restored).toEqual([7]);
    expect(r.size).toBe(0);
  });
});

describe('enemy recovery (on the server)', () => {
  const dataDir = join(__dirname, '../../../../data');
  const files = readGameDataFiles(dataDir);
  function world() {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = makeServer();
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'mender' } as any);
    const pid = t.getPlayerId();
    const step = (n: number) => { for (let i = 0; i < n; i++) server.step(); };
    return { server, pid, num: InSystem.systemId[pid], step };
  }

  it('a grid pirate and a custom enemy left alone heal to full; the grid one regrows a part it lost', () => {
    const { server, pid, num, step } = world();
    const x = Position.x[pid] + 60000, y = Position.y[pid];
    const [grid] = server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_gunship'] }, x, y);
    const [custom] = server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider'] }, x + 3000, y);
    expect(server.enemies.custom.has(custom)).toBe(true);
    const g = server.ships.get(grid)!, c = server.ships.get(custom)!;
    // Wear both, and shoot a part clean off the grid one
    const lost = g.blueprint.parts.findIndex((p, i) => p.fn !== 'core' && i > 0);
    for (let i = 0; i < g.hp.length; i++) if (i !== lost && g.hp[i] > 2) server.ships.damagePartBy(grid, i, g.hp[i] * 0.4, pid);
    server.ships.damagePartBy(grid, lost, g.hp[lost] * 10, pid);
    for (let i = 0; i < c.hp.length; i++) if (c.hp[i] > 2) server.ships.damagePartBy(custom, i, c.hp[i] * 0.4, pid);
    step(2);
    const g0 = server.ships.integrity(grid), c0 = server.ships.integrity(custom);
    expect(server.ships.get(grid)!.derived.alive[lost]).toBe(false);
    expect(server.recovery.size).toBe(2);
    // Their last combat, set back to just before the end of a whole recovery
    const back = server.currentTick - LIFE.idle - LIFE.heal + 40;
    server.combat.note(grid, -1, back);
    server.combat.note(custom, -1, back);
    for (const e of [grid, custom]) (server.recovery as any).wounded.set(e, back);
    const heals: number[] = [];
    const healAll = server.ships.healAll.bind(server.ships);
    (server.ships as any).healAll = (e: number, share: number) => { if (e === grid) heals.push(share); healAll(e, share); };
    step(50);
    expect(heals.length).toBeGreaterThan(0);
    void g0;
    expect(server.ships.get(grid)!.derived.alive[lost]).toBe(true);
    expect(server.ships.integrity(grid)).toBeGreaterThan(0.999);
    expect(server.ships.integrity(custom)).toBeGreaterThan(c0);
    expect(server.recovery.size).toBe(0);
  }, 60_000);
});
