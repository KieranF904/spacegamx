/**
 * Decision inputs (CAPS.BODIES; common bodies/, client ships/bodies/BodyRunner.ts, docs/design/decision-inputs.md):
 * the Scrap Mother's brain decides on the server, her body flies her on both sides. A capable client's tick-aligned
 * replica of her is the server's ship bit for bit at every snapshot's tick through her three stages, with no control
 * rows of her and keyframes only where her body doesn't model what moved her (a stage shed, a contact); a legacy
 * observer gets her the old way, unchanged; a decision the client lost is caught by its check and put right.
 *
 * A real GameServer; the pilot (a fake client with every cap) flies by input messages, on time, firing at her.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, CAPS, DECISION, encodeMessage, decodeMessage, controlRowId, datan2,
  type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import type { StagedBrain } from '../../game/brains/staged.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const ALL = CAPS.HITS | CAPS.SELF_HITS | CAPS.PACKED | CAPS.COALESCE | CAPS.OWN_SHOTS | CAPS.ROUGH | CAPS.OWN_SIM | CAPS.INPUTS | CAPS.BODIES;

interface Got { snapshots: number; checked: number; off: number; keyframes: number; ctlRows: number; decisions: number; syncs: number; running: number; ctlWhileOff: number }
const zero = (): Got => ({ snapshots: 0, checked: 0, off: 0, keyframes: 0, ctlRows: 0, decisions: 0, syncs: 0, running: 0, ctlWhileOff: 0 });

interface Opts {
  ticks?: number;
  /** Stages forced on (the dev shed) at these ticks: each moves her fight on to her next stage */
  stagesAt?: number[];
  /** The client loses this snapshot's decisions (the forced miss) */
  dropAt?: number;
  /** A second capable client joins at this tick (arriving mid-fight) */
  lateAt?: number;
  /** The capable client's caps switched off CAPS.BODIES at this tick, and back on at `capsOnAt` (the admin's switch) */
  capsOffAt?: number;
  capsOnAt?: number;
  /** She's taken away at this tick (Bosses.remove: her arena emptied) */
  removeAt?: number;
}

function fight(o: Opts = {}) {
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
  const A = new FakeHitsClient(server, { name: 'bodies_a', caps: ALL, env });
  const B = new FakeHitsClient(server, { name: 'legacy_b', caps: 0, env });
  let C: FakeHitsClient | null = null;
  let boss = -1;
  /** The boss's real state at each tick's end */
  const truth = new Map<number, number[]>();
  const got = { A: zero(), B: zero(), C: zero() };
  const now = () => (ships.has(boss) ? [Position.x[boss], Position.y[boss], Velocity.x[boss], Velocity.y[boss], Rotation.angle[boss], ships.get(boss)!.angVel] : undefined);
  const watch = (f: FakeHitsClient, g: Got, drop?: () => boolean) => {
    const fa = f as unknown as { snapshot(s: ServerSnapshotMessage): void };
    const orig = fa.snapshot.bind(f);
    fa.snapshot = (s) => {
      if (drop?.() && s.decisions?.some((d) => d[0] === boss && d[2] !== DECISION.SYNC)) s = { ...s, decisions: s.decisions.filter((d) => d[0] !== boss || d[2] === DECISION.SYNC) };
      orig(s);
      g.snapshots++;
      if (s.ships?.some((k) => k[0] === boss)) g.keyframes++;
      if (s.ctl?.some((r) => controlRowId(r) === boss)) { g.ctlRows++; if (capsOff) g.ctlWhileOff++; }
      for (const d of s.decisions ?? []) if (d[0] === boss) { g.decisions++; if (d[2] === DECISION.SYNC) g.syncs++; }
      if (!f.bodies || ![...f.bodies.ids()].includes(boss)) return;
      g.running++;
      // (a frame that goes as the tick ends: the boss as it is now)
      const st = f.reps.at(boss, s.tick)?.body, r = truth.get(s.tick) ?? (s.tick === server.getTick() ? now() : undefined);
      if (!st || !r) return;
      g.checked++;
      if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4] || st.angVel !== r[5]) g.off++;
    };
  };
  let dropped = false, capsOff = false;
  watch(A, got.A, () => { if (o.dropAt === undefined || dropped || server.getTick() < o.dropAt) return false; dropped = true; return true; });
  watch(B, got.B);
  let seq = 1;
  const send = (t: number) => {
    // Its controls for the next tick: it keeps its distance from her, its aim on her, firing
    const dx = boss >= 0 ? Position.x[boss] - Position.x[A.pid] : 1, dy = boss >= 0 ? Position.y[boss] - Position.y[A.pid] : 0, d = Math.hypot(dx, dy);
    const phase = Math.floor(t / 50) % 4;
    const bck = A.bodies?.takeCheck(true, server.getTick());
    const msg = {
      type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1,
      forward: d > 1900 ? dy < -0.38 * d : phase === 0, backward: d > 1900 ? dy > 0.38 * d : phase === 2,
      left: d > 1900 ? dx < -0.38 * d : phase === 1, right: d > 1900 ? dx > 0.38 * d : phase === 3, boost: false,
      fireLeft: t >= 0 && t % 40 < 25, fireRight: false, targetAngle: datan2(dy, dx), cursorDist: Math.min(2000, d),
      ...(chk ? { ownCheck: chk } : {}), ...(bck ? { bodyCheck: bck } : {}),
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
    const r = now();
    if (r) truth.set(server.getTick(), r);
    clock.t += 1000 / 60;
    chk = A.own?.takeCheck(true, server.getTick());
    const rep = A.selfHits?.takeReport(true);
    if (rep) server.hits.report(server.pilots.connOf(A.pid)! as never, rep);
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
    B.flushUp();
    C?.flushUp();
  };
  for (let i = 0; i < 20; i++) step(-1);
  const god = (f: FakeHitsClient) => { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); c.isAdmin = false; };
  for (const f of [A, B]) god(f);
  const num = InSystem.systemId[A.pid];
  ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
  Position.x[B.pid] = x0 - 300; Position.y[B.pid] = y0 + 1400;
  boss = server.bosses.spawnAt('boss_scrap_mother', num, x0 + 1800, y0);
  const brain = server.bosses.brainOf(boss) as unknown as StagedBrain & { stage: number };
  const stages = [...(o.stagesAt ?? [])];
  for (let t = 0; t < (o.ticks ?? 900); t++) {
    if (stages.length && t === stages[0]) {
      stages.shift();
      // (her fight moved on to her next stage at once: the dev shed, a step at a time until it's there)
      const st = brain.stage;
      for (let n = 1; n < 400 && brain.stage === st; n++) brain.forceShed(n);
    }
    if (o.capsOffAt === t) { server.pilots.connOf(A.pid)!.capsNext = ALL & ~CAPS.BODIES; capsOff = true; }
    if (o.capsOnAt === t) { server.pilots.connOf(A.pid)!.capsNext = ALL; capsOff = false; }
    if (o.removeAt === t) server.bosses.remove(boss);
    if (o.lateAt === t) {
      C = new FakeHitsClient(server, { name: 'bodies_c', caps: ALL, env });
      god(C);
      Position.x[C.pid] = x0 - 600; Position.y[C.pid] = y0 - 1200; Velocity.x[C.pid] = 0; Velocity.y[C.pid] = 0;
      watch(C, got.C);
    }
    step(t);
  }
  const tracked = (server.bodies as unknown as { bosses: Map<number, unknown> }).bosses.has(boss);
  return { server, boss, brain, got, A, tracked, stats: server.bodies.stats, rep: server.replication.bodyStats };
}

describe('decision inputs: the Scrap Mother flown by her body on both sides (CAPS.BODIES)', () => {
  it('through her three stages: the client\'s replica of her is the server\'s ship at every snapshot, no control rows of her, checks agreeing', () => {
    const r = fight({ ticks: 1500, stagesAt: [500, 1000] });
    if (process.env.BODY_DEBUG) console.log('BODIES', JSON.stringify({ got: r.got, stats: r.stats, rep: r.rep, runner: r.A.bodies?.stats }));
    expect(r.brain.stage).toBe(3);
    expect(r.got.A.running).toBeGreaterThan(300);
    expect(r.got.A.checked).toBeGreaterThan(300);
    expect(r.got.A.off).toBe(0);
    expect(r.got.A.ctlRows).toBe(0);
    expect(r.got.A.decisions).toBeGreaterThan(5);
    // (keyframes of her: the first, and only what her body doesn't model: the stage sheds)
    expect(r.got.A.keyframes).toBeLessThan(r.got.B.keyframes / 4);
    expect(r.stats.checks).toBeGreaterThan(10);
    expect(r.stats.off).toBe(0);
    expect(r.stats.agreed).toBe(r.stats.checks - r.stats.stale - r.stats.unknown);
    // The legacy observer: her the old way (rows and keyframes), no decisions
    expect(r.got.B.decisions).toBe(0);
    expect(r.got.B.running).toBe(0);
    expect(r.got.B.keyframes).toBeGreaterThan(50);
  }, 240_000);

  it('a decision lost: its check catches it, a SYNC and a keyframe put it right', () => {
    const r = fight({ ticks: 700, dropAt: 300 });
    expect(r.stats.off).toBeGreaterThan(0);
    expect(r.got.A.syncs).toBeGreaterThan(1);
    // (put right: off for a few snapshots between the loss and the fix, never after)
    expect(r.got.A.off).toBeGreaterThan(0);
    expect(r.got.A.off).toBeLessThan(40);
  }, 240_000);

  it('a client arriving mid-fight: synced at once, its replica of her exact from there', () => {
    const r = fight({ ticks: 900, lateAt: 450 });
    expect(r.got.C.syncs).toBeGreaterThan(0);
    expect(r.got.C.checked).toBeGreaterThan(100);
    expect(r.got.C.off).toBe(0);
    expect(r.got.C.ctlRows).toBe(0);
  }, 240_000);

  it('the cap switched off mid-fight: her rows the old way, no checks judged; back on: a SYNC, her replica exact again', () => {
    const r = fight({ ticks: 900, capsOffAt: 300, capsOnAt: 550 });
    const conn = r.server.pilots.connOf(r.A.pid)!;
    // (off: the client runs her no longer, nor does the server think it does: her rows came again)
    expect(r.got.A.ctlWhileOff).toBeGreaterThan(0);
    // (on again: synced afresh, her replica the server's ship from there, the checks agreeing)
    expect(r.got.A.syncs).toBeGreaterThan(1);
    expect(r.A.bodies!.on).toBe(true);
    expect([...r.A.bodies!.ids()]).toContain(r.boss);
    expect(r.server.bodies.runs(conn, r.boss)).toBe(true);
    expect(r.got.A.off).toBe(0);
    expect(r.stats.off).toBe(0);
    // (a reconnect: the client lets every body go, until the new connection SYNCs it, ShipClient.resetHits)
    r.A.bodies!.reset();
    expect([...r.A.bodies!.ids()]).toEqual([]);
  }, 240_000);

  it('taken away mid-fight: her decisions forgotten at once (her id may be another ship\'s later), the client stops her', () => {
    const r = fight({ ticks: 500, removeAt: 400 });
    expect(r.tracked).toBe(false);
    expect([...r.A.bodies!.ids()]).not.toContain(r.boss);
    expect(r.server.bodies.runs(r.server.pilots.connOf(r.A.pid)!, r.boss)).toBe(false);
  }, 240_000);
});
