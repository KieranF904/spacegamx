/**
 * @contract validate.recipes
 * owns:       recipes.json: refining and craft recipes resolve
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { type V, entries } from './context.js';
import { isObj, list } from '../validateShapes.js';

export function validateRecipes(v: V): void {
  const { c, f, ships, functions, quest, fn, material, item, bag } = v;
  const F = 'recipes.json';
  const r = f.recipes;
  list(r?.refining).forEach((x, i) => { item(F, `refining[${i}].id`, x?.id); bag(F, `refining[${i}].inputs`, x?.inputs); });
  list(r?.craft).forEach((x, i) => {
    bag(F, `craft[${i}].out`, x?.out);
    bag(F, `craft[${i}].inputs`, x?.inputs);
    if (x?.quest !== undefined) quest(F, `craft[${i}].quest`, x.quest);
    // Nothing opens early: a recipe that isn't a starter opens at a level (a job's kit too)
    if (!x?.starter && typeof x?.level !== 'number') c.err(`craft[${i}].level`, `"${x?.id}" isn't a starter, so it needs the level it opens at`, F);
  });
  for (const [m, plate] of entries(r?.parts?.plates)) { material(F, `parts.plates.${m}`, m); item(F, `parts.plates.${m}`, plate); }
  for (const [fid, extra] of entries(r?.parts?.extras)) {
    fn(F, `parts.extras.${fid}`, fid);
    for (const [id] of entries(extra)) if (id !== 'plate') item(F, `parts.extras.${fid}.${id}`, id);
  }
  for (const [mid, mr] of entries(r?.models)) {
    if (fn(F, `models.${mid}`, mid) && !functions.get(mid)?.model) c.err(`models.${mid}`, `"${mid}" isn't a model (ships/models.json)`, F);
    bag(F, `models.${mid}.inputs`, mr?.inputs);
  }
  if (ships) for (const m of list(ships.catalog.models?.models)) if (typeof m?.id === 'string' && !isObj(r?.models?.[m.id])) c.err(`models`, `model "${m.id}" has no recipe (scripts/econ/models.mjs)`, F);
}
