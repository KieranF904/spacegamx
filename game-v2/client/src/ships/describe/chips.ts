/** Short card chips from facts (modelCards.ts keyStats): headline and stat facts, a `chip` or `sentence` winning over "label value" */

import type { Fact } from '@space-game/common';
import { factValue } from './render';

export function chips(facts: readonly Fact[]): string[] {
  const out: string[] = [];
  for (const f of facts) {
    if (f.tier !== 'headline' && f.tier !== 'stat') continue;
    out.push(f.chip ?? f.sentence ?? `${f.label.toLowerCase()} ${factValue(f)}`);
  }
  return out;
}
