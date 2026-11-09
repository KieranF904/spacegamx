/**
 * @contract client.ui.resource-levels
 * owns:       the one rule for "from what pilot level can you use this" for every guide entry (resource, rock, enemy, system), the sort by that level, and the locked test against a player's level
 * needs:      common/ (GRADE_LEVEL, MATERIAL_LEVEL), the GameData shape (type only) and the source index (no I/O, no DOM)
 * invariants: a system opens at GRADE_LEVEL[its grade] (data/factions.json spawns grade, else its danger capped at 5); a rock and an enemy at the lowest level of the systems they are in — client/src/ui/resources/levels.test.ts
 *             a resource opens at the highest of its recipe `level` and its structure material's MATERIAL_LEVEL; with neither, at the lowest level of the systems it comes from, else the highest level of a recipe's inputs — client/src/ui/resources/levels.test.ts
 *             level 1 or less is no gate (undefined); a tile is locked only when it has a gate above the player's level — client/src/ui/resources/levels.test.ts
 * extend:     a new kind of gate is one more step in itemLevel below
 */

import { GRADE_LEVEL, MATERIAL_LEVEL } from '@space-game/common';
import type { GameData } from './resourceIndex';
import type { SourceIndex } from './sourceIndex';

export type LevelView = 'res' | 'rock' | 'enemy' | 'sys';
/** Level by entry id, per view; an entry with no gate is absent */
export interface LevelIndex { res: Map<string, number>; rock: Map<string, number>; enemy: Map<string, number>; sys: Map<string, number> }

/** A level of 1 or less gates nothing (every pilot starts at 1) */
const gate = (n: number | undefined): number | undefined => (n !== undefined && n > 1 ? n : undefined);
const min = (a: number[]): number | undefined => (a.length ? Math.min(...a) : undefined);
const max = (a: number[]): number | undefined => (a.length ? Math.max(...a) : undefined);

/** The level a system opens at: its grade's level (GRADE_LEVEL) */
export function systemLevel(d: GameData, id: string): number | undefined {
  const s = d.systems.find((x) => x.id === id);
  if (!s) return undefined;
  const grade = d.spawns?.[id]?.grade ?? Math.min(s.danger, GRADE_LEVEL.length - 1);
  return gate(GRADE_LEVEL[Math.max(0, Math.min(grade, GRADE_LEVEL.length - 1))]);
}

export function buildLevels(d: GameData, ix: SourceIndex): LevelIndex {
  const sys = new Map<string, number>();
  for (const s of ix.systems) { const l = systemLevel(d, s.id); if (l !== undefined) sys.set(s.id, l); }
  const sysLevel = (id: string) => sys.get(id) ?? 0;

  const rock = new Map<string, number>();
  for (const r of ix.rocks) { const l = gate(min(r.systems.map((p) => sysLevel(p.id)))); if (l !== undefined) rock.set(r.id, l); }
  const enemy = new Map<string, number>();
  for (const e of ix.enemies) { const l = gate(min(e.systemIds.map(sysLevel))); if (l !== undefined) enemy.set(e.id, l); }

  // item -> the material whose plate it is (recipes.json parts.plates)
  const plateOf = new Map(Object.entries(d.recipes.parts.plates ?? {}).map(([mat, item]) => [item, mat]));
  const memo = new Map<string, number | undefined>();
  const visiting = new Set<string>();
  const itemLevel = (id: string): number | undefined => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return undefined;
    visiting.add(id);
    const explicit: number[] = [];
    for (const r of d.recipes.refining) if (r.id === id && r.level !== undefined) explicit.push(r.level);
    for (const r of d.recipes.craft) if (id in r.out && r.level !== undefined) explicit.push(r.level);
    const mat = plateOf.get(id);
    if (mat !== undefined && MATERIAL_LEVEL[mat] !== undefined) explicit.push(MATERIAL_LEVEL[mat]);
    let out = max(explicit);
    if (out === undefined) {
      const found = ix.columns.get(id)?.systems ?? [];
      out = found.length ? min(found.map((s) => sysLevel(s.id))) : undefined;
    }
    if (out === undefined) {
      // made only from other things: as high as the dearest input of its easiest recipe
      const rec = [...d.recipes.refining.filter((r) => r.id === id).map((r) => r.inputs), ...d.recipes.craft.filter((r) => id in r.out).map((r) => r.inputs)];
      out = min(rec.map((inputs) => max(Object.keys(inputs).map((i) => itemLevel(i) ?? 0)) ?? 0));
    }
    visiting.delete(id);
    const g = gate(out);
    memo.set(id, g);
    return g;
  };
  const res = new Map<string, number>();
  for (const it of d.items) { const l = itemLevel(it.id); if (l !== undefined) res.set(it.id, l); }
  return { res, rock, enemy, sys };
}

/** The level an entry opens at, or undefined for no gate */
export function levelOf(ix: LevelIndex, view: LevelView, id: string): number | undefined {
  return ix[view].get(id);
}

/** Can this pilot not use it yet: it has a gate above their level (no level known: nothing is locked) */
export function isLocked(level: number | undefined, player: number | undefined): boolean {
  return level !== undefined && player !== undefined && level > player;
}

/** Entries by level ascending, then name (an entry with no gate counts as level 0) */
export function sortByLevel<T>(items: T[], levelFor: (t: T) => number | undefined, nameFor: (t: T) => string): T[] {
  return [...items].sort((a, b) => (levelFor(a) ?? 0) - (levelFor(b) ?? 0) || nameFor(a).localeCompare(nameFor(b)));
}
