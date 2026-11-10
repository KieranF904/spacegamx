import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { FLASH_RESTORE_TICKS, type Blueprint } from '@space-game/common';
import { GameServer } from '../../../GameServer.js';
import { GameData } from '../../../data/GameData.js';
import { readGameDataFiles } from '../../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../loadShipConfig.js';
import { createShipBridge } from '../../../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../../../data');

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = new GameServer({ gameData: new GameData(readGameDataFiles(dataDir)), userDB: {} as any, scene: 'sectors', autoStart: false, ships: createShipBridge({ ...loadShipConfigCached(dataDir), playerBubbles: true }) });
  return { server, ships: server.getShips() };
}

/** The starter ship with parts added beside its first gun (free cells at x -2) */
function withParts(base: Blueprint, extra: { fn: string; x: number; y: number }[]): Blueprint {
  const bp: Blueprint = JSON.parse(JSON.stringify(base));
  extra.forEach((e, k) => bp.parts.push({ uid: 900 + k, piece: 'sq', fn: e.fn, material: 'steel', x: e.x, y: e.y, rot: 0, flip: false } as never));
  return bp;
}

describe('Flash Screen (server half)', () => {
  const spawn = (extra: { fn: string; x: number; y: number }[]) => {
    const w = world();
    const e = w.ships.spawnDummy(withParts(w.ships.playerBlueprint, extra), 0, 300000, 0, 0);
    return { ...w, e, ship: w.ships.get(e)! };
  };

  it('comes back whole after 240 ticks', () => {
    const { server, ships, e, ship } = spawn([{ fn: 'shield_flash_screen', x: -2, y: 0 }]);
    expect(ship.derived.shieldMax).toBe(36);
    expect(ship.shield).toBe(36);
    ships.hurt(e, ship, 0, 36);
    expect(ship.shield).toBe(0);
    for (let i = 0; i < FLASH_RESTORE_TICKS - 5; i++) server.step();
    expect(ship.shield).toBe(0);
    for (let i = 0; i < 10; i++) server.step();
    expect(ship.shield).toBe(36);
  });

  // (A Capacitor bank paying to bring it back at once was the pool core's, removed with it: on the ports core the Flash
  // Screen draws nothing yet, a known gap the owner deferred with the ports switch)
  it.todo('on the ports core: a store touching it pays to bring it back at once (deferred: Flash draws nothing on ports)');

});

describe('Spaced Plating', () => {
  it('takes half damage from splash, and full damage from a hit', () => {
    const w = world();
    const e = w.ships.spawnDummy(withParts(w.ships.playerBlueprint, [{ fn: 'plating_spaced_plating', x: -2, y: 0 }]), 0, 300000, 0, 0);
    const ship = w.ships.get(e)!;
    const i = ship.blueprint.parts.findIndex((p) => p.fn === 'plating_spaced_plating');
    expect(i).toBeGreaterThan(0);
    const lost = (splash: boolean) => {
      const was = ship.hp[i];
      w.ships.hurt(e, ship, i, 20, -1, splash ? { splash: true } : undefined);
      return was - ship.hp[i];
    };
    const hit = lost(false), blast = lost(true);
    expect(hit).toBeGreaterThan(0);
    expect(blast).toBeCloseTo(hit / 2, 5);
  });
});
