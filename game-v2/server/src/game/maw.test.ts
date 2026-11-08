import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, createShipState, hitMultiplier, weaponHit, validateBlueprint } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);

describe('the Heart of the Maw', () => {
  it('is huge, slow and plated in Mk V, with Mk II vents that are the way in', () => {
    const ships = createShipBridge(loadShipConfigCached(dataDir));
    const cat = ships.catalog, tun = ships.tuning;
    const bp = ships.enemyDesigns.maw_heart_titan;
    expect(validateBlueprint(cat, bp, tun).ok).toBe(true);
    expect(bp.parts.length).toBeLessThanOrEqual(255);
    const heart = createShipState(cat, tun, 0, bp, 0).derived, starter = createShipState(cat, tun, 0, ships.playerBlueprint, 0).derived;
    expect(heart.radius).toBeGreaterThan(starter.radius * 6);
    expect(heart.maxThrust.forward / heart.mass).toBeLessThan((starter.maxThrust.forward / starter.mass) * 0.15);
    // Every gun it carries has the power to fire
    expect(heart.weapons.length).toBeGreaterThanOrEqual(8);
    for (const w of heart.weapons) expect(w.satisfaction, w.kind).toBeGreaterThan(0.95);
    // A Mk I gun barely scratches the shell; the vents take it about as a Mk II hull would
    const mk1 = weaponHit('cannon', tun.weapons.cannon, 1);
    const shell = bp.parts.find((p) => p.fn === 'armor')!, vent = bp.parts.find((p) => p.material === 'steel')!;
    expect(hitMultiplier(cat, tun, shell, mk1)).toBeLessThanOrEqual(0.06);
    expect(hitMultiplier(cat, tun, vent, mk1)).toBeGreaterThan(0.4);
    // A Mk IV gun gets through the vents easily and makes some headway against the shell
    expect(hitMultiplier(cat, tun, shell, weaponHit('cannon', tun.weapons.cannon, 4))).toBeGreaterThan(0.15);
  });

  it('wakes at its lair as built, beats (a telegraphed ring), and its spawn launch from its hull', () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = new GameServer({ gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any, scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)) });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'diver' } as any);
    const pid = t.getPlayerId(), conn = server.pilots.connOf(pid)! as any;
    const def = (files.bosses as any).bosses.boss_maw_heart;
    const num = server.gameData.getSystemNum('the_maw');
    (server as any).travelTo(conn, num, def.lair.x, def.lair.y + 5000, false);
    for (let i = 0; i < 130; i++) { Position.x[pid] = def.lair.x; Position.y[pid] = def.lair.y + 5000; Velocity.x[pid] = Velocity.y[pid] = 0; server.step(); }
    const bosses = (server as any).bosses;
    const eid = bosses.eidOf('boss_maw_heart');
    expect(eid).toBeGreaterThanOrEqual(0);
    const ships = server.getShips();
    const ship = ships.get(eid)!;
    // Built exactly as designed: its plate is neutronium, not regraded
    expect(ship.blueprint.parts.some((p) => p.material === 'neutronium')).toBe(true);
    expect(InSystem.systemId[eid]).toBe(num);
    // Hurt it past its second phase: lurkers come out of its bays, at its hull
    const before = new Set([...ships.bodies.keys()]);
    ships.healAll?.(eid, 0);
    for (let i = 0; i < ship.hp.length; i++) if (ship.blueprint.parts[i].fn !== 'core') ship.hp[i] = ship.maxHp[i] * 0.6;
    for (let i = 0; i < 70; i++) server.step();
    const spawn = [...ships.bodies.keys()].filter((e) => !before.has(e) && server.enemies.factionOf(e) === 'maw');
    expect(spawn.length).toBeGreaterThan(0);
    for (const e of spawn) expect(Math.hypot(Position.x[e] - Position.x[eid], Position.y[e] - Position.y[eid])).toBeLessThan(ship.derived.radius + 1500);
  });
});
