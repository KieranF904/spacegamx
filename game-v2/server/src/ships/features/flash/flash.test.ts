import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { FLASH_RESTORE_TICKS, parseBlueprint, type Blueprint } from '@space-game/common';
import { readFileSync } from 'fs';
import { GameServer } from '../../../GameServer.js';
import { GameData } from '../../../data/GameData.js';
import { readGameDataFiles } from '../../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../loadShipConfig.js';
import { createShipBridge } from '../../../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../../../data');

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = new GameServer({ gameData: new GameData(readGameDataFiles(dataDir)), userDB: {} as any, scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)) });
  return { server, ships: server.getShips() };
}

/** The starter ship with parts added beside its first gun (free cells at x -2) */
function withParts(base: Blueprint, extra: { fn: string; x: number; y: number }[]): Blueprint {
  const bp: Blueprint = JSON.parse(JSON.stringify(base));
  extra.forEach((e, k) => bp.parts.push({ uid: 900 + k, piece: 'sq', fn: e.fn, material: 'steel', x: e.x, y: e.y, rot: 0, flip: false } as never));
  delete (bp as { wires?: unknown }).wires;
  return bp;
}

/** The pool-era starter (a fixture): its Capacitor banks are the pool core's (Charge.b) */
const poolSparrow = (): Blueprint => parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/fixtures/sparrow-t.json'), 'utf-8'));

describe('Flash Screen (server half)', () => {
  const spawn = (extra: { fn: string; x: number; y: number }[], pool = false) => {
    const w = world();
    const e = w.ships.spawnDummy(withParts(pool ? poolSparrow() : w.ships.playerBlueprint, extra), 0, 300000, 0, 0);
    return { ...w, e, ship: w.ships.get(e)! };
  };

  it('with no Capacitor bank touching it, comes back whole after 240 ticks', () => {
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

  // (A bank paying for it is the pool core's: on the ports core the Flash Screen draws nothing yet, a known gap the owner
  // deferred with the ports switch (with Tow, Strafer and Gyro), so these run on the pool-era starter)
  it.todo('on the ports core: a store touching it pays to bring it back at once (deferred: Flash draws nothing on ports)');

  it('with a Capacitor bank touching it that can pay 4 E a point, comes back at once and the bank pays', () => {
    const { ships, e, ship } = spawn([{ fn: 'shield_flash_screen', x: -2, y: 0 }, { fn: 'power_capacitor', x: -2, y: -1 }], true);
    expect(ships.chargeOf(e).b[0] ?? 100).toBe(100);
    ships.hurt(e, ship, 0, 36);
    expect(ship.shield).toBe(36);
    // (36 points at 4 E is 144 of the Capacitor's 160)
    expect(ships.chargeOf(e).b[0]).toBeCloseTo(10, 1);
  });

  it('with a bank touching it that is too empty to pay, waits like the rest', () => {
    const { server, ships, e, ship } = spawn([{ fn: 'shield_flash_screen', x: -2, y: 0 }, { fn: 'power_capacitor', x: -2, y: -1 }], true);
    const c = ships.chargeOf(e);
    ships.setCharge(e, { ...c, b: [50] });
    ships.hurt(e, ship, 0, 36);
    expect(ship.shield).toBe(0);
    expect(ships.chargeOf(e).b[0]).toBe(50);
    for (let i = 0; i < FLASH_RESTORE_TICKS + 2; i++) server.step();
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
