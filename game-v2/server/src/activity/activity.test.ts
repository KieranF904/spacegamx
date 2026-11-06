import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { ActivityFeed, GLOBAL_PER_MIN, PER_KEY_PER_MIN, TALLY_MS, type FeedEvent } from './ActivityFeed.js';
import { Activity, BIG_SALE, CHAT_MAX, activity, enabledTypes, sessionLength } from './index.js';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

/** A feed with a hand-turned clock and a lobby that takes (or refuses) what it's sent */
function rig(o: { up?: boolean } = {}) {
  let t = 1_000_000;
  const sent: FeedEvent[][] = [];
  const lobby = { up: o.up ?? true, calls: 0 };
  const feed = new ActivityFeed({
    now: () => t,
    send: async (batch) => { lobby.calls++; if (!lobby.up) throw new Error('ECONNREFUSED'); sent.push(batch); return true; },
    maxBatch: 10, maxQueue: 50,
  });
  return { feed, sent, lobby, advance: (ms: number) => { t += ms; }, all: () => sent.flat() };
}

describe('ActivityFeed (batching, limits, a lobby that is down)', () => {
  it('sends queued events in batches of at most maxBatch, oldest first, nothing twice', async () => {
    const r = rig();
    for (let i = 0; i < 25; i++) r.feed.emit('dock', `p${i}`, 'Docked');
    await r.feed.pump();
    await r.feed.pump();
    await r.feed.pump();
    await r.feed.pump();
    expect(r.sent.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(r.all().map((e) => e.player)).toEqual(Array.from({ length: 25 }, (_, i) => `p${i}`));
    expect(r.feed.pending).toBe(0);
  });

  it('limits one pilot and type a minute, and the whole server; says how many were dropped', async () => {
    const r = rig();
    for (let i = 0; i < PER_KEY_PER_MIN + 7; i++) r.feed.emit('death', 'spammer', 'Ship destroyed');
    // (Another pilot isn't held back by them)
    expect(r.feed.emit('death', 'other', 'Ship destroyed')).toBe(true);
    expect(r.feed.pending).toBe(PER_KEY_PER_MIN + 1);
    while (r.feed.pending) { await r.feed.pump(); r.advance(10); }
    expect(r.all().find((e) => e.type === 'dropped')!.detail).toBe('Events not sent: 7 over the rate limit');
    // A minute on, they may again
    r.advance(60_000);
    expect(r.feed.emit('death', 'spammer', 'Ship destroyed')).toBe(true);

    const g = rig();
    let n = 0;
    for (let i = 0; i < GLOBAL_PER_MIN + 50; i++) if (g.feed.emit('join', `p${i}`, 'Joined')) n++;
    expect(n).toBe(GLOBAL_PER_MIN);
  });

  it('keeps one quiet-keyed event per window (docking at the same station)', () => {
    const r = rig();
    expect(r.feed.emit('dock', 'a', 'Docked at Sol', '', { key: 'Sol', ms: 600_000 })).toBe(true);
    expect(r.feed.emit('dock', 'a', 'Docked at Sol', '', { key: 'Sol', ms: 600_000 })).toBe(false);
    expect(r.feed.emit('dock', 'a', 'Docked at Vega', '', { key: 'Vega', ms: 600_000 })).toBe(true);
    r.advance(600_000);
    expect(r.feed.emit('dock', 'a', 'Docked at Sol', '', { key: 'Sol', ms: 600_000 })).toBe(true);
  });

  it('sums tallies into one line per pilot every TALLY_MS, or when they leave', async () => {
    const r = rig();
    const fmt = (c: Map<string, number>) => [...c].map(([k, n]) => `${k} ${n}`).join(', ');
    r.feed.tally('kills', 'a', 'pirates', 3, fmt);
    r.feed.tally('kills', 'a', 'drones', 1, fmt);
    r.feed.tally('kills', 'a', 'pirates', 2, fmt);
    r.feed.tally('kills', 'b', 'drones', 4, fmt);
    await r.feed.pump();
    expect(r.all()).toEqual([]);
    r.feed.flushTallies('b');
    r.advance(TALLY_MS);
    await r.feed.pump();
    expect(r.all().map((e) => [e.player, e.detail])).toEqual([['b', 'drones 4'], ['a', 'pirates 5, drones 1']]);
  });

  it("drops gracefully while the lobby is down: keeps the newest maxQueue, backs off, then catches up", async () => {
    const r = rig({ up: false });
    for (let i = 0; i < 60; i++) r.feed.emit('join', `p${i}`, 'Joined');
    await r.feed.pump();
    expect(r.lobby.calls).toBe(1);
    expect(r.feed.failing).toBe(true);
    // (Backing off: no call again at once)
    await r.feed.pump();
    expect(r.lobby.calls).toBe(1);
    r.advance(2000);
    await r.feed.pump();
    expect(r.lobby.calls).toBe(2);
    // Back up: the queue goes out, and the loss is said
    r.lobby.up = true;
    r.advance(60_000);
    while (r.feed.pending) { await r.feed.pump(); r.advance(10); }
    const players = r.all().filter((e) => e.type === 'join').map((e) => e.player);
    expect(players[0]).toBe('p10');
    expect(players.at(-1)).toBe('p59');
    expect(r.all().some((e) => e.type === 'dropped' && /10 while the lobby was unreachable/.test(e.detail))).toBe(true);
  });

  it('never throws into the game when the send itself throws or answers false', async () => {
    const feed = new ActivityFeed({ send: async () => false });
    feed.emit('join', 'a', 'x');
    await expect(feed.pump()).resolves.toBeUndefined();
    expect(feed.pending).toBe(1);
  });
});

describe('the activity facade', () => {
  function started(types = 'all') {
    let t = 5_000_000;
    const sent: FeedEvent[] = [];
    const a = new Activity();
    a.start({ url: 'http://lobby', secret: 's', server: 'Test', timer: false, types, now: () => t, send: async (b) => { sent.push(...b); return true; } });
    return { a, sent, advance: (ms: number) => { t += ms; }, flush: async () => { a.feed!.flushTallies(undefined, true); while (a.feed!.pending) await a.feed!.pump(); } };
  }

  it('is off until started: every call does nothing', () => {
    const a = new Activity();
    expect(a.on).toBe(false);
    a.join({ username: 'x', userId: 1 });
    a.death({ username: 'x', userId: 1 }, {});
    a.error('tick', new Error('boom'));
    expect(a.feed).toBeNull();
  });

  it('a session: join, then leave with its length', async () => {
    const r = started();
    const conn = { username: 'vega', userId: 7 };
    r.a.join(conn);
    r.a.join({ username: 'Guest_12', userId: null });
    r.advance(72 * 60_000);
    r.a.leave(conn);
    r.a.leave(conn);
    await r.flush();
    expect(r.sent.filter((e) => e.type !== 'server').map((e) => [e.type, e.player, e.detail])).toEqual([
      ['join', 'vega', 'Joined (signed in)'], ['join', 'Guest_12', 'Joined as a guest'], ['leave', 'vega', 'Left after 1 h 12 min'],
    ]);
    expect(sessionLength(40_000)).toBe('40 s');
  });

  it('PvP deaths name both pilots; PvE deaths say what did it; big sales stand alone, small ones are summed', async () => {
    const r = started();
    const a = { username: 'alice', userId: 1 }, b = { username: 'bob', userId: 2 };
    r.a.death(a, { by: 'pilot' }, 'bob');
    r.a.death(b, { by: 'Scrap Mite', region: 'the Rockery' });
    r.a.sale(a, '40 × Iron', BIG_SALE, 'Sol Central');
    r.a.sale(a, '2 × Iron', 120, 'Sol Central');
    r.a.sale(a, '3 × Iron', 180, 'Sol Central');
    await r.flush();
    const rows = r.sent.filter((e) => e.type !== 'server').map((e) => [e.type, e.player, e.other ?? '', e.detail]);
    expect(rows).toEqual([
      ['pvp', 'alice', 'bob', 'Killed by bob'],
      ['death', 'bob', '', 'Destroyed by Scrap Mite in the Rockery'],
      ['sale', 'alice', '', 'Sold 40 × Iron for 5,000 cr at Sol Central'],
      ['sales', 'alice', '', 'Market sales: 300 cr'],
    ]);
  });

  it('private messages and friend actions are counts only; an admin mail or announcement never carries its text', async () => {
    const r = started();
    const a = { username: 'alice', userId: 1 };
    r.a.social(a, 'private messages');
    r.a.social(a, 'private messages');
    r.a.social(a, 'friend requests');
    r.a.admin('boss', 'mail', { to: 'alice', text: 'secret words here' }, { ok: true, text: 'Mailed alice: secret words here' });
    r.a.admin('boss', 'announce', { text: 'server restart soon' }, { ok: true, text: 'Announced: server restart soon' });
    r.a.admin('boss', 'who', {}, { ok: true, text: 'list' });
    r.a.admin('boss', 'kick', { player: 'mallory', reason: 'spam' }, { ok: true, text: 'Kicked mallory' });
    await r.flush();
    const rows = r.sent.filter((e) => e.type !== 'server');
    expect(rows.map((e) => [e.type, e.detail])).toEqual([
      ['admin', '/mail alice: done'], ['admin', '/announce: done'], ['admin', '/kick mallory: done (Kicked mallory)'], ['social', '2 private messages, 1 friend requests'],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/secret words|restart soon/);
  });
});

describe('which event types go out (ACTIVITY_TYPES)', () => {
  it('by default: sign-ins, sessions, public chat and the operational ones; the rest only when switched on', () => {
    const on = enabledTypes();
    for (const t of ['join', 'leave', 'chat', 'admin', 'kick', 'refused', 'protocol', 'error', 'server', 'dropped']) expect(on.has(t), t).toBe(true);
    for (const t of ['death', 'pvp', 'kills', 'mined', 'sale', 'sales', 'trade', 'craft', 'dock', 'level', 'quest', 'ship', 'build', 'refit', 'boss_kill', 'social']) expect(on.has(t), t).toBe(false);
    expect(enabledTypes('+death, +boss_kill, -chat').has('death')).toBe(true);
    expect(enabledTypes('+death, +boss_kill, -chat').has('chat')).toBe(false);
    expect([...enabledTypes('join,leave,nonsense')].sort()).toEqual(['dropped', 'join', 'leave']);
    expect(enabledTypes('all').has('dock')).toBe(true);
  });

  it('types that are off send nothing, tallies included', async () => {
    const sent: FeedEvent[] = [];
    const a = new Activity();
    a.start({ url: 'x', secret: 's', server: 'T', timer: false, send: async (b) => { sent.push(...b); return true; } });
    const p = { username: 'alice', userId: 1 };
    a.death(p, { by: 'Mite' });
    a.dock(p, 'Sol Central');
    a.sale(p, 'ore', 99_999, 'Sol');
    a.social(p, 'private messages');
    a.chat(p, 'hello all');
    a.feed!.flushTallies(undefined, true);
    while (a.feed!.pending) await a.feed!.pump();
    expect(sent.filter((e) => e.type !== 'server').map((e) => [e.type, e.detail])).toEqual([['chat', 'hello all']]);
    await a.stop(0);
  });

  it('public chat is cleaned and capped', async () => {
    const sent: FeedEvent[] = [];
    const a = new Activity();
    a.start({ url: 'x', secret: 's', server: 'T', timer: false, send: async (b) => { sent.push(...b); return true; } });
    a.chat({ username: 'bob', userId: null }, `hi\u0000\nthere ${'x'.repeat(400)}`);
    a.chat({ username: 'bob', userId: null }, '   ');
    while (a.feed!.pending) await a.feed!.pump();
    const chat = sent.filter((e) => e.type === 'chat');
    expect(chat).toHaveLength(1);
    expect(chat[0].detail.startsWith('hi there x')).toBe(true);
    expect(chat[0].detail).toHaveLength(CHAT_MAX);
    await a.stop(0);
  });
});

describe('the game server sends its pilots\' sessions (fake client)', () => {
  afterEach(async () => { await activity.stop(0); });

  it('a guest joins and leaves: join and leave events, under the server name', async () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const dataDir = join(__dirname, '../../../data');
    const server = new GameServer({
      gameData: new GameData(readGameDataFiles(dataDir)), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    });
    const batches: { server: string; events: FeedEvent[] }[] = [];
    activity.start({ url: 'http://lobby', secret: 's', server: 'Local dev', timer: false, send: async (events) => { batches.push({ server: 'Local dev', events }); return true; } });
    activity.watch(server.pilots);
    const t = new LocalTransport(server);
    t.onMessage = () => {};
    t.connect();
    t.send({ type: 'join', username: 'visitor' } as any);
    t.send({ type: 'chat', text: 'anyone mining in the Rockery?' } as any);
    // (Party chat and commands aren't public chat)
    t.send({ type: 'chat', text: '/p party only' } as any);
    t.disconnect();
    while (activity.feed!.pending) await activity.feed!.pump();
    const events = batches.flatMap((b) => b.events).filter((e) => e.type !== 'server');
    expect(events.map((e) => [e.type, e.player])).toEqual([['join', 'visitor'], ['chat', 'visitor'], ['leave', 'visitor']]);
    expect(events[1].detail).toBe('anyone mining in the Rockery?');
    expect(events[2].detail).toMatch(/^Left after \d+ s$/);
  });
});
