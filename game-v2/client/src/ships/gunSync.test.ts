import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createShipState, parseBlueprint, packGunState, gunStateAt, CHARGE_GROUPS_AT, PILOT_ROW, GUN_STATE_PATIENCE, type ShipState } from '@space-game/common';
import { PILOT_EXTRAS } from '../../../common/src/ships/features/plan';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../../common/src/ships/testData';
import { GunSync } from './gunSync';

const catalog = testCatalog();
const tuning = readShipJson('tuning.json');

function railDriver(): ShipState {
  const b = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  for (const q of b.parts) if (q.fn === 'cannon_pip') q.fn = 'railgun_rail_driver';
  return createShipState(catalog, tuning, 1, b, 0);
}

/** A pilot row carrying `server`'s gun state */
function row(server: ShipState): number[] {
  const d = new Array(CHARGE_GROUPS_AT).fill(0);
  d[PILOT_ROW.groups] = 1;
  d.push(100);
  for (let i = 0; i < PILOT_EXTRAS; i++) d.push(0);
  packGunState(server, d);
  expect(d[gunStateAt(d)]).toBe(2);
  return d;
}

describe('gun-state correction (client)', () => {
  it('takes the server\'s clip only once it has disagreed for 30 ticks running; agreeing again resets the count', () => {
    const mine = railDriver(), server = railDriver();
    const sync = new GunSync();
    const p = mine.derived.weapons[0].part;
    // The server fired a shot the client missed: one round fewer there
    server.rounds[p] = 5;
    for (let t = 100; t <= 200; t++) sync.record(mine, t);
    expect(sync.onRow(mine, row(server), 120)).toBe(0);
    expect(sync.onRow(mine, row(server), 120 + GUN_STATE_PATIENCE - 1)).toBe(0);
    expect(mine.rounds[p]).toBe(6);
    // (Agreeing in between starts the count again)
    server.rounds[p] = 6;
    expect(sync.onRow(mine, row(server), 125)).toBe(0);
    server.rounds[p] = 5;
    expect(sync.onRow(mine, row(server), 130)).toBe(0);
    expect(sync.onRow(mine, row(server), 130 + GUN_STATE_PATIENCE)).toBe(1);
    expect(mine.rounds[p]).toBe(5);
    // A tick it never predicted (too old, or not yet): nothing to compare
    expect(sync.onRow(mine, row(server), 5000)).toBe(0);
  });

  it('adopts a reload mid-way at the server progress, not from the start', () => {
    const mine = railDriver(), server = railDriver();
    const sync = new GunSync();
    const w = mine.derived.weapons[0], p = w.part, len = w.fire.reload ?? 60;
    server.rounds[p] = 0;
    server.reload[p] = len * 0.3; // 70% done on the server; the client never saw the reload start
    for (let t = 100; t <= 200; t++) sync.record(mine, t);
    expect(sync.onRow(mine, row(server), 120)).toBe(0);
    expect(sync.onRow(mine, row(server), 120 + GUN_STATE_PATIENCE)).toBe(1);
    expect(mine.reload[p]).toBeGreaterThan(0);
    expect(Math.abs(mine.reload[p] - len * 0.3)).toBeLessThanOrEqual(len / 8);
  });
});
