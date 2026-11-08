/**
 * A lair boss's arena, life and fight rules on the server (docs/bosses/rework-2026-11.md 2, 7, 10), on the Scrap
 * Mother's nest: its barrier, waking her by passing it, leaving out of combat, recovery and dormancy, windows,
 * personal attacks and the boss tools.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, LIFE, GATE, WINDOW, DECISION, rayTerrain, insideArena, type ServerMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { devHooks } from '../brains/kit.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const NEST = 'sol_scrap_nest', MOTHER = 'boss_scrap_mother';

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    devTeleport: true,
    ships: createShipBridge(loadShipConfigCached(dataDir)),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'arena' } as any);
  const pid = t.getPlayerId();
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  const num = server['gameData'].getSystemNum(NEST);
  const arena = server['gameData'].getSystem(NEST)!.arena!;
  const place = (x: number, y: number, vx = 0, vy = 0) => {
    InSystem.systemId[pid] = num; Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = vx; Velocity.y[pid] = vy;
  };
  const life = () => server.bosses.life.stateOf(MOTHER);
  const boss = () => server.bosses.eidOf(MOTHER);
  const msgs = <T extends ServerMessage['type']>(type: T) => got.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  // (the pilot can't be hurt: these tests are about the arena, not dodging)
  server.bosses.unhurt.add(pid);
  return { server, t, got, pid, step, num, arena, place, life, boss, msgs };
}

/** Into the arena through its barrier, from just outside it, and up to the fight (`close`: then near her, so she fights) */
function wake(w: ReturnType<typeof world>, close = false): void {
  w.place(0, w.arena.radius + 260);
  w.step(70);
  w.t.send({ type: 'interact' } as any);
  w.step(LIFE.wake + 2);
  if (close) { w.place(0, 2400); w.step(30); }
}

describe('boss arenas', () => {
  it('the Mother lies dormant (no ship) until a pilot passes her barrier inward: entering is free, she rises, then fights', () => {
    const w = world();
    w.place(0, w.arena.radius + 260);
    w.step(130);
    expect(w.life()).toBe('dormant');
    expect(w.server.bosses.inSystem(w.num)).toEqual([]);
    w.t.send({ type: 'interact' } as any);
    expect(insideArena(w.arena, Position.x[w.pid], Position.y[w.pid])).toBe(true);
    expect(w.life()).toBe('waking');
    const eid = w.boss();
    expect(eid).toBeGreaterThanOrEqual(0);
    // (waking: it can't be hurt, and every client is told from which tick it rises)
    expect(w.server.bosses.invulnerable(eid)).toBe(true);
    const told = w.msgs('bossLife');
    expect(told.at(-1)).toMatchObject({ boss: MOTHER, bodyId: eid, state: 'waking' });
    w.step(LIFE.wake + 1);
    expect(w.life()).toBe('active');
    expect(w.server.bosses.invulnerable(eid)).toBe(false);
    expect(w.msgs('bossIntro').length).toBe(1);
  });

  it('the barrier is solid both ways: ships and shots stop at it, and the boss stays in', () => {
    const w = world();
    const rock = w.server.terrainOf(w.num)!;
    expect(rock.pieces.length).toBeGreaterThan(12);
    expect(rayTerrain(rock, 0, w.arena.radius - 500, 0, w.arena.radius + 500)).toBeLessThan(1);
    expect(rayTerrain(rock, w.arena.radius + 500, 0, w.arena.radius - 500, 0)).toBeLessThan(1);
    // A pilot flying hard at it from inside, and from outside, stays where it was
    w.place(0, w.arena.radius - 400, 0, 30);
    w.step(40);
    expect(insideArena(w.arena, Position.x[w.pid], Position.y[w.pid])).toBe(true);
    w.place(0, w.arena.radius + 600, 0, -30);
    w.step(40);
    expect(insideArena(w.arena, Position.x[w.pid], Position.y[w.pid])).toBe(false);
    // The boss, flung at it down the Throat (the Heart's one way out), stays in
    wake(w);
    const b = w.boss(), gy = w.arena.barrier![0][1];
    w.server.ships.teleport(b, 0, gy - 1900);
    Velocity.y[b] = 60;
    w.step(30);
    expect(insideArena(w.arena, Position.x[b], Position.y[b])).toBe(true);
  });

  it('leaving needs 5 s out of combat; dying or logging in inside puts you outside', () => {
    const w = world();
    wake(w);
    w.place(0, w.arena.radius - 250);
    w.server.combat.note(w.pid, w.boss(), w.server.currentTick);
    w.t.send({ type: 'interact' } as any);
    expect(insideArena(w.arena, Position.x[w.pid], Position.y[w.pid])).toBe(true);
    expect(w.server.arenaGates.leaveWait(w.pid)).toBeGreaterThan(0);
    w.step(GATE.quiet + 1);
    w.place(0, w.arena.radius - 250);
    expect(w.server.arenaGates.leaveWait(w.pid)).toBe(0);
    w.t.send({ type: 'interact' } as any);
    expect(insideArena(w.arena, Position.x[w.pid], Position.y[w.pid])).toBe(false);
    // (in, then put out: the way a death or a log-in inside is)
    w.place(0, 0);
    expect(w.server.arenaGates.placeOutside(w.pid)).toBe(true);
    expect(Position.x[w.pid]).toBe(w.arena.outside.x);
    expect(Position.y[w.pid]).toBe(w.arena.outside.y);
  });

  it('out of combat it idles 30 s, heals to full in 2 minutes, sinks back and lies dormant; anyone coming in stops the heal', () => {
    const w = world();
    wake(w);
    const b = w.boss(), ship = w.server.ships.get(b)!;
    // Hurt it, then everyone out
    // (a light wear on many parts: nothing breaks off, so nothing goes on hurting it after)
    for (let i = 0; i < ship.hp.length; i += 2) if (ship.hp[i] > 2) w.server.ships.damagePartBy(b, i, ship.hp[i] * 0.15, w.pid);
    w.server.ships.teleport(w.pid, w.arena.outside.x, w.arena.outside.y);
    w.step(2);
    expect(w.life()).toBe('recovering');
    const hurt = w.server.ships.integrity(b);
    w.step(LIFE.idle + 2);
    expect(w.life()).toBe('healing');
    w.step(900);
    const mid = w.server.ships.integrity(b);
    expect(mid).toBeGreaterThan(hurt);
    // Someone comes in: the heal stops where it is
    w.place(0, w.arena.radius - 600);
    w.step(2);
    expect(w.life()).toBe('active');
    w.server.ships.teleport(w.pid, w.arena.outside.x, w.arena.outside.y);
    w.step(2);
    expect(w.life()).toBe('recovering');
    // The rest at once (the dev clock skip), then the sinking
    w.server.bosses.life.skip(MOTHER);
    expect(w.life()).toBe('healing');
    w.server.bosses.life.skip(MOTHER);
    expect(w.life()).toBe('sleeping');
    w.step(2);
    expect(w.server.ships.integrity(b)).toBeGreaterThan(0.999);
    w.step(LIFE.sleep);
    expect(w.life()).toBe('dormant');
    expect(w.server.bosses.inSystem(w.num)).toEqual([]);
    expect(w.msgs('bossLife').map((m) => m.state)).toEqual(['waking', 'active', 'recovering', 'healing', 'active', 'recovering', 'healing', 'sleeping', 'dormant']);
  }, 60_000);

  it('a window takes x2 up to its cap; filling it early cracks it (a bonus, a stagger) and clients see the meter', () => {
    const w = world();
    wake(w);
    const b = w.boss(), hooks = devHooks(w.server.bosses.brainOf(b))!;
    // (outside her windows the Mother takes her own x0.25: brains/scrapMother.ts)
    expect(w.server.bosses.taken(b)).toBeCloseTo(0.25);
    w.t.send({ type: 'bossDevTool', action: 'window' } as any);
    expect(w.server.bosses.taken(b)).toBe(WINDOW.inside);
    const cap = hooks.fight.window!.cap;
    const ship = w.server.ships.get(b)!;
    let dealt = 0;
    for (let i = 0; i < ship.hp.length && dealt < cap * 1.2; i++) if (ship.hp[i] > 50 && ship.derived.alive[i]) dealt += w.server.ships.damagePartBy(b, i, 400, w.pid);
    expect(hooks.fight.window!.crackAt).toBeGreaterThanOrEqual(0);
    expect(hooks.fight.stats.cracks).toBe(1);
    // (staggered: outside rate, and it holds still)
    expect(w.server.bosses.taken(b)).toBeCloseTo(0.25);
    w.step(8);
    const told = w.msgs('bossWindow');
    expect(told[0]).toMatchObject({ bodyId: b, fill: 0, cap });
    expect(told.some((m) => m.crack && m.fill === WINDOW.steps)).toBe(true);
    w.step(DEV_TICKS);
    expect(w.msgs('bossWindow').at(-1)!.ticks).toBe(0);
  });

  it('personal attacks: each beat each pilot present may draw one, the loose cap holds with 12 dummies, none in a window\'s rest beat', () => {
    const w = world();
    wake(w, true);
    const b = w.boss(), brain = w.server.bosses.brainOf(b)!, hooks = devHooks(brain)!;
    const tables = (brain as any).tables;
    tables.personal = { beat: 120, chance: 1, pool: [['mark'], ['mark'], ['mark']], ticks: 200 };
    const drawn: number[][] = [];
    const host = (brain as any).host, decide = host.decide;
    host.decide = (eid: number, op: number, args: number[], s: unknown) => { if (op === DECISION.PERSONAL) drawn.push([w.server.currentTick, ...args]); decide?.(eid, op, args, s); };
    w.t.send({ type: 'bossDevTool', action: 'dummies', n: 12, dps: 'off' } as any);
    expect(w.server.arenaGates.present(w.num).length).toBe(13);
    let most = 0;
    for (let i = 0; i < 1200; i++) { w.step(); most = Math.max(most, hooks.fight.running); }
    expect(drawn.length).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(6);
    expect(most).toBe(6);
    for (const [, slot] of drawn) expect(slot).toBeLessThan(13);
    // Every draw names the slot's pilot, and the dummies are among those drawn
    expect(new Set(drawn.map((d) => d[1])).size).toBeGreaterThan(1);
    // (her attack phases: they come in her signature moves too; only a window's rest beat holds them off)
    let inMoves = 0, inRest = 0;
    host.decide = (eid: number, op: number, args: number[], s: unknown) => {
      if (op === DECISION.PERSONAL) {
        const win = hooks.fight.window, now = w.server.currentTick;
        if (hooks.fight.isSignature(hooks.moveName)) inMoves++;
        if (win && now >= win.at && now < win.at + WINDOW.rest) inRest++;
      }
      decide?.(eid, op, args, s);
    };
    w.step(2400);
    expect(inMoves).toBeGreaterThan(0);
    expect(inRest).toBe(0);
  }, 60_000);

  it('the boss tools: hold, play a move, stage jump, dummies that deal damage, the damage log and the summary', () => {
    const w = world();
    wake(w, true);
    const b = w.boss(), hooks = devHooks(w.server.bosses.brainOf(b))!;
    w.t.send({ type: 'bossDevTool', action: 'panel' } as any);
    const panel = w.msgs('bossDev').at(-1)!;
    expect(panel.bosses[0]).toMatchObject({ id: MOTHER, eid: b, life: 'active', stage: 1 });
    expect(panel.bosses[0].moves).toContain('haul');
    w.t.send({ type: 'bossDevTool', action: 'move', move: 'haul' } as any);
    w.step(3);
    expect(hooks.moveName).toBe('haul');
    w.t.send({ type: 'bossDevTool', action: 'hold', on: true } as any);
    w.step(3);
    expect(hooks.moveName).toBe('');
    w.t.send({ type: 'bossDevTool', action: 'hold', on: false } as any);
    const before = w.server.ships.integrity(b);
    w.t.send({ type: 'bossDevTool', action: 'dummies', n: 4, dps: 'starter' } as any);
    w.step(130);
    expect(w.server.ships.integrity(b)).toBeLessThan(before);
    // A personal attack on me, logged with what it was (the pilot can be hurt for this one)
    w.server.bosses.unhurt.delete(w.pid);
    w.place(Position.x[b] + 2400, Position.y[b]);
    w.t.send({ type: 'bossDevTool', action: 'personal', move: 'mark' } as any);
    w.step(100);
    w.t.send({ type: 'bossDevTool', action: 'panel' } as any);
    const log = w.msgs('bossDev').at(-1)!.log;
    expect(log.some((e) => e.attack === 'personal mark' && /Scrap Mother/.test(e.source))).toBe(true);
    w.t.send({ type: 'bossDevTool', action: 'summary' } as any);
    // (the one forced on me at least: her own rolls come in her moves too now)
    expect(w.msgs('bossDev').at(-1)!.summary).toMatch(/Personal attacks drawn: (.*, )?arena [1-9]/);
    w.server.bosses.unhurt.add(w.pid);
    w.t.send({ type: 'bossDevTool', action: 'stage', n: 2 } as any);
    w.step(2);
    expect(hooks.stageNow).toBe(2);
  }, 60_000);
});

const DEV_TICKS = 480;
