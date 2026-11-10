import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync, existsSync, rmSync, appendFileSync } from 'fs';
import * as bitecs from 'bitecs';
import { InSystem } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');

describe('telemetry', () => {
  it('writes a line for each death and each first-time milestone', async () => {
    const file = join(tmpdir(), `sg-telemetry-${process.pid}-${Date.now()}.jsonl`);
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = makeServer({ telemetry: async (lines) => appendFileSync(file, lines) });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'rookie' } as any);
    const pid = t.getPlayerId(), conn = server.pilots.connOf(pid)!;
    server.pilots.bumpStat(conn, 'kills');
    server.pilots.bumpStat(conn, 'kills');
    server.pilots.onDestroyed(conn, InSystem.systemId[pid], 0, 170000, 0, 0, { by: 'Pirate Raider', region: 'reaches' });
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    rmSync(file, { force: true });
    // The first kill once, however many follow
    expect(lines.filter((l) => l.ev === 'first_kill').length).toBe(1);
    const death = lines.find((l) => l.ev === 'death');
    expect(death).toMatchObject({ who: 'g:rookie', system: 'sol', by: 'Pirate Raider', region: 'reaches', safe: false });
    expect(typeof death.minutes).toBe('number');
  });
});
