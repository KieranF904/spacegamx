/**
 * The music's choices (musicProfiles.ts, data/audio.json `music`): every system has its own mood, areas and
 * situations vary it, and the director only moves once a change has held (so edges don't thrash).
 */

import { describe, expect, it } from 'vitest';
import audioData from '../../../data/audio.json';
import systemsData from '../../../data/systems.json';
import bossData from '../../../data/bosses.json';
import { MusicDirector, holdFor, mergeProfile, patternHits, pickArea, placeKey, resolveMood, situationKeys, type MusicRegistry } from './musicProfiles';
import { MusicPlaceTracker } from './musicPlace';
import type { StarSystemData } from '@space-game/common';

const REG = (audioData as unknown as { music: MusicRegistry }).music;
const SYSTEMS = (systemsData as unknown as { systems: StarSystemData[] }).systems;
const BOSSES = Object.keys((bossData as unknown as { bosses: Record<string, unknown> }).bosses);

describe('music registry data', () => {
  it('every system has a profile, and every profile resolves to a playable mood', () => {
    for (const s of SYSTEMS) {
      expect(REG.systems[s.id], s.id).toBeDefined();
      const m = resolveMood(REG, { system: s.id });
      expect(m.scale.length, s.id).toBeGreaterThanOrEqual(5);
      expect(m.bar).toBeGreaterThan(2);
      expect(m.progression.every((d) => Number.isInteger(d))).toBe(true);
      for (const p of m.perc ?? []) expect(['kick', 'tom', 'thump', 'clank', 'shaker', 'snare']).toContain(p.kind);
    }
  });

  it('names only real scales, presets, areas and bosses', () => {
    const scales = new Set(Object.keys(REG.scales));
    const check = (p: Record<string, unknown>, where: string) => {
      if (typeof p.scale === 'string') expect(scales.has(p.scale), `${where} scale ${p.scale}`).toBe(true);
      for (const e of [p.extends ?? []].flat() as string[]) expect(!!(REG.presets?.[e] ?? REG.systems[e]), `${where} extends ${e}`).toBe(true);
    };
    for (const [id, p] of Object.entries(REG.systems)) {
      check(p as Record<string, unknown>, id);
      const sys = SYSTEMS.find((s) => s.id === id);
      expect(sys, `${id} is a system`).toBeDefined();
      for (const pl of Object.keys(p.planets ?? {})) expect(sys!.planets?.some((x) => x.id === pl), `${id} planet ${pl}`).toBe(true);
      for (const z of Object.keys(p.zones ?? {})) expect(sys!.zones?.some((x) => x.id === z), `${id} zone ${z}`).toBe(true);
      for (const r of Object.keys(p.regions ?? {})) expect(sys!.regions?.some((x) => x.id === r), `${id} region ${r}`).toBe(true);
      for (const a of [...Object.values(p.planets ?? {}), ...Object.values(p.zones ?? {}), ...Object.values(p.regions ?? {})]) check(a as Record<string, unknown>, id);
    }
    for (const [k, p] of Object.entries(REG.situations)) {
      check(p as Record<string, unknown>, k);
      const [kind, boss] = k.split(':');
      expect(['docked', 'arena', 'boss']).toContain(kind);
      if (boss) expect(BOSSES, k).toContain(boss);
    }
  });

  it('the systems sound different from each other', () => {
    const sig = (id: string) => {
      const m = resolveMood(REG, { system: id });
      return JSON.stringify([m.root, m.scale, m.bar, m.pad, m.bellTone, m.perc?.map((p) => p.kind), Object.keys(m.noise).filter((k) => m.noise[k as 'wind']), !!m.arp]);
    };
    const main = ['sol', 'ashfall', 'borealis', 'nebula_prime', 'void_sector', 'cinder_reach', 'the_maw', 'glasswater'];
    expect(new Set(main.map(sig)).size).toBe(main.length);
  });

  it("Sol keeps its character: D major, its progression, a nine-second bar, warm sawtooth pads and bells", () => {
    const m = resolveMood(REG, { system: 'sol' });
    expect(m).toMatchObject({ root: 50, progression: [0, 4, 5, 3], bar: 9, pad: 'sawtooth', brightness: 900, bells: 2.2, bellOctave: 2, bellTone: 'bell', perc: null, bass: null });
    expect(m.scale).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });

  it('the named bosses have their own fight music', () => {
    for (const b of ['boss_scrap_mother', 'boss_pyreclast', 'boss_maw_heart']) {
      const sys = (bossData as unknown as { bosses: Record<string, { system: string }> }).bosses[b].system;
      const calm = resolveMood(REG, { system: sys }), fight = resolveMood(REG, { system: sys, boss: b });
      expect(fight.perc, b).not.toBeNull();
      expect(JSON.stringify(fight), b).not.toBe(JSON.stringify(calm));
      expect(fight.dreadScale).toBeLessThan(1);
    }
  });
});

describe('profile resolution', () => {
  const reg: MusicRegistry = {
    scales: { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] },
    defaults: { root: 50, bar: 9, bells: 2, brightness: 900 },
    presets: { drums: { perc: [{ kind: 'tom', pattern: 'x...', level: 0.5 }] } },
    systems: {
      a: { root: 45, scale: 'minor', noise: { wind: 0.3 }, planets: { p1: { bells: 4 } }, zones: { z1: { extends: 'drums', mul: { brightness: 0.5 } } } },
      b: { extends: ['a', 'drums'], bar: 7 },
    },
    situations: { docked: { perc: null, mul: { bells: 0.5 } }, boss: { bar: 6 }, 'boss:x': { root: 40 }, arena: { noise: { rumble: 0.2 } } },
  };

  it('lays layers in order: defaults, system (and what it extends), area, situation', () => {
    expect(resolveMood(reg, { system: 'a' })).toMatchObject({ root: 45, bar: 9, scale: [0, 2, 3, 5, 7, 8, 10] });
    expect(resolveMood(reg, { system: 'b' })).toMatchObject({ root: 45, bar: 7 });
    expect(resolveMood(reg, { system: 'b' }).perc?.[0].kind).toBe('tom');
    expect(resolveMood(reg, { system: 'a', planet: 'p1' }).bells).toBe(4);
    const z = resolveMood(reg, { system: 'a', zone: 'z1' });
    expect(z.brightness).toBe(450);
    expect(z.perc?.length).toBe(1);
    expect(resolveMood(reg, { system: 'unknown' })).toMatchObject({ root: 50, bar: 9 });
  });

  it('null takes a layer out, mul scales, textures merge', () => {
    const d = resolveMood(reg, { system: 'b', docked: true });
    expect(d.perc).toBeNull();
    expect(d.bells).toBe(1);
    expect(resolveMood(reg, { system: 'a', arena: 'x' }).noise).toEqual({ wind: 0.3, rumble: 0.2 });
    expect(mergeProfile({ noise: { wind: 1 } }, { noise: null as never }).noise).toBeNull();
  });

  it('a boss fight wins over its arena, the arena over docking', () => {
    expect(situationKeys({ system: 'a', boss: 'x', arena: 'x', docked: true })).toEqual(['boss', 'boss:x']);
    expect(situationKeys({ system: 'a', arena: 'x', docked: true })).toEqual(['arena', 'arena:x']);
    expect(situationKeys({ system: 'a', docked: true })).toEqual(['docked']);
    expect(resolveMood(reg, { system: 'a', boss: 'x' })).toMatchObject({ bar: 6, root: 40 });
  });

  it("a place's key ignores areas with no music of their own", () => {
    expect(placeKey(reg, { system: 'a', planet: 'nowhere', zone: 'z1' })).toBe(placeKey(reg, { system: 'a', zone: 'z1' }));
    expect(placeKey(reg, { system: 'a', planet: 'p1' })).not.toBe(placeKey(reg, { system: 'a' }));
  });

  it('patterns: accents, normals, rests', () => {
    expect(patternHits('x.o.58?', () => 0.2)).toEqual([1.35, 0, 1, 0, 1, 1, 1]);
    expect(patternHits('?', () => 0.9)).toEqual([0]);
  });
});

describe('transitions', () => {
  it('areas: enter inside the inner edge, leave only past the outer one', () => {
    const at = (d: number) => [{ id: 'p', d, enter: 1000, exit: 1500 }];
    expect(pickArea(at(1200), null)).toBeNull();
    expect(pickArea(at(900), null)).toBe('p');
    expect(pickArea(at(1400), 'p')).toBe('p');
    expect(pickArea(at(1600), 'p')).toBeNull();
    // The nearest of two (by its own reach)
    expect(pickArea([{ id: 'a', d: 800, enter: 1000, exit: 1500 }, { id: 'b', d: 500, enter: 4000, exit: 5000 }], null)).toBe('b');
  });

  it('holds: a jump moves at once, a fight starts quickly and ends slowly', () => {
    expect(holdFor(null, { system: 'a' })).toBe(0);
    expect(holdFor({ system: 'a' }, { system: 'b' })).toBe(0);
    expect(holdFor({ system: 'a' }, { system: 'a', boss: 'x' })).toBeLessThan(1000);
    expect(holdFor({ system: 'a', boss: 'x' }, { system: 'a' })).toBeGreaterThan(4000);
    expect(holdFor({ system: 'a' }, { system: 'a', zone: 'z' })).toBeGreaterThan(1000);
  });

  it("the director moves only once a change has held, and a flicker at an edge doesn't move it", () => {
    const reg: MusicRegistry = { scales: {}, defaults: {}, systems: { a: { zones: { z: { bar: 5 } } } }, situations: { boss: {} } };
    const d = new MusicDirector(reg);
    expect(d.update({ system: 'a' }, 0)).toEqual({ system: 'a' });
    expect(d.update({ system: 'a' }, 100)).toBeNull();
    // In and out of the zone, faster than its hold: nothing
    for (let t = 200; t < 5000; t += 400) expect(d.update({ system: 'a', zone: t % 800 < 400 ? 'z' : null }, t)).toBeNull();
    // In it for good: it moves after the hold
    expect(d.update({ system: 'a', zone: 'z' }, 6000)).toBeNull();
    expect(d.update({ system: 'a', zone: 'z' }, 8600)?.zone).toBe('z');
    // A boss: quickly; gone for a moment (bar flicker): stays; gone for good: leaves
    expect(d.update({ system: 'a', zone: 'z', boss: 'x' }, 9000)).toBeNull();
    expect(d.update({ system: 'a', zone: 'z', boss: 'x' }, 9800)?.boss).toBe('x');
    expect(d.update({ system: 'a', zone: 'z' }, 10000)).toBeNull();
    expect(d.update({ system: 'a', zone: 'z', boss: 'x' }, 11000)).toBeNull();
    expect(d.update({ system: 'a', zone: 'z' }, 12000)).toBeNull();
    expect(d.update({ system: 'a', zone: 'z' }, 18500)).toEqual({ system: 'a', zone: 'z' });
  });

  it('the place tracker finds the arena, with a margin to leave it', () => {
    const sys = SYSTEMS.find((s) => s.id === 'sol_scrap_nest')!;
    const t = new MusicPlaceTracker();
    const a = sys.arena!;
    const base = { systemId: sys.id, sys, tick: 0, docked: false, boss: null };
    expect(t.update({ ...base, x: a.centre.x, y: a.centre.y }).arena).toBe('boss_scrap_mother');
    // Just past the chamber's edge (away from the barrier): still in; well past: out
    const dir = a.barrier ? -1 : 1;
    expect(t.update({ ...base, x: a.centre.x, y: a.centre.y + dir * (a.radius + 300) }).arena).toBe('boss_scrap_mother');
    expect(t.update({ ...base, x: a.centre.x, y: a.centre.y + dir * (a.radius + 3000) }).arena).toBeUndefined();
  });

  it("the place tracker finds Sol's zones and regions", () => {
    const sol = SYSTEMS.find((s) => s.id === 'sol')!;
    const t = new MusicPlaceTracker();
    const base = { systemId: 'sol', sys: sol, tick: 0, docked: false, boss: null };
    const lanes = sol.zones!.find((z) => z.id === 'lanes')!;
    const p = t.update({ ...base, x: (lanes.inner + lanes.outer) / 2, y: 0 });
    expect(p.zone).toBe('lanes');
    expect(p.region).toBe('middle');
    // Just out past the lanes' outer edge: still in them (the margin)
    expect(t.update({ ...base, x: lanes.outer + 1000, y: 0 }).zone).toBe('lanes');
  });
});
