import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, InSystem, ServerMessage, huntedBoss, ribbonKey, weekOf } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world(clock = { t: Date.UTC(2026, 9, 21, 12) }, store = new MemoryProfileStore()) {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
    profileStore: store,
  });
  const pilot = (name: string) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    const conn = server.pilots.connOf(t.getPlayerId())!;
    return { t, got, conn, pid: () => t.getPlayerId(), profile: () => server.pilots.get(conn)!, send: (m: any) => t.send(m) };
  };
  return { server, clock, store, a: pilot('Ash'), b: pilot('Bree'), step: (n = 1) => { for (let i = 0; i < n; i++) server.step(); } };
}

function killOne(w: ReturnType<typeof world>, killer: number): void {
  const [foe] = w.server.enemies.spawnPack(InSystem.systemId[killer], { faction: 'pirates', ships: ['pirate_skiff'] }, Position.x[killer] + 900, Position.y[killer]);
  const bridge = w.server.getShips();
  (bridge as any).lastHitBy.set(foe, killer);
  bridge.damagePartFraction(foe, bridge.get(foe)!.blueprint.parts.findIndex((p) => p.fn === 'core'), 1);
  w.step(3);
}

describe('ribbons', () => {
  it('the first kill earns First Blood: the reward is paid and the popup sent', () => {
    const w = world();
    Position.x[w.a.pid()] = 30000; Position.y[w.a.pid()] = 30000;
    const credits = w.a.profile().credits;
    killOne(w, w.a.pid());
    expect(w.a.profile().stats[ribbonKey('first_blood')]).toBeGreaterThan(0);
    expect(w.a.got.some((m) => m.type === 'ribbon' && (m as any).id === 'first_blood')).toBe(true);
    expect(w.a.profile().credits).toBeGreaterThanOrEqual(credits + 10);
    // Not twice
    killOne(w, w.a.pid());
    expect(w.a.got.filter((m) => m.type === 'ribbon' && (m as any).id === 'first_blood').length).toBe(1);
  });

  it('visiting systems counts towards Explorer, and progress is reported', () => {
    const w = world();
    for (const sys of ['sol', 'borealis', 'nebula_prime', 'cinder_reach']) w.server.achievements.visit(w.a.conn, sys);
    expect(w.a.profile().stats[ribbonKey('explorer')]).toBeGreaterThan(0);
    w.a.send({ type: 'ribbons' });
    const prog = [...w.a.got].reverse().find((m) => m.type === 'ribbons') as any;
    expect(prog.progress.find((p: any) => p.id === 'explorer').earned).toBe(true);
    expect(prog.progress.find((p: any) => p.id === 'cartographer').value).toBe(4);
  });

  it('rare ribbons and boss kills make the galaxy news, for everyone', () => {
    const w = world();
    w.a.profile().stats.kills = 249;
    Position.x[w.a.pid()] = 30000; Position.y[w.a.pid()] = 30000;
    killOne(w, w.a.pid());
    expect(w.b.got.some((m) => m.type === 'news' && /Ash earned the Ace ribbon/.test((m as any).text))).toBe(true);
  });
});

describe('rankings', () => {
  it('registered pilots are ranked weekly and all time; a new week starts the weekly boards again', async () => {
    const w = world();
    (w.a.conn as any).userId = 11;
    (w.b.conn as any).userId = 12;
    w.server.pilots.bumpStat(w.a.conn, 'earned', 500);
    w.server.pilots.bumpStat(w.b.conn, 'earned', 900);
    w.a.send({ type: 'rankings' });
    let r = [...w.a.got].reverse().find((m) => m.type === 'rankings') as any;
    const earned = r.boards.find((b: any) => b.key === 'earned');
    expect(earned.weekly.map((x: any) => x.name)).toEqual(['Bree', 'Ash']);
    expect(earned.you.weeklyRank).toBe(2);
    // Saved, and back after a restart
    await w.server.achievements.save(true);
    expect(await w.store.loadDoc('rankings')).toBeTruthy();
    // Next week: the weekly board is empty, all time remembers
    w.clock.t += 8 * 24 * 3600 * 1000;
    w.a.send({ type: 'rankings' });
    r = [...w.a.got].reverse().find((m) => m.type === 'rankings') as any;
    const e2 = r.boards.find((b: any) => b.key === 'earned');
    expect(e2.weekly).toEqual([]);
    expect(e2.allTime.length).toBe(2);
  });

  it('guests are not ranked', () => {
    const w = world();
    w.server.pilots.bumpStat(w.a.conn, 'kills', 3);
    w.a.send({ type: 'rankings' });
    const r = [...w.a.got].reverse().find((m) => m.type === 'rankings') as any;
    expect(r.boards.find((b: any) => b.key === 'kills').weekly).toEqual([]);
  });
});

describe('the weekly hunt', () => {
  it('every boss takes a turn, and the hunted one pays double', () => {
    const ids = Object.keys((files.bosses as any).bosses).filter((b) => !(files.bosses as any).bosses[b].arena && !(files.bosses as any).bosses[b].fixed);
    const seen = new Set<string>();
    const t0 = Date.UTC(2026, 0, 5);
    for (let k = 0; k < ids.length; k++) seen.add(huntedBoss(t0 + k * 7 * 86400000, ids)!);
    expect(seen.size).toBe(ids.length);
    expect(weekOf(t0 + 7 * 86400000)).toBe(weekOf(t0) + 1);

    const w = world();
    const id = huntedBoss(w.clock.t, ids)!;
    const def = (files.bosses as any).bosses[id];
    const host = (w.server as any).createBossHost();
    host.reward(w.a.pid(), id, def, def.xp, def.credits, {});
    // (The kill may earn ribbons too: look at the boss payout itself)
    const paid = w.a.got.find((m) => m.type === 'gained' && String((m as any).source) === `kill:${def.name}`) as any;
    expect(paid.credits).toBe(def.credits * 2);
    expect(paid.xp).toBe(def.xp * 2);
    // Arrivals are told about the hunt
    expect(w.a.got.some((m) => m.type === 'news' && (m as any).kind === 'hunt')).toBe(true);
  });
});

describe('sharing designs', () => {
  it('a design goes to the party (and only to the party)', () => {
    const w = world();
    const bp = w.server.getShips().get(w.a.pid())!.blueprint;
    w.a.send({ type: 'shareDesign', blueprint: bp });
    expect(w.b.got.some((m) => m.type === 'sharedDesign')).toBe(false);
    w.a.send({ type: 'partyInvite', name: 'Bree' });
    w.b.send({ type: 'partyRespond', accept: true });
    w.clock.t += 5000;
    w.a.send({ type: 'shareDesign', blueprint: { ...bp, name: 'Kestrel' } });
    const got = w.b.got.find((m) => m.type === 'sharedDesign') as any;
    expect(got.from).toBe('Ash');
    expect(got.blueprint.name).toBe('Kestrel');
  });
});
