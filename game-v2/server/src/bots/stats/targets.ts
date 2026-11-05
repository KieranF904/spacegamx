/**
 * "How long would this loop take to pay for X?" The raw ore a target costs (parts expanded through the refining and crafting
 * recipes down to minerals), against the ore per hour a bot deposits. The scarcest ore sets the time; ore the loop never
 * brings (a rock type it does not mine) makes the target unreachable by this loop alone.
 */
import type { Blueprint } from '@space-game/common';
import type { Economy } from '@space-game/common';
import type { Bag } from '../core/types.js';

export interface Target { name: string; raw: Bag; unresolved: string[] }

type Recipes = Economy['recipes'];

/** Minerals a bag of items is made from, through refining and crafting */
export function rawOre(econ: Economy, bag: Bag): { raw: Bag; unresolved: string[] } {
  const raw: Bag = {}, unresolved = new Set<string>();
  const visit = (id: string, n: number, depth: number): void => {
    const def = econ.items.get(id);
    if (def?.category === 'mineral') { raw[id] = (raw[id] ?? 0) + n; return; }
    const r = (econ.recipes as Recipes).refining.get(id) ?? (econ.recipes as Recipes).craft.get(id);
    const made = r ? ('out' in r ? (typeof r.out === 'number' ? r.out : (r.out as Bag)[id] ?? 1) : 1) : 0;
    if (!r || !made || depth > 6) { unresolved.add(id); return; }
    for (const [inId, k] of Object.entries(r.inputs)) visit(inId, (n / made) * k, depth + 1);
  };
  for (const [id, n] of Object.entries(bag)) visit(id, n, 0);
  return { raw, unresolved: [...unresolved] };
}

/** What a few meaningful things cost: the Mk I mining laser, and a whole Prospector (every part's fabrication inputs) */
export function targetsFor(econ: Economy, prospector: Blueprint): Target[] {
  const laser = econ.recipes.partInputs({ material: 'alloy', fn: 'utility_mining_laser', piece: 'sq' });
  const ship: Bag = {};
  for (const p of prospector.parts) for (const [id, n] of Object.entries(econ.recipes.partInputs(p as never))) ship[id] = (ship[id] ?? 0) + n;
  return [
    { name: 'Mk I mining laser (alloy)', ...rawOre(econ, laser) },
    { name: 'a Prospector, every part built', ...rawOre(econ, ship) },
  ];
}

export interface TargetTime { name: string; raw: Bag; unresolved: string[]; minutes: number | null; limiting: string; missing: string[]; totalOre: number; minutesIfAnyOre: number }

/** Minutes of the loop for each target, from the ore per hour it deposits (by ore) */
export function timeToTargets(targets: Target[], depositedPerHour: Bag): TargetTime[] {
  const total = Object.values(depositedPerHour).reduce((a, n) => a + n, 0);
  return targets.map((t) => {
    let hours = 0, limiting = '';
    const missing: string[] = [];
    for (const [ore, need] of Object.entries(t.raw)) {
      const rate = depositedPerHour[ore] ?? 0;
      if (rate <= 0) { missing.push(ore); continue; }
      if (need / rate > hours) { hours = need / rate; limiting = ore; }
    }
    const totalOre = Object.values(t.raw).reduce((a, n) => a + n, 0);
    return { name: t.name, raw: t.raw, unresolved: t.unresolved, minutes: missing.length ? null : hours * 60, limiting, missing, totalOre, minutesIfAnyOre: total ? (totalOre / total) * 60 : 0 };
  });
}

export function targetsText(times: TargetTime[]): string {
  const L = ['  -- time to afford, at this loop\'s ore mix --'];
  for (const t of times) {
    const need = Object.entries(t.raw).map(([k, n]) => `${Math.ceil(n)} ${k}`).join(', ');
    L.push(`  ${t.name}: needs ${need}${t.unresolved.length ? ` (+ ${t.unresolved.join(', ')}: not mined)` : ''}`);
    L.push(`      ${t.minutes === null ? `not from this loop alone (it brings no ${t.missing.join(', ')})` : `${t.minutes.toFixed(0)} min (waiting on ${t.limiting})`}; ${t.minutesIfAnyOre.toFixed(0)} min if every ore counted`);
  }
  return L.join('\n');
}
