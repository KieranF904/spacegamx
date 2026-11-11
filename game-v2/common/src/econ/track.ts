/**
 * The unlock track: what each pilot level opens. Models at their unlock level
 * (data/ships/models.json `unlock`), structure materials at MATERIAL_LEVEL,
 * and room (build points, hangar bays, fabricator queue slots: data/unlocks.json).
 * The level-up message and the field guide both read it, so they agree.
 */

import type { FunctionDef } from '../ships/types.js';
import { MATERIAL_LEVEL } from './market.js';
import { unlockedAt, unlockTable, UNLOCK_KEYS } from './unlocks.js';
import { LEVEL_CAP } from './levels.js';

export interface TrackStep {
  level: number;
  /** Models learned here, in unlock-then-family order */
  models: FunctionDef[];
  /** Structure materials opened here (ids) */
  materials: string[];
  /** Room opened here ("Build points 75", "Hangar bay 6") */
  capacity: string[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const modelName = (m: FunctionDef) => m.name ?? m.id;

/** "Steel structure" */
export function materialUnlockName(id: string): string {
  return `${cap(id)} structure`;
}

/** Player models a level teaches (the boss legendaries too: their level opens them, their artefact makes them) */
function levelModels(fns: Iterable<FunctionDef>): FunctionDef[] {
  return [...fns].filter((f) => f.model && f.unlock && f.unlock.level > 0);
}

/** Every level from `from` to `to` that opens something, in order */
export function unlockTrack(fns: Iterable<FunctionDef>, from = 1, to = LEVEL_CAP): TrackStep[] {
  const steps = new Map<number, TrackStep>();
  const at = (level: number) => {
    let s = steps.get(level);
    if (!s) steps.set(level, (s = { level, models: [], materials: [], capacity: [] }));
    return s;
  };
  const inRange = (l: number) => l >= from && l <= to;
  for (const m of levelModels(fns)) if (inRange(m.unlock!.level)) at(m.unlock!.level).models.push(m);
  for (const [id, l] of Object.entries(MATERIAL_LEVEL)) if (l > 0 && inRange(l)) at(l).materials.push(id);
  const t = unlockTable();
  const room = new Set(UNLOCK_KEYS.flatMap((k) => Object.keys(t[k].levels ?? {}).map(Number)).filter(inRange));
  for (const l of room) at(l).capacity.push(...unlockedAt(l));
  for (const s of steps.values()) s.models.sort((a, b) => (a.family ?? '').localeCompare(b.family ?? '') || modelName(a).localeCompare(modelName(b)));
  return [...steps.values()].sort((a, b) => a.level - b.level);
}

/** What reaching a level opens, by name: models, then materials, then room */
export function levelUnlockNames(fns: Iterable<FunctionDef>, level: number): string[] {
  const s = unlockTrack(fns, level, level)[0];
  return s ? [...s.models.map(modelName), ...s.materials.map(materialUnlockName), ...s.capacity] : [];
}

/**
 * The next level past `level` that teaches something to build (a model or a
 * material), and what: the hint under a level-up ("Next: Twinlink at Lv 12")
 */
export function nextBuildUnlock(fns: Iterable<FunctionDef>, level: number): { level: number; names: string[] } | null {
  const s = unlockTrack(fns, level + 1).find((x) => x.models.length || x.materials.length);
  return s ? { level: s.level, names: [...s.models.map(modelName), ...s.materials.map(materialUnlockName)] } : null;
}

/** "Twinlink at Lv 12", "Needle and Siphon at Lv 13", "Torch, Jump Coil and 2 more at Lv 14" */
export function nextUnlockHint(fns: Iterable<FunctionDef>, level: number): string | null {
  const n = nextBuildUnlock(fns, level);
  if (!n) return null;
  const list = n.names.length > 3 ? [...n.names.slice(0, 2), `${n.names.length - 2} more`] : n.names;
  const said = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
  return `${said} at Lv ${n.level}`;
}
