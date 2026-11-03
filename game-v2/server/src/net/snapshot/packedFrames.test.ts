/**
 * Bit-packed frames and coalescing (CAPS.PACKED, CAPS.COALESCE; common network/packed, PackedLink.ts) on a real
 * GameServer: a pilot fires at a parked freighter while two observers watch from the same distance, one on packed and
 * coalesced frames, one on the base format. Every packed message the server sends is decoded on the side and compared,
 * frame by frame, with what the base format makes of the same messages; by the end both observers have seen the same
 * damage, fires, impacts, detonations and removed shells, and hold the server's part HP; the packed one got fewer,
 * smaller WebSocket messages. The shooter takes everything (confirmed and client-detected hits too).
 *
 * Also: switching packed frames off and on mid-fight, a request's answer going at once, and an idle observer's
 * messages coalesced.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'path';
import { isDeepStrictEqual } from 'util';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Input, InSystem, CAPS, hpWire, ReplicaMode, replicaAngle, quantizeReplicaAngle, PackedEncoder, PackedDecoder,
  ServerFrameReader, decodeServerFrame, encodeServerMessage, serverFrame,
  type ShipState, type ReplicaEnv, type ClientSocket, type ClientMessage, type ServerMessage,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { COALESCE_TICKS } from './constants.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const PACKED = CAPS.PACKED | CAPS.COALESCE;
// (Finding its own hits takes its own shells as fire events too: as rows they are told, not found)
const ALL = CAPS.HITS | CAPS.SELF_HITS | PACKED | CAPS.OWN_SHOTS;

/** Every packed message encoded is decoded on the side (a decoder per encoder) and compared with the base format */
function teeEncoder() {
  const shadow = new WeakMap<PackedEncoder, PackedDecoder>();
  const tee = { frames: 0, bad: [] as string[], packed: 0, legacy: 0 };
  const orig = PackedEncoder.prototype.encode;
  vi.spyOn(PackedEncoder.prototype, 'encode').mockImplementation(function (this: PackedEncoder, subs, you) {
    const data = orig.call(this, subs, you);
    let dec = shadow.get(this);
    if (!dec) shadow.set(this, (dec = new PackedDecoder()));
    const got = dec.decode(data);
    const want = subs.map((sub) => decodeServerFrame(serverFrame(sub.map((p) => encodeServerMessage(p.msg)))));
    tee.frames += subs.length;
    if (!isDeepStrictEqual(got, want) && tee.bad.length < 5) tee.bad.push(JSON.stringify({ got, want }).slice(0, 600));
    return data;
  });
  return tee;
}

afterEach(() => { vi.restoreAllMocks(); });

/** PACKED_DEBUG: what each message type cost, packed and as the base format (all clients) */
const typeCost: Record<string, [number, number, number]> = {};
if (process.env.PACKED_DEBUG) {
  const proto = PackedEncoder.prototype as unknown as { message(this: { io: { bitLength: number } }, part: { msg: ServerMessage }): void };
  const orig = proto.message;
  proto.message = function (part) {
    const b0 = this.io.bitLength;
    orig.call(this, part);
    const e = (typeCost[part.msg.type] ??= [0, 0, 0]);
    e[0]++; e[1] += encodeServerMessage(part.msg).length; e[2] += (this.io.bitLength - b0) / 8;
  };
}

function makeServer() {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
    netCaps: ALL,
  });
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  return { server, clock, env };
}

/** The ships whose HP a client should hold as the server has it, and what it holds instead */
function hpOff(server: GameServer, f: FakeHitsClient, tag: string): string[] {
  const conn = server.pilots.connOf(f.pid)!;
  const out: string[] = [];
  for (const [id, s] of server.getShips().bodies) {
    const synced = conn.shipSynced.get(id), mine = f.store.get(id);
    if (!synced || synced.ship !== s || synced.rebuilds !== s.rebuilds || !mine || !conn.shipView.has(id) || conn.debrisHeld.has(id)) continue;
    const want = s.hp.map(hpWire), got = (mine as ShipState).hp;
    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) out.push(`${tag} ship ${id} part ${i}: ${got[i]} vs ${want[i]}`);
  }
  return out;
}

interface Fight {
  ticks?: number;
  /** At these ticks the packed observer's caps change to these (switching packed frames off and on) */
  switches?: [number, number][];
  seed?: number;
}

function fight(sc: Fight) {
  // (A seeded world: the same fight every run)
  let seed = sc.seed ?? 0x2545f491;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
  const tee = teeEncoder();
  const { server, clock, env } = makeServer();
  const ships = server.getShips();
  const S = new FakeHitsClient(server, { name: 'shooter', caps: ALL, env });
  const P = new FakeHitsClient(server, { name: 'packed_obs', caps: PACKED, env });
  const B = new FakeHitsClient(server, { name: 'legacy_obs', caps: 0, env });
  const fakes = [S, P, B];
  const step = () => {
    server.step();
    clock.t += 1000 / 60;
    for (const f of fakes) f.flushUp();
  };
  for (let i = 0; i < 20; i++) step();
  // (The shooter can't die; the observers aren't admins, so no admin stats in their streams)
  { const c = server.pilots.connOf(S.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); c.isAdmin = false; }
  const num = InSystem.systemId[S.pid];
  ships.respawnInPlace(S.pid, ships.library.get('sparrow-t')!);
  const x0 = Position.x[S.pid] + 30000, y0 = Position.y[S.pid] + 30000;
  const place = (p: number, x: number, y: number) => { Position.x[p] = x; Position.y[p] = y; Velocity.x[p] = 0; Velocity.y[p] = 0; };
  place(S.pid, x0, y0);
  place(P.pid, x0 - 300, y0 + 400);
  place(B.pid, x0 - 300, y0 - 400);
  const target = ships.spawnDummy(ships.library.get('hauler')!, x0 + 700, y0, 0, num);
  const ship = ships.get(target)!;
  for (let i = 0; i < ship.hp.length; i++) ship.hp[i] *= 0.03;
  const counts0 = fakes.map((f) => ({ messages: f.messages, frames: f.frames, bytes: f.bytes }));
  const ticks = sc.ticks ?? 900;
  for (let t = 0; t < ticks; t++) {
    for (const [at, caps] of sc.switches ?? []) if (t === at) server.pilots.connOf(P.pid)!.capsNext = caps;
    for (const k of ['forward', 'backward', 'left', 'right', 'fireLeft', 'fireRight', 'boost'] as const) Input[k][S.pid] = 0;
    if (ships.has(target)) {
      const dx = Position.x[target] - Position.x[S.pid], dy = Position.y[target] - Position.y[S.pid];
      Input.targetAngle[S.pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.atan2(dy, dx)));
      Input.cursorDist[S.pid] = Math.hypot(dx, dy);
      Input.fireLeft[S.pid] = 1; Input.fireRight[S.pid] = 1;
    }
    place(S.pid, x0, y0);
    step();
  }
  for (const k of ['fireLeft', 'fireRight'] as const) Input[k][S.pid] = 0;
  for (let t = 0; t < 90; t++) step();
  // (What a coalesced client's link still holds, the last tick or two of the stream: out now, so all are compared as of now)
  for (const f of fakes) server.pilots.connOf(f.pid)!.packed?.drain(server.getTick());
  const counts = fakes.map((f, i) => ({ messages: f.messages - counts0[i].messages, frames: f.frames - counts0[i].frames, bytes: f.bytes - counts0[i].bytes }));
  return { server, S, P, B, tee, counts, target };
}

/** Two observers saw the same fight */
function expectSameView(x: FakeHitsClient, y: FakeHitsClient) {
  const keys = new Set([...x.damage.keys(), ...y.damage.keys()]);
  for (const k of keys) expect(x.damage.get(k) ?? 0, k).toBeCloseTo(y.damage.get(k) ?? 0, 6);
  expect([...x.ignites].sort()).toEqual([...y.ignites].sort());
  expect(x.projectileHits).toBe(y.projectileHits);
  expect(x.detonations).toBe(y.detonations);
  const gone = (a: FakeHitsClient, b: FakeHitsClient) => [...a.removed].filter((id) => b.known.has(id)).sort((m, n) => m - n);
  expect(gone(x, y)).toEqual(gone(y, x));
}

describe('packed frames: a packed and a base-format observer see the same fight', () => {
  it('Pips on a freighter: parts shot away, debris, the freighter dying', () => {
    const r = fight({});
    if (process.env.PACKED_DEBUG) console.log(JSON.stringify({ tee: { ...r.tee, bad: r.tee.bad.length }, counts: r.counts, P: server(r).P, S: server(r).S, typeCost }));
    // Every packed message decoded to exactly what the base format would have carried
    expect(r.tee.bad).toEqual([]);
    expect(r.tee.frames).toBeGreaterThan(100);
    // The same fight seen, and the server's HP held, by all three
    expectSameView(r.P, r.B);
    expect(r.P.projectileHits + r.B.damage.size).toBeGreaterThan(0);
    for (const [f, tag] of [[r.S, 'S'], [r.P, 'P'], [r.B, 'B']] as const) expect(hpOff(r.server, f, tag).slice(0, 5)).toEqual([]);
    // The shooter's own hits: found by itself, no corrections, no HP check off
    expect(r.server.hits.stats.own).toBeGreaterThan(0);
    expect(r.server.hits.stats.fixes).toBe(0);
    expect(r.S.hits!.stats.mismatches).toBe(0);
    // Fewer, smaller messages for the packed observer (the same frames inside them)
    const [, p, b] = r.counts;
    expect(p.frames).toBeGreaterThanOrEqual(b.frames * 0.9);
    expect(p.messages).toBeLessThan(b.messages * 0.85);
    // (A short fight: most of an observer's bytes here are ship designs and part losses, which pack least)
    expect(p.bytes).toBeLessThan(b.bytes * 0.75);
  }, 120_000);

  it("the shooter finds its own hits, so they don't make its frames go early; it still sees every hit", () => {
    const r = fight({});
    const st = server(r).S!;
    if (process.env.PACKED_DEBUG) console.log(JSON.stringify({ S: st, counts: r.counts }));
    // (Before, damage to or from its ship and the snapshot after a hit went at once: nearly every message was early)
    expect(st.why.damage ?? 0).toBe(0);
    expect(st.why.hitSnapshot ?? 0).toBe(0);
    // (what is left: the test re-placing its ship each tick, a correction; the join)
    expect(st.urgent).toBeLessThan(st.messages * 0.2);
    // ...so its sub-frames share messages as an idle pilot's do
    expect(st.subFrames).toBeGreaterThan(st.messages * 1.6);
    // The same hits, fires and blasts as the legacy observer, its shells gone the same, and the server's HP
    expectSameView(r.S, r.B);
    expect(hpOff(r.server, r.S, 'S').slice(0, 5)).toEqual([]);
    expect(r.S.hits!.stats.mismatches).toBe(0);
  }, 120_000);

  it('switching packed frames off and on mid-fight keeps everything in order', () => {
    const r = fight({ ticks: 600, switches: [[150, 0], [300, PACKED], [420, CAPS.PACKED], [500, PACKED]] });
    expect(r.tee.bad).toEqual([]);
    expectSameView(r.P, r.B);
    expect(hpOff(r.server, r.P, 'P').slice(0, 5)).toEqual([]);
    expect(r.server.pilots.connOf(r.P.pid)!.packed).toBeDefined();
  }, 120_000);
});

/** A raw client: what it got, message by message */
function rawClient(server: GameServer, caps: number) {
  const reader = new ServerFrameReader();
  const got: ServerMessage[][][] = [];
  const socket: ClientSocket = { isOpen: () => true, send: (data) => { got.push(reader.read(data as Uint8Array)); } };
  const link = server.connect(socket);
  link.receive({ type: 'join', username: `raw_${caps}`, caps } as ClientMessage);
  return { got, link, pid: () => server.getPlayerId(socket), socket };
}

describe('packed frames: coalescing', () => {
  it("an idle pilot's frames wait for each other; an answer to a request goes at once", () => {
    teeEncoder();
    const { server, clock } = makeServer();
    const C = rawClient(server, PACKED), L = rawClient(server, 0);
    for (let i = 0; i < 30; i++) { server.step(); clock.t += 1000 / 60; }
    const c0 = C.got.length, l0 = L.got.length;
    for (let i = 0; i < 600; i++) { server.step(); clock.t += 1000 / 60; }
    const cMsgs = C.got.length - c0, lMsgs = L.got.length - l0;
    const cFrames = C.got.slice(c0).reduce((n, m) => n + m.length, 0);
    expect(cFrames).toBeGreaterThanOrEqual(lMsgs * 0.9);
    expect(cMsgs).toBeLessThan(lMsgs * 0.8);
    // Nothing waited longer than the window: each message's first snapshot is at most COALESCE_TICKS older than its last
    for (const m of C.got.slice(c0)) {
      const ticks = m.flat().filter((x) => x.type === 'snapshot').map((x) => (x as { tick: number }).tick);
      if (ticks.length > 1) expect(ticks[ticks.length - 1] - ticks[0]).toBeLessThanOrEqual(COALESCE_TICKS);
    }
    // A request's answer (a message the tick's stream doesn't carry) goes before the next tick
    const before = C.got.length;
    C.link.receive({ type: 'ping', clientTime: 123 } as unknown as ClientMessage);
    expect(C.got.length).toBe(before + 1);
    expect(C.got[before].flat().some((m) => m.type === 'pong')).toBe(true);
    const conn = server.pilots.connOf(C.pid())!;
    server.net.batching++;
    server.net.send(conn.ws, { type: 'toast', text: 'now', kind: 'info' } as ServerMessage);
    server.net.batching--;
    server.flushOutbox();
    expect(C.got[C.got.length - 1].flat().some((m) => m.type === 'toast')).toBe(true);
  }, 60_000);
});

function server(r: ReturnType<typeof fight>) {
  const link = (f: FakeHitsClient) => r.server.pilots.connOf(f.pid)!.packed;
  return { P: link(r.P)?.stats, S: link(r.S)?.stats };
}
