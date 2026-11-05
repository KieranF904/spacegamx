import { describe, expect, it } from 'vitest';
import type { LodestoneData } from '@space-game/common';
import { STILLSTONE_MAP, buildStillstoneMap, stillstoneKind } from './stillstoneMap';
import systems from '../../../data/systems.json';

const stones = (systems as unknown as { systems: { lodestones?: LodestoneData[] }[] }).systems.flatMap((s) => s.lodestones ?? []);
const N = STILLSTONE_MAP;
const px = (a: Uint8Array, x: number, y: number, c: number) => a[(y * N + x) * 4 + c];

describe('stillstone surface maps', () => {
  it('come out as crowns, rosettes and a few nested, from the id alone', () => {
    const kinds = stones.map((s) => stillstoneKind(s));
    expect(kinds).toContain('crown');
    expect(kinds).toContain('rosette');
    expect(stones.map((s) => stillstoneKind(s))).toEqual(kinds);
  });

  it('cover the stone and nothing past its edge', () => {
    const { map } = buildStillstoneMap({ ...stones[0], state: 'active' });
    expect(px(map, N / 2, N / 2, 3)).toBe(255);
    for (const [x, y] of [[0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1]]) expect(px(map, x, y, 3)).toBe(0);
    // relief: neither flat nor edge-on, on the whole
    let nz = 0, n = 0;
    for (let j = 0; j < N; j += 4) for (let i = 0; i < N; i += 4) if (px(map, i, j, 3) > 200) { nz += Math.abs(px(map, i, j, 0) - 128); n++; }
    expect(nz / n).toBeGreaterThan(5);
    expect(nz / n).toBeLessThan(90);
  });

  it('light the grooves of a live stone, never a dead one', () => {
    const sum = (a: Uint8Array) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += a[i]; return s; };
    const live = buildStillstoneMap({ ...stones[0], state: 'active' }), dead = buildStillstoneMap({ ...stones[0], state: 'dead' });
    expect(sum(live.glow)).toBeGreaterThan(1000);
    expect(sum(dead.glow)).toBe(0);
  });
});
