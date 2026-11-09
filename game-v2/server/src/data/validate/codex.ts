/**
 * @contract validate.codex
 * owns:       codex.json: what each record waits for, and the records bosses give
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { type V } from './context.js';
import { list } from '../validateShapes.js';

export function validateCodex(v: V): void {
  const { f, bosses, record, cond } = v;
  list(f.codex?.entries).forEach((e, i) => cond('codex.json', `entries[${i}].unlock`, e?.unlock));
  // (a boss's records, found on meeting it)
  for (const [id, b] of bosses) list((b as { codex?: unknown } | undefined)?.codex).forEach((r, i) => record('bosses.json', `bosses.${id}.codex[${i}]`, r));
}
