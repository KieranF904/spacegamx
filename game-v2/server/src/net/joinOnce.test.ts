/**
 * A socket joins once (net/auth.ts handleJoin, SEC-02): a second `join`, or a sign-in on top of one, can't swap who the
 * socket is past the one-session sweep and the profile lease; join attempts are rate limited (MessageLimits). A guest
 * coming back with their key is a new socket, and still gets their pilot back.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import type { ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from './LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { MessageLimiter, MESSAGE_LIMITS } from './MessageLimits.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);
const shipConfig = loadShipConfigCached(dataDir);
const KEY = '0123456789abcdef0123456789abcdef';
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

const userDB = {
  checkSession: async (t: string) => {
    const id = Number(t.split(':')[1]);
    return id ? { user: { id, username: `pilot${id}`, email: '', is_admin: false, is_owner: false, created_at: '' } } : { user: null, error: 'no' };
  },
  login: async (username: string) => ({ success: true, token: 'tok:9', user: { id: 9, username, is_admin: false, is_owner: false } }),
  validateSession: async () => null, cleanupExpiredSessions: async () => {}, admin: null,
};

function server(opts: { tutorial?: boolean } = {}) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  return new GameServer({
    gameData: new GameData(files), userDB: userDB as never, scene: 'sectors', autoStart: false,
    ships: createShipBridge(shipConfig), profileStore: new MemoryProfileStore(), ...opts,
  });
}

function pilot(gs: GameServer) {
  const t = new LocalTransport(gs);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  const conn = () => (gs as any).clients.get((t as any).socket);
  const results = () => got.filter((m) => m.type === 'authResult') as Extract<ServerMessage, { type: 'authResult' }>[];
  return { t, got, conn, results };
}

describe('a socket joins once', () => {
  it('a second join on a joined socket is ignored: same name, same pilot, one answer', async () => {
    const gs = server();
    const p = pilot(gs);
    p.t.send({ type: 'join', username: 'Alice' } as never);
    await flush();
    const pid = p.t.getPlayerId();
    p.t.send({ type: 'join', username: 'Bob' } as never);
    await flush();
    expect(p.conn().username).toBe('Alice');
    expect(p.t.getPlayerId()).toBe(pid);
    expect(p.results()).toHaveLength(1);
  });

  it("a guest can't turn into an account with a token join on top (the sweep and the lease are skipped otherwise)", async () => {
    const gs = server();
    const p = pilot(gs);
    p.t.send({ type: 'join', username: 'Alice' } as never);
    await flush();
    p.t.send({ type: 'join', token: 'tok:5', username: 'pilot5' } as never);
    await flush();
    expect(p.conn().userId).toBeNull();
    expect(p.conn().username).toBe('Alice');
  });

  it("an account can't swap to another account on the same socket", async () => {
    const gs = server();
    const p = pilot(gs);
    p.t.send({ type: 'join', token: 'tok:5', username: 'pilot5' } as never);
    await flush();
    expect(p.conn().userId).toBe(5);
    p.t.send({ type: 'join', token: 'tok:6', username: 'pilot6' } as never);
    await flush();
    expect(p.conn().userId).toBe(5);
    expect(p.conn().username).toBe('pilot5');
  });

  it('the same account on a new socket still ends the old session (the one-session sweep)', async () => {
    const gs = server();
    const a = pilot(gs);
    a.t.send({ type: 'join', token: 'tok:5', username: 'pilot5' } as never);
    await flush();
    const b = pilot(gs);
    b.t.send({ type: 'join', token: 'tok:5', username: 'pilot5' } as never);
    await flush();
    expect(b.conn().userId).toBe(5);
    expect(a.conn().userId).toBeNull();
    expect(a.results().at(-1)?.success).toBe(false);
  });

  it('a guest back with their key on a new socket has their pilot again, and the old socket is ended', async () => {
    const gs = server({ tutorial: true });
    const a = pilot(gs);
    a.t.send({ type: 'join', username: 'Guest_1', guestKey: KEY } as never);
    await flush();
    gs.tutorial!.completeStep(a.conn(), 'welcome');
    gs.pilots.addCredits(a.conn(), 777);
    const credits = gs.pilots.get(a.conn())!.credits;
    // (A reconnect the server hasn't seen the old socket close for)
    const b = pilot(gs);
    b.t.send({ type: 'join', username: 'Guest_1', guestKey: KEY } as never);
    await flush();
    expect(b.results().at(-1)?.success).toBe(true);
    expect(gs.pilots.get(b.conn())!.credits).toBe(credits);
    expect(gs.pilots.get(b.conn())!.tutorial.step).toBe('rings');
    expect(a.results().at(-1)?.success).toBe(false);
    // (and the old socket joining again can't take it back)
    a.t.send({ type: 'join', username: 'Guest_1', guestKey: KEY } as never);
    await flush();
    expect(a.conn().guestId).toBeNull();
  });

  it('join attempts are rate limited', () => {
    expect(MESSAGE_LIMITS.join).toBeDefined();
    let t = 0;
    const limiter = new MessageLimiter(() => t);
    const conn = {};
    let passed = 0;
    for (let i = 0; i < 20; i++) if (limiter.allow(conn, 'join')) passed++;
    expect(passed).toBe(MESSAGE_LIMITS.join.burst);
    t += 60_000;
    expect(limiter.allow(conn, 'join')).toBe(true);
  });
});
