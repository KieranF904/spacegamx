/**
 * Lasers, pulse guns and the Lance in a running server: the Cutter's ramp (family-beams-pulse).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Input, InSystem, Position, Velocity, Rotation, isWeaponFn, ServerMessage, replicaAngle, quantizeReplicaAngle, ReplicaMode } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const X = 25000, Y = 20000;
const aimEast = () => replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(0));

/** A pilot whose every gun is this weapon model, held at (X, Y), and what its client is sent */
function pilotWith(model: string, cargo?: { id: string; n: number }, guns = 2) {
  resetGlobals();
  const server = new GameServer({ profileStore: new MemoryProfileStore(), gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)) });
  const t = new LocalTransport(server);
  const got: { tick: number; m: ServerMessage }[] = [];
  t.onMessage = (m) => got.push({ tick: server.getTick(), m });
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId(), conn = server.pilots.connOf(pid)!;
  const p = server.pilots.get(conn)!;
  // (The starter's guns are Pips, swapped in place as the parity harness does: its mounting rules aren't the point here)
  const ships = server.getShips()!;
  const bp = ships.get(pid)!.blueprint;
  let n = 0;
  ships.respawnInPlace(pid, { ...bp, parts: bp.parts.map((q) => ((q.fn === 'cannon_pip' || isWeaponFn(q.fn)) && n++ < guns ? { ...q, fn: model } : q)) });
  if (cargo) p.cargo.push(cargo);
  const hold = () => { Position.x[pid] = X; Position.y[pid] = Y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  const detonations = (kind: string) => got.filter((g) => g.m.type === 'detonation' && (g.m as any).kind === kind).map((g) => ({ tick: g.tick, ...(g.m as any) }));
  return { server, t, got, pid, ships, hold, detonations };
}


/** A pilot with this beam and a pirate skiff held `gap` east of it; `burn` steps a tick with the trigger held (or not), and returns what the beam dealt, by part */
function beamRig(model: string, gap = 400) {
  const w = pilotWith(model, undefined, 1);
  const [skiff] = w.server.enemies.spawnPack(InSystem.systemId[w.pid], { faction: 'pirates', ships: ['pirate_skiff'] }, X + gap, Y);
  const dealt: { part: number; amount: number }[] = [];
  const ships = w.ships as any, hurt = ships.hurt.bind(ships);
  ships.hurt = (eid: number, ship: unknown, part: number, amount: number, src: number, hit?: unknown) => {
    const d = hurt(eid, ship, part, amount, src, hit);
    if (eid === skiff && src === w.pid && amount < 5) dealt.push({ part, amount });
    return d;
  };
  const sk = w.ships.get(skiff)!;
  const burn = (held: boolean, at?: number) => {
    w.hold(); Rotation.angle[w.pid] = 0;
    Position.x[skiff] = X + gap; Position.y[skiff] = Y + (at ?? 0); Velocity.x[skiff] = 0; Velocity.y[skiff] = 0; Rotation.angle[skiff] = 0;
    sk.shield = 0;
    for (let i = 0; i < sk.hp.length; i++) sk.hp[i] = sk.maxHp[i];
    Input.fireLeft[w.pid] = held ? 1 : 0; Input.cursorDist[w.pid] = gap; Input.targetAngle[w.pid] = aimEast();
    const n = dealt.length;
    w.server.step();
    return dealt.slice(n);
  };
  return { ...w, skiff, burn, dealt };
}

describe('Cutter: it burns deeper the longer it stays on one part', () => {
  const sum = (hits: { amount: number }[]) => hits.reduce((a, d) => a + d.amount, 0);

  it('60 dps rising to 150 over 90 ticks on the same part', () => {
    const r = beamRig('laser_cutter');
    const per: number[] = [];
    for (let i = 0; i < 130; i++) { const d = sum(r.burn(true)); if (d > 0) per.push(d); }
    // (Damage a tick is the dps over 60 at the gun's strength, so the ratio is the ramp)
    expect(per[0]).toBeGreaterThan(0);
    for (let i = 1; i < per.length; i++) expect(per[i]).toBeGreaterThanOrEqual(per[i - 1] - 1e-9);
    expect(per[40] / per[0]).toBeGreaterThan(1.3);
    expect(per[40] / per[0]).toBeLessThan(2);
    expect(per[129] / per[0]).toBeCloseTo(150 / 60, 2);
    expect(new Set(r.dealt.map((d) => d.part)).size).toBe(1);
  });

  it('starts over when the trigger is let go', () => {
    const r = beamRig('laser_cutter');
    let start = 0, last = 0;
    for (let i = 0; i < 110; i++) { const d = sum(r.burn(true)); if (d > 0) { last = d; if (!start) start = d; } }
    expect(last / start).toBeCloseTo(2.5, 2);
    for (let i = 0; i < 6; i++) r.burn(false);
    expect(sum(r.burn(true))).toBeCloseTo(start, 6);
  });

  it('starts over when the beam slips to another part', () => {
    const r = beamRig('laser_cutter');
    let start = 0, last = 0;
    for (let i = 0; i < 110; i++) { const d = sum(r.burn(true)); if (d > 0) { last = d; if (!start) start = d; } }
    const part = r.dealt[r.dealt.length - 1].part;
    expect(last / start).toBeCloseTo(2.5, 2);
    // Slide the target sideways until the beam finds another part
    let moved = -1;
    for (let dy = 8; dy <= 120 && moved < 0; dy += 8) { const hits = r.burn(true, dy); if (hits.length && hits[0].part !== part) moved = sum(hits); }
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeCloseTo(start, 6);
  });
});
