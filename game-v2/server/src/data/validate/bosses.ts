/**
 * @contract validate.bosses
 * owns:       bosses.json: lairs and designs resolve (its drops: validate/loot.ts)
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers; npm: @space-game/common
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { MAX_DRIVE } from '@space-game/common';
import { type V, entries } from './context.js';
import { isObj, list } from '../validateShapes.js';

export function validateBosses(v: V): void {
  const { c, f, systems, quests, sys, faction, design, weaponKind } = v;
  const F = 'bosses.json';
  const arenaBosses = new Set<string>();
  for (const q of quests.values()) for (const s of list(q?.steps)) if (s?.type === 'boss' && s.arena) arenaBosses.add(s.boss);
  for (const [id, b] of entries(f.bosses?.bosses)) {
    const P = `bosses.${id}`;
    faction(F, `${P}.faction`, b?.faction);
    sys(F, `${P}.system`, b?.system);
    design(F, b?.design !== undefined ? `${P}.design` : P, b?.design ?? id);
    list(b?.phases).forEach((ph, i) => {
      list(ph?.escorts).forEach((e, j) => design(F, `${P}.phases[${i}].escorts[${j}]`, e));
      if (isObj(ph?.nova)) weaponKind(F, `${P}.phases[${i}].nova.kind`, ph.nova.kind);
    });
    if (typeof b?.speed === 'number' && !(b.speed > 0 && b.speed <= MAX_DRIVE)) c.err(`${P}.speed`, `speed is engine output, above 0 and at most ${MAX_DRIVE}`, F);
    if (b?.arena && !arenaBosses.has(id)) c.warn(P, `arena boss "${id}" is fought only in a job's arena, but no quest step fights it there`, F);
    if (b?.arena && systems.has(b.system) && !isObj(systems.get(b.system).surface?.arena)) c.warn(`${P}.system`, `arena boss lives in "${b.system}", which is not an arena`, F);
  }
}
