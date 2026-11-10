import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, InSystem, ServerMessage, outlierScale } from '@space-game/common';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const gameData = new GameData(files);
  const server = makeServer({
    gameData, });
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'ava' } as any);
  return { server, gameData, step, t, got, pid: t.getPlayerId(), conn: server.pilots.connOf(t.getPlayerId())! as any };
}

describe('Ashfall Drift', () => {
  it("is one gate from Sol, and as safe a tier as Sol's next door", () => {
    const { gameData, server } = world();
    const ash = gameData.getSystem('ashfall')!;
    expect(ash.danger).toBe(1);
    expect(ash.centralBody?.type).toBe('brown_dwarf');
    expect(gameData.getSystem('sol')!.portals.some((p) => p.targetSystem === 'ashfall')).toBe(true);
    expect(ash.portals.some((p) => p.targetSystem === 'sol')).toBe(true);
    // Its threat sits with the starter systems, well under Borealis
    const threats = server.threats();
    expect(threats.ashfall).toBeGreaterThan(0);
    expect(threats.ashfall).toBeLessThan(threats.borealis);
  });

  it('a crowded belt of common rock, boulders among it, and outliers four times as often', () => {
    const { server, gameData } = world();
    const num = gameData.getSystemNum('ashfall');
    const ids = (server as any).asteroidIdsBySystem.get(num) as number[];
    expect(ids.length).toBe(560);
    const types = ids.map((e) => (server as any).asteroidTypeById.get(e));
    expect(types.filter((t) => t === 'rock_ashback').length).toBeGreaterThan(40);
    let here = 0, sol = 0;
    for (let i = 0; i < 20000; i++) {
      if (outlierScale('seed', 'ashfall', 0, i, 'asteroid_metal')) here++;
      if (outlierScale('seed', 'sol', 0, i, 'asteroid_metal')) sol++;
    }
    expect(here).toBeGreaterThan(sol * 3);
  });

  it("the Redtooth don't wait to be shot, and their outpost holds its ground", () => {
    const { server, gameData, step, conn, pid } = world();
    const spawns = (gameData.factionsFile as any).spawns.ashfall;
    expect(spawns.groups.some((g: any) => g.faction === 'redtooth' && !g.passive)).toBe(true);
    const num = gameData.getSystemNum('ashfall');
    (server as any).travelTo(conn, num, 30000, 30000, false);
    step(130);
    expect(InSystem.systemId[pid]).toBe(num);
    const bosses = (server as any).bosses;
    const hold = bosses.eidOf('boss_redtooth_hold');
    expect(hold).toBeGreaterThanOrEqual(0);
    const at = { x: Position.x[hold], y: Position.y[hold] };
    const lair = (gameData.bossesFile as any).bosses.boss_redtooth_hold.lair;
    expect(Math.hypot(at.x - lair.x, at.y - lair.y)).toBeLessThan(5);
    // Ram it: it doesn't budge
    Position.x[pid] = at.x; Position.y[pid] = at.y + 600;
    step(200);
    expect(Math.hypot(Position.x[hold] - at.x, Position.y[hold] - at.y)).toBeLessThan(0.01);
  });
});
