/**
 * Determinism check: record N ticks of input, replay them on a fresh proto
 * server, and hash the ship state. Matching hashes mean the ship code is ready
 * for client prediction once networking returns.
 *
 * Runs a whole GameServer, so call it where no other server shares the bitecs
 * globals: a test process or a Web Worker, never next to a live game.
 */

import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, Health, ClientInputMessage, Blueprint, seededRng, hashInts } from '@space-game/common';
import { createProtoServer, ProtoServerOptions } from '../proto/createProtoServer.js';
import { LocalTransport } from '../net/LocalTransport.js';
import type { ShipBridge } from './ShipBridge.js';

export type RecordedInput = Omit<ClientInputMessage, 'type' | 'seq' | 'tick'>;

/** A seeded stream of plausible flight inputs (held for a few ticks at a time). */
export function recordInputs(seed: number, ticks: number): RecordedInput[] {
  const rng = seededRng(seed);
  const out: RecordedInput[] = [];
  let cur: RecordedInput = { forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0 };
  for (let t = 0; t < ticks; t++) {
    if (t % 15 === 0) {
      cur = {
        forward: rng() < 0.6, backward: rng() < 0.15, left: rng() < 0.3, right: rng() < 0.3,
        boost: rng() < 0.2, fireLeft: rng() < 0.5, fireRight: false,
        targetAngle: (rng() * 2 - 1) * Math.PI,
      };
    }
    out.push({ ...cur, targetAngle: cur.targetAngle + Math.sin(t / 20) * 0.3 });
  }
  return out;
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
function pushFloat(acc: number[], v: number): void {
  f64[0] = v;
  acc.push(u32[0], u32[1]);
}

/** Hash every ship and debris body: pose, velocity, spin, per-part HP and detachment. */
export function hashShips(bridge: ShipBridge): number {
  const acc: number[] = [];
  for (const eid of [...bridge.bodies.keys()].sort((a, b) => a - b)) {
    const s = bridge.bodies.get(eid)!;
    acc.push(eid, s.kind === 'ship' ? 1 : 2, s.blueprint.parts.length);
    for (const v of [Position.x[eid], Position.y[eid], Velocity.x[eid], Velocity.y[eid], Rotation.angle[eid], s.angVel, Health.current[eid]]) pushFloat(acc, v);
    s.hp.forEach((hp, i) => { pushFloat(acc, hp); acc.push(s.detached[i] ? 1 : 0); });
    s.cooldown.forEach((c) => pushFloat(acc, c));
    s.aim.forEach((a) => pushFloat(acc, a));
  }
  return hashInts(...acc);
}

/** bitecs 0.3 exports resetGlobals at runtime but leaves it out of its type definitions. */
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

export interface ReplayOptions {
  files: ProtoServerOptions['files'];
  ships: ProtoServerOptions['ships'];
  inputs: RecordedInput[];
  /** Blueprint for a target dummy placed ahead of the player, so shots land and parts break */
  dummy?: Blueprint;
}

export function runReplay(opts: ReplayOptions): { hash: number; ticks: number; bodies: number } {
  resetGlobals();
  const server = createProtoServer({ files: opts.files, ships: opts.ships, autoStart: false });
  const bridge = server.getShips()!;
  const transport = new LocalTransport(server);
  transport.connect();
  transport.send({ type: 'join', username: 'replay' } as any);
  const pid = transport.getPlayerId();
  // createPlayer picks a random spawn point; pin it so runs start identically
  Position.x[pid] = 0;
  Position.y[pid] = 0;
  Velocity.x[pid] = 0;
  Velocity.y[pid] = 0;
  Rotation.angle[pid] = -Math.PI / 2;
  if (opts.dummy) bridge.spawnDummy(opts.dummy, 0, -260, Math.PI / 2);

  opts.inputs.forEach((inp, i) => {
    transport.send({ type: 'input', seq: i + 1, tick: i, ...inp });
    server.step();
  });
  return { hash: hashShips(bridge), ticks: server.getTick(), bodies: bridge.bodies.size };
}
