// Pins the contract invariants of the weapon modifier layers (fx/mods: index, kit) with a real field and fake textures
import { describe, it, expect, vi } from 'vitest';
import { WeaponType } from '@space-game/common';

vi.mock('../../../fxTextures', async (orig) => {
  const mk = (name: string) => () => ({ name }) as never;
  return {
    ...(await orig<Record<string, unknown>>()),
    disc: mk('disc'), ring: mk('ring'), softDot: mk('dot'), streak: mk('streak'), petal: mk('petal'), puff: mk('puff'), glowBall: mk('ball'),
    petalScale: () => ({ x: 1, y: 1 }),
  };
});

import { Container } from 'pixi.js';
import { FxField } from '../FxField';
import { FRAG_CAP, HIT_CAP, SMOKE_CAP } from '../particleTypes';
import { weaponStyle } from '../../weaponStyles';
import { LAYERS, chainArc, modBeam, modFlight, modFrame, modImpact, modMarkCount, modMuzzle, type ModFx } from './index';
import { CAP_IMPACT, CAP_MUZZLE, EFFECTS, LOOK, MARK_CAP } from './looks';
import tuning from '../../../../../../data/ships/tuning.json';

const names = (tuning as { modifiers: { effects: string[] } }).modifiers.effects;

function field() {
  const f = new FxField(new Container());
  let drawn = 0;
  for (const pool of [f.glow, f.smokeG, f.extraG, f.hitG]) vi.spyOn(pool, 'take').mockImplementation((() => { drawn++; }) as never);
  vi.spyOn(f, 'line').mockImplementation((() => { drawn++; }) as never);
  vi.spyOn(f, 'circle').mockImplementation((() => { drawn++; }) as never);
  return { f, drawn: () => drawn };
}

/** What the layers have put in the field's lists */
const made = (f: FxField): number =>
  f.sparks.length + f.smoke.length + f.hitGlows.length + f.frags.length + f.flares.length + f.scorches.length + f.hitLights.length + modMarkCount(f);

const shot = (fx: readonly ModFx[] | undefined, id = 5) => ({
  id, owner: 1, type: WeaponType.Cannon, spawnX: 0, spawnY: 0, vx: 10, vy: 0, power: 1, size: 1, splash: 0, ended: false, fx,
  style: weaponStyle(WeaponType.Cannon),
}) as never;

/** One shot's whole life through the hooks: its muzzle, some frames of flight, its hit, the frames after */
function life(f: FxField, fx: readonly ModFx[] | undefined, id = 5): void {
  const s = shot(fx, id);
  modMuzzle(f, s, 0, 0, 0, 14);
  for (let i = 0; i < 6; i++) { modFlight(f, s, 20 + i * 10, 0, i * 10, 0, 1, 0, 20, 1, 1, i, 1); modFrame(f, 1); }
  modImpact(f, s, 90, 0, Math.PI, true, 1, 0, 1);
  for (let i = 0; i < 4; i++) modFrame(f, 1);
}

describe('client.weapon-fx.mods', () => {
  it('every effect in tuning modifiers.effects has a layer and a look, with its three shell stages and its beam', () => {
    expect(EFFECTS).toEqual(names);
    for (const name of names) {
      const l = LAYERS[name];
      expect(l, name).toBeDefined();
      expect(LOOK[name], name).toBeDefined();
      expect(typeof l.muzzle, name).toBe('function');
      expect(typeof l.flight, name).toBe('function');
      expect(typeof l.impact, name).toBe('function');
      expect(typeof (l.beam ?? l.beamEnd), name).toBe('function');
    }
  });

  it('adds nothing for a shot with no effects, an effect at strength 0, or an effect it does not know', () => {
    for (const fx of [undefined, [], names.map((_, i) => ({ fx: i, k: 0 })), [{ fx: 99, k: 1 }]]) {
      const { f, drawn } = field();
      life(f, fx);
      chainArc(f, 0, 0, 50, 0, 0);
      expect(made(f)).toBe(0);
      expect(drawn()).toBe(0);
    }
    const g = { moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), circle: vi.fn(), fill: vi.fn(), poly: vi.fn() };
    const self = () => g;
    for (const k of Object.keys(g) as (keyof typeof g)[]) g[k].mockImplementation(self);
    modBeam(g as never, undefined, 0, 0, 100, 0, 6, 1, 0, 1, true);
    modBeam(g as never, names.map((_, i) => ({ fx: i, k: 0 })), 0, 0, 100, 0, 6, 1, 0, 1, true);
    modBeam(g as never, [{ fx: 0, k: 1 }], 0, 0, 100, 0, 6, 0, 0, 1, true);
    for (const k of Object.keys(g) as (keyof typeof g)[]) expect(g[k]).not.toHaveBeenCalled();
  });

  it('every effect adds something at each stage at full strength, and draws on a beam', () => {
    names.forEach((name, i) => {
      const fx = [{ fx: i, k: 1 }];
      const a = field();
      modMuzzle(a.f, shot(fx), 0, 0, 0, 14);
      modFrame(a.f, 1);
      expect(made(a.f) + a.drawn(), `${name} muzzle`).toBeGreaterThan(0);
      const b = field();
      for (let t = 0; t < 8; t++) { modFlight(b.f, shot(fx), 20 + t * 10, 0, t * 10, 0, 1, 0, 20, 1, 1, t, 1); modFrame(b.f, 1); }
      expect(made(b.f) + b.drawn(), `${name} flight`).toBeGreaterThan(0);
      const c = field();
      modImpact(c.f, shot(fx), 90, 0, Math.PI, true, 1, 0, 1);
      modFrame(c.f, 1);
      expect(made(c.f) + c.drawn(), `${name} impact`).toBeGreaterThan(0);
      let calls = 0;
      const g: Record<string, () => unknown> = {};
      for (const k of ['moveTo', 'lineTo', 'stroke', 'circle', 'fill', 'poly', 'quadraticCurveTo', 'bezierCurveTo', 'closePath', 'ellipse', 'arc', 'rect']) g[k] = () => { calls++; return g; };
      modBeam(g as never, fx, 0, 0, 300, 0, 6, 1, 0.4, 1, true);
      expect(calls, `${name} beam`).toBeGreaterThan(0);
    });
  });

  it('a layer grows with strength: more at 1 than at 0.3, never nothing above 0', () => {
    names.forEach((_, i) => {
      const count = (k: number) => { const { f, drawn } = field(); life(f, [{ fx: i, k }]); return made(f) + drawn(); };
      expect(count(0.3)).toBeGreaterThan(0);
      expect(count(1)).toBeGreaterThanOrEqual(count(0.3));
    });
  });

  it('is deterministic: the same shot makes the same particles', () => {
    const run = () => { const { f } = field(); life(f, [{ fx: 0, k: 1 }, { fx: 2, k: 0.6 }, { fx: 6, k: 1 }, { fx: 8, k: 1 }]); return JSON.stringify(f.sparks.map((s) => [s.x, s.y, s.vx, s.vy, s.max])); };
    const rnd = vi.spyOn(Math, 'random');
    expect(run()).toBe(run());
    expect(rnd).not.toHaveBeenCalled();
    rnd.mockRestore();
  });

  it('a shot with four effects stays inside the budget four single effects would have, at the muzzle and at the hit', () => {
    const four = [{ fx: 1, k: 1 }, { fx: 2, k: 1 }, { fx: 7, k: 1 }, { fx: 8, k: 1 }];
    const a = field();
    modMuzzle(a.f, shot(four), 0, 0, 0, 14);
    expect(a.f.sparks.length + a.f.smoke.length + a.f.hitGlows.length + a.f.frags.length + a.f.flares.length).toBeLessThanOrEqual(4 * CAP_MUZZLE[4]);
    const b = field();
    modImpact(b.f, shot(four), 90, 0, Math.PI, true, 1, 0, 1);
    expect(b.f.sparks.length + b.f.smoke.length + b.f.hitGlows.length + b.f.frags.length + b.f.flares.length).toBeLessThanOrEqual(4 * CAP_IMPACT[4]);
    expect(4 * CAP_IMPACT[4]).toBeLessThan(2 * CAP_IMPACT[1] + 1);
  });

  it('a rapid gun with four effects firing every other frame stays under the field caps, and thins as the load climbs', () => {
    const { f } = field();
    const four = [{ fx: 1, k: 1 }, { fx: 2, k: 1 }, { fx: 7, k: 1 }, { fx: 8, k: 1 }];
    let first = 0, last = 0;
    for (let n = 0; n < 200; n++) {
      const before = made(f);
      life(f, four, n + 1);
      if (n === 0) first = made(f) - before;
      if (n === 199) last = made(f) - before;
      // (the field's own drawing ages its lists; here only the caps hold them)
      expect(f.hitGlows.length).toBeLessThanOrEqual(HIT_CAP);
      expect(f.smoke.length).toBeLessThanOrEqual(SMOKE_CAP);
      expect(f.frags.length).toBeLessThanOrEqual(FRAG_CAP);
      expect(f.sparks.length).toBeLessThanOrEqual(HIT_CAP * 2);
      expect(modMarkCount(f)).toBeLessThanOrEqual(MARK_CAP);
    }
    expect(last).toBeLessThanOrEqual(first);
  });
});
