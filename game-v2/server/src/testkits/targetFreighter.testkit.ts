/**
 * Test-only: a fixed target freighter, unarmed and unshielded, whatever the world's freighters become: the library Ark
 * Tender with its guns and shields made plain hull (it replaces the retired pool-era dev Test Freighter).
 */
import type { Blueprint } from '@space-game/common';

export function targetFreighter(ships: { library: ReadonlyMap<string, Blueprint> }, catalog?: { functions: ReadonlyMap<string, { weapon?: string; shield?: number; shaped?: unknown }> }): Blueprint {
  const bp = ships.library.get('ark-tender');
  if (!bp) throw new Error('targetFreighter: no library ark-tender');
  const armed = (fn: string) => {
    const f = catalog?.functions.get(fn);
    return f ? !!f.weapon || (f.shield ?? 0) > 0 || !!f.shaped : /^(cannon|autocannon|pulse|laser|railgun|flak|missile|torpedo|lance|emp|arc|mortar|point_defence|shield)/.test(fn);
  };
  return {
    ...bp,
    name: 'Target Freighter',
    parts: bp.parts.map((p) => {
      if (!armed(p.fn)) return p;
      const { mount: _m, facing: _f, mods: _x, gems: _g, ...rest } = p;
      return { ...rest, fn: 'hull', material: 'alloy' };
    }),
  };
}
