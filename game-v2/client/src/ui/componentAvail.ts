/**
 * What a component means for this pilot, shared by the component guide (side panel) and the hangar palette (no DOM):
 * whether it's open (componentGuide.ts rowGates), the short "Reach level N" a locked one shows, how a category tab
 * counts, what making it costs against what you have, and (the hangar's) whether you can place it now: free build,
 * spares on hand, fabricate, or locked.
 */

import type { Bag } from '@space-game/common';
import { requirementLine, type CompTab, type Gate } from './componentGuide';

/** Open to this pilot: every gate met */
export function isOpen(gates: Gate[]): boolean {
  return requirementLine(gates).met;
}

/**
 * The short lock a row shows ("Reach level 12", "Needs its licence", "Needs Rustjaw's Fang"): its first unmet gate,
 * shortened; '' when it's open
 */
export function lockText(gates: Gate[]): string {
  const g = gates.find((x) => !x.met);
  if (!g) return '';
  if (g.kind === 'level') return g.text.replace(/\s*\(you're \d+\)$/, '');
  if (g.kind === 'licence') return 'Needs its licence';
  if (g.kind === 'part') return g.text.split(':')[0];
  return g.text;
}

/** The level a locked row waits on (null: not a level, or it's open) */
export function lockLevel(gates: Gate[]): number | null {
  const g = gates.find((x) => !x.met && x.kind === 'level');
  const m = g?.text.match(/level (\d+)/);
  return m ? Number(m[1]) : null;
}

/** A row list split into what's open (first) and what's locked, each keeping its order */
export function splitOpen<T>(rows: readonly T[], open: (r: T) => boolean): { open: T[]; locked: T[] } {
  const out = { open: [] as T[], locked: [] as T[] };
  for (const r of rows) (open(r) ? out.open : out.locked).push(r);
  return out;
}

/** Each tab's open and total counts (the tab badges) */
export function tabCounts<T extends { tab: CompTab }>(rows: readonly T[], tabs: readonly { id: CompTab }[], open: (r: T) => boolean): Map<CompTab, { open: number; total: number }> {
  const out = new Map(tabs.map((t) => [t.id, { open: 0, total: 0 }]));
  for (const r of rows) {
    const c = out.get(r.tab);
    if (!c) continue;
    c.total++;
    if (open(r)) c.open++;
  }
  return out;
}

/** One input of a cost, against what the pilot has */
export interface CostLine { id: string; n: number; have: number; short: boolean }

export function costLines(bag: Bag, have: (id: string) => number): CostLine[] {
  return Object.entries(bag).map(([id, n]) => {
    const h = have(id);
    return { id, n, have: h, short: h < n };
  });
}

/** You have every input (an empty cost is affordable) */
export function affordable(lines: readonly CostLine[]): boolean {
  return lines.every((l) => !l.short);
}

/**
 * Can it go on a design now, and how: 'free' (free build or proto: anything), 'have' (spares on hand), 'make' (it
 * places as a ghost and gets fabricated), 'locked' (not licensed: its gates say why). `canMake` is the pilot's licence
 * as the server checks it; one on hand still needs it to fit.
 */
export type Avail = 'free' | 'have' | 'make' | 'locked';

export function availability(o: { free: boolean; spare: number; canMake: boolean }): Avail {
  if (o.free) return 'free';
  if (!o.canMake) return 'locked';
  return o.spare > 0 ? 'have' : 'make';
}

/** Sort rank: what you can place first (spares, then fabricate, then free), locked last */
export const AVAIL_RANK: Record<Avail, number> = { have: 0, make: 1, free: 1, locked: 2 };
