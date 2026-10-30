import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Velocity } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from './loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = new GameServer({ gameData: new GameData(readGameDataFiles(dataDir)), userDB: {} as any, scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)) });
  return { server, ships: server.getShips() };
}

const ahead = () => ({ controls: { forward: true, backward: false, left: false, right: false, boost: false, targetAngle: 0 }, firing: false });

describe('damage cripples a ship', () => {
  it('shot down to its core it limps; losing parts never makes it quicker', () => {
    const { server, ships } = world();
    const raider = (keep: (fn: string) => boolean, x: number) => {
      const e = ships.spawnDummy(ships.enemyDesigns['pirate_raider'], x, 300000, 0, 0);
      ships.get(e)!.blueprint.parts.forEach((p, i) => { if (!keep(p.fn)) ships.damagePartFraction(e, i, 1); });
      ships.setController(e, ahead);
      return e;
    };
    const whole = raider(() => true, 200000);
    const core = raider((f) => f === 'core', 220000);
    const engines = raider((f) => ['core', 'thruster', 'generator', 'conduit'].includes(f), 240000);
    for (let i = 0; i < 60 * 12; i++) server.step();
    const speed = (e: number) => Math.hypot(Velocity.x[e], Velocity.y[e]);
    expect(speed(core)).toBeLessThan(speed(whole) * 0.45);
    expect(speed(engines)).toBeLessThan(speed(whole) * 0.85);
    expect(speed(engines)).toBeGreaterThan(speed(core));
    expect(ships.get(core)!.derived.drive).toBeLessThan(0.4);
  });

  it('unbuilt (ghost) parts aren\'t damage', () => {
    const { ships } = world();
    const e = ships.spawnDummy(ships.playerBlueprint, 0, 0, 0, 0);
    const bp = ships.get(e)!.blueprint;
    ships.setGhosts(e, bp.parts.filter((p) => p.fn !== 'core' && p.fn !== 'thruster').slice(0, 4).map((p) => p.uid));
    const d = ships.get(e)!.derived;
    expect(d.drive).toBe(1);
    expect(d.fullMass).toBeCloseTo(d.mass, 6);
  });
});
