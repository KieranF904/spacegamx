import { describe, it, expect } from 'vitest';
import { followerPose, type ClampLinkRec } from '@space-game/common';
import { dockedPlace, type Place } from './dockedDraw';

const link = { leader: 1, follower: 2, lc: 0, fc: 0, offset: { ox: 30, oy: -12, oa: 1.2 }, tick: 0, until: Infinity } as unknown as ClampLinkRec;

describe('a docked partner drawn on your ship', () => {
  it('you lead: your follower sits at its offset from you', () => {
    const own: Place = { x: 100, y: 50, angle: 0.7 }, out: Place = { x: 0, y: 0, angle: 0 };
    expect(dockedPlace(link, 1, 2, own, out)).toBe(true);
    const f = followerPose({ ...own, vx: 0, vy: 0, angVel: 0 }, link.offset);
    expect(out.x).toBeCloseTo(f.x, 6); expect(out.y).toBeCloseTo(f.y, 6); expect(out.angle).toBeCloseTo(f.angle, 6);
  });

  it('you follow: your leader is placed so that you sit at its offset', () => {
    const own: Place = { x: -40, y: 220, angle: -2.5 }, out: Place = { x: 0, y: 0, angle: 0 };
    expect(dockedPlace(link, 2, 1, own, out)).toBe(true);
    const f = followerPose({ ...out, vx: 0, vy: 0, angVel: 0 }, link.offset);
    expect(f.x).toBeCloseTo(own.x, 1); expect(f.y).toBeCloseTo(own.y, 1); expect(f.angle).toBeCloseTo(own.angle, 4);
  });

  it('anyone else is left where the replica put it', () => {
    const out: Place = { x: 9, y: 9, angle: 9 };
    expect(dockedPlace(link, 1, 3, { x: 0, y: 0, angle: 0 }, out)).toBe(false);
    expect(dockedPlace(null, 1, 2, { x: 0, y: 0, angle: 0 }, out)).toBe(false);
    expect(out).toEqual({ x: 9, y: 9, angle: 9 });
  });
});
