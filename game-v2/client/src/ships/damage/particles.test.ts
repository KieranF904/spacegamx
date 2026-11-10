/**
 * The damage particle field (damage/particles.ts): the live list is capped by setQuality and the lower tiers drop a
 * share of the small particles; a chunk's hot edge is stroked once and parked for the next chunk when it cools.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'pixi.js';
import { DamageParticles } from './particles';

vi.mock('../../rendering/fxTextures', () => {
  const t = () => ({});
  return { DOT_SIZE: 1, glowBall: t, puff: t, streak: t, streakScale: () => ({ x: 1, y: 1 }) };
});
vi.mock('../../rendering/particlePool', async () => {
  const { Container: C } = await import('pixi.js');
  return { ParticlePool: class { container = new C(); begin() {} end() {} take() {} ring() {} } };
});

afterEach(() => vi.restoreAllMocks());

describe('the live list is capped by setQuality and the lower tiers drop a share of the small particles', () => {
  it('no more than the cap are kept, whatever is pushed', () => {
    const p = new DamageParticles(new Container());
    p.setQuality(1, 5);
    for (let i = 0; i < 20; i++) p.ring(0, 0, 0, 0, 1, 2, 10, 0xffffff, 1);
    expect(p.ps.length).toBe(5);
  });
  it('a keep share below 1 drops sparks, smoke and dust by that share, never rings or chunks, and never a flak fragment', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const p = new DamageParticles(new Container());
    p.setQuality(0.25, 1000);
    for (let i = 0; i < 10; i++) { p.spark(0, 0, 0, 0, 10, 1); p.dustPuff(0, 0, 0, 0, 5, 10, 1, 1); }
    expect(p.ps.length).toBe(0);
    p.setQuality(0.75, 1000);
    for (let i = 0; i < 10; i++) p.spark(0, 0, 0, 0, 10, 1);
    expect(p.ps.length).toBe(10);
    p.setQuality(0, 1000);
    const before = p.ps.length;
    p.ring(0, 0, 0, 0, 1, 2, 10, 1, 1);
    p.chunks(0, 0, 0, 0, 3, 1, 4);
    p.fragment(0, 0, 1, 0, 10, 2, 1);
    expect(p.ps.length).toBe(before + 1 + 3 + 1);
  });
});

describe('a chunk\'s hot edge is stroked once and parked for the next chunk when it cools', () => {
  it('the same edge is kept while the chunk glows, and handed to the next chunk after it cools', () => {
    const layer = new Container();
    const p = new DamageParticles(layer);
    p.chunks(0, 0, 0, 0, 1, 0, 6);
    const first = p.ps[0];
    first.max = 100;
    p.draw(1);
    const edge = first.hot;
    expect(edge).toBeDefined();
    p.draw(1);
    expect(first.hot).toBe(edge); // still the one edge, not stroked afresh each frame
    first.life = 50; // cooled (past 0.35 of its life)
    p.draw(1);
    expect(first.hot).toBeUndefined();
    p.chunks(0, 0, 0, 0, 1, 0, 6);
    const next = p.ps[p.ps.length - 1];
    next.max = 100;
    p.draw(1);
    expect(next.hot).toBe(edge); // the parked edge, reused
  });
});
