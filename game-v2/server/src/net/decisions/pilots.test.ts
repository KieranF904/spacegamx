/**
 * The enemy AI's pilots as shared bodies (CAPS.PILOTS; common bodies/aiPilot.ts, server game/brains/aiPilot.ts,
 * docs/design/decision-inputs.md 6.5): Enemies' commander decides on the server (state, target, waypoint, strafe side,
 * aim error), the pilot flies each ship on both sides. A capable client's tick-aligned replica of every hostile it runs
 * is the server's ship bit for bit at every snapshot's tick (patrolling, closing in, strafing round it as a pack,
 * breaking off), with no control rows of it; a legacy observer gets them the old way; a lost decision is caught by the
 * check and put right; a client without CAPS.PILOTS runs none.
 *
 * A real GameServer; the pilot (a fake client with every cap) flies by input messages, on time, firing at the nearest.
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

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const BODIES = CAPS.HITS | CAPS.SELF_HITS | CAPS.PACKED | CAPS.COALESCE | CAPS.OWN_SHOTS | CAPS.ROUGH | CAPS.OWN_SIM | CAPS.INPUTS | CAPS.BODIES | CAPS.CAUSES;
const ALL = BODIES | CAPS.PILOTS;

interface Got { snapshots: number; checked: number; off: number; keyframes: number; ctlRows: number; decisions: number; syncs: number; running: number; ran: Set<number>; offAt: string[]; ops: Record<string, number> }
const zero = (): Got => ({ snapshots: 0, checked: 0, off: 0, keyframes: 0, ctlRows: 0, decisions: 0, syncs: 0, running: 0, ran: new Set(), offAt: [], ops: {} });

interface Opts {
  ticks?: number;
  /** The capable client's caps */
  caps?: number;
  /** The client loses this snapshot's decisions (the forced miss) */
  dropAt?: number;
  /** Packs: ships each, and where from the pilot */
  packs?: { ships: string[]; dx: number; dy: number }[];
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
  const caps = o.caps ?? ALL;
  const A = new FakeHitsClient(server, { name: 'pilots_a', caps, env });
  const B = new FakeHitsClient(server, { name: 'legacy_b', caps: 0, env });
  let foes: number[] = [];
  const foe = new Set<number>();
  /** Every hostile's real state at each tick's end */
  const truth = new Map<number, Map<number, number[]>>();
  const got = { A: zero(), B: zero() };
  const real = (id: number) => [Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], Rotation.angle[id], ships.get(id)!.angVel];
  const now = () => { const m = new Map<number, number[]>(); for (const id of foes) if (ships.has(id)) m.set(id, real(id)); return m; };
  const watch = (f: FakeHitsClient, g: Got, drop?: () => boolean) => {
    const fa = f as unknown as { snapshot(s: ServerSnapshotMessage): void };
    const orig = fa.snapshot.bind(f);
    fa.snapshot = (s) => {
      if (drop?.() && s.decisions?.some((d) => foe.has(d[0]) && d[2] !== DECISION.SYNC)) s = { ...s, decisions: s.decisions.filter((d) => !foe.has(d[0]) || d[2] === DECISION.SYNC) };
      const running = new Set(f.bodies?.ids() ?? []);
      orig(s);
      g.snapshots++;
      for (const k of s.ships ?? []) if (foe.has(k[0])) g.keyframes++;
      // (a ship run since the last snapshot gets no control rows)
      for (const r of s.ctl ?? []) if (running.has(controlRowId(r)) && f.bodies?.ids() && [...f.bodies.ids()].includes(controlRowId(r))) g.ctlRows++;
      for (const d of s.decisions ?? []) if (foe.has(d[0])) { g.decisions++; const k = d[2] === DECISION.WANT ? `W${d[3]}` : `${d[2]}`; g.ops[k] = (g.ops[k] ?? 0) + 1; if (d[2] === DECISION.SYNC) g.syncs++; }
      const tr = truth.get(s.tick) ?? (s.tick === server.getTick() ? now() : undefined);
      for (const id of f.bodies?.ids() ?? []) {
        if (!foe.has(id)) continue;
        g.running++;
        g.ran.add(id);
        const st = f.reps.at(id, s.tick)?.body, r = tr?.get(id);
        if (!st || !r) continue;
        g.checked++;
        if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4] || st.angVel !== r[5]) { g.off++; if (g.offAt.length < 8) g.offAt.push(`${id}@${s.tick}`); }
      }
    };
  };
  // (every decision of theirs in a second's snapshots lost)
  watch(A, got.A, () => o.dropAt !== undefined && server.getTick() >= o.dropAt && server.getTick() < o.dropAt + 60);
  watch(B, got.B);
  let seq = 1;
  let chk: ReturnType<NonNullable<FakeHitsClient['own']>['takeCheck']>;
  const nearest = () => {
    let best = -1, bd = Infinity;
    for (const id of foes) {
      if (!ships.has(id)) continue;
      const d = Math.hypot(Position.x[id] - Position.x[A.pid], Position.y[id] - Position.y[A.pid]);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  };
  const send = (t: number) => {
    // Its controls for the next tick: it weaves about, aim on the nearest hostile, firing now and then
    const n = nearest();
    const dx = n >= 0 ? Position.x[n] - Position.x[A.pid] : 1, dy = n >= 0 ? Position.y[n] - Position.y[A.pid] : 0, d = Math.hypot(dx, dy);
    const phase = Math.floor(t / 50) % 4;
    const bck = A.bodies?.takeCheck(true, server.getTick());
    const msg = {
      type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1,
      forward: phase === 0, backward: phase === 2, left: phase === 1, right: phase === 3, boost: false,
      fireLeft: t >= 0 && t % 60 < 20 && d < 1500, fireRight: false, targetAngle: datan2(dy, dx), cursorDist: Math.min(2000, d),
      ...(chk ? { ownCheck: chk } : {}), ...(bck ? { bodyCheck: bck } : {}),
    } as unknown as ClientMessage;
    chk = undefined;
    const dec = decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientMessage;
    A.noteInput(dec);
    A.link!.receive(dec);
  };
  const step = (t: number) => {
    send(t);
    server.step();
    truth.set(server.getTick(), now());
    truth.delete(server.getTick() - 120);
    clock.t += 1000 / 60;
    chk = A.own?.takeCheck(true, server.getTick());
    const rep = A.selfHits?.takeReport(true);
    if (rep) server.hits.report(server.pilots.connOf(A.pid)! as never, rep);
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
    B.flushUp();
  };
  for (let i = 0; i < 20; i++) step(-1);
  const god = (f: FakeHitsClient) => { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); c.isAdmin = false; };
  for (const f of [A, B]) god(f);
  const num = InSystem.systemId[A.pid];
  ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
  Position.x[B.pid] = x0 - 300; Position.y[B.pid] = y0 + 1400;
  for (const p of o.packs ?? [{ ships: ['pirate_raider', 'pirate_skiff', 'pirate_skiff'], dx: 1500, dy: 900 }, { ships: ['pirate_raider'], dx: -2500, dy: -600 }]) {
    foes.push(...server.enemies.spawnPack(num, { faction: 'pirates', ships: p.ships } as never, x0 + p.dx, y0 + p.dy));
  }
  for (const id of foes) foe.add(id);
  for (let t = 0; t < (o.ticks ?? 900); t++) step(t);
  foes = foes.filter((id) => ships.has(id));
  return { server, got, A, stats: server.bodies.stats, rep: server.replication.bodyStats };
}

describe('decision inputs: the enemy AI flown by its pilot\'s body on both sides (CAPS.PILOTS)', () => {
  it('a pirate fight: every hostile the client runs is the server\'s ship at every snapshot, no control rows of them, checks agreeing', () => {
    const r = fight({ ticks: 1200 });
    if (process.env.BODY_DEBUG) console.log('PILOTS', JSON.stringify({ got: { ...r.got.A, ran: [...r.got.A.ran] }, B: { ...r.got.B, ran: r.got.B.ran.size }, stats: r.stats, rep: r.rep, runner: r.A.bodies?.stats }));
    expect(r.got.A.ran.size).toBeGreaterThanOrEqual(3);
    expect(r.got.A.checked).toBeGreaterThan(500);
    expect(r.got.A.off).toBe(0);
    expect(r.got.A.ctlRows).toBe(0);
    expect(r.got.A.decisions).toBeGreaterThan(10);
    expect(r.stats.checks).toBeGreaterThan(10);
    expect(r.stats.off).toBe(0);
    // (keyframes of them: the first, and what their bodies don't model)
    expect(r.got.A.keyframes).toBeLessThan(r.got.B.keyframes / 2 + 10);
    // The legacy observer: them the old way, no decisions
    expect(r.got.B.decisions).toBe(0);
    expect(r.got.B.running).toBe(0);
  }, 240_000);

  it('a decision lost: its check catches it, SYNCs put it right', () => {
    const r = fight({ ticks: 800, dropAt: 400 });
    expect(r.stats.off).toBeGreaterThan(0);
    expect(r.got.A.off).toBeLessThan(60);
  }, 240_000);

  it('a client with bodies but not CAPS.PILOTS runs none of them: their rows the old way', () => {
    const r = fight({ ticks: 500, caps: BODIES });
    expect(r.got.A.ran.size).toBe(0);
    expect(r.got.A.decisions).toBe(0);
  }, 240_000);
});
