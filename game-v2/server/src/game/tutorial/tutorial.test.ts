/**
 * The training yard's foundation: per-pilot damage counters, owner-only drops, done-step objects inert for that pilot
 * only, skipping at any step, the one-way exit, stationary bodies, and marker events (docs: common/src/tutorial/README.md)
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Asteroid, InSystem, Projectile, Dead, ServerMessage, TutorialEvent, objectPos, planetPosition } from '@space-game/common';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../ships/createShipBridge.js';
import { makeServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const shipConfig = loadShipConfigCached(dataDir);

function yard(names = ['ann', 'bo'], tutorial = true) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = makeServer({
    gameData: new GameData(files), tutorial, ships: createShipBridge(shipConfig),
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
  it('a new trainee starts with empty storage (the starter pack comes on leaving); a server without the yard keeps the usual kit', () => {
    const w = yard(['ann']);
    expect(w.pilots[0].profile().storage).toEqual([]);
    const plain = yard(['bo'], false);
    expect(plain.pilots[0].profile().storage.length).toBeGreaterThan(0);
  });

  it('a trainee who dies comes back in the yard, at the same step', async () => {
    const w = yard(['ann']);
    const a = w.pilots[0];
    w.tut.completeStep(a.conn, 'welcome');
    w.put(a.pid, w.center.x - 5000, w.center.y);
    bitecs.addComponent(w.server.world, Dead, a.pid);
    a.t.send({ type: 'respawn' } as never);
    await new Promise((r) => setTimeout(r, 0));
    w.step(2);
    // (a new ship: the connection's entity)
    const now = a.conn.playerId;
    expect(now).not.toBe(a.pid);
    expect(InSystem.systemId[now]).toBe(w.server.gameData.getSystemNum('vesta_yard'));
    expect(w.dist(now)).toBeLessThan(w.data.yard.spawnRadius + 50);
    expect(a.profile().tutorial.step).toBe('rings');
  });

  it('puts new pilots in the Vesta yard system, and tells each its state', () => {
    const w = yard();
    expect(w.data.yard.system).toBe('vesta_yard');
    for (const p of w.pilots) {
      expect(InSystem.systemId[p.pid]).toBe(w.server.gameData.getSystemNum('vesta_yard'));
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
    expect(InSystem.systemId[w.pilots[0].pid]).toBe(w.server.gameData.getSystemNum('sol'));
  });

  it("the yard is its own system: Vesta large, the station fixed above it, nothing of Sol in it, not on the map", () => {
    const w = yard(['ann']);
    const gd = w.server.gameData;
    const sys = gd.getSystem('vesta_yard')!;
    expect(gd.getSystem('sol')!.stations).not.toContain('sol_station_yard');
    expect(sys).toMatchObject({ tutorial: true, stations: ['sol_station_yard'], portals: [], danger: 1, centralBody: { type: 'none' } });
    expect(sys.surface).toBeUndefined();
    expect(sys.planets).toHaveLength(1);
    expect(sys.planets![0]).toMatchObject({ id: 'vesta', kind: 'rocky', orbit: { period: 0 } });
    expect(sys.planets![0].radius).toBeGreaterThan(gd.getSystem('sol')!.planets!.find((q) => q.id === 'vesta')!.radius * 3);
    expect(sys.regions?.[0]?.danger).toBe('safe');
    expect([sys.derelicts, sys.nests, sys.traffic, sys.structures, sys.rifts].every((l) => !l?.length)).toBe(true);
    // the station does not orbit: a fixed spot just off the planet's limb
    const st = gd.getStation('sol_station_yard')!;
    expect(st.system).toBe('vesta_yard');
    expect(st.orbit).toBeUndefined();
    const planet = sys.planets![0], at = planetPosition(planet, 0);
    const gap = Math.hypot(st.position.x - at.x, st.position.y - at.y) - planet.radius - st.radius;
    expect(gap).toBeGreaterThan(300);
    expect(gap).toBeLessThan(3000);
    // every training object clears the planet and sits well inside the leash
    for (const o of w.data.objects) {
      const p = objectPos(w.data, o);
      expect(Math.hypot(p.x - at.x, p.y - at.y)).toBeGreaterThan(planet.radius + o.radius);
      expect(Math.hypot(p.x - w.center.x, p.y - w.center.y)).toBeLessThan(w.data.yard.leash / 2);
    }
    // the exit marker is far enough to want the jump drive, near enough to find with a little zooming out
    const exit = objectPos(w.data, w.tut.def('exit_marker')!);
    expect(Math.hypot(exit.x - w.center.x, exit.y - w.center.y)).toBeGreaterThan(1500);
    expect(Math.hypot(exit.x - w.center.x, exit.y - w.center.y)).toBeLessThan(4500);
    // the rocks and drones are all in the yard system, none in Sol
    const solNum = gd.getSystemNum('sol'), yardNum = gd.getSystemNum('vesta_yard');
    for (const id of ['drone_1', 'drone_2', 'drone_3']) expect(InSystem.systemId[w.eid(id)]).toBe(yardNum);
    const solIds = (w.server as never as { asteroidIdsBySystem: Map<number, number[]> }).asteroidIdsBySystem.get(solNum) ?? [];
    for (const id of ['drone_1']) expect(solIds).not.toContain(w.eid(id));
  });

  it('leaving lands in Sol at its usual start, and X near Vesta in Sol leads nowhere', () => {
    const w = yard();
    const [a] = w.pilots;
    const gd = w.server.gameData;
    a.t.send({ type: 'tutorialLeave' } as never);
    w.step(3);
    expect(InSystem.systemId[a.pid]).toBe(gd.getSystemNum('sol'));
    // no way down to the yard from Vesta's orbit in Sol (it is not a surface): X does nothing there
    const sol = gd.getSystem('sol')!;
    const vp = planetPosition(sol.planets!.find((q) => q.id === 'vesta')!, w.server.currentTick);
    expect(w.server.surfaces.surfaceNear(sol, vp.x + 1000, vp.y, w.server.currentTick)).toBeNull();
    expect(w.server.surfaces.descend(a.conn as never, sol, vp.x + 1000, vp.y)).toBe(false);
  });

  it("a trainee at the yard's edge is stopped inside and asked to leave; nothing takes them out by itself", () => {
    const w = yard();
    const [a] = w.pilots;
    const y = w.data.yard, yardNum = w.server.gameData.getSystemNum('vesta_yard');
    expect(y.leash).toBeGreaterThan(15000);
    a.got.length = 0;
    w.put(a.pid, w.center.x - y.leash - 800, w.center.y);
    w.step(3);
    expect(InSystem.systemId[a.pid]).toBe(yardNum);
    expect(w.dist(a.pid)).toBeLessThan(y.leash);
    expect(a.profile().tutorial.left).toBe(false);
    expect(a.got.filter((m) => m.type === 'tutorialEdge')).toHaveLength(1);
    expect(a.got.some((m) => m.type === 'toast' && /Leave training/.test((m as { text?: string }).text ?? ''))).toBe(true);
    // pushing out again soon after: held again, but the prompt waits its turn
    w.put(a.pid, w.center.x, w.center.y - y.leash - 800);
    w.step(3);
    expect(w.dist(a.pid)).toBeLessThan(y.leash);
    expect(a.got.filter((m) => m.type === 'tutorialEdge')).toHaveLength(1);
    expect(InSystem.systemId[a.pid]).toBe(yardNum);
    // answering Leave is the ordinary leave
    a.t.send({ type: 'tutorialLeave' } as never);
    w.step(3);
    expect(a.profile().tutorial.left).toBe(true);
    expect(InSystem.systemId[a.pid]).toBe(w.server.gameData.getSystemNum('sol'));
  });

  it('two pilots hitting one drone keep their own counters; the shared drone never changes', () => {
    const w = yard();
    const [a, b] = w.pilots;
    for (const p of [a, b]) { p.profile().tutorial.step = 'drones'; p.profile().tutorial.done = ['welcome', 'rings', 'brake']; }
    const d = w.eid('drone_1');
    const hp0 = Asteroid.hp[d], x0 = Position.x[d], y0 = Position.y[d];
    expect(w.tut.hit(d, a.pid, 100)).toBe(true);
    expect(w.tut.hit(d, b.pid, 50)).toBe(true);
    expect(a.profile().tutorial.hits?.drone_1).toBe(100);
    expect(b.profile().tutorial.hits?.drone_1).toBe(50);
    expect(w.tut.hit(d, a.pid, 10_000)).toBe(true);
    expect(a.profile().tutorial.hits?.drone_1).toBe(160);
    expect(b.profile().tutorial.hits?.drone_1).toBe(50);
    expect(Asteroid.hp[d]).toBe(hp0);
    expect(Position.x[d]).toBe(x0);
    expect(Position.y[d]).toBe(y0);
    // a body that is not a training one is not claimed
    expect(w.tut.hit(999_999, a.pid, 5)).toBe(false);
  });

  it('a real shell striking a drone is counted for its owner and breaks nothing; a drone of a later step counts nothing', () => {
    const w = yard();
    const [a, b] = w.pilots;
    a.profile().tutorial.step = 'drones';
    a.profile().tutorial.done = ['welcome', 'rings', 'brake'];
    const d = w.eid('drone_1');
    const world = w.server.world;
    const shell = () => {
      const e = bitecs.addEntity(world);
      bitecs.addComponent(world, Projectile, e);
      bitecs.addComponent(world, InSystem, e);
      InSystem.systemId[e] = InSystem.systemId[d];
      Projectile.miningYield[e] = 1;
      return e;
    };
    const s1 = shell();
    w.server.hurtAsteroid(s1, d, a.pid, 700, Position.x[d], Position.y[d]);
    expect(bitecs.hasComponent(world, Dead, s1)).toBe(true);
    expect(bitecs.hasComponent(world, Dead, d)).toBe(false);
    expect(Asteroid.hp[d]).toBeGreaterThan(900_000);
    expect(a.profile().tutorial.hits?.drone_1).toBe(160);
    expect(b.profile().tutorial.hits).toBeUndefined();
    // B is still at the first step: the drone is hidden from them, and their shell counts nothing
    w.server.hurtAsteroid(shell(), d, b.pid, 50, Position.x[d], Position.y[d]);
    expect(b.profile().tutorial.hits).toBeUndefined();
  });

  it('breaking a drone is the breaking pilot alone: an event for them, listed in their state only', () => {
    const w = yard();
    const [a, b] = w.pilots;
    for (const p of [a, b]) { p.profile().tutorial.step = 'drones'; p.profile().tutorial.done = ['welcome', 'rings', 'brake']; }
    const events: [number, TutorialEvent][] = [];
    w.tut.subscribe((c, ev) => events.push([c.playerId, ev]));
    const d = w.eid('drone_1');
    w.tut.hit(d, a.pid, 160);
    expect(events).toEqual([[a.pid, { kind: 'objectBroken', object: 'drone_1', step: 'drones' }]]);
    // it cannot be broken twice by the same pilot
    w.tut.hit(d, a.pid, 160);
    expect(events.length).toBe(1);
    w.server.flushLazy();
    const stateOf = (p: typeof a) => p.got.filter((m) => m.type === 'tutorialState').pop() as Extract<ServerMessage, { type: 'tutorialState' }>;
    expect(stateOf(a).broken).toEqual(['drone_1']);
    expect(stateOf(b).broken).toEqual([]);
  });

  it('the yard has an ordinary belt around Vesta, clear of the course and the station, of low-grade ore', () => {
    const w = yard();
    const gd = w.server.gameData;
    const sys = gd.getSystem('vesta_yard')!;
    const ring = sys.asteroidBelt.extra![0];
    expect(ring.count).toBeGreaterThanOrEqual(20);
    expect(ring.at!.length).toBe(ring.count);
    const vesta = planetPosition(sys.planets![0], 0), vr = sys.planets![0].radius;
    const clear = [...w.data.objects.map((o) => objectPos(w.data, o)), w.center];
    for (const [x, y] of ring.at!) {
      expect(Math.hypot(x - vesta.x, y - vesta.y)).toBeGreaterThan(vr + 500);
      for (const c of clear) expect(Math.hypot(x - c.x, y - c.y)).toBeGreaterThan(2000);
    }
    // real asteroid entities of the shared sim, made of the yard's own field
    const yardNum = gd.getSystemNum('vesta_yard');
    const belt = (w.server as never as { asteroidIdsBySystem: Map<number, number[]> }).asteroidIdsBySystem.get(yardNum)!.filter((e) => !w.tut.isBody(e));
    expect(belt.length).toBe(ring.count);
    for (const e of belt) expect(InSystem.systemId[e]).toBe(yardNum);
    expect(sys.asteroidField).toBe('yard_belt');
  });

  it('an object of a step a pilot has done is inert for them and live for another', () => {
    const w = yard();
    const [a, b] = w.pilots;
    a.profile().tutorial.done.push('drones');
    b.profile().tutorial.step = 'drones';
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
    expect(InSystem.systemId[a.pid]).toBe(w.server.gameData.getSystemNum('sol'));
    const state = a.got.filter((m) => m.type === 'tutorialState').pop() as Extract<ServerMessage, { type: 'tutorialState' }>;
    expect(state).toMatchObject({ step: '', left: true });
    // B, still in training, is untouched
    expect(b.profile().tutorial.left).toBe(false);
    expect(w.dist(b.pid)).toBeLessThan(w.data.yard.leash);
    // A is put back in the yard (an admin teleport, say): turned away to Sol
    w.server.travelTo(a.conn, w.server.gameData.getSystemNum('vesta_yard'), w.center.x + 1500, w.center.y, false);
    w.step(3);
    expect(InSystem.systemId[a.pid]).toBe(w.server.gameData.getSystemNum('sol'));
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

  it('existing profiles are marked left (and unseen, so the yard takes them as returners); a fresh one is not', async () => {
    const { migrateProfile, newProfile, starterKit } = await import('@space-game/common');
    const kit = starterKit(server_bp());
    const fresh = newProfile(kit);
    expect(fresh.tutorial.left).toBe(false);
    const saved = JSON.parse(JSON.stringify(fresh));
    delete saved.tutorial;
    expect(migrateProfile(saved, kit).tutorial).toEqual({ step: '', done: [], left: true, unseen: true });
    saved.tutorial = { step: 'rings', done: ['welcome'], left: false, hits: { drone_1: 40, junk: 'x' } };
    expect(migrateProfile(saved, kit).tutorial).toEqual({ step: 'rings', done: ['welcome'], left: false, hits: { drone_1: 40 } });
    saved.tutorial = 'junk';
    expect(migrateProfile(saved, kit).tutorial.left).toBe(true);
  });

  it('the yard stays put: bodies, station and hp unchanged over 600 ticks', () => {
    const w = yard(['ann']);
    const ids = ['ring_1', 'drone_1', 'drone_2', 'drone_3'].filter((id) => w.tut.entityOf(id) !== undefined).map((id) => w.eid(id));
    expect(ids.length).toBe(3);
    const snap = () => ids.map((e) => [Position.x[e], Position.y[e], Asteroid.hp[e]]);
    const before = snap();
    for (const e of ids) w.server.placeAsteroid(e);
    const station = (w.server as never as { gameData: GameData }).gameData.getStation('sol_station_yard')!;
    w.step(600);
    for (const e of ids) w.server.placeAsteroid(e);
    expect(snap()).toEqual(before);
    for (const id of ['drone_1']) {
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
