/**
 * A pilot's own ship stepped by its client (CAPS.OWN_SIM; common network/ownTick.ts, client ships/own/OwnTick.ts,
 * docs/design/confirmed-hits.md part G). The client flies its tick-aligned own ship from its own inputs at their target
 * ticks, and works out the causes the server tells it (pulls, contacts, rebuilds); it is sent no control rows or
 * keyframes of its own ship while that holds, and its check (a hash on its inputs) agrees every time.
 *
 * A real GameServer; the pilot (a fake client, full caps) flies by input messages, on time.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, encodeMessage, decodeMessage, ServerFrameReader, controlRowId,
  type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../ships/createShipBridge.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { stationQuery } from '../../game/Docking.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

interface Opts {
  /** What else happens on a tick, before it (a dummy brought up against it, an EMP) */
  each?: (t: number, w: World) => void;
  /** A pull on its ship during the tick (as a boss's magnet pulls, in its brain's step after the pilots have moved) */
  pull?: (t: number) => [number, number] | null;
  /** Something during the tick, after the pilots have moved (where a boss's brain acts) */
  mid?: (t: number, w: World) => void;
  /** The client drops the own-ship causes of this snapshot (the forced miss) */
  dropAt?: number;
  /** A hitch: no inputs sent from `from` until `to`, then those ticks' inputs all at once (late), the controls it had before (`same`) or changed */
  hitch?: { from: number; to: number; same: boolean };
  ticks?: number;
  /** Its ship (a library blueprint; the Sparrow T if not said) */
  ship?: string;
  /** An observer near it: its replica of A checked at each snapshot, and A's keyframes to it counted */
  watch?: boolean;
  /** Its aim and keys on tick t, if not the default sweep (the held aim angle: common sim/aimHold.ts) */
  aim?: (t: number) => number;
  keys?: (t: number) => Record<string, boolean>;
}
interface World { server: GameServer; A: FakeHitsClient; target: number; x0: number; y0: number }

function fly(o: Opts = {}) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigCached(dataDir)),
    clock: () => clock.t,
  });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'own_sim', env });
  const C = o.watch ? new FakeHitsClient(server, { name: 'watch', env }) : null;
  const seen = { keyframes: 0, checked: 0, off: 0 };
  if (C) {
    const fc = C as unknown as { snapshot(s: ServerSnapshotMessage): void };
    const oc = fc.snapshot.bind(C);
    fc.snapshot = (s) => {
      const held = C.reps.has(A.pid);
      oc(s);
      if (held && s.ships?.some((k) => k[0] === A.pid)) seen.keyframes++;
      const st = C.reps.at(A.pid, s.tick)?.body, r = truth.get(s.tick);
      if (st && r) { seen.checked++; if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4]) seen.off++; }
    };
  }
  // What A was sent of its own ship, and its own layer against the server's ship at each snapshot's tick
  const got = { keyframes: 0, ctlRows: 0, causes: 0, snapshots: 0, off: 0, checked: 0, ownRows: 0, causedRows: 0, syncs: 0, hazSyncs: 0, headMisses: 0 };
  // (The ownSyncs it was sent: its whole state put right, or its hazards alone; and its head hashes it disagreed with)
  { const ot = A.own, o2 = ot.onOwnSync.bind(ot); ot.onOwnSync = (m) => { if (m.c) got.syncs++; else got.hazSyncs++; o2(m); }; }
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
    // (Its own row: a correction of its drawn prediction; the causes' moves it works out itself, so none rides with them)
    if (s.entities.some((e) => e.id === A.pid)) { got.ownRows++; if (s.own?.length) got.causedRows++; }
    const st = A.reps.at(A.pid, s.tick)?.body, r = truth.get(s.tick);
    if (A.own.on && st && r) { got.checked++; if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4]) got.off++; }
  };
  void ServerFrameReader;
  let seq = 1, lastT = -1;
  // (A hitch: the ticks it sent nothing for, the server holding what it had; sent late once it's over)
  const backlog: number[] = [];
  const send = (t: number) => {
    const h = o.hitch;
    if (h && t >= h.from && t < h.to) { backlog.push(server.getTick() + 1); return; }
    if (h && t === h.to) for (const tt of backlog.splice(0)) post(h.same ? lastT : t + 20, tt);
    post(t, server.getTick() + 1);
    lastT = t;
  };
  const post = (t: number, targetTick: number) => {
    // Its controls for the next tick: thrust that changes now and then, the aim sweeping, firing
    const phase = Math.floor(t / 40) % 4;
    const msg = {
      type: 'input', seq: seq++, tick: 0, targetTick,
      forward: phase === 0, backward: phase === 2, left: phase === 1, right: phase === 3, boost: false,
      fireLeft: t % 50 < 30, fireRight: false, targetAngle: o.aim ? o.aim(t) : Math.sin(t / 30) * 1.2, cursorDist: 700,
      ...(o.keys?.(t) ?? {}),
      ...(chk ? { ownCheck: chk } : {}),
    } as unknown as ClientMessage;
    chk = undefined;
    const dec = decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientMessage;
    A.noteInput(dec);
    A.link!.receive(dec);
  };
  let chk: ReturnType<FakeHitsClient['own']['takeCheck']>;
  const step = (t: number) => {
    send(t);
    server.step();
    truth.set(server.getTick(), [Position.x[A.pid], Position.y[A.pid], Velocity.x[A.pid], Velocity.y[A.pid], Rotation.angle[A.pid]]);
    clock.t += 1000 / 60;
    chk = A.own.takeCheck(true, server.getTick());
    got.headMisses = A.own.stats.headMisses;
    const rep = A.selfHits.takeReport(true);
    if (rep) server.hits.report(server.pilots.connOf(A.pid)! as never, rep);
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
    C?.flushUp();
  };
  for (let i = 0; i < 20; i++) step(-1);
  { const c = server.pilots.connOf(A.pid)! as unknown as { isAdmin: boolean }; c.isAdmin = true; server.admin.run(c as never, 'god', { on: 'on' }); c.isAdmin = false; }
  const num = InSystem.systemId[A.pid];
  ships.respawnInPlace(A.pid, ships.library.get(o.ship ?? 'sparrow-t')!);
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
  if (C) { Position.x[C.pid] = x0 - 300; Position.y[C.pid] = y0 - 400; Velocity.x[C.pid] = 0; Velocity.y[C.pid] = 0; }
  const target = ships.spawnDummy(ships.library.get('hauler')!, x0 + 700, y0, 0, num);
  const w: World = { server, A, target, x0, y0 };
  let now = -1;
  { const en = server.enemies as unknown as { tick(): void }, o0 = en.tick.bind(en); en.tick = () => { o0(); const p = o.pull?.(now); if (p) ships.push(A.pid, p[0], p[1]); o.mid?.(now, w); }; }
  // Rebuilds of its ship, and of a ship already rebuilt that tick (bridge/rebuild.ts: none)
  const reb = { own: 0, repeats: 0 };
  {
    const sb = ships as unknown as { rebuildNow(eid: number, ...a: unknown[]): void }, o1 = sb.rebuildNow.bind(sb);
    let tickOf = -1;
    const seen = new Set<number>();
    sb.rebuildNow = (eid, ...a) => {
      if (server.getTick() !== tickOf) { tickOf = server.getTick(); seen.clear(); }
      if (seen.has(eid)) reb.repeats++; else seen.add(eid);
      if (eid === A.pid) reb.own++;
      return o1(eid, ...a);
    };
  }
  for (let t = 0; t < 40; t++) step(t);
  const seen0 = { ...seen };
  const at0 = { ...got }, own0 = { ...server.replication.ownStats }, chk0 = { ...server.ownChecks.stats };
  for (let t = 40; t < (o.ticks ?? 600); t++) { now = t; o.each?.(t, w); step(t); }
  const d = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(a).filter((k) => typeof a[k] === 'number').map((k) => [k, a[k] - (b[k] ?? 0)]));
  return { w, reb, seen: d(seen, seen0), got: d(got, at0), own: d(server.replication.ownStats as never, own0 as never), checks: d(server.ownChecks.stats as never, chk0 as never), journal: server.hits.journalStats([server.pilots.connOf(A.pid)! as never]) };
}

/** Ore into its hold every 60 ticks (the hold's mass changes: it flies heavier from its next step) */
function loadUp(t: number, w: World): void {
  if (t % 60 !== 0) return;
  const pilots = w.server.pilots as unknown as { sessions: Map<unknown, { profile: { cargo: { id: string; n: number }[] } }> };
  const s = pilots.sessions.get(w.server.pilots.connOf(w.A.pid));
  s?.profile.cargo.push({ id: 'silicate', n: 40 });
}

describe('its own ship stepped by itself (CAPS.OWN_SIM)', () => {
  it('its hold filling: a CARGO cause (CAPS.CARGO), no keyframe of its ship to it or a watcher', () => {
    const r = fly({ watch: true, each: loadUp });
    expect(r.own.cargo).toBeGreaterThan(5);
    expect(r.got.keyframes).toBe(0);
    expect(r.got.off).toBe(0);
    expect(r.checks.bodyOff ?? 0).toBe(0);
    expect(r.seen.checked).toBeGreaterThan(50);
    expect(r.seen.off).toBe(0);
    expect(r.seen.keyframes).toBe(0);
  }, 120_000);

  it('flown by its own inputs: no control rows or keyframes of its own ship, its layer the server\'s ship, its checks agreeing', () => {
    const r = fly();
    // (A snapshot goes only when there's something to say: no rows, keyframes or control rows of its own ship, and since
    // SHOT_IDS no fire records of its own shells either, so a pilot alone with a parked dummy gets one now and then:
    // its layer is checked at each)
    expect(r.got.snapshots).toBeGreaterThan(5);
    expect(r.got.keyframes).toBe(0);
    expect(r.got.ctlRows).toBe(0);
    expect(r.got.checked).toBeGreaterThan(5);
    expect(r.got.off).toBe(0);
    expect(r.checks.checks).toBeGreaterThan(5);
    expect(r.checks.agreed).toBe(r.checks.checks - r.checks.stale);
    // (Every snapshot's head hash agreed with its layer: sim/headHash.ts)
    expect(r.w.A.own.stats.heads).toBeGreaterThan(5);
    expect(r.w.A.own.stats.headMisses).toBe(0);
    expect(r.journal.disagreed).toBe(0);
  }, 120_000);

  it('its aim held where it changes nothing (common sim/aimHold.ts): flat-out swings, the helm, firing: no rows, keyframes or misses', () => {
    for (const [aim, keys] of [
      [(t: number) => t * 0.17, undefined],
      [(t: number) => t * 0.05, (t: number) => ({ helm: true, right: t % 80 < 40, forward: t % 80 >= 40 })],
      [(t: number) => [0.3, 2.4, -1.2, 1.0, -2.8][Math.floor(t / 90) % 5] + 0.004 * Math.sin(t * 1.7), undefined],
    ] as [(t: number) => number, ((t: number) => Record<string, boolean>) | undefined][]) {
      const r = fly({ watch: true, aim, keys });
      const st = r.w.server.getShips().stats.aimHold;
      if (process.env.OWN_DEBUG) console.log('AIM', JSON.stringify({ got: r.got, checks: r.checks, seen: r.seen, st, client: r.w.A.own.stats }));
      expect(st.held).toBeGreaterThan(50);
      expect(r.got.keyframes).toBe(0);
      expect(r.got.ctlRows).toBe(0);
      expect(r.got.off).toBe(0);
      expect(r.got.headMisses).toBe(0);
      expect(r.checks.agreed).toBe(r.checks.checks - r.checks.stale);
      expect(r.seen.checked).toBeGreaterThan(50);
      expect(r.seen.off).toBe(0);
      expect(r.seen.keyframes).toBe(0);
      expect(r.journal.disagreed).toBe(0);
    }
  }, 240_000);

  it('pulled (TEMPORARY: a boss\'s magnet, sent as its push) and shoved by a ship it touches: causes, worked out exactly', () => {
    const r = fly({
      // A magnet's pull for a while
      pull: (t) => (t > 100 && t < 220 ? [0.031 * Math.sin(t / 9), -0.047] : null),
      each: (t, w) => {
        // A dummy brought right up against it (they touch, and push apart)
        if (t === 300) { Position.x[w.target] = Position.x[w.A.pid] + 40; Position.y[w.target] = Position.y[w.A.pid]; Velocity.x[w.target] = -2; }
      },
    });
    if (process.env.OWN_DEBUG) console.log('OWN', JSON.stringify({ got: r.got, own: r.own, checks: r.checks, client: r.w.A.own.stats }));
    expect(r.own.pull).toBeGreaterThan(50);
    expect(r.own.contact).toBeGreaterThan(0);
    expect(r.got.causes).toBeGreaterThan(50);
    // (no own row for what its causes moved: its snapshots carry the head hash instead, sim/headHash.ts)
    expect(r.got.causedRows).toBeLessThan(r.got.causes / 10);
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
    // (Its full state stays exact: the EMP is told as its hazards alone, once, as it lands; its end it works out itself)
    expect(r.got.headMisses).toBe(0);
    expect(r.got.syncs).toBe(0);
    expect(r.got.hazSyncs).toBe(1);
  }, 120_000);

  // (Found in the net table's Scrap Mother fight, docs/audits/sim-foundation-after-2026-11-06.md: the server held parts
  // it had restored dead, its client's step refilled them, an ownSync about once a second. Its other cause there, a
  // damaged generator's output from exact HP against its client's tenths: common power/ports.test.ts)
  const engines = (w: World) => {
    const s = w.server.getShips().get(w.A.pid)!;
    return s.blueprint.parts.map((p, i) => (/engine|drive|thruster/.test(p.fn) && s.derived.alive[i] ? i : -1)).filter((i) => i >= 0);
  };
  it('its hull restored over parts it lost (scaleHp, as the benches keep a pilot alive): rebuilt, its full state exact', () => {
    const r = fly({
      ship: 'halberd',
      each: (t, w) => {
        const ships = w.server.getShips();
        if (t === 150 || t === 330) for (const i of engines(w).slice(0, 3)) ships.damagePartFraction(w.A.pid, i, 1);
        if (t === 210 || t === 390) ships.scaleHp(w.A.pid, 1);
      },
    });
    expect(r.own.rebuild).toBeGreaterThanOrEqual(4);
    expect(r.got.headMisses).toBe(0);
    expect(r.got.syncs).toBe(0);
    expect(r.checks.bodyOff).toBe(0);
    expect(r.got.off).toBe(0);
  }, 120_000);

  it('rebuilt at one point a tick: parts lost, healed, repaired and regrown between ticks and mid-tick, once each tick, its layer exact', () => {
    const wing = (w: World) => {
      const s = w.server.getShips().get(w.A.pid)!;
      return s.blueprint.parts.map((p, i) => (p.fn !== 'core' && s.derived.alive[i] ? i : -1)).filter((i) => i >= 0);
    };
    const r = fly({
      // Between ticks (as a message is): two parts shot away and a heal, then a repair; each lands on the next tick's rebuild point
      each: (t, w) => {
        const ships = w.server.getShips();
        if (t === 150 || t === 330) { const live = wing(w); for (const i of live.slice(-2)) ships.damagePartFraction(w.A.pid, i, 1); ships.healAll(w.A.pid, 0.1); }
        if (t === 250 || t === 420) ships.repair(w.A.pid);
      },
      // During a tick (where a boss's brain acts): parts lost and the ship repaired in the same tick, then more lost
      mid: (t, w) => {
        const ships = w.server.getShips();
        if (t === 200) { for (const i of wing(w).slice(0, 2)) ships.damagePartFraction(w.A.pid, i, 1); ships.repair(w.A.pid); ships.damagePartFraction(w.A.pid, wing(w)[0], 1); }
      },
    });
    if (process.env.OWN_DEBUG) console.log('OWN', JSON.stringify({ reb: r.reb, got: r.got, own: r.own, checks: r.checks, client: r.w.A.own.stats }));
    expect(r.reb.repeats).toBe(0);
    expect(r.reb.own).toBeGreaterThanOrEqual(5);
    expect(r.own.rebuild).toBeGreaterThanOrEqual(3);
    expect(r.got.keyframes).toBe(0);
    expect(r.got.off).toBe(0);
    expect(r.checks.bodyOff).toBe(0);
    expect(r.journal.disagreed).toBe(0);
  }, 120_000);

  it('a cause it missed: its check catches it, a keyframe of its own ship puts it right, and it checks closely for a while', () => {
    const r = fly({ dropAt: 150, pull: (t) => (t > 100 && t < 200 ? [0.02, 0.03] : null) });
    expect(r.checks.bodyOff).toBeGreaterThan(0);
    expect(r.got.keyframes).toBeGreaterThan(0);
    expect(r.w.A.own.stats.fixes).toBeGreaterThan(0);
    // (The head hash caught it as well: its check went at once)
    expect(r.w.A.own.stats.headMisses).toBeGreaterThan(0);
    // (put right: the last snapshots' own layer is the server's again)
    expect(r.got.off).toBeLessThan(40);
  }, 120_000);

  it('late inputs after a hitch: the same controls as it flew cost nothing; changed ones a keyframe, then exact again', () => {
    const same = fly({ hitch: { from: 200, to: 210, same: true } });
    expect(same.got.keyframes).toBe(0);
    expect(same.got.off).toBe(0);
    expect(same.own.keyframes).toBe(0);
    const changed = fly({ hitch: { from: 200, to: 210, same: false } });
    expect(changed.got.keyframes).toBeGreaterThan(0);
    expect(changed.w.server.replication.ownStats.why['late input']).toBeGreaterThan(0);
    expect(changed.got.off).toBeLessThan(5);
  }, 120_000);

  it('docked: one keyframe of its own ship as it docks and one as it leaves, none between, its checks agreeing', () => {
    let station = -1;
    const r = fly({
      ticks: 520,
      each: (t, w) => {
        const A = w.A, srv = w.server;
        if (t === 60) {
          let bd = Infinity;
          for (const st of stationQuery(srv.getWorld())) { if (InSystem.systemId[st] !== InSystem.systemId[A.pid]) continue; const d = Math.hypot(Position.x[st] - Position.x[A.pid], Position.y[st] - Position.y[A.pid]); if (d < bd) { bd = d; station = st; } }
          Position.x[A.pid] = Position.x[station] + 150; Position.y[A.pid] = Position.y[station]; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
        }
        if (t === 100) A.link!.receive({ type: 'dock' } as ClientMessage);
        if (t === 420) A.link!.receive({ type: 'undock' } as ClientMessage);
      },
    });
    expect(station).toBeGreaterThanOrEqual(0);
    expect(r.w.A.own.stats.headMisses).toBe(0);
    // (the move beside the station, docking, undocking: no more)
    expect(r.got.keyframes).toBeLessThanOrEqual(4);
    expect(r.checks.checks).toBeGreaterThan(5);
    expect(r.checks.bodyOff).toBe(0);
  }, 120_000);
});

