/**
 * The focus grid and ships away (CAPS.FOCUS; server net/cells/FocusCells.ts and AwayNet.ts, client ships/cells/ShipMemory.ts,
 * common network/cells.ts).
 *
 * A real GameServer; two pilots fly about by inputs (their controls change every 40 ticks), and an observer holding
 * cells is moved away from them and back. Every ship on its tick layer is checked against the server's ship at every
 * snapshot's tick: entering, leaving and coming back must all be exact. Coming back, a ship it kept gets its keyframe
 * and only what changed: no blueprint, no full sync, no status row with its place unless something in it changed.
 * Every client holds cells (the 40 km view circle is gone with the per-cap fallbacks).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, encodeMessage, decodeMessage, CELL_SIZE, focusCells, cellAt, AWAY_TICKS,
  type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage, type ServerMessage,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { makeServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

interface Seen {
  snapshots: number; checked: number; off: number; offIds: string[]; keyframes: Map<number, number>; cells: ServerMessage[];
  /** Every message about a ship by its id, in order: [tick, what] (sync+bp, sync, hps, row+pos, row) */
  about: Map<number, [number, string][]>;
}

function world(o: { dir?: (t: number, k: number) => number; at?: (x0: number, y0: number, k: number) => [number, number] } = {}) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = makeServer({ clock: () => clock.t });
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'watcher', env });
  const P = [new FakeHitsClient(server, { name: 'pilot_b', env }), new FakeHitsClient(server, { name: 'pilot_c', env })];
  const truth = new Map<number, Map<number, number[]>>();
  const seen: Seen = { snapshots: 0, checked: 0, off: 0, offIds: [], keyframes: new Map(), cells: [], about: new Map() };
  const note = (id: number, what: string) => { let l = seen.about.get(id); if (!l) seen.about.set(id, (l = [])); l.push([server.getTick(), what]); };
  const fa = A as unknown as { snapshot(s: ServerSnapshotMessage): void; handle(m: ServerMessage): void };
  const oSnap = fa.snapshot.bind(A), oHandle = fa.handle.bind(A);
  fa.handle = (m) => {
    if (m.type === 'cells') seen.cells.push(m);
    if (m.type === 'shipSync') note(m.id, m.blueprint || m.design ? 'sync+bp' : m.hp ? 'sync+hp' : 'sync');
    if (m.type === 'shipHps') for (const [id] of m.ships ?? []) note(id, 'hps');
    if (m.type === 'snapshot') for (const e of m.entities) note(e.id, e.x !== undefined ? 'row+pos' : 'row');
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
    for (const f of [A, ...P]) f.flushUp();
    check();
    if (where) for (const f of [A]) { Position.x[f.pid] = where[0]; Position.y[f.pid] = where[1]; Velocity.x[f.pid] = Velocity.y[f.pid] = 0; }
  };
  for (let i = 0; i < 10; i++) step();
  for (const f of [A, ...P]) { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); c.isAdmin = false; }
  // Somewhere quiet: a cell's middle well out from the sun
  const x0 = Math.floor((Position.x[A.pid] + 60000) / CELL_SIZE) * CELL_SIZE + CELL_SIZE / 2, y0 = Math.floor((Position.y[A.pid] + 60000) / CELL_SIZE) * CELL_SIZE + CELL_SIZE / 2;
  P.forEach((f, k) => { const p = o.at ? o.at(x0, y0, k) : [x0 - 600 + 1200 * k, y0 + 300]; Position.x[f.pid] = p[0]; Position.y[f.pid] = p[1]; Velocity.x[f.pid] = Velocity.y[f.pid] = 0; });
  where = [x0, y0];
  const run = (n: number, at?: [number, number]) => { if (at) where = at; for (let i = 0; i < n; i++) step(); };
  return { server, A, P, seen, run, x0, y0, conn: server.pilots.connOf(A.pid)! };
}

const away = (w: { x0: number; y0: number }): [number, number] => [w.x0 + 46000, w.y0];

/** What A was told about a ship since tick t */
const since = (w: { seen: Seen }, id: number, t: number) => (w.seen.about.get(id) ?? []).filter(([at]) => at > t).map(([, what]) => what);

describe('the focus grid and ships away (CAPS.FOCUS)', () => {
  it('holds the ships homed in its focus cells only; ships leaving are kept at both ends', () => {
    const w = world();
    w.run(60);
    const [b, c] = w.P.map((p) => p.pid);
    expect(w.conn.shipView.has(b) && w.conn.shipView.has(c)).toBe(true);
    // 30 km off: past every focus cell round them (inside the old 40 km circle)
    w.run(30, [w.x0 + 30000, w.y0 + 8000]);
    const f = new Set(focusCells(w.x0 + 30000, w.y0 + 8000));
    expect(f.has(cellAt(Position.x[b], Position.y[b]))).toBe(false);
    expect(w.conn.shipView.has(b)).toBe(false);
    expect(w.A.reps.has(b)).toBe(false);
    expect(w.A.away.has(b)).toBe(true);
    expect(w.conn.away?.has(b)).toBe(true);
    // (what it was sent of it stays: its sync and HP)
    expect(w.conn.shipSynced.has(b) && w.conn.shipHpSent.has(b)).toBe(true);
    expect(w.seen.cells.some((m) => m.type === 'cells' && (m.k ?? []).includes(b))).toBe(true);
    expect([...w.A.away.ids()].sort()).toEqual([...w.conn.away!.ids()].sort());
    expect(w.seen.off).toBe(0);
  });

  it.each([
    ['2.5 s away', 150],
    ['40 s away (past the old 10 s hold)', 2400],
  ])('leaves and comes back: a keyframe and only what changed, no replay, exact (%s)', (_, ticks) => {
    const w = world();
    w.run(90);
    const ids = w.P.map((p) => p.pid);
    w.run(ticks, away(w));
    expect(ids.every((id) => w.A.away.has(id) && !w.A.reps.has(id))).toBe(true);
    // (Flown off meanwhile: put back where it'll see them, as they might have flown back)
    w.P.forEach((f, k) => { Position.x[f.pid] = w.x0 - 600 + 1200 * k; Position.y[f.pid] = w.y0 + 300; Velocity.x[f.pid] = Velocity.y[f.pid] = 0; });
    const kf0 = ids.map((id) => w.seen.keyframes.get(id) ?? 0), t0 = w.server.getTick();
    w.run(150, [w.x0, w.y0]);
    expect(ids.every((id) => w.A.reps.has(id) && !w.A.away.has(id))).toBe(true);
    expect(w.seen.cells.some((m) => m.type === 'cells' && ids.every((id) => (m.b ?? []).includes(id)))).toBe(true);
    // (its movement from a keyframe each...)
    expect(ids.map((id, i) => (w.seen.keyframes.get(id) ?? 0) - kf0[i]).every((n) => n >= 1)).toBe(true);
    // (...and nothing else it had: no blueprint, no full sync, no row with its place)
    for (const id of ids) {
      const told = since(w, id, t0);
      expect(told).not.toContain('sync+bp');
      expect(told).not.toContain('sync+hp');
      expect(told).not.toContain('row+pos');
    }
    expect(w.A.away.stats.missed).toBe(0);
    expect(w.seen.checked).toBeGreaterThan(300);
    expect(w.seen.offIds).toEqual([]);
  });

  it('part HP changed while away: only the change goes back; a ship destroyed while away is told by id', () => {
    const w = world();
    w.run(90);
    const [b, c] = w.P.map((p) => p.pid);
    w.run(150, away(w));
    const ship = w.server.getShips().get(b)!;
    const part = ship.hp.findIndex((h) => h > 20);
    ship.hp[part] -= 7;
    w.server.getShips().removeShip(c);
    const t0 = w.server.getTick();
    w.run(150, [w.x0, w.y0]);
    const told = since(w, b, t0);
    expect(told.includes('hps') || told.includes('sync')).toBe(true);
    expect(told).not.toContain('sync+bp');
    expect(told).not.toContain('sync+hp');
    expect(w.A.store.get(b)!.hp[part]).toBeCloseTo(ship.hp[part], 1);
    expect(w.A.away.has(c)).toBe(false);
    expect(w.conn.away?.has(c) ?? false).toBe(false);
    expect(w.A.away.stats.removed).toBe(1);
    expect(w.seen.offIds).toEqual([]);
  });

  it('let go by age at both ends at once; back after that, they come as new', () => {
    const w = world();
    w.run(90);
    const ids = w.P.map((p) => p.pid);
    w.run(AWAY_TICKS + 120, away(w));
    // (the server sweeps each round, the client at each snapshot or cells message)
    expect(ids.some((id) => w.conn.away?.has(id))).toBe(false);
    w.P.forEach((f, k) => { Position.x[f.pid] = w.x0 - 600 + 1200 * k; Position.y[f.pid] = w.y0 + 300; Velocity.x[f.pid] = Velocity.y[f.pid] = 0; });
    const t0 = w.server.getTick();
    w.run(150, [w.x0, w.y0]);
    expect(ids.some((id) => w.A.away.has(id))).toBe(false);
    for (const id of ids) expect(since(w, id, t0)).toContain('row+pos');
    expect(w.A.away.stats.missed).toBe(0);
    expect(w.seen.offIds).toEqual([]);
  }, 60_000);

  it('dithering on the 19 km edge: out and back again and again, both ends agree, exact', () => {
    const w = world();
    w.run(60);
    // The pilots' cell's near edge is 19 km off at x = cell start - 19,000: hop either side of it
    const edge = Math.floor(w.x0 / CELL_SIZE) * CELL_SIZE - 19000;
    for (let k = 0; k < 6; k++) w.run(45, [edge + (k % 2 ? 300 : -300), w.y0]);
    const st = w.server.snapshots.away.stats;
    expect(st.kept).toBeGreaterThanOrEqual(2);
    expect(st.back).toBeGreaterThanOrEqual(2);
    expect([...w.A.away.ids()].sort()).toEqual([...(w.conn.away?.ids() ?? [])].sort());
    expect(w.A.away.stats.missed).toBe(0);
    expect(w.seen.offIds).toEqual([]);
  });
  it('ships crossing the border between a focus cell and one past it: out and in again, exact on both sides', () => {
    // The pilots fly north and south (forward is -y) across their cell's north border, the watcher south of them so that
    // cell is in focus and the next one north is not
    const w = world({ dir: (t) => [1, -1, -1, 1][Math.floor(t / 90) % 4], at: (x0, y0, k) => [x0 - 300 + 600 * k, y0 - CELL_SIZE / 2 + 300 + 100 * k] });
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
    const w = world();
    w.run(60);
    const focus = w.server.snapshots.focus as unknown as { host: { transit(eid: number): boolean } };
    let burning = true;
    focus.host.transit = () => burning;
    const d0 = w.server.snapshots.focus.stats.left, cells0 = new Set(w.conn.focus!.cells);
    // (flown 30 km in steps, as a burn carries it)
    for (let k = 1; k <= 10; k++) w.run(9, [w.x0 + 3000 * k, w.y0]);
    expect(w.server.snapshots.focus.stats.left).toBe(d0);
    expect([...w.conn.focus!.cells]).toEqual([...cells0]);
    burning = false;
    w.run(6);
    expect(w.server.snapshots.focus.stats.left).toBeGreaterThan(d0);
    expect(w.conn.focus!.cells).not.toEqual(cells0);
    expect(w.seen.offIds).toEqual([]);
  });

  it('a new system starts afresh (nothing kept from before the jump)', () => {
    const w = world();
    w.run(60);
    w.run(60, away(w));
    expect(w.conn.away?.size).toBeGreaterThan(0);
    w.conn.lastSystemId = -1;
    w.run(3);
    expect(w.conn.away?.size ?? 0).toBe(0);
    expect(InSystem.systemId[w.A.pid]).toBe(w.conn.lastSystemId);
  });
});
