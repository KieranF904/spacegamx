import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, InSystem, Input, ServerMessage, unpackMapLegs, unpackMapRoutes, unpackMapInfo, legAt, patrolNext, MAP_DOT_SLACK, type ServerMapDotsMessage, type Leg, type Patrol, type PatrolState } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from './loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { PROMOTE_RADIUS, DEMOTE_RADIUS, DEMOTE_AFTER, DEMOTE_CHECK, RECENT, cruiseOf } from './SimLod.js';

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
  // (Where a ship is: a distant one's route worked out, its components being written only now and then)
  const at = (eid: number) => server.lod.where(eid);
  return { server, t, got, pid, conn, bridge, step, num, hold, at, lod: server.lod, enemies: server.enemies };
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
    // Going distant moves nothing (its route starts where it was: at most a tick's flight)
    expect(Math.hypot(w.at(foe).x - before[0], w.at(foe).y - before[1])).toBeLessThan(cruiseOf(ship, w.bridge.tuning).speed * 2 + 1);
    expect(ship.hp).toEqual(hp);
    ship.cooldown.fill(500);
    w.step(120);
    expect(w.bridge.isDormant(foe)).toBe(true);
    expect(ship.hp).toEqual(hp);
    expect(ship.shield).toBe(0); // (caught up when it wakes, not while it sleeps)
    const p = w.at(foe), at = [p.x, p.y, p.vx, p.vy, p.angle];
    // Woken: the same ship, where its route had it, its shield and guns caught up
    w.hold(p.x + 30000, p.y);
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
    // (once nothing's hurt them for RECENT.damaged: packmates bumping as they regroup counts)
    const asleep = () => pack.filter((e) => w.bridge.has(e)).every((e) => w.bridge.isDormant(e));
    for (let i = 0; i < 60 * 60 && !asleep(); i++) w.step(1, () => { w.hold(-100000, -150000); check(); });
    expect(asleep()).toBe(true);
  });

  it('a system nobody is in goes distant at once, moving all the while, and is put away once it has been left a while', () => {
    const w = world();
    inSol(w, 120000, 0);
    const ash = w.num('ashfall');
    const eids = [
      ...w.enemies.spawnPack(ash, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff'] }, 20000, 20000),
      ...w.enemies.spawnPack(ash, { faction: 'pirates', ships: ['pirate_raider'] }, -30000, 10000),
    ];
    w.step(DEMOTE_CHECK + 1);
    expect(eids.every((e) => w.bridge.isDormant(e))).toBe(true);
    // Moving all the while (they patrol)...
    const x0 = w.at(eids[0]).x, y0 = w.at(eids[0]).y;
    w.step(60 * 10);
    expect(Math.hypot(w.at(eids[0]).x - x0, w.at(eids[0]).y - y0)).toBeGreaterThan(50);
    // ...then out of the world altogether (rules.json memory.evictAfterSeconds: game/SystemMemory.ts)
    w.step(60 * w.server.memory.rules.evictAfterSeconds);
    expect(eids.some((e) => w.bridge.has(e))).toBe(false);
    expect(w.server.memory.remembers('ashfall')).toBe(true);
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
    // (Ashfall's left empty all the while: kept in the world for this)
    (w.server.memory.rules as any).evictAfterSeconds = 1e6;
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
    let { x: px, y: py, angle: pa } = w.at(foe), fastest = 0, turned = 0;
    for (let i = 0; i < 60 * 60; i++) {
      w.step(1);
      const p = w.at(foe);
      fastest = Math.max(fastest, Math.hypot(p.x - px, p.y - py));
      turned = Math.max(turned, Math.abs(Math.atan2(Math.sin(p.angle - pa), Math.cos(p.angle - pa))));
      px = p.x; py = p.y; pa = p.angle;
    }
    // Never faster than it flies, nor turning faster than it can, from one tick to the next (no jumps)
    expect(fastest).toBeLessThanOrEqual(c.speed * 1.02 + 0.1);
    expect(turned).toBeLessThanOrEqual(c.turn + 1e-3);
    // And it got (most of the way) there at about the speed it flies
    const left = Math.hypot(w.at(foe).x + 20000, w.at(foe).y - 30000);
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
    const arrived = (e: number, x: number, y: number) => Math.hypot(w.at(e).x - x, w.at(e).y - y) < 1200;
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

  it('far ships and other pilots reach the system map (mapDots) while it is open: a leg or a patrol each, sent again only when it changes', () => {
    const w = world();
    const sol = w.num('sol');
    inSol(w, 120000, 0);
    const [foe] = w.enemies.spawnPack(sol, { faction: 'pirates', ships: ['pirate_raider'] }, -60000, 120000);
    // Another pilot, far off across the system
    const t2 = new LocalTransport(w.server);
    t2.connect();
    t2.send({ type: 'join', username: 'faraway' } as any);
    const p2 = t2.getPlayerId();
    (w.server as any).travelTo(w.server.pilots.connOf(p2), sol, -120000, -60000, false);
    const both = () => { w.hold(120000, 0); Position.x[p2] = -120000; Position.y[p2] = -60000; Velocity.x[p2] = Velocity.y[p2] = 0; };
    w.step(DEMOTE_AFTER + DEMOTE_CHECK * 2, both);
    expect(w.bridge.isDormant(foe)).toBe(true);
    const dots = () => w.got.filter((m): m is ServerMapDotsMessage => m.type === 'mapDots');
    // Map closed: nothing sent
    expect(dots().length).toBe(0);
    w.t.send({ type: 'mapView', open: true } as any);
    w.step(5, both);
    expect(dots().length).toBe(1);
    const first = dots()[0];
    expect(first.full).toBe(1);
    // The client's view of a dot: the last leg it was sent carried on from then, or its patrol's legs worked out (as FarShips does)
    const legs = new Map<number, { leg: Leg; tick: number; patrol?: { p: Patrol; s: PatrolState } }>();
    const take = (m: ServerMapDotsMessage) => {
      for (const r of unpackMapLegs(m.dots)) legs.set(r.id, { leg: r.leg, tick: m.tick });
      for (const r of unpackMapRoutes(m.routes ?? [], m.tick)) legs.set(r.id, { leg: r.state.leg, tick: r.state.t0, patrol: { p: r.patrol, s: r.state } });
      for (const id of m.gone ?? []) legs.delete(id);
    };
    const drawn = (id: number) => {
      const l = legs.get(id)!, now = (w.server as any).currentTick;
      while (l.patrol && now >= l.patrol.s.end) { l.patrol.s = patrolNext(l.patrol.p, l.patrol.s); l.leg = l.patrol.s.leg; l.tick = l.patrol.s.t0; }
      return legAt(l.leg, now - l.tick);
    };
    take(first);
    expect(unpackMapInfo(first.info ?? []).find((d) => d.id === foe)?.kind).toBe(3);
    expect(unpackMapInfo(first.info ?? []).find((d) => d.id === p2)?.kind).toBe(4);
    expect(first.names).toContain(foe);
    expect(first.names).toContain('faraway');
    // On patrol round where it was spawned: sent as its patrol, drawn exactly where it is
    expect(legs.get(foe)?.patrol).toBeTruthy();
    expect(Math.hypot(drawn(foe).x - w.at(foe).x, drawn(foe).y - w.at(foe).y)).toBeLessThan(1);
    // A minute on: always exactly where it is, its patrol never sent again (nor named), however many legs it flies
    let resent = 0;
    for (let s = 0; s < 60; s++) {
      const n = dots().length;
      w.step(60, both);
      for (const m of dots().slice(n)) { take(m); if (unpackMapLegs(m.dots).concat(unpackMapRoutes(m.routes ?? [], m.tick) as any).some((r) => r.id === foe)) resent++; expect(m.names?.includes(foe) ?? false).toBe(false); }
      expect(Math.hypot(drawn(foe).x - w.at(foe).x, drawn(foe).y - w.at(foe).y)).toBeLessThan(1);
      expect(Math.hypot(drawn(p2).x - Position.x[p2], drawn(p2).y - Position.y[p2])).toBeLessThan(MAP_DOT_SLACK);
    }
    expect(resent).toBe(0);
    // In view, it's an entity (not a dot)
    const p = w.at(foe);
    w.step(66, () => { w.hold(p.x + 20000, p.y); Position.x[p2] = -120000; Position.y[p2] = -60000; });
    expect(legs.has(foe) || dots().some((m) => m.gone?.includes(foe))).toBe(true);
    for (const m of dots()) take(m);
    expect(legs.has(foe)).toBe(false);
    // Closed again: nothing more
    w.t.send({ type: 'mapView', open: false } as any);
    const n = dots().length;
    w.step(130, both);
    expect(dots().length).toBe(n);
  });

  it("a distant ship's route is the same whether it's looked at every tick or once a minute", () => {
    const run = (every: number) => {
      const w = world();
      (w.server.memory.rules as any).evictAfterSeconds = 1e6;
      inSol(w, 120000, 0);
      const [foe] = w.enemies.spawnPack(w.num('ashfall'), { faction: 'pirates', ships: ['pirate_raider'] }, 20000, -10000);
      const seen: number[][] = [];
      for (let i = 1; i <= 60 * 60 * 3; i++) {
        w.step(1, () => w.hold(120000, 0));
        if (i % every === 0 || i % 3600 === 0) { const p = w.at(foe); if (i % 3600 === 0) seen.push([p.x, p.y, p.angle]); }
      }
      return seen;
    };
    expect(run(1)).toEqual(run(3600));
  }, 120000);

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
