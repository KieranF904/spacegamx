/**
 * @contract validate.items
 * owns:       items.json: quest, codex and part references resolve
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { type V } from './context.js';
import { isObj, list } from '../validateShapes.js';

export function validateItems(v: V): void {
  const { f, quest, record, fn, material, piece } = v;
  list(f.items?.items).forEach((it, i) => {
    const F = 'items.json', P = `items[${i}]`;
    if (it?.quest !== undefined) quest(F, `${P}.quest`, it.quest);
    if (it?.codex !== undefined) record(F, `${P}.codex`, it.codex);
    if (isObj(it?.part)) { material(F, `${P}.part.material`, it.part.material); fn(F, `${P}.part.fn`, it.part.fn); piece(F, `${P}.part.piece`, it.part.piece); }
  });
}
