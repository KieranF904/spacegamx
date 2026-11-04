/**
 * A pilot's own ship stepped by its client (CAPS.OWN_SIM; common network/ownTick.ts, client ships/own/OwnTick.ts,
 * docs/design/confirmed-hits.md part G). The client flies its tick-aligned own ship from its own inputs at their target
 * ticks, and works out the causes the server tells it (pulls, contacts, rebuilds); it is sent no control rows or
 * keyframes of its own ship while that holds, and its check (a hash on its inputs) agrees every time.
 *
 * A real GameServer; the pilot (a fake client with OWN_SIM) flies by input messages, on time, a legacy observer watches.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, CAPS, encodeMessage, decodeMessage, ServerFrameReader, controlRowId,
  type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const ALL = CAPS.HITS | CAPS.SELF_HITS | CAPS.PACKED | CAPS.COALESCE | CAPS.OWN_SHOTS | CAPS.ROUGH | CAPS.OWN_SIM;

interface Opts {
  /** What else happens on a tick, before it (a dummy brought up against it, an EMP) */
  each?: (t: number, w: World) => void;
  /** A pull on its ship during the tick (as a boss's magnet pulls, in its brain's step after the pilots have moved) */
  pull?: (t: number) => [number, number] | null;
  /** The client drops the own-ship causes of this snapshot (the forced miss) */
  dropAt?: number;
  ticks?: number;
}
interface World { server: GameServer; A: FakeHitsClient; target: number; x0: number; y0: number }

function fly(o: Opts = {}) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
    netCaps: ALL,
  });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'own_sim', caps: ALL, env });
  const B = new FakeHitsClient(server, { name: 'legacy_obs', caps: 0, env });
  // What A was sent of its own ship, and its own layer against the server's ship at each snapshot's tick
  const got = { keyframes: 0, ctlRows: 0, causes: 0, snapshots: 0, off: 0, checked: 0 };
  const truth = new Map<number, number[]>();
  const fa = A as unknown as { snapshot(s: ServerSnapshotMessage): void };
  const oSnap = fa.snapshot.bind(A);
  fa.snapshot = (s) => {
    if (o.dropAt !== undefined && s.tick >= o.dropAt && s.own?.length && o.dropAt >= 0) { s = { ...s, own: undefined }; o.dropAt = -1; }
    oSnap(s);
    got.snapshots++;
    if (s.ships?.some((k) => k[0] === A.pid)) got.keyframes++;
    if (s.ctl?.some((r) => controlRowId(r) === A.pid)) got.ctlRows++;
    got.causes += s.own?.length ?? 0;
    const st = A.reps.at(A.pid, s.tick)?.body, r = truth.get(s.tick);
    if (A.own?.on && st && r) { got.checked++; if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4]) got.off++; }
  };
  void ServerFrameReader;
  let seq = 1;
  const send = (t: number) => {
    // Its controls for the next tick: thrust that changes now and then, the aim sweeping, firing
    const phase = Math.floor(t / 40) % 4;
    const msg = {
      type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1,
      forward: phase === 0, backward: phase === 2, left: phase === 1, right: phase === 3, boost: false,
      fireLeft: t % 50 < 30, fireRight: false, targetAngle: Math.sin(t / 30) * 1.2, cursorDist: 700,
      ...(chk ? { ownCheck: chk } : {}),
    } as unknown as ClientMessage;
    chk = undefined;
    const dec = decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientMessage;
    A.noteInput(dec);
    A.link!.receive(dec);
  };
  let chk: ReturnType<NonNullable<FakeHitsClient['own']>['takeCheck']>;
  const step = (t: number) => {
    send(t);
    server.step();
    truth.set(server.getTick(), [Position.x[A.pid], Position.y[A.pid], Velocity.x[A.pid], Velocity.y[A.pid], Rotation.angle[A.pid]]);
    clock.t += 1000 / 60;
    chk = A.own?.takeCheck(true, server.getTick());
    const rep = A.selfHits?.takeReport(true);
    if (rep) server.hits.report(server.pilots.connOf(A.pid)! as never, rep);
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
    B.flushUp();
  };
  for (let i = 0; i < 20; i++) step(-1);
  for (const f of [A, B]) { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); c.isAdmin = false; }
  const num = InSystem.systemId[A.pid];
  ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
  Position.x[B.pid] = x0 - 300; Position.y[B.pid] = y0 + 400;
  const target = ships.spawnDummy(ships.library.get('hauler')!, x0 + 700, y0, 0, num);
  const w: World = { server, A, target, x0, y0 };
  let now = -1;
  { const en = server.enemies as unknown as { tick(): void }, o0 = en.tick.bind(en); en.tick = () => { o0(); const p = o.pull?.(now); if (p) ships.push(A.pid, p[0], p[1]); }; }
  for (let t = 0; t < 40; t++) step(t);
  const at0 = { ...got }, own0 = { ...server.replication.ownStats }, chk0 = { ...server.ownChecks.stats };
  for (let t = 40; t < (o.ticks ?? 600); t++) { now = t; o.each?.(t, w); step(t); }
  const d = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(a).filter((k) => typeof a[k] === 'number').map((k) => [k, a[k] - (b[k] ?? 0)]));
  return { w, got: d(got, at0), own: d(server.replication.ownStats as never, own0 as never), checks: d(server.ownChecks.stats as never, chk0 as never), journal: server.hits.journalStats([server.pilots.connOf(A.pid)!]) };
}

describe('its own ship stepped by itself (CAPS.OWN_SIM)', () => {
  it('flown by its own inputs: no control rows or keyframes of its own ship, its layer the server\'s ship, its checks agreeing', () => {
    const r = fly();
    expect(r.got.snapshots).toBeGreaterThan(50);
    expect(r.got.keyframes).toBe(0);
    expect(r.got.ctlRows).toBe(0);
    expect(r.got.checked).toBeGreaterThan(40);
    expect(r.got.off).toBe(0);
    expect(r.checks.checks).toBeGreaterThan(5);
    expect(r.checks.agreed).toBe(r.checks.checks - r.checks.stale);
    expect(r.journal.disagreed).toBe(0);
  }, 120_000);

  it('pulled (TEMPORARY: a boss\'s magnet, sent as its push) and shoved by a ship it touches: causes, worked out exactly', () => {
    const r = fly({
      // A magnet's pull for a while
      pull: (t) => (t > 100 && t < 220 ? [0.031 * Math.sin(t / 9), -0.047] : null),
      each: (t, w) => {
        // A dummy brought right up against it (they touch, and push apart)
        if (t === 300) { Position.x[w.target] = Position.x[w.A.pid] + 40; Position.y[w.target] = Position.y[w.A.pid]; Velocity.x[w.target] = -2; }
      },
    });
    if (process.env.OWN_DEBUG) console.log('OWN', JSON.stringify({ got: r.got, own: r.own, checks: r.checks, client: r.w.A.own?.stats }));
    expect(r.own.pull).toBeGreaterThan(50);
    expect(r.own.contact).toBeGreaterThan(0);
    expect(r.got.causes).toBeGreaterThan(50);
    expect(r.got.off).toBe(0);
    expect(r.got.ctlRows).toBe(0);
    expect(r.checks.bodyOff).toBe(0);
    expect(r.journal.disagreed).toBe(0);
  }, 120_000);

  it('the engines crippled (an EMP): that window\'s real controls go, the layer stays exact', () => {
    const r = fly({ each: (t, w) => { if (t === 200) w.server.getShips().emp(w.A.pid, 90); } });
    expect(r.own.exc).toBeGreaterThan(0);
    expect(r.got.ctlRows).toBeGreaterThan(0);
    expect(r.got.off).toBe(0);
    expect(r.checks.bodyOff).toBe(0);
  }, 120_000);

  it('a cause it missed: its check catches it, a keyframe of its own ship puts it right, and it checks closely for a while', () => {
    const r = fly({ dropAt: 150, pull: (t) => (t > 100 && t < 200 ? [0.02, 0.03] : null) });
    expect(r.checks.bodyOff).toBeGreaterThan(0);
    expect(r.got.keyframes).toBeGreaterThan(0);
    expect(r.w.A.own!.stats.fixes).toBeGreaterThan(0);
    // (put right: the last snapshots' own layer is the server's again)
    expect(r.got.off).toBeLessThan(40);
  }, 120_000);
});
