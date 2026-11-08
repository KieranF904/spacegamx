/**
 * The hazard sums before you go: each hazard a system rates, what your ship's
 * build stands up to, and what being short of it costs (ships/hazards.ts).
 * Cold is told as time: how long till frozen through away from heat, with
 * your hull's insulation (ships/warmth.ts).
 */

import { HAZARDS, hazardTolerance, hazardDeficit, insulationOf, secondsToFreeze, type HazardRules, type ShipDerived } from '@space-game/common';
import hazardData from '../../../data/hazards.json';
import { esc } from './escape';

const RULES = hazardData as unknown as HazardRules;
const NAME: Record<string, string> = {
  radiation: 'Radiation', thermal: 'Thermal', cryo: 'Cryo', corrosive: 'Corrosive', gravitational: 'Gravity', electromagnetic: 'EM',
};

/** Tooltip rows for a system's hazard ratings, against the ship you fly (null: no ship) */
export function hazardRows(ratings: Record<string, number> | undefined, ship: ShipDerived | null): string {
  const rated = HAZARDS.filter((h) => (ratings?.[h] ?? 0) > 0);
  if (!rated.length) return '';
  const tol = ship ? hazardTolerance(RULES, ship) : null;
  const short = tol ? hazardDeficit(ratings ?? {}, tol) : {};
  return rated.map((h) => {
    if (h === 'cryo') return coldRow(ratings![h], ship);
    const t = tol?.[h] ?? 0, s = short[h];
    const yours = tol ? ` · your ship ${t.toFixed(1)}` : '';
    const cost = s ? `<div style="color:#fca5a5; margin-left:10px">short ${s}: ${esc(RULES.effects?.[h]?.summary ?? '')}</div>`
      : tol ? ' <span style="color:#86efac">✓</span>' : '';
    return `<div class="t-row"><b>${NAME[h]}</b> ${ratings![h]}${yours}${cost}</div>`;
  }).join('');
}

/** Cold: how long a ship lasts away from heat, and what its insulation buys */
export function coldRow(rating: number, ship: ShipDerived | null): string {
  const w = RULES.warmth;
  if (!w) return `<div class="t-row"><b>${NAME.cryo}</b> ${rating}</div>`;
  const ins = ship ? insulationOf(ship) : 0;
  const mins = (s: number) => `${Math.round(s / 60 * 2) / 2} min`;
  const yours = ship ? ` · your ship freezes through in about ${mins(secondsToFreeze(w, rating, ins))} away from heat${ins > 0.005 ? ` (its insulation keeps out ${Math.round(ins * 100)}% of the cold)` : ''}`
    : ` · about ${mins(secondsToFreeze(w, rating, 0))} from warm to frozen through away from heat`;
  return `<div class="t-row"><b>${NAME.cryo}</b> ${rating}${yours}<div style="color:#9fd8ff; margin-left:10px">Stars, stations and fires warm you back up</div></div>`;
}
