/**
 * Other ships' shells on the PT timeline (C3; client predict/kinds/shellsKind.ts over ships/guns/OtherGuns.ts): drawn on
 * the tick they're fired, ahead of the snapshot that tells of it, and where the server's shell is.
 *
 * A real GameServer and a watcher A (a fake client, full caps) on a fake transport with LAT ticks each way, its PT layer
 * (the game's PtStLayer over the replica layer, as the crowd probe's) stepped to its own predicted tick and the shells
 * kind drawing other ships' volleys ahead (a fake renderer keeps each predicted shell). Another pilot B fires in bursts
 * (held last input on PT: a burst's first ticks and its end are mispredicted, and taken back); an AI pack fights A
 * (flown by its bodies: decided). Each server shell of theirs is looked for among what A drew ahead of its snapshot.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, InSystem, Projectile, encodeMessage, decodeMessage, parseBlueprint, otherShotWireOf, fireVolley,
  type ReplicaEnv, type ClientMessage, type Blueprint, type FlightBody, type LaneRec,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { PtStLayer } from '../../../../client/src/predict/ptst.js';
import { ReplicaPtWorld } from '../../../../client/src/predict/world.js';
import { ShellsKind } from '../../../../client/src/predict/kinds/shellsKind.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const LAT = 4;

interface Drawn { owner: number; t: number; x: number; y: number; vx: number; vy: number; confirmed: number; retracted: boolean }

function ptFight(who: 'pilot' | 'ai') {
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
  const down: { at: number; data: Uint8Array }[] = [];
  const A = new FakeHitsClient(server, { name: 'watcher', env, defer: (data) => down.push({ at: server.getTick() + LAT, data }) });
  const B = new FakeHitsClient(server, { name: 'gunner', env });
  const up: { at: number; msg: ClientMessage }[] = [];
  let seqA = 1, seqB = 1;
  const input = (msg: Record<string, unknown>, seq: number) => decodeMessage(encodeMessage({ type: 'input', seq, tick: 0, targetTick: server.getTick() + 1 + LAT, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0, cursorDist: 400, ...msg } as unknown as ClientMessage) as ArrayBuffer) as ClientMessage;

  // (A's PT layer, as the game's: its own predicted tick LAT + LAT ahead of the snapshots it has)
  const ptWorld = new ReplicaPtWorld({
    reps: A.reps, store: A.store, bodies: A.bodies, tuning: A.store.tuning,
    self: () => A.pid, confirmed: () => A.snapTick, predicted: () => server.getTick() + LAT, candidates: () => A.reps.ids(),
  });
  const layer = new PtStLayer(ptWorld, { touch: true });
  const drawn = new Map<number, Drawn>(), handles = new Map<number, number>();
  let nextHandle = 1;
  const shells = new ShellsKind({
    layer, kind: (id) => ptWorld.kind(id)?.name, guns: A.otherGuns, tuning: A.store.tuning, confirmed: () => A.snapTick,
    ship: (id) => { const s = A.store.get(id); return s && s.kind === 'ship' ? s : undefined; },
    env: () => env(A.pid),
    pose: (id, t) => A.reps.preAt(id, t),
    draw: (owner: number, t: number, rec: LaneRec, pose: FlightBody) => {
      const ship = A.store.get(owner)!;
      const v = fireVolley({ owner, tick: t, part: rec.part, aimQ: rec.aimQ, ammo: 0, aug: rec.aug ? 1 : undefined }, ship as never, pose, A.store.tuning);
      const out: number[] = [];
      v?.shells.forEach((sh, i) => {
        const h = nextHandle++, name = otherShotWireOf(owner, t, rec.part, i);
        handles.set(h, name);
        // (the latest drawing of that shot is the one that stands)
        drawn.set(name, { owner, t, x: sh.x, y: sh.y, vx: sh.vx, vy: sh.vy, confirmed: A.snapTick, retracted: false });
        out.push(h);
      });
      return out;
    },
    retract: (h) => { const n = handles.get(h), d = n !== undefined ? drawn.get(n) : undefined; if (d) d.retracted = true; },
  });

  const truth = new Map<number, number[]>();
  const watched = new Set<number>([B.pid]);
  const fired = ships.fired, push = fired.push.bind(fired);
  fired.push = (...fs) => {
    for (const f of fs) {
      if (!watched.has(f.owner) || !f.shots) continue;
      f.ids.forEach((eid, k) => truth.set(otherShotWireOf(f.owner, f.tick, f.part, k), [Projectile.spawnX[eid], Projectile.spawnY[eid], Velocity.x[eid], Velocity.y[eid], f.tick]));
    }
    return push(...fs);
  };
  let script: (t: number) => Record<string, unknown> = () => ({});
  const step = (t: number) => {
    up.push({ at: server.getTick() + LAT, msg: input({}, seqA++) });
    const mb = input(script(t), seqB++);
    B.noteInput(mb);
    B.link!.receive(mb);
    while (up.length && up[0].at <= server.getTick()) { const m = up.shift()!.msg; A.noteInput(m); A.link!.receive(m); }
    server.step();
    clock.t += 1000 / 60;
    while (down.length && down[0].at <= server.getTick()) A.frame(down.shift()!.data);
    for (const c of [A, B]) {
      const chk = c.own.takeCheck(true, server.getTick());
      if (chk) { if (c === A) up.push({ at: server.getTick() + LAT, msg: input({ ownCheck: chk }, seqA++) }); else { const m = input({ ownCheck: chk }, seqB++); B.link!.receive(m); } }
      const rep = c.selfHits.takeReport(true);
      if (rep) server.hits.report(server.pilots.connOf(c.pid)! as never, rep);
      for (const m of c.outbox.splice(0)) c.link?.receive(m);
    }
    if (A.snapTick > 0) {
      layer.confirm(A.snapTick);
      shells.confirm(A.snapTick);
      layer.advance(server.getTick() + LAT);
      shells.advance(server.getTick() + LAT);
    }
  };
  for (let i = 0; i < 20; i++) step(-1);
  for (const c of [A, B]) { const cc = server.pilots.connOf(c.pid)! as unknown as { isAdmin: boolean }; cc.isAdmin = true; server.admin.run(cc as never, 'god', { on: 'on' }); cc.isAdmin = false; }
  const num = InSystem.systemId[A.pid];
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  const place = (pid: number, x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
  place(A.pid, x0, y0);
  if (who === 'pilot') {
    const b = parseBlueprint(JSON.stringify(ships.library.get('sparrow-t')!)) as Blueprint;
    const pips = b.parts.filter((q) => q.fn === 'cannon_pip');
    pips[1].fn = 'autocannon_chainsaw';
    ships.respawnInPlace(B.pid, b);
    place(B.pid, x0 + 900, y0);
    for (let t = -60; t < 0; t++) step(-1);
    // (bursts a second and a half long, the aim moved between some of them: held input foresees a burst's body, not its start)
    script = (t) => ({ fireLeft: t % 150 < 90, targetAngle: -Math.PI / 2 + 0.2 * Math.floor(t / 300), cursorDist: 500 });
    for (let t = 0; t < 1200; t++) step(t);
  } else {
    place(B.pid, x0 - 20000, y0);
    // (it hunts A: out here is safe space, where a pack spares a pilot that hasn't hurt it, so a fight would hang on a
    // ship of it happening to bump into A first, as testkits/decisionFight.testkit.ts `prey`)
    const pack = server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff', 'pirate_skiff'] }, x0 + 1400, y0 - 600);
    for (const id of pack) server.enemies.setPrey(id, A.pid, true);
    for (let t = 0; t < 1200; t++) {
      for (const [eid] of ships.bodies) if (server.enemies.factionOf(eid)) watched.add(eid);
      step(-1);
    }
  }
  script = () => ({});
  for (let t = 0; t < 120; t++) step(-1);
  // Each server shell of theirs: drawn ahead (before A's snapshot of its tick), and where the server's is
  let ahead = 0, exact = 0, late = 0, off = 0;
  for (const [name, t] of truth) {
    const d = drawn.get(name);
    if (!d || d.retracted) { late++; continue; }
    if (d.confirmed < t[4]) ahead++;
    if (d.x === t[0] && d.y === t[1] && d.vx === t[2] && d.vy === t[3]) exact++; else off++;
  }
  // (and what it drew that the server never fired, still standing: wrong)
  let wrong = 0;
  for (const [name, d] of drawn) if (!d.retracted && !truth.has(name) && d.t < server.getTick() - 2 * LAT) wrong++;
  return { truth: truth.size, ahead, exact, late, off, wrong, stats: { ...shells.stats }, laneStats: { ...A.otherGuns.stats } };
}

describe('other ships\' shells on the PT timeline (C3)', () => {
  it('another pilot (held last input): its shells drawn on their fire tick ahead of the snapshot, exactly the server\'s', () => {
    const r = ptFight('pilot');
    if (process.env.GUNS_DEBUG) console.log(JSON.stringify(r));
    expect(r.truth).toBeGreaterThan(100);
    // (drawn ahead: all but a burst's first shells, which held input can't foresee, and are drawn once the trigger is told)
    expect(r.ahead / r.truth).toBeGreaterThan(0.7);
    expect(r.off).toBe(0);
    expect(r.exact + r.late).toBe(r.truth);
    expect(r.wrong).toBe(0);
  }, 300_000);

  it('an AI pack (flown by its bodies, decided): its shells drawn on their fire tick ahead of the snapshot, exactly the server\'s', () => {
    const r = ptFight('ai');
    if (process.env.GUNS_DEBUG) console.log(JSON.stringify(r));
    expect(r.truth).toBeGreaterThan(30);
    // (a decision the snapshots haven't told yet (a new order, a target switch) makes what it fires ahead of it late)
    expect(r.ahead / r.truth).toBeGreaterThan(0.8);
    expect(r.exact + r.late).toBe(r.truth);
    expect(r.off).toBe(0);
    expect(r.wrong).toBe(0);
  }, 300_000);
});
