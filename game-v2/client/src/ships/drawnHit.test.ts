/**
 * Where a shell's drawn line first meets a drawn ship (DrawnWorld, WeaponFx.castHit): its real hull outline at the
 * pose it's drawn at, its shield bubble while the shield is up, never its shooter, nor a ship its shells pass through.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { createShipState, EntityType, SIDE } from '@space-game/common';
import { loadShipConfigFromDisk } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/proto/createProtoServer';
import { ShipStore } from './ShipStore';
import { DrawnWorld, bubbleRadius } from './drawnHit';
import type { GameState } from '../state/GameState';
import type { DrawnHit } from '../rendering/weapons/WeaponFx';

const bridge = createShipBridge(loadShipConfigFromDisk(join(__dirname, '../../../data')));

function world(shield = 0, sides: Record<number, number> = {}) {
  const store = new ShipStore(bridge.catalog, bridge.tuning);
  const ship = createShipState(bridge.catalog, bridge.tuning, 20, bridge.library.get('hauler')!, 0);
  store.bodies.set(20, ship);
  const entities = new Map<number, object>([[20, { id: 20, type: EntityType.ShipBody, renderX: 1000, renderY: 0, renderAngle: 0.4, data: [0, shield] }]]);
  const state = { entities: Object.assign(entities, { ofType: () => [] }) } as unknown as GameState;
  return { ship, w: new DrawnWorld(store, state, (id) => sides[id] ?? 0) };
}

const out: DrawnHit = { t: 0, x: 0, y: 0, target: -1 };

describe('a shell meets what is drawn', () => {
  it("a ship's hull: the outline, at the pose it's drawn at", () => {
    const { ship, w } = world();
    expect(w.cast(0, 0, 2000, 0, 7, null, out)).toBe(true);
    expect(out.target).toBe(20);
    // (on the hull, inside its bounding circle, short of its middle)
    expect(out.x).toBeGreaterThan(1000 - ship.derived.radius - 1e-6);
    expect(out.x).toBeLessThan(1000);
    expect(out.y).toBe(0);
    // A line that stops short, or passes wide, meets nothing
    expect(w.cast(0, 0, 1000 - ship.derived.radius - 5, 0, 7, null, out)).toBe(false);
    expect(w.cast(0, ship.derived.radius + 20, 2000, ship.derived.radius + 20, 7, null, out)).toBe(false);
  });

  it('a raised shield: its bubble, before the hull', () => {
    const { ship, w } = world(60);
    expect(w.cast(0, 0, 2000, 0, 7, null, out)).toBe(true);
    expect(out.x).toBeCloseTo(1000 - bubbleRadius(ship), 6);
  });

  it('never its shooter, nor what it has passed, nor a ship its shells pass through', () => {
    expect(world().w.cast(0, 0, 2000, 0, 20, null, out)).toBe(false);
    expect(world().w.cast(0, 0, 2000, 0, 7, [20], out)).toBe(false);
    // (a pilot's shell and a ward ship: on one side)
    expect(world(0, { 7: SIDE.PILOT, 20: SIDE.WARD }).w.cast(0, 0, 2000, 0, 7, null, out)).toBe(false);
  });
});
