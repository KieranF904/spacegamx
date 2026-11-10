/**
 * Look-only gimbals (TurretVisuals): point defence turns to its last intercept and rests after 900 ms, and your own
 * ship with prediction on is skipped (its guns are stepped on the tick layer).
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { createShipState, EntityType, type ShipState } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { TurretVisuals, type TurretVisualsHost } from './TurretVisuals';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
const { catalog, tuning } = bridge;

function setup(design: string, id: number, prediction: boolean) {
  const ship = createShipState(catalog, tuning, id, bridge.library.get(design)!, 0) as ShipState;
  const state = {
    playerId: 1, predictionEnabled: prediction,
    entities: new Map([[id, { type: EntityType.ShipBody, renderX: 0, renderY: 0, renderAngle: 0 }]]),
  };
  const host = { store: { bodies: new Map([[id, ship]]) }, state, tuning, localAim: () => ({ angle: 2.5, dist: 600 }) } as unknown as TurretVisualsHost;
  return { ship, tv: new TurretVisuals(host) };
}
const moved = (ship: ShipState, parts: number[]) => parts.some((q) => Math.abs(ship.aim[q] ?? 0) > 1e-6);

describe('your own ship with prediction on is skipped', () => {
  it('its gimbals do not step from the cursor, but do with prediction off', () => {
    const on = setup('drum', 1, true);
    for (let i = 0; i < 60; i++) on.tv.stepTurrets();
    expect(moved(on.ship, [3, 4])).toBe(false);
    const off = setup('drum', 1, false);
    for (let i = 0; i < 60; i++) off.tv.stepTurrets();
    expect(moved(off.ship, [3, 4])).toBe(true);
  });
});

describe('point defence turns to its last intercept and rests after 900 ms', () => {
  it('turns while the intercept is fresh, and is back at rest once 900 ms have passed', () => {
    const { ship, tv } = setup('sunspear', 5, false);
    const pd = [30, 31, 34, 35];
    expect(moved(ship, pd)).toBe(false);
    const t0 = performance.now();
    for (const q of pd) tv.noteIntercept(5, q, 300, -400);
    for (let i = 0; i < 120; i++) tv.stepPointDefence(t0 + 100);
    expect(moved(ship, pd)).toBe(true);
    for (let i = 0; i < 600; i++) tv.stepPointDefence(t0 + 1000);
    expect(moved(ship, pd)).toBe(false);
  });
});
