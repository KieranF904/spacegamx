/**
 * The hazard sums before you go: each hazard a system rates, what your ship's
 * build stands up to, and what being short of it costs (ships/hazards.ts).
 */

import { HAZARDS, hazardTolerance, hazardDeficit, type HazardRules, type ShipDerived } from '@space-game/common';
import hazardData from '../../../data/hazards.json';

const RULES = hazardData as unknown as HazardRules;
const NAME: Record<string, string> = {
  radiation: 'Radiation', thermal: 'Thermal', cryo: 'Cryo', corrosive: 'Corrosive', gravitational: 'Gravity', electromagnetic: 'EM',
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Tooltip rows for a system's hazard ratings, against the ship you fly (null: no ship) */
export function hazardRows(ratings: Record<string, number> | undefined, ship: ShipDerived | null): string {
  const rated = HAZARDS.filter((h) => (ratings?.[h] ?? 0) > 0);
  if (!rated.length) return '';
  const tol = ship ? hazardTolerance(RULES, ship) : null;
  const short = tol ? hazardDeficit(ratings ?? {}, tol) : {};
  return rated.map((h) => {
    const t = tol?.[h] ?? 0, s = short[h];
    const yours = tol ? ` · your ship ${t.toFixed(1)}` : '';
    const cost = s ? `<div style="color:#fca5a5; margin-left:10px">short ${s}: ${esc(RULES.effects?.[h]?.summary ?? '')}</div>`
      : tol ? ' <span style="color:#86efac">✓</span>' : '';
    return `<div class="t-row"><b>${NAME[h]}</b> ${ratings![h]}${yours}${cost}</div>`;
  }).join('');
}
