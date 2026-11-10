/**
 * Custom enemies against a pilot, headless (docs/enemies/custom-roster.md): how well they fight and how cleanly they
 * replicate. A real GameServer; pilot A is a fake client with every cap, its frames LAT ticks late, its inputs on time;
 * the packs hunt it. Per design it counts:
 *
 *   fight   moves started; shells fired by moves and guns, and how many were aimed to meet A (A's path held straight
 *           from the shot's tick: the shot's line comes within A's radius while the shell lives); strikes (splash,
 *           beams, the torch) and how many touched A; damage dealt a second; the time to deal a starter's worth
 *   net     keyframes of its ships A runs (corrections) and tick-layer disagreements with the server, a second;
 *           decisions a second
 *   motion  how often its thrust reverses tick to tick (|dv| both ticks over a hair, opposite ways) and its turn
 *           reverses, a ship-second; and A's drawn pose (ShipReplicaSet.pose at a render tick DELAY behind, half ticks)
 *           against the server's path there: the mean and worst gap, and frames off by more than 6 units
 *
 *   npx tsx src/bench/customFight.ts [secs=30]
 *   env PACK=helios_drone,helios_drone FACTION=helios  PILOT=strafe|still|weave|chase  FIRE=1  REAL=1 (A takes its
 *       damage and the run ends when it dies; else A soaks it: recorded, not dealt)  LAT=3  DELAY=8  TRACE=<n>: the
 *       n-th hostile's path, tick by tick, server and client  SOL=1: A stays where it joined (Sol, the drones' ground)
 *       PASSIVE=1: the pack spawns passive (A must shoot it to start the fight)  DIST=1400  JSON=out.json
 */
import { join, dirname } from 'path';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasComponent } from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, Dead, DECISION, inSafeSpace, encodeMessage, decodeMessage, controlRowId, datan2, dcos, dsin,
  type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { FakeHitsClient } from '../net/hits/fakeHitsClient.testkit.js';

// (The payout dice's secret fixed too, as Math.random is: the same run every time. game/payoutDice.ts)
process.env.PAYOUT_SECRET ??= 'bench';
{
  let seed = Number(process.env.SEED ?? 0x2545f491);
  Math.random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '../../../data');
const secs = Number(process.argv[2]) || 30;
const LAT = Number(process.env.LAT ?? 3), DELAY = Number(process.env.DELAY ?? 8);
const PILOT = process.env.PILOT ?? 'strafe', FIRE = process.env.FIRE === '1', REAL = process.env.REAL === '1';
const PACK = (process.env.PACK ?? 'helios_drone,helios_drone,helios_drone').split(',');
const FACTION = process.env.FACTION ?? 'helios';
const DIST = Number(process.env.DIST ?? 1400);

const clock = { t: 1_000_000 };
const server = new GameServer({
  gameData: new GameData(readGameDataFiles(dataDir)),
  userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
  scene: 'sectors', autoStart: false,
  ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  clock: () => clock.t,
  crowd: true,
} as never);
const ships = server.getShips();
const T = () => server.getTick();
const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
const down: { at: number; data: Uint8Array }[] = [];
const A = new FakeHitsClient(server, { name: 'fight_a', env, defer: (data) => down.push({ at: T() + LAT, data }) });
const up: { at: number; msg: ClientMessage }[] = [];

const custom = server.enemies.custom as unknown as { live: Map<number, { design: string; move: { move: number; start: number } | null }>; stats: { moves: Record<string, number> } };
const designOf = (id: number) => custom.live.get(id)?.design;
const foes = () => [...ships.bodies.keys()].filter((id) => custom.live.has(id));

// ---- the fight's tally, by design ----
interface Tally {
  shipTicks: number; speedSum: number; speedMax: number; contactDmg: number; contactTicks: number; lastContact: number; shots: number; aimed: number; near: number; strikes: number; struck: number; dmg: number; dmgShots: number;
  kf: number; off: number; checked: number; decisions: number; ctl: number; ops: Record<string, number>;
  thrustRev: number; turnRev: number; flips: number; drawn: number; drawnSum: number; drawnMax: number; drawnBad: number;
}
const tally = new Map<string, Tally>();
const of = (d: string | undefined) => {
  const k = d ?? '?';
  let t = tally.get(k);
  if (!t) tally.set(k, (t = { shipTicks: 0, speedSum: 0, speedMax: 0, contactDmg: 0, contactTicks: 0, lastContact: -1, shots: 0, aimed: 0, near: 0, strikes: 0, struck: 0, dmg: 0, dmgShots: 0, kf: 0, off: 0, checked: 0, decisions: 0, ctl: 0, ops: {}, thrustRev: 0, turnRev: 0, flips: 0, drawn: 0, drawnSum: 0, drawnMax: 0, drawnBad: 0 }));
  return t;
};
let measuring = false;

// Shells: aimed to meet A if its line comes within A's radius (plus the shell's) while it lives, A held straight;
// `near` if it came that close to where A really went (worked out at the end, from A's path)
const shells: { d: string; x: number; y: number; vx: number; vy: number; t: number; life: number; r: number }[] = [];
const aPath = new Map<number, [number, number]>();
const weapons = (ships as unknown as { tuning: { weapons: Record<string, { speed?: number; life?: number; size?: number }> } }).tuning.weapons;
const host = (custom as unknown as { host: { fire?: (o: number, k: string, x: number, y: number, a: number, d: number, opts?: unknown) => void; ships: unknown } }).host;
const fire0 = host.fire;
host.fire = (o, k, x, y, a, d, opts) => {
  if (measuring && designOf(o)) {
    const t = of(designOf(o));
    t.shots++;
    const w = weapons[k] ?? {}, sp = w.speed ?? 40, life = w.life ?? 100, r = (ships.get(A.pid)?.derived.radius ?? 60) + (w.size ?? 1) * 6;
    const svx = dcos(a) * sp, svy = dsin(a) * sp;
    // (relative motion: A's position less the shell's, from the shot's tick)
    const rx = Position.x[A.pid] - x, ry = Position.y[A.pid] - y, rvx = Velocity.x[A.pid] - svx, rvy = Velocity.y[A.pid] - svy;
    const vv = rvx * rvx + rvy * rvy, tc = vv > 0 ? Math.max(0, Math.min(life, -(rx * rvx + ry * rvy) / vv)) : 0;
    if (Math.hypot(rx + rvx * tc, ry + rvy * tc) <= r) t.aimed++;
    shells.push({ d: designOf(o)!, x, y, vx: svx, vy: svy, t: T(), life, r });
  }
  fire0?.(o, k, x, y, a, d, opts);
};
// Strikes: splash at a point, and a line's burn (counted once a tick a ship)
const sh = ships as unknown as Record<string, (...a: unknown[]) => unknown>;
const splash0 = sh.splashAt.bind(ships);
sh.splashAt = (num: unknown, x: unknown, y: unknown, radius: unknown, damage: unknown, source: unknown, ...rest: unknown[]) => {
  const d = designOf(source as number);
  // (not the Slag Ray's: its splashes are its wake's pools burning, ground denied, not shots at you)
  if (measuring && d && d !== 'slag_ray') { const t = of(d); t.strikes++; if (Math.hypot(Position.x[A.pid] - (x as number), Position.y[A.pid] - (y as number)) <= (radius as number) + (ships.get(A.pid)?.derived.radius ?? 60)) t.struck++; }
  return splash0(num, x, y, radius, damage, source, ...rest);
};
// Its thrust controls tick to tick: how often they change (its engines flickering on and off, or swapping ways)
const lastBits = new Map<number, number>();
{
  const P = (server.enemies as unknown as { pilots: { orders: (eid: number, out: { bits: number }, ...r: unknown[]) => unknown } }).pilots;
  const o0 = P.orders.bind(P);
  P.orders = (eid, out, ...r) => {
    const b = out.bits & 15, was = lastBits.get(eid);
    if (measuring && was !== undefined && was !== b && designOf(eid)) of(designOf(eid)).flips++;
    lastBits.set(eid, b);
    return o0(eid, out, ...r);
  };
}
// Damage A takes, by who dealt it (soaked unless REAL)
let dmgShot = false;
const hurt0 = sh.hurt.bind(ships);
sh.hurt = (eid: unknown, ship: unknown, part: unknown, amount: unknown, source: unknown, vs: unknown) => {
  if (eid !== A.pid) return hurt0(eid, ship, part, amount, source, vs);
  const d = designOf(source as number);
  if (measuring && d) {
    const t = of(d);
    t.dmg += amount as number;
    if (dmgShot) t.dmgShots += amount as number;
    // (a contact's: no hit, splash or point with it)
    if (vs === undefined) { t.contactDmg += amount as number; if (t.lastContact !== T()) { t.lastContact = T(); t.contactTicks++; } }
  }
  return REAL ? hurt0(eid, ship, part, amount, source, vs) : 0;
};

// ---- the client's view: keyframes, disagreements, decisions, its drawn pose ----
const truth = new Map<number, Map<number, number[]>>();
const real = (id: number) => [Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], Rotation.angle[id], ships.get(id)!.angVel];
{
  const fa = A as unknown as { snapshot(s: ServerSnapshotMessage): void };
  const orig = fa.snapshot.bind(A);
  let lastS = -1;
  fa.snapshot = (s) => {
    const held = new Set<number>(A.reps.ids());
    if (measuring) {
      for (const k of s.ships ?? []) if (held.has(k[0]) && designOf(k[0])) of(designOf(k[0])).kf++;
      for (const c of s.ctl ?? []) if (designOf(controlRowId(c))) of(designOf(controlRowId(c))).ctl++;
      for (const d of s.decisions ?? []) if (designOf(d[0]) && d[2] !== DECISION.SYNC) { const g = of(designOf(d[0])), k = d[2] === DECISION.WANT ? `W${d[3]}` : `op${d[2]}`; g.decisions++; g.ops[k] = (g.ops[k] ?? 0) + 1; }
    }
    orig(s);
    if (process.env.DBG && traced >= 0) {
      const rep = (A.reps as unknown as { reps: Map<number, { fixes?: unknown[]; kf: number; last: number }> }).reps.get(traced);
      const kf = s.ships?.some((k) => k[0] === traced), dec = s.decisions?.filter((d) => d[0] === traced), cz = s.causes?.filter((c) => (c as number[]).includes(traced));
      if (kf || dec?.length || cz?.length || rep?.fixes) trace.push(`  SNAP ${s.tick} at ${T()} kf=${kf} dec=${JSON.stringify(dec)} causes=${JSON.stringify(cz)} fixes=${JSON.stringify(rep?.fixes)} last=${rep?.last}`);
    }
    if (measuring) for (const id of A.reps.ids()) {
      const d = designOf(id);
      if (!d) continue;
      for (let t = Math.max(lastS + 1, s.tick - 8); t <= s.tick; t++) {
        const st = A.reps.at(id, t)?.body, r = truth.get(t)?.get(id);
        if (!st || !r) continue;
        const g = of(d);
        g.checked++;
        if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4] || st.angVel !== r[5]) g.off++;
      }
    }
    lastS = s.tick;
  };
}

// ---- A ----
let seq = 1;
let chk: unknown, bck: unknown;
const chkQ: { at: number; v: unknown }[] = [], bckQ: { at: number; v: unknown }[] = [];
const nearest = () => {
  let best = -1, bd = Infinity;
  for (const id of foes()) { const d = Math.hypot(Position.x[id] - Position.x[A.pid], Position.y[id] - Position.y[A.pid]); if (d < bd) { bd = d; best = id; } }
  return best;
};
let lastKey = '';
const send = (t: number) => {
  const n = nearest();
  const dx = n >= 0 ? Position.x[n] - Position.x[A.pid] : 1, dy = n >= 0 ? Position.y[n] - Position.y[A.pid] : 0, d = Math.hypot(dx, dy) || 1;
  let mx = 0, my = 0, boost = false;
  if (PILOT === 'strafe' && n >= 0) {
    // Round it, the way a pilot circles a target: across its line, in or out to hold 600-1100, turning about every 4 s
    const side = Math.floor(t / 240) % 2 ? 1 : -1, ux = dx / d, uy = dy / d;
    const radial = d > 1100 ? 0.7 : d < 600 ? -0.7 : 0;
    mx = -uy * side + ux * radial; my = ux * side + uy * radial;
  } else if (PILOT === 'weave') {
    const phase = Math.floor(t / 50) % 4;
    my = phase === 0 ? -1 : phase === 2 ? 1 : 0; mx = phase === 1 ? -1 : phase === 3 ? 1 : 0;
  } else if (PILOT === 'chase' && n >= 0 && d > 500) { mx = dx / d; my = dy / d; boost = d > 1500; }
  while (chkQ.length && chkQ[0].at <= T()) chk = chkQ.shift()!.v;
  while (bckQ.length && bckQ[0].at <= T()) bck = bckQ.shift()!.v;
  const c = {
    forward: my < -0.38, backward: my > 0.38, left: mx < -0.38, right: mx > 0.38, boost,
    fireLeft: FIRE && t >= 0 && d < 1500, fireRight: FIRE && t >= 0 && d < 1500,
    // (aimed as a pilot aims, a little ahead of a mover: its shell's flight at a cannon's 48 a tick, less the share of
    // its own way a shell keeps, common launch.ts)
    targetAngle: n >= 0 ? datan2(dy + (Velocity.y[n] - 0.3 * Velocity.y[A.pid]) * (d / 48), dx + (Velocity.x[n] - 0.3 * Velocity.x[A.pid]) * (d / 48)) : 0, cursorDist: Math.min(2000, d),
  };
  const key = JSON.stringify([c.forward, c.backward, c.left, c.right, c.boost, c.fireLeft, Math.round(c.targetAngle * 400), Math.round(c.cursorDist / 8)]);
  if (key === lastKey && !chk && !bck) return;
  lastKey = key;
  const msg = { type: 'input', seq: seq++, tick: 0, targetTick: T() + 1, ...c, ...(chk ? { ownCheck: chk } : {}), ...(bck ? { bodyCheck: bck } : {}) } as unknown as ClientMessage;
  chk = undefined; bck = undefined;
  const dec = decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientMessage;
  A.noteInput(dec);
  A.link!.receive(dec);
};

// ---- motion: thrust and turn reversals; the drawn pose against the server's path ----
const prev = new Map<number, { vx: number; vy: number; ax: number; ay: number; av: number }>();
const trace: string[] = [];
const TRACE = process.env.TRACE !== undefined ? Number(process.env.TRACE) : -1;
let traced = -1;
const motion = () => {
  for (const id of foes()) {
    const d = designOf(id)!, g = of(d), vx = Velocity.x[id], vy = Velocity.y[id], av = ships.get(id)!.angVel;
    const p = prev.get(id);
    if (p) {
      const ax = vx - p.vx, ay = vy - p.vy;
      if (measuring) {
        g.shipTicks++;
        const v = Math.hypot(vx, vy);
        g.speedSum += v; g.speedMax = Math.max(g.speedMax, v);
        if (Math.hypot(ax, ay) > 0.02 && Math.hypot(p.ax, p.ay) > 0.02 && ax * p.ax + ay * p.ay < 0) g.thrustRev++;
        if (Math.abs(av) > 0.002 && Math.abs(p.av) > 0.002 && av * p.av < 0) g.turnRev++;
      }
      prev.set(id, { vx, vy, ax, ay, av });
    } else prev.set(id, { vx, vy, ax: 0, ay: 0, av });
  }
  // The drawn pose DELAY ticks behind, at the half ticks, against the server's path there
  if (!measuring) return;
  for (const id of A.reps.ids()) {
    const d = designOf(id);
    if (!d) continue;
    for (const half of [0, 0.5]) {
      const rt = T() - DELAY + half, f = Math.floor(rt);
      const p = A.reps.pose(id, rt), a = truth.get(f)?.get(id), b = truth.get(f + 1)?.get(id);
      if (!p || !a || !b) continue;
      const k = rt - f, x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k, e = Math.hypot(p.x - x, p.y - y);
      const g = of(d);
      g.drawn++; g.drawnSum += e; g.drawnMax = Math.max(g.drawnMax, e); if (e > 6) g.drawnBad++;
      if (process.env.DBG && e > 6) {
        const rep = (A.reps as unknown as { reps: Map<number, { fixes?: unknown[]; kf: number; last: number; hist: Map<number, unknown> }> }).reps.get(id)!;
        trace.push(`  DRAWN ${id} at ${T()} rt=${rt} e=${e.toFixed(1)} kf=${rep.kf} last=${rep.last} hist=${[...rep.hist.keys()].filter((k) => k >= f - 3 && k <= f + 4).join(',')} fixes=${JSON.stringify(rep.fixes)} drawn=${p.x.toFixed(1)},${p.y.toFixed(1)} srv=${x.toFixed(1)},${y.toFixed(1)}`);
      }
    }
  }
};

// ---- the run ----
const step = (t: number) => {
  send(t);
  dmgShot = true;
  server.step();
  dmgShot = false;
  truth.set(T(), new Map(foes().map((id) => [id, real(id)])));
  aPath.set(T(), [Position.x[A.pid], Position.y[A.pid]]);
  truth.delete(T() - 200);
  clock.t += 1000 / 60;
  while (down.length && down[0].at <= T()) A.frame(down.shift()!.data);
  const c = A.own?.takeCheck(true, T());
  if (c) chkQ.push({ at: T() + LAT, v: c });
  const b = A.bodies?.takeCheck(true, T());
  if (b) bckQ.push({ at: T() + LAT, v: b });
  const rep = A.selfHits?.takeReport(true);
  if (rep) server.hits.report(server.pilots.connOf(A.pid)! as never, rep);
  for (const m of A.outbox.splice(0)) up.push({ at: T() + LAT, msg: m });
  while (up.length && up[0].at <= T()) A.link?.receive(up.shift()!.msg);
  motion();
  if (TRACE >= 0 && measuring) {
    const ids = foes();
    if (traced < 0 && ids.length > TRACE) traced = ids[TRACE];
    const id = traced;
    if (ships.has(id)) {
      const cl = A.reps.at(id, T() - LAT)?.body, r = truth.get(T() - LAT)?.get(id), L = custom.live.get(id);
      const e = (server.enemies as unknown as { enemies: Map<number, { state: string; target: number }> }).enemies.get(id);
      const p = A.reps.pose(id, T() - DELAY);
      const tr = truth.get(T() - DELAY)?.get(id);
      trace.push([T(), e?.state, L?.move ? `m${L.move.move}@${T() - L.move.start}` : '-', ...real(id).map((v) => v.toFixed(2)),
        cl && r ? `cli-srv@${T() - LAT}=${Math.hypot(cl.x - r[0], cl.y - r[1]).toFixed(2)}` : 'cli -', p && tr ? `drawn-srv@${T() - DELAY}=${Math.hypot(p.x - tr[0], p.y - tr[1]).toFixed(2)}` : 'drawn -',
        `A=${Position.x[A.pid].toFixed(0)},${Position.y[A.pid].toFixed(0)}`].join(' '));
    }
  }
};
for (let i = 0; i < 20; i++) step(-1);
const num = InSystem.systemId[A.pid];
ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
const hp0 = ships.get(A.pid)!.hp.reduce((a, h) => a + h, 0);
// (Out of safe space, unless SOL: there hostiles leave a pilot be, and a hunting pack breaks off every 20 ticks)
let x0 = Position.x[A.pid] + (process.env.SOL ? 0 : 30000), y0 = Position.y[A.pid] + (process.env.SOL ? 2000 : 30000);
const sys = server.gameData.getSystemByNum(num);
while (!process.env.SOL && inSafeSpace(sys, x0, y0)) { x0 += 20000; y0 += 20000; }
Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
const pack = server.enemies.spawnPack(num, { faction: FACTION, ships: PACK, ...(process.env.PASSIVE ? { passive: true } : {}) } as never, x0 + DIST, y0 + DIST * 0.4);
if (!process.env.PASSIVE) for (const id of pack) server.enemies.setPrey(id, A.pid, true);
for (let t = 0; t < 120; t++) step(t);
measuring = true;
const m0 = T();
let died = -1, packDead = -1;
for (let t = 120; t < 120 + secs * 60; t++) {
  step(t);
  if (died < 0 && (!ships.has(A.pid) || hasComponent(server.getWorld(), Dead, A.pid))) { died = T() - m0; break; }
  if (packDead < 0 && pack.every((id) => !ships.has(id))) packDead = T() - m0;
  if (!foes().length || (process.env.UNTIL_PACK && packDead >= 0)) break;
}
const ran = (T() - m0) / 60;
for (const sh of shells) {
  // (a shot at tick t is stepped from t + 1 on, as A is)
  for (let k = 1; k <= sh.life; k++) {
    const a = aPath.get(sh.t + k);
    if (!a) break;
    if (Math.hypot(a[0] - (sh.x + sh.vx * k), a[1] - (sh.y + sh.vy * k)) <= sh.r) { of(sh.d).near++; break; }
  }
  if (process.env.DBG) {
    // (how it missed: its closest pass to A's real path, and A's way from the shot's tick)
    let best = Infinity, bk = 0;
    for (let k = 1; k <= sh.life; k++) { const a = aPath.get(sh.t + k); if (!a) break; const m = Math.hypot(a[0] - (sh.x + sh.vx * k), a[1] - (sh.y + sh.vy * k)); if (m < best) { best = m; bk = k; } }
    const a0 = aPath.get(sh.t), a1 = aPath.get(sh.t + bk);
    console.log(`SHOT ${sh.d} t=${sh.t} miss=${best.toFixed(0)} at k=${bk} A@shot=${a0?.map((v) => v.toFixed(0))} A@pass=${a1?.map((v) => v.toFixed(0))} from=${sh.x.toFixed(0)},${sh.y.toFixed(0)}`);
  }
}
const out: Record<string, unknown> = { pack: PACK.join(','), faction: FACTION, pilot: PILOT, fire: FIRE, real: REAL, secs: +ran.toFixed(1), diedAt: died >= 0 ? +(died / 60).toFixed(1) : null,
  packDeadAt: packDead >= 0 ? +(packDead / 60).toFixed(1) : null, aHp: +(100 * (ships.get(A.pid)?.hp.reduce((a, h) => a + h, 0) ?? 0) / hp0).toFixed(0), moves: custom.stats.moves };
const designs: Record<string, unknown> = {};
for (const [d, g] of tally) {
  const shipSecs = g.shipTicks / 60 || 1;
  designs[d] = {
    speedMean: +(g.speedSum / (g.shipTicks || 1)).toFixed(1), speedMax: +g.speedMax.toFixed(1), contactDps: +(g.contactDmg / ran).toFixed(2), contactTicks: g.contactTicks,
    shots: g.shots, aimedPct: g.shots ? Math.round((100 * g.aimed) / g.shots) : null, nearPct: g.shots ? Math.round((100 * g.near) / g.shots) : null, strikes: g.strikes, struckPct: g.strikes ? Math.round((100 * g.struck) / g.strikes) : null,
    dps: +(g.dmg / ran).toFixed(1), ttkStarter: g.dmg ? +(hp0 / (g.dmg / ran)).toFixed(1) : null,
    corrPerSec: +(g.kf / ran).toFixed(2), offPerSec: +(g.off / ran).toFixed(2), checked: g.checked, ctlRows: g.ctl, decPerSec: +(g.decisions / ran).toFixed(2), ops: g.ops,
    thrustRevPerShipSec: +(g.thrustRev / shipSecs).toFixed(2), turnRevPerShipSec: +(g.turnRev / shipSecs).toFixed(2), thrustFlipsPerShipSec: +(g.flips / shipSecs).toFixed(2),
    drawnMean: g.drawn ? +(g.drawnSum / g.drawn).toFixed(2) : null, drawnMax: +g.drawnMax.toFixed(1), drawnBadPct: g.drawn ? +((100 * g.drawnBad) / g.drawn).toFixed(1) : null,
  };
}
out.designs = designs;
out.bodies = { server: (server as unknown as { bodies: { stats: unknown } }).bodies.stats, runner: A.bodies?.stats ?? null };
console.log(JSON.stringify(out));
if (trace.length) console.log(trace.join('\n'));
if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify(out, null, 1));
process.exit(0);
