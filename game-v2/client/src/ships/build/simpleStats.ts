/**
 * @contract client.ships.build-simple-stats
 * owns:       what Simple mode keeps of the stats: the five stat keys the delta card and chips show, and the power balance line
 * needs:      build/statDelta (generatorsShort)
 * invariants: the power line says how many generators short, and nothing when balanced — client/src/ships/build/simpleStats.test.ts
 * extend:     a stat kept in Simple is one more key in SIMPLE_STAT_KEYS (and a row in the hangar's simple panel)
 */

import { generatorsShort } from './statDelta';

/** The stat-delta keys (statDelta STATS) a new pilot sees: top speed, turn, firepower, hull (shield with it), power balance */
export const SIMPLE_STAT_KEYS: ReadonlySet<string> = new Set(['topSpeed', 'turn180', 'dps', 'hull', 'shield', 'power']);

/** The power row: "120 made · 150 used", and how many generators it lacks (`short` null: it balances) */
export function powerBalance(made: number, drawn: number, gens: number): { text: string; short: string | null } {
  const n = (v: number) => Math.round(v).toLocaleString('en-US');
  return { text: `${n(made)} made · ${n(drawn)} used`, short: generatorsShort(made, drawn, gens) };
}
