/**
 * Flak burst ship search (flakBurst.shipAtPoint): it only reads the drawn world, and finds a ship only by a standing part.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { createShipState, EntityType } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { ShipStore } from '../ShipStore';
import { shipAtPoint } from './flakBurst';
import type { GameState } from '../../state/GameState';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));

describe('nothing here changes a hit or a blast: the search only reads the drawn world', () => {
  it('finds the ship at its centre, none far off, and leaves ships and poses as they were', () => {
    const store = new ShipStore(bridge.catalog, bridge.tuning);
    const ship = createShipState(bridge.catalog, bridge.tuning, 20, bridge.library.get('hauler')!, 0);
    store.bodies.set(20, ship);
    const e = { id: 20, type: EntityType.ShipBody, renderX: 1000, renderY: 0, renderAngle: 0.4 };
    const state = { entities: new Map([[20, e]]) } as unknown as GameState;
    const before = JSON.stringify([ship.hp, ship.derived.alive, ship.aim, e]);
    // (the ship's centre of mass: its own cell grid origin is somewhere on a part)
    const hits = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => shipAtPoint(store, state, 1000, 0, 400, 1000 + Math.cos(k) * 20, Math.sin(k) * 20));
    expect(hits).toContain(20);
    expect(shipAtPoint(store, state, 1000, 0, 400, 9000, 9000)).toBe(-1);
    expect(JSON.stringify([ship.hp, ship.derived.alive, ship.aim, e])).toBe(before);
  });
});
