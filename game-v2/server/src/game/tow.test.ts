/**
 * The Burst Strafer and the Tow Beam in the full server: a dodge throws the
 * pilot sideways and the replicas (the server's shadows of what clients
 * predict) stay on the real path through it; a tow takes hold of a wreck,
 * pulls it along, weighs on the pilot, and salvages it into storage at a
 * station; working ships are never towed.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, InSystem, ServerMessage, parseBlueprint, worldToLocalDir, strafeForce, dodgePhase, DODGE_LEFT, DODGE_RIGHT, pilotExtras, type Blueprint } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const sparrow: Blueprint = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/sparrow-t.json'), 'utf-8'));
const corsair: Blueprint = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/bulwark.json'), 'utf-8'));
/** The Sparrow with a Burst Strafer on each flank and a Tow Beam under its left wing, in place of the wing's armour tip (a Tug-ish Dancer) */
const fitted: Blueprint = {
  ...sparrow,
  parts: [
    ...sparrow.parts.filter((p) => p.uid !== 10),
    { uid: 60, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: 3, y: 0, rot: 0, flip: false, facing: 'E' },
    { uid: 61, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: -2, y: 0, rot: 0, flip: false, facing: 'W' },
    { uid: 62, piece: 'rect2', fn: 'utility_tow_beam', material: 'steel', x: -2, y: 2, rot: 0, flip: false, facing: 'S' },
  ] as Blueprint['parts'],
};

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigCached(dataDir)),
    clock: () => 1_000_000,
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'tug' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  // Out in open space, away from anything, nose up
  Position.x[pid] = 40000; Position.y[pid] = 40000; Velocity.x[pid] = 0; Velocity.y[pid] = 0; Rotation.angle[pid] = -Math.PI / 2;
  let seq = 1;
  const input = (i: Record<string, unknown>) => t.send({ type: 'input', seq: seq++, tick: 0, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: -Math.PI / 2, ...i } as any);
  const run = (n: number) => { for (let k = 0; k < n; k++) server.step(); };
  const ships = server.getShips()!;
  ships.respawnInPlace(pid, fitted);
  return { server, t, got, pid, conn, input, run, ships };
}

describe('Burst Strafer in the server', () => {
  it('a press dodges once (no way held: sideways, then back the other way), and the replicas follow it without a keyframe', () => {
    const { server, pid, input, run, ships } = world();
    const d = ships.get(pid)!.derived;
    expect(strafeForce(d.fx?.strafe, DODGE_LEFT)).toBeGreaterThan(0);
    expect(strafeForce(d.fx?.strafe, DODGE_RIGHT)).toBeGreaterThan(0);
    const rep = (server as any).replication;
    run(3);
    const before = { ...rep.reasons };
    input({ dodge: true });
    run(d.fx!.strafe!.ticks + 5);
    const lat = worldToLocalDir([Velocity.x[pid], Velocity.y[pid]], Rotation.angle[pid])[0];
    expect(lat).toBeGreaterThan(2);
    expect(ships.get(pid)!.dodgeDir).toBe(DODGE_RIGHT);
    // Held: no second burst, however long. Let go and press again: a second one, the other way
    run(d.fx!.strafe!.cooldown + 10);
    expect(dodgePhase(ships.get(pid)!.dodge, d.fx?.strafe).phase).toBe('held');
    input({ dodge: false });
    run(2);
    expect(dodgePhase(ships.get(pid)!.dodge, d.fx?.strafe).phase).toBe('ready');
    input({ dodge: true });
    run(d.fx!.strafe!.ticks + 2);
    expect(ships.get(pid)!.dodgeDir).toBe(DODGE_LEFT);
    expect(worldToLocalDir([Velocity.x[pid], Velocity.y[pid]], Rotation.angle[pid])[0]).toBeLessThan(0);
    const moved = Object.entries(rep.reasons as Record<string, number>).filter(([k, v]) => k.startsWith('Player:') && v !== (before[k] ?? 0));
    expect(moved).toEqual([]);
  });

  it("the pilot's snapshot row carries the dodge counter and its way (the prediction replays from them)", () => {
    const { got, input, run } = world();
    input({ dodge: true, left: true });
    run(5);
    const snaps = got.filter((m) => m.type === 'snapshot') as any[];
    expect(snaps.length).toBeGreaterThan(0);
    // (Whatever the snapshot encoding, the pilot's own row has its data: find a row carrying a dodge under way)
    const rows = snaps.flatMap((s) => (s.e ?? s.entities ?? []) as any[]).map((r) => (Array.isArray(r) ? r[9] : r.data)).filter((x) => Array.isArray(x) && x.length > 16);
    expect(rows.some((data: number[]) => pilotExtras(data).dodge > 0 && pilotExtras(data).dodgeDir === DODGE_LEFT)).toBe(true);
  });
});

describe('Tow Beam in the server', () => {
  /** A derelict-style wreck (a Corsair) `dist` to the pilot's left */
  const withWreck = (dist = 300) => {
    const w = world();
    const wreck = w.ships.spawnWreck(corsair, Position.x[w.pid] - dist, Position.y[w.pid], 0, InSystem.systemId[w.pid], 7);
    w.run(1);
    // Aim at it
    w.input({ targetAngle: Math.PI, cursorDist: dist });
    w.run(1);
    return { ...w, wreck };
  };

  it('takes hold of the wreck nearest the cursor, pulls it along, and the pilot carries its load', () => {
    const { t, pid, wreck, input, run, ships, server } = withWreck();
    expect(ships.towable(wreck)?.kind).toBe('wreck');
    t.send({ type: 'tow', on: true } as any);
    run(1);
    expect((server as any).features.get('tow').targetOf(pid)).toBe(wreck);
    expect(ships.get(pid)!.tow).toBe(wreck);
    // Fly away to the right: the wreck comes after
    const x0 = Position.x[wreck];
    input({ right: true, targetAngle: -Math.PI / 2 });
    run(240);
    expect(Position.x[wreck]).toBeGreaterThan(x0 + 50);
    expect(Velocity.x[wreck]).toBeGreaterThan(0);
    expect(ships.get(pid)!.cargo ?? 0).toBeGreaterThan(0);
    // Let go: the load's gone, it coasts
    t.send({ type: 'tow', on: false } as any);
    run(2);
    expect((server as any).features.get('tow').targetOf(pid)).toBeUndefined();
    expect(ships.get(pid)!.tow).toBeUndefined();
    expect(ships.get(pid)!.cargo ?? 0).toBe(0);
  });

  it('a towing pilot flies heavier than a free one', () => {
    const speed = (tow: boolean) => {
      const { t, pid, input, run } = withWreck(250);
      if (tow) t.send({ type: 'tow', on: true } as any);
      run(1);
      input({ right: true, targetAngle: -Math.PI / 2 });
      run(120);
      return Math.hypot(Velocity.x[pid], Velocity.y[pid]);
    };
    expect(speed(true)).toBeLessThan(speed(false) * 0.9);
  });

  it('towed into a station, a wreck is salvaged for plate into storage and is gone', () => {
    const { t, pid, conn, wreck, run, ships, server } = withWreck();
    t.send({ type: 'tow', on: true } as any);
    run(1);
    const storage = () => server.pilots.get(conn)!.storage.reduce((n, s) => n + s.n, 0);
    const before = storage(), salvaged = server.pilots.get(conn)!.stats.salvaged ?? 0;
    // In a station's reach
    (server as any).stationInRange = () => 1;
    run(1);
    expect(ships.has(wreck)).toBe(false);
    expect(storage()).toBeGreaterThan(before);
    expect(server.pilots.get(conn)!.stats.salvaged ?? 0).toBe(salvaged + 1);
    expect((server as any).features.get('tow').targetOf(pid)).toBeUndefined();
  });

  it('never takes hold of a working ship, and nothing out of reach', () => {
    const { t, pid, got, run, ships, server } = withWreck(3000);
    t.send({ type: 'tow', on: true } as any);
    run(1);
    expect((server as any).features.get('tow').targetOf(pid)).toBeUndefined();
    expect(got.some((m) => m.type === 'systemMessage' && /Nothing to tow/.test((m as any).text))).toBe(true);
    // The pilot's own ship, or any pilot's, isn't towable
    expect(ships.towable(pid)).toBeNull();
  });

  it('a ship with no Tow Beam is told so', () => {
    const w = world();
    w.ships.respawnInPlace(w.pid, sparrow);
    w.t.send({ type: 'tow', on: true } as any);
    w.run(1);
    expect(w.got.some((m) => m.type === 'systemMessage' && /No Tow Beam/.test((m as any).text))).toBe(true);
  });
});
