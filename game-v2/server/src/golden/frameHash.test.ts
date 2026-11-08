/**
 * Golden whole-server frame hash (refactor safety net, Stage 0).
 *
 * A full 'sectors' GameServer runs in-process with four scripted pilots for 900 ticks:
 *   strafer  - the F9 dev ship with Burst Strafers (test-strafer): thrust, turns, dodges every way, fires
 *   tug      - the F9 Tow Beam hauler (test-tow-hauler) with ore in its hold, towing a Corsair wreck
 *   striker  - the F9 striker (test-surge-striker: Pulse Dynamos charging a Capacitor bank, Rail Driver, Flash Screen), firing
 *   sparrow  - a stock Sparrow (sparrow-t) flying and firing alongside
 * Every 100 ticks it records, per pilot, a running SHA-256 of every raw frame the server sent that pilot (the
 * bytes on the wire, in order) plus the frame count, and a SHA-256 of a canonical dump of the server's world:
 * every ECS entity's gameplay components, every ShipBridge ship state and charge, and each pilot's profile.
 * The hashes are pinned in frameHash.golden.json. A refactor that only moves code must keep them identical.
 *
 * Regenerate deliberately (after an intended behaviour change), from game-v2/:
 *   UPDATE_GOLDEN=1 npx vitest run server/src/golden/frameHash.test.ts        (bash)
 *   $env:UPDATE_GOLDEN=1; npx vitest run server/src/golden/frameHash.test.ts  (PowerShell)
 *
 * Determinism controls:
 *   - Math.random is replaced by a seeded mulberry32 for the whole run (world build included).
 *   - Date (Date.now, new Date) is faked and advanced 1000/60 ms per tick from a fixed epoch; the server's clock
 *     option is left at its default (Date.now) so the faked time drives autosave, hunts, jobs and serverTime.
 *   - performance.now is stubbed to the same simulated time (tick timing / perf metrics).
 *   - bitecs globals are reset before each server, and the whole loop is synchronous (no awaits), so no
 *     microtask (profile loads etc.) can interleave differently between runs.
 *   - The scenario runs twice in one process and must match itself before it is compared with the golden file
 *     (catches leaked module state as well as unseeded randomness).
 * Excluded on purpose:
 *   - Asteroid Position/Velocity/Rotation: asteroids are placed lazily from the orbit timetable (placeAsteroid);
 *     the stored values only say when something last asked, an implementation detail. Their Asteroid fields
 *     (hp, ore, orbit) are kept. What clients see of asteroids is still in the frames.
 *   - NetworkSync (replication bookkeeping): what it schedules is already in the frames.
 *   - Render-only components (Sprite, Trail, Glow).
 * Float maths is IEEE-exact on one machine; a different CPU/Node with a different Math.sin could in principle
 * change the hashes, so regenerate on a new platform only after the suite passes there.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash, type Hash } from 'crypto';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, Radius, Health, Lifetime, Player, Input, Boost, Inventory, Projectile, Bullet, Laser,
  Pulse, MiningShot, AI, Enemy, NPC, Asteroid, Station, Portal, DroppedItem, Dead, OwnedBy, InSystem,
  encodeMessage, decodeMessage, ServerFrameReader, parseBlueprint,
  type ClientMessage, type ClientSocket, type Blueprint,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '../../../data');
const GOLDEN = join(here, 'frameHash.golden.json');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

const TICKS = 900;
const EVERY = 100;
const SEED = 0x5eed_2026;
const EPOCH = Date.UTC(2026, 0, 5, 12, 0, 0); // a fixed Monday noon
const TICK_MS = 1000 / 60;

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** JSON with sorted keys and explicit non-finite numbers */
function canon(v: unknown): string {
  if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? '-0' : String(v)) : `"${v}"`;
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (ArrayBuffer.isView(v)) return canon(Array.from(v as unknown as ArrayLike<number>));
  if (v instanceof Map) return canon([...v.entries()].sort((a, b) => canon(a[0]).localeCompare(canon(b[0]))));
  if (v instanceof Set) return canon([...v].map(canon).sort());
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined && typeof o[k] !== 'function').map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Gameplay components dumped per entity (asteroids skip the lazily placed ones; see the header) */
const COMPONENTS: [string, Record<string, unknown>][] = Object.entries({
  Position, Velocity, Rotation, Radius, Health, Lifetime, Player, Input, Boost, Inventory, Projectile, Bullet, Laser,
  Pulse, MiningShot, AI, Enemy, NPC, Asteroid, Station, Portal, DroppedItem, Dead, OwnedBy, InSystem,
}) as [string, Record<string, unknown>][];
const LAZY_ON_ASTEROIDS = new Set(['Position', 'Velocity', 'Rotation']);

type PilotSpec = { name: string; bp: Blueprint; dx: number; dy: number };

function fixtures(): { specs: PilotSpec[]; corsair: Blueprint; shipCfg: ReturnType<typeof loadShipConfigCached> } {
  const shipCfg = loadShipConfigCached(dataDir);
  const dev = shipCfg.dev ?? {};
  const bp = (f: string) => parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints', f), 'utf-8'));
  for (const id of ['test-strafer', 'test-tow-hauler', 'test-surge-striker']) if (!dev[id]) throw new Error(`dev ship ${id} missing`);
  return {
    shipCfg,
    corsair: bp('fixtures/corsair.json'),
    specs: [
      { name: 'strafer', bp: dev['test-strafer'], dx: 0, dy: 0 },
      { name: 'tug', bp: dev['test-tow-hauler'], dx: 500, dy: 0 },
      { name: 'striker', bp: dev['test-surge-striker'], dx: 0, dy: 500 },
      { name: 'sparrow', bp: bp('sparrow-t.json'), dx: 500, dy: 500 },
    ],
  };
}

/** The scripted controls: a pure function of (pilot, tick) */
function controls(p: number, t: number): Record<string, unknown> {
  const phase = Math.floor(t / 150);
  const wobble = Math.sin((t + p * 37) / 40);
  const base = {
    forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false,
    targetAngle: -Math.PI / 2 + p * (Math.PI / 2) + wobble * 0.8, cursorDist: 300 + p * 100, dodge: false,
  };
  switch (phase) {
    case 0: return { ...base, forward: t % 60 < 40 };                                  // thrust and settle
    case 1: return { ...base, forward: true, targetAngle: base.targetAngle + t / 30, fireLeft: t % 20 < 10 }; // turn and fire
    case 2: {                                                                           // dodges, every way
      const k = Math.floor((t % 150) / 25);
      const way = [{}, { left: true }, { right: true }, { forward: true }, { backward: true }, { left: true, forward: true }][k];
      return { ...base, ...way, dodge: t % 25 < 4, fireRight: t % 30 < 6 };
    }
    case 3: return { ...base, forward: true, boost: t % 90 < 30, fireLeft: true, fireRight: true }; // boost and full fire
    case 4: return { ...base, backward: t % 50 < 25, right: t % 70 < 20, dodge: t % 40 < 3, fireLeft: t % 15 < 5 };
    default: return { ...base, left: t % 40 < 20, fireRight: t % 25 < 12, targetAngle: base.targetAngle - t / 50 };
  }
}

interface Checkpoint {
  tick: number;
  world: string;
  pilots: Record<string, { frames: number; stream: string }>;
}
interface Result {
  ticks: number;
  checkpoints: Checkpoint[];
  /** Message type -> count over the run, per pilot (a readable hint of where a mismatch lies) */
  messageTypes: Record<string, Record<string, number>>;
  faults: Record<string, number>;
  /** Proof the script exercised what it is meant to (also pinned): ticks towing, dodges begun and their ways, ticks each pilot fired on */
  probes: { towTicks: number; dodges: number; dodgeDirs: number[]; firedTicks: Record<string, number>; tugMessages: string[] };
}

function scenario(): Result {
  const random = rng(SEED);
  vi.spyOn(Math, 'random').mockImplementation(random);
  vi.useFakeTimers({ toFake: ['Date'], now: EPOCH });
  let simMs = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => simMs);

  const { specs, corsair, shipCfg } = fixtures();
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(readGameDataFiles(dataDir)),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(shipCfg),
  });
  const ships = server.getShips();

  const pilots = specs.map((spec) => {
    const hash: Hash = createHash('sha256');
    const counter = { frames: 0, types: {} as Record<string, number>, texts: [] as string[] };
    // (Bit-packed messages once joined, every client running the full caps set; base-format frames before)
    const reader = new ServerFrameReader();
    const socket: ClientSocket = {
      isOpen: () => true,
      send: (data) => {
        const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));
        hash.update(bytes);
        counter.frames++;
        for (const msgs of reader.read(bytes)) for (const m of msgs) {
          counter.types[m.type] = (counter.types[m.type] ?? 0) + 1;
          if (m.type === 'systemMessage') counter.texts.push(String((m as { text?: unknown }).text));
        }
      },
    };
    const link = server.connect(socket);
    const send = (msg: Record<string, unknown>) => link.receive(decodeMessage(encodeMessage(msg as unknown as ClientMessage)) as ClientMessage);
    send({ type: 'join', username: spec.name });
    const pid = server.getPlayerId(socket);
    if (!pid) throw new Error(`${spec.name} did not join`);
    return { spec, hash, counter, send, pid, seq: 1 };
  });

  // Out in open space together (in each other's view), then onto the fixture ships
  const sys = InSystem.systemId[pilots[0].pid];
  for (const p of pilots) {
    Position.x[p.pid] = 40000 + p.spec.dx; Position.y[p.pid] = 40000 + p.spec.dy;
    Velocity.x[p.pid] = 0; Velocity.y[p.pid] = 0; Rotation.angle[p.pid] = -Math.PI / 2;
    ships.respawnInPlace(p.pid, p.spec.bp);
  }
  const tug = pilots[1];
  server.pilots.get(server.pilots.connOf(tug.pid)!)!.cargo.push({ id: 'iron_ore', n: 12 });
  const wreck = ships.spawnWreck(corsair, Position.x[tug.pid] - 300, Position.y[tug.pid], 0, sys, 7);

  const posQuery = bitecs.defineQuery([Position]);
  const dumpWorld = (): string => {
    const world = server.getWorld();
    const ents = [...posQuery(world)].sort((a, b) => a - b);
    const rows: unknown[] = [];
    for (const eid of ents) {
      const isAsteroid = bitecs.hasComponent(world, Asteroid, eid);
      const comps: Record<string, unknown> = {};
      for (const [name, c] of COMPONENTS) {
        if (!bitecs.hasComponent(world, c as any, eid)) continue;
        if (isAsteroid && LAZY_ON_ASTEROIDS.has(name)) { comps[name] = 1; continue; }
        const f: Record<string, unknown> = {};
        for (const [k, arr] of Object.entries(c)) {
          const v = (arr as ArrayLike<unknown>)[eid];
          f[k] = ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v;
        }
        comps[name] = f;
      }
      const s = ships.get(eid);
      const ship = s ? {
        kind: s.kind, hp: s.hp, maxHp: s.maxHp, detached: s.detached, ghost: s.ghost, angVel: s.angVel, jump: s.jump,
        cargo: s.cargo, dodge: s.dodge, dodgeDir: s.dodgeDir, tow: s.tow, cooldown: s.cooldown, aim: s.aim,
        rebuilds: s.rebuilds, charge: ships.chargeOf(eid), parts: s.blueprint.parts.length,
      } : undefined;
      rows.push([eid, comps, ship]);
    }
    const profiles = pilots.map((p) => server.pilots.get(server.pilots.connOf(p.pid)!) ?? null);
    return canon({ tick: server.getTick(), rows, profiles });
  };

  const checkpoints: Checkpoint[] = [];
  const probes: Result['probes'] = { towTicks: 0, dodges: 0, dodgeDirs: [], firedTicks: {}, tugMessages: [] };
  const lastFired = new Map<number, number>();
  let lastDodge = 0;
  for (let t = 0; t < TICKS; t++) {
    // (Each input for the tick about to run, as a client's lands: on time, not late (a late one is applied at once, the
    // same tick, but marks its own ship off: its row and a keyframe every round, docs: Stage 3b))
    const next = server.getTick() + 1;
    pilots.forEach((p, i) => {
      p.send({ type: 'input', seq: p.seq++, tick: 0, targetTick: next, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0, ...controls(i, t) });
    });
    if (t === 120) { tug.send({ type: 'input', seq: tug.seq++, tick: 0, targetTick: next, ...controls(1, t), targetAngle: Math.PI, cursorDist: 300 }); tug.send({ type: 'tow', on: true }); }
    if (t === 700) tug.send({ type: 'tow', on: false });
    server.step();
    if (ships.get(tug.pid)?.tow !== undefined) probes.towTicks++;
    const st = ships.get(pilots[0].pid);
    if (st && (st.dodge ?? 0) > 0 && lastDodge === 0) { probes.dodges++; if (!probes.dodgeDirs.includes(st.dodgeDir ?? 0)) probes.dodgeDirs.push(st.dodgeDir ?? 0); }
    lastDodge = st?.dodge ?? 0;
    for (const p of pilots) {
      const f = ships.lastFiredTick(p.pid);
      if (f !== lastFired.get(p.pid)) { lastFired.set(p.pid, f); probes.firedTicks[p.spec.name] = (probes.firedTicks[p.spec.name] ?? 0) + 1; }
    }
    simMs += TICK_MS;
    vi.setSystemTime(EPOCH + Math.round(simMs));
    if ((t + 1) % EVERY === 0) {
      checkpoints.push({
        tick: t + 1,
        world: sha(dumpWorld()),
        pilots: Object.fromEntries(pilots.map((p) => [p.spec.name, { frames: p.counter.frames, stream: p.hash.copy().digest('hex') }])),
      });
    }
  }
  void wreck;
  probes.dodgeDirs.sort((x, y) => x - y);
  probes.tugMessages = tug.counter.texts;
  const result: Result = {
    ticks: TICKS,
    checkpoints,
    messageTypes: Object.fromEntries(pilots.map((p) => [p.spec.name, Object.fromEntries(Object.entries(p.counter.types).sort())])),
    faults: Object.fromEntries(Object.entries(server.faultCounts() as Record<string, number>).sort()),
    probes,
  };
  vi.useRealTimers();
  vi.restoreAllMocks();
  return result;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('golden whole-server frame hash', () => {
  it('900 scripted ticks with four pilots reproduce the pinned frame and world hashes', () => {
    const a = scenario();
    const b = scenario();
    expect(b, 'the scenario must be deterministic within one process').toEqual(a);
    expect(a.faults, 'no system faulted during the run').toEqual({});
    // The script really exercised towing, dodging (several ways) and every pilot's guns
    expect(a.probes.towTicks).toBeGreaterThan(300);
    expect(a.probes.dodges).toBeGreaterThanOrEqual(4);
    expect(new Set(a.probes.dodgeDirs).size).toBeGreaterThanOrEqual(3);
    for (const n of ['strafer', 'tug', 'striker', 'sparrow']) expect(a.probes.firedTicks[n] ?? 0, `${n} fired`).toBeGreaterThan(0);
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(a, null, 2) + '\n');
      if (process.env.UPDATE_GOLDEN !== '1') throw new Error(`no golden file: wrote ${GOLDEN}; rerun to check it`);
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8')) as Result;
    // Compare tick by tick first so a failure names the first checkpoint that drifted
    for (let i = 0; i < golden.checkpoints.length; i++) expect(a.checkpoints[i], `checkpoint at tick ${golden.checkpoints[i].tick}`).toEqual(golden.checkpoints[i]);
    expect(a).toEqual(golden);
  }, 300_000);
});
