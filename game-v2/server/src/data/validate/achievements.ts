/**
 * @contract validate.achievements
 * owns:       achievements.json: ribbon stats and boss ribbons resolve
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { type V } from './context.js';
import { list, KNOWN_STATS } from '../validateShapes.js';

export function validateAchievements(v: V): void {
  const { c, f, bosses, ref } = v;
  list(f.achievements?.ribbons).forEach((r, i) => {
    if (typeof r?.stat === 'string' && !KNOWN_STATS.includes(r.stat) && !r.stat.startsWith('boss:')) c.warn(`ribbons[${i}].stat`, `nothing counts the stat "${r.stat}"`, 'achievements.json');
    if (typeof r?.stat === 'string' && r.stat.startsWith('boss:')) ref('achievements.json', `ribbons[${i}].stat`, 'boss', bosses, r.stat.slice(5));
  });
}
