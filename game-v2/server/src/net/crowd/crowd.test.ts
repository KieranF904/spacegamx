/**
 * Crowd fallbacks (CAPS.CROWD; server net/crowd/CrowdControl.ts, common network/crowd.ts).
 *
 * A real GameServer with two pilots flying (and firing) by inputs, a watcher with every cap and a legacy watcher. Each
 * level is forced in turn and undone: every ship on the watcher's tick layer is checked against the server's at every
 * snapshot's tick, through every switch. The automatic levels are checked on CrowdControl alone with made-up costs.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, Input, CAPS, ReplicaMode, replicaAngle, quantizeReplicaAngle, encodeMessage, decodeMessage, CELL_SIZE, CROWD_LEVELS, CROWD_MAX_LEVEL, crowdStage, ghostWeight,
  type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage, type ServerMessage, type ServerCrowdMessage,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { CrowdControl, CROWD_HIGH_MS, CROWD_LOW_MS } from './CrowdControl.js';
import type { ClientConnection } from '../ClientConnection.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const ALL = 32767;

interface Seen { snaps: number[]; legacySnaps: number[]; checked: number; offIds: string[]; ownKf: number[]; fixes: number; crowd: ServerCrowdMessage[] }

function world(o: { fire?: boolean; far?: number; free?: boolean } = {}) {
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
  server.crowd!.auto = false;
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'watcher', caps: ALL, env });
  const L = new FakeHitsClient(server, { name: 'legacy', caps: 0, env });
  const P = [new FakeHitsClient(server, { name: 'pilot_b', caps: 0, env }), new FakeHitsClient(server, { name: 'pilot_c', caps: 0, env })];
  const truth = new Map<number, Map<number, number[]>>();
  const seen: Seen = { snaps: [], legacySnaps: [], checked: 0, offIds: [], ownKf: [], fixes: 0, crowd: [] };
  const fa = A as unknown as { snapshot(s: ServerSnapshotMessage): void; handle(m: ServerMessage): void };
  const oSnap = fa.snapshot.bind(A), oHandle = fa.handle.bind(A);
  fa.handle = (m) => {
    if (m.type === 'crowd') seen.crowd.push(m);
    if (m.type === 'hitFix') seen.fixes++;
    oHandle(m);
  };
  fa.snapshot = (s) => {
    oSnap(s);
    seen.snaps.push(s.tick);
    if (seen.snaps.length > 3 && (s.ships ?? []).some((k) => k[0] === A.pid)) { seen.ownKf.push(s.tick); if (process.env.CROWD_DEBUG) console.log('OWNKF', s.tick, JSON.stringify((server.replication as unknown as { ownStats: unknown }).ownStats)); }
  };
  const fl = L as unknown as { snapshot(s: ServerSnapshotMessage): void };
  const lSnap = fl.snapshot.bind(L);
  fl.snapshot = (s) => { lSnap(s); seen.legacySnaps.push(s.tick); };
  /** Every ship A holds on its tick layer against the server's at the tick its last snapshot was for */
  const check = () => {
    const t = A.snapTick, tr = truth.get(t);
    if (!tr) return;
    for (const id of A.reps.ids()) {
      if (id === A.pid) continue;
      const st = A.reps.at(id, t)?.body, r = tr.get(id);
      if (!st || !r) continue;
      seen.checked++;
      if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4]) seen.offIds.push(`${id}@${t}`);
    }
  };
  let seq = 1;
  /** The watcher's system's tick (its own clock once dilated: sim/SystemClocks.ts) */
  const now = () => server.clocks!.tickOf(InSystem.systemId[A.pid]);
  const fly = (f: FakeHitsClient, t: number, k: number) => {
    const phase = Math.floor((t + 17 * k) / 40) % 4;
    const msg = { type: 'input', seq: seq++, tick: 0, targetTick: now() + 1, forward: phase !== 2, backward: false, left: phase === 1, right: phase === 3,
      boost: false, fireLeft: false, fireRight: false, targetAngle: (k ? Math.PI : 0) + 0.2 * phase, cursorDist: 700 };
    f.link!.receive(decodeMessage(encodeMessage(msg as unknown as ClientMessage) as ArrayBuffer) as ClientMessage);
  };
  let t = 0;
  let where: [number, number] | null = null;
  let dummy = -1;
  const step = () => {
    P.forEach((f, k) => fly(f, t, k));
    // (fire: the watcher shoots a dummy hauler, its own hits found on its tick layer: three phases in four)
    if (dummy >= 0 && server.getShips().has(dummy)) {
      const dx = Position.x[dummy] - Position.x[A.pid], dy = Position.y[dummy] - Position.y[A.pid], on = Math.floor(t / 40) % 4 !== 0 ? 1 : 0;
      Input.targetAngle[A.pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.atan2(dy, dx)));
      Input.cursorDist[A.pid] = Math.hypot(dx, dy);
      Input.fireLeft[A.pid] = on; Input.fireRight[A.pid] = on;
    }
    server.step();
    t++;
    const m = new Map<number, number[]>();
    for (const [eid] of server.getShips().bodies) m.set(eid, [Position.x[eid], Position.y[eid], Velocity.x[eid], Velocity.y[eid], Rotation.angle[eid]]);
    truth.set(now(), m);
    truth.delete(now() - 64);
    clock.t += 1000 / 60;
    for (const f of [A, L, ...P]) f.flushUp();
    check();
    if (where) for (const f of [A, L]) { Position.x[f.pid] = where[0]; Position.y[f.pid] = where[1]; Velocity.x[f.pid] = Velocity.y[f.pid] = 0; }
  };
  for (let i = 0; i < 10; i++) step();
  for (const f of [A, L, ...P]) { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); c.isAdmin = false; }
  // A cell's middle well out from the sun; one pilot beside the watchers, one in a cell 12-20 km east (in a 19 km focus, not a 10 km one)
  const x0 = Math.floor((Position.x[A.pid] + 60000) / CELL_SIZE) * CELL_SIZE + CELL_SIZE / 2, y0 = Math.floor((Position.y[A.pid] + 60000) / CELL_SIZE) * CELL_SIZE + CELL_SIZE / 2;
  const far = o.far ?? 17500;
  P.forEach((f, k) => { Position.x[f.pid] = k ? x0 + far : x0 + 900; Position.y[f.pid] = y0 + 300; Velocity.x[f.pid] = Velocity.y[f.pid] = 0; });
  where = [x0, y0];
  if (o.fire) {
    const ships = server.getShips();
    ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
    Position.x[A.pid] = x0; Position.y[A.pid] = y0;
    dummy = ships.spawnDummy(ships.library.get('hauler')!, x0 + 700, y0, 0, InSystem.systemId[A.pid]);
  }
  // (free: put there once, then left alone: its own ship flies by the tick layer like any)
  if (o.free) { step(); where = null; }
  const run = (n: number) => { for (let i = 0; i < n; i++) step(); };
  const system = () => InSystem.systemId[A.pid];
  return { server, A, L, P, seen, run, now, conn: server.pilots.connOf(A.pid)! as ClientConnection, system };
}

const gaps = (ticks: number[]) => ticks.slice(1).map((t, i) => t - ticks[i]);

describe('crowd fallbacks (CAPS.CROWD)', () => {
  it('the levels: focus shrinks first, then the window widens, then the clock slows; the fade follows the radius', () => {
    const stages = CROWD_LEVELS.map((_, i) => crowdStage(i));
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect(stages[0]).toBe(0);
    expect(stages[CROWD_MAX_LEVEL]).toBe(3);
    expect(ghostWeight(8999, 10000)).toBe(0);
    expect(ghostWeight(9500, 10000)).toBeCloseTo(0.5);
    expect(ghostWeight(10000, 10000)).toBe(1);
    expect(ghostWeight(18000)).toBe(0);
  });

  it('focus: a smaller radius drops the far cell, told from a tick; undone, it comes back; every held ship exact', () => {
    const w = world();
    w.run(90);
    const [near, far] = w.P.map((p) => p.pid);
    expect(w.conn.shipView.has(far) && w.conn.shipView.has(near)).toBe(true);
    const sys = w.system();
    w.server.crowd!.force(sys, 3);
    w.run(30);
    const m = w.seen.crowd.at(-1)!;
    expect(m).toMatchObject({ lv: 3, f: 10000, w: 3, r: 60 });
    expect(m.tick).toBeGreaterThan(0);
    expect(w.conn.shipView.has(far)).toBe(false);
    expect(w.conn.shipView.has(near)).toBe(true);
    expect(w.A.cells.has(far)).toBe(true);
    w.run(60);
    w.server.crowd!.force(sys, 0);
    w.run(60);
    expect(w.seen.crowd.at(-1)).toMatchObject({ lv: 0, f: 19000 });
    expect(w.conn.shipView.has(far)).toBe(true);
    expect(w.A.reps.has(far)).toBe(true);
    expect(w.seen.checked).toBeGreaterThan(200);
    expect(w.seen.offIds).toEqual([]);
  });

  it('window: snapshots every 6 ticks, then 9, then 3 again, to every client in the system; fights stay exact', () => {
    const w = world({ fire: true, far: 1500, free: true });
    w.run(90);
    const sys = w.system();
    const at = () => w.seen.snaps.length;
    const lat = () => w.seen.legacySnaps.length;
    w.server.crowd!.force(sys, 4);
    const s4 = at(), t4 = w.server.getTick();
    w.run(120);
    const s5 = at(), l5 = lat();
    w.server.crowd!.force(sys, 5);
    w.run(180);
    const s0 = at(), l0 = lat(), t0 = w.server.getTick();
    w.server.crowd!.force(sys, 0);
    w.run(120);
    expect(gaps(w.seen.snaps.slice(s4 + 1, s5))).toEqual(Array(s5 - s4 - 2).fill(6));
    expect(gaps(w.seen.snaps.slice(s5 + 1, s0))).toEqual(Array(s0 - s5 - 2).fill(9));
    expect(gaps(w.seen.snaps.slice(s0 + 1))).toEqual(Array(w.seen.snaps.length - s0 - 2).fill(3));
    expect(gaps(w.seen.legacySnaps.slice(l5 + 1, l0)).every((g) => g === 9)).toBe(true);
    expect(w.seen.crowd.map((m) => m.w)).toEqual([6, 9, 3]);
    expect(w.seen.checked).toBeGreaterThan(300);
    expect(w.seen.offIds).toEqual([]);
    // (no more keyframes of its own ship while the windows were wide than before: its Input is written directly here, so
    // the server finds it 'late' now and then whatever the window; and no hit of its own put right)
    const rate = (a: number, b: number) => w.seen.ownKf.filter((k) => k > a && k <= b).length / (b - a);
    expect(rate(t4, t0)).toBeLessThanOrEqual(rate(0, t4) * 1.25);
    expect(w.seen.fixes).toBe(0);
    expect((w.server as unknown as { hits: { stats: { hits: number } } }).hits.stats.hits).toBeGreaterThan(20);
  });

  it('dilation: the system steps 30 times a second on its own clock, told from a tick ahead; undone, 60 again; exact throughout', () => {
    const w = world({ fire: true, far: 1500, free: true });
    w.run(90);
    const sys = w.system();
    const base0 = w.server.getTick();
    w.server.crowd!.force(sys, 7);
    const told = w.seen.crowd.at(-1)!;
    expect(told).toMatchObject({ lv: 7, r: 30, w: 9 });
    expect(told.tick).toBe(w.now() + 30);
    w.run(300);
    // (30 ticks at full rate to the stated tick, then half: about 30 + 135 of its ticks in 300 base ticks)
    const ran = w.now() - base0;
    expect(ran).toBeGreaterThan(160);
    expect(ran).toBeLessThan(170);
    expect(w.server.getTick() - w.now()).toBeGreaterThan(130);
    const s1 = w.seen.snaps.length;
    w.run(300);
    expect(gaps(w.seen.snaps.slice(s1)).every((g) => g === 9)).toBe(true);
    w.server.crowd!.force(sys, 0);
    expect(w.seen.crowd.at(-1)).toMatchObject({ lv: 0, r: 60, w: 3 });
    // (the rate changes at the stated tick, 30 of its ticks on: at half rate, 60 base ticks)
    w.run(70);
    const t1 = w.now(), b1 = w.server.getTick();
    w.run(240);
    // (back to full rate on its own clock: still behind the server's, never catching up while anyone's there)
    expect(w.now() - t1).toBeGreaterThan(200);
    expect(w.server.getTick() - w.now()).toBe(b1 - t1);
    expect(w.seen.checked).toBeGreaterThan(300);
    expect(w.seen.offIds).toEqual([]);
    expect(w.seen.fixes).toBe(0);
    expect((w.server as unknown as { hits: { stats: { hits: number } } }).hits.stats.hits).toBeGreaterThan(20);
  });

  it('automatic: over budget it goes up a level at a time, holds, and comes down in reverse without flapping', () => {
    const sent: { lv: number; tick: number }[] = [];
    const conn = { caps: CAPS.CROWD } as ClientConnection;
    const cc = new CrowdControl({ clients: () => [conn], systemOf: () => 7, send: (_c, m) => sent.push(m), tickOf: () => 1000, setRate: () => {} });
    const lv: number[] = [];
    let k = 0;
    // Busy: the cost falls as the levels rise, but stays above the low mark (noisy, round the high one)
    for (let i = 0; i < 3000; i++, k++) { cc.charge(7, Math.max(CROWD_LOW_MS + 1, 24 - 2.2 * cc.levelOf(7)) + ((i * 7919) % 5) - 2); cc.endTick(); lv.push(cc.levelOf(7)); }
    const peak = cc.levelOf(7);
    expect(peak).toBeGreaterThan(3);
    // (never down while busy)
    expect(lv.every((v, i) => !i || v >= lv[i - 1])).toBe(true);
    // Quiet: down one level at a time
    const down: number[] = [];
    for (let i = 0; i < 6000; i++, k++) { cc.charge(7, 1); cc.endTick(); down.push(cc.levelOf(7)); }
    expect(cc.levelOf(7)).toBe(0);
    expect(down.every((v, i) => !i || v === down[i - 1] || v === down[i - 1] - 1)).toBe(true);
    expect(sent.map((m) => m.lv)).toEqual([...Array.from({ length: peak }, (_, i) => i + 1), ...Array.from({ length: peak }, (_, i) => peak - 1 - i)]);
    expect(CROWD_HIGH_MS).toBeGreaterThan(2 * CROWD_LOW_MS);
  });
});
