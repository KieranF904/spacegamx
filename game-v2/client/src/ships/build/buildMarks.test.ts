/**
 * Build marks (buildMarks.ts): a directional part's arrow points out of its facing edge for every side, and a shaped
 * shield's cover is exactly the one the game derives (shaped.ts), wall ends and arc ends alike.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createShipState, parseBlueprint, placeGeometry, shapedOf, SIDE_NORMAL, type PlacedPart, type Side, type ShipTuning } from '@space-game/common';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../../../common/src/ships/testData';
import { facingMark, shieldCover, coverPolyline, hasDirection } from './buildMarks';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrow = readFileSync(join(SHIP_DATA_DIR, 'blueprints/fixtures/sparrow-t.json'), 'utf-8');

const part = (fn: string, x: number, y: number, facing: Side): PlacedPart =>
  ({ uid: 60, piece: 'sq', fn, material: 'alloy', x, y, rot: 0, flip: false, facing }) as PlacedPart;

describe('facing marks', () => {
  it.each(['N', 'E', 'S', 'W'] as Side[])('a clamp facing %s has its arrow pointing out of that edge', (side) => {
    const p = part('docking_clamp', 0, 0, side);
    const mk = facingMark(p, placeGeometry(catalog, p))!;
    expect(mk).not.toBeNull();
    expect(mk.dir).toEqual(SIDE_NORMAL[side]);
    // (the tip is past the edge, the two base points are level with each other across the way out)
    const [l, tip, r] = mk.tri;
    expect((tip[0] - mk.at[0]) * mk.dir[0] + (tip[1] - mk.at[1]) * mk.dir[1]).toBeGreaterThan(0.3);
    expect((l[0] - r[0]) * mk.dir[0] + (l[1] - r[1]) * mk.dir[1]).toBeCloseTo(0, 9);
  });

  it('a part with no direction has no mark', () => {
    const p = { ...part('hull', 0, 0, 'N'), facing: undefined } as PlacedPart;
    expect(hasDirection(p)).toBe(false);
    expect(facingMark(p, placeGeometry(catalog, p))).toBeNull();
  });
});

describe('shield cover', () => {
  const ship = (fn: string, side: Side) => {
    const bp = parseBlueprint(sparrow);
    const p = part(fn, side === 'W' ? -2 : 3, 0, side);
    bp.parts.push(p);
    return { state: createShipState(catalog, tuning, 1, bp, 0), p };
  };

  it('a wall shield covers the ends the game derives', () => {
    const { state, p } = ship('shield_spark_wall', 'W');
    const real = shapedOf(state)[0];
    const s = shieldCover(p, placeGeometry(catalog, p))!;
    expect([s.ax, s.ay, s.bx, s.by]).toEqual([real.ax, real.ay, real.bx, real.by]);
    expect(coverPolyline(s)).toEqual([[real.ax, real.ay], [real.bx, real.by]]);
  });

  it('an arc shield starts and ends on its radius, at its half span either side of the way out', () => {
    const { state, p } = ship('shield_visor', 'W');
    const real = shapedOf(state)[0];
    const pts = coverPolyline(shieldCover(p, placeGeometry(catalog, p))!);
    const first = pts[0], last = pts[pts.length - 1];
    for (const [x, y] of pts) expect(Math.hypot(x - real.cx, y - real.cy)).toBeCloseTo(real.r, 9);
    expect(first[0]).toBeCloseTo(real.cx + Math.cos(real.mid - real.half) * real.r, 9);
    expect(last[1]).toBeCloseTo(real.cy + Math.sin(real.mid + real.half) * real.r, 9);
  });

  it('other parts have no cover', () => {
    const p = part('docking_clamp', 0, 0, 'N');
    expect(shieldCover(p, placeGeometry(catalog, p))).toBeNull();
  });
});
