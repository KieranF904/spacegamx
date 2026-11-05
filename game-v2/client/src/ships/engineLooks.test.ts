import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_LOOK, ENGINE_LOOKS, FROST_PAL, SLOTS, engineLookOf, initMote, moteRate, newMote, newNozzleDraw, nozzleDraw, plumeSpec, puffFlicker, stepMote,
  type EngineLook, type NozzleDraw,
} from './engineLooks';
import { SHIELD_LOOKS } from './shieldLooks';

const models = JSON.parse(readFileSync(join(__dirname, '../../../data/ships/models.json'), 'utf-8')) as { models: { id: string; category?: string; glow?: string }[] };
const ENGINES = models.models.filter((m) => m.category === 'engines' && m.id.startsWith('engine_')).map((m) => m.id);
const SHIELDS = ['shield_deflector', 'shield_flicker_screen', 'shield_bulwark_projector', 'shield_flash_screen'];

const draw = (id: string, thr: number, boost: number, time = 1, seed = 0): NozzleDraw => nozzleDraw(newNozzleDraw(), engineLookOf(id), thr, boost, 20, 20, time, seed, 0xa8dcff);
/** What a nozzle shows, coarsely: which slots are on (idle, at full throttle, on boost) and the flame's colours */
const signature = (id: string): string => [0, 1].flatMap((thr) => [0, 1].map((b) => {
  const d = draw(id, thr, b);
  return SLOTS.filter((s) => d[s].on && d[s].alpha > 0).map((s) => `${s}#${d[s].tint.toString(16)}`).join('+') + (d.body.on ? `:${d.pal ? `${d.pal.outer}/${d.pal.shape}` : 'tinted'}` : '');
})).join(' | ');

describe('engine looks', () => {
  it('every engine model in models.json has its own look', () => {
    expect(ENGINES.length).toBeGreaterThanOrEqual(9);
    for (const id of ENGINES) {
      expect(ENGINE_LOOKS[id], id).toBeDefined();
      expect(engineLookOf(id)).toBe(ENGINE_LOOKS[id]);
    }
  });

  it('the looks are distinct: no two models draw the same layers in the same colours', () => {
    const seen = new Map<string, string>();
    for (const id of ENGINES) {
      const sig = signature(id);
      expect(seen.get(sig), `${id} looks like ${seen.get(sig)}: ${sig}`).toBeUndefined();
      seen.set(sig, id);
    }
    // (and none is the plain default)
    for (const id of ENGINES) expect(ENGINE_LOOKS[id]).not.toEqual(DEFAULT_LOOK);
  });

  it('unknown and legacy engines fall back: the default flame, in the ship\'s own colours', () => {
    expect(engineLookOf('nonsense')).toBe(DEFAULT_LOOK);
    expect(engineLookOf(undefined)).toBe(DEFAULT_LOOK);
    expect(engineLookOf('thruster')).toBe(DEFAULT_LOOK);
    for (const fn of ['afterburner', 'plasma_drive']) {
      const l = engineLookOf(fn);
      expect(l.pal, fn).toBeUndefined();
      expect(l.flame).toBe(true);
    }
    expect(engineLookOf('plasma_drive').rings?.mode).toBe('pinch');
  });

  it('the readouts hold for every model: more throttle, a bigger effect; boost grows only engines that boost', () => {
    for (const id of [...ENGINES, 'thruster']) {
      const k = engineLookOf(id);
      if (k.blobs?.mode === 'burst' || k.blobs?.mode === 'flicker') continue; // (puffs and pops blink: checked below)
      const lo = plumeSpec(k, 0.3, 0, 20, 20, 1, 0), hi = plumeSpec(k, 1, 0, 20, 20, 1, 0), bo = plumeSpec(k, 1, 1, 20, 20, 1, 0);
      expect(hi.L, id).toBeGreaterThan(lo.L);
      if (k.boostGain > 0) expect(bo.L, id).toBeGreaterThan(hi.L);
      else expect(bo.L, id).toBeCloseTo(hi.L, 5);
      // (and a cold engine shows no flame)
      expect(draw(id, 0, 0).body.on, id).toBe(false);
      if (k.flame) expect(draw(id, 1, 0).body.alpha, id).toBeGreaterThan(draw(id, 0.3, 0).body.alpha);
    }
    for (const id of ENGINES) expect(moteRate(engineLookOf(id), 1, 0, 20, 20), id).toBeGreaterThan(moteRate(engineLookOf(id), 0.5, 0, 20, 20));
  });

  it('the Torch is a needle that does not grow with boost; the Afterburner roars orange with diamonds and flares hard on boost', () => {
    const at = (id: string, boost: number) => plumeSpec(engineLookOf(id), 1, boost, 20, 20, 1, 0);
    expect(engineLookOf('engine_torch').pal?.shape).toBe('needle');
    expect(at('engine_torch', 1).L).toBeCloseTo(at('engine_torch', 0).L, 5);
    expect(at('engine_afterburner', 1).L).toBeGreaterThan(at('engine_afterburner', 0).L * 2);
    expect(at('engine_afterburner', 0).diamonds).toBeGreaterThan(0);
    expect(at('engine_afterburner', 1).diamonds).toBeGreaterThan(at('engine_afterburner', 0).diamonds);
    expect(at('engine_afterburner', 1).pal?.shape).toBe('cone');
    expect(at('engine_afterburner', 0).pal?.outer).toBe(0xff7a1a);
    expect(draw('engine_afterburner', 1, 1).haze.alpha).toBeGreaterThan(draw('engine_afterburner', 1, 0).haze.alpha);
  });

  it('the Fusion Torch has the longest plume, a wide haze and a lingering trail', () => {
    const len = (id: string) => plumeSpec(engineLookOf(id), 1, 0, 20, 20, 1, 0).L;
    for (const id of ENGINES.filter((i) => i !== 'engine_fusion_torch')) expect(len('engine_fusion_torch'), id).toBeGreaterThan(len(id));
    const f = draw('engine_fusion_torch', 1, 0);
    expect(f.haze.on).toBe(true);
    expect(f.haze.wid).toBeGreaterThan(f.body.wid * 2);
    expect(engineLookOf('engine_fusion_torch').motes.life).toBeGreaterThan(2 * engineLookOf('engine_ion_drive').motes.life);
  });

  it('the Plasma Drive is pinched by rings riding down the stream', () => {
    const a = draw('engine_plasma_drive', 1, 0, 1), b = draw('engine_plasma_drive', 1, 0, 1.2);
    expect(a.ringA.on || a.ringB.on).toBe(true);
    expect(a.ringA.a).not.toBeCloseTo(b.ringA.a, 1);
    expect(a.ringA.len).toBeLessThan(a.ringA.wid);
    expect(engineLookOf('engine_plasma_drive').motes.swirl).toBeGreaterThan(0);
  });

  it('the Reaction Thruster throbs in its own pink, slugs riding out', () => {
    const k = engineLookOf('engine_reaction_thruster');
    expect(k.pal?.outer).toBe(0xe879f9);
    const Ls = [0, 0.05, 0.1, 0.15, 0.2, 0.25].map((t) => plumeSpec(k, 1, 0, 20, 20, t, 0).L);
    expect(Math.max(...Ls) / Math.min(...Ls)).toBeGreaterThan(1.3);
    expect(draw('engine_reaction_thruster', 1, 0).blobA.on).toBe(true);
    expect(k.motes.size).toBeGreaterThan(1.5);
  });

  it('cold gas, sail and strafer: no flame, each its own way', () => {
    // Vernier: puffs blinking on and off
    let on = 0, off = 0;
    for (let t = 0; t < 3; t += 0.01) (draw('engine_vernier', 1, 0, t).blobA.alpha > 0 ? on++ : off++);
    expect(on).toBeGreaterThan(0);
    expect(off).toBeGreaterThan(0);
    for (let t = 0; t < 5; t += 0.07) { const f = puffFlicker(t, 1.3); expect(f).toBeGreaterThanOrEqual(0); expect(f).toBeLessThanOrEqual(1); }
    // Drift Sail: a sheet of light and ripples, faint even at idle
    const s0 = draw('engine_drift_sail', 0, 0), s1 = draw('engine_drift_sail', 1, 0);
    expect(s0.haze.on).toBe(true);
    expect(s1.haze.alpha).toBeGreaterThan(s0.haze.alpha);
    expect(s1.ringA.on || s1.ringB.on).toBe(true);
    // Burst Strafer: pops thrown sideways, opposite ways
    const p = draw('engine_burst_strafer', 1, 0, 0.13);
    expect(Math.sign(p.blobA.s)).toBe(-Math.sign(p.blobB.s));
    expect(Math.abs(p.blobA.s)).toBeGreaterThan(0);
    for (const id of ['engine_vernier', 'engine_drift_sail', 'engine_burst_strafer']) {
      expect(engineLookOf(id).flame, id).toBe(false);
      expect(draw(id, 1, 1).body.on, id).toBe(false);
    }
  });

  it('nozzleDraw reuses what it is given; every layer it turns on is finite and in range', () => {
    const d = newNozzleDraw(), layers = SLOTS.map((s) => d[s]);
    for (const id of [...ENGINES, 'thruster', 'plasma_drive']) {
      for (const [thr, b, fr] of [[0, 0, 0], [0.5, 0, 0], [1, 1, 0], [1, 0, 1]]) {
        for (let t = 0; t < 2; t += 0.13) {
          expect(nozzleDraw(d, engineLookOf(id), thr, b, 14, 20, t, 3.1, 0xa8dcff, fr)).toBe(d);
          for (const s of SLOTS) {
            const l = d[s];
            if (!l.on) continue;
            for (const v of [l.a, l.s, l.len, l.wid, l.alpha]) expect(Number.isFinite(v), `${id} ${s}`).toBe(true);
            expect(l.alpha).toBeLessThanOrEqual(1);
            expect(l.len).toBeGreaterThan(0);
          }
        }
      }
    }
    expect(SLOTS.map((s) => d[s])).toEqual(layers);
  });

  it('motes: swirling ones corkscrew, all of them fade out', () => {
    const go = (k: EngineLook) => {
      const m = initMote(newMote(), k, 1, 0, 20, 20, 0, () => 0.5, 0, 0, 1, 0, 0, 1, 0, 0);
      let maxY = 0, n = 0;
      while (stepMote(m, 1 / 60)) { maxY = Math.max(maxY, Math.abs(m.y)); n++; }
      return { maxY, n };
    };
    expect(go(engineLookOf('engine_plasma_drive')).maxY).toBeGreaterThan(0.5);
    expect(go(engineLookOf('engine_ion_drive')).maxY).toBe(0);
    expect(go(engineLookOf('engine_fusion_torch')).n).toBeGreaterThan(go(engineLookOf('engine_ion_drive')).n * 2);
  });

  it('every shield model has a bubble look, and only the Flash Screen blooms', () => {
    for (const id of SHIELDS) expect(SHIELD_LOOKS[id], id).toBeDefined();
    expect(Object.entries(SHIELD_LOOKS).filter(([, l]) => l.reform).map(([k]) => k)).toEqual(['shield_flash_screen']);
  });

  it('a slowed ship (a Frostbite beam) has short, pale, icy plumes', () => {
    const look = engineLookOf('engine_ion_drive'), warm = plumeSpec(look, 1, 0, 20, 20, 1, 0), cold = plumeSpec(look, 1, 0, 20, 20, 1, 0, 1);
    expect(cold.L).toBeLessThan(warm.L * 0.6);
    expect(cold.pal).toBe(FROST_PAL);
    expect(plumeSpec(look, 1, 0, 20, 20, 1, 0, 0).L).toBe(warm.L);
  });
});
