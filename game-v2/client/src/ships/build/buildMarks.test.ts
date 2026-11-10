/**
 * Build marks (buildMarks.ts): a directional part's arrow points out of its facing edge for every side, and a shaped
 * shield's cover is exactly the one the game derives (shaped.ts), wall ends and arc ends alike.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint, placeGeometry, shapedAt, SIDE_NORMAL, type PlacedPart, type Side } from '@space-game/common';
import { testCatalog, SHIP_DATA_DIR } from '../../../../common/src/ships/testData';
import { designOf } from '../../../../common/src/ships/design';
import { facingMark, shieldCover, coverPolyline, hasDirection } from './buildMarks';

const catalog = testCatalog();
const sparrow = readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8');

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
  // (The shield as the game's derive works it out, shapedAt: on the ports core one power can't reach isn't up, so the
  // rebuild's own list would drop this unfed one)
  const ship = (fn: string, side: Side) => {
    const bp = parseBlueprint(sparrow);
    const p = part(fn, side === 'W' ? -2 : 3, 0, side);
    bp.parts.push(p);
    const D = designOf(catalog, bp), i = bp.parts.length - 1;
    return { real: shapedAt(D.fns[i], D.mats[i], i, D.mounts[i])!, p };
  };

  it('a wall shield covers the ends the game derives', () => {
    const { real, p } = ship('shield_spark_wall', 'W');
    const s = shieldCover(p, placeGeometry(catalog, p))!;
    expect([s.ax, s.ay, s.bx, s.by]).toEqual([real.ax, real.ay, real.bx, real.by]);
    expect(coverPolyline(s)).toEqual([[real.ax, real.ay], [real.bx, real.by]]);
  });

  it('an arc shield starts and ends on its radius, at its half span either side of the way out', () => {
    const { real, p } = ship('shield_visor', 'W');
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
