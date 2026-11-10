/**
 * The numbers the HUD reads off your ship (ShipReadouts): the status record and ring records are reused between
 * calls, and the ring's groups come off the predicted gun state.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { createShipState, type Blueprint, type PlacedPart, type Rot, type ShipState } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { ShipReadouts, type ReadoutsHost } from './ShipReadouts';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
const { catalog, tuning } = bridge;
const p = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const design: Blueprint = {
  name: 'test', catalogVersion: 1,
  parts: [
    p(0, 'rect2', 'core', 0, 0),
    p(1, 'block2', 'cannon_bastion', 2, 0, { facing: 'N' }),
    p(2, 'sq', 'power_cell_reactor', -1, 1),
    p(3, 'sq', 'engine_ion_drive', 0, 2, { facing: 'S' }),
    p(4, 'sq', 'engine_ion_drive', 1, 2, { facing: 'S' }),
  ],
};

function rig() {
  const ship = createShipState(catalog, tuning, 1, design, 0) as ShipState;
  const host = {
    state: { playerId: 1, charge: ship.charge, serverTick: 10, entities: new Map() },
    store: { get: (id: number) => (id === 1 ? ship : undefined) },
    catalog, tuning,
    pilot: { profile: {}, cargo: [] },
    features: { statusLines: () => [] },
    jump: {},
    thrustCommand: () => ({ dir: [0, 0], turn: 0, boost: false }),
    helm: () => false,
    localJump: () => ({ phase: 'ready' }),
    jumpReach: () => 0,
  } as unknown as ReadoutsHost;
  return { ship, r: new ShipReadouts(host) };
}

describe('the status record and ring records are reused between calls', () => {
  it('statusInput hands back the very same record, and ringGroups the same group records', () => {
    const { r } = rig();
    const a = r.statusInput(), b = r.statusInput();
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    const g1 = r.ringGroups(), g2 = r.ringGroups();
    expect(g1.length).toBeGreaterThan(0);
    expect(g2).toBe(g1);
    expect(g2[0]).toBe(g1[0]);
  });
});

describe('ring groups come off the predicted gun state', () => {
  it('a round spent on the ship\'s own (predicted) gun state shows in the next call', () => {
    const { r, ship } = rig();
    const g = r.ringGroups()[0];
    expect(g.model).toBe('clip');
    const full = g.rounds;
    expect(full).toBeGreaterThan(1);
    ship.rounds[g.parts[0]] = full - 1;
    expect(r.ringGroups()[0].rounds).toBe(full - 1);
  });
});
