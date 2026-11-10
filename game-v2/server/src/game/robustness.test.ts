/**
 * Server robustness (docs/audits/server-robustness.md): one bad system, entity
 * or message can't stop the world; hostile messages are survived; connections
 * that come and go leave nothing behind.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import type { ClientSocket, ServerMessage } from '@space-game/common';
import { ServerFrameReader, Player, Dead, bountyIds, Input, CURSOR_DIST_MAX } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { clientBlueprint } from '../net/handlers/shipEdit.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { MessageLimiter } from '../net/MessageLimits.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const shipConfig = loadShipConfigCached(dataDir);

function makeServer(userDB: Record<string, unknown> = {}) {
  resetGlobals();
  return new GameServer({
    profileStore: new MemoryProfileStore(), gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {}, ...userDB } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(shipConfig),
  });
}

/** A raw connection: messages go straight in as objects (NaN, Infinity and all, which JSON would lose) */
function rawClient(server: GameServer) {
  let open = true;
  const got: ServerMessage[] = [];
  // (bit-packed messages once joined, every client running the full caps set; base frames before)
  const reader = new ServerFrameReader();
  const socket: ClientSocket = { isOpen: () => open, send: (d) => { for (const msgs of reader.read(d as Uint8Array)) got.push(...msgs); }, close: () => { open = false; } };
  const link = server.connect(socket);
  return { link, got, socket, close: () => { open = false; link.close(); } };
}

const s = (server: GameServer) => server as any;

// Quiet the expected error logs
function quietly<T>(fn: () => T): T {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try { return fn(); } finally { err.mockRestore(); log.mockRestore(); warn.mockRestore(); }
}

describe('crash isolation', () => {
  it('a system that throws every tick is logged and the rest of the tick still runs', () => {
    const server = makeServer();
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'pilot' } as any);
    server.enemies.tick = () => { throw new Error('bad entity'); };
    let pilotsTicked = 0;
    const realTick = server.pilots.tick.bind(server.pilots);
    server.pilots.tick = () => { pilotsTicked++; realTick(); };
    const before = s(server).currentTick;
    quietly(() => { for (let i = 0; i < 30; i++) server.step(); });
    expect(s(server).currentTick).toBe(before + 30);
    expect(pilotsTicked).toBe(30); // (runs after enemies)
    expect(server.faultCounts().enemies).toBe(30);
  });

  it('the game loop schedules its next run even when a snapshot throws', () => {
    const server = makeServer();
    s(server).sendSnapshots = () => { throw new Error('bad snapshot'); };
    s(server).lastTickTime = performance.now() - 100;
    quietly(() => expect(() => s(server).gameLoop()).not.toThrow());
    expect(s(server).gameLoopTimer).toBeTruthy();
    clearTimeout(s(server).gameLoopTimer);
    clearImmediate(s(server).gameLoopTimer);
    expect(server.faultCounts().snapshots).toBeGreaterThan(0);
  });

  it('a bad input is dropped on its own and the queue still empties', () => {
    const server = makeServer();
    const c = rawClient(server);
    c.link.receive({ type: 'join', username: 'p' } as any);
    const real = s(server).handleInput.bind(server);
    s(server).handleInput = () => { throw new Error('bad input'); };
    c.link.receive({ type: 'input', seq: 1 } as any);
    quietly(() => server.step());
    expect(s(server).inputQueue.length).toBe(0);
    s(server).handleInput = real;
    expect(() => server.step()).not.toThrow();
  });

  it('a lobby that fails mid-join is a logged fault, not an unhandled rejection', async () => {
    const server = makeServer({ checkSession: async () => { throw new Error('lobby down'); } });
    const c = rawClient(server);
    await quietly(async () => {
      c.link.receive({ type: 'join', token: 'abc' } as any);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(server.faultCounts().join).toBe(1);
  });

  it('a throw while a connection closes still forgets it', () => {
    const server = makeServer();
    const c = rawClient(server);
    c.link.receive({ type: 'join', username: 'p' } as any);
    s(server).trade.remove = () => { throw new Error('bad trade'); };
    quietly(() => c.close());
    expect(s(server).clients.size).toBe(0);
    expect(server.faultCounts().close).toBe(1);
  });

  it('a profile that fails to migrate is kept, never saved over with a fresh one', async () => {
    const store = new MemoryProfileStore();
    await store.save(7, { version: 1, credits: 'not a profile', ship: 5, hangar: 'x' });
    resetGlobals();
    const server = new GameServer({
      profileStore: store, gameData: new GameData(files), autoStart: false, scene: 'sectors', ships: createShipBridge(shipConfig),
      userDB: { validateSession: async () => ({ id: 7, username: 'seven', is_admin: false }), cleanupExpiredSessions: async () => {} } as any,
    });
    const c = rawClient(server);
    await quietly(async () => {
      c.link.receive({ type: 'join', token: 't' } as any);
      await new Promise((r) => setTimeout(r, 20));
      for (let i = 0; i < 5; i++) server.step();
      await server.saveAll();
    });
    // (A v1 save is older than the oldest migration kept: migrateProfile throws, Pilots logs it) What's stored is never a
    // fresh start over a real save: it stays as it was
    const saved = await store.load(7) as { credits: unknown };
    expect(saved).toEqual({ version: 1, credits: 'not a profile', ship: 5, hangar: 'x' });
  });
});

// Every client message type the server handles (GameServer.handleMessage)
const TYPES = ['input', 'ping', 'mapView', 'chat', 'interact', 'respawn', 'trainingDrone', 'target', 'pilotInfo', 'partyInvite',
  'ribbons', 'rankings', 'shareDesign', 'mapPing', 'partyRespond', 'partyLeave', 'partyKick', 'partyPromote', 'tradeRequest',
  'tradeRespond', 'tradeOffer', 'tradeAccept', 'tradeCancel', 'vendorOpen', 'vendorBuy', 'marketScan', 'itemMove', 'itemJettison',
  'itemUse', 'stationOpen', 'refine', 'craft', 'outpostCharter', 'outpostUpgrade', 'ammoPrefer', 'slotLoadout',
  'restockLoadout', 'itemStore', 'gemCut', 'gemSocket', 'gemUnsocket', 'marketSell', 'marketBuy', 'questBoard', 'questAccept', 'talk',
  'questAbandon', 'questSeen', 'codexRead', 'skillUp', 'join', 'stateHash', 'shipEdit', 'slotSave', 'slotFly',
  'slotClear', 'designSave', 'fabOrder', 'fabOrderCancel', 'designDelete', 'slotBuild', 'slotOrder', 'job', 'scrapItem', 'marketSellAll',
  'quickbarSet', 'dock', 'contrib', 'siege', 'undock', 'shipNeed', 'nonsense', '__proto__'];

/** Seeded so a failure can be replayed */
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

function junk(r: () => number, depth = 0): unknown {
  const pick = Math.floor(r() * 16);
  switch (pick) {
    case 0: return NaN;
    case 1: return Infinity;
    case 2: return -1;
    case 3: return 1e12;
    case 4: return Math.floor(r() * 10);
    case 5: return '__proto__';
    case 6: return 'constructor';
    case 7: return 'x'.repeat(Math.floor(r() * 5000));
    case 8: return null;
    case 9: return undefined;
    case 10: return true;
    case 11: return depth > 2 ? [] : Array.from({ length: Math.floor(r() * 6) }, () => junk(r, depth + 1));
    case 12: return depth > 2 ? {} : { __proto__: { polluted: true }, a: junk(r, depth + 1), parts: [junk(r, depth + 1)] };
    case 13: return 0.5;
    case 14: return 'iron_ore';
    default: return Array.from({ length: 3000 }, () => 0); // (big)
  }
}

const FIELDS = ['id', 'n', 'slot', 'text', 'items', 'blueprint', 'name', 'x', 'y', 'kind', 'target', 'skill', 'qty', 'count', 'gem', 'index',
  'station', 'accept', 'open', 'seq', 'clientTime', 'cursorDist', 'targetAngle', 'op', 'plan', 'credits', 'from', 'to', 'tick', 'hash', 'hashes', 'username', 'protocol', 'token'];

describe('hostile messages (fuzz)', () => {
  it('survives thousands of malformed messages of every type, and keeps ticking', async () => {
    const server = makeServer();
    const r = rng(1234);
    const bad = rawClient(server);
    const good = new LocalTransport(server);
    const goodGot: ServerMessage[] = [];
    good.onMessage = (m) => goodGot.push(m);
    good.connect();
    good.send({ type: 'join', username: 'bystander' } as any);
    const reached = new Map<string, number>();
    const realHandle = s(server).handleMessage.bind(server);
    s(server).handleMessage = (c: any, m: any) => { if (c.joined && m && typeof m === 'object') reached.set(String(m.type), (reached.get(String(m.type)) ?? 0) + 1); return realHandle(c, m); };
    await quietly(async () => {
      bad.link.receive({ type: 'join', username: 'fuzzer' } as any);
      // Shapes that aren't messages at all
      for (const m of [null, undefined, 42, 'str', [], { type: 5 }, { type: null }, { type: {} }]) bad.link.receive(m as any);
      for (let i = 0; i < 4000; i++) {
        const msg: Record<string, unknown> = { type: TYPES[Math.floor(r() * TYPES.length)] };
        for (const f of FIELDS) if (r() < 0.3) msg[f] = junk(r);
        expect(() => bad.link.receive(msg as any)).not.toThrow();
        if (i % 20 === 0) expect(() => server.step()).not.toThrow();
      }
      await new Promise((res) => setTimeout(res, 20));
      for (let i = 0; i < 60; i++) server.step();
    });
    if (process.env.FUZZ_REPORT) console.info('faults caught:', server.faultCounts(), 'reached:', Object.fromEntries(reached), 'dropped:', Object.fromEntries(server.limiter.dropped));
    expect(reached.size).toBeGreaterThan(TYPES.length / 2);
    // Nothing leaked onto every object
    expect(({} as any).polluted).toBeUndefined();
    // The bystander still gets snapshots
    goodGot.length = 0;
    for (let i = 0; i < 10; i++) server.step();
    expect(goodGot.some((m) => m.type === 'snapshot' || m.type === 'delta' || (m as any).tick !== undefined)).toBe(true);
    // The fuzzer's own save is still numbers where numbers go
    const p = server.pilots.get(s(server).clients.get(bad.socket))!;
    for (const st of [...p.cargo, ...p.storage]) expect(Number.isFinite(st.n)).toBe(true);
    expect(Number.isFinite(p.credits)).toBe(true);
    expect(Number.isFinite(p.skillPoints)).toBe(true);
  }, 60_000);

  it("a jettison with a count that isn't one leaves the hold whole", () => {
    const server = makeServer();
    const c = rawClient(server);
    c.link.receive({ type: 'join', username: 'p' } as any);
    const conn = s(server).clients.get(c.socket);
    server.pilots.give(conn, { iron_ore: 5 }, { quiet: true });
    for (const n of ['x', {}, NaN, -3, Infinity]) c.link.receive({ type: 'itemJettison', id: 'iron_ore', n } as any);
    const st = server.pilots.get(conn)!.cargo.find((x) => x.id === 'iron_ore');
    for (const x of server.pilots.get(conn)!.cargo) expect(Number.isFinite(x.n)).toBe(true);
    expect(st?.n ?? 0).toBeLessThan(5);
  });

  it("'__proto__' isn't a skill", () => {
    const server = makeServer();
    const c = rawClient(server);
    c.link.receive({ type: 'join', username: 'p' } as any);
    const p = server.pilots.get(s(server).clients.get(c.socket))!;
    p.skillPoints = 3;
    for (const skill of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) c.link.receive({ type: 'skillUp', skill } as any);
    expect(p.skillPoints).toBe(3);
    expect(Object.keys(p.skills)).toEqual([]);
  });

  it("only takes a bounty the board offers (not one made up from any id)", () => {
    const server = makeServer();
    const q = s(server).quests;
    const now = Date.now();
    q.host.now = () => now;
    expect(q.onBoard('sol_central', bountyIds('sol_central', now)[0])).toBe(true);
    expect(q.onBoard('sol_central', 'bounty:sol_central:999999999:0')).toBe(false);
    expect(q.onBoard('sol_central', 'bounty:sol_central:1:3')).toBe(false);
  });

  it('a ship design with thousands of parts is refused before any work is done on it', () => {
    const server = makeServer();
    const parts = Array.from({ length: 20000 }, (_, i) => ({ uid: i, piece: 'block', fn: 'structure', material: 'steel', x: 0, y: 0, rot: 0 }));
    const t0 = performance.now();
    expect(() => clientBlueprint(server as any, { name: 'bomb', catalogVersion: 1, parts })).toThrow();
    expect(performance.now() - t0).toBeLessThan(50);
    const bp = clientBlueprint(server as any, { name: 'n'.repeat(10_000), catalogVersion: 1, parts: [{ uid: 0, piece: 'block', fn: 'structure', material: 'steel', x: 0, y: 0, rot: 0, facing: { a: 1 }, gems: ['g'.repeat(1000)] }] });
    expect(bp.name.length).toBe(64);
    expect(bp.parts[0].facing).toBeUndefined();
    expect(bp.parts[0].gems[0].length).toBe(40);
  });

  it('a guest name is a short string with no control characters', () => {
    const server = makeServer();
    for (const [username, ok] of [[{ evil: 1 }, /^Guest_/], ['a\u0000b\nc', /^abc$/], ['x'.repeat(5000), /^x{24}$/]] as const) {
      const c = rawClient(server);
      c.link.receive({ type: 'join', username } as any);
      expect(s(server).clients.get(c.socket).username).toMatch(ok);
    }
  });

  it('aim distances and sequence numbers that are not numbers become 0', () => {
    const server = makeServer();
    const c = rawClient(server);
    c.link.receive({ type: 'join', username: 'p' } as any);
    const conn = s(server).clients.get(c.socket);
    s(server).applyInputToEntity(conn, { cursorDist: 'far', seq: 'x', targetAngle: NaN });
    expect(conn.lastInputSeq).toBe(0);
    s(server).applyInputToEntity(conn, { cursorDist: 1e39, seq: 5 });
    expect(conn.lastInputSeq).toBe(5);
    expect(Input.cursorDist[conn.playerId]).toBe(CURSOR_DIST_MAX);
    // A jump aimed past 65,535 (a star's ring reaches that far) goes as far as it was aimed
    s(server).applyInputToEntity(conn, { cursorDist: 80000, seq: 6 });
    expect(Input.cursorDist[conn.playerId]).toBe(80000);
  });
});

describe('rate limits', () => {
  it('chat spam is cut off after a burst, and comes back with time', () => {
    let now = 0;
    const lim = new MessageLimiter(() => now);
    const conn = {};
    let ok = 0;
    for (let i = 0; i < 100; i++) if (lim.allow(conn, 'chat')) ok++;
    expect(ok).toBe(8);
    now += 60_000;
    ok = 0;
    for (let i = 0; i < 100; i++) if (lim.allow(conn, 'chat')) ok++;
    expect(ok).toBe(8); // (refilled to the burst, no more)
    expect(lim.allow(conn, 'input')).toBe(true); // (no limit)
    expect(lim.allow(conn, '__proto__')).toBe(true);
  });

  it('a spammer\'s chat reaches others only a burst\'s worth', () => {
    const server = makeServer();
    const spam = rawClient(server), other = rawClient(server);
    spam.link.receive({ type: 'join', username: 'spam' } as any);
    other.link.receive({ type: 'join', username: 'other' } as any);
    for (let i = 0; i < 50; i++) spam.link.receive({ type: 'chat', text: `hi ${i}` } as any);
    server.step();
    expect(other.got.filter((m) => m.type === 'chat').length).toBe(8);
  });
});

describe('long runs', () => {
  it('connections that come and go leave nothing behind', async () => {
    const server = makeServer();
    const stay = rawClient(server);
    stay.link.receive({ type: 'join', username: 'stays' } as any);
    for (let i = 0; i < 30; i++) server.step();
    const sizes = () => ({
      clients: s(server).clients.size,
      sessions: s(server.pilots).sessions.size,
      outbox: s(server).net.outbox.size,
      lazy: s(server).net.lazy.size,
      states: s(server).lastEntityStates.size,
      lingering: s(server).lingering.size,
    });
    const base = sizes();
    await quietly(async () => {
      for (let round = 0; round < 150; round++) {
        const c = rawClient(server);
        c.link.receive({ type: 'join', username: `p${round}` } as any);
        c.link.receive({ type: 'chat', text: 'hello' } as any);
        c.link.receive({ type: 'mapView', open: true } as any);
        c.link.receive({ type: 'partyInvite', name: 'stays' } as any);
        for (let i = 0; i < 4; i++) server.step();
        c.close();
        server.step();
      }
      for (let i = 0; i < 120; i++) server.step();
    });
    const after = sizes();
    expect(after.clients).toBe(base.clients);
    expect(after.sessions).toBe(base.sessions);
    expect(after.outbox).toBeLessThanOrEqual(1);
    expect(after.lazy).toBeLessThanOrEqual(1);
    expect(after.states).toBeLessThanOrEqual(base.states + 1);
    expect(after.lingering).toBe(0);
    // Their ships are gone from the world too
    const players = bitecs.defineQuery([Player])(s(server).world).filter((e: number) => !bitecs.hasComponent(s(server).world, Dead, e));
    expect(players.length).toBe(1);
  }, 60_000);
});
