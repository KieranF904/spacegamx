/**
 * Where replicated ships are drawn (ReplicaPlacement.placeReplica): a ship docked to yours is placed at your draw tick,
 * on your ship as drawn, not at the render tick behind it.
 */
import { describe, expect, it } from 'vitest';
import { EntityType } from '@space-game/common';
import { ReplicaPlacement, type PlacementHost } from './ReplicaPlacement';

const ME = 1, PARTNER = 2;

describe('a ship docked to yours is placed at your draw tick', () => {
  it('its place follows your ship at the own draw tick (rotated offset), while the render tick would put it elsewhere', () => {
    const poseAt = (id: number, t: number) => (id === ME
      ? { x: 1000 + t * 10, y: 0, angle: 0, vx: 0, vy: 0, jump: 0, jumpScale: 0, aim: 0 }
      : { x: -5, y: -5, angle: 0, vx: 0, vy: 0, jump: 0, jumpScale: 0, aim: 0 });
    const lookups: number[] = [];
    const host = {
      state: { playerId: ME, ownDrawTick: () => 20.5 },
      replicas: {
        pose: poseAt,
        clamps: {
          size: 1,
          recAt: (self: number, t: number) => { lookups.push(t); return { leader: self, follower: PARTNER, lc: 0, fc: 0, offset: { ox: 30, oy: 0, oa: 0.5 } }; },
        },
        isDocked: () => true,
      },
      own: { on: true },
      otherGuns: { distAt: () => undefined },
    } as unknown as PlacementHost;
    const e = { id: PARTNER, type: EntityType.ShipBody, x: 0, y: 0, angle: 0, vx: 0, vy: 0, renderX: 0, renderY: 0, renderAngle: 0 };
    expect(new ReplicaPlacement(host).placeReplica(e as never, 5)).toBe(true);
    expect(lookups).toEqual([20]); // your link at your draw tick (floored), not the render tick 5
    // your ship at tick 20.5 is at x 1205 (the render tick's pose would be x 1050); the clamp's x offset runs along the hull's grid (+y at angle 0)
    expect(e.x).toBeCloseTo(1205, 1);
    expect(e.y).toBeCloseTo(30, 1);
    expect(e.angle).toBeCloseTo(0.5, 4);
    expect(e.renderX).toBe(e.x);
  });
});
