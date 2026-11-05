/**
 * Every part function in data/ships/functions.json and every model (models.json) carries its presentation
 * (name, rarity, description, fabricator category, colour, decor shape), the
 * shape it names exists in partDecor, and its sounds exist.
 */

import { describe, expect, it } from 'vitest';
import shipFunctions from '../../../data/ships/functions.json';
import shipModels from '../../../data/ships/models.json';
import tuningData from '../../../data/ships/tuning.json';
import { DECOR_SHAPES } from './partDecor';
import { RARITIES, WEAPON_KIND_TYPE, type FunctionDef } from '@space-game/common';
import sfxIndex from '../../public/sfx/index.json';
import { SFX_VARIANTS } from '../audio/sfx';
import { BEAM_LOOP, KIND_SFX, shotSoundForKind, shotSoundForType } from '../audio/weaponSounds';

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

  it('every part of one weapon kind makes the same sound (a projectile carries only its kind)', () => {
    const byKind = new Map<string, string>();
    for (const f of fns) {
      if (!f.weapon) continue;
      const s = `${f.sfx ?? ''}/${f.sfxTurret ?? ''}`;
      if (f.sfx === undefined) continue;
      expect(byKind.get(f.weapon) ?? s, `${f.id} (${f.weapon})`).toBe(s);
      byKind.set(f.weapon, s);
    }
  });

  it('every weapon kind is heard: a shot sound, a held beam loop, or its own pulses', () => {
    const tuning = (tuningData as unknown as { weapons: Record<string, unknown> }).weapons;
    // Pulse lasers' pulses: ShipClient beamFx.onPulse (laser_pulse); the Lance's own beam: LanceFx
    const ownSound = new Set(['laser']);
    for (const kind of Object.keys(tuning)) {
      const parts = fns.filter((f) => f.weapon === kind);
      const beam = parts.some((f) => (f as { fire?: { model?: string } }).fire?.model === 'beam');
      if (beam) expect(BEAM_LOOP.get(kind), `${kind}: a held beam with no loop`).toBeTruthy();
      if (ownSound.has(kind)) continue;
      const shot = KIND_SFX.get(kind);
      if (kind === 'lance' || kind === 'frostbite' || kind === 'repair') { expect(BEAM_LOOP.get(kind), kind).toBeTruthy(); continue; }
      expect(shot, `${kind}: no shot sound`).toBeDefined();
      if (shot!.sfx) expect(SOUNDS[shot!.sfx], `${kind}: ${shot!.sfx} exists`).toBeDefined();
    }
    // The bosses' own projectiles don't fall back on the plain cannon shot
    for (const k of ['rivet', 'scrap_chunk', 'seam_seeker', 'heart_spark', 'heart_seeker']) expect(shotSoundForType(WEAPON_KIND_TYPE[k], false), k).not.toBe('shot');
  });

  it('weapon families that differ sound different', () => {
    const shot = (k: string) => KIND_SFX.get(k)?.sfx;
    for (const [a, b] of [['cannon', 'autocannon'], ['cannon', 'pulse'], ['emp', 'arc'], ['missile', 'torpedo'], ['missile', 'charge'], ['flak', 'mortar']]) expect(shot(a), `${a} vs ${b}`).not.toBe(shot(b));
    expect(shotSoundForKind('point_defence', true, 'turret_shot')).not.toBe('turret_shot');
  });
});
