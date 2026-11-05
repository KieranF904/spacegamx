import { describe, expect, it, vi } from 'vitest';

// (No canvas here: the particle textures are stand-ins)
vi.mock('../fxTextures', () => ({ disc: () => 'disc', rock: (i: number) => `rock:${Math.abs(i) % 4}` }));

import { MiningStrikeFx, strikeRolls, POD_NEAR, POD_WITHIN, type StrikeEmitter } from './MiningStrikeFx';

function rig() {
  const sparks: { x: number; y: number; vx: number; vy: number; color: number; tex?: unknown }[] = [];
  const flashes: { color: number; radius: number }[] = [];
  let t = 10;
  const emit: StrikeEmitter = {
    spark: (x, y, vx, vy, _life, _r, color, o) => { sparks.push({ x, y, vx, vy, color, tex: o?.tex }); },
    flash: (_x, _y, radius, color) => { flashes.push({ color, radius }); },
  };
  const fx = new MiningStrikeFx(emit, () => t);
  return { fx, sparks, flashes, at: (s: number) => { t = s; } };
}

describe('a mining strike (every hit that rolls for ore)', () => {
  it('throws rock grit and dust back out of the face, in the rock\'s colours, not a white shell spark', () => {
    const { fx, sparks, flashes } = rig();
    fx.strike(100, 0, 1, 0, 'ice');
    expect(sparks.filter((s) => String(s.tex).startsWith('rock')).length).toBeGreaterThanOrEqual(5);
    expect(sparks.some((s) => s.tex === 'disc')).toBe(true);
    // Out of the face (+x here), never back into the rock
    for (const s of sparks) expect(s.vx).toBeGreaterThan(-0.5 * Math.hypot(s.vx, s.vy));
    expect(flashes.every((f) => f.color !== 0xffffff)).toBe(true);
  });

  it('a chunk appearing near a strike just made gets the richer puff; far off, or later, it does not', () => {
    const { fx, sparks, at } = rig();
    fx.strike(0, 0, 1, 0, 'stone');
    const n = sparks.length;
    expect(fx.pod(POD_NEAR * 2, 0)).toBe(false);
    expect(sparks.length).toBe(n);
    expect(fx.pod(40, 10)).toBe(true);
    expect(sparks.length).toBeGreaterThan(n);
    at(10 + POD_WITHIN + 0.1);
    expect(fx.pod(40, 10)).toBe(false);
  });

  it('plays for hits that mine: guns on soft rock only, a mining charge on rock it can crack, never the EMP', () => {
    expect(strikeRolls('fixed', 1)).toBe(true);
    expect(strikeRolls('autocannon', 2)).toBe(false);
    expect(strikeRolls('lance', 3)).toBe(false);
    expect(strikeRolls('charge', 3)).toBe(true);
    expect(strikeRolls('emp', 1)).toBe(false);
    // (an unknown kind mines as the server's does: as a fixed gun)
    expect(strikeRolls(undefined, 1)).toBe(true);
  });
});
