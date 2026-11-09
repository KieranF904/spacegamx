/**
 * @contract client.ui.resource-tiers
 * owns:       the guide's coarse Low / Medium / High tiers for drop chances and rock yield shares (the guide never shows a percentage), and the one table of thresholds
 * needs:      nothing (pure)
 * invariants: a value maps to the highest tier whose floor it reaches; tiers only ever go Low, Medium, High — client/src/ui/resources/sourceIndex.test.ts
 * extend:     retune a threshold in TIER_FLOORS; a new measured thing is one more row there
 */

export type Tier = 'low' | 'medium' | 'high';
export const TIER_LABEL: Record<Tier, string> = { low: 'Low', medium: 'Medium', high: 'High' };
/** Pips drawn on an icon: 1 to 3 */
export const TIER_PIPS: Record<Tier, number> = { low: 1, medium: 2, high: 3 };

/**
 * The thresholds, one row per measure: the lowest value that counts as Medium and as High.
 * drop: a 0..1 drop chance. rock: a share of a rock's ore, 0..1 (its weight over the rock's total).
 */
export const TIER_FLOORS: Record<'drop' | 'rock', { medium: number; high: number }> = {
  drop: { medium: 0.1, high: 0.4 },
  rock: { medium: 0.15, high: 0.4 },
};

export function tierOf(measure: keyof typeof TIER_FLOORS, value: number): Tier {
  const f = TIER_FLOORS[measure];
  return value >= f.high ? 'high' : value >= f.medium ? 'medium' : 'low';
}
