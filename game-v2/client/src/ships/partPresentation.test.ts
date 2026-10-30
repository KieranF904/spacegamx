/**
 * Every part function in data/ships/functions.json and every model (models.json) carries its presentation
 * (name, rarity, description, fabricator category, colour, decor shape), the
 * shape it names exists in partDecor, and its sounds exist.
 */

import { describe, expect, it } from 'vitest';
import shipFunctions from '../../../data/ships/functions.json';
import shipModels from '../../../data/ships/models.json';
import systemsData from '../../../data/systems.json';
import { DECOR_SHAPES } from './partDecor';
import { RARITIES, WEAPON_KIND_TYPE, type FunctionDef } from '@space-game/common';
import sfxIndex from '../../public/sfx/index.json';
import { SFX_VARIANTS } from '../audio/sfx';

const fns = [...(shipFunctions as unknown as { functions: FunctionDef[] }).functions, ...(shipModels as unknown as { models: FunctionDef[] }).models];
/** What a pilot is shown (the legacy functions models replaced aren't) */
const shown = fns.filter((f) => !f.legacy);
const CATEGORIES = ['weapons', 'power', 'engines', 'shields', 'utility', 'core', 'structure'];
const SOUNDS = { ...Object.fromEntries(Object.keys(SFX_VARIANTS).map((id) => [id, { variants: SFX_VARIANTS[id], loop: false }])), ...(sfxIndex as Record<string, { variants: number; loop?: boolean }>) };

describe('part presentation data', () => {
  it.each(fns.map((f) => [f.id, f] as const))('%s has its presentation fields', (_id, f) => {
    expect(typeof f.name).toBe('string');
    expect(f.name!.length).toBeGreaterThan(0);
    // (The game's own ships' parts are never items nor fabricated: no rarity, tab or place in one)
    if (!f.exclusive) expect(RARITIES).toContain(f.rarity);
    expect(typeof f.description).toBe('string');
    expect(f.description!.length).toBeGreaterThan(0);
    if (!f.exclusive) expect(CATEGORIES).toContain(f.category);
    if (!f.exclusive && f.category !== 'structure') expect(typeof f.fabOrder).toBe('number');
    expect(f.color).toMatch(/^#[0-9a-f]{6}$/);
    if (f.glow !== undefined) expect(f.glow).toMatch(/^#[0-9a-f]{6}$/);
    expect(Object.keys(DECOR_SHAPES)).toContain(f.decor);
    // Weapons draw a gun; nothing else does
    expect(DECOR_SHAPES[f.decor as keyof typeof DECOR_SHAPES] === 'weapon').toBe(!!f.weapon);
    for (const s of [f.sfx, f.sfxTurret]) if (s !== undefined) expect(SOUNDS[s]?.loop, `sound ${s}`).toBe(false);
    if (f.sfxLoop !== undefined) expect(SOUNDS[f.sfxLoop]?.loop, `loop ${f.sfxLoop}`).toBe(true);
    // A projectile weapon (one with a wire type) has a shot sound
    if (f.weapon && WEAPON_KIND_TYPE[f.weapon] !== undefined) expect(f.sfx).toBeTruthy();
    if (f.guide) {
      expect(f.guide.name.length).toBeGreaterThan(0);
      expect(f.guide.blurb.length).toBeGreaterThan(0);
      expect(typeof f.guide.order).toBe('number');
    }
  });

  it('fabricator and field guide orders are unique', () => {
    for (const c of CATEGORIES.filter((c) => c !== 'structure')) {
      const orders = shown.filter((f) => f.category === c).map((f) => f.fabOrder);
      expect(new Set(orders).size, c).toBe(orders.length);
    }
    const guide = shown.filter((f) => f.guide).map((f) => f.guide!.order);
    expect(new Set(guide).size).toBe(guide.length);
  });

  it('system music moods are well formed', () => {
    const systems = (systemsData as unknown as { systems: { id: string; visuals?: { music?: Record<string, unknown> } }[] }).systems;
    const withMusic = systems.filter((s) => s.visuals?.music);
    expect(withMusic.map((s) => s.id)).toContain('sol');
    for (const s of withMusic) {
      const m = s.visuals!.music!;
      for (const k of ['root', 'bar', 'brightness', 'bells', 'bellOctave']) expect(typeof m[k], `${s.id}.${k}`).toBe('number');
      expect(Array.isArray(m.progression)).toBe(true);
      expect(['major', 'lydian', 'dorian', 'aeolian', 'phrygian']).toContain(m.scale);
    }
  });
});
