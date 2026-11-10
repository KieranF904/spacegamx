/**
 * Guests kept by their browser's key (pilots/guests.ts): a guest who joins again with it (a dropped socket, a restarted
 * server) flies on as they were, tutorial step, credits and place; without it, or with another key, a fresh pilot. The
 * keep is bounded (time and count) and holds a hash of the key, never the key.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, InSystem, type ServerMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../ships/createShipBridge.js';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { GuestKeep, guestIdOf, GUEST_DOC, GUEST_KEEP_MAX, GUEST_KEEP_MS } from './guests.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const shipConfig = loadShipConfigCached(dataDir);
const KEY = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const flush = () => new Promise((r) => setTimeout(r, 0));

function server(store: MemoryProfileStore) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  return new GameServer({
    gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false, tutorial: true, ships: createShipBridge(shipConfig), profileStore: store,
  });
}

async function join_(gs: GameServer, name: string, guestKey?: string) {
  const t = new LocalTransport(gs);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: name, ...(guestKey ? { guestKey } : {}) } as never);
  await flush(); await flush();
  const conn = () => gs.pilots.connOf(t.getPlayerId())!;
  return { t, got, conn, profile: () => gs.pilots.get(conn())! };
}

describe('guests kept by their key', () => {
  it('a guest back after a dropped socket has their pilot as they left it: tutorial step, credits, place', async () => {
    const gs = server(new MemoryProfileStore());
    const a = await join_(gs, 'Guest_1', KEY);
    gs.tutorial!.completeStep(a.conn(), 'welcome');
    gs.pilots.addCredits(a.conn(), 1234);
    const credits = a.profile().credits;
    const pid = a.t.getPlayerId();
    Position.x[pid] += 300;
    const x = Position.x[pid];
    a.t.disconnect();
    await flush();
    gs.step();

    const b = await join_(gs, 'Guest_1', KEY);
    expect(b.profile().tutorial.step).toBe('rings');
    expect(b.profile().credits).toBe(credits);
    const now = b.t.getPlayerId();
    expect(InSystem.systemId[now]).toBe(gs.gameData.getSystemNum('vesta_yard'));
    expect(Math.abs(Position.x[now] - x)).toBeLessThan(2);
    // (and told so: the client's tutorial resumes at that step)
    const state = b.got.filter((m) => m.type === 'tutorialState').pop() as Extract<ServerMessage, { type: 'tutorialState' }>;
    expect(state.step).toBe('rings');
  });

  it('kept across a server restart (the store written on shutdown, or by the tick if killed)', async () => {
    const store = new MemoryProfileStore();
    const gs = server(store);
    const a = await join_(gs, 'Guest_2', KEY);
    gs.tutorial!.completeStep(a.conn(), 'welcome');
    await gs.saveAll();
    // (A new process on the same store, the old one gone without a word)
    const gs2 = server(store);
    const b = await join_(gs2, 'Guest_2', KEY);
    expect(b.profile().tutorial.step).toBe('rings');
  });

  it('a step finished is kept at once: a server killed right after it still has it', async () => {
    const store = new MemoryProfileStore();
    let now = 1_000_000;
    const gs = server(store);
    (gs.pilots as unknown as { now: () => number }).now = () => now;
    const a = await join_(gs, 'Guest_3', KEY);
    gs.tutorial!.completeStep(a.conn(), 'welcome');
    now += 60_000;
    gs.pilots.tick();
    await flush(); await flush();
    const doc = (await store.loadDoc(GUEST_DOC)) as { guests: { profile: { tutorial: { step: string } } }[] };
    expect(doc.guests[0].profile.tutorial.step).toBe('rings');
  });

  it('no key, or another key: a fresh pilot (a name proves nothing)', async () => {
    const gs = server(new MemoryProfileStore());
    const a = await join_(gs, 'Guest_4', KEY);
    gs.tutorial!.completeStep(a.conn(), 'welcome');
    a.t.disconnect();
    await flush();
    expect((await join_(gs, 'Guest_4')).profile().tutorial.step).toBe('welcome');
    expect((await join_(gs, 'Guest_4', OTHER)).profile().tutorial.step).toBe('welcome');
  });

  it('the same key joining again while its old connection is still open: the old one is kept and ended', async () => {
    const gs = server(new MemoryProfileStore());
    const a = await join_(gs, 'Guest_5', KEY);
    gs.tutorial!.completeStep(a.conn(), 'welcome');
    const b = await join_(gs, 'Guest_5', KEY);
    expect(b.profile().tutorial.step).toBe('rings');
    expect(a.got.some((m) => m.type === 'authResult' && !(m as { success: boolean }).success)).toBe(true);
  });

  it('keeps a hash of the key, for GUEST_KEEP_MS and GUEST_KEEP_MAX at most', async () => {
    expect(guestIdOf('nope')).toBeNull();
    expect(guestIdOf(42)).toBeNull();
    expect(guestIdOf(KEY)).not.toBe(KEY);
    expect(guestIdOf(KEY)).toBe(guestIdOf(KEY.toUpperCase()));
    let now = 0;
    const store = new MemoryProfileStore();
    const keep = new GuestKeep(store, () => now);
    keep.put('a', 'A', { n: 1 });
    now += GUEST_KEEP_MS + 1;
    expect(await keep.take('a')).toBeNull();
    for (let i = 0; i < GUEST_KEEP_MAX + 5; i++) keep.put(`g${i}`, 'G', { n: i });
    expect(keep.size).toBe(GUEST_KEEP_MAX);
    expect(await keep.take('g0')).toBeNull();
    expect((await keep.take(`g${GUEST_KEEP_MAX + 4}`))?.profile).toEqual({ n: GUEST_KEEP_MAX + 4 });
    await keep.flush();
    const raw = JSON.stringify(await store.loadDoc(GUEST_DOC));
    expect(raw).not.toContain(KEY);
    // (read back by the next process)
    const again = new GuestKeep(store, () => now);
    expect((await again.take('g10'))?.profile).toEqual({ n: 10 });
  });
});
