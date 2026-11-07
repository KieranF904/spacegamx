/**
 * Docking Clamps as a part feature (features/README.md; their rules: clamp.ts; docs/design/groups-mines-docking.md).
 * Shared half: what a rebuild derives (`derived.fx.clamp`: each working clamp's mouth, way out and size) and the facts
 * a card shows. Locking, swapping who steers and undocking are decisions (network/clampProtocol.ts) the server takes
 * (server/src/ships/features/clamp); the joined pair's flight is shared (package K: common sim); the prompt, keys and
 * drawing are the client's (client/src/ships/features/clamp).
 *
 * (No imported value is used at module scope here: the plan reaches this file through the registry.)
 */

import type { PartFeature } from '../types.js';
import { clampOf } from './clamp.js';

export const feature: PartFeature = {
  id: 'clamp',
  applies: (fn) => !!fn.clamp,
  // (After the others: feature numbers follow (order, id), so theirs do not move)
  order: 90,
  derive(c) {
    for (const i of c.parts) {
      const k = clampOf(c.fns[i]), mt = c.mounts[i];
      if (!k || !mt) continue;
      (c.out.clamp ??= { clamps: [] }).clamps.push({
        part: i, uid: c.blueprint.parts[i].uid, size: k.size,
        mouth: [mt.at[0], mt.at[1]], dir: [mt.dir[0], mt.dir[1]],
      });
    }
  },
  describe({ fn }) {
    const k = clampOf(fn);
    if (!k) return [];
    const cells = k.size === 1 ? 'one-cell' : `${k.size}-cell`;
    return [{
      feature: 'clamp', key: 'size', label: 'Clamp', value: k.size, tier: 'stat',
      sentence: `locks to another ship's ${cells} clamp lined up with it, when both pilots agree; one steers, each keeps their own guns`,
      short: `locks to a ${cells} clamp`,
      chip: `${cells} clamp`,
    }];
  },
};
