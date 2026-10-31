/** Tooltip rows from facts (partTip.ts, windowKit.ts partStatsHtml): label, text, and whether it is a warning */

import type { Fact } from '@space-game/common';
import { factValue } from './render';

export interface TipRow { label: string; text: string; warn: boolean }

/** Every tier shows in a full tooltip; `compact` (the small item tooltip) drops 'detail' */
export function tipRows(facts: readonly Fact[], compact = false): TipRow[] {
  const out: TipRow[] = [];
  for (const f of facts) {
    if (compact && f.tier === 'detail') continue;
    out.push({ label: f.label, text: f.sentence ?? factValue(f), warn: f.tier === 'warning' });
  }
  return out;
}
