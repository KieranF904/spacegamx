/**
 * A fight for decision-input tests (pilots.test.ts, customEnemies.test.ts): a real GameServer, a pilot (a fake client:
 * every client has the full caps set) flying by input messages on time and firing at the nearest hostile, a second
 * client watching from nearby, and packs (or a boss) round them. Every hostile either client runs is checked against
 * the server's ship at each snapshot's tick (the server's own state is the ground truth).
 */
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, DECISION, encodeMessage, decodeMessage, controlRowId, datan2,
  type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage, type ShipState,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { FakeHitsClient } from '../net/hits/fakeHitsClient.testkit.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

interface Got { snapshots: number; checked: number; off: number; keyframes: number; ctlRows: number; decisions: number; syncs: number; running: number; ran: Set<number>; offAt: string[]; ops: Record<string, number>; lastTick?: number }
const zero = (): Got => ({ snapshots: 0, checked: 0, off: 0, keyframes: 0, ctlRows: 0, decisions: 0, syncs: 0, running: 0, ran: new Set(), offAt: [], ops: {} });

export interface Opts {
  ticks?: number;
  /** The client loses this snapshot's decisions (the forced miss) */
  dropAt?: number;
  /** Packs: ships each, and where from the pilot (and their faction: pirates by default) */
  packs?: { ships: string[]; dx: number; dy: number; faction?: string }[];
  /** At this tick every hostile loses the parts with these uids (a custom enemy's piece: all its parts) */
  loseAt?: number;
  /** Every pack ship hunts the pilot (out here it's in safe space: else only what it shoots turns on it) */
  prey?: boolean;
  lose?: (ship: ShipState, uid: number) => boolean;
  /** A boss the enemy AI flies (bosses.json without a brain), this far off; its escorts come as its phases do */
  boss?: string;
  /** Its hull brought down to this share at this tick (its phases: escorts, novas, blinks) */
  hurtAt?: number;
  hurt?: number;
  /** Before each tick (between ticks, as a message is): `foes` the hostiles now */
  each?: (t: number, server: GameServer, foes: number[]) => void;
}

export function fight(o: Opts = {}) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
  });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  /** Every mob's state at each tick's end, and A's mobs (CAPS.WAYPOINTS) against it on every tick it steps them */
  const mobTruth = new Map<string, number[]>();
  const mobs = { checked: 0, off: 0, firstOff: '' };
  const A = new FakeHitsClient(server, {
    name: 'pilots_a', env,
    onGuideStep: (id, t, m) => {
      const s = mobTruth.get(`${id}:${t}`);
      if (!s) return;
      mobs.checked++;
      if (s[0] !== m.x || s[1] !== m.y || s[2] !== m.vx || s[3] !== m.vy || s[4] !== (m.a ?? 0)) { mobs.off++; if (!mobs.firstOff) mobs.firstOff = `${id}@${t}: ${JSON.stringify(m)} vs ${s}`; }
    },
  });
  const B = new FakeHitsClient(server, { name: 'watcher_b', env });
  // (every hostile, escorts spawned mid-fight too)
  const foe = { has: (id: number) => ships.has(id) && !!server.enemies.factionOf(id) };
  const foeIds = () => [...ships.bodies.keys()].filter((id) => foe.has(id));
  /** Every hostile's real state at each tick's end */
  const truth = new Map<number, Map<number, number[]>>();
  const got = { A: zero(), B: zero() };
  const real = (id: number) => [Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], Rotation.angle[id], ships.get(id)!.angVel];
  const now = () => { const m = new Map<number, number[]>(); for (const id of foeIds()) m.set(id, real(id)); return m; };
  const watch = (f: FakeHitsClient, g: Got, drop?: () => boolean) => {
    const fa = f as unknown as { snapshot(s: ServerSnapshotMessage): void };
    const orig = fa.snapshot.bind(f);
    fa.snapshot = (s) => {
      if (drop?.() && s.decisions?.some((d) => foe.has(d[0]) && d[2] !== DECISION.SYNC)) s = { ...s, decisions: s.decisions.filter((d) => !foe.has(d[0]) || d[2] === DECISION.SYNC) };
      const running = new Set(f.bodies?.ids() ?? []);
      orig(s);
      g.snapshots++;
      (g as { lastTick?: number }).lastTick = s.tick;
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
        if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4] || st.angVel !== r[5]) { g.off++; if (g.offAt.length < 8) g.offAt.push(`${id}@${s.tick}:${[st.x - r[0], st.y - r[1], st.vx - r[2], st.vy - r[3], st.angle - r[4], st.angVel - r[5]].map((v) => +v.toPrecision(3)).join(",")}${s.ships?.some((k) => k[0] === id) ? ":kf" : ""}:own${s.ships?.some((k) => k[0] === f.pid) ? "kf" : ""}:tg${server.enemies.targetOf(id)}=${f.pid}/${B.pid}:tkf${s.ships?.some((k) => k[0] === server.enemies.targetOf(id)) ? 1 : 0}:boss${boss}:cz${JSON.stringify(s.causes?.filter((c) => c.includes(id)))}:d${JSON.stringify(s.decisions?.filter((d) => d[0] === id))}:ctl${JSON.stringify(s.ctl?.filter((c) => controlRowId(c) === id))}:prev${s.tick - (g.lastTick ?? 0)}`); }
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
    for (const id of foeIds()) {
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
    for (const [eid] of server.mobs.guided()) mobTruth.set(`${eid}:${server.getTick()}`, [Position.x[eid], Position.y[eid], Velocity.x[eid], Velocity.y[eid], Rotation.angle[eid]]);
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
  let boss = -1;
  if (o.boss) boss = server.bosses.spawnAt(o.boss, num, x0 + 1800, y0);
  for (const p of o.packs ?? (o.boss ? [] : [{ ships: ['pirate_raider', 'pirate_skiff', 'pirate_skiff'], dx: 1500, dy: 900 }, { ships: ['pirate_raider'], dx: -2500, dy: -600 }])) {
    const ids = server.enemies.spawnPack(num, { faction: p.faction ?? 'pirates', ships: p.ships } as never, x0 + p.dx, y0 + p.dy);
    if (o.prey) for (const id of ids) server.enemies.setPrey(id, A.pid, true);
  }
  for (let t = 0; t < (o.ticks ?? 900); t++) {
    if (o.hurtAt === t && ships.has(boss)) {
      // (its hull brought down: every part to this share, as many hits would, so its phases come)
      ships.setPartHp(boss, () => o.hurt ?? 0.5);
    }
    if (o.loseAt === t && o.lose) for (const id of foeIds()) { const sh = ships.get(id)!; ships.setPartHp(id, (uid) => (o.lose!(sh, uid) ? 0 : 1)); }
    o.each?.(t, server, foeIds());
    step(t);
  }
  return { server, got, A, B, boss, mobs, stats: server.bodies.stats, rep: server.replication.bodyStats };
}
