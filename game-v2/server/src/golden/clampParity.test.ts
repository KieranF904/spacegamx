/**
 * Docking Clamps parity (docs/design/groups-mines-docking.md 3; common sim/clampPair.ts, ships/bridge/clamp.ts,
 * ships/features/clamp). Two pilots on a real GameServer (inputs through LocalTransport) lock their clamps, and the
 * pair is flown 600 scripted ticks of the steering pilot's inputs. Tick for tick it must be the same:
 *
 *   server          the real ships (the bridge's flight step, the pair's order and contacts)
 *   steering pilot  its own whole step (common sim/ownStep.ts stepOwnShip, what its client's OwnTick runs), flying the pair
 *   other pilot     its own whole step riding the leader as its client holds it (the leader's replica)
 *   third client    replicaStep from the leader's control bits and the link alone (no follower positions sent)
 *
 * Plus: the server's lined-up check refuses outside tolerance; the follower's shadow needs no keyframe while linked;
 * a swap keeps the pose; each break (undock, jump, death, gone, station, part) and the relock wait; weapons still fire
 * per owner while docked.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, Input, Health, InSystem, ReplicaMode, CTL, replicaStep, controlBits, buildFlightInputs, simAimQ, stepOwnShip, ownStructure,
  quantizeCursorAngle, dequantizeCursorAngle, replicaAngle, followerPose, clampOffset, ClampLinks, linksSource, CLAMP,
  type ServerMessage, type FlightBody, type OwnExtras, type SimEnv, type ReplicaEnv, type Blueprint, type ShipState, type ClientInputMessage,
} from '@space-game/common';
import { parseBlueprint } from '../../../common/src/ships/blueprint.js';
import { SHIP_DATA_DIR } from '../../../common/src/ships/testData.js';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import type { Clamps } from '../ships/features/clamp/Clamps.js';
import { stationQuery } from '../game/Docking.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const sparrow = readFileSync(join(SHIP_DATA_DIR, 'blueprints/fixtures/sparrow-t.json'), 'utf-8');
const UP = -1.5708;

/** A Sparrow T with a Docking Clamp on its right (E) or left (W) */
function clamped(side: 'E' | 'W'): Blueprint {
  const bp = parseBlueprint(sparrow);
  bp.parts.push({ uid: 60, piece: 'sq', fn: 'docking_clamp', material: 'alloy', x: side === 'E' ? 3 : -2, y: 0, rot: 0, flip: false, facing: side } as never);
  return bp;
}

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigCached(dataDir)),
    clock: () => 1_000_000,
  });
  const join = (name: string) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    return { t, got, id: t.getPlayerId() };
  };
  const a = join('Ash'), b = join('Bree'), c = join('Cole');
  const ships = server.getShips()!;
  ships.respawnInPlace(a.id, clamped('E'));
  ships.respawnInPlace(b.id, clamped('W'));
  const A = ships.get(a.id)!, B = ships.get(b.id)!;
  const ca = A.derived.fx!.clamp!.clamps[0], cb = B.derived.fx!.clamp!.clamps[0];
  const offset = clampOffset(ca, A.derived.com, cb, B.derived.com, ships.tuning.cellSize);
  const place = (eid: number, p: { x: number; y: number; vx?: number; vy?: number; angle: number }, ship: ShipState) => {
    Position.x[eid] = p.x; Position.y[eid] = p.y; Velocity.x[eid] = p.vx ?? 0; Velocity.y[eid] = p.vy ?? 0; Rotation.angle[eid] = p.angle; ship.angVel = 0;
  };
  /** Side by side in open space, clamps facing, `gap` apart along them and `side` across */
  const lineUp = (gap = 6, side = 0) => {
    place(a.id, { x: 40000, y: 40000, angle: UP }, A);
    const f = followerPose({ x: 40000, y: 40000, vx: 0, vy: 0, angle: UP, angVel: 0 }, offset);
    place(b.id, { x: f.x + gap, y: f.y + side, angle: f.angle }, B);
    place(c.id, { x: 41500, y: 40000, angle: UP }, ships.get(c.id)!);
    for (const id of [a.id, b.id, c.id]) { for (const k of ['forward', 'backward', 'left', 'right', 'boost', 'jump'] as const) Input[k][id] = 0; Input.targetAngle[id] = UP; }
  };
  const clamps = (server as any).features.get('clamp') as Clamps;
  const dock = () => {
    a.t.send({ type: 'clampDock', with: b.id, clamp: ca.uid, theirs: cb.uid } as any);
    server.step();
    b.t.send({ type: 'clampDock', with: a.id, clamp: cb.uid, theirs: ca.uid } as any);
    server.step();
  };
  return { server, a, b, c, ships, A, B, ca, cb, offset, lineUp, dock, clamps, tick: () => server.getTick() };
}

/** The scripted steering (0-based tick) */
function script(i: number) {
  const ph = Math.floor(i / 50) % 6;
  return {
    keys: { forward: ph === 0 || ph === 3 || ph === 5, backward: ph === 2, left: ph === 1 || ph === 5, right: ph === 4, boost: ph === 3 && i % 100 < 40 },
    aim: UP + Math.sin(i / 41) * 1.6,
  };
}
const input = (seq: number, keys: object, aim: number, fire = false, dist = 0): ClientInputMessage => ({
  type: 'input', seq, tick: 0, fireLeft: fire, fireRight: false, forward: false, backward: false, left: false, right: false, boost: false, ...keys,
  targetAngle: Math.fround(dequantizeCursorAngle(quantizeCursorAngle(aim))), cursorDist: dist,
} as ClientInputMessage);

const row = (b: FlightBody) => [b.x, b.y, b.vx, b.vy, b.angle, b.angVel];
const real = (id: number, s: ShipState): FlightBody => ({ x: Position.x[id], y: Position.y[id], vx: Velocity.x[id], vy: Velocity.y[id], angle: Rotation.angle[id], angVel: s.angVel, jump: s.jump, jumpScale: s.jumpScale, cargo: s.cargo, dodge: s.dodge, dodgeDir: s.dodgeDir });

describe('docking clamps on the server', () => {
  it('locks only lined up and when both press; the first to press steers; the other pilot is asked', () => {
    const w = world();
    w.lineUp(6, CLAMP.lateral + 4);
    w.dock();
    expect(w.clamps.linkOf(w.a.id)).toBeUndefined();
    w.lineUp(6, 0);
    for (let i = 0; i < 4; i++) w.server.step();
    w.dock();
    expect(w.b.got.some((m) => m.type === 'clampAsk' && m.from === w.a.id && m.what === 'dock')).toBe(true);
    const k = w.clamps.linkOf(w.a.id)!;
    expect(k.leader).toBe(w.a.id);
    expect(k.follower).toBe(w.b.id);
    // (Told to everyone in the system: the third pilot too)
    for (const p of [w.a, w.b, w.c]) expect(p.got.some((m) => m.type === 'clampLink' && m.leader === w.a.id && m.follower === w.b.id)).toBe(true);
  });

  it('flies alike on the server, the steering pilot, the other pilot and a third client for 600 ticks; no follower keyframes', () => {
    const w = world();
    w.lineUp();
    for (let i = 0; i < 4; i++) w.server.step();
    w.dock();
    const k = w.clamps.linkOf(w.a.id)!;
    expect(k).toBeDefined();
    // Recorded each tick: the server's bodies, the leader's flown control bits and aim, the pilots' extras
    let bits = 0, q = 0;
    const ctl = w.ships.replicaCtl, setCtl = ctl.set.bind(ctl);
    ctl.set = (id, v) => { if (id === w.a.id) { bits = v.bits; q = v.q; } return setCtl(id, v); };
    const renv: ReplicaEnv = (w.server as any).replicaEnv(InSystem.systemId[w.a.id]);
    const links = new ClampLinks();
    links.link({ leader: k.leader, follower: k.follower, lc: k.lc, fc: k.fc, offset: k.offset, tick: k.from });
    const derivedOf = (id: number) => w.ships.get(id)!.derived;
    // (Each end's leader by tick: the steering pilot's own, and the replica the others hold)
    const ownHist = new Map<number, { body: FlightBody; bits: number }>();
    const repHist = new Map<number, { body: FlightBody; bits: number }>();
    const ownSrc = linksSource(links, derivedOf, (id, t) => ownHist.get(t) ?? null);
    const repSrc = linksSource(links, derivedOf, (id, t) => repHist.get(t) ?? null);
    const simEnv = (t: number, clamp: typeof ownSrc): SimEnv => ({ tick: t, tuning: w.ships.tuning, gravity: renv.gravity, fields: { central: renv.central, lodestones: renv.lodestones ?? [] }, terrain: renv.terrain ?? null, hazard: renv.hazard, clamp });
    // Every end starts from the server's state as linked
    let lead = real(w.a.id, w.A), fol = real(w.b.id, w.B);
    let lx: OwnExtras = w.ships.ownExtras(w.a.id, w.tick())!, fx: OwnExtras = w.ships.ownExtras(w.b.id, w.tick())!;
    const rLead = { ...lead }, rFol = { ...fol };
    const shadows = (w.server as any).replication.shadows as Map<number, { version: number; cver: number; own?: { version: number } }>;
    const fv = () => { const s = shadows.get(w.b.id)!; return [s.version, s.cver, s.own?.version]; };
    let fv0: unknown = null;
    const folKeys = (from: number) => w.c.got.slice(from).filter((m) => m.type === 'snapshot').reduce((n, m: any) => n + (m.ships ?? []).filter((r: number[]) => r[0] === w.b.id).length, 0);
    let mark = 0, fired = 0, ownFired = 0;
    const push = w.ships.fired.push.bind(w.ships.fired);
    w.ships.fired.push = (...r) => { for (const f of r) if (f.owner === w.b.id) fired++; return push(...r); };
    for (let i = 0; i < 600; i++) {
      const s = script(i);
      w.a.t.send(input(i + 1, s.keys, s.aim));
      // (The other pilot's movement keys do nothing; it aims and fires its own guns)
      const aimB = Rotation.angle[w.b.id] + 0.05;
      w.b.t.send(input(i + 1, { backward: true, left: true }, aimB, i % 90 < 30, 600));
      w.server.step();
      const t = w.tick();
      const sLead = real(w.a.id, w.A), sFol = real(w.b.id, w.B);
      // The steering pilot: its own whole step, flying the pair
      const inA = input(i + 1, s.keys, s.aim);
      const sl = stepOwnShip(w.a.id, lx, lead, controlBits(buildFlightInputs(inA, false)), simAimQ(inA.targetAngle), { fire: false, fireAlt: false, jumpDist: 0, aimDist: 0 }, ownStructure(w.A.derived, w.A), simEnv(t, ownSrc), []);
      lx = { charge: sl.charge, guns: sl.guns, hazard: sl.hazard, jumpPrime: sl.jumpPrime };
      ownHist.set(t, { body: { ...lead }, bits: sl.ctl.bits });
      expect(row(lead), `steering pilot, tick ${i}`).toEqual(row(sLead));
      // A third client: the leader's replica from its control bits
      replicaStep(ReplicaMode.Player, rLead, { bits, targetAngle: replicaAngle(ReplicaMode.Player, q) }, w.A.derived, w.ships.tuning, { ...renv, clamp: repSrc }, t, w.a.id);
      repHist.set(t, { body: { ...rLead }, bits });
      expect(row(rLead), `leader's replica, tick ${i}`).toEqual(row(sLead));
      replicaStep(ReplicaMode.Player, rFol, { bits: CTL.hold, targetAngle: 0 }, w.B.derived, w.ships.tuning, { ...renv, clamp: repSrc }, t, w.b.id);
      expect(row(rFol), `follower's replica, tick ${i}`).toEqual(row(sFol));
      // The other pilot: its own whole step riding the leader's replica (its guns aim its own way)
      const inB = input(i + 1, { backward: true, left: true }, aimB, i % 90 < 30, 600);
      const evs: { k: string }[] = [];
      const sf = stepOwnShip(w.b.id, fx, fol, controlBits(buildFlightInputs(inB, false)), simAimQ(inB.targetAngle), { fire: !!inB.fireLeft, fireAlt: false, jumpDist: 600, aimDist: 600 }, ownStructure(w.B.derived, w.B), simEnv(t, repSrc), evs as never[]);
      ownFired += evs.filter((e) => e.k === 'fire').length;
      fx = { charge: sf.charge, guns: sf.guns, hazard: sf.hazard, jumpPrime: sf.jumpPrime };
      expect(row(fol), `other pilot, tick ${i}`).toEqual(row(sFol));
      // (Settled: the follower's shadows never need a keyframe while linked)
      if (i === 20) { fv0 = fv(); mark = w.c.got.length; }
      if (i > 20) expect(fv()).toEqual(fv0);
    }
    expect(folKeys(mark)).toBe(0);
    expect(Math.hypot(Position.x[w.a.id] - 40000, Position.y[w.a.id] - 40000)).toBeGreaterThan(500);
    // (Each pilot keeps its own guns: the other pilot fired while docked)
    expect(fired).toBeGreaterThan(5);
    expect(ownFired).toBe(fired);
  });

  it('the pair carries the follower\'s load: alike on the server, the steering pilot and a third client; a changed load is a fresh record', () => {
    const fly = (load: (i: number) => number) => {
      const w = world();
      // (The follower's hold, as the bridge asks it: Pilots.cargoMass)
      let held = load(-1);
      const pilots = (w.server as any).pilots, own = pilots.cargoMass.bind(pilots);
      pilots.cargoMass = (eid: number) => (eid === w.b.id ? held : own(eid));
      w.lineUp();
      for (let i = 0; i < 4; i++) w.server.step();
      w.dock();
      const k = w.clamps.linkOf(w.a.id)!;
      expect(k.fcargo).toBe(w.B.cargo ?? 0);
      let bits = 0, q = 0;
      const ctl = w.ships.replicaCtl, setCtl = ctl.set.bind(ctl);
      ctl.set = (id, v) => { if (id === w.a.id) { bits = v.bits; q = v.q; } return setCtl(id, v); };
      const renv: ReplicaEnv = (w.server as any).replicaEnv(InSystem.systemId[w.a.id]);
      // (The links as the steering pilot's client holds them: from its clampLink messages)
      const links = new ClampLinks();
      let seen = 0;
      const note = () => { for (; seen < w.a.got.length; seen++) { const m = w.a.got[seen] as any; if (m.type === 'clampLink') links.link({ tick: m.tick, leader: m.leader, follower: m.follower, lc: m.lc, fc: m.fc, offset: m.offset, fcargo: m.fcargo }); } };
      note();
      const derivedOf = (id: number) => w.ships.get(id)!.derived;
      const ownHist = new Map<number, { body: FlightBody; bits: number }>(), repHist = new Map<number, { body: FlightBody; bits: number }>();
      const ownSrc = linksSource(links, derivedOf, (id, t) => ownHist.get(t) ?? null);
      const repSrc = linksSource(links, derivedOf, (id, t) => repHist.get(t) ?? null);
      const simEnv = (t: number): SimEnv => ({ tick: t, tuning: w.ships.tuning, gravity: renv.gravity, fields: { central: renv.central, lodestones: renv.lodestones ?? [] }, terrain: renv.terrain ?? null, hazard: renv.hazard, clamp: ownSrc });
      const lead = real(w.a.id, w.A), rLead = { ...lead };
      let lx: OwnExtras = w.ships.ownExtras(w.a.id, w.tick())!;
      const start = { x: lead.x, y: lead.y };
      for (let i = 0; i < 160; i++) {
        held = load(i);
        const keys = { forward: true, left: i % 40 < 10 };
        w.a.t.send(input(i + 1, keys, UP));
        w.server.step();
        note();
        const t = w.tick(), sLead = real(w.a.id, w.A);
        const inA = input(i + 1, keys, UP);
        const sl = stepOwnShip(w.a.id, lx, lead, controlBits(buildFlightInputs(inA, false)), simAimQ(inA.targetAngle), { fire: false, fireAlt: false, jumpDist: 0, aimDist: 0 }, ownStructure(w.A.derived, w.A), simEnv(t), []);
        lx = { charge: sl.charge, guns: sl.guns, hazard: sl.hazard, jumpPrime: sl.jumpPrime };
        ownHist.set(t, { body: { ...lead }, bits: sl.ctl.bits });
        expect(row(lead), `steering pilot, tick ${i}`).toEqual(row(sLead));
        replicaStep(ReplicaMode.Player, rLead, { bits, targetAngle: replicaAngle(ReplicaMode.Player, q) }, w.A.derived, w.ships.tuning, { ...renv, clamp: repSrc }, t, w.a.id);
        repHist.set(t, { body: { ...rLead }, bits });
        expect(row(rLead), `leader's replica, tick ${i}`).toEqual(row(sLead));
      }
      expect(w.clamps.linkOf(w.a.id), 'still linked').toBeDefined();
      const loads = w.c.got.filter((m: any) => m.type === 'clampLink').map((m: any) => m.fcargo ?? 0);
      return { dist: Math.hypot(lead.x - start.x, lead.y - start.y), loads };
    };
    const light = fly(() => 0), heavy = fly((i) => (i < 80 ? 400 : 900));
    expect(light.loads).toEqual([0]);
    // (Locked with its load, then a fresh record when it grew)
    expect(heavy.loads.length).toBe(2);
    expect(heavy.loads[0]).toBeGreaterThan(0);
    expect(heavy.loads[1]).toBeGreaterThan(heavy.loads[0]);
    expect(heavy.dist).toBeLessThan(light.dist * 0.95);
  });

  it('a swap keeps the pose; undock pushes apart and the pair waits to relock', () => {
    const w = world();
    w.lineUp();
    for (let i = 0; i < 4; i++) w.server.step();
    w.dock();
    for (let i = 0; i < 30; i++) { w.a.t.send(input(i + 1, { forward: true }, UP)); w.server.step(); }
    const before = real(w.b.id, w.B);
    w.b.t.send({ type: 'clampSwap' } as any);
    w.server.step();
    expect(w.a.got.some((m) => m.type === 'clampAsk' && m.what === 'swap')).toBe(true);
    w.a.t.send({ type: 'clampSwap' } as any);
    w.server.step();
    w.server.step();
    const k = w.clamps.linkOf(w.a.id)!;
    expect(k.leader).toBe(w.b.id);
    const after = real(w.b.id, w.B);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(3 * Math.hypot(before.vx, before.vy) + 1);
    const p = followerPose(real(w.b.id, w.B), k.offset), fa = real(w.a.id, w.A);
    expect(Math.hypot(p.x - fa.x, p.y - fa.y)).toBeLessThan(0.02);
    // Undock (either alone): apart along the clamps' line
    const d0 = Math.hypot(Position.x[w.a.id] - Position.x[w.b.id], Position.y[w.a.id] - Position.y[w.b.id]);
    w.a.t.send({ type: 'clampUndock' } as any);
    for (let i = 0; i < 20; i++) w.server.step();
    expect(w.clamps.linkOf(w.a.id)).toBeUndefined();
    expect(w.b.got.some((m) => m.type === 'clampBreak' && m.why === 'undock' && !!m.push)).toBe(true);
    expect(Math.hypot(Position.x[w.a.id] - Position.x[w.b.id], Position.y[w.a.id] - Position.y[w.b.id])).toBeGreaterThan(d0 + 20);
    // (The same pair can't lock again at once)
    w.lineUp();
    w.dock();
    expect(w.clamps.linkOf(w.a.id)).toBeUndefined();
  });

  it('breaks: a jump key, a destroyed ship, a station berth, a clamp lost, a pilot gone', () => {
    const cases: [string, (w: ReturnType<typeof world>) => void][] = [
      // (Each through the game's own path: an input holding the jump key, health run out, a berth at a station)
      ['jump', (w) => { w.b.t.send(input(900, { jump: true }, UP)); }],
      ['death', (w) => { Health.current[w.a.id] = 0; }],
      ['station', (w) => {
        const s = (w.server as any), sys = InSystem.systemId[w.b.id];
        const st = stationQuery(s.world).find((e: number) => InSystem.systemId[e] === sys);
        expect(st, 'a station in the pair\'s system').toBeDefined();
        Position.x[st!] = Position.x[w.b.id]; Position.y[st!] = Position.y[w.b.id];
        const conn = [...s.clients.values()].find((c: any) => c.playerId === w.b.id);
        s.docking.handleDock(conn);
        expect(s.dockedShips.has(w.b.id), 'berthed').toBe(true);
      }],
      ['part', (w) => { const s = w.ships.get(w.a.id)!; const i = s.blueprint.parts.findIndex((p) => p.uid === w.ca.uid); w.ships.damagePartBy(w.a.id, i, 1e9, -1); }],
      ['gone', (w) => { w.b.t.disconnect(); }],
    ];
    for (const [why, act] of cases) {
      const w = world();
      w.lineUp();
      for (let i = 0; i < 4; i++) w.server.step();
      w.dock();
      expect(w.clamps.linkOf(w.a.id), why).toBeDefined();
      act(w);
      for (let i = 0; i < 3; i++) w.server.step();
      Input.jump[w.b.id] = 0;
      (w.server as any).dockedShips.delete(w.b.id);
      expect(w.clamps.linkOf(w.a.id), why).toBeUndefined();
      expect(w.a.got.filter((m) => m.type === 'clampBreak').map((m: any) => m.why), why).toEqual([why]);
    }
  });
});
