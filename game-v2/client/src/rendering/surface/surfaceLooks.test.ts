import { describe, expect, it } from 'vitest';
import systems from '../../../../data/systems.json';
import { BY_SURFACE, hexRgb, lookFor, lookOf, lookUniforms, nightShade } from './surfaceLooks';
import { groundFrag } from './groundShader';

const list = (Array.isArray(systems) ? systems : (systems as { systems?: unknown[] }).systems ?? Object.values(systems)) as { id: string; surface?: { kind: string } }[];
const surfaces = list.filter((s) => s.surface);

describe('surface looks', () => {
  it('names only surfaces that exist', () => {
    const ids = new Set(surfaces.map((s) => s.id));
    for (const id of Object.keys(BY_SURFACE)) expect(ids.has(id), id).toBe(true);
  });

  it('gives every surface a look whose uniforms the ground shader declares', () => {
    for (const s of surfaces) {
      const u = lookUniforms(lookFor({ kind: s.surface!.kind as never, id: s.id }));
      for (const [name, v] of Object.entries(u)) {
        expect(groundFrag, name).toMatch(new RegExp(`uniform\\s+\\w+\\s+${name};`));
        for (const x of [v].flat()) expect(Number.isFinite(x), `${s.id} ${name}`).toBe(true);
      }
    }
  });

  it('keeps the classic palette for the dev toggle', () => {
    const now = lookOf({ kind: 'terran', id: 'terra_nova_surface' }, false), before = lookOf({ kind: 'terran', id: 'terra_nova_surface' }, true);
    expect(before.low).toBe(0x5b8a3e);
    expect(now.fields).toBe(1);
    expect(before.cloudTint).toBe(0xffffff);
  });

  it('passes through a warm dusk to the night of each world', () => {
    const l = lookFor({ kind: 'rocky', id: 'selene_siege' });
    expect(nightShade(l, 0).ground).toEqual([1, 1, 1]);
    nightShade(l, 1).ground.forEach((v, i) => expect(v).toBeCloseTo(hexRgb(l.nightTint)[i]));
    const dusk = nightShade(l, 0.45);
    expect(dusk.ground[0]).toBeGreaterThan(dusk.ground[2] + 0.1);
    expect(dusk.sun[0]).toBeGreaterThan(dusk.sun[2]);
    // the lighting's night is darker than the ground's (headlights and lamps carry it)
    expect(nightShade(l, 1).ambient[1]).toBeLessThan(nightShade(l, 1).ground[1]);
    for (const s of surfaces) for (const n of [0, 0.3, 0.7, 1]) for (const v of Object.values(nightShade(lookFor({ kind: s.surface!.kind as never, id: s.id }), n)).flat()) expect(Number.isFinite(v)).toBe(true);
  });
});
