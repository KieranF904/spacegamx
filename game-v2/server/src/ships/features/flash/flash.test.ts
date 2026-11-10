import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { FLASH_RESTORE_TICKS, type Blueprint } from '@space-game/common';
import { GameServer } from '../../../GameServer.js';
import { GameData } from '../../../data/GameData.js';
import { readGameDataFiles } from '../../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../loadShipConfig.js';
import { createShipBridge } from '../../../ships/createShipBridge.js';
import { feedParts } from '../../../../../common/src/ships/testData.js';

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
  /** The starter with parts added beside its first gun, the Flash Screen fed by a Cell Reactor across its in port (fed) */
  const spawn = (extra: { fn: string; x: number; y: number }[], fed = true) => {
    const w = world();
    const bp = withParts(w.ships.playerBlueprint, extra);
    if (fed) feedParts(w.ships.catalog, bp, extra.map((_, k) => 900 + k));
    const e = w.ships.spawnDummy(bp, 0, 300000, 0, 0);
    return { ...w, e, ship: w.ships.get(e)! };
  };
  const flashPart = (ship: { derived: { fx?: { flash?: { parts: number[] } } } }) => ship.derived.fx!.flash!.parts[0];

  it('with its own store full, comes back at once and the store is spent', () => {
    const { ships, e, ship } = spawn([{ fn: 'shield_flash_screen', x: -2, y: 0 }]);
    const p = flashPart(ship), L = ship.derived.ports;
    expect(ship.derived.shieldMax).toBe(36);
    expect(ship.shield).toBe(36);
    expect(L.cap[p]).toBeGreaterThan(0);
    ships.hurt(e, ship, 0, 36);
    expect(ship.shield).toBe(36);
    expect(ships.chargeOf(e).e!.held[p]).toBe(0);
  });

  it('with its store spent, comes back whole after 240 ticks, and the store refills from its line', () => {
    const { server, ships, e, ship } = spawn([{ fn: 'shield_flash_screen', x: -2, y: 0 }]);
    const p = flashPart(ship), L = ship.derived.ports;
    ships.hurt(e, ship, 0, 36);
    expect(ship.shield).toBe(36);
    ships.hurt(e, ship, 0, 36);
    expect(ship.shield).toBe(0);
    for (let i = 0; i < FLASH_RESTORE_TICKS - 5; i++) server.step();
    expect(ship.shield).toBe(0);
    for (let i = 0; i < 10; i++) server.step();
    expect(ship.shield).toBe(36);
    const held = ships.chargeOf(e).e!.held[p];
    expect(held).toBeGreaterThan(0);
    for (let i = 0; i < 900; i++) server.step();
    expect(ships.chargeOf(e).e!.held[p]).toBe(L.cap[p]);
  });

  it('cut off from power, its store never refills: after the first, it always waits', () => {
    const { server, ships, e, ship } = spawn([{ fn: 'shield_flash_screen', x: -2, y: 0 }], false);
    ships.hurt(e, ship, 0, 36);
    expect(ship.shield).toBe(36);
    for (let i = 0; i < 900; i++) server.step();
    ships.hurt(e, ship, 0, 36);
    expect(ship.shield).toBe(0);
    for (let i = 0; i < FLASH_RESTORE_TICKS + 5; i++) server.step();
    expect(ship.shield).toBe(36);
  });

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
