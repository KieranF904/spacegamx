/**
 * The Mine Bay as a part feature (features/README.md; its rules: minebay.ts; docs/design/groups-mines-docking.md).
 * Shared half: what a rebuild derives (`derived.fx.minebay`: each working bay's mouth, way out and model numbers) and
 * the facts a card shows. Not a weapon: no WeaponInfo, never aimed, never fired by the triggers or a weapon group. No
 * flight hook, input bit or wire slot: a drop is a decision (`mineDrop` up, `minesLaid` down, network/minesProtocol.ts),
 * the mines the server's (server/src/ships/features/minebay), the key and drawing the client's.
 *
 * (No imported value is used at module scope here: the plan reaches this file through the registry.)
 */

import type { PartFeature } from '../types.js';
import { MINES, mineBayOf } from './minebay.js';

export const feature: PartFeature = {
  id: 'minebay',
  applies: (fn) => !!fn.mineBay,
  // (After the others: feature numbers follow (order, id), so theirs do not move)
  order: 80,
  derive(c) {
    for (const i of c.parts) {
      const m = mineBayOf(c.fns[i]), mt = c.mounts[i];
      if (!m || !mt) continue;
      (c.out.minebay ??= { bays: [] }).bays.push({
        part: i, uid: c.blueprint.parts[i].uid, ...m,
        mouth: [mt.at[0], mt.at[1]], dir: [mt.dir[0], mt.dir[1]],
      });
    }
  },
  describe({ fn }) {
    const m = mineBayOf(fn);
    if (!m) return [];
    const arm = Math.round((MINES.armTicks / 60) * 10) / 10;
    return [
      {
        feature: 'minebay', key: 'batch', label: 'Drops', value: m.batch, tier: 'stat',
        sentence: `drops ${m.batch} proximity mines behind you a press, from a magazine of ${m.capacity}`,
        dim: `they arm after ${arm} s, never go off for you or your party, and last ${Math.round(MINES.lifeTicks / 60)} s`,
        short: `${m.batch} mines a drop, ${m.capacity} held`,
        chip: `${m.batch} mines a drop`,
      },
      {
        feature: 'minebay', key: 'blast', label: 'Mine blast', value: MINES.blastDamage, tier: 'stat',
        sentence: `each mine hits for up to ${MINES.blastDamage} across ${MINES.blastRadius} m`,
        short: `${MINES.blastDamage} a mine`,
      },
    ];
  },
};
