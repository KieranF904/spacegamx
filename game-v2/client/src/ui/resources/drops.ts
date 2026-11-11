/**
 * @contract client.ui.resource-drops
 * owns:       what each boss and each faction drops per kill, from the loot tables (data/loot.json) and who rolls them (factions.json drops, bosses.json drops), as chances for the guide to turn into tiers
 * needs:      common econ/loot.ts (dropChances, dropSpecFor); the GameData shape (type only)
 * invariants: a faction's chance for an item is the best of its ships' (any ship, anywhere it lives) — client/src/ui/resources/sourceIndex.test.ts
 * extend:     a new kind of dropper is one more function here
 */

import { dropChances, dropSpecFor, type DropChance } from '@space-game/common';
import type { GameData } from './resourceIndex';

const tablesOf = (d: GameData) => d.loot?.tables ?? {};

/** A boss's drops per kill, most likely first */
export function bossDropRows(d: GameData, id: string): DropChance[] {
  return dropChances(tablesOf(d), { drops: d.bosses[id]?.drops });
}

/** A faction's drops per kill: per item the best chance any of its ships has (its own designs, and in a system that sets its own) */
export function factionDropRows(d: GameData, id: string): DropChance[] {
  const f = d.factions[id];
  if (!f) return [];
  const best = new Map<string, DropChance>();
  const take = (rows: DropChance[]) => {
    for (const r of rows) {
      const was = best.get(r.item);
      best.set(r.item, was ? { item: r.item, chance: Math.max(was.chance, r.chance), min: Math.min(was.min, r.min), max: Math.max(was.max, r.max) } : r);
    }
  };
  const tables = tablesOf(d);
  const ships = Object.entries(f.ships ?? {}).filter(([s]) => !(s in d.bosses) && !s.startsWith('boss_') && !s.startsWith('giant_'));
  for (const [, s] of ships) take(dropChances(tables, dropSpecFor(s, f)));
  for (const sp of Object.values(d.spawns ?? {})) for (const [s, spec] of Object.entries(sp.loot ?? {})) if (f.ships?.[s]) take(dropChances(tables, dropSpecFor(spec, f.ships[s], f)));
  if (!ships.length) take(dropChances(tables, f));
  return [...best.values()].sort((a, b) => b.chance - a.chance);
}
