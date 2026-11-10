import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import type { ServerMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { PostgresProfileStore } from '../../profile/PostgresProfileStore.js';
import { FakePgPool } from '../../profile/fakePg.js';
import { LEASE_MS } from '../../profile/lease.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

const userDB = {
  checkSession: async (t: string) => {
    const id = Number(t.split(':')[1]);
    return { user: { id, username: `pilot${id}`, email: '', is_admin: false, is_owner: false, created_at: '' } };
  },
  validateSession: async () => null, cleanupExpiredSessions: async () => {}, admin: null,
};

/** One game server ("paris") on a shared fake database; "sydney" is the other region, played by direct calls on a second store */
async function setup() {
  resetGlobals();
  const db = new FakePgPool();
  const store = await PostgresProfileStore.setup(db);
  const sydney = await PostgresProfileStore.setup(db);
  const server = new GameServer({
    gameData: new GameData(files), userDB: userDB as any, scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigCached(dataDir)), profileStore: store,
  });
  server.pilots.opts.serverId = 'paris';
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  const join = async (id: number) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: `pilot${id}`, token: `tok:${id}` } as any);
    await flush();
    return { t, got };
  };
  return { db, server, sydney, join, flush };
}

describe('profile lease on the game server', () => {
  it('claims the account on login and gives it up (saved first) when the pilot leaves', async () => {
    const { db, server, sydney, join, flush } = await setup();
    const p = await join(3);
    expect(db.leases.get(3)?.holder).toBe('paris');
    expect((await sydney.claimLease(3, 'sydney')).ok).toBe(false);
    p.t.disconnect();
    await flush();
    expect(db.profiles.has(3)).toBe(true); // saved on leaving
    expect(db.leases.has(3)).toBe(false);
    expect((await sydney.claimLease(3, 'sydney')).ok).toBe(true);
    void server;
  });

  it('refuses a login while another region holds the account, with a clear message', async () => {
    const { db, sydney, join } = await setup();
    await sydney.claimLease(4, 'sydney');
    const p = await join(4);
    const fail = p.got.filter((m) => m.type === 'authResult' && !(m as any).success) as any[];
    expect(fail.at(-1)?.error).toMatch(/still in another region/);
    expect(db.leases.get(4)?.holder).toBe('sydney'); // untouched
    expect(db.profiles.has(4)).toBe(false); // and nothing of theirs was saved over
  });

  it('lets a pilot in once the other region lost its lease (crash) or let go', async () => {
    const { db, sydney, join } = await setup();
    await sydney.claimLease(5, 'sydney');
    db.clock += LEASE_MS + 1;
    const p = await join(5);
    expect(p.got.some((m) => m.type === 'authResult' && !(m as any).success)).toBe(false);
    expect(db.leases.get(5)?.holder).toBe('paris');
  });

  it('keeps pilots\' leases alive while they are on', async () => {
    const { db, server, join, flush } = await setup();
    await join(6);
    const before = db.leases.get(6)!.until;
    db.clock += 40_000;
    server.pilots.opts.leaseRenewMs = 0;
    server.pilots.tick();
    await flush();
    expect(db.leases.get(6)!.until).toBe(before + 40_000);
  });

  it('keeps the lease when the final save fails (so no region loads a stale profile)', async () => {
    const { db, sydney, join, flush } = await setup();
    const p = await join(8);
    db.down = true;
    p.t.disconnect();
    await flush();
    db.down = false;
    expect(db.leases.get(8)?.holder).toBe('paris');
    expect((await sydney.claimLease(8, 'sydney')).ok).toBe(false);
  });

  it("a server that lost the lease can't save over the region that took it (SD-03)", async () => {
    const { db, server, sydney, join, flush } = await setup();
    const p = await join(10);
    // Paris stalls past the lease; Sydney takes the account and saves it
    db.clock += LEASE_MS + 1;
    expect((await sydney.claimLease(10, 'sydney')).ok).toBe(true);
    await sydney.save(10, { version: 6, mark: 'sydney' }, 'sydney');
    const conn = server.pilots.connOf(p.t.getPlayerId())!;
    server.pilots.saveNow(conn);
    p.t.disconnect();
    await flush();
    expect(JSON.parse(db.profiles.get(10) as string).mark).toBe('sydney'); // untouched by paris
    expect(db.leases.get(10)?.holder).toBe('sydney');
    // (The holder itself saves as before)
    await sydney.save(10, { version: 6, mark: 'again' }, 'sydney');
    expect(JSON.parse(db.profiles.get(10) as string).mark).toBe('again');
  });

  it('refuses the login (fails closed) while the database cannot be reached', async () => {
    const { db, join } = await setup();
    db.down = true;
    const p = await join(9);
    db.down = false;
    expect(p.got.some((m) => m.type === 'authResult' && !(m as any).success)).toBe(true);
  });
});
