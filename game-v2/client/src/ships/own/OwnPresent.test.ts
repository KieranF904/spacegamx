/**
 * Drawing what your own ship's tick layer fired (OwnPresent.ownStepTo): each event OwnTick hands out is drawn once
 * (OwnTick.takeEvents hands each tick out once), and no volley is drawn while berthed.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { createShipState, GUN_ARRAYS, type Blueprint, type PlacedPart, type Rot, type ShipState } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { OwnPresent, type OwnPresentHost } from './OwnPresent';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
const { catalog, tuning } = bridge;
const p = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const design: Blueprint = {
  name: 'test', catalogVersion: 1,
  parts: [
    p(0, 'rect2', 'core', 0, 0),
    p(1, 'sq', 'autocannon', 2, 0, { facing: 'N' }),
    p(2, 'sq', 'power_cell_reactor', -1, 1),
    p(3, 'sq', 'engine_ion_drive', 0, 2, { facing: 'S' }),
    p(4, 'sq', 'engine_ion_drive', 1, 2, { facing: 'S' }),
  ],
};
const ME = 1;

function rig(docked: boolean) {
  const ship = createShipState(catalog, tuning, ME, design, 0) as ShipState;
  const shots: unknown[] = [];
  const guns: Record<string, number[]> = {};
  for (const k of GUN_ARRAYS) guns[k] = [];
  const simState = { body: { x: 0, y: 0, angle: 0, vx: 0, vy: 0, jump: 0 }, hazard: { empUntil: 0 }, guns };
  // two ticks, each with one volley (its first barrel's fire event)
  const handed = [10, 11].map((tick) => ({ tick, events: [{ k: 'fire', barrel: 0, slot: 1, aimQ: 0 }], state: simState }));
  const host = {
    store: { get: (id: number) => (id === ME ? ship : undefined) },
    state: { playerId: ME },
    tuning,
    own: { on: true, takeEvents: (_t: number, out: unknown[]) => { out.push(...handed); return out; }, inputAt: () => ({ fire: 0, fireAlt: 0, sel: 0 }), extrasAt: () => null },
    replicas: { at: () => ({ body: simState.body }) },
    ownShells: {},
    gunFeel: { own: () => {} },
    jump: {},
    scene: () => ({ predictShot: (s: unknown) => shots.push(s) }),
    beamFx: () => null,
    docked: () => docked,
    ownAmmo: () => undefined,
  } as unknown as OwnPresentHost;
  return { present: new OwnPresent(host), shots };
}

describe('each tick\'s events are drawn once', () => {
  it('every event handed out makes exactly one drawn volley (the cannon\'s single shell)', () => {
    const { present, shots } = rig(false);
    expect(present.ownStepTo(11)).not.toBeNull();
    expect(shots.length).toBe(2);
  });
});

describe('no volley is drawn while berthed', () => {
  it('the same events draw nothing when docked', () => {
    const { present, shots } = rig(true);
    expect(present.ownStepTo(11)).not.toBeNull();
    expect(shots.length).toBe(0);
  });
});
