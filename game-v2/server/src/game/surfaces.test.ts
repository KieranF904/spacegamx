import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage, planetPosition } from '@space-game/common';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);

function world(data = files) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const gameData = new GameData(data);
  const server = makeServer({
    gameData, });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  return { server, gameData, t, got, pid, step, conn: server.pilots.connOf(pid)! };
}

const hold = (pid: number, x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };

describe('planet surfaces', () => {
  it('X in orbit over Terra Nova goes down; past the edge goes back up beside it', () => {
    const { server, gameData, t, pid, step } = world();
    const sol = gameData.getSystem('sol')!;
    const planet = sol.planets!.find((p) => p.id === 'terra_nova')!;
    const at = planetPosition(planet, (server as any).currentTick);
    hold(pid, at.x + planet.radius + 300, at.y);
    t.send({ type: 'interact' } as any);
    step(2);
    expect(gameData.getSystemByNum(InSystem.systemId[pid])?.id).toBe('terra_nova_surface');
    // Arrived on the side it came from (east)
    expect(Position.x[pid]).toBeGreaterThan(10000);
    hold(pid, 30000, 0);
    step(12);
    expect(gameData.getSystemByNum(InSystem.systemId[pid])?.id).toBe('sol');
    const now = planetPosition(planet, (server as any).currentTick);
    expect(Math.hypot(Position.x[pid] - now.x, Position.y[pid] - now.y)).toBeLessThan(planet.radius + 3000);
  });

  it('Terra Nova is peaceful: no sieges', () => {
    const { gameData } = world();
    expect(gameData.getSystem('terra_nova_surface')!.surface!.siege).toBeUndefined();
  });

  it('a city with a siege: pylons go up, the siege comes in waves, and the defenders are paid', () => {
    // (Terra Nova has none: give its city one for this test)
    const data = structuredClone(files);
    const tn = data.systems.systems.find((s) => s.id === 'terra_nova_surface')!.surface!;
    tn.siege = { everySeconds: 240, waves: 4, faction: 'pirates' };
    tn.city!.pylons = [{ x: 2700, y: 300 }, { x: -1500, y: 2300 }, { x: -1200, y: -2500 }];
    const { server, gameData, got, pid, step, conn } = world(data);
    const num = gameData.getSystemNum('terra_nova_surface');
    (server as any).travelTo(conn, num, 1000, 0, false);
    step(20);
    const g = (server.surfaces as any).sieges.get(num);
    expect(g.pylons.filter((e: number) => server.getShips().has(e)).length).toBe(3);
    // Bring the siege on now
    g.next = (server as any).currentTick;
    step(20);
    expect(g.phase).toBe('warning');
    g.next = (server as any).currentTick;
    step(20);
    expect(g.phase).toBe('wave');
    expect(got.some((m) => m.type === 'objective')).toBe(true);
    const credits = server.pilots.get(conn)!.credits;
    // Break every wave (the raiders vanish), defending from the city
    for (let w = 0; w < 10 && g.phase !== 'calm'; w++) {
      for (const r of g.raiders) server.getShips().removeShip(r);
      g.next = (server as any).currentTick;
      for (let i = 0; i < 30; i++) { hold(pid, 1000, 0); step(); }
    }
    expect(g.phase).toBe('calm');
    expect(server.pilots.get(conn)!.credits).toBeGreaterThan(credits);
    expect(got.some((m) => m.type === 'objectiveEnd')).toBe(true);
  });
});
