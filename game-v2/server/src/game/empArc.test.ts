/**
 * EMP and arc (Hush, Blackout, Spark, Tesla) in a running server: the Blackout charges and fires itself (and lets go
 * early, nothing fires), the Tesla zaps on a beat while held and chains, and the section 4 numbers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  parseBlueprint, Input, InSystem, Position, Velocity, isWeaponFn, ServerMessage, replicaAngle, quantizeReplicaAngle, ReplicaMode,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const X = 25000, Y = 20000;
const aimEast = () => replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(0));

/** A pilot whose guns are this weapon model, held at (X, Y) */
function pilotWith(model: string, guns = 1, fed = false) {
  resetGlobals();
  const server = new GameServer({ profileStore: new MemoryProfileStore(), gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)) });
  const t = new LocalTransport(server);
  const got: { tick: number; m: ServerMessage }[] = [];
  t.onMessage = (m) => got.push({ tick: server.getTick(), m });
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const ships = server.getShips()!;
  // (Its guns fed in full when asked (the gun range's flag, types.ts Blueprint.range): a Tesla burns 170 E/s and a Cell
  // Reactor makes 35, so on the starter it sputters)
  const bp = fed ? { ...ships.get(pid)!.blueprint, range: true as const } : ships.get(pid)!.blueprint;
  let n = 0;
  ships.respawnInPlace(pid, { ...bp, parts: bp.parts.map((q) => ((q.fn === 'cannon_pip' || isWeaponFn(q.fn)) && n++ < guns ? { ...q, fn: model } : q)) });
  const hold = () => { Position.x[pid] = X; Position.y[pid] = Y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  const detonations = (kind: string) => {
    const out: any[] = [];
    for (const g of got) {
      const ms = g.m.type === 'batch' ? (g.m as any).m : [g.m];
      for (const m of ms) if (m.type === 'detonation' && m.kind === kind) out.push({ tick: g.tick, ...m });
    }
    return out;
  };
  const fire = (on: boolean, dist: number) => { Input.fireLeft[pid] = on ? 1 : 0; Input.cursorDist[pid] = dist; Input.targetAngle[pid] = aimEast(); };
  return { server, pid, ships, hold, detonations, fire };
}

const hpOf = (ship: { hp: ArrayLike<number>; shield: number }) => { let s = ship.shield; for (let i = 0; i < ship.hp.length; i++) s += ship.hp[i]; return s; };

describe('Blackout: a charge that fires itself', () => {
  it('held, it charges for 90 ticks and then fires on its own; the orb bursts', () => {
    const w = pilotWith('emp_blackout');
    let tick = 0;
    for (; tick < 400 && !w.detonations('emp').length; tick++) { w.hold(); w.fire(true, 700); w.server.step(); }
    const boom = w.detonations('emp')[0];
    expect(boom).toBeTruthy();
    expect(boom.radius).toBe(320);
    // (90 ticks of charge, then the orb's flight: not before the charge is full)
    expect(tick).toBeGreaterThan(90);
    expect(tick).toBeLessThan(200);
    // It keeps going while held: the 240-tick cooldown, then a second charge
    const first = tick;
    for (; tick < first + 600 && w.detonations('emp').length < 2; tick++) { w.hold(); w.fire(true, 700); w.server.step(); }
    expect(w.detonations('emp').length).toBe(2);
    expect(tick - first).toBeGreaterThan(240);
  });

  it('let go before it is full, nothing fires', () => {
    const w = pilotWith('emp_blackout');
    for (let i = 0; i < 60; i++) { w.hold(); w.fire(true, 700); w.server.step(); }
    for (let i = 0; i < 300; i++) { w.hold(); w.fire(false, 700); w.server.step(); }
    expect(w.detonations('emp').length).toBe(0);
  });
});

describe('Tesla: a held storm that zaps on a beat', () => {
  function teslaOn(second: boolean) {
    const w = pilotWith('arc_tesla', 99, true);
    const sys = InSystem.systemId[w.pid];
    const [a] = w.server.enemies.spawnPack(sys, { faction: 'pirates', ships: ['pirate_skiff'] }, X + 400, Y);
    const [b] = second ? w.server.enemies.spawnPack(sys, { faction: 'pirates', ships: ['pirate_skiff'] }, X + 400, Y + 150) : [-1];
    const place = () => {
      w.hold();
      Position.x[a] = X + 400; Position.y[a] = Y; Velocity.x[a] = 0; Velocity.y[a] = 0;
      if (b >= 0) { Position.x[b] = X + 400; Position.y[b] = Y + 150; Velocity.x[b] = 0; Velocity.y[b] = 0; }
    };
    return { ...w, a, b, place };
  }

  it('burns in lumps 12 ticks apart while held, and not at all when let go', () => {
    const w = teslaOn(false);
    const ship = w.ships.get(w.a)!;
    const hits: number[] = [];
    let last = -1;
    for (let i = 0; i < 90; i++) {
      w.place(); ship.shield = 0; w.fire(true, 400);
      w.server.step();
      const now = hpOf(ship);
      if (last >= 0 && now < last - 0.01) hits.push(i);
      last = now;
    }
    expect(hits.length).toBeGreaterThanOrEqual(5);
    for (let k = 1; k < hits.length; k++) expect(hits[k] - hits[k - 1]).toBe(12);
    const n = hits.length;
    for (let i = 0; i < 60; i++) { w.place(); ship.shield = 0; w.fire(false, 400); w.server.step(); }
    expect(hits.length).toBe(n);
    const before = hpOf(ship);
    for (let i = 0; i < 30; i++) { w.place(); ship.shield = 0; w.fire(false, 400); w.server.step(); }
    expect(hpOf(ship)).toBeGreaterThanOrEqual(before - 0.01);
  });

  it('each zap leaps to a second ship nearby, and everyone is shown the hop', () => {
    const w = teslaOn(true);
    const sa = w.ships.get(w.a)!, sb = w.ships.get(w.b)!;
    const a0 = hpOf(sa), b0 = hpOf(sb);
    for (let i = 0; i < 30; i++) { w.place(); sa.shield = 0; sb.shield = 0; w.fire(true, 400); w.server.step(); }
    const da = a0 - hpOf(sa), db = b0 - hpOf(sb);
    expect(da).toBeGreaterThan(0);
    expect(db).toBeGreaterThan(0);
    expect(w.detonations('tesla_arc').length).toBeGreaterThan(0);
    expect(w.detonations('tesla_arc')[0].from).toBeTruthy();
  });
});

describe('section 4 numbers', () => {
  const models: any = JSON.parse(JSON.stringify(require(join(dataDir, 'ships/models.json'))));
  const byId = (id: string) => (models.models ?? models).find((m: any) => m.id === id);
  const area: Record<string, number> = { sq: 1, round: Math.PI / 4 };

  it('Hush: a shot every 162 ticks costing 25 E, a 90-tick fuse; Spark: 45 ticks, 13.5 E', () => {
    const h = byId('emp_hush'), s = byId('arc_spark');
    expect(h.fire.interval).toBe(162);
    expect((h.demand * area.sq * 162) / 60).toBeCloseTo(25, 1);
    expect(h.weaponMods.set.life).toBe(90);
    expect(s.fire.interval).toBe(45);
    expect((s.demand * area.sq * 45) / 60).toBeCloseTo(13.5, 1);
  });

  it('Blackout: charge 90, cooldown 240, 90 E, r320, 168 ticks; Tesla: 30 E/s, a zap per 12 ticks of 14, chain 5', () => {
    const b = byId('emp_blackout'), t = byId('arc_tesla');
    expect(b.fire).toMatchObject({ model: 'charge', charge: 90, cooldown: 240, chargeE: 90 });
    expect(b.weaponMods.set.emp).toEqual({ radius: 320, ticks: 168 });
    expect(b.weaponMods.set.endAtAim).toBe(true);
    expect(t.fire.model).toBe('beam');
    expect(t.demand * area.round).toBeCloseTo(30, 1);
    expect(t.weaponMods.set).toMatchObject({ zap: 12, range: 660, chain: { count: 5, radius: 300, falloff: 0.5 } });
    expect((t.weaponMods.set.dps / 60) * t.weaponMods.set.zap).toBeCloseTo(14, 6);
  });
});
