/**
 * A guest registering (pilots/convert.ts, net/handlers/guestAccount.ts): the pilot moves to the new account once, only into an
 * account with no profile, and the kept record goes with it; a guest past their 3 days is registered, never played.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { hasComponent } from 'bitecs';
import { Dead, Input, Position, type ServerMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../ships/createShipBridge.js';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { guestIdOf } from './guests.js';
import { makeEmptyServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const shipConfig = loadShipConfigCached(dataDir);
const KEY = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const H = 60 * 60_000;
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };

/** The lobby's accounts as the game server asks them: a session token is a user */
const accounts: Record<string, { id: number; username: string; email: string; is_admin: boolean; created_at: string }> = {
  tokAlice: { id: 7, username: 'Alice', email: '', is_admin: false, created_at: '' },
  tokBob: { id: 8, username: 'Bob', email: '', is_admin: false, created_at: '' },
};
const userDB = { validateSession: async (t: string) => accounts[t] ?? null, cleanupExpiredSessions: async () => {} } as never;

function server(store: MemoryProfileStore, clock?: { t: number }) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const gs = makeEmptyServer({ gameData: new GameData(files), tutorial: true, ships: createShipBridge(shipConfig), profileStore: store, userDB });
  if (clock) (gs.pilots as unknown as { now: () => number }).now = () => clock.t;
  return gs;
}

async function joinAs(gs: GameServer, name: string, opts: { guestKey?: string; token?: string } = {}) {
  const t = new LocalTransport(gs);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: name, ...(opts.guestKey ? { guestKey: opts.guestKey } : {}), ...(opts.token ? { token: opts.token } : {}) } as never);
  await settle();
  const conn = () => gs.pilots.connOf(t.getPlayerId())!;
  const last = <T extends ServerMessage['type']>(type: T) => got.filter((m) => m.type === type).pop() as Extract<ServerMessage, { type: T }> | undefined;
  return { t, got, conn, profile: () => gs.pilots.get(conn())!, last, convert: async (token: string) => { t.send({ type: 'convertGuest', token } as never); await settle(); } };
}

describe('a guest registering', () => {
  it('moves the whole profile to the new account, once: the kept record is consumed and the pilot stays in game', async () => {
    const store = new MemoryProfileStore();
    const gs = server(store);
    const a = await joinAs(gs, 'Guest_1', { guestKey: KEY });
    expect(a.last('guestStatus')).toMatchObject({ state: 'active' });
    gs.tutorial!.completeStep(a.conn(), 'welcome');
    gs.pilots.addCredits(a.conn(), 1234);
    const credits = a.profile().credits;
    const hangar = JSON.stringify(a.profile().hangar);

    await a.convert('tokAlice');
    expect(a.last('guestConverted')).toMatchObject({ success: true });
    expect(a.last('authResult')).toMatchObject({ success: true, username: 'Alice' });
    expect(a.conn().userId).toBe(7);
    expect(a.conn().username).toBe('Alice');
    expect(a.conn().guestId).toBeNull();
    // (In game as the account, nothing reloaded)
    expect(a.profile().credits).toBe(credits);
    const saved = (await store.load(7)) as { credits: number; tutorial: { step: string }; hangar: unknown };
    expect(saved.credits).toBe(credits);
    expect(saved.tutorial.step).toBe('rings');
    expect(JSON.stringify(saved.hangar)).toBe(hangar);
    // The guest's record is gone: the same browser's key gets a fresh guest, and the account holds the one pilot
    expect(gs.pilots.guests.size).toBe(0);
    a.t.disconnect();
    await settle();
    const again = await joinAs(gs, 'Guest_1', { guestKey: KEY });
    expect(again.profile().tutorial.step).toBe('welcome');
    expect(again.profile().credits).not.toBe(credits);
    const back = await joinAs(gs, 'Alice', { token: 'tokAlice' });
    expect(back.profile().credits).toBe(credits);
    expect(back.profile().tutorial.step).toBe('rings');
  });

  it('never into an account that already has a pilot: nothing changes, the guest stays a guest', async () => {
    const store = new MemoryProfileStore();
    const gs = server(store);
    const bob = await joinAs(gs, 'Bob', { token: 'tokBob' });
    gs.pilots.addCredits(bob.conn(), 5000);
    await gs.saveAll();
    const bobCredits = bob.profile().credits;
    const bobSaved = JSON.stringify(await store.load(8));

    const g = await joinAs(gs, 'Guest_2', { guestKey: KEY });
    gs.tutorial!.completeStep(g.conn(), 'welcome');
    await g.convert('tokBob');
    expect(g.last('guestConverted')).toMatchObject({ success: false });
    expect(g.last('guestConverted')!.error).toMatch(/already has a pilot/);
    expect(g.conn().userId).toBeNull();
    expect(g.conn().guestId).toBe(guestIdOf(KEY));
    expect(JSON.stringify(await store.load(8))).toBe(bobSaved);
    expect(bob.profile().credits).toBe(bobCredits);
    // (still a kept guest, and may register under a name that is new)
    expect(gs.pilots.guests.size).toBe(1);
    await g.convert('tokAlice');
    expect(g.last('guestConverted')).toMatchObject({ success: true });
  });

  it('only once: a second try is refused, and two guests into one account get one winner', async () => {
    const store = new MemoryProfileStore();
    const gs = server(store);
    const a = await joinAs(gs, 'Guest_3', { guestKey: KEY });
    const b = await joinAs(gs, 'Guest_4', { guestKey: OTHER });
    gs.pilots.addCredits(a.conn(), 111);
    gs.pilots.addCredits(b.conn(), 222);
    const ca = a.profile().credits, cb = b.profile().credits;
    a.t.send({ type: 'convertGuest', token: 'tokAlice' } as never);
    b.t.send({ type: 'convertGuest', token: 'tokAlice' } as never);
    await settle();
    const wins = [a, b].filter((x) => x.last('guestConverted')?.success);
    expect(wins.length).toBe(1);
    const [w] = wins;
    expect(((await store.load(7)) as { credits: number }).credits).toBe(w === a ? ca : cb);
    // (the loser is still a guest with their own record, and the winner can't register again)
    const loser = w === a ? b : a;
    expect(loser.conn().userId).toBeNull();
    expect(gs.pilots.guests.size).toBe(1);
    await w.convert('tokBob');
    expect(w.last('guestConverted')).toMatchObject({ success: false });
    expect(await store.load(8)).toBeNull();
  });

  it('a made-up or unknown session is refused, and a signed-in pilot is not a guest', async () => {
    const gs = server(new MemoryProfileStore());
    const g = await joinAs(gs, 'Guest_5', { guestKey: KEY });
    await g.convert('nope');
    expect(g.last('guestConverted')).toMatchObject({ success: false });
    expect(g.conn().userId).toBeNull();
    const bob = await joinAs(gs, 'Bob', { token: 'tokBob' });
    await bob.convert('tokAlice');
    expect(bob.last('guestConverted')).toMatchObject({ success: false });
    expect(bob.conn().userId).toBe(8);
  });

  it('a guest past their 3 days is not played: they are told, and registering moves the kept pilot', async () => {
    const store = new MemoryProfileStore();
    const clock = { t: 1_000_000 };
    const gs = server(store, clock);
    const a = await joinAs(gs, 'Guest_6', { guestKey: KEY });
    gs.tutorial!.completeStep(a.conn(), 'welcome');
    gs.pilots.addCredits(a.conn(), 777);
    const credits = a.profile().credits;
    a.t.disconnect();
    await settle();
    // (Back every 10 h for 70 h: never idle; 73 h from the start it is past the 3 days)
    for (let i = 0; i < 7; i++) {
      clock.t += 10 * H;
      const c = await joinAs(gs, 'Guest_6', { guestKey: KEY });
      expect(c.last('guestStatus')).toMatchObject({ state: 'active' });
      c.t.disconnect();
      await settle();
    }
    clock.t += 3 * H;
    const late = await joinAs(gs, 'Guest_6', { guestKey: KEY });
    expect(late.last('guestStatus')).toMatchObject({ state: 'expired', expiresInMs: 11 * H });
    // (Not their pilot, and nothing of this connection kept over it)
    expect(late.profile().tutorial.step).toBe('welcome');
    late.t.disconnect();
    await settle();
    const again = await joinAs(gs, 'Guest_6', { guestKey: KEY });
    expect(again.last('guestStatus')).toMatchObject({ state: 'expired' });
    // (No ship of theirs in the world: it is dead to every system, so unseen, unhit and unflown; their controls are not heard)
    const ghost = again.t.getPlayerId();
    expect(hasComponent(gs.world, Dead, ghost)).toBe(true);
    expect(gs.flying(ghost)).toBe(false);
    const px = Position.x[ghost];
    again.t.send({ type: 'input', seq: 1, forward: true, fireLeft: true, fireRight: true } as never);
    again.t.send({ type: 'chat', text: 'hello' } as never);
    gs.step(); gs.step();
    expect(Input.forward[ghost]).toBe(0);
    expect(Input.fireLeft[ghost]).toBe(0);
    expect(Position.x[ghost]).toBeCloseTo(px, 1);
    // (Nor does anyone else hear them)
    const watcher = await joinAs(gs, 'Watcher');
    again.t.send({ type: 'chat', text: 'hello' } as never);
    await settle();
    expect(watcher.got.some((m) => m.type === 'chat')).toBe(false);
    await again.convert('tokAlice');
    expect(again.last('guestConverted')).toMatchObject({ success: true });
    // (A ship now, as after a respawn, with their pilot on it: and they fly it)
    const ship = again.t.getPlayerId();
    expect(ship).not.toBe(ghost);
    expect(gs.flying(ship)).toBe(true);
    again.t.send({ type: 'input', seq: 2, tick: 0, forward: true } as never);
    gs.step();
    expect(Input.forward[ship]).toBe(1);
    expect(again.profile().credits).toBe(credits);
    expect(again.profile().tutorial.step).toBe('rings');
    expect(((await store.load(7)) as { credits: number }).credits).toBe(credits);
    expect(gs.pilots.guests.size).toBe(0);
  });

  it('a guest not used for 12 h is wiped: the next join with the key is a new guest', async () => {
    const clock = { t: 1_000_000 };
    const gs = server(new MemoryProfileStore(), clock);
    const a = await joinAs(gs, 'Guest_7', { guestKey: KEY });
    gs.tutorial!.completeStep(a.conn(), 'welcome');
    a.t.disconnect();
    await settle();
    clock.t += 12 * H + 1;
    const b = await joinAs(gs, 'Guest_7', { guestKey: KEY });
    expect(b.profile().tutorial.step).toBe('welcome');
    expect(b.last('guestStatus')).toMatchObject({ state: 'active', expiresInMs: 3 * 24 * H });
  });
});
