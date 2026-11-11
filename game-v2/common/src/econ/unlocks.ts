/**
 * What a pilot has room for: hangar bays, fabricator and refinery queue
 * slots, party size. One place answers it (unlocks(profile)), from a table of
 * what each level adds (data/unlocks.json), so milestones are data. None of it
 * touches a ship's numbers: a ship is what it's built from.
 */

import { stationPerks, type Outpost } from './outpost.js';
import { engineeringSlots } from './quests.js';

export const UNLOCK_KEYS = ['hangarSlots', 'partySize', 'complexity', 'blueprintSlots'] as const;
export type UnlockKey = typeof UNLOCK_KEYS[number];
export type Unlocks = Record<UnlockKey, number>;

export interface UnlockDef {
  /** What every pilot starts with */
  base: number;
  /** What a level adds (level → extra), e.g. { "15": 1 } */
  levels?: Record<string, number>;
  /** Named in the level-up message: "Hangar bay" */
  label: string;
}
export type UnlockTable = Record<UnlockKey, UnlockDef>;

/** Until data/unlocks.json is loaded (and what it falls back to) */
export const DEFAULT_UNLOCKS: UnlockTable = {
  hangarSlots: { base: 5, label: 'Hangar bay' },
  partySize: { base: 4, label: 'Party place' },
  complexity: { base: 255, label: 'Ship complexity' },
  blueprintSlots: { base: 10, label: 'Design slot' },
};

let table: UnlockTable = DEFAULT_UNLOCKS;

/** The milestone table (server: from GameData; client: at start) */
export function setUnlockTable(t: Partial<UnlockTable> | undefined): void {
  table = { ...DEFAULT_UNLOCKS };
  for (const k of UNLOCK_KEYS) if (t?.[k]) table[k] = { ...DEFAULT_UNLOCKS[k], ...t[k] };
}

export function unlockTable(): UnlockTable {
  return table;
}

/** What a pilot of this level has (engineering skill points still add fabricator slots: one per two; their station's tracks add more) */
export function unlocks(p: { level: number; skills?: Record<string, number>; outpost?: Outpost }): Unlocks {
  const out = {} as Unlocks;
  for (const k of UNLOCK_KEYS) {
    let n = table[k].base;
    for (const [lv, add] of Object.entries(table[k].levels ?? {})) if (p.level >= Number(lv)) n += add;
    out[k] = n;
  }
  if (p.outpost) {
    const s = stationPerks(p.outpost);
    out.hangarSlots += s.hangarSlots;
  }
  return out;
}

/** The next `n` levels (above `level`) that open something, and what */
function nextUnlocks(level: number, n = 5): { level: number; what: string[] }[] {
  const levels = new Set<number>();
  for (const k of UNLOCK_KEYS) for (const lv of Object.keys(table[k].levels ?? {})) if (Number(lv) > level) levels.add(Number(lv));
  return [...levels].sort((a, b) => a - b).slice(0, n).map((lv) => ({ level: lv, what: unlockedAt(lv) }));
}

/** What reaching this level opens ("Hangar bay 4") */
export function unlockedAt(level: number): string[] {
  const out: string[] = [];
  for (const k of UNLOCK_KEYS) {
    const add = table[k].levels?.[String(level)];
    if (!add) continue;
    const n = unlocks({ level })[k];
    out.push(k === 'complexity' ? `${table[k].label} ${n}` : add === 1 ? `${table[k].label} ${n}` : `${add} more ${table[k].label.toLowerCase()}s`);
  }
  return out;
}
