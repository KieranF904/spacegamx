/**
 * Facts (common ships/features/types.ts Fact) into words. The phrase table
 * lives here, in one place, so every part feature speaks in one voice: a fact
 * is a label and a number with a unit, or a `sentence` the feature authored.
 * Pure text, no markup: callers escape and style.
 */

import type { Fact } from '@space-game/common';

const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');

const UNIT: Record<NonNullable<Fact['unit']>, (v: number) => string> = {
  m: (v) => `${n0(v)} m`,
  s: (v) => `${(Math.round(v * 100) / 100).toString()} s`,
  '%': (v) => `${Math.round(v * 100)}%`,
  power: (v) => `${n0(v)}/s`,
  x: (v) => `×${(Math.round(v * 100) / 100).toString()}`,
};

/** "1,400 m", "×2.2", or the string as it is */
export function factValue(f: Fact): string {
  if (typeof f.value === 'string') return f.value;
  return f.unit ? UNIT[f.unit](f.value) : n0(f.value);
}

/** The facts of one tier set, in the order given */
export function factsOf(facts: readonly Fact[], ...tiers: Fact['tier'][]): Fact[] {
  return facts.filter((f) => tiers.includes(f.tier));
}
