import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, InSystem, Dead } from '@space-game/common';
import { addComponent } from 'bitecs';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { withDevData } from '../data/devData.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const env = process.env.NODE_ENV;
const files = withDevData(readGameDataFiles(dataDir), dataDir);
const shipConfig = loadShipConfigCached(dataDir);
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Signs in as "pilot" (user 1) with token "tok" */
const userDB = {
  validateSession: async (t: string) => (t === 'tok' ? { id: 1, username: 'pilot', email: '', is_admin: false, created_at: '' } : null),
  cleanupExpiredSessions: async () => {},
};

/** A server (started with or without devStart) and a way to join it as a guest or as "pilot" */
function serverWith(devStart: string | undefined, profileStore = new MemoryProfileStore()) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = makeServer({
    gameData: new GameData(files), userDB: userDB as any, devStart, profileStore,
    ships: createShipBridge(shipConfig),
  });
  const join = async (signedIn: boolean) => {
    const t = new LocalTransport(server);
    t.onMessage = () => {};
    t.connect();
    t.send({ type: 'join', username: signedIn ? 'pilot' : 'visitor', ...(signedIn ? { token: 'tok' } : {}) } as any);
    await flush();
    const conn = () => [...(server as any).clients.values()].find((c: any) => c.ws === (t as any).socket);
    const where = () => {
      const eid = t.getPlayerId();
      return { system: server.gameData.getSystemByNum(InSystem.systemId[eid])?.id, r: Math.hypot(Position.x[eid], Position.y[eid]) };
    };
    return { t, conn, where };
  };
  return { server, join };
}

/** In the Rockery, clear of the star (700) and inside the belt's inner edge (3500): rocks near, none underneath */
function expectRockery(at: { system?: string; r: number }): void {
  expect(at.system).toBe('dev_rockery');
  expect(at.r).toBeGreaterThan(700 + 1000);
  expect(at.r).toBeLessThan(3500);
}

describe('dev start system (dev server only)', () => {
  afterEach(() => { process.env.NODE_ENV = env; });

  it('guests join in the Rockery on a dev server, and in Sol otherwise', async () => {
    process.env.NODE_ENV = 'development';
    expectRockery((await serverWith('dev_rockery').join(false)).where());
    expect((await serverWith(undefined).join(false)).where().system).toBe('sol');
  });

  it('a returning pilot comes back in the Rockery, not where they left off; and respawns there', async () => {
    process.env.NODE_ENV = 'development';
    const store = new MemoryProfileStore();
    // Left off in Sol (a server without the option)
    const a = serverWith(undefined, store);
    const first = await a.join(true);
    expect(first.where().system).toBe('sol');
    await a.server.pilots.detach(first.conn());
    expect(((await store.load(1)) as { position: { system: string } }).position.system).toBe('sol');

    const b = serverWith('dev_rockery', store);
    const back = await b.join(true);
    expectRockery(back.where());
    // Dies, and comes back in the Rockery (it has no stations)
    addComponent(b.server.world, Dead, back.t.getPlayerId());
    back.t.send({ type: 'respawn' } as any);
    await flush();
    expectRockery(back.where());
  });

  it('never under production, even if a production server were started with it', async () => {
    process.env.NODE_ENV = 'production';
    const { join } = serverWith('dev_rockery');
    expect((await join(false)).where().system).toBe('sol');
    expect((await join(true)).where().system).toBe('sol');
  });
});
