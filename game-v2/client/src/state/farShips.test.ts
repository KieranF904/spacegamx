import { describe, it, expect } from 'vitest';
import { packMapLeg, packMapInfo, unpackMapLegs, legAt, legTo, type Leg, type MapDot } from '@space-game/common';
import { FarShips } from './FarShips';

type Row = { id: number; leg: Leg };
const msg = (tick: number, rows: Row[], extra: { info?: MapDot[]; gone?: number[]; names?: (number | string)[]; full?: 1 } = {}) => {
  const dots: number[] = [], info: number[] = [];
  for (const r of rows) packMapLeg(dots, r.id, r.leg);
  for (const d of extra.info ?? []) packMapInfo(info, d);
  return { type: 'mapDots' as const, tick, dots, info, gone: extra.gone, names: extra.names, full: extra.full };
};
/** Holding its velocity (a live ship) */
const steady = (id: number, x: number, y: number, vx: number, vy: number): Row => ({ id, leg: { x, y, vx, vy, wx: vx, wy: vy, thrust: -1 } });
const look = (id: number, kind = 3): MapDot => ({ id, kind, rank: 0, calm: false, faction: 1, rating: 12 });

describe('far ships on the map', () => {
  it('carry on along their legs between updates, and ease a correction out instead of jumping', () => {
    const f = new FarShips();
    f.apply(msg(1000, [steady(7, 50000, 0, 4, 0)], { info: [look(7)], names: [7, 'Raider'], full: 1 }), 'sol', 1000);
    const at = (t: number) => f.list('sol', t)[0];
    expect(at(1000).name).toBe('Raider');
    expect(at(1000).kind).toBe(3);
    expect(at(1030).renderX).toBeCloseTo(50120, 0);
    // Its next leg has it a little further on than carried (it sped up): drawn where it was, then eased over
    const before = at(1060).renderX;
    f.apply(msg(1060, [steady(7, 50400, 0, 6, 0)]), 'sol', 1060);
    expect(Math.abs(at(1060).renderX - before)).toBeLessThan(1);
    let last = at(1060).renderX;
    for (let t = 1061; t < 1120; t++) {
      const x = at(t).renderX;
      expect(x - last).toBeGreaterThan(0);
      expect(x - last).toBeLessThan(15);
      last = x;
    }
    expect(at(1120).renderX).toBeCloseTo(50400 + 6 * 60, 0);
    // Nothing sent about it for a while: it's still there, carried on (and still what it was)
    expect(at(1600).renderX).toBeCloseTo(50400 + 6 * 540, 0);
    expect(at(1600).kind).toBe(3);
    // Gone: gone from the map; another system's list: nothing here
    f.apply(msg(1620, [], { gone: [7] }), 'sol', 1620);
    expect(f.list('sol', 1620).length).toBe(0);
    f.apply(msg(1680, [steady(9, 0, 0, 0, 0)], { full: 1 }), 'ashfall', 1680);
    expect(f.list('sol', 1680).length).toBe(0);
    expect(f.list('ashfall', 1680).length).toBe(1);
    // Ones the client has as real ships are left to them
    expect(f.list('ashfall', 1680, (id) => id === 9).length).toBe(0);
    // A fresh list drops what isn't in it
    f.apply(msg(1700, [steady(11, 10, 10, 0, 0)], { full: 1 }), 'ashfall', 1700);
    expect(f.list('ashfall', 1700).map((s) => s.id)).toEqual([11]);
  });

  it("a distant ship's leg is followed exactly: thrusting round onto its new way, then coasting to a stop where it was going", () => {
    const f = new FarShips();
    // Moving off to the side, then turning for a point 20 000 away at 3 a tick (a rounded turn)
    const leg = legTo({ x: 0, y: 0, vx: 0, vy: 4 }, 20000, 0, 3);
    f.apply(msg(0, [{ id: 3, leg }], { full: 1 }), 'sol', 0);
    // (Exactly the leg as sent: what the server reckons the map has, rounded as it went)
    const sent: number[] = [];
    packMapLeg(sent, 3, leg);
    const [{ leg: as }] = unpackMapLegs(sent);
    for (const t of [0, 100, 1000, 5000, 9000, 20000]) {
      const p = legAt(as, t), s = f.list('sol', t)[0];
      expect(Math.hypot(s.renderX - p.x, s.renderY - p.y)).toBeLessThan(1e-6);
      // ...which is within a few tens of units of the leg itself, all the way
      const q = legAt(leg, t);
      expect(Math.hypot(s.renderX - q.x, s.renderY - q.y)).toBeLessThan(40);
    }
    const end = f.list('sol', 30000)[0];
    expect(Math.hypot(end.renderX - 20000, end.renderY)).toBeLessThan(60);
    expect(Math.hypot(end.vx, end.vy)).toBeLessThan(0.01);
  });
});
