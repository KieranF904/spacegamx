// Pins the contract invariants of the weapon-fx modules (FlakAimFx, FxField, ImpactFx, MuzzleFx, TracerFx, hitDraw, particleTypes) with fake fields
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WeaponType } from '@space-game/common';

vi.mock('../../fxTextures', async (orig) => {
  const mk = (name: string) => () => ({ name }) as never;
  return {
    ...(await orig<Record<string, unknown>>()),
    disc: mk('disc'), ring: mk('ring'), softDot: mk('dot'), streak: mk('streak'), petal: mk('petal'), puff: mk('puff'), glowBall: mk('ball'),
    petalScale: () => ({ x: 1, y: 1 }),
  };
});

import { FlakAimFx, MAX_AIM_MARKS, type AimMark } from './FlakAimFx';
import { FxField } from './FxField';
import { ImpactFx } from './ImpactFx';
import { MuzzleFx } from './MuzzleFx';
import { TracerFx, fadeState } from './TracerFx';
import { drawHits } from './hitDraw';
import { modMarkCount } from './mods';
import { FADE_FRAMES, FRAG_CAP, HIT_CAP, SMOKE_CAP } from './particleTypes';
import { weaponStyle } from '../weaponStyles';
import { Container } from 'pixi.js';

afterEach(() => vi.restoreAllMocks());

describe('client.weapon-fx.flak-aim', () => {
  it('allocates nothing per frame: the same mark list is handed to the host every frame and capped', () => {
    const lists = new Set<AimMark[]>();
    const lines = vi.fn();
    const host = { aimMarks: (out: AimMark[]) => { lists.add(out); out[0].x = 0; out[0].r = 100; out[0].firing = 1; return 99; } };
    const fx = new FlakAimFx({ line: lines, ringAt: vi.fn() } as never, host);
    fx.draw(1); fx.draw(2); fx.draw(3);
    expect(lists.size).toBe(1);
    expect([...lists][0]).toHaveLength(MAX_AIM_MARKS);
    expect(lines).toHaveBeenCalled();
    // A mark with no reach draws nothing
    lines.mockClear();
    const none = new FlakAimFx({ line: lines, ringAt: vi.fn() } as never, { aimMarks: (out) => { out[0].r = 0; return 1; } });
    none.draw(1);
    expect(lines).not.toHaveBeenCalled();
  });
});

describe('client.weapon-fx.muzzle', () => {
  const shot = (hot: number) => ({
    owner: 1, spawnX: 0, spawnY: 0, vx: 10, vy: 0, power: 1, size: 1, hot, glow: 0xffffff, pose: undefined,
    style: { muzzle: { size: 10, life: 6, sparks: 0, smoke: 0, color: 0xffaa00 }, casings: 10, heat: { cold: 0xff0000, hot: 0xffffff } },
  });
  const field = () => ({ flashes: [] as unknown[], sparks: [] as { color: number }[], rings: [] as unknown[], smoke: [] as unknown[], hitGlows: [] as unknown[], shocks: [] as unknown[], particleKeep: 1 });
  const brass = (spin: number) => {
    const f = field();
    new MuzzleFx(f as never, { onMuzzle: null, barrelTip: null, spinAt: () => spin }).flash(shot(0) as never);
    return f.sparks.filter((s) => s.color === 0xe0b860).length;
  };
  it('a minigun throws more brass the faster it spins', () => {
    const slow = brass(0), mid = brass(0.5), fast = brass(1);
    expect(slow).toBe(3);               // 10 casings x 0.3
    expect(fast).toBe(12);              // 10 casings x 1.2
    expect(slow).toBeLessThan(mid);
    expect(mid).toBeLessThan(fast);
  });
  it('a gun without a spin throws its plain casing count however it spins', () => {
    const f = field();
    const s = shot(0);
    (s.style as { heat?: unknown }).heat = undefined;
    new MuzzleFx(f as never, { onMuzzle: null, barrelTip: null, spinAt: () => 1 }).flash(s as never);
    expect(f.sparks.filter((x) => x.color === 0xe0b860)).toHaveLength(10);
  });
});

describe('client.weapon-fx.tracer', () => {
  it('a dying tracer fades and shrinks linearly over FADE_FRAMES, and is gone after it', () => {
    expect(fadeState(null)).toEqual({ fade: 1, k: 0 });
    expect(fadeState(0)).toEqual({ fade: 1, k: 0 });
    const half = fadeState(FADE_FRAMES / 2)!;
    expect(half.fade).toBeCloseTo(0.5);
    expect(half.k).toBeCloseTo(0.5);
    expect(fadeState(FADE_FRAMES - 1)!.k).toBeCloseTo((FADE_FRAMES - 1) / FADE_FRAMES);
    expect(fadeState(FADE_FRAMES)).toBeNull();
    expect(fadeState(FADE_FRAMES + 5)).toBeNull();
  });
});

describe('the Mauler reads as a cannon, not a rocket', () => {
  const style = weaponStyle(WeaponType.Cannon, 1, 'cannon_mauler');

  it('its shell is a slug on long straight trails, none of them a motor\'s: no smoke (trail, sweep, flying cloud), no tapering flame, no wobble', () => {
    expect(style.shell?.kind).toBe('slug');
    expect(style.trail).toBeUndefined();
    expect(style.sweep).toBeUndefined();
    expect(style.smokeCloud?.fly).toBeFalsy();
    expect(style.taper).toBeFalsy();
    expect(style.wobble).toBeUndefined();
    expect(style.motion).toBe('linear');
    // (its trails: a long tracer, a thin line left down its path, ripples and shed flecks)
    expect(style.tracerTicks).toBeGreaterThanOrEqual(8);
    expect(style.contrail!.size).toBeLessThanOrEqual(3);
    expect(style.ripple).toBeDefined();
    expect(style.drip).toBeDefined();
  });

  it('a shell in flight makes no smoke, and its ripples and flecks stay few however long it flies', () => {
    const f = new FxField(new Container());
    for (const pool of [f.glow, f.smokeG, f.extraG, f.hitG]) vi.spyOn(pool, 'take').mockImplementation((() => {}) as never);
    const band = vi.spyOn(f, 'band').mockImplementation((() => {}) as never);
    const tracer = new TracerFx(f, { guideTo: null, state: null });
    const shot = {
      id: 1, owner: 1, style, size: 2, dim: 1, arc: 0, glow: 0xff9a30, phase: 0.3, hot: 0, pulse: 0, fading: null, ended: false,
      head: { x: 100, y: 0 }, tail: { x: 60, y: 0 }, vx: 20, vy: 0, ctX: NaN, ctY: NaN, t: 5, spawnTick: 0, endTick: 0, endAt: Infinity,
    };
    let ripples = 0, flecks = 0, segs = 0;
    for (let i = 0; i < 200; i++) {
      shot.head.x += 20; shot.tail.x += 20;
      band.mockClear();
      tracer.drawAll(new Map([[1, shot as never]]), i, 1);
      // (aged as the field would age them: drawParticles and drawLayered are not run here)
      for (const list of [f.shocks, f.sparks] as { life: number; max: number }[][]) for (let k = list.length - 1; k >= 0; k--) if (++list[k].life >= list[k].max) list.splice(k, 1);
      ripples = Math.max(ripples, f.shocks.length); flecks = Math.max(flecks, f.sparks.length); segs = Math.max(segs, band.mock.calls.length);
    }
    expect(f.smoke).toHaveLength(0);
    expect(ripples).toBeGreaterThan(0);
    expect(ripples).toBeLessThanOrEqual(4);
    expect(flecks).toBeGreaterThan(0);
    expect(flecks).toBeLessThanOrEqual(32);
    // (the line left down its path: a segment a frame, each gone after the contrail's life)
    expect(segs).toBeGreaterThan(0);
    expect(segs).toBeLessThanOrEqual(style.contrail!.life);
    // (every trail segment lies on the shell's own line: straight)
    expect(band.mock.calls.every((c) => c[1] === 0 && c[3] === 0)).toBe(true);
    expect(f.glow.take).toHaveBeenCalled();
    expect(f.extraG.take).toHaveBeenCalled();
  });

  it('its muzzle is a heavy gun\'s blast: a flash, pressure rings, smoke at the bore and sparks', () => {
    expect(style.blast).toBe('heavy');
    const f = new FxField(new Container());
    new MuzzleFx(f, { onMuzzle: null, barrelTip: null, spinAt: null }).flash({ owner: 1, spawnX: 0, spawnY: 0, vx: 20, vy: 0, power: 1, size: 2, hot: 0, glow: 0xff9a30, style } as never);
    expect(f.flashes).toHaveLength(1);
    expect(f.shocks.length).toBeGreaterThanOrEqual(2);
    expect(f.smoke.length).toBeGreaterThan(8);
    expect(f.sparks.length).toBeGreaterThan(8);
    expect(f.hitGlows.length).toBeGreaterThan(0);
    // (within the pool's budgets, as the other heavy guns)
    expect(f.smoke.length).toBeLessThan(40);
    expect(f.sparks.length).toBeLessThan(40);
  });
});

describe('client.weapon-fx.hit-draw', () => {
  const take = vi.fn();
  const makeFx = () => ({
    hitG: { take }, shockG: { ring: vi.fn() }, glow: {}, line: vi.fn(), circle: vi.fn(),
    hitGlows: [] as Record<string, unknown>[], scorches: [] as Record<string, unknown>[], shocks: [] as Record<string, unknown>[],
    frags: [] as Record<string, unknown>[], flares: [] as Record<string, unknown>[], hitLights: [] as Record<string, unknown>[], smoke: [] as unknown[], particleKeep: 1,
  });
  const glow = (color: number, life: number, max: number) => ({ x: 0, y: 0, life, max, size: 10, color, core: false });

  it('ages each list and draws it newest first, splicing out what reached max life', () => {
    take.mockClear();
    const fx = makeFx();
    fx.hitGlows.push(glow(1, 0, 10), glow(2, 0, 10), glow(3, 9, 10), glow(4, 0, 10));
    drawHits(fx as never, 2);
    expect(fx.hitGlows.map((g) => g.color)).toEqual([1, 2, 4]);   // 3 aged out
    expect(fx.hitGlows.every((g) => g.life === 2 || g.color === 3)).toBe(true);
    // Drawn from the end of the list: 4, then 2, then 1
    expect(take.mock.calls.map((c) => c[5])).toEqual([4, 2, 1]);
    // Lights and shocks go the same way
    fx.hitLights.push({ x: 0, y: 0, life: 9, max: 10, radius: 1, power: 1, color: 0 }, { x: 0, y: 0, life: 0, max: 10, radius: 1, power: 1, color: 0 });
    drawHits(fx as never, 1);
    expect(fx.hitLights).toHaveLength(1);
  });

  it('a fragment\'s smoke puffs stop at SMOKE_CAP', () => {
    const fx = makeFx();
    const frag = () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 100, size: 2, hot: 0xffffff, cool: 0x333333, trail: 0xffffff, drag: 1, puff: 0, smokes: 1 });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fx.frags.push(frag());
    drawHits(fx as never, 1);
    expect(fx.smoke).toHaveLength(1);
    fx.smoke = new Array(SMOKE_CAP).fill(0);
    fx.frags[0].puff = 0;
    drawHits(fx as never, 1);
    expect(fx.smoke).toHaveLength(SMOKE_CAP);
  });
});

describe('client.weapon-fx.impact and particles', () => {
  const layered = { ...weaponStyle(WeaponType.Cannon), hit: {
    core: { size: 10, life: 6 }, bloom: { size: 20, life: 10 }, shock: { size: 30, life: 10, width: 3, count: 3 },
    debris: { count: 8, speed: 5, size: 2, life: 10, hot: 0xffffff, cool: 0x333333 }, scorch: { size: 8, life: 30, color: 0xffaa00 },
    embers: { count: 20, speed: 3, life: 20, hot: 0xffaa00, cool: 0x552200 }, spray: { count: 20, speed: 8, cone: 30, life: 10 },
  } };
  const field = () => ({
    hitGlows: [], shocks: [], scorches: [], frags: [], flares: [], hitLights: [], smoke: [], rings: [], sparks: [], fragsMade: 0, particleKeep: 1,
    anchors: { open: () => null }, liquid: { n: 0, keep: 1, bind: () => {}, spawn: () => {} },
  } as Record<string, unknown[] | unknown>);
  const hit = (f: Record<string, unknown>) => new ImpactFx(f as never, { surfaceAt: null, sounds: null, state: null }).at({ style: layered, size: 1, power: 1, vx: 10, vy: 0, owner: 1, id: 1, glow: 0xffffff } as never, 0, 0);

  it('layered particle lists stop growing at their caps (the caps are what particleTypes exports)', () => {
    expect([HIT_CAP, FRAG_CAP, SMOKE_CAP]).toEqual([600, 240, 700]);
    const f = field();
    (f.hitGlows as unknown[]).push(...new Array(HIT_CAP).fill({}));
    (f.shocks as unknown[]).push(...new Array(HIT_CAP).fill({}));
    (f.scorches as unknown[]).push(...new Array(HIT_CAP).fill({}));
    (f.sparks as unknown[]).push(...new Array(HIT_CAP * 2).fill({ color: 0 }));
    hit(f);
    expect((f.hitGlows as unknown[]).length).toBe(HIT_CAP);
    expect((f.shocks as unknown[]).length).toBe(HIT_CAP);
    expect((f.scorches as unknown[]).length).toBe(HIT_CAP);
    expect((f.sparks as unknown[]).length).toBe(HIT_CAP * 2);
    // Below the caps the same hit does add
    const g = field();
    hit(g);
    expect((g.hitGlows as unknown[]).length).toBeGreaterThan(0);
    expect((g.shocks as unknown[]).length).toBeGreaterThan(0);
    expect((g.scorches as unknown[]).length).toBe(1);
  });

  it('fragments past FRAG_CAP drop the oldest first', () => {
    const f = field();
    const old = Array.from({ length: FRAG_CAP }, (_, i) => ({ id: i }));
    (f.frags as unknown[]).push(...old);
    hit(f);
    const frags = f.frags as { id?: number }[];
    expect(frags).toHaveLength(FRAG_CAP);
    expect(frags[0].id).toBeGreaterThan(0);                 // the first went
    expect(frags.some((x) => x.id === FRAG_CAP - 1)).toBe(true); // the newest old one is still there
    expect(frags[frags.length - 1].id).toBeUndefined();     // and the new ones are at the end
  });

  it('a plain shell\'s hit leaves no modifier\'s blast; a blast told alone adds a ring and one hanging mark, and no ring past HIT_CAP', () => {
    const real = () => new FxField(new Container());
    const impact = (f: FxField) => new ImpactFx(f, { surfaceAt: null, sounds: null, state: null } as never);
    // (an unmodified slug: its own layers only, nothing hanging after)
    const a = real();
    impact(a).at({ style: weaponStyle(WeaponType.Cannon), size: 1, power: 1, vx: 10, vy: 0, owner: 1, id: 1, glow: 0xffffff, splash: 0 } as never, 0, 0);
    expect(modMarkCount(a)).toBe(0);
    const b = real();
    impact(b).blast(0, 0, 30);
    expect(b.shocks.some((s) => s.size === 30)).toBe(true);
    expect(modMarkCount(b)).toBe(1);
    // (a way out of a hull: its heading given, a second mark of its own)
    impact(b).blast(400, 0, 30, 1);
    expect(modMarkCount(b)).toBe(2);
    const c = real();
    c.shocks.push(...new Array(HIT_CAP).fill({ x: 0, y: 0, life: 0, max: 1, size: 1, width: 1, color: 0 }));
    impact(c).blast(0, 0, 30);
    expect(c.shocks).toHaveLength(HIT_CAP);
  });
});

describe('client.weapon-fx.field', () => {
  const makeField = () => {
    const f = new FxField(new Container());
    const log: string[] = [];
    for (const [name, pool] of [['glow', f.glow], ['smoke', f.smokeG], ['extra', f.extraG], ['hit', f.hitG]] as const) {
      vi.spyOn(pool, 'take').mockImplementation(((tex: { name: string }) => { log.push(`${name}:${tex.name}`); }) as never);
    }
    return { f, log };
  };

  it('draws flashes, sparks, smoke, then rings, in that order', () => {
    const { f, log } = makeField();
    f.rings.push({ x: 0, y: 0, life: 0, max: 10, size: 10, color: 1 });
    f.smoke.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 10, size: 4 });
    f.sparks.push({ x: 0, y: 0, vx: 1, vy: 0, life: 0, max: 10, color: 1 });
    f.flashes.push({ x: 0, y: 0, angle: 0, life: 0, max: 10, size: 5, color: 1, sparks: [], petals: [1, 1, 1], girth: 1, owner: -1, ox: 0, oy: 0, rel: 0 });
    f.drawParticles(1);
    const firstPetal = log.indexOf('glow:petal'), firstStreak = log.indexOf('glow:streak'), smoke = log.indexOf('smoke:dot'), lastDisc = log.lastIndexOf('glow:disc');
    expect(firstPetal).toBeGreaterThanOrEqual(0);
    expect(firstPetal).toBeLessThan(firstStreak);
    expect(firstStreak).toBeLessThan(smoke);
    expect(smoke).toBeLessThan(lastDisc);
  });

  it('a vent makes no particles when the quality share drops it', () => {
    const { f } = makeField();
    f.particleKeep = 0.5;
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.9);   // above the share: dropped
    f.vent(0, 0, 0, 'smoke', 1); f.vent(0, 0, 0, 'spark', 1);
    expect(f.smoke).toHaveLength(0);
    expect(f.sparks).toHaveLength(0);
    rnd.mockReturnValue(0.1);                                    // below it: made
    f.vent(0, 0, 0, 'smoke', 1); f.vent(0, 0, 0, 'spark', 1);
    expect(f.smoke).toHaveLength(1);
    expect(f.sparks).toHaveLength(2);
  });

  it('draws the liquid, then the layered hits', () => {
    const { f, log } = makeField();
    f.hitGlows.push({ x: 0, y: 0, life: 0, max: 10, size: 10, color: 1, core: false });
    const update = vi.fn(() => { log.push('liquid'); });
    (f as unknown as { liquid: unknown }).liquid = { n: 1, keep: 1, update };
    f.drawLayered(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(log.indexOf('liquid')).toBeLessThan(log.indexOf('hit:ball'));
  });

  it('a vent makes no particles when the quality share drops it', () => {
    const { f } = makeField();
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    f.particleKeep = 0.5;
    f.vent(0, 0, 0, 'smoke', 0xffffff); f.vent(0, 0, 0, 'spark', 0xffffff);
    expect(f.smoke).toHaveLength(0);
    expect(f.sparks).toHaveLength(0);
    f.particleKeep = 1;
    f.vent(0, 0, 0, 'smoke', 0xffffff); f.vent(0, 0, 0, 'spark', 0xffffff);
    expect(f.smoke).toHaveLength(1);
    expect(f.sparks).toHaveLength(2);
  });
});
