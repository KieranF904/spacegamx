/**
 * Shield and ambient effects (damage/shields.ts, damage/ambient.ts, damage/partEffects.ts) over a recording stand-in
 * for the particle field: a drop already sounded by a ripple is not sounded again within RIPPLE_HEARD_MS, a ripple
 * lives 18 frames and rides the ship's frame, a burn ends with its time or its part, a crumbling part throttles its sound.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { createShipState, EntityType, type ShipState } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { DamageCtx } from './context';
import { ShieldFx } from './shields';
import { AmbientFx } from './ambient';
import { crumble } from './partEffects';

vi.mock('../../rendering/fxTextures', () => {
  const t = () => ({});
  return { BUBBLE_RIM: 1, DOT_SIZE: 1, bubble: t, bubbleRim: t, glowBall: t, hexShield: t, streak: t, streakScale: () => ({ x: 1, y: 1 }) };
});

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
const { catalog, tuning } = bridge;

type Call = [string, ...unknown[]];

/** Anything called on it is recorded by its path */
function recorder(calls: Call[], path = 'p'): unknown {
  return new Proxy(() => {}, {
    get: (_t, name) => (name === 'ps' ? [] : recorder(calls, `${path}.${String(name)}`)),
    apply: (_t, _this, args) => { calls.push([path, ...args]); return undefined; },
  });
}

interface Ent { type: EntityType; renderX: number; renderY: number; renderAngle: number; vx: number; vy: number; data: number[] }

function rig(design = 'hauler') {
  const calls: Call[] = [];
  const ship = createShipState(catalog, tuning, 5, bridge.library.get(design)!, 0) as ShipState;
  const ent: Ent = { type: EntityType.ShipBody, renderX: 100, renderY: 50, renderAngle: 0.3, vx: 0, vy: 0, data: [0, 100, 0] };
  const source = {
    bodies: new Map([[5, ship]]),
    get: (id: number) => (id === 5 ? ship : undefined),
    geometry: () => [{ centroid: [1, 1] }, { centroid: [1, 1] }, { centroid: [1, 1] }, { centroid: [1, 1] }],
    tuning,
  };
  const state = { entities: new Map([[5, ent]]), playerId: 1 };
  const sound = (id: string) => { calls.push(['sound', id]); };
  const c = new DamageCtx(recorder(calls) as never, source as never, state as never, sound, 100);
  return { c, calls, ship, ent, source };
}
const sounds = (calls: Call[], id: string) => calls.filter((k) => k[0] === 'sound' && k[1] === id).length;

afterEach(() => vi.restoreAllMocks());

describe('a shield\'s drop that a shell\'s ripple already sounded is not sounded again within RIPPLE_HEARD_MS', () => {
  it('quiet after a ripple, audible again once 700 ms have passed, and audible with no ripple at all', () => {
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const quiet = rig(), loud = rig();
    for (const r of [quiet, loud]) { new ShieldFx(r.c); }
    const a = new ShieldFx(quiet.c), b = new ShieldFx(loud.c);
    a.drawShields(1); b.drawShields(1); // both at 100: nothing dropped yet
    a.shieldHit(quiet.ent.renderX, quiet.ent.renderY); // a shell ripples a's bubble
    quiet.ent.data[1] = 50; loud.ent.data[1] = 50;
    a.drawShields(30); b.drawShields(30);
    expect(sounds(quiet.calls, 'shield_hit')).toBe(0);
    expect(sounds(loud.calls, 'shield_hit')).toBe(1);
    // the same ripple's window has run out: the next drop is heard
    now += 800;
    quiet.ent.data[1] = 20;
    a.drawShields(30);
    expect(sounds(quiet.calls, 'shield_hit')).toBe(1);
  });
});

describe('a ripple lives 18 frames and rides the ship\'s frame', () => {
  it('drawn on frames 1 to 17, gone on the 18th, and placed by the ship\'s pose each frame', () => {
    const { c, calls, ent } = rig();
    const fx = new ShieldFx(c);
    fx.drawShields(1);
    fx.shieldHit(ent.renderX + 20, ent.renderY); // struck 20 out along +x, ship turned by renderAngle 0.3
    const drawn = () => calls.filter((k) => k[0] === 'p.addSprites.take');
    fx.drawRipples(1);
    const first = drawn()[0] as unknown as [string, unknown, number, number];
    const d = Math.hypot(first[2] - ent.renderX, first[3] - ent.renderY);
    expect(d).toBeGreaterThan(0);
    expect(Math.atan2(first[3] - ent.renderY, first[2] - ent.renderX)).toBeCloseTo(0, 5);
    // the ship moves and turns: the patch follows, still at the same distance, its bearing turned by the same amount
    ent.renderX = -400; ent.renderY = 900; ent.renderAngle += 1;
    fx.drawRipples(1);
    const second = drawn()[1] as unknown as [string, unknown, number, number];
    expect(Math.hypot(second[2] - ent.renderX, second[3] - ent.renderY)).toBeCloseTo(d, 5);
    expect(Math.atan2(second[3] - ent.renderY, second[2] - ent.renderX)).toBeCloseTo(1, 5);
    for (let i = 0; i < 40; i++) fx.drawRipples(1);
    expect(drawn().length).toBe(17); // frames 1..17 drew, the 18th removed it, then nothing
  });
});

describe('a burn ends when its time is up or its part is gone', () => {
  const flames = (calls: Call[]) => calls.filter((k) => k[0] === 'p.push').length;
  it('flames while it lasts, none after its seconds run out', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { c, calls } = rig();
    const fx = new AmbientFx(c);
    fx.onIgnite(5, 0, 60); // one second
    calls.length = 0;
    fx.fires(1);
    expect(flames(calls)).toBeGreaterThan(0);
    c.time = 1.5;
    calls.length = 0;
    fx.fires(1);
    expect(flames(calls)).toBe(0);
  });
  it('none once its part is gone', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { c, calls, ship } = rig();
    const fx = new AmbientFx(c);
    fx.onIgnite(5, 0, 600);
    calls.length = 0;
    fx.fires(1);
    expect(flames(calls)).toBeGreaterThan(0);
    ship.derived.alive[0] = false;
    calls.length = 0;
    fx.fires(1);
    expect(flames(calls)).toBe(0);
  });
});

describe('a crumbling part throttles its sound', () => {
  it('one sound per quarter second of the effects clock, however many crumbles', () => {
    const { c, calls } = rig();
    c.time = 1;
    for (let i = 0; i < 5; i++) crumble(c, 0, 0, 0, 0, 20);
    expect(sounds(calls, 'disintegrate')).toBe(1);
    c.time = 1.2;
    crumble(c, 0, 0, 0, 0, 20);
    expect(sounds(calls, 'disintegrate')).toBe(1);
    c.time = 1.3;
    crumble(c, 0, 0, 0, 0, 20);
    expect(sounds(calls, 'disintegrate')).toBe(2);
  });
});
