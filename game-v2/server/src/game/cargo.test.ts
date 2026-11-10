/**
 * Cargo mass in the full server: a laden pilot flies heavy, and the replicas
 * (the server's own shadows of what clients predict) stay on the real path,
 * one keyframe carrying the load when it changes. (These lived in
 * anchor.test.ts until the Stabiliser Anchor was removed.)
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { makeEmptyServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
function world() {
  resetGlobals();
  const server = makeEmptyServer({ clock: () => 1_000_000 });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'hauler' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  // Out in open space, away from anything
  Position.x[pid] = 40000; Position.y[pid] = 40000; Velocity.x[pid] = 0; Velocity.y[pid] = 0; Rotation.angle[pid] = -Math.PI / 2;
  let seq = 1;
  const input = (i: Record<string, unknown>) => t.send({ type: 'input', seq: seq++, tick: 0, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: -Math.PI / 2, ...i } as any);
  const run = (n: number) => { for (let k = 0; k < n; k++) server.step(); };
  return { server, pid, conn, input, run, ships: server.getShips()! };
}

describe('cargo mass in the server', () => {
  const thrust = (load: number) => {
    const { server, pid, conn, input, run, ships } = world();
    if (load) server.pilots.get(conn)!.cargo.push({ id: 'iron_ore', n: load });
    input({ forward: true });
    run(40);
    return { speed: Math.hypot(Velocity.x[pid], Velocity.y[pid]), cargo: ships.get(pid)!.cargo ?? 0, server };
  };

  it('a full hold of ore accelerates slower; the mass rides on the ship', () => {
    const empty = thrust(0), full = thrust(30);
    expect(empty.cargo).toBe(0);
    expect(full.cargo).toBeCloseTo(3, 6);
    expect(full.speed).toBeGreaterThan(0);
    expect(full.speed).toBeLessThan(empty.speed * 0.9);
  });

  it('taking cargo on goes as one CARGO cause; replicas stay on the real path', () => {
    const { server, pid, conn, input, run } = world();
    const rep = (server as any).replication;
    input({ forward: true, targetAngle: 0.4 });
    run(30);
    const before = { ...rep.reasons }, v0 = rep.versionOf(pid);
    // (The pilot's own causes worked out: whatever else is about, say two pirates bumping, has its own)
    let worked = 0;
    const work = rep.work.bind(rep);
    rep.work = (eid: number, ...rest: unknown[]) => { const w = work(eid, ...rest); if (eid === pid && w) worked++; return w; };
    server.pilots.get(conn)!.cargo.push({ id: 'iron_ore', n: 20 });
    run(30);
    const after = Object.fromEntries(Object.entries(rep.reasons as Record<string, number>).map(([k, v]) => [k, v - (before[k] ?? 0)]).filter(([k, v]) => k.startsWith('Player:') && !k.endsWith(':caused') && (v as number) > 0));
    // (The shadow worked the new mass out: never off its path, so no divergence (its pilot's client steps it, so the
    // window is counted 'Player:caused', a cause told, not a divergence); its shared version moved once)
    expect(after).toEqual({});
    expect(worked).toBe(1);
    expect(rep.versionOf(pid) - v0).toBe(1);
  });
});

