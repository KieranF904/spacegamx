/** Ship summary fields from the facts of a design's parts (shipSummary.ts): headline facts, one per feature key, in first-seen order */

import type { Fact } from '@space-game/common';
import { factValue } from './render';

export interface SummaryField { key: string; label: string; text: string }

export function summaryFields(facts: readonly Fact[]): SummaryField[] {
  const seen = new Set<string>(), out: SummaryField[] = [];
  for (const f of facts) {
    if (f.tier !== 'headline') continue;
    const key = `${f.feature}.${f.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: f.label, text: factValue(f) });
  }
  return out;
}
