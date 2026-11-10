// Pins the contract invariants of Renderer and the modules under rendering/renderer/ (damageNumbers, deathScreen, panControl, systemVisuals,
// background, cameraStep, entityParts, entityViews, frameEffects, minimap, particleFx) with fake renderer hosts; Pixi runs headless in node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Container, Graphics } from 'pixi.js';
import { EntityType, EffectType } from '@space-game/common';

const bitmapTexts: unknown[] = [];
const installs: unknown[] = [];
vi.mock('pixi.js', async (orig) => {
  const p = await orig<typeof import('pixi.js')>();
  class FakeBitmapText extends p.Container {
    text = '';
    style = { fontSize: 0 };
    anchor = { set: () => {} };
    constructor() { super(); bitmapTexts.push(this); }
  }
  return { ...p, BitmapText: FakeBitmapText, BitmapFont: { install: (o: unknown) => installs.push(o) } };
});
vi.mock('../fxTextures', async (orig) => {
  const { Texture } = await import('pixi.js');
  const tex = () => Texture.EMPTY;
  return { ...(await orig<Record<string, unknown>>()), disc: tex, ring: tex, rock: tex, softDot: tex, streak: tex, glowBall: tex };
});
vi.mock('../weapons/WeaponFx', () => ({ shotTimelines: () => [0, 0] }));

import { DamageNumbers } from './damageNumbers';
import { DeathScreen } from './deathScreen';
import { PanControl } from './panControl';
import { DEFAULT_SYSTEM_VISUALS, visualsFromInfo } from './systemVisuals';
import { starBody } from './background';
import { updateCamera } from './cameraStep';
import { updateHealthBar, type Tag } from './entityParts';
import { renderEntities, radiusOf } from './entityViews';
import { updateEffects, collectLights } from './frameEffects';
import { Minimap } from './minimap';
import { ParticleFx } from './particleFx';

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('client.render.renderer', () => {
  const text = src('../Renderer.ts');
  it('draws a frame in one update(delta): camera, backdrop, entities, effects, numbers, minimap in order', () => {
    expect(text.match(/^  update\(delta: number\): void \{/gm)).toHaveLength(1);
    const body = text.slice(text.indexOf('  update(delta: number): void {'));
    const order = ['updateCamera(this', 'renderBackground(this', 'renderEntities(this', 'updateEffects(this', 'this.damageNumbers.update(', 'this.minimap.tick()'].map((s) => body.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('gets effects, hit numbers, minimap and death screen from modules under renderer/', () => {
    for (const [cls, file] of [['ParticleFx', 'particleFx'], ['DamageNumbers', 'damageNumbers'], ['Minimap', 'minimap'], ['DeathScreen', 'deathScreen']]) {
      expect(text).toContain(`import { ${cls} } from './renderer/${file}'`);
      expect(text).not.toMatch(new RegExp(`class ${cls}\\b`));
    }
  });
});

describe('client.render.damage-numbers', () => {
  const host = { tagScale: () => 1, cameraAngle: () => 0 };
  it('pools its texts: once warm, a hit makes no new text and the font is installed once', () => {
    bitmapTexts.length = 0; installs.length = 0;
    const d = new DamageNumbers(new Container(), host);
    for (let i = 0; i < 4; i++) d.show(0, 0, 10 + i);
    expect(bitmapTexts).toHaveLength(4);
    d.update(2);                         // all expire back into the pool
    expect(d.layer.children).toHaveLength(0);
    for (let i = 0; i < 4; i++) d.show(0, 0, 5);
    expect(bitmapTexts).toHaveLength(4);
    d.show(0, 0, 5, true);               // a fifth live at once: one more, then pooled again
    expect(bitmapTexts).toHaveLength(5);
    expect(installs.length).toBeLessThanOrEqual(1);
  });
});

describe('client.render.death-screen', () => {
  it('a resize while dead keeps the fade and the title scale where they were', () => {
    let size = { width: 800, height: 600 };
    const parent = new Container();
    const d = new DeathScreen(parent, () => size);
    d.show('a Raider');
    const o = () => (d as unknown as { overlay: Container }).overlay;
    o().alpha = 0.6;
    o().getChildByLabel('deathTitle')!.scale.set(1.2);
    const before = o();
    size = { width: 1200, height: 700 };
    d.rebuild();
    expect(o()).not.toBe(before);
    expect(o().alpha).toBeCloseTo(0.6);
    expect(o().getChildByLabel('deathTitle')!.scale.x).toBeCloseTo(1.2);
    expect(o().getChildByLabel('deathTitle')!.x).toBe(600);
    expect(parent.children).toHaveLength(1);
    d.hide();
    expect(d.active).toBe(false);
    d.rebuild();                         // nothing up: nothing built
    expect(d.active).toBe(false);
  });
});

describe('client.render.pan-control', () => {
  const stubs: unknown[] = [];
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => { const b = { style: {}, addEventListener: () => {}, textContent: '', title: '' }; stubs.push(b); return b; }, body: { appendChild: () => {} } });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('keeps the browser from autoscrolling on the middle button only', () => {
    const on: Record<string, (e: unknown) => void> = {};
    const canvas = { addEventListener: (n: string, f: (e: unknown) => void) => { on[n] = f; }, setPointerCapture: () => {}, releasePointerCapture: () => {} };
    const pan = new PanControl(canvas as never, { zoom: () => 2, locked: () => false });
    for (const ev of ['mousedown', 'auxclick', 'pointerdown']) {
      const mid = vi.fn(), left = vi.fn();
      on[ev]({ button: 1, preventDefault: mid, pointerId: 1 });
      on[ev]({ button: 0, preventDefault: left, pointerId: 2 });
      expect(mid, ev).toHaveBeenCalledTimes(1);
      expect(left, ev).not.toHaveBeenCalled();
    }
    // The drag then pans in world units (screen px over zoom), and recenter brings it back
    on.pointermove({ pointerId: 1, movementX: 10, movementY: -4 });
    expect(pan.pan).toEqual({ x: -5, y: 2 });
    on.pointermove({ pointerId: 9, movementX: 10, movementY: 10 });
    expect(pan.pan).toEqual({ x: -5, y: 2 });
    pan.recenter();
    expect(pan.pan).toEqual({ x: 0, y: 0 });
  });
  it('does not even start a drag while the camera is locked', () => {
    const on: Record<string, (e: unknown) => void> = {};
    const canvas = { addEventListener: (n: string, f: (e: unknown) => void) => { on[n] = f; } };
    const pan = new PanControl(canvas as never, { zoom: () => 1, locked: () => true });
    on.pointerdown({ button: 1, preventDefault: () => {}, pointerId: 1 });
    on.pointermove({ pointerId: 1, movementX: 10, movementY: 10 });
    expect(pan.pan).toEqual({ x: 0, y: 0 });
  });
});

describe('client.render.system-visuals', () => {
  it('a systemInfo that names no hue or radius builds what the default draws (the fallback until it arrives), and the backdrop falls back to it', () => {
    const v = visualsFromInfo({ centralBody: {}, visuals: {} } as never);
    expect(v.starHue).toBe(DEFAULT_SYSTEM_VISUALS.starHue);
    expect(v.starRadius).toBe(DEFAULT_SYSTEM_VISUALS.starRadius);
    expect(src('./background.ts')).toContain('rend.systemVisuals.get(rend.currentSystemId) || DEFAULT_SYSTEM_VISUALS');
  });
});

describe('client.render.background', () => {
  it('a system\'s star is its systems.json entry, else one made once per visuals object from what the server sent', () => {
    const rend = { currentSystemId: 'no-such-system', starBodies: new Map() };
    const v = { starHue: 12, starRadius: 345, sunStyle: 'granular' };
    const a = starBody(rend as never, v as never);
    expect(a).toMatchObject({ radius: 345, hue: 12, sunStyle: 'granular' });
    expect(starBody(rend as never, v as never)).toBe(a);
    expect(starBody(rend as never, { ...v } as never)).not.toBe(a);
  });
});

describe('client.render.camera-step', () => {
  function fakeRend(over: Record<string, unknown> = {}) {
    const wc = { pivot: { set: vi.fn() }, x: 0, y: 0, rotation: 0, scale: { set: vi.fn() } };
    return {
      cameraTarget: undefined, state: { getPlayerPosition: () => ({ x: 100, y: 50 }), screenShake: {} },
      app: { screen: { width: 1000, height: 800 } }, cameraZoom: 1, cameraHeading: null, helmTime: 0, cameraSnap: false, cameraAngle: 0,
      cameraX: 100, cameraY: 50, cameraFollow: 0.1, shakeScale: 1, death: { active: false },
      panCtl: { pan: { x: 0, y: 0 }, showRecenter: vi.fn() }, worldContainer: wc, ...over,
    };
  }
  it('keeps a panned view\'s ship a margin (10%) inside every edge, and offers the recenter button once off it', () => {
    const r = fakeRend();
    r.panCtl.pan.x = 99999; r.panCtl.pan.y = -99999;
    updateCamera(r as never, 0.016);
    expect(r.panCtl.pan.x).toBeCloseTo(0.4 * 1000);
    expect(r.panCtl.pan.y).toBeCloseTo(-0.4 * 800);
    expect(r.panCtl.showRecenter).toHaveBeenLastCalledWith(true);
    r.panCtl.pan.x = r.panCtl.pan.y = 0;
    updateCamera(r as never, 0.016);
    expect(r.panCtl.showRecenter).toHaveBeenLastCalledWith(false);
  });
  it('a snap lands the camera on the ship; follow is smoothed otherwise, and the view returns to north-up with no heading', () => {
    const r = fakeRend({ cameraX: 0, cameraY: 0, cameraSnap: true, cameraAngle: 0.5 });
    updateCamera(r as never, 0.016);
    expect([r.cameraX, r.cameraY]).toEqual([100, 50]);
    expect(r.cameraSnap).toBe(false);
    expect(r.worldContainer.pivot.set).toHaveBeenLastCalledWith(100, 50);
    expect(r.worldContainer.x).toBe(500);
    expect(r.worldContainer.y).toBe(400);
    const s = fakeRend({ cameraX: 0, cameraY: 0 });
    updateCamera(s as never, 0.016);
    expect(s.cameraX).toBeGreaterThan(0);
    expect(s.cameraX).toBeLessThan(100);
    // North-up: a small leftover roll is zeroed, a large one eases back
    const n = fakeRend({ cameraAngle: 5e-5 });
    updateCamera(n as never, 0.016);
    expect(n.cameraAngle).toBe(0);
    const big = fakeRend({ cameraAngle: 1.0 });
    updateCamera(big as never, 0.016);
    expect(big.cameraAngle).toBeLessThan(1.0);
    expect(big.cameraAngle).toBeGreaterThan(0);
  });
});

describe('client.render.entity-parts', () => {
  it('redraws the health bar only when what it shows changes', () => {
    const bar = new Graphics();
    const clear = vi.spyOn(bar, 'clear');
    const tag: Tag = { name: null, bar, barKey: '' };
    const e = { hp: 50, maxHp: 100, data: [] as number[] };
    updateHealthBar(tag, e);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(bar.visible).toBe(true);
    updateHealthBar(tag, e); updateHealthBar(tag, { ...e });
    expect(clear).toHaveBeenCalledTimes(1);
    updateHealthBar(tag, { ...e, hp: 49 });
    expect(clear).toHaveBeenCalledTimes(2);
    // A shield strip changes what it shows too
    updateHealthBar(tag, { hp: 49, maxHp: 100, data: [0, 0, 0, 0, 40] });
    expect(clear).toHaveBeenCalledTimes(3);
    // Undamaged: hidden, nothing drawn
    updateHealthBar(tag, { hp: 100, maxHp: 100, data: [] });
    expect(bar.visible).toBe(false);
    expect(clear).toHaveBeenCalledTimes(3);
  });
});

describe('client.render.entity-views', () => {
  function fakeRend(entities: Record<string, unknown>[]) {
    return {
      aliveIds: new Set<number>(), viewBox: () => ({ hw: 500, hh: 500 }), CULL_MARGIN: 100, tagScale: 1,
      state: { entities: new Map(entities.map((e) => [e.id as number, e])), playerId: 1 },
      cameraX: 0, cameraY: 0, cameraAngle: 0, showNames: true,
      entityGraphics: new Map<number, Container>(), entityContainer: new Container(), fadingIn: new Map(), fadingOut: [] as unknown[],
      hiddenEntityIds: new Set(), mobs: new Map(), rockHits: new Map(), tags: new Map(), shipRadius: new Map(), typeOf: new Map(),
      rocks: { remove: vi.fn() }, rockObjs: new Map(), rifts: new Map(), gates: new Map(), stations: new Map(),
    };
  }
  const ship = (id: number, x: number) => ({ id, type: EntityType.ShipBody, x, y: 0, renderX: x, renderY: 0, renderAngle: 0.5, data: [] });
  it('makes a view once and keeps it while the entity lives; shots get none; the out-of-view are hidden, not disposed', () => {
    const r = fakeRend([ship(1, 0), ship(2, 5000), { id: 3, type: EntityType.Projectile, x: 0, y: 0, renderX: 0, renderY: 0, renderAngle: 0 }]);
    renderEntities(r as never, 0.016);
    expect([...r.entityGraphics.keys()]).toEqual([1]);
    const first = r.entityGraphics.get(1)!;
    expect(first.rotation).toBe(0.5);
    r.state.entities.set(2, ship(2, 0));
    renderEntities(r as never, 0.016);
    expect(r.entityGraphics.get(1)).toBe(first);
    expect(r.entityGraphics.size).toBe(2);
    // Out of view again: kept, hidden
    r.state.entities.set(2, ship(2, 9000));
    renderEntities(r as never, 0.016);
    expect(r.entityGraphics.get(2)!.visible).toBe(false);
    expect(r.entityGraphics.has(2)).toBe(true);
  });
  it('disposes a gone entity\'s view', () => {
    const r = fakeRend([ship(1, 0), ship(2, 10)]);
    renderEntities(r as never, 0.016);
    const gone = r.entityGraphics.get(2)!;
    r.state.entities.delete(2);
    renderEntities(r as never, 0.016);
    expect(r.entityGraphics.has(2)).toBe(false);
    expect(gone.destroyed).toBe(true);
    expect(r.entityContainer.children).toHaveLength(1);
    expect(r.rocks.remove).toHaveBeenCalledWith(2);
  });
  it('reaches further than its size for culling: a ship its hull and tag, a rock 1.3 times its size, a rift more than a gate', () => {
    const r = fakeRend([]);
    r.shipRadius.set(5, 100);
    expect(radiusOf(r as never, { id: 5, type: EntityType.ShipBody })).toBe(160);
    expect(radiusOf(r as never, { id: 6, type: EntityType.Asteroid, data: [100] })).toBeCloseTo(130);
    expect(radiusOf(r as never, { id: 7, type: EntityType.Portal, data: [0, 1] })).toBeGreaterThan(radiusOf(r as never, { id: 8, type: EntityType.Portal, data: [0, 0] }));
  });
});

describe('client.render.frame-effects', () => {
  const gate = () => ({ phase: 1, pulse: 1, outer: { rotation: 0, alpha: 0 }, inner: { rotation: 0, alpha: 0 }, core: { scale: { set: vi.fn() } } });
  it('breathes each gate within its band, and drops seams and pods whose entity is gone', () => {
    const g = gate();
    const pod = { update: vi.fn(), light: vi.fn() };
    const rend = {
      fx: { update: vi.fn() }, rifts: new Map(), gates: new Map([[1, g]]), time: 3, seamTime: 0,
      asteroidSeams: new Map([[10, { phase: 0, glow: { alpha: 0 } }], [11, { phase: 0, glow: { alpha: 0 } }]]),
      entityGraphics: new Map([[10, {}], [20, { visible: false, x: 0, y: 0 }]]),
      lootPods: new Map([[20, pod], [21, pod]]), stations: new Map(), podLight: {}, lighting: { levelAt: () => 0 },
      state: { entities: new Map(), playerId: 1 }, weaponFx: { update: vi.fn() }, entityAt: () => undefined,
    };
    updateEffects(rend as never, 0.016);
    expect(g.pulse).toBeGreaterThanOrEqual(0.64);
    expect(g.pulse).toBeLessThanOrEqual(1);
    expect(g.outer.alpha).toBe(g.pulse);
    expect([...rend.asteroidSeams.keys()]).toEqual([10]);
    expect([...rend.lootPods.keys()]).toEqual([20]);
    expect(rend.fx.update).toHaveBeenCalledWith(0.016);
    expect(rend.weaponFx.update).toHaveBeenCalledTimes(1);
  });
  it('lights a dropped item in its rarity\'s colour, and shades from ships only in space', () => {
    const L = { point: vi.fn(), shadow: vi.fn() };
    const rend = {
      weaponFx: { collectLights: vi.fn() }, fx: { collectLights: vi.fn() },
      entityGraphics: new Map([[1, { visible: true, x: 5, y: 6 }]]), stations: new Map(), gates: new Map(),
      state: { entities: new Map([[1, { type: EntityType.DroppedItem, data: [3] }], [2, { renderX: 7, renderY: 8 }]]) },
      shipRadius: new Map([[2, 30]]), surface: { active: false },
    };
    collectLights(rend as never, L as never);
    expect(L.point).toHaveBeenCalledTimes(1);
    expect(L.point.mock.calls[0][2]).toBe(0xc77dff);
    expect(L.shadow).toHaveBeenCalledWith(7, 8, 30);
    L.shadow.mockClear();
    rend.surface.active = true;
    collectLights(rend as never, L as never);
    expect(L.shadow).not.toHaveBeenCalled();
  });
});

describe('client.render.minimap', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['performance'] }));
  afterEach(() => vi.useRealTimers());
  function make(angle: () => number) {
    const state = {
      getPlayerPosition: () => ({ x: 0, y: 0 }), entities: new Map(), playerId: 1, systemId: 'sol', getRawServerTick: () => 0,
      populations: { ghosts: () => [] },
    };
    const host = { cameraAngle: angle, sysData: () => undefined, wayIns: () => [], hiddenBody: () => false };
    const m = new Minimap(() => 1000, new Container(), state as never, host);
    const g = (m as unknown as { graphics: Graphics }).graphics;
    return { m, g, clear: vi.spyOn(g, 'clear') };
  }
  it('is turned against the view\'s roll', () => {
    let a = 0.7;
    const { m, g } = make(() => a);
    vi.advanceTimersByTime(100);
    m.tick();
    expect(g.rotation).toBeCloseTo(-0.7);
    a = -1.1;
    vi.advanceTimersByTime(100);
    m.tick();
    expect(g.rotation).toBeCloseTo(1.1);
  });
  it('redraws at most every 1000/hz milliseconds', () => {
    const { m, clear } = make(() => 0);
    m.setHz(10);
    vi.advanceTimersByTime(150);
    m.tick(); m.tick(); m.tick();
    expect(clear).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60);
    m.tick();
    expect(clear).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    m.tick();
    expect(clear).toHaveBeenCalledTimes(2);
    m.setHz(20);
    vi.advanceTimersByTime(60);
    m.tick();
    expect(clear).toHaveBeenCalledTimes(3);
  });
});

describe('client.render.particle-fx', () => {
  /** Math.random fed from a list (then 0.5) */
  const feed = (vals: number[]) => { let i = 0; return vi.spyOn(Math, 'random').mockImplementation(() => vals[i++] ?? 0.5); };
  afterEach(() => vi.restoreAllMocks());
  const parts = (fx: ParticleFx) => (fx as unknown as { particles: { vx: number; vy: number; maxLife: number; life: number; color: number; radius: number }[] }).particles;
  it('an explosion\'s random draws go angle, speed, colour roll, life, radius for each particle in turn', () => {
    const fx = new ParticleFx(new Container(), { entities: new Map(), playerId: 1, triggerScreenShake: () => {} } as never);
    feed([0.25, 0.5, 0.1, 0, 0]);
    fx.showEffect(EffectType.Explosion, 0, 0, [3]);
    const p = parts(fx)[0];
    // angle 0.25 turn (straight down +y), speed 1 + 0.5 * 4, roll 0.1 (white), life 0.2, radius 2
    expect(p.vx).toBeCloseTo(0, 6);
    expect(p.vy).toBeCloseTo(3);
    expect(p.color).toBe(0xffffff);
    expect(p.life).toBeCloseTo(0.2);
    expect(p.radius).toBeCloseTo(2);
  });
  it('the same random sequence makes the same effect', () => {
    const run = () => {
      const fx = new ParticleFx(new Container(), { entities: new Map(), playerId: 1, triggerScreenShake: () => {} } as never);
      let s = 12345;
      vi.spyOn(Math, 'random').mockImplementation(() => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
      fx.showEffect(EffectType.Explosion, 5, 6, [120]);
      return JSON.stringify(parts(fx).map((x) => [x.vx, x.vy, x.life, x.color, x.radius]));
    };
    expect(run()).toBe(run());
  });
});
