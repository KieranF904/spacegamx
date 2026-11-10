/**
 * A freighter shooting back at a pilot (game/enemies/defenders.ts), on that pilot's tick layer: its body (the enemy AI
 * pilot's HAUL order, common bodies/aiPilot.ts) flies its course and fires its guns there, so the pilot builds its
 * shells from its gun lane (common sim/otherGuns.ts, server net/guns/GunNet.ts) and the server sends no fire records of
 * them bar the ticks it tells (the first volley after a quiet spell, with the gunSync). Each shell the pilot built is
 * held to the server's projectile with the same shot: spawn point, velocity, exactly; its lanes to the server's, by hash.
 *
 * A real GameServer; the pilot A (a fake client, full caps, the game's client classes) sits off a Ceres Hauler's course,
 * shoots it as it goes by, then stops; the hauler shoots back for its 30 s, its autopilot on its course throughout.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  DECISION, Position, Velocity, InSystem, Projectile, encodeMessage, decodeMessage, otherShotWireOf, laneHash,
  type ReplicaEnv, type ClientMessage,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../ships/createShipBridge.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { DEFEND_QUIET_TICKS } from '../../game/enemies/defenders.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

describe('a freighter shooting back, on its attacker\'s tick layer', () => {
  it("its shells built from its lane are the server's exactly, its fire records not sent; its course its autopilot's", () => {
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
    const A = new FakeHitsClient(server, { name: 'attacker', env });
    let seq = 1;
    const post = (msg: Record<string, unknown>) => {
      const m = { type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0, cursorDist: 400, ...msg } as unknown as ClientMessage;
      const dec = decodeMessage(encodeMessage(m) as ArrayBuffer) as ClientMessage;
      A.noteInput(dec);
      A.link!.receive(dec);
    };
    let hauler = -1;
    // (the hauler's shells as spawned, under the name A gives the shell with that shot id; the fire records A was sent of it)
    const truth = new Map<number, number[]>();
    const fired = ships.fired, push = fired.push.bind(fired);
    fired.push = (...fs) => {
      for (const f of fs) {
        if (f.owner !== hauler || !f.shots) continue;
        f.ids.forEach((eid, k) => truth.set(otherShotWireOf(f.owner, f.tick, f.part, k), [Projectile.spawnX[eid], Projectile.spawnY[eid], Velocity.x[eid], Velocity.y[eid]]));
      }
      return push(...fs);
    };
    let told = 0;
    const origSnap = (A as unknown as { snapshot: (s: { fire?: number[][] }) => void }).snapshot.bind(A);
    (A as unknown as { snapshot: (s: { fire?: number[][] }) => void }).snapshot = (s) => {
      for (const f of s.fire ?? []) if (f[0] === hauler) told++;
      origSnap(s);
    };
    let laneChecks = 0, bodyTicks = 0;
    const laneOff: string[] = [];
    const course: ({ x: number; y: number } | null)[] = [];
    let script: (t: number) => Record<string, unknown> = () => ({});
    const step = (t: number) => {
      post(script(t));
      server.step();
      clock.t += 1000 / 60;
      const chk = A.own.takeCheck(true, server.getTick());
      if (chk) post({ ownCheck: chk });
      const rep = A.selfHits.takeReport(true);
      if (rep) server.hits.report(server.pilots.connOf(A.pid)! as never, rep);
      for (const m of A.outbox.splice(0)) A.link?.receive(m);
      const l = server.gunNet.lanes.get(hauler);
      if (l) {
        const h = A.otherGuns.hashAt(hauler, l.at);
        if (h !== undefined) { laneChecks++; if (h !== laneHash(hauler, l.x, l.pd)) laneOff.push(`${l.at}`); }
      }
      if (hauler >= 0) { course.push(ships.autopilotOf(hauler)); if (server.enemies.aiBodyOn(hauler)) bodyTicks++; }
    };
    for (let i = 0; i < 20; i++) step(-1);
    const ops: Record<string, number> = {};
    const dec = server.bodies.decide.bind(server.bodies);
    server.bodies.decide = (eid, op, args, st) => { if (eid === hauler) { const k = `${op}:${op === DECISION.WANT ? JSON.stringify(args) : ''}`; ops[k] = (ops[k] ?? 0) + 1; } return dec(eid, op, args, st); };
    const cc = server.pilots.connOf(A.pid)! as unknown as { isAdmin: boolean };
    cc.isAdmin = true; server.admin.run(cc as never, 'god', { on: 'on' }); cc.isAdmin = false;
    const num = InSystem.systemId[A.pid];
    const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
    ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
    Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
    // A hauler on a straight course past A's side (as a Ceres Hauler on its route: an autopilot leg), a defender
    hauler = ships.spawnDummy(ships.library.get('hauler')!, x0 - 900, y0 + 1500, -Math.PI / 2, num);
    server.enemies.defend(hauler);
    const to = { x: x0 - 900, y: y0 - 60000, arriveRadius: 700 };
    ships.setAutopilot(hauler, to);
    for (let t = -40; t < 0; t++) step(-1);
    const aimAt = () => ({ targetAngle: Math.atan2(Position.y[hauler] - Position.y[A.pid], Position.x[hauler] - Position.x[A.pid]), cursorDist: Math.min(1500, Math.hypot(Position.y[hauler] - Position.y[A.pid], Position.x[hauler] - Position.x[A.pid])) });
    // A shoots it as it comes by, then holds fire and only turns to watch it. (A starter's Pips alone stay under a
    // freighter's tolerance for strays, so a heavy shell of A's lands early on: past it, the hauler shoots back)
    script = (t) => ({ ...aimAt(), fireLeft: t < 150 && t % 40 < 25 });
    let locked = false;
    const heavy = (server.enemies.defenders as unknown as { list: Map<number, { tolerance: number }> }).list.get(hauler)!.tolerance * 1.1;
    for (let t = 0; t < DEFEND_QUIET_TICKS + 600; t++) {
      if (t === 30) for (let i = 0, left = heavy; left > 0 && i < ships.get(hauler)!.hp.length; i++) if (ships.get(hauler)!.blueprint.parts[i].fn !== 'core' && ships.get(hauler)!.hp[i] > 40) left -= ships.damagePartBy(hauler, i, Math.min(30, left), A.pid);
      step(t);
      if (server.enemies.defenders.attackerOf(hauler) === A.pid) locked = true;
    }
    script = () => ({});

    // (A's shells of the hauler, each the server's exactly)
    let exact = 0;
    const inexact: string[] = [];
    for (const [id, sh] of A.otherShells) {
      if (sh.owner !== hauler) continue;
      const t = truth.get(id);
      if (!t) { inexact.push(`${id}: no server shell`); continue; }
      if (sh.x === t[0] && sh.y === t[1] && sh.vx === t[2] && sh.vy === t[3]) exact++;
      else inexact.push(`${id}: client ${[sh.x, sh.y, sh.vx, sh.vy]} server ${t}`);
    }
    if (process.env.GUNS_DEBUG) console.log(JSON.stringify({ locked, exact, truth: truth.size, told, laneChecks, laneOff: laneOff.length, bodyTicks, stats: server.gunNet.stats, lane: A.otherGuns.stats, inexact: inexact.slice(0, 5) }));
    expect(locked).toBe(true);
    expect(bodyTicks).toBeGreaterThan(300);
    // (its two Rattlers and two light Overpulses: about 30 shells in this pass)
    expect(truth.size).toBeGreaterThan(4);
    expect(inexact).toEqual([]);
    expect(exact).toBeGreaterThan(3);
    // (its fire records to A: the told ticks only, far fewer than the shells A built itself)
    // (and with so few shells the one told, the first volley after a quiet spell, is a fifth of them or more: at most that one)
    expect(told).toBeLessThanOrEqual(1);
    expect(told).toBeLessThan(exact);
    expect(server.gunNet.stats.fixes).toBe(0);
    // (held where A stepped its lane: while it was lately firing, GUN_ACTIVE)
    expect(laneChecks).toBeGreaterThan(5);
    expect(laneOff).toEqual([]);
    // (it kept its autopilot course all along)
    for (const c of course) expect(c).toEqual({ x: to.x, y: to.y, arriveRadius: to.arriveRadius });
    expect(server.enemies.defenders.attackerOf(hauler)).toBe(-1);
    // (its body, as A ran it, the server's ship throughout: nothing it flew made a bodied shadow leave the real ship
    // (Replication), and what it cost on the wire is its SYNC as it turned on and its OFF as it went quiet: its course's
    // point held, its target one attacker, no other decisions of it)
    const rep = server.replication.bodyStats;
    if (process.env.GUNS_DEBUG) console.log(JSON.stringify({ bodies: server.bodies.stats, rep, ops }));
    expect(rep.stepped).toBeGreaterThan(300);
    expect(Object.values(rep.why).reduce((a, b) => a + b, 0)).toBe(0);
    expect(ops).toEqual({ [`${DECISION.SYNC}:`]: 1, [`${DECISION.OFF}:`]: 1 });
  }, 300_000);
});
