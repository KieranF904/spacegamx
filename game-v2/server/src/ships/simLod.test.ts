import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, InSystem, Input, ServerMessage, unpackMapDots, type ServerMapDotsMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from './loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { PROMOTE_RADIUS, DEMOTE_RADIUS, DEMOTE_AFTER, DEMOTE_CHECK, STEP, RECENT, cruiseOf } from './SimLod.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'watcher' } as any);
  const pid = t.getPlayerId();
  const conn = (server as any).clients.values().next().value;
  const bridge = server.getShips();
  const step = (n = 1, each?: () => void) => { for (let i = 0; i < n; i++) { each?.(); server.step(); } };
  const num = (id: string) => server.gameData.getSystemNum(id);
  // The pilot somewhere, sitting still (god mode: nothing it meets ends the test)
  const hold = (x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  server['admin'].god.add(server.pilots.connOf(pid) as any);
  return { server, t, got, pid, conn, bridge, step, num, hold, lod: server.lod, enemies: server.enemies };
}

/** The pilot out in Sol's open middle, away from its safe space */
function inSol(w: ReturnType<typeof world>, x: number, y: number) {
  (w.server as any).travelTo(w.conn, w.num('sol'), x, y, false);
  w.hold(x, y);
}

describe('simulation level of detail', () => {
  it('a ship nobody is near goes distant only after a while, and wakes as soon as a pilot comes within reach (hysteresis)', () => {
    const w = world();
    const sol = w.num('sol');
    inSol(w, 120000, 0);
    const [foe] = w.enemies.spawnPack(sol, { faction: 'pirates', ships: ['pirate_raider'] }, 120000, 90000);
    // Stand off from it (keeping step with where it patrols), a given distance away
    const off = (d: number) => () => w.hold(Position.x[foe] + d, Position.y[foe]);
    // Between the two radii: never put to sleep
    w.step(DEMOTE_AFTER + DEMOTE_CHECK * 3, off((PROMOTE_RADIUS + DEMOTE_RADIUS) / 2));
    expect(w.bridge.isDormant(foe)).toBe(false);
    // Past the outer one: not at once...
    w.step(DEMOTE_AFTER - DEMOTE_CHECK * 2, off(DEMOTE_RADIUS + 6000));
    expect(w.bridge.isDormant(foe)).toBe(false);
    // ...but once it's been out of everyone's reach for DEMOTE_AFTER
    w.step(DEMOTE_CHECK * 4, off(DEMOTE_RADIUS + 6000));
    expect(w.bridge.isDormant(foe)).toBe(true);
    // Back between the radii: it stays distant (no flicker at the edge)
    w.step(DEMOTE_CHECK * 3, off((PROMOTE_RADIUS + DEMOTE_RADIUS) / 2));
    expect(w.bridge.isDormant(foe)).toBe(true);
    // Inside the inner one: live the same tick, well before it could come into anyone's view
    off(PROMOTE_RADIUS - 3000)();
    w.step(1);
    expect(w.bridge.isDormant(foe)).toBe(false);
    expect((w.conn.shipView as Set<number>).has(foe)).toBe(false);
  });

  it('keeps every part, its shield and its guns as they were, both ways, and carries on from where it was', () => {
    const w = world();
    const sol = w.num('sol');
    inSol(w, 120000, 0);
    const [foe] = w.enemies.spawnPack(sol, { faction: 'pirates', ships: ['pirate_raider'] }, 120000, 100000);
    const ship = w.bridge.get(foe)!;
    // Battle damage: a part shot up, the shield down, a gun mid-cooldown
    const part = ship.blueprint.parts.findIndex((p) => p.fn !== 'core');
    w.bridge.damagePartBy(foe, part, ship.maxHp[part] * 0.4, w.pid);
    ship.shield = 0;
    // Hurt lately: it isn't put to sleep yet, however far everyone is
    w.step(RECENT.damaged - 60);
    expect(w.bridge.isDormant(foe)).toBe(false);
    const hp = [...ship.hp];
    let slept = -1;
    let before: number[] = [];
    for (let i = 0; i < DEMOTE_AFTER + 200 && slept < 0; i++) {
      before = [Position.x[foe], Position.y[foe], Velocity.x[foe], Velocity.y[foe], Rotation.angle[foe]];
      w.step(1);
      if (w.bridge.isDormant(foe)) slept = i;
    }
    expect(slept).toBeGreaterThanOrEqual(0);
    // Going distant moves nothing (the tick it went, SimLod hasn't moved it yet, or by at most a step's flight)
    expect(Math.hypot(Position.x[foe] - before[0], Position.y[foe] - before[1])).toBeLessThan(cruiseOf(ship, w.bridge.tuning).speed * STEP + 1);
    expect(ship.hp).toEqual(hp);
    ship.cooldown.fill(500);
    w.step(STEP * 10);
    expect(w.bridge.isDormant(foe)).toBe(true);
    expect(ship.hp).toEqual(hp);
    expect(ship.shield).toBe(0); // (caught up when it wakes, not while it sleeps)
    const at = [Position.x[foe], Position.y[foe], Velocity.x[foe], Velocity.y[foe], Rotation.angle[foe]];
    // Woken: the same ship, where it was, its shield and guns caught up
    w.hold(Position.x[foe] + 30000, Position.y[foe]);
    w.lod.tick();
    expect(w.bridge.isDormant(foe)).toBe(false);
    expect(ship.hp).toEqual(hp);
    expect(Math.abs(Position.x[foe] - at[0]) + Math.abs(Position.y[foe] - at[1])).toBeLessThan(0.02);
    expect(Math.abs(Velocity.x[foe] - at[2]) + Math.abs(Velocity.y[foe] - at[3])).toBeLessThan(0.02);
    expect(Math.abs(Rotation.angle[foe] - at[4])).toBeLessThan(0.002);
    expect(ship.cooldown.every((c) => c < 500)).toBe(true);
    if (ship.derived.shieldMax > 0) expect(ship.shield).toBeGreaterThan(0);
  });

  it('never puts a ship to sleep while it is fighting, hurt or shooting lately', () => {
    const w = world();
    const sol = w.num('sol');
    // Out past the safe space, a pack right on top of the pilot: it engages and fires
    inSol(w, 100000, 100000);
    const pack = w.enemies.spawnPack(sol, { faction: 'pirates', ships: ['pirate_raider', 'pirate_raider'] }, 101500, 100000);
    let fought = false;
    const check = () => {
      for (const e of pack) {
        if (!w.bridge.has(e)) continue;
        if (w.enemies.targetOf(e) >= 0) fought = true;
        if (!w.bridge.isDormant(e)) continue;
        // Distant: not in a fight, not hurt or firing lately
        expect(w.enemies.targetOf(e)).toBe(-1);
        expect((w.server as any).currentTick - w.bridge.lastDamagedTick(e)).toBeGreaterThanOrEqual(RECENT.damaged);
        expect((w.server as any).currentTick - w.bridge.lastFiredTick(e)).toBeGreaterThanOrEqual(RECENT.fired);
      }
    };
    w.step(60 * 6, () => { w.hold(100000, 100000); check(); });
    expect(fought).toBe(true);
    // The pilot jumps clean away mid-fight: they break off in time, and only then go distant
    w.step(DEMOTE_AFTER + RECENT.damaged + 60 * 4, () => { w.hold(-100000, -150000); check(); });
    expect(pack.filter((e) => w.bridge.has(e)).every((e) => w.bridge.isDormant(e))).toBe(true);
  });

  it('a system nobody is in goes distant at once, and its packs still leave when they always did', () => {
    const w = world();
    inSol(w, 120000, 0);
    const ash = w.num('ashfall');
    const eids = [
      ...w.enemies.spawnPack(ash, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff'] }, 20000, 20000),
      ...w.enemies.spawnPack(ash, { faction: 'pirates', ships: ['pirate_raider'] }, -30000, 10000),
    ];
    w.step(DEMOTE_CHECK + 1);
    expect(eids.every((e) => w.bridge.isDormant(e))).toBe(true);
    // Moving all the while (they patrol), and gone after the idle time (factions.json rules.idleDespawnSeconds)
    const x0 = Position.x[eids[0]], y0 = Position.y[eids[0]];
    w.step(60 * 20);
    expect(Math.hypot(Position.x[eids[0]] - x0, Position.y[eids[0]] - y0)).toBeGreaterThan(50);
    const idle = (files.factions as any).rules.idleDespawnSeconds * 60;
    w.step(idle);
    expect(eids.some((e) => w.bridge.has(e))).toBe(false);
  });

  it('a pilot spooling a jump wakes what it could land beside before it gets there', () => {
    const w = world();
    const sol = w.num('sol');
    inSol(w, 0, 150000);
    const [foe] = w.enemies.spawnPack(sol, { faction: 'pirates', ships: ['pirate_raider'] }, 110000, 150000);
    w.step(DEMOTE_AFTER + DEMOTE_CHECK * 2, () => w.hold(0, 150000));
    expect(w.bridge.isDormant(foe)).toBe(true);
    // Facing it, the jump key held: it's live while the drive's still charging
    Rotation.angle[w.pid] = 0;
    Input.targetAngle[w.pid] = 0;
    Input.jump[w.pid] = 1;
    Input.cursorDist[w.pid] = 100000;
    let woke = -1;
    for (let i = 0; i < 80 && woke < 0; i++) {
      Velocity.x[w.pid] = 0; Velocity.y[w.pid] = 0;
      w.step(1);
      if (!w.bridge.isDormant(foe)) woke = i;
    }
    expect(woke).toBeGreaterThanOrEqual(0);
    expect(w.bridge.get(w.pid)!.jump).toBeLessThan(90);
  });

  it('a distant ship flies like a real one: no jumps, never faster than it can fly, turning as it can', () => {
    const w = world();
    inSol(w, 120000, 0);
    const ash = w.num('ashfall');
    const [foe] = w.enemies.spawnPack(ash, { faction: 'pirates', ships: ['pirate_raider'] }, 30000, -20000);
    // Sent somewhere well off: it flies the whole way distant
    w.enemies.sendPack([foe], { x: -20000, y: 30000 });
    w.step(DEMOTE_CHECK + 1);
    expect(w.bridge.isDormant(foe)).toBe(true);
    const ship = w.bridge.get(foe)!;
    const c = cruiseOf(ship, w.bridge.tuning);
    expect(c.speed).toBeGreaterThan(1);
    let px = Position.x[foe], py = Position.y[foe], pa = Rotation.angle[foe], fastest = 0, turned = 0;
    for (let i = 0; i < 60 * 60; i++) {
      w.step(1);
      const d = Math.hypot(Position.x[foe] - px, Position.y[foe] - py);
      fastest = Math.max(fastest, d);
      turned = Math.max(turned, Math.abs(Math.atan2(Math.sin(Rotation.angle[foe] - pa), Math.cos(Rotation.angle[foe] - pa))));
      px = Position.x[foe]; py = Position.y[foe]; pa = Rotation.angle[foe];
    }
    // A step's flight at most (its cruise speed × STEP ticks), and a step's turn
    expect(fastest).toBeLessThanOrEqual(c.speed * STEP * 1.02 + 0.1);
    expect(turned).toBeLessThanOrEqual(c.turn * STEP + 1e-3);
    // And it got (most of the way) there at about the speed it flies
    const left = Math.hypot(Position.x[foe] + 20000, Position.y[foe] - 30000);
    expect(left).toBeLessThan(Math.hypot(50000, 50000) - c.speed * 60 * 60 * 0.5);
  });

  it('travels about as fast distant as live (the same design, the same trip)', () => {
    const w = world();
    inSol(w, 120000, 0);
    const bp = w.bridge.library.get('hauler')!;
    const sol = w.num('sol'), ash = w.num('ashfall');
    const live = w.bridge.spawnDummy(bp, 120000, 5000, 0, sol);
    const far = w.bridge.spawnDummy(bp, 0, 5000, 0, ash);
    w.bridge.setAutopilot(live, { x: 120000, y: 25000, arriveRadius: 500 });
    w.bridge.setAutopilot(far, { x: 0, y: 25000, arriveRadius: 500 });
    const arrived = (e: number, x: number, y: number) => Math.hypot(Position.x[e] - x, Position.y[e] - y) < 1200;
    let tLive = -1, tFar = -1;
    for (let i = 0; i < 60 * 240 && (tLive < 0 || tFar < 0); i++) {
      w.step(1, () => w.hold(120000, 0));
      if (i === DEMOTE_CHECK * 2) expect(w.bridge.isDormant(far)).toBe(true);
      expect(w.bridge.isDormant(live)).toBe(false);
      if (tLive < 0 && arrived(live, 120000, 25000)) tLive = i;
      if (tFar < 0 && arrived(far, 0, 25000)) tFar = i;
    }
    expect(tLive).toBeGreaterThan(0);
    expect(tFar).toBeGreaterThan(0);
    expect(tFar / tLive).toBeGreaterThan(0.7);
    expect(tFar / tLive).toBeLessThan(1.4);
  });

  it('far ships still reach the system map (mapDots) while it is open, where they are', () => {
    const w = world();
    const sol = w.num('sol');
    inSol(w, 120000, 0);
    const [foe] = w.enemies.spawnPack(sol, { faction: 'pirates', ships: ['pirate_raider'] }, -60000, 120000);
    w.step(DEMOTE_AFTER + DEMOTE_CHECK * 2, () => w.hold(120000, 0));
    expect(w.bridge.isDormant(foe)).toBe(true);
    const dots = () => w.got.filter((m): m is ServerMapDotsMessage => m.type === 'mapDots');
    // Map closed: nothing sent
    expect(dots().length).toBe(0);
    w.t.send({ type: 'mapView', open: true } as any);
    w.step(5, () => w.hold(120000, 0));
    expect(dots().length).toBe(1);
    const first = unpackMapDots(dots()[0].dots).find((d) => d.id === foe)!;
    expect(first).toBeTruthy();
    expect(first.kind).toBe(3);
    const k0 = (w.server as any).currentTick - dots()[0].tick;
    expect(Math.hypot(first.x + first.vx * k0 - Position.x[foe], first.y + first.vy * k0 - Position.y[foe])).toBeLessThan(60 + k0 * 0.2);
    // Named once
    expect(dots()[0].names).toContain(foe);
    w.step(125, () => w.hold(120000, 0));
    expect(dots().length).toBe(3);
    const last = dots()[2];
    expect(last.names?.includes(foe) ?? false).toBe(false);
    // Where it is now, carried on along its velocity from when it was sent (as the map does: FarShips)
    const d = unpackMapDots(last.dots).find((x) => x.id === foe)!;
    const k = (w.server as any).currentTick - last.tick;
    expect(Math.hypot(d.x + d.vx * k - Position.x[foe], d.y + d.vy * k - Position.y[foe])).toBeLessThan(60 + k * 0.2);
    // In view, it's an entity (not a dot)
    w.step(1, () => w.hold(Position.x[foe] + 20000, Position.y[foe]));
    w.step(65, () => w.hold(Position.x[foe] + 20000, Position.y[foe]));
    expect(unpackMapDots(dots()[dots().length - 1].dots).some((x) => x.id === foe)).toBe(false);
    // Closed again: nothing more
    w.t.send({ type: 'mapView', open: false } as any);
    const n = dots().length;
    w.step(130, () => w.hold(120000, 0));
    expect(dots().length).toBe(n);
  });

  it('a boss idle at its lair sleeps far from pilots and wakes as one comes; one fighting never does', () => {
    const w = world();
    const bor = w.num('borealis');
    (w.server as any).travelTo(w.conn, bor, -90000, -90000, false);
    w.hold(-90000, -90000);
    const eid = w.server.bosses.spawn('boss_brood_mother');
    expect(eid).toBeGreaterThan(0);
    w.step(DEMOTE_AFTER + DEMOTE_CHECK * 3, () => w.hold(-90000, -90000));
    expect(w.bridge.isDormant(eid)).toBe(true);
    expect(w.server.bosses.busy(eid)).toBe(false);
    // Someone flies over: it's live again, its brain picking up where it was
    const lx = Position.x[eid], ly = Position.y[eid];
    w.step(2, () => w.hold(lx - PROMOTE_RADIUS + 5000, ly));
    expect(w.bridge.isDormant(eid)).toBe(false);
    // Up close: it fights. Then the pilot is suddenly far: it stays live while it's still at it
    w.step(60 * 8, () => w.hold(lx + 2500, ly));
    expect(w.enemies.targetOf(eid)).toBeGreaterThanOrEqual(0);
    w.step(DEMOTE_CHECK * 2 + 1, () => w.hold(-90000, -90000));
    // (It may break off and settle; it's never asleep while busy)
    if (w.server.bosses.busy(eid)) expect(w.bridge.isDormant(eid)).toBe(false);
    w.step(DEMOTE_AFTER + RECENT.damaged + 60 * 30, () => {
      w.hold(-90000, -90000);
      if (w.bridge.isDormant(eid)) expect(w.server.bosses.busy(eid)).toBe(false);
    });
  });
});
