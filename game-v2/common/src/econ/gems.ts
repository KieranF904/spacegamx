/**
 * Cut gems (data/gems.json): socketed into a weapon part, a gem changes how
 * that gun fires: its level's WeaponMods (ships/types.ts), which ride the
 * blueprint so both sides fire the same shells. How many sockets a part has
 * comes from its material's grade and its size; the server alone sets a
 * part's gems and works out its mods from them.
 */

import type { Catalog } from '../ships/catalog.js';
import type { PlacedPart, WeaponMods } from '../ships/types.js';
import { partGrade } from '../ships/grades.js';
import type { Bag } from './stacks.js';

export interface GemLevel { summary: string; mods: WeaponMods }
export interface GemType { name: string; color: string; material: string; levels: Record<string, GemLevel> }
export interface GemsFile {
  sockets: { byGrade: [number, number][]; levelByGrade: number[]; largeArea: number; legendary: [number, number] };
  cuts: Record<string, { inputs: Bag; seconds: number; fail: number }>;
  types: Record<string, GemType>;
}

export function gemItemId(type: string, level: number): string {
  return `gem_${type}_${level}`;
}

export function parseGemItemId(id: string): { type: string; level: number } | null {
  const m = /^gem_([a-z_]+)_(\d)$/.exec(id);
  return m ? { type: m[1], level: Number(m[2]) } : null;
}

/** How many sockets a weapon part has for a pilot of this level (0 for anything but a weapon) */
export function socketsFor(gems: GemsFile, catalog: Catalog, p: { fn: string; material: string; piece: string }, level: number): number {
  const fn = catalog.functions.get(p.fn);
  if (!fn?.weapon) return 0;
  const area = catalog.variants.get(p.piece)?.[0]?.area ?? 1;
  const large = area >= gems.sockets.largeArea ? 1 : 0;
  if (fn.rarity === 'legendary') return gems.sockets.legendary[large];
  // (Its grade: its material's, or a model's tier)
  const grade = partGrade(catalog, p);
  if (level < (gems.sockets.levelByGrade[grade] ?? 0)) return 0;
  return gems.sockets.byGrade[grade]?.[large] ?? 0;
}

/** What a set of socketed gems makes of a gun: their mods together (numbers add up; effects, the last one's) */
export function gemMods(gems: GemsFile, ids: string[] | undefined): WeaponMods | undefined {
  if (!ids?.length) return undefined;
  const out: { mul: Record<string, number>; add: Record<string, number>; set: Record<string, unknown> } = { mul: {}, add: {}, set: {} };
  for (const id of ids) {
    const g = parseGemItemId(id);
    const m = g && gems.types[g.type]?.levels[String(g.level)]?.mods;
    if (!m) continue;
    for (const [k, v] of Object.entries(m.mul ?? {})) out.mul[k] = (out.mul[k] ?? 0) + (v ?? 0);
    for (const [k, v] of Object.entries(m.add ?? {})) out.add[k] = (out.add[k] ?? 0) + (v ?? 0);
    Object.assign(out.set, m.set ?? {});
  }
  const mods: WeaponMods = {};
  if (Object.keys(out.mul).length) mods.mul = out.mul;
  if (Object.keys(out.add).length) mods.add = out.add;
  if (Object.keys(out.set).length) mods.set = out.set;
  return Object.keys(mods).length ? mods : undefined;
}

/** What cutting a gem takes: the level's inputs, plus a level 2+ gem's own material */
export function cutInputs(gems: GemsFile, type: string, level: number): Bag | null {
  const cut = gems.cuts[String(level)], t = gems.types[type];
  if (!cut || !t?.levels[String(level)]) return null;
  return level >= 2 ? { ...cut.inputs, [t.material]: (cut.inputs[t.material] ?? 0) + 1 } : { ...cut.inputs };
}

/** A part's gems and mods agree (the mods come from the gems) */
export function setPartGems(gems: GemsFile, p: PlacedPart, ids: string[]): void {
  if (ids.length) p.gems = ids; else delete p.gems;
  const mods = gemMods(gems, ids);
  if (mods) p.mods = mods; else delete p.mods;
}
