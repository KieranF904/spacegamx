/**
 * The network cost table (docs/audits/netcode-table-2026-11-05.md): one pilot's download in a fixed set of seeded scenes,
 * as payload B/s, WebSocket messages a second and wire B/s (payload + 66 B a message), with the newest caps the build has.
 *
 *   cd server && npx tsx --tsconfig ../scripts/net/tsconfig.json src/bench/netTable.ts            every scenario
 *   ... netTable.ts --only idle,rock-gale --secs 10 --out table.json
 *   ... netTable.ts --case <scenario>        one scenario in this process (what the table runs), one NETTABLE JSON line
 *
 * The measured pilot is the client's real tick layer (FakeHitsClient) announcing every cap the build has (DEFAULT_CAPS,
 * or every CAPS bit on a build without it), flown by input messages with 3 ticks of latency each way, what it owes the
 * server (hit reports, own and body checks, debris acks) riding them. On a build with no CAPS it's a plain socket: before
 * the caps, nothing a client sent changed what the server sent it. Every byte counted is the server's real encoder output.
 *
 * Portable on purpose: everything build-specific is looked up at run time, so this file runs unchanged on older trees
 * (git archive one, link node_modules, give it a tsconfig mapping @space-game/common to its common/src). Each scenario
 * runs in its own process (bitecs globals), `Math.random` seeded: the bytes repeat run to run.
 */
import { join, dirname } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as common from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const K = common as unknown as Record<string, any>;
const { Position, Velocity, Input, InSystem, Asteroid, encodeMessage, decodeMessage } = K;
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '../../../data');
const argv = process.argv.slice(2);
// (The payout dice's secret fixed: a rock's chunks the same every run, so the bytes are too. game/payoutDice.ts)
process.env.PAYOUT_SECRET ??= 'bench';
const arg = (name: string, d?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };

/** Scenario: what it is (for the table), the measured pilot's ship, seconds measured */
const SCENARIOS: Record<string, { label: string; secs: number }> = {
  idle: { label: 'Idle in Sol (Sparrow T parked, alone)', secs: 20 },
  cruise: { label: 'Cruise (Sparrow T flying 24 km legs, alone)', secs: 20 },
  'crowd-20': { label: 'Crowd cruise, 20 pilots', secs: 15 },
  'crowd-50': { label: 'Crowd cruise, 50 pilots', secs: 15 },
  'crowd-100': { label: 'Crowd cruise, 100 pilots', secs: 15 },
  'rock-starter': { label: 'Starter (Sparrow T, 2 Pips) firing at a rock', secs: 20 },
  'rock-gale': { label: 'Gale (2 Sparks, 2 Chainsaws) firing at a rock', secs: 20 },
  map: { label: 'System map open (idle in Sol)', secs: 20 },
  mother: { label: 'Scrap Mother (Halberd)', secs: 20 },
  pyreclast: { label: 'Pyreclast (Halberd)', secs: 20 },
  pirates: { label: 'Pirates (Sunspear vs two packs)', secs: 20 },
  custom: { label: 'Custom enemies (Sunspear vs two packs)', secs: 20 },
  reentry: { label: 'A ship re-entering the focus (another pilot 5 s beside A, 5 s 60 km away)', secs: 240 },
};
const WS_HEADER = 66;
const LAT = 3;

// ------------------------------------------------------------------------------------------------ the table (driver)
async function table(): Promise<void> {
  const only = arg('only')?.split(',') ?? Object.keys(SCENARIOS);
  const results: any[] = [];
  for (const sc of only) {
    const t0 = Date.now();
    const args = [...process.execArgv, fileURLToPath(import.meta.url), '--case', sc, ...(arg('secs') ? ['--secs', arg('secs')!] : [])];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' }, timeout: 30 * 60_000 });
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('NETTABLE '));
    if (!line) { console.error(`${sc}: failed (${r.status})\n${(r.stderr ?? '').slice(-2000)}${(r.stdout ?? '').slice(-800)}`); results.push({ scenario: sc, failed: true }); continue; }
    results.push(JSON.parse(line.slice(9)));
    console.error(`${sc} done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const ok = results.filter((r) => !r.failed);
  const head = ['scenario', 'payload B/s', 'WS msgs/s', 'wire B/s', 'up B/s', 'notes'];
  const rows = results.map((r) => r.failed ? [r.scenario, '-', '-', '-', '-', 'failed'] : [r.scenario, String(r.payloadBps), r.wsMsgsPerSec.toFixed(2), String(r.wireBps), String(r.upBps), r.notes.join('; ')]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((x) => x[i].length)));
  const fmt = (x: string[]) => x.map((c, i) => (i === 0 || i === 5 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  console.log(`\nprotocol ${ok[0]?.protocol ?? '?'}, caps ${ok[0]?.caps ?? '?'} (${ok[0]?.client ?? '?'}), latency ${LAT} ticks; wire = payload + ${WS_HEADER} B a WebSocket message\n`);
  console.log(fmt(head)); console.log(w.map((x) => '-'.repeat(x)).join('  '));
  for (const x of rows) console.log(fmt(x));
  const out = arg('out');
  if (out) writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
}

// ------------------------------------------------------------------------------------------------ one scenario
interface Ctl { forward: boolean; backward: boolean; left: boolean; right: boolean; boost: boolean; fireLeft: boolean; fireRight: boolean; targetAngle: number; cursorDist: number }
const still = (p: number): Ctl => ({ forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: Input.targetAngle[p], cursorDist: Input.cursorDist[p] || 400 });
/** Thrust toward a direction (the four keys of a top-down ship, 0.38 dead zone) */
function steer(c: Ctl, ux: number, uy: number): void {
  if (uy < -0.38) c.forward = true;
  if (uy > 0.38) c.backward = true;
  if (ux < -0.38) c.left = true;
  if (ux > 0.38) c.right = true;
}
/** Hold `near`-`far` off a target, face it, fire inside 1.8 km */
function fightCtl(p: number, t: number, near: number, far: number, fire: boolean): Ctl {
  const c = still(p);
  const dx = Position.x[t] - Position.x[p], dy = Position.y[t] - Position.y[p], d = Math.hypot(dx, dy) || 1;
  c.targetAngle = Math.atan2(dy, dx);
  c.cursorDist = Math.min(65000, d);
  const want = d > far ? 1 : d < near ? -1 : 0;
  if (want) steer(c, (dx / d) * want, (dy / d) * want);
  if (d > far + 600) c.boost = true;
  if (fire && d < 1800) c.fireLeft = c.fireRight = true;
  return c;
}
/** Fly to a point, boosting while far, nothing fired */
function cruiseCtl(p: number, x: number, y: number): Ctl {
  const c = still(p);
  const dx = x - Position.x[p], dy = y - Position.y[p], d = Math.hypot(dx, dy) || 1;
  c.targetAngle = Math.atan2(dy, dx);
  c.cursorDist = 2000;
  steer(c, dx / d, dy / d);
  c.boost = d > 4000;
  return c;
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function runCase(sc: string): Promise<void> {
  if (!SCENARIOS[sc]) throw new Error(`no scenario ${sc}: ${Object.keys(SCENARIOS).join(', ')}`);
  const secs = Number(arg('secs')) || SCENARIOS[sc].secs;
  Math.random = rng(0x2545f491);
  const notes: string[] = [];
  const CAPS: Record<string, number> | undefined = K.CAPS;
  const caps = CAPS ? (K.DEFAULT_CAPS ?? Object.values(CAPS).reduce((a, b) => a | b, 0)) : 0;
  let Fake: any = null;
  if (CAPS) Fake = (await import('../net/hits/fakeHitsClient.testkit.js')).FakeHitsClient;

  const clock = { t: 1_000_000 };
  const server: any = new GameServer({
    gameData: new GameData(readGameDataFiles(dataDir)),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
    netCaps: caps,
    // (crowd fallbacks: on in the real server; older builds took them with netCaps CROWD)
    crowd: true,
  } as never);
  const ships = server.getShips();
  const T = () => server.getTick();
  let measuring = false;

  // ---- the measured pilots: the client's tick layer (or a plain socket before the caps) ----
  interface Meas { pid: number; fake: any; link: any; raw: number; msgs: number; upBytes: number; upMsgs: number; down: { at: number; data: Uint8Array }[]; up: { at: number; msg: any }[];
    repQ: { at: number; v: unknown }[]; chkQ: { at: number; v: unknown }[]; bckQ: { at: number; v: unknown }[]; acks: number[]; lastKey: string; sentAt: number; seq: number }
  const byType: Record<string, number> = {};
  const count = (m: Meas, data: unknown) => {
    if (!measuring) return;
    m.raw += typeof data === 'string' ? Buffer.byteLength(data) : (data as Uint8Array).byteLength;
    m.msgs++;
    // (A plain socket's frames by message type: a guide to where the bytes go on builds before the packed codec)
    if (!m.fake && typeof data !== 'string' && K.splitServerFrame) for (const { msg, bytes } of K.splitServerFrame(data)) byType[msg.type] = (byType[msg.type] ?? 0) + bytes;
  };
  const env = (id: number) => server.replication.host.env(id);
  function measured(name: string): Meas {
    const m: Meas = { pid: -1, fake: null, link: null, raw: 0, msgs: 0, upBytes: 0, upMsgs: 0, down: [], up: [], repQ: [], chkQ: [], bckQ: [], acks: [], lastKey: '', sentAt: -9, seq: 1 };
    if (Fake) {
      m.fake = new Fake(server, { name, caps, env, defer: (data: Uint8Array) => { count(m, data); m.down.push({ at: T() + LAT, data }); } });
      m.pid = m.fake.pid;
      m.link = m.fake.link;
      // (Before the fake worked out debris itself: as ShipClient.onDebrisSplit did, confirmed on the next input)
      if (!m.fake.debris && K.deriveSplit) {
        const f = m.fake, oHandle = f.handle.bind(f);
        f.handle = (msg: any) => { if (msg.type === 'debrisSplit') derive(m, msg); return oHandle(msg); };
      }
    } else {
      const socket = { isOpen: () => true, send: (data: unknown) => count(m, data) };
      m.link = server.connect(socket as never);
      m.link.receive({ type: 'join', username: name } as never);
      m.pid = server.getPlayerId(socket as never);
    }
    return m;
  }
  function derive(m: Meas, msg: any): void {
    const f = m.fake, parent = f.store.get(msg.id), at = parent ? f.reps.at(msg.id, msg.tick) : null;
    if (!parent || !at) return;
    const got = K.deriveSplit(f.store.catalog, f.store.tuning, parent, msg.id, msg.tick, K.unpackIds(msg.e), new Set(K.unpackRuns(msg.p, parent.blueprint.parts.length)), K.computeJoins(f.store.geometry(parent)), at.body, (i: number) => parent.hp[i]);
    for (const d of got ?? []) { f.store.bodies.set(d.id, d.ship); f.reps.spawnDebris(d.id, msg.tick, d.body); m.acks.push(d.id, d.hash); }
  }
  /** This tick's input: sent when keys, 13-bit aim or 4-unit cursor change, or when something rides it */
  function fly(m: Meas, c: Ctl, now: number): void {
    const q = K.quantizeCursorAngle ? K.quantizeCursorAngle(c.targetAngle) : Math.round(c.targetAngle * 1000);
    const key = JSON.stringify([c.forward, c.backward, c.left, c.right, c.boost, c.fireLeft, c.fireRight, q, Math.round(c.cursorDist / 4)]);
    let rep: unknown, chk: unknown, bck: unknown;
    while (m.repQ.length && m.repQ[0].at <= now) rep = m.repQ.shift()!.v;
    while (m.chkQ.length && m.chkQ[0].at <= now) chk = m.chkQ.shift()!.v;
    while (m.bckQ.length && m.bckQ[0].at <= now) bck = m.bckQ.shift()!.v;
    const acks = m.fake?.debris?.takeAcks?.() ?? (m.acks.length ? m.acks.splice(0) : undefined);
    if (key === m.lastKey && !rep && !chk && !bck && !acks) return;
    m.lastKey = key;
    m.sentAt = now;
    const msg = { type: 'input', seq: m.seq++, tick: 0, targetTick: now + 1, ...c, ...(acks ? { acks } : {}), ...(rep ? { hitReport: rep } : {}), ...(chk ? { ownCheck: chk } : {}), ...(bck ? { bodyCheck: bck } : {}) };
    const enc = encodeMessage(msg) as ArrayBuffer;
    const sent = m.fake && CAPS?.INPUTS && (caps & CAPS.INPUTS) && K.InputEncoder ? ((m as any).ienc ??= new K.InputEncoder()).encode(msg, true) as ArrayBuffer : enc;
    if (measuring) { m.upMsgs++; m.upBytes += sent.byteLength; }    const dec = decodeMessage(enc);
    m.fake?.noteInput?.(dec);
    m.link.receive(dec);
  }
  /** After the server's step: frames that have arrived, what it owes, its messages on their way up */
  function afterStep(m: Meas): void {
    const f = m.fake;
    if (!f) return;
    const now = T();
    while (m.down.length && m.down[0].at <= now) f.frame(m.down.shift()!.data);
    const rep = f.selfHits?.on ? f.selfHits.takeReport(true) : undefined;
    if (rep) m.repQ.push({ at: now + LAT, v: rep });
    const chk = f.own?.takeCheck?.(m.sentAt === now - 1, now);
    if (chk) m.chkQ.push({ at: now + LAT, v: chk });
    const bck = f.bodies?.takeCheck?.(m.sentAt === now - 1, now);
    if (bck) m.bckQ.push({ at: now + LAT, v: bck });
    // (a message that goes as JSON, an hpResync, encodes to a string)
    for (const msg of f.outbox.splice(0)) { m.up.push({ at: now + LAT, msg }); if (measuring) { m.upMsgs++; const e = encodeMessage(msg) as ArrayBuffer | string; m.upBytes += typeof e === 'string' ? Buffer.byteLength(e) : e.byteLength; } }
    while (m.up.length && m.up[0].at <= now) f.link?.receive(m.up.shift()!.msg);
  }
  /** The other pilots: plain sockets that count nothing, their controls straight onto the ECS (as the crowd bench's bulk) */
  function bot(name: string): number {
    const socket = { isOpen: () => true, send: () => {} };
    const link = server.connect(socket as never);
    link.receive({ type: 'join', username: name } as never);
    return server.getPlayerId(socket as never);
  }
  function direct(p: number, c: Ctl): void {
    for (const k of ['forward', 'backward', 'left', 'right', 'fireLeft', 'fireRight', 'boost'] as const) Input[k][p] = c[k] ? 1 : 0;
    Input.targetAngle[p] = K.replicaAngle && K.ReplicaMode ? K.replicaAngle(K.ReplicaMode.Player, K.quantizeReplicaAngle(c.targetAngle)) : c.targetAngle;
    // (on the 4-unit grid a client's input puts it on, as the measured pilots' inputs are)
    Input.cursorDist[p] = Math.round(c.cursorDist / 4) * 4;
  }
  const lib = (name: string) => {
    const hit = ships.library.get(name);
    if (hit) return hit;
    for (const f of [`blueprints/${name}.json`, `blueprints/dev/${name}.json`]) {
      try { return JSON.parse(readFileSync(join(dataDir, 'ships', f), 'utf8')); } catch { /* next */ }
    }
    throw new Error(`no blueprint ${name}`);
  };
  const place = (p: number, x: number, y: number) => { Position.x[p] = x; Position.y[p] = y; Velocity.x[p] = 0; Velocity.y[p] = 0; };

  // ---- the scene ----
  const crowdN = sc.startsWith('crowd-') ? Number(sc.slice(6)) : 0;
  const meas: Meas[] = [];
  const bots: { pid: number; home: { x: number; y: number }; leg: { x: number; y: number }; out: boolean }[] = [];
  const r = rng(0xc0ffee);
  if (crowdN) {
    // (the crowd bench's cruise layout: a 12 km grid, each pilot flying out and back along a 24 km leg; two measured)
    const measIdx = new Set([0, Math.floor(crowdN / 2)]);
    const pids: number[] = [];
    for (let i = 0; i < crowdN; i++) {
      if (measIdx.has(i)) { const m = measured(`nt_m${i}`); meas.push(m); pids.push(m.pid); } else pids.push(bot(`nt_b${i}`));
    }
    for (let i = 0; i < 20; i++) { server.step(); clock.t += 1000 / 60; }
    const pool = ['sparrow-t', 'halberd', 'sunspear', 'ports-gale', 'ports-heron', 'ports-wasp', 'ports-brawler', 'wisp'];
    const base = { x: Position.x[pids[0]], y: Position.y[pids[0]] }, side = Math.ceil(Math.sqrt(crowdN));
    pids.forEach((pid, i) => {
      ships.respawnInPlace(pid, lib(pool[Math.floor(r() * pool.length)]));
      const x = base.x + ((i % side) - side / 2) * 12000 + (r() - 0.5) * 3000, y = base.y + (Math.floor(i / side) - side / 2) * 12000 + (r() - 0.5) * 3000;
      place(pid, x, y);
      const la = r() * Math.PI * 2;
      bots.push({ pid, home: { x, y }, leg: { x: x + Math.cos(la) * 24000, y: y + Math.sin(la) * 24000 }, out: true });
    });
    const num = InSystem.systemId[pids[0]];
    for (let k = 0; k < 2; k++) { const b = bots[Math.floor((k / 2) * crowdN)], a = r() * Math.PI * 2; server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff', 'pirate_skiff'] }, b.home.x + Math.cos(a) * 1800, b.home.y + Math.sin(a) * 1800); }
  } else {
    meas.push(measured('nt_A'));
    for (let i = 0; i < 30; i++) { server.step(); clock.t += 1000 / 60; }
  }
  const A = meas[0];
  const num = InSystem.systemId[A.pid];
  const shipFor: Record<string, string> = { 'rock-gale': 'ports-gale', mother: 'halberd', pyreclast: 'halberd', pirates: 'sunspear', custom: 'sunspear' };
  if (!crowdN) ships.respawnInPlace(A.pid, lib(shipFor[sc] ?? 'sparrow-t'));
  const start = { x: Position.x[A.pid], y: Position.y[A.pid] };
  let target = -1, rock = -1, B = -1;
  let legOut = true;
  const spot = { x: start.x + 30000, y: start.y + 30000 };
  const leg = { x: spot.x + 24000, y: spot.y - 6000 };
  if (!crowdN) place(A.pid, spot.x, spot.y);
  const placeRock = (a: number) => server.placeAsteroid?.(a);
  if (sc === 'rock-starter' || sc === 'rock-gale') {
    // (a lone rock in Sol, size 50-90, nearest the spot with no ship within 9 km; A parked 350 units off its edge)
    const all: number[] = server.asteroidIndexById ? [...server.asteroidIndexById.keys()] : (await import('bitecs')).defineQuery([Asteroid])(server.getWorld());
    const rocks = all.filter((a) => InSystem.systemId[a] === num && !server.isGas?.(a)).map((a) => { placeRock(a); return a; });
    const lonely = (x: number, y: number) => { for (const [eid] of ships.bodies) if (eid !== A.pid && InSystem.systemId[eid] === num && Math.hypot(Position.x[eid] - x, Position.y[eid] - y) < 9000) return false; return true; };
    let bd = Infinity;
    for (const a of rocks) {
      if (Asteroid.size[a] <= 50 || Asteroid.size[a] >= 90 || !lonely(Position.x[a], Position.y[a])) continue;
      const d = Math.hypot(Position.x[a] - start.x, Position.y[a] - start.y);
      if (d < bd) { bd = d; rock = a; }
    }
    if (rock < 0) throw new Error('no lone rock');
    place(A.pid, Position.x[rock] - (Asteroid.size[rock] + 350), Position.y[rock]);
    notes.push(`rock size ${Asteroid.size[rock]}`);
  } else if (sc === 'mother' || sc === 'pyreclast') {
    target = server.bosses.spawnAt(sc === 'mother' ? 'boss_scrap_mother' : 'boss_pyreclast', num, spot.x + 1800, spot.y);
  } else if (sc === 'pirates' || sc === 'custom') {
    const packs = sc === 'pirates' ? [['pirate_raider', 'pirate_skiff', 'pirate_skiff'], ['pirate_raider', 'pirate_skiff']] : [['cinder_zealot', 'maw_lurker', 'frost_shard'], ['helios_drone', 'helios_drone', 'scrap_crawler']];
    server.enemies.spawnPack(num, { faction: 'pirates', ships: packs[0] }, spot.x + 1500, spot.y + 900);
    server.enemies.spawnPack(num, { faction: 'pirates', ships: packs[1] }, spot.x - 1500, spot.y + 900);
    (globalThis as any).__ntPack = packs[1];
  } else if (sc === 'reentry') {
    // (another pilot, B, in and out of A's view every 10 s)
    B = bot('nt_B');
    ships.respawnInPlace(B, lib('ports-wasp'));
    place(B, spot.x + 1500, spot.y);
  } else if (sc === 'map') {
    A.link.receive({ type: 'mapView', open: true });
  }
  const nearestHostile = (p: number) => {
    let best = -1, bd = Infinity;
    for (const [eid] of ships.bodies) {
      if (!server.enemies.factionOf(eid) || InSystem.systemId[eid] !== num) continue;
      const d = Math.hypot(Position.x[eid] - Position.x[p], Position.y[eid] - Position.y[p]);
      if (d < bd) { bd = d; best = eid; }
    }
    return best;
  };
  let reentries = 0, bAway = false, firing = 0;
  const fight = ['mother', 'pyreclast', 'pirates', 'custom'].includes(sc);

  const stepOnce = () => {
    const now = T();
    if (crowdN) {
      if (now % 120 === 0 && server.enemies.count(num) < 4) { const b = bots[Math.floor(r() * bots.length)]; server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff'] }, b.home.x + 1800, b.home.y); }
      for (const b of bots) {
        const tx = b.out ? b.leg.x : b.home.x, ty = b.out ? b.leg.y : b.home.y;
        if (Math.hypot(tx - Position.x[b.pid], ty - Position.y[b.pid]) < 1500) b.out = !b.out;
        const c = cruiseCtl(b.pid, b.out ? b.leg.x : b.home.x, b.out ? b.leg.y : b.home.y);
        const m = meas.find((x) => x.pid === b.pid);
        if (m) fly(m, c, now); else direct(b.pid, c);
      }
    } else {
      let c: Ctl;
      if (sc === 'cruise') {
        const tx = legOut ? leg.x : spot.x, ty = legOut ? leg.y : spot.y;
        if (Math.hypot(tx - Position.x[A.pid], ty - Position.y[A.pid]) < 1500) legOut = !legOut;
        c = cruiseCtl(A.pid, legOut ? leg.x : spot.x, legOut ? leg.y : spot.y);
      } else if (rock >= 0) {
        placeRock(rock);
        c = still(A.pid);
        c.targetAngle = Math.round(Math.atan2(Position.y[rock] - Position.y[A.pid], Position.x[rock] - Position.x[A.pid]) * 200) / 200;
        c.cursorDist = 400; c.fireLeft = c.fireRight = true;
      } else if (sc === 'pirates' || sc === 'custom') {
        if (now % 300 === 0 && server.enemies.count(num) < 4) server.enemies.spawnPack(num, { faction: 'pirates', ships: (globalThis as any).__ntPack }, Position.x[A.pid] + 1600, Position.y[A.pid] - 800);
        const t = nearestHostile(A.pid);
        c = t >= 0 ? fightCtl(A.pid, t, 500, 900, true) : still(A.pid);
      } else if (target >= 0 && ships.has(target)) c = fightCtl(A.pid, target, 1300, 1700, true);
      else c = still(A.pid);
      fly(A, c, now);
      if (measuring && (c.fireLeft || c.fireRight)) firing++;
      // (Fights: A is kept alive, its hull restored once a second, the same rule on every build)
      if (fight && now % 60 === 0 && ships.has(A.pid)) ships.scaleHp(A.pid, 1);
      if (B >= 0) {
        // (5 s parked 1.5 km off A, then 5 s 60 km away: out of the 19 km focus and the old 40 km circle; then back)
        const away = now % 600 >= 300;
        if (away !== bAway) { place(B, spot.x + (away ? 60000 : 1500), spot.y); if (measuring && !away) reentries++; }
        bAway = away;
        direct(B, still(B));
      }
    }
    server.step();
    clock.t += 1000 / 60;
    for (const m of meas) afterStep(m);
  };
  for (let i = 0; i < (Number(arg('warm')) || 180); i++) stepOnce();
  measuring = true;
  const t0 = performance.now();
  for (let i = 0; i < secs * 60; i++) stepOnce();
  const wallMs = performance.now() - t0;
  measuring = false;

  const mean = (f: (m: Meas) => number) => meas.reduce((a, m) => a + f(m), 0) / meas.length / secs;
  const payloadBps = mean((m) => m.raw), wsMsgsPerSec = mean((m) => m.msgs);
  if (crowdN) notes.push(`mean of ${meas.length} pilots`);
  if (B >= 0) notes.push(`${reentries} re-entries`);
  if (target >= 0) notes.push(ships.has(target) ? 'boss alive at the end' : 'boss dead before the end');
  if (!ships.has(A.pid)) notes.push('measured pilot dead at the end');
  if (fight || rock >= 0) notes.push(`firing ${Math.round((firing / (secs * 60)) * 100)}% of ticks`);
  if (sc === 'pirates' || sc === 'custom') notes.push(`${server.enemies.count(num)} hostiles at the end`);
  const res = {
    scenario: sc, label: SCENARIOS[sc].label, secs, protocol: K.PROTOCOL_VERSION, caps, client: Fake ? 'FakeHitsClient' : 'plain socket',
    payloadBps: Math.round(payloadBps), wsMsgsPerSec: +wsMsgsPerSec.toFixed(2), wireBps: Math.round(payloadBps + WS_HEADER * wsMsgsPerSec),
    upBps: Math.round(mean((m) => m.upBytes)), upMsgsPerSec: +mean((m) => m.upMsgs).toFixed(2),
    msPerTick: +(wallMs / (secs * 60)).toFixed(3), notes,
    byType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [k, Math.round(v / secs / meas.length)])),
  };
  console.log('NETTABLE ' + JSON.stringify(res));
}

const one = arg('case');
if (one) { await runCase(one); process.exit(0); }
await table();
process.exit(0);
