/**
 * The training yard's foundation: per-pilot damage counters, owner-only drops, done-step objects inert for that pilot
 * only, skipping at any step, the one-way exit, stationary bodies, and marker events (docs: common/src/tutorial/README.md)
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Asteroid, InSystem, Projectile, Dead, ServerMessage, TutorialEvent, objectPos } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const shipConfig = loadShipConfigCached(dataDir);

function yard(names = ['ann', 'bo'], tutorial = true) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false, tutorial, ships: createShipBridge(shipConfig),
  });
  const pilots = names.map((n) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: n } as never);
    const pid = t.getPlayerId();
    const conn = server.pilots.connOf(pid)!;
    return { t, got, pid, conn, profile: () => server.pilots.get(conn)! };
  });
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  const tut = server.tutorial!;
  const data = server.gameData.tutorialFile!;
  const eid = (id: string) => tut.entityOf(id)!;
  const put = (pid: number, x: number, y: number) => { server.ships.teleport(pid, x, y); Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  const center = data.yard.center;
  const dist = (pid: number) => Math.hypot(Position.x[pid] - center.x, Position.y[pid] - center.y);
  return { server, pilots, step, tut, data, eid, put, center, dist };
}

describe('the training yard', () => {
  it('puts new pilots in the yard at Vesta, in Sol, and tells each its state', () => {
    const w = yard();
    for (const p of w.pilots) {
      expect(InSystem.systemId[p.pid]).toBe(w.server.gameData.getSystemNum('sol'));
      expect(w.dist(p.pid)).toBeLessThan(w.data.yard.spawnRadius + 50);
      expect(p.profile().tutorial).toEqual({ step: 'welcome', done: [], left: false });
    }
    const state = w.pilots[0].got.filter((m) => m.type === 'tutorialState').pop() as Extract<ServerMessage, { type: 'tutorialState' }>;
    expect(state).toMatchObject({ step: 'welcome', done: [], left: false, broken: [], passed: [] });
    // one shared yard: both are within the leash of each other
    expect(Math.hypot(Position.x[w.pilots[0].pid] - Position.x[w.pilots[1].pid], Position.y[w.pilots[0].pid] - Position.y[w.pilots[1].pid])).toBeLessThan(w.data.yard.spawnRadius * 2 + 50);
  });

  it('without the option nothing is built: no yard station, no bodies, pilots start beside Sol Central', () => {
    const w = yard(['solo'], false);
    expect(w.server.tutorial).toBeUndefined();
    expect(Math.hypot(Position.x[w.pilots[0].pid] - w.center.x, Position.y[w.pilots[0].pid] - w.center.y)).toBeGreaterThan(20000);
  });

  it('two pilots hitting one rock keep their own counters; the shared rock never changes', () => {
    const w = yard();
    const [a, b] = w.pilots;
    const rock = w.eid('training_rock');
    const hp0 = Asteroid.hp[rock], x0 = Position.x[rock], y0 = Position.y[rock];
    expect(w.tut.hit(rock, a.pid, 250)).toBe(true);
    expect(w.tut.hit(rock, b.pid, 100)).toBe(true);
    expect(a.profile().tutorial.hits?.training_rock).toBe(250);
    expect(b.profile().tutorial.hits?.training_rock).toBe(100);
    expect(w.tut.hit(rock, a.pid, 10_000)).toBe(true);
    expect(a.profile().tutorial.hits?.training_rock).toBe(600);
    expect(b.profile().tutorial.hits?.training_rock).toBe(100);
    expect(Asteroid.hp[rock]).toBe(hp0);
    expect(Position.x[rock]).toBe(x0);
    expect(Position.y[rock]).toBe(y0);
    // a body that is not a training one is not claimed
    expect(w.tut.hit(999_999, a.pid, 5)).toBe(false);
  });

  it('a real shell striking a training rock is counted for its owner and breaks nothing', () => {
    const w = yard();
    const [a, b] = w.pilots;
    const rock = w.eid('training_rock');
    const world = w.server.world;
    const shell = () => {
      const e = bitecs.addEntity(world);
      bitecs.addComponent(world, Projectile, e);
      bitecs.addComponent(world, InSystem, e);
      InSystem.systemId[e] = InSystem.systemId[rock];
      Projectile.miningYield[e] = 1;
      return e;
    };
    const s1 = shell();
    w.server.hurtAsteroid(s1, rock, a.pid, 700, Position.x[rock], Position.y[rock]);
    expect(bitecs.hasComponent(world, Dead, s1)).toBe(true);
    expect(bitecs.hasComponent(world, Dead, rock)).toBe(false);
    expect(Asteroid.hp[rock]).toBeGreaterThan(900_000);
    expect(a.profile().tutorial.hits?.training_rock).toBe(600);
    expect(b.profile().tutorial.hits).toBeUndefined();
    // the same shell from B yields nothing of A's and counts for B
    w.server.hurtAsteroid(shell(), rock, b.pid, 50, Position.x[rock], Position.y[rock]);
    expect(b.profile().tutorial.hits?.training_rock).toBe(50);
  });

  it('breaking a rock drops ore only the owner sees and can take', () => {
    const w = yard();
    const [a, b] = w.pilots;
    const events: [number, TutorialEvent][] = [];
    w.tut.subscribe((c, ev) => events.push([c.playerId, ev]));
    const rock = w.eid('training_rock');
    w.tut.hit(rock, a.pid, 600);
    expect(events).toEqual([[a.pid, { kind: 'objectBroken', object: 'training_rock', step: 'mine' }]]);
    const pods = w.server.pods.near(InSystem.systemId[rock], Position.x[rock], Position.y[rock], 400);
    expect(pods.length).toBe(4);
    const total: Record<string, number> = {};
    for (const p of pods) for (const [k, n] of Object.entries(w.server.pods.get(p)!)) total[k] = (total[k] ?? 0) + n;
    expect(total).toEqual({ iron_ore: 8, nickel_ore: 4 });
    const keyA = w.server.pilots.keyOf(a.conn), keyB = w.server.pilots.keyOf(b.conn);
    expect(w.server.pods.hasPrivate).toBe(true);
    for (const p of pods) { expect(w.server.pods.visibleTo(p, keyA)).toBe(true); expect(w.server.pods.visibleTo(p, keyB)).toBe(false); }
    // B sits on the chunks: nothing is taken. A sits on them: all of it.
    const cargoOf = (p: typeof a) => Object.fromEntries(p.profile().cargo.map((s) => [s.id, s.n]));
    const at = { x: Position.x[pods[0]], y: Position.y[pods[0]] };
    w.put(b.pid, at.x, at.y);
    w.step(30);
    expect(cargoOf(b)).toEqual({});
    expect(w.server.pods.near(InSystem.systemId[rock], at.x, at.y, 600).length).toBeGreaterThan(0);
    w.put(b.pid, w.center.x, w.center.y - 3000);
    for (const p of pods) w.put(a.pid, Position.x[p], Position.y[p]), w.step(40);
    expect((cargoOf(a).iron_ore ?? 0) + (cargoOf(a).nickel_ore ?? 0)).toBeGreaterThan(0);
    // the pilot who broke it can no longer hurt it or collect from it again
    w.tut.hit(rock, a.pid, 600);
    expect(events.filter(([, e]) => e.kind === 'objectBroken').length).toBe(1);
    // and the state they are sent lists it as broken, B's does not
    w.server.flushLazy();
    const stateOf = (p: typeof a) => p.got.filter((m) => m.type === 'tutorialState').pop() as Extract<ServerMessage, { type: 'tutorialState' }>;
    expect(stateOf(a).broken).toEqual(['training_rock']);
    expect(stateOf(b).broken).toEqual([]);
  });

  it('an object of a step a pilot has done is inert for them and live for another', () => {
    const w = yard();
    const [a, b] = w.pilots;
    a.profile().tutorial.done.push('drones');
    const d1 = w.eid('drone_1');
    expect(w.tut.hit(d1, a.pid, 100)).toBe(true);
    expect(w.tut.hit(d1, b.pid, 100)).toBe(true);
    expect(a.profile().tutorial.hits?.drone_1).toBeUndefined();
    expect(b.profile().tutorial.hits?.drone_1).toBe(100);
    const events: TutorialEvent[] = [];
    w.tut.subscribe((_c, ev) => events.push(ev));
    w.tut.hit(d1, a.pid, 10_000);
    expect(events).toEqual([]);
    w.tut.hit(d1, b.pid, 10_000);
    expect(events).toEqual([{ kind: 'objectBroken', object: 'drone_1', step: 'drones' }]);
    // nobody else (no pilot) hurts a training body either
    expect(w.tut.hit(d1, 424242, 1000)).toBe(true);
  });

  it('skipping at a middle step grants the pack, moves the pilot to Sol, and the yard stays shut', () => {
    const w = yard();
    const [a, b] = w.pilots;
    const p = a.profile();
    p.tutorial.step = 'drones';
    p.tutorial.done.push('welcome', 'rings', 'brake');
    const storage0 = Object.fromEntries(p.storage.map((s) => [s.id, s.n]));
    const credits0 = p.credits;
    a.t.send({ type: 'tutorialLeave' } as never);
    w.step(2);
    expect(p.tutorial).toEqual({ step: '', done: ['welcome', 'rings', 'brake'], left: true });
    const pack = w.data.starterPack;
    const storage1 = Object.fromEntries(p.storage.map((s) => [s.id, s.n]));
    for (const [k, n] of Object.entries(pack.items)) expect(storage1[k] ?? 0).toBe((storage0[k] ?? 0) + n);
    expect(p.credits).toBe(credits0 + pack.credits);
    expect(p.home).toBe('sol_station_central');
    expect(w.dist(a.pid)).toBeGreaterThan(20000);
    const state = a.got.filter((m) => m.type === 'tutorialState').pop() as Extract<ServerMessage, { type: 'tutorialState' }>;
    expect(state).toMatchObject({ step: '', left: true });
    // B, still in training, is untouched
    expect(b.profile().tutorial.left).toBe(false);
    expect(w.dist(b.pid)).toBeLessThan(w.data.yard.leash);
    // A flies back to the yard: turned away
    w.put(a.pid, w.center.x + 1500, w.center.y);
    w.step(3);
    expect(w.dist(a.pid)).toBeGreaterThan(w.data.yard.keepOut);
    // a second leave does nothing (no second pack)
    a.t.send({ type: 'tutorialLeave' } as never);
    w.step(2);
    expect(p.credits).toBe(credits0 + pack.credits);
    // a left pilot respawns in Sol, never in the yard
    expect(w.tut.spawnFor(a.conn, false)).toBeNull();
    expect(w.tut.spawnFor(b.conn, false)).not.toBeNull();
  });

  it('an admin /tutorial reset and /tutorial step put a left pilot back in the yard; a non-admin cannot', () => {
    const w = yard(['ann', 'bo']);
    const [a, b] = w.pilots;
    a.t.send({ type: 'tutorialLeave' } as never);
    b.t.send({ type: 'tutorialLeave' } as never);
    w.step(2);
    expect(w.dist(a.pid)).toBeGreaterThan(20000);
    (a.conn as unknown as { isAdmin: boolean }).isAdmin = true;
    a.t.send({ type: 'chat', text: '/tutorial reset' } as never);
    w.step(2);
    expect(a.profile().tutorial).toMatchObject({ step: 'welcome', done: [], left: false });
    expect(w.dist(a.pid)).toBeLessThan(w.data.yard.spawnRadius + 50);
    const state = a.got.filter((m) => m.type === 'tutorialState').pop() as Extract<ServerMessage, { type: 'tutorialState' }>;
    expect(state).toMatchObject({ step: 'welcome', left: false });
    a.t.send({ type: 'chat', text: '/tutorial step power' } as never);
    w.step(2);
    const ids = w.data.steps.map((s) => s.id);
    expect(a.profile().tutorial).toMatchObject({ step: 'power', done: ids.slice(0, ids.indexOf('power')), left: false });
    // (the step's grant, the Cell Reactor, came with it)
    expect(a.profile().storage.some((s) => s.id === 'part:alloy:power_cell_reactor:sq')).toBe(true);
    b.t.send({ type: 'chat', text: '/tutorial reset' } as never);
    w.step(2);
    expect(b.profile().tutorial.left).toBe(true);
  });

  it('a pilot who has left is not hurt by, and does not hurt, training bodies', () => {
    const w = yard();
    const a = w.pilots[0];
    w.tut.leave(a.conn);
    expect(w.tut.hit(w.eid('drone_2'), a.pid, 500)).toBe(true);
    expect(a.profile().tutorial.hits).toBeUndefined();
  });

  it('existing profiles are marked left; a fresh one is not', async () => {
    const { migrateProfile, newProfile, starterKit } = await import('@space-game/common');
    const kit = starterKit(server_bp());
    const fresh = newProfile(kit);
    expect(fresh.tutorial.left).toBe(false);
    const saved = JSON.parse(JSON.stringify(fresh));
    delete saved.tutorial;
    expect(migrateProfile(saved, kit).tutorial).toEqual({ step: '', done: [], left: true });
    saved.tutorial = { step: 'rings', done: ['welcome'], left: false, hits: { drone_1: 40, junk: 'x' } };
    expect(migrateProfile(saved, kit).tutorial).toEqual({ step: 'rings', done: ['welcome'], left: false, hits: { drone_1: 40 } });
    saved.tutorial = 'junk';
    expect(migrateProfile(saved, kit).tutorial.left).toBe(true);
  });

  it('the yard stays put: bodies, station and hp unchanged over 600 ticks', () => {
    const w = yard(['ann']);
    const ids = ['ring_1', 'drone_1', 'drone_2', 'drone_3', 'training_rock'].filter((id) => w.tut.entityOf(id) !== undefined).map((id) => w.eid(id));
    expect(ids.length).toBe(4);
    const snap = () => ids.map((e) => [Position.x[e], Position.y[e], Asteroid.hp[e]]);
    const before = snap();
    for (const e of ids) w.server.placeAsteroid(e);
    const station = (w.server as never as { gameData: GameData }).gameData.getStation('sol_station_yard')!;
    w.step(600);
    for (const e of ids) w.server.placeAsteroid(e);
    expect(snap()).toEqual(before);
    for (const id of ['drone_1', 'training_rock']) {
      const o = w.tut.def(id)!, at = objectPos(w.data, o);
      expect(Math.hypot(Position.x[w.eid(id)] - at.x, Position.y[w.eid(id)] - at.y)).toBeLessThan(0.05);
    }
    expect(station.position).toEqual(w.center);
  });

  it('sees rings passed once, a stop in the zone, and a ring of a done step not at all', () => {
    const w = yard(['ann']);
    const a = w.pilots[0];
    const events: TutorialEvent[] = [];
    w.tut.subscribe((_c, ev) => events.push(ev));
    const ring = objectPos(w.data, w.tut.def('ring_2')!);
    w.put(a.pid, ring.x, ring.y);
    w.step(3);
    w.step(3);
    expect(events.filter((e) => e.kind === 'ringPassed')).toEqual([{ kind: 'ringPassed', ring: 'ring_2', step: 'rings' }]);
    const zone = objectPos(w.data, w.tut.def('stop_zone')!);
    w.put(a.pid, zone.x, zone.y);
    w.step(w.data.yard.stopTicks + 5);
    expect(events.filter((e) => e.kind === 'zoneStopped')).toEqual([{ kind: 'zoneStopped', zone: 'stop_zone', step: 'brake' }]);
    a.profile().tutorial.done.push('rings');
    events.length = 0;
    const r1 = objectPos(w.data, w.tut.def('ring_1')!);
    w.put(a.pid, r1.x, r1.y);
    w.step(3);
    expect(events.filter((e) => e.kind === 'ringPassed')).toEqual([]);
  });

  it('docking at the yard station is reported', () => {
    const w = yard(['ann']);
    const a = w.pilots[0];
    const events: TutorialEvent[] = [];
    w.tut.subscribe((_c, ev) => events.push(ev));
    w.put(a.pid, w.center.x + 700, w.center.y);
    w.step(2);
    a.t.send({ type: 'dock' } as never);
    w.step(2);
    expect(events).toContainEqual({ kind: 'docked', station: 'sol_station_yard' });
  });

  it('the welcome card advances on an acknowledgement for the current step only', () => {
    const w = yard(['ann']);
    const a = w.pilots[0];
    a.t.send({ type: 'tutorialReport', kind: 'ack', step: 'rings' } as never);
    w.step(1);
    expect(a.profile().tutorial.step).toBe('welcome');
    a.t.send({ type: 'tutorialReport', kind: 'ack', step: 'welcome' } as never);
    w.step(1);
    expect(a.profile().tutorial).toMatchObject({ step: 'rings', done: ['welcome'] });
    // entering a step zeroes the counters on its objects
    a.profile().tutorial.hits = { drone_1: 90 };
    w.tut.completeStep(a.conn, 'rings');
    w.tut.completeStep(a.conn, 'brake');
    expect(a.profile().tutorial.step).toBe('drones');
    expect(a.profile().tutorial.hits).toBeUndefined();
  });
});

function server_bp() {
  return createShipBridge(shipConfig).playerBlueprint;
}
