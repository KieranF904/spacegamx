/**
 * @contract validate.extras
 * owns:       the small data files nothing else validates: strings.json (placeholders), mobs.json (blast, the mobs that part
 *             functions launch) and terrain/<id>.json (named for a real system)
 * needs:      validate/context (the ids and reference helpers), common MOB_IDS; browser-safe: no Node imports
 * invariants: the real data has no errors — server/src/data/validateGameData.test.ts
 *             a launched mob that does not exist (also those named in move code), an unbalanced string placeholder and a terrain file for no system are
 *             caught — server/src/data/validate/extras.test.ts
 * extend:     a new cross-reference check for one of these files goes in the function below
 */

import { MOB_IDS } from '@space-game/common';
import { type V, entries, str } from './context.js';

export function validateExtras(v: V): void {
  const { c, f, systems, ships } = v;
  for (const [k, text] of entries(f.strings)) {
    const s = str(text);
    if (s === undefined) continue;
    if (s.split('{').length !== s.split('}').length) c.err(k, `unbalanced "{" "}" in "${s}"`, 'strings.json');
  }
  const mobs = new Map(entries(f.mobs?.mobs));
  if (f.mobs !== undefined) {
    for (const fnd of ships?.catalog.functions?.functions ?? []) {
      const mob = (fnd as { id?: string; launches?: { mob?: string } })?.launches?.mob;
      if (mob !== undefined) v.ref('ships/functions.json', `${(fnd as { id?: string }).id}.launches.mob`, 'mob (mobs.json)', mobs, mob);
    }
  }
  // Mobs that move code launches by name (common MOB_IDS) must exist
  if (f.mobs !== undefined) for (const [k, id] of Object.entries(MOB_IDS)) v.ref('common/src/constants.ts', `MOB_IDS.${k}`, 'mob (mobs.json)', mobs, id);
  for (const id of Object.keys(f.terrain ?? {})) {
    if (!systems.has(id)) c.err(id, `terrain file for "${id}": no such system in systems.json`, 'terrain');
  }
}
