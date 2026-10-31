/**
 * Cargo mass and the Stabiliser Anchor in the full server: a laden pilot flies
 * heavy, a braced one holds against pulls, recharges its shield faster, and
 * the replicas (the server's own shadows of what clients predict) stay on the
 * real path through all of it.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, ServerMessage, parseBlueprint, DEFAULT_ANCHOR, isBraced, type Blueprint } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const sparrow: Blueprint = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/sparrow-t.json'), 'utf-8'));
/** The Sparrow with a Stabiliser Anchor on its right flank and a Deflector on its left */
const braceable: Blueprint = {
  ...sparrow,
  parts: [
    ...sparrow.parts,
    { uid: 50, piece: 'block2', fn: 'utility_stabiliser_anchor', material: 'steel', x: 3, y: -1, rot: 0, flip: false },
    { uid: 51, piece: 'sq', fn: 'shield_deflector', material: 'steel', x: -2, y: 0, rot: 0, flip: false },
  ],
};

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => 1_000_000,
  });
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

  it('taking cargo on sends one keyframe carrying it; otherwise replicas stay on the real path', () => {
    const { server, conn, input, run } = world();
    const rep = (server as any).replication;
    input({ forward: true, targetAngle: 0.4 });
    run(30);
    const before = { ...rep.reasons };
    server.pilots.get(conn)!.cargo.push({ id: 'iron_ore', n: 20 });
    run(30);
    const after = Object.fromEntries(Object.entries(rep.reasons as Record<string, number>).map(([k, v]) => [k, v - (before[k] ?? 0)]).filter(([k, v]) => k.startsWith('Player:') && (v as number) > 0));
    expect(after).toEqual({ 'Player:cargo': 1 });
  });
});

describe('Stabiliser Anchor in the server', () => {
  const braced = () => {
    const w = world();
    w.ships.respawnInPlace(w.pid, braceable);
    expect(w.ships.get(w.pid)!.derived.anchor).toBeGreaterThanOrEqual(0.5);
    return w;
  };

  it('braces after its spool, and the replicas follow it there without a keyframe', () => {
    const { server, pid, input, run, ships } = braced();
    const rep = (server as any).replication;
    run(2);
    const before = { ...rep.reasons };
    input({ brace: true });
    run(DEFAULT_ANCHOR.braceTicks - 2);
    expect(ships.isBraced(pid)).toBe(false);
    run(4);
    expect(ships.isBraced(pid)).toBe(true);
    expect(isBraced(ships.get(pid)!.brace)).toBe(true);
    const moved = Object.entries(rep.reasons as Record<string, number>).filter(([k, v]) => k.startsWith('Player:') && v !== (before[k] ?? 0));
    expect(moved).toEqual([]);
  });

  it('braced, pulls and knockback do not move it; free, they do', () => {
    const { server, pid, input, run, ships } = braced();
    const nudge = (server as any).weapons.host.nudge as (eid: number, ax: number, ay: number) => void;
    nudge(pid, 5, 0);
    expect(Velocity.x[pid]).toBeCloseTo(5, 6);
    Velocity.x[pid] = 0;
    input({ brace: true });
    run(DEFAULT_ANCHOR.braceTicks + 2);
    expect(ships.pullShare(pid)).toBe(DEFAULT_ANCHOR.pull);
    const vx = Velocity.x[pid];
    nudge(pid, 5, 0);
    expect(Velocity.x[pid]).toBeCloseTo(vx, 6);
  });

  it('braced, its shield recharges faster and a hit takes less of it', () => {
    const regen = (brace: boolean) => {
      const { pid, input, run, ships } = braced();
      input({ brace });
      run(DEFAULT_ANCHOR.braceTicks + 2);
      const ship = ships.get(pid)!;
      expect(ship.derived.shieldMax).toBeGreaterThan(0);
      ship.shield = 0;
      ship.shieldHitTick = -10000;
      run(60);
      const gained = ship.shield;
      ship.shield = ship.derived.shieldMax;
      (ships as any).hurt(pid, ship, 0, 10, -1);
      return { gained, lost: ship.derived.shieldMax - ship.shield };
    };
    const free = regen(false), held = regen(true);
    expect(held.gained / free.gained).toBeCloseTo(1 + DEFAULT_ANCHOR.shieldRegen, 1);
    expect(held.lost).toBeLessThan(free.lost);
    expect(free.lost / held.lost).toBeCloseTo(1 + DEFAULT_ANCHOR.shieldSoak, 3);
  });
});
