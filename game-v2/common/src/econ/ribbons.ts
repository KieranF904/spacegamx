/**
 * Ribbons (data/achievements.json), weekly rankings and the hunted boss: the
 * rules both sides need, so the client shows exactly what the server counts.
 */

export interface RibbonDef {
  id: string;
  name: string;
  icon: string;
  /** A profile stat, or 'level' (pilot level) or 'systems' (star systems visited) */
  stat: string;
  at: number;
  description: string;
  reward: { credits?: number; xp?: number };
  /** Announced to the whole galaxy */
  rare?: boolean;
}

export interface RibbonsFile {
  ribbons: RibbonDef[];
}

/** Where a pilot stands on a ribbon's stat */
export function ribbonValue(def: RibbonDef, stats: Record<string, number>, level: number): number {
  if (def.stat === 'level') return level;
  if (def.stat === 'systems') return Object.keys(stats).filter((k) => k.startsWith('sys:')).length;
  return stats[def.stat] ?? 0;
}

/** The stat key that marks a ribbon as earned */
export const ribbonKey = (id: string) => `ach:${id}`;

// ---------------------------------------------------------------------------
// Weeks (rankings, the hunt)
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Weeks start on Monday 00:00 UTC (1970-01-05 was a Monday) */
const EPOCH_MONDAY = 4 * 24 * 60 * 60 * 1000;

export function weekOf(nowMs: number): number {
  return Math.floor((nowMs - EPOCH_MONDAY) / WEEK_MS);
}

/** ms until the week turns */
export function weekEndsIn(nowMs: number): number {
  return WEEK_MS - ((nowMs - EPOCH_MONDAY) % WEEK_MS);
}

/** This week's hunted boss (double rewards): every boss gets its turn */
export function huntedBoss(nowMs: number, bossIds: string[]): string | undefined {
  if (!bossIds.length) return undefined;
  const ids = [...bossIds].sort();
  return ids[((weekOf(nowMs) % ids.length) + ids.length) % ids.length];
}

/** What rankings rank */
export const RANKED: { key: string; label: string }[] = [
  { key: 'earned', label: 'Credits earned' },
  { key: 'kills', label: 'Hostiles destroyed' },
  { key: 'bosses', label: 'Boss kills' },
  { key: 'quests', label: 'Jobs done' },
  { key: 'mined', label: 'Ore mined' },
];
