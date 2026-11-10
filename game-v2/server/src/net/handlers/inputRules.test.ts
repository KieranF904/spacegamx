/**
 * The server's rules for inputs (net/handlers/flight.ts handleInput), on a real GameServer:
 *   - a late input (its tick already stepped) never rewrites what was stepped: it goes on the next step, and its client
 *     is corrected (selfLate);
 *   - one stamped further ahead than MAX_INPUT_LEAD (64 ticks) is dropped; one at the limit lands on its tick;
 *   - berthed, the controls are neutral and stay so: what was waiting is dropped, as is anything sent before the
 *     client knew (its seq is still taken); undocked, inputs count again;
 *   - a respawned ship starts with neutral controls (aim 0), whatever the last one had;
 *   - compact inputs (CAPS.INPUTS) through the per-socket decoder land on the same ticks with the same controls.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Input, Position, InSystem, Station, InputEncoder, InputDecoder, dequantizeCursorAngle, quantizeCursorAngle, cursorDistOnGrid,
  type ClientInputMessage, type ClientSocket,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../ships/createShipBridge.js';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { makeServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world() {
  resetGlobals();
  const server = makeServer({ profileStore: new MemoryProfileStore() });
  const t = new LocalTransport(server);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as never);
  for (let i = 0; i < 5; i++) server.step();
  const conn = () => server.pilots.connOf(t.getPlayerId())! as unknown as { scheduledInputs: unknown[]; selfLate: boolean; lastInputSeq: number; docked: unknown; playerId: number };
  const tick = () => (server as unknown as { currentTick: number }).currentTick;
  return { server, t, conn, tick, pid: () => t.getPlayerId() };
}

const input = (seq: number, at: number | undefined, o: Partial<ClientInputMessage> = {}): ClientInputMessage => ({
  type: 'input', seq, tick: 0, targetTick: at === undefined ? undefined : at & 0xffff, forward: false, backward: false, left: false, right: false,
  boost: false, fireLeft: false, fireRight: false, targetAngle: 0, cursorDist: 0, ...o,
});

describe('input rules', () => {
  it('a late input goes on the next step: nothing already stepped is rewritten, and the client is corrected', () => {
    const w = world();
    const pid = w.pid();
    for (let i = 0; i < 10; i++) w.server.step();
    const now = w.tick();
    w.t.send(input(1, now - 5, { forward: true }));
    expect(Input.forward[pid]).toBe(0);
    w.conn().selfLate = false;
    w.server.step();
    expect(Input.forward[pid]).toBe(1);
    expect(w.conn().selfLate).toBe(true);
    // (the server keeps no history to rewind: what it sent for those ticks stands; the input counts from now)
    expect(w.tick()).toBe(now + 1);
  });

  it('an input stamped too far ahead is dropped; one at the limit lands on its tick exactly', () => {
    const w = world();
    const pid = w.pid();
    const now = w.tick();
    w.t.send(input(1, now + 65, { forward: true }));
    w.t.send(input(2, now + 64, { left: true }));
    w.server.step();
    expect(w.conn().scheduledInputs.length).toBe(1);
    while (w.tick() < now + 63) { w.server.step(); expect(Input.left[pid]).toBe(0); }
    w.server.step();
    expect(Input.left[pid]).toBe(1);
    for (let i = 0; i < 5; i++) w.server.step();
    expect(Input.forward[pid]).toBe(0);
  });

  it('berthed: the controls go neutral and stay so; what waited and what comes before the client knows is dropped', () => {
    const w = world();
    const pid = w.pid();
    const st = bitecs.defineQuery([Station, Position])((w.server as unknown as { world: bitecs.IWorld }).world).find((s) => InSystem.systemId[s] === InSystem.systemId[pid])!;
    Position.x[pid] = Position.x[st] + 100; Position.y[pid] = Position.y[st];
    w.t.send(input(1, w.tick() + 1, { forward: true, fireLeft: true, targetAngle: 1 }));
    w.server.step();
    expect(Input.forward[pid]).toBe(1);
    w.t.send(input(2, w.tick() + 20, { right: true }));
    w.server.step();
    expect(w.conn().scheduledInputs.length).toBe(1);
    w.t.send({ type: 'dock' } as never);
    expect(w.conn().docked).toBeTruthy();
    expect([Input.forward[pid], Input.fireLeft[pid], w.conn().scheduledInputs.length]).toEqual([0, 0, 0]);
    // the aim stays as it was (as the client holds it)
    expect(quantizeCursorAngle(Input.targetAngle[pid])).toBe(quantizeCursorAngle(1));
    // sent before it knew: dropped, its seq taken
    w.t.send(input(3, w.tick() + 3, { forward: true }));
    for (let i = 0; i < 6; i++) w.server.step();
    expect(Input.forward[pid]).toBe(0);
    expect(w.conn().lastInputSeq).toBe(3);
    w.t.send({ type: 'undock' } as never);
    w.t.send(input(4, w.tick() + 2, { backward: true }));
    for (let i = 0; i < 3; i++) w.server.step();
    expect(Input.backward[pid]).toBe(1);
  });

  it('a respawned ship starts with neutral controls, and nothing from before waits for a tick', () => {
    const w = world();
    const pid = w.pid();
    w.t.send(input(1, w.tick() + 1, { forward: true, helm: true, targetAngle: 2, cursorDist: 800 }));
    w.server.step();
    w.t.send(input(2, w.tick() + 30, { left: true }));
    w.server.step();
    // (the way a pilot's ship goes: removed the tick it dies; then the respawn request)
    bitecs.removeEntity((w.server as unknown as { world: bitecs.IWorld }).world, pid);
    w.t.send({ type: 'respawn' } as never);
    const np = w.conn().playerId;
    expect([Input.forward[np], Input.helm[np], Input.targetAngle[np], Input.cursorDist[np], Input.left[np]]).toEqual([0, 0, 0, 0, 0]);
    expect(w.conn().scheduledInputs.length).toBe(0);
  });
});

describe('compact inputs through the server', () => {
  it('land on their ticks with exactly the controls sent, mixed with the base layout', () => {
    const w = world();
    // A socket of its own, as SocketTransport has one: an encoder on the client, a decoder per connection
    const socket: ClientSocket = { isOpen: () => true, send: () => {} };
    const link = w.server.connect(socket);
    link.receive({ type: 'join', username: 'compact' } as never);
    const pid = w.server.getPlayerId(socket);
    const enc = new InputEncoder(), dec = new InputDecoder();
    const send = (m: ClientInputMessage, compact = true) => link.receive(dec.decode(enc.encode(m, compact)));
    let seed = 3;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const want = new Map<number, ClientInputMessage>();
    let q = 100, seq = 0;
    for (let i = 0; i < 400; i++) {
      const at = w.tick() + 3;
      if (rnd() < 0.5) {
        q = (q + Math.floor((rnd() - 0.5) * 300) * 2 + 8192) % 8192;
        const m = input(++seq, at, { forward: rnd() < 0.5, fireLeft: rnd() < 0.3, targetAngle: dequantizeCursorAngle(q), cursorDist: cursorDistOnGrid(rnd() * 3000) });
        send(m, rnd() < 0.85);
        want.set(at, m);
      }
      w.server.step();
      // the step just run flew what was stamped for it, if anything was
      const m = want.get(w.tick());
      if (m) {
        expect([Input.forward[pid], Input.fireLeft[pid], quantizeCursorAngle(Input.targetAngle[pid]), Input.sequence[pid]]).toEqual([m.forward ? 1 : 0, m.fireLeft ? 1 : 0, quantizeCursorAngle(m.targetAngle), m.seq]);
        // (the base layout carries the distance in 4-unit steps)
        expect(Math.abs(Input.cursorDist[pid] - m.cursorDist!)).toBeLessThanOrEqual(2);
      }
    }
    expect(enc.stats.compact).toBeGreaterThan(100);
  });
});
