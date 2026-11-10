/**
 * Debris a client runs itself (CAPS.DEBRIS; common ships/debrisLife.ts, client ships/debris/DebrisLives.ts): freighters
 * shot apart a part at a time, then one blown up whole, and every piece left to drift, knock and crumble away. A client
 * running its pieces has each exactly as the server does at every snapshot, through their grace and its end, every
 * crumble and the pieces those break into, with no keyframe, sync or crumble effect of a piece it runs after its spawn.
 * Checked against the server's own state of every piece at every tick up to each snapshot (every client runs its debris: the
 * structs-only and legacy observers went with the per-cap fallbacks).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, InSystem, DEBRIS_GRACE_TICKS, type ReplicaEnv, type ClientMessage, type ServerMessage, type ServerSnapshotMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { targetFreighter } from '../../testkits/targetFreighter.testkit.js';
import { makeServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

interface Seen { kfAt: [number, number][]; kfRun: number; syncRun: number; crumbleRun: number; checked: number; off: string[]; keyframes: number; last: number }

/** A server, a client running its debris, and what it was sent and holds, checked against the server's state */
function world() {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = makeServer({ clock: () => clock.t });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  // (Three clients side by side, as the test always had; each runs its debris and is checked on its own)
  const A = new FakeHitsClient(server, { name: 'runs', env });
  const C = new FakeHitsClient(server, { name: 'runs_c', env });
  const B = new FakeHitsClient(server, { name: 'runs_b', env });
  const fakes = [A, C, B];
  const seen = new Map<FakeHitsClient, Seen>(fakes.map((f) => [f, { kfAt: [], kfRun: 0, syncRun: 0, crumbleRun: 0, checked: 0, off: [], keyframes: 0, last: -1 }]));
  let seq = 1;
  // (Pieces knocked by one gone that tick or out of the running client's view: what it has of the other may not be how
  // that one ended (its removal can come before it stepped there), so the server keyframes it: Replication.forClient)
  // (told after the snapshot's step, so counted at the end)
  const excused = new Map<number, number[]>();
  const excuse = (id: number, tick: number) => !!excused.get(id)?.some((t) => t > tick - 30 && t <= tick);
  // (Each piece's state as each tick left it: frames may wait a few ticks, coalesced, and a quiet window be long)
  const real = new Map<number, Map<number, number[]>>();
  const step = () => {
    server.step();
    clock.t += 1000 / 60;
    const now = new Map<number, number[]>();
    for (const [id, ship] of ships.bodies) if (ship.kind === 'debris') now.set(id, [Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], Rotation.angle[id], ship.angVel]);
    real.set(server.getTick(), now);
    real.delete(server.getTick() - 300);
    for (const f of fakes) {
      // (Its confirmations of the pieces it worked out, on an input as a client sends them)
      const acks = f.debris.takeAcks();
      if (acks) f.link!.receive({ type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0, acks } as unknown as ClientMessage);
      f.flushUp();
    }
  };
  for (let i = 0; i < 30; i++) step();
  for (const f of fakes) { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); }
  const sys = InSystem.systemId[A.pid];
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  for (const [k, f] of fakes.entries()) { Position.x[f.pid] = x0 - 200 * k; Position.y[f.pid] = y0 + 300 * k; Velocity.x[f.pid] = 0; Velocity.y[f.pid] = 0; }
  // What each client is sent of the pieces it runs, and its state of every piece it holds against the server's
  for (const f of fakes) {
    const s = seen.get(f)!, fa = f as unknown as { handle(m: ServerMessage): void; snapshot(m: ServerSnapshotMessage): void };
    const oh = fa.handle.bind(f), os = fa.snapshot.bind(f);
    fa.handle = (m) => {
      // (A sync of one it runs is only for one something else touched: told from then on)
      if (m.type === 'shipSync' && f.debris.lives.has(m.id) && !ships.debrisNet.told.has(m.id)) s.syncRun++;
      if (m.type === 'partDestroyed' && m.how === 'crumble' && f.debris.lives.has(m.bodyId)) s.crumbleRun++;
      oh(m);
    };
    fa.snapshot = (m) => {
      for (const k of m.ships ?? []) { if (f.debris.lives.has(k[0])) s.kfAt.push([k[0], m.tick]); if (ships.get(k[0])?.kind === 'debris') s.keyframes++; }
      os(m);
      const check = (id: number, t: number, want: number[] | undefined, st: { x: number; y: number; vx: number; vy: number; angle: number; angVel: number } | undefined) => {
        if (!want || !st) return;
        s.checked++;
        const mine = [st.x, st.y, st.vx, st.vy, st.angle, st.angVel];
        if (mine.some((v, i) => v !== want[i]) && s.off.length < 10) s.off.push(`${f === A ? "A" : f === C ? "C" : "B"} tick ${t} piece ${id} (${f.debris.lives.has(id) ? 'runs' : 'sent'}): ${mine.join(',')} vs ${want.join(',')}`);
      };
      for (const id of f.reps.ids()) {
        // (A frame that went at once: sent at the tick's end, the state now)
        const ship = ships.get(id), now = m.tick === server.getTick() && ship?.kind === 'debris' ? [Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], Rotation.angle[id], ship.angVel] : undefined;
        check(id, m.tick, real.get(m.tick)?.get(id) ?? now, f.reps.at(id, m.tick)?.body);
        // (...and every tick of the window since its last snapshot from its keyframe or spawn on, as it stepped them: a
        // snapshot goes only when there's something to say, so a quiet window can be long)
        for (let t = Math.max(s.last + 1, f.reps.kfOf(id) ?? Infinity); t < m.tick; t++) check(id, t, real.get(t)?.get(id), f.reps.ring.get(id, t)?.body);
      }
      s.last = m.tick;
    };
  }
  // (Knocks between pieces just past their grace: the grace ends with them where it found them, overlapping or not)
  const pairsYoung = { justPast: 0 };
  const run = (ticks: number, each: (t: number) => void) => {
    for (let t = 0; t < ticks; t++) {
      each(t);
      step();
      const view = server.pilots.connOf(A.pid)!.shipView, out = (x: number) => !ships.has(x) || !view.has(x);
      const note = (id: number) => { let l = excused.get(id); if (!l) excused.set(id, (l = [])); l.push(server.getTick()); };
      for (const [a, c] of ships.debrisNet.pairs) { if (out(a) !== out(c)) note(out(a) ? c : a); }
      // (...and what knocks into one of those: its keyframe goes with the other's)
      for (let more = true, n = 0; more && n < 8; n++) { more = false; for (const [a, c] of ships.debrisNet.pairs) { const ea = excuse(a, server.getTick()), ec = excuse(c, server.getTick()); if (ea !== ec) { note(ea ? c : a); more = true; } } }
      for (const [a, c] of ships.debrisNet.pairs) for (const id of [a, c]) { const age = server.getTick() - (ships.get(id)?.spawnTick ?? -1e9); if (age > DEBRIS_GRACE_TICKS && age <= DEBRIS_GRACE_TICKS + 60) pairsYoung.justPast++; }
    }
  };
  return { server, ships, A, sys, x0, y0, run, seen: (f: FakeHitsClient) => { const s = seen.get(f)!; s.kfRun = s.kfAt.filter(([id, t]) => !excuse(id, t)).length; return s; }, pairsYoung };
}

function fight(ticks: number) {
  const w = world(), { ships, sys, x0, y0, server } = w;
  // (An unarmed, unshielded freighter: a fixed target, whatever the world's freighters become)
  const bp = targetFreighter(ships);
  const haulers = [0, 1, 2].map((i) => ships.spawnDummy(bp, x0 + 700 + 260 * i, y0 - 150 + 170 * i, 0.4 * i, sys));
  // Parts shot away, a few at a time, seeded
  let r = 7;
  const rnd = () => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return r / 4294967296; };
  w.run(ticks, (t) => {
    if (t < 420 && t % 10 === 0) {
      const live = haulers.filter((h) => ships.has(h));
      const h = live[Math.floor(rnd() * live.length)], sp = h !== undefined ? ships.get(h) : undefined;
      const parts = sp ? sp.blueprint.parts.map((_, i) => i).filter((i) => sp.derived.alive[i] && sp.blueprint.parts[i].fn !== 'core') : [];
      if (parts.length) ships.damagePartFraction(h, parts[Math.floor(rnd() * parts.length)], 1);
    }
    // One blown up whole: its core gone, every part breaks away
    if (t === 300 && ships.has(haulers[2])) { const sp = ships.get(haulers[2])!; ships.damagePartFraction(haulers[2], sp.blueprint.parts.findIndex((p) => p.fn === 'core'), 1); }
  });
  void server;
  return w;
}

/** The Scrap Mother made to shed through her stages (dev forceShed: a step every so often), then blowing apart */
function shedding(ticks: number) {
  const w = world(), { server, ships, sys, x0, y0 } = w;
  const eid = server.bosses.spawnAt('boss_scrap_mother', sys, x0 + 1500, y0);
  const brain = server.bosses.brainOf(eid)!;
  let n = 0;
  const shed = { pieces: 0, aloof: 0 };
  const before = new Set(ships.bodies.keys());
  w.run(ticks, (t) => { if (t > 30 && t % 24 === 0 && ships.has(eid)) brain.forceShed!(++n); });
  for (const id of w.A.debris.lives.ids()) if (!before.has(id)) shed.pieces++;
  return { ...w, eid, shed };
}

describe('debris a client runs itself (CAPS.DEBRIS)', () => {
  it('freighters shot apart and blown up: every piece exact through its life, nothing sent of the ones it runs', () => {
    const r = fight(1500);
    const a = r.seen(r.A);
    const acks = (r.server as unknown as { snapshots: { debrisAcks: { ok: number; late: number } } }).snapshots.debrisAcks;
    if (process.env.DEBRIS_DEBUG) console.log(JSON.stringify({ a, lives: r.A.debris.lives.stats, splits: r.A.debris.stats, acks, pairs: r.pairsYoung }));
    // It ran pieces, which crumbled and broke up, and it worked every bit of it out
    expect(r.A.debris.lives.stats.pieces).toBeGreaterThan(20);
    expect(r.A.debris.lives.stats.crumbles).toBeGreaterThan(20);
    expect(a.off).toEqual([]);
    expect(a.checked).toBeGreaterThan(1000);
    expect(a.kfRun + a.syncRun + a.crumbleRun).toBe(0);
    // (every split worked out and confirmed in time: a split told goes with a snapshot, which its client waits for)
    expect(acks.ok).toBeGreaterThan(0);
    expect(acks.late).toBe(0);
    // (...pieces knocking just past their grace among them: the grace ends where it found them, in contact or not)
    expect(r.pairsYoung.justPast).toBeGreaterThan(0);
  }, 240_000);

  it('a boss shedding its plates and stages, then blowing apart: its flung pieces worked out and run too', () => {
    const r = shedding(1800);
    const a = r.seen(r.A);
    const acks = (r.server as unknown as { snapshots: { debrisAcks: { ok: number; wrong: number } } }).snapshots.debrisAcks;
    if (process.env.DEBRIS_DEBUG) console.log(JSON.stringify({ a, lives: r.A.debris.lives.stats, splits: r.A.debris.stats, acks, gone: !r.ships.has(r.eid), aloof: r.A.store.aloof.size }));
    // Its sheds came as splits the clients worked out, the pieces only to be seen, and every one exact
    expect(r.A.debris.stats.pieces).toBeGreaterThan(20);
    expect(r.ships.has(r.eid)).toBe(false);
    expect(a.off).toEqual([]);
    expect(a.kfRun + a.syncRun + a.crumbleRun).toBe(0);
  }, 240_000);
});
