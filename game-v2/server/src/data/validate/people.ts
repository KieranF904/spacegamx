/**
 * @contract validate.people
 * owns:       people.json: places, moves, topics and the quests people give resolve
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { type V } from './context.js';
import { isObj, list } from '../validateShapes.js';

export function validatePeople(v: V): void {
  const { c, f, quests, people, plan, cond, lines, place } = v;
  list(f.people?.people).forEach((p, i) => {
    const F = 'people.json', P = `people[${i}]`;
    place(F, `${P}.at`, p?.at);
    list(p?.moves).forEach((m, j) => { cond(F, `${P}.moves[${j}].if`, m?.if); place(F, `${P}.moves[${j}].at`, m?.at); });
    if (isObj(p?.craft)) {
      plan(F, `${P}.craft.ship`, p.craft.ship);
      if (isObj(p.at) && 'station' in p.at) c.warn(`${P}.craft`, 'a craft is only parked for people out in space (not at a station)', F);
    }
    if (Array.isArray(p?.greeting) && !p.greeting.length) c.err(`${P}.greeting`, 'needs at least one greeting', F);
    list(p?.topics).forEach((t, j) => {
      cond(F, `${P}.topics[${j}].if`, t?.if);
      if (t?.once && t.id === undefined) c.warn(`${P}.topics[${j}]`, 'a `once` topic needs an `id` to be remembered by', F);
      lines(F, `${P}.topics[${j}].lines`, t?.lines);
    });
  });
  // Every quest someone is offered by talking to them needs that person reachable
  for (const [id, q] of quests) if (q?.person !== undefined && q.giver === undefined && !people.has(q.person)) c.err(`quests (${id})`, `quest "${id}" can only be offered by "${q.person}", who doesn't exist`, 'quests.json');
}
