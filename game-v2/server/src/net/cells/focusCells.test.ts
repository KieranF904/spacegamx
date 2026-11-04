/**
 * The focus grid (CAPS.FOCUS; server net/cells/FocusCells.ts, client ships/cells/CellCache.ts, common network/cells.ts).
 *
 * A real GameServer; two pilots fly about by inputs (their controls change every 40 ticks), and an observer holding
 * cells is moved away from them and back. Every ship on its tick layer is checked against the server's ship at every
 * snapshot's tick: entering, leaving and coming back (from its kept cell, fast-forwarded from the log, and as new) must
 * all be exact. A legacy observer alongside keeps the 40 km circle.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, CAPS, encodeMessage, decodeMessage, CELL_SIZE, focusCells, cellAt,
  type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage, type ServerMessage,
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

interface Seen { snapshots: number; checked: number; off: number; offIds: string[]; keyframes: Map<number, number>; cells: ServerMessage[] }

function world(caps: number, o: { corrupt?: boolean; dir?: (t: number, k: number) => number; at?: (x0: number, y0: number, k: number) => [number, number] } = {}) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
    netCaps: caps | CAPS.HITS | CAPS.PACKED | CAPS.BLOCKS | CAPS.OWN_SHOTS | CAPS.OWN_SIM,
  });
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'watcher', caps, env });
  const L = new FakeHitsClient(server, { name: 'legacy', caps: 0, env });
  const P = [new FakeHitsClient(server, { name: 'pilot_b', caps: 0, env }), new FakeHitsClient(server, { name: 'pilot_c', caps: 0, env })];
  const truth = new Map<number, Map<number, number[]>>();
  const seen: Seen = { snapshots: 0, checked: 0, off: 0, offIds: [], keyframes: new Map(), cells: [] };
  const fa = A as unknown as { snapshot(s: ServerSnapshotMessage): void; handle(m: ServerMessage): void };
  const oSnap = fa.snapshot.bind(A), oHandle = fa.handle.bind(A);
  fa.handle = (m) => {
    if (m.type === 'cells') seen.cells.push(m);
    // (A cache gone bad: its answers' hashes off by one)
    if (m.type === 'cells' && o.corrupt && m.b) { oHandle(m); for (const r of A.outbox) if (r.type === 'cellCache') r.c = r.c.map((v, i) => (i % 3 === 2 && v ? v ^ 1 : v)); return; }
    oHandle(m);
  };
  fa.snapshot = (s) => {
    oSnap(s);
    seen.snapshots++;
    for (const k of s.ships ?? []) { seen.keyframes.set(k[0], (seen.keyframes.get(k[0]) ?? 0) + 1); if (process.env.FOCUS_DEBUG) console.log('KF', k[0], s.tick); }
  };
  /** Every ship A holds on its tick layer against the server's at the tick its last snapshot was for */
  const check = () => {
    const t = A.snapTick, tr = truth.get(t);
    if (!tr) return;
    for (const id of A.reps.ids()) {
      if (id === A.pid) continue;
      const st = A.reps.at(id, t)?.body, r = tr.get(id);
      if (!st || !r) continue;
      seen.checked++;
      if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4]) { seen.off++; seen.offIds.push(`${id}@${t}`); }
    }
  };
  let seq = 1;
  const fly = (f: FakeHitsClient, t: number, k: number) => {
    const phase = Math.floor((t + 17 * k) / 40) % 4;
    const msg = { type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1, forward: o.dir ? o.dir(t, k) > 0 : phase !== 2, backward: !!o.dir && o.dir(t, k) < 0, left: !o.dir && phase === 1, right: !o.dir && phase === 3,
      boost: false, fireLeft: false, fireRight: false, targetAngle: (k ? 1 : -1) * 0.4 * phase, cursorDist: 700 } as unknown as ClientMessage;
    f.link!.receive(decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientMessage);
  };
  let where: [number, number] | null = null;
  let t = 0;
  const step = () => {
    P.forEach((f, k) => fly(f, t, k));
    server.step();
    t++;
    const m = new Map<number, number[]>();
    for (const [eid] of server.getShips().bodies) m.set(eid, [Position.x[eid], Position.y[eid], Velocity.x[eid], Velocity.y[eid], Rotation.angle[eid]]);
    truth.set(server.getTick(), m);
    truth.delete(server.getTick() - 64);
    clock.t += 1000 / 60;
    for (const f of [A, L, ...P]) f.flushUp();
    check();
    if (where) for (const f of [A, L]) { Position.x[f.pid] = where[0]; Position.y[f.pid] = where[1]; Velocity.x[f.pid] = Velocity.y[f.pid] = 0; }
  };
  for (let i = 0; i < 10; i++) step();
  for (const f of [A, L, ...P]) { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); c.isAdmin = false; }
  // Somewhere quiet: a cell's middle well out from the sun
  const x0 = Math.floor((Position.x[A.pid] + 60000) / CELL_SIZE) * CELL_SIZE + CELL_SIZE / 2, y0 = Math.floor((Position.y[A.pid] + 60000) / CELL_SIZE) * CELL_SIZE + CELL_SIZE / 2;
  P.forEach((f, k) => { const p = o.at ? o.at(x0, y0, k) : [x0 - 600 + 1200 * k, y0 + 300]; Position.x[f.pid] = p[0]; Position.y[f.pid] = p[1]; Velocity.x[f.pid] = Velocity.y[f.pid] = 0; });
  where = [x0, y0];
  const run = (n: number, at?: [number, number]) => { if (at) where = at; for (let i = 0; i < n; i++) step(); };
  return { server, A, L, P, seen, run, x0, y0, conn: server.pilots.connOf(A.pid)!, lconn: server.pilots.connOf(L.pid)! };
}

const away = (w: { x0: number; y0: number }): [number, number] => [w.x0 + 46000, w.y0];

describe('the focus grid (CAPS.FOCUS)', () => {
  it('holds the ships homed in its focus cells only; the legacy client keeps its 40 km circle', () => {
    const w = world(CAPS.FOCUS);
    w.run(60);
    const [b, c] = w.P.map((p) => p.pid);
    expect(w.conn.shipView.has(b) && w.conn.shipView.has(c)).toBe(true);
    // 30 km off: past every focus cell round them, inside the legacy circle
    w.run(30, [w.x0 + 30000, w.y0 + 8000]);
    const f = new Set(focusCells(w.x0 + 30000, w.y0 + 8000));
    expect(f.has(cellAt(Position.x[b], Position.y[b]))).toBe(false);
    expect(w.conn.shipView.has(b)).toBe(false);
    expect(w.lconn.shipView.has(b)).toBe(true);
    expect(w.A.reps.has(b)).toBe(false);
    expect(w.A.cells.has(b)).toBe(true);
    // ...and they're its ghosts (map-dot legs) with its map shut
    expect(w.seen.cells.some((m) => m.type === 'cells' && (m.d ?? []).includes(b))).toBe(true);
    expect(w.seen.off).toBe(0);
  });

  it.each([
    ['plain frames', CAPS.FOCUS],
    ['every cap (packed, blocks, own ship, bodies)', 2047],
  ])('leaves and comes back within the hold: put back from its kept cell and a log, no keyframes, exact (%s)', (_, caps) => {
    const w = world(caps);
    w.run(90);
    const ids = w.P.map((p) => p.pid);
    if (process.env.FOCUS_DEBUG) console.log('POS', ids.map((id) => [Position.x[id] - w.x0, Position.y[id] - w.y0, Velocity.x[id], w.server.pilots.connOf(id)?.docked]));
    const kf0 = ids.map((id) => w.seen.keyframes.get(id) ?? 0);
    w.run(150, away(w));
    expect(ids.every((id) => w.A.cells.has(id))).toBe(true);
    w.run(150, [w.x0, w.y0]);
    const st = w.server.snapshots.focus.stats;
    if (process.env.FOCUS_DEBUG) console.log(ids, JSON.stringify(st), JSON.stringify(w.A.cells.stats), w.seen.cells.map((m) => JSON.stringify(m)).join(' | '), JSON.stringify(w.server.replication.reasons));
    expect(st.offers).toBeGreaterThan(0);
    expect(st.logs).toBeGreaterThan(0);
    expect(st.logShips).toBeGreaterThanOrEqual(2);
    expect(st.logEvents).toBeGreaterThan(0);
    expect(w.A.cells.stats.restored).toBeGreaterThanOrEqual(2);
    expect(ids.every((id) => w.A.reps.has(id))).toBe(true);
    // (no entry keyframe for them: they came back from what it kept)
    expect(ids.map((id) => w.seen.keyframes.get(id) ?? 0)).toEqual(kf0);
    expect(w.seen.checked).toBeGreaterThan(500);
    expect(w.seen.offIds).toEqual([]);
  });

  it('back after the hold, or with a cache gone bad: they come as new, still exact', () => {
    for (const o of [{ long: true }, { corrupt: true }]) {
      const w = world(CAPS.FOCUS, o);
      w.run(90);
      const ids = w.P.map((p) => p.pid);
      const kf0 = ids.map((id) => w.seen.keyframes.get(id) ?? 0);
      w.run(o.long ? 700 : 150, away(w));
      w.run(150, [w.x0, w.y0]);
      const st = w.server.snapshots.focus.stats;
      expect(st.logs).toBe(0);
      if (o.corrupt) expect(st.refusedHash).toBeGreaterThan(0);
      else expect(st.offers).toBe(0);
      expect(ids.every((id) => w.A.reps.has(id))).toBe(true);
      expect(ids.map((id, i) => (w.seen.keyframes.get(id) ?? 0) - kf0[i]).every((n) => n >= 1)).toBe(true);
      expect(w.seen.offIds).toEqual([]);
    }
  });

  it('dithering on the 19 km edge: drops and returns are logs, and the ships stay exact', () => {
    const w = world(CAPS.FOCUS);
    w.run(60);
    // The pilots' cell's near edge is 19 km off at x = cell start - 19,000: hop either side of it
    const edge = Math.floor(w.x0 / CELL_SIZE) * CELL_SIZE - 19000;
    for (let k = 0; k < 6; k++) w.run(45, [edge + (k % 2 ? 300 : -300) - 2000 * 0, w.y0]);
    const st = w.server.snapshots.focus.stats;
    if (process.env.FOCUS_DEBUG) console.log(JSON.stringify(st), JSON.stringify(w.A.cells.stats));
    expect(st.drops).toBeGreaterThanOrEqual(2);
    expect(st.logs).toBeGreaterThanOrEqual(1);
    expect(w.seen.offIds).toEqual([]);
  });

  it('ships crossing the border between a focus cell and one past it: out and in again, exact on both sides', () => {
    // The pilots fly north and south (forward is -y) across their cell's north border, the watcher south of them so that
    // cell is in focus and the next one north is not
    const w = world(2047, { dir: (t) => [1, -1, -1, 1][Math.floor(t / 90) % 4], at: (x0, y0, k) => [x0 - 300 + 600 * k, y0 - CELL_SIZE / 2 + 300 + 100 * k] });
    const top = Math.floor(w.y0 / CELL_SIZE) * CELL_SIZE;
    const spot: [number, number] = [w.x0, top + CELL_SIZE + 19000 - 3000];
    expect(focusCells(...spot)).toContain(cellAt(w.x0, w.y0));
    expect(focusCells(...spot)).not.toContain(cellAt(w.x0, top - 10));
    let flips = 0, was = true;
    for (let i = 0; i < 80; i++) {
      w.run(10, spot);
      const now = w.conn.shipView.has(w.P[0].pid);
      if (now !== was) flips++;
      was = now;
    }
    // (out of its view past the border and back in, more than once)
    expect(flips).toBeGreaterThanOrEqual(3);
    expect(w.seen.checked).toBeGreaterThan(300);
    expect(w.seen.offIds).toEqual([]);
  });

  it("a jump's burn is a transit: the focus holds still till it ends, then changes once", () => {
    const w = world(CAPS.FOCUS);
    w.run(60);
    const focus = w.server.snapshots.focus as unknown as { host: { transit(eid: number): boolean } };
    let burning = true;
    focus.host.transit = () => burning;
    const d0 = w.server.snapshots.focus.stats.drops, cells0 = new Set(w.conn.focus!.cells);
    // (flown 30 km in steps, as a burn carries it)
    for (let k = 1; k <= 10; k++) w.run(9, [w.x0 + 3000 * k, w.y0]);
    expect(w.server.snapshots.focus.stats.drops).toBe(d0);
    expect([...w.conn.focus!.cells]).toEqual([...cells0]);
    burning = false;
    w.run(6);
    expect(w.server.snapshots.focus.stats.drops).toBeGreaterThan(d0);
    expect(w.conn.focus!.cells).not.toEqual(cells0);
    expect(w.seen.offIds).toEqual([]);
  });

  it('a new system starts afresh (no offer from before the jump)', () => {
    const w = world(CAPS.FOCUS);
    w.run(60);
    w.run(60, away(w));
    expect(w.conn.focus?.dropped.size).toBeGreaterThan(0);
    w.conn.lastSystemId = -1;
    w.run(3);
    expect(w.conn.focus?.dropped.size ?? 0).toBe(0);
    expect(InSystem.systemId[w.A.pid]).toBe(w.conn.lastSystemId);
  });
});
