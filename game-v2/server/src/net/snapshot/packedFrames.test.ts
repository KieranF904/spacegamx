/**
 * Bit-packed frames and coalescing (CAPS.PACKED, CAPS.COALESCE; common network/packed, PackedLink.ts) on a real
 * GameServer: a pilot fires at a parked freighter while an observer watches. Every packed message the server sends is
 * decoded on the side and compared, frame by frame, with what the base format makes of the same messages (and what the
 * base format would have cost: a WebSocket message a frame, those bytes); by the end the shooter and the observer were
 * shown the damage, fires, impacts, detonations and removed shells the server's own record of the fight has
 * (hits/serverTruth.testkit.ts), and hold the server's part HP; the packed streams took fewer, smaller WebSocket messages
 * than the base format would have. Every client takes everything (full caps).
 *
 * Also: a request's answer going at once, and an idle pilot's messages coalesced.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'path';
import { isDeepStrictEqual } from 'util';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, InSystem, hpWire, PackedEncoder, PackedDecoder, encodeMessage, decodeMessage,
  ServerFrameReader, decodeServerFrame, encodeServerMessage, serverFrame,
  type ShipState, type ReplicaEnv, type ClientSocket, type ClientMessage, type ServerMessage,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { serverTruth, damageOff, removedBoth, type ServerTruth } from '../hits/serverTruth.testkit.js';
import { COALESCE_TICKS } from './constants.js';
import { makeServer as makeTestServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

/**
 * Every packed message encoded is decoded on the side (a decoder per encoder) and compared with the base format; per
 * encoder, what the base format would have cost the same frames (a WebSocket message each, and its bytes)
 */
function teeEncoder() {
  const shadow = new WeakMap<PackedEncoder, PackedDecoder>();
  const base = new Map<PackedEncoder, { messages: number; bytes: number }>();
  const tee = { frames: 0, bad: [] as string[], base };
  const orig = PackedEncoder.prototype.encode;
  vi.spyOn(PackedEncoder.prototype, 'encode').mockImplementation(function (this: PackedEncoder, subs, you) {
    const data = orig.call(this, subs, you);
    let dec = shadow.get(this);
    if (!dec) shadow.set(this, (dec = new PackedDecoder()));
    const got = dec.decode(data);
    const frames = subs.map((sub) => serverFrame(sub.map((p) => encodeServerMessage(p.msg))));
    const want = frames.map((f) => decodeServerFrame(f));
    const b = base.get(this) ?? { messages: 0, bytes: 0 };
    base.set(this, b);
    b.messages += frames.length;
    for (const f of frames) b.bytes += f.length;
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
  const server = makeTestServer({ clock: () => clock.t });
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  return { server, clock, env };
}

/** The ships whose HP a client should hold as the server has it, and what it holds instead */
function hpOff(server: GameServer, f: FakeHitsClient, tag: string): string[] {
  const conn = server.pilots.connOf(f.pid)! as unknown as { shipSynced: Map<number, { ship: ShipState; rebuilds: number }>; shipView: Set<number>; debrisHeld: Map<number, unknown> };
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
  seed?: number;
}

type Link = { enc: PackedEncoder; stats: { messages: number; subFrames: number; bytes: number; urgent: number; why: Record<string, number> } };
const linkOf = (server: GameServer, f: FakeHitsClient) => (server.pilots.connOf(f.pid)! as unknown as { packed?: Link }).packed;

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
  const S = new FakeHitsClient(server, { name: 'shooter', env });
  const P = new FakeHitsClient(server, { name: 'observer', env });
  const fakes = [S, P];
  const truth = serverTruth(server);
  // The shooter flies by input messages, as a real client (it steps its own ship from them: set on the side they'd be a
  // late input, a keyframe of its own ship); its checks ride them, its hit report goes straight to the ledger
  let seq = 1, chk: ReturnType<FakeHitsClient['own']['takeCheck']>;
  const aim = { fire: false, angle: 0, dist: 0 };
  const step = () => {
    const msg = {
      type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1,
      forward: false, backward: false, left: false, right: false, boost: false,
      fireLeft: aim.fire, fireRight: aim.fire, targetAngle: aim.angle, cursorDist: aim.dist, ...(chk ? { ownCheck: chk } : {}),
    } as unknown as ClientMessage;
    chk = undefined;
    const dec = decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientMessage;
    S.noteInput(dec);
    S.link!.receive(dec);
    server.step();
    clock.t += 1000 / 60;
    chk = S.own.takeCheck(true, server.getTick());
    const rep = S.selfHits.takeReport(true);
    if (rep) server.hits.report(server.pilots.connOf(S.pid)! as never, rep);
    for (const m of S.outbox.splice(0)) S.link?.receive(m);
    P.flushUp();
  };
  for (let i = 0; i < 20; i++) step();
  // (The shooter can't die; the observer isn't an admin, so no admin stats in its stream)
  { const c = server.pilots.connOf(S.pid)! as unknown as { isAdmin: boolean }; c.isAdmin = true; server.admin.run(c as never, 'god', { on: 'on' }); c.isAdmin = false; }
  const num = InSystem.systemId[S.pid];
  ships.respawnInPlace(S.pid, ships.library.get('sparrow-t')!);
  const x0 = Position.x[S.pid] + 30000, y0 = Position.y[S.pid] + 30000;
  const place = (p: number, x: number, y: number) => { Position.x[p] = x; Position.y[p] = y; Velocity.x[p] = 0; Velocity.y[p] = 0; };
  place(S.pid, x0, y0);
  place(P.pid, x0 - 300, y0 + 400);
  const target = ships.spawnDummy(ships.library.get('hauler')!, x0 + 700, y0, 0, num);
  const ship = ships.get(target)!;
  for (let i = 0; i < ship.hp.length; i++) ship.hp[i] *= 0.03;
  const counts0 = fakes.map((f) => ({ messages: f.messages, frames: f.frames, bytes: f.bytes }));
  const base0 = fakes.map((f) => ({ ...(tee.base.get(linkOf(server, f)!.enc) ?? { messages: 0, bytes: 0 }) }));
  const ticks = sc.ticks ?? 900;
  for (let t = 0; t < ticks; t++) {
    aim.fire = false;
    if (ships.has(target)) {
      const dx = Position.x[target] - Position.x[S.pid], dy = Position.y[target] - Position.y[S.pid];
      aim.angle = Math.atan2(dy, dx);
      aim.dist = Math.hypot(dx, dy);
      aim.fire = true;
    }
    step();
  }
  aim.fire = false;
  for (let t = 0; t < 90; t++) step();
  // (What a coalesced client's link still holds, the last tick or two of the stream: out now, so all are compared as of now)
  for (const f of fakes) (server.pilots.connOf(f.pid)! as unknown as { packed?: { drain(t: number): number } }).packed?.drain(server.getTick());
  const counts = fakes.map((f, i) => {
    const b = tee.base.get(linkOf(server, f)!.enc)!;
    return {
      messages: f.messages - counts0[i].messages, frames: f.frames - counts0[i].frames, bytes: f.bytes - counts0[i].bytes,
      // (what the base format would have sent of the same frames: a message each)
      baseMessages: b.messages - base0[i].messages, baseBytes: b.bytes - base0[i].bytes,
    };
  });
  return { server, S, P, tee, truth, counts, target };
}

/** A client was shown the fight the server had */
function expectShown(f: FakeHitsClient, truth: ServerTruth) {
  const allowance = 0.051 * (f.hits.stats.records + f.hits.stats.own) + 0.2;
  expect(damageOff(f.damage, truth.damage, allowance).slice(0, 5)).toEqual([]);
  expect([...f.ignites].sort()).toEqual([...truth.ignites].sort());
  expect(f.projectileHits).toBe(truth.impacts);
  expect(f.detonations).toBe(truth.detonations);
  const gone = removedBoth(f, truth);
  expect(gone.client).toEqual(gone.server);
}

describe('packed frames: what each client is shown is the server\'s fight, in fewer, smaller messages', () => {
  it('Pips on a freighter: parts shot away, debris, the freighter dying', () => {
    const r = fight({});
    if (process.env.PACKED_DEBUG) console.log(JSON.stringify({ tee: { frames: r.tee.frames, bad: r.tee.bad.length }, counts: r.counts, P: linkOf(r.server, r.P)?.stats, S: linkOf(r.server, r.S)?.stats, typeCost }));
    // Every packed message decoded to exactly what the base format would have carried
    expect(r.tee.bad).toEqual([]);
    expect(r.tee.frames).toBeGreaterThan(100);
    // The same fight the server had, and the server's HP held, by both
    expectShown(r.P, r.truth);
    expect(r.P.projectileHits + r.truth.damage.size).toBeGreaterThan(0);
    for (const [f, tag] of [[r.S, 'S'], [r.P, 'P']] as const) expect(hpOff(r.server, f, tag).slice(0, 5)).toEqual([]);
    // The shooter's own hits: found by itself, no corrections, no HP check off
    expect(r.server.hits.stats.own).toBeGreaterThan(0);
    expect(r.server.hits.stats.fixes).toBe(0);
    expect(r.S.hits.stats.mismatches).toBe(0);
    // Fewer, smaller messages for the observer than the base format would have sent of the same frames
    const [, p] = r.counts;
    expect(p.frames).toBe(p.baseMessages);
    expect(p.messages).toBeLessThan(p.baseMessages * 0.85);
    // (A short fight: most of an observer's bytes here are ship designs and part losses, which pack least)
    expect(p.bytes).toBeLessThan(p.baseBytes * 0.75);
    // (every snapshot went as encode-once blocks; each row was encoded once however many clients took it. A snapshot goes
    // only when there is something to say: with its own shells worked out by the shooter, about one in five rounds here)
    expect(linkOf(r.server, r.P)!.enc.stats.blocks).toBeGreaterThan(40);
    expect(linkOf(r.server, r.S)!.enc.stats.blocks).toBeGreaterThan(40);
    const st = r.server.net.blocks.stats;
    // (the observer steps the shooter's guns itself since other ships' guns are stepped from their inputs: no fire rows of
    // its shells, net/guns/GunNet.ts; was > 100 with them)
    expect(st.k + st.c + st.f + st.e).toBeGreaterThan(60);
  }, 120_000);

  it("the shooter finds its own hits, so they don't make its frames go early; it still sees every hit", () => {
    const r = fight({});
    const st = linkOf(r.server, r.S)!.stats;
    if (process.env.PACKED_DEBUG) console.log(JSON.stringify({ S: st, counts: r.counts }));
    // (Before, damage to or from its ship and the snapshot after a hit went at once: nearly every message was early)
    expect(st.why.damage ?? 0).toBe(0);
    expect(st.why.hitSnapshot ?? 0).toBe(0);
    // (what is left: the join and its first frames)
    expect(st.urgent).toBeLessThan(st.messages * 0.2);
    // ...so its sub-frames share messages as an idle pilot's do: as well as the observer's beside it, near enough (how
    // many frames share depends on how busy the stream is: sparse now that a snapshot goes only with something in it)
    const idle = r.counts[1].frames / r.counts[1].messages;
    expect(idle).toBeGreaterThan(1.15);
    expect(st.subFrames / st.messages).toBeGreaterThan(idle * 0.9);
    // The hits, fires and blasts the server had, its shells gone the same, and the server's HP
    expectShown(r.S, r.truth);
    expect(hpOff(r.server, r.S, 'S').slice(0, 5)).toEqual([]);
    expect(r.S.hits.stats.mismatches).toBe(0);
  }, 120_000);
});

/** A raw client: what it got, message by message */
function rawClient(server: GameServer, name: string) {
  const reader = new ServerFrameReader();
  const got: ServerMessage[][][] = [];
  const socket: ClientSocket = { isOpen: () => true, send: (data) => { got.push(reader.read(data as Uint8Array)); } };
  const link = server.connect(socket);
  link.receive({ type: 'join', username: name } as ClientMessage);
  return { got, link, pid: () => server.getPlayerId(socket), socket };
}

describe('packed frames: coalescing', () => {
  it("an idle pilot's frames wait for each other; an answer to a request goes at once", () => {
    teeEncoder();
    const { server, clock } = makeServer();
    const C = rawClient(server, 'raw_idle');
    for (let i = 0; i < 30; i++) { server.step(); clock.t += 1000 / 60; }
    const c0 = C.got.length;
    for (let i = 0; i < 600; i++) { server.step(); clock.t += 1000 / 60; }
    const cMsgs = C.got.length - c0;
    const cFrames = C.got.slice(c0).reduce((n, m) => n + m.length, 0);
    // (the base format would have sent a message a frame)
    expect(cMsgs).toBeLessThan(cFrames * 0.8);
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
    const conn = server.pilots.connOf(C.pid())! as unknown as { ws: ClientSocket };
    server.net.batching++;
    server.net.send(conn.ws, { type: 'toast', text: 'now', kind: 'info' } as ServerMessage);
    server.net.batching--;
    server.flushOutbox();
    expect(C.got[C.got.length - 1].flat().some((m) => m.type === 'toast')).toBe(true);
  }, 60_000);
});
