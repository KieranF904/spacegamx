/**
 * The damage effects' frame (DamageFx.update): delayed actions, ambient effects, anchors, then it draws particles,
 * shields, ripples and charges, between opening and closing the particle pools.
 */
import { describe, expect, it, vi } from 'vitest';
import { Container } from 'pixi.js';
import { DamageFx } from './DamageFx';

vi.mock('../rendering/particlePool', async () => {
  const { Container: C } = await import('pixi.js');
  return { ParticlePool: class { container = new C(); begin() {} end() {} take() {} ring() {} } };
});
vi.mock('../rendering/fxTextures', () => ({ DOT_SIZE: 1, BUBBLE_RIM: 1, glowBall: () => ({}), puff: () => ({}), streak: () => ({}), streakScale: () => ({ x: 1, y: 1 }), bubble: () => ({}), bubbleRim: () => ({}), hexShield: () => ({}) }));

describe('a frame runs delayed actions, ambient effects, anchors, then draws particles, shields, ripples, charges', () => {
  it('in that order, the particle pools opened before the drawing and closed after it', () => {
    const log: string[] = [];
    const fx = new DamageFx(new Container(), { bodies: new Map() } as never, { entities: new Map(), playerId: 1 } as never, () => {}, 100) as unknown as Record<string, Record<string, unknown>>;
    const say = (name: string) => () => { log.push(name); };
    fx.c.runPending = say('pending');
    Object.assign(fx.amb, { ambient: say('ambient'), fires: say('fires'), drawCharges: say('charges') });
    Object.assign(fx.shields, { drawShields: say('shields'), drawRipples: say('ripples') });
    Object.assign(fx.p, { begin: say('begin'), draw: say('particles'), end: say('end') });
    (fx.p.anchors as { live: unknown[]; step: () => void }).live = [{}];
    (fx.p.anchors as { step: () => void }).step = say('anchors');
    (fx as unknown as DamageFx).update(1 / 60);
    expect(log).toEqual(['pending', 'ambient', 'fires', 'anchors', 'begin', 'particles', 'shields', 'ripples', 'charges', 'end']);
  });
});
