/**
 * The combat lock (gameServer/combatLock.ts): dealing damage starts it as taking damage does, a pilot who quits inside it
 * leaves their ship, rejoining in time flies that very ship (state kept), rejoining late is a normal login, shutdown
 * saves a lingering ship as it is, and the HUD is told when the lock starts and ends.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Player, Dead, TICK_RATE, type ClientSocket } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { COMBAT_RULES, combatLeft } from './combatLock.js';
import { lingerSystem } from './session.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const S = (server: GameServer) => server as any;

function boot() {
  resetGlobals();
  const store = new MemoryProfileStore();
  const server = new GameServer({
    gameData: new GameData(readGameDataFiles(dataDir)),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)), profileStore: store,
  });
  // (What the game says to each socket, as objects: the transport would pack them into frames)
  const real = S(server).send.bind(server);
  S(server).send = (ws: any, msg: any) => { (ws.said ??= []).push(msg); real(ws, msg); };
  return { server, store };
}

function join_(server: GameServer, name: string) {
  let open = true;
  const socket = { isOpen: () => open, send: () => {}, close: () => { open = false; }, said: [] as any[] } as unknown as ClientSocket & { said: any[] };
  const sent = socket.said;
  const link = server.connect(socket);
  link.receive({ type: 'join', username: name } as any);
  const conn = [...S(server).clients.values()].find((c: any) => c.ws === socket);
  return { link, conn, sent, pid: conn.playerId as number };
}

/** Signed in as account `id` (the join as a guest, then the account's login) */
async function signIn(server: GameServer, name: string, id: number) {
  const j = join_(server, name);
  j.conn.userId = id;
  await server.loginPilot(j.conn, id);
  return j;
}

// (Messages queue in the outbox till it flushes, as at the end of a tick)
const sentMsgs = (sent: any[], type: string, _server?: GameServer) => {  return sent.filter((m) => m && m.type === type); };

describe('combat lock', () => {
  it('quit mid-fight: the ship stays; rejoin within the time: the same ship, state kept', async () => {
    const { server } = boot();
    const a = await signIn(server, 'ace', 7);
    const pid = a.pid;
    Position.x[pid] = 1234; Position.y[pid] = -567; Velocity.x[pid] = 12; Velocity.y[pid] = -3;
    const ship = S(server).ships.get(pid);
    ship.hp[1] = ship.hp[1] * 0.5;
    const hp = [...ship.hp];
    S(server).combat.note(pid, -1, S(server).currentTick);
    expect(combatLeft(S(server), pid)).toBeGreaterThan(0);
    a.link.close();
    expect(S(server).lingering.has(pid)).toBe(true);

    const b = await signIn(server, 'ace', 7);
    expect(b.conn.playerId).toBe(pid);
    expect(S(server).lingering.size).toBe(0);
    expect(Position.x[pid]).toBe(1234);
    expect(Position.y[pid]).toBe(-567);
    expect(Velocity.x[pid]).toBe(12);
    expect([...S(server).ships.get(pid).hp]).toEqual(hp);
    expect(bitecs.hasComponent(S(server).world, Dead, pid)).toBe(false);
    expect(S(server).pilots.get(b.conn)).toBeDefined();
    expect(S(server).pilots.get(a.conn)).toBeUndefined();
    // (the client is told its ship's number again)
    const w = sentMsgs(b.sent, 'welcome', server);
    expect(w[w.length - 1].playerId).toBe(pid);
    // (the fresh ship the join made is gone)
    expect(bitecs.hasComponent(S(server).world, Dead, b.pid) || b.pid === pid).toBe(true);
  });

  it('rejoin after the linger is over: a normal login (the old ship is finished and saved)', async () => {
    const { server, store } = boot();
    const a = await signIn(server, 'ace', 7);
    const pid = a.pid;
    Position.x[pid] = 900; Position.y[pid] = 900;
    S(server).combat.note(pid, -1, S(server).currentTick);
    a.link.close();
    expect(S(server).lingering.has(pid)).toBe(true);
    S(server).currentTick += TICK_RATE * (COMBAT_RULES.lockSeconds + COMBAT_RULES.lingerSeconds) + 5;
    lingerSystem(S(server));
    expect(S(server).lingering.size).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    const saved: any = await store.load(7);
    expect(saved).toBeTruthy();
    const b = await signIn(server, 'ace', 7);
    expect(b.conn.playerId).not.toBe(pid);
    expect(bitecs.hasComponent(S(server).world, Player, b.conn.playerId)).toBe(true);
  });

  it('dealing damage starts the lock (taking none), and quitting then leaves the ship', async () => {
    const { server } = boot();
    const a = await signIn(server, 'ace', 7);
    const foe = S(server).createPlayer();
    expect(combatLeft(S(server), a.pid)).toBe(0);
    // (the ship bridge's damage report: a shot of ours hit the foe)
    S(server).combat.note(foe, a.pid, S(server).currentTick);
    expect(combatLeft(S(server), a.pid)).toBe(COMBAT_RULES.lockSeconds * TICK_RATE);
    a.link.close();
    expect(S(server).lingering.has(a.pid)).toBe(true);
  });

  it('the lingering time counts from the last combat event, not from the quit', async () => {
    const { server } = boot();
    const a = await signIn(server, 'ace', 7);
    S(server).currentTick = 1000;
    S(server).combat.note(a.pid, -1, 1000 - TICK_RATE * 10);
    a.link.close();
    const until = S(server).lingering.get(a.pid).until;
    expect(until).toBe(1000 - TICK_RATE * 10 + TICK_RATE * (COMBAT_RULES.lockSeconds + COMBAT_RULES.lingerSeconds));
  });

  it('quitting in peace (or as a guest) does not leave the ship', async () => {
    const { server } = boot();
    const a = await signIn(server, 'ace', 7);
    a.link.close();
    expect(S(server).lingering.size).toBe(0);
    const g = join_(server, 'guesty');
    S(server).combat.note(g.pid, -1, S(server).currentTick);
    g.link.close();
    expect(S(server).lingering.size).toBe(0);
  });

  it('shutdown saves a lingering ship as it is, and the update restart does not finish it early', async () => {
    const { server, store } = boot();
    const a = await signIn(server, 'ace', 7);
    Position.x[a.pid] = 4321; Position.y[a.pid] = 8765;
    S(server).combat.note(a.pid, -1, S(server).currentTick);
    a.link.close();
    expect(S(server).lingering.has(a.pid)).toBe(true);
    await server.saveAll();
    const saved: any = await store.load(7);
    expect(saved.position.x).toBe(4321);
    expect(saved.position.y).toBe(8765);
    expect(S(server).lingering.has(a.pid)).toBe(true);
  });

  it('the HUD is told when the lock starts and when it ends', async () => {
    const { server } = boot();
    const a = await signIn(server, 'ace', 7);
    lingerSystem(S(server));
    expect(sentMsgs(a.sent, 'combatLock', server)).toHaveLength(0);
    S(server).combat.note(a.pid, -1, S(server).currentTick);
    lingerSystem(S(server));
    const m = sentMsgs(a.sent, 'combatLock', server);
    expect(m).toHaveLength(1);
    expect(m[0].left).toBe(COMBAT_RULES.lockSeconds * 1000);
    S(server).currentTick += TICK_RATE * COMBAT_RULES.lockSeconds + 1;
    lingerSystem(S(server));
    const m2 = sentMsgs(a.sent, 'combatLock', server);
    expect(m2).toHaveLength(2);
    expect(m2[1].left).toBe(0);
  });
});
