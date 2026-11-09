/**
 * @contract validate.quests
 * owns:       quests.json: steps, rewards, offers and restricted systems resolve
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers
 * invariants: the real data has no errors, and a dangling reference is caught — server/src/data/validateGameData.test.ts
 * extend:     a new cross-reference check for this file goes in the function below
 */

import { type V, entries } from './context.js';
import { isObj, list } from '../validateShapes.js';

export function validateQuests(v: V): void {
  const { c, f, systems, quests, craftRecipes, bosses, reputations, restricted, licences, ref, sys, station, quest, person, faction, record, design, plan, fn, material, item, bag, licence, lines } = v;
  const F = 'quests.json';
  const qf = f.quests;
  // Ships are not rewards: a job hands out a design only for a build job to use (main_01's Prospector, for main_02)
  const builtPlans = new Set<unknown>();
  for (const q of list(qf?.quests)) for (const s of list(q?.steps)) if (s?.type === 'slot' || s?.type === 'build' || s?.type === 'fly') builtPlans.add(s.plan);
  list(qf?.quests).forEach((q, i) => {
    const P = `quests[${i}]`;
    if (q?.giver !== undefined) station(F, `${P}.giver`, q.giver);
    if (q?.person !== undefined) person(F, `${P}.person`, q.person);
    list(q?.requires).forEach((r, j) => { if (quest(F, `${P}.requires[${j}]`, r) && r === q.id) c.err(`${P}.requires[${j}]`, 'a quest requires itself', F); });
    for (const [k] of entries(q?.minRep)) ref(F, `${P}.minRep.${k}`, 'reputation (quests.json reputations)', reputations, k);
    lines(F, `${P}.offer`, q?.offer);
    list(q?.onStart?.recipes).forEach((x, j) => licence(F, `${P}.onStart.recipes[${j}]`, x));
    bag(F, `${P}.onStart.items`, q?.onStart?.items);
    list(q?.steps).forEach((s, j) => {
      const S = `${P}.steps[${j}]`;
      if (!isObj(s)) return;
      lines(F, `${S}.after`, s.after);
      switch (s.type) {
        case 'travel': case 'scan': case 'visit': case 'hold': case 'course': sys(F, `${S}.system`, s.system); break;
        case 'recover': sys(F, `${S}.system`, s.system); item(F, `${S}.item`, s.item); break;
        case 'construct': sys(F, `${S}.system`, s.system); list(s.pieces).forEach((pc, k) => item(F, `${S}.pieces[${k}].item`, pc?.item)); break;
        case 'dock': case 'courier': station(F, `${S}.station`, s.station); break;
        case 'mine': case 'loot': case 'refine': if (s.item !== undefined) item(F, `${S}.item`, s.item); break;
        case 'craft':
          if (s.item !== undefined) item(F, `${S}.item`, s.item);
          if (s.teach !== undefined && ref(F, `${S}.teach`, 'fabricator recipe (recipes.json craft)', craftRecipes, s.teach)) {
            const rq = craftRecipes.get(s.teach).quest;
            if (rq !== undefined && rq !== q.id) c.warn(`${S}.teach`, `recipe "${s.teach}" belongs to quest "${rq}"`, F);
          }
          break;
        case 'refit': if (s.fn !== undefined) fn(F, `${S}.fn`, s.fn); if (s.material !== undefined) material(F, `${S}.material`, s.material); break;
        case 'kill':
          if (s.faction !== undefined) faction(F, `${S}.faction`, s.faction);
          if (s.enemy !== undefined) design(F, `${S}.enemy`, s.enemy);
          if (s.system !== undefined) sys(F, `${S}.system`, s.system);
          break;
        case 'deliver': bag(F, `${S}.items`, s.items); break;
        case 'boss':
          if (ref(F, `${S}.boss`, 'boss', bosses, s.boss)) {
            const b = bosses.get(s.boss);
            if (s.arena !== undefined && !b.arena) c.warn(`${S}.boss`, `boss "${s.boss}" is fought in an arena here but isn't marked arena: it also lairs out in the world`, F);
            if (s.arena === undefined && b.arena) c.err(`${S}.boss`, `boss "${s.boss}" is arena-only, so this step needs an arena (it never appears at a lair)`, F);
          }
          if (s.arena !== undefined && sys(F, `${S}.arena`, s.arena) && !isObj(systems.get(s.arena).surface?.arena)) c.err(`${S}.arena`, `system "${s.arena}" is not an arena (needs surface.arena)`, F);
          if (s.arena !== undefined && s.person === undefined) c.err(`${S}.person`, 'an arena boss step needs a person to talk to before the fight', F);
          if (s.person !== undefined) person(F, `${S}.person`, s.person);
          lines(F, `${S}.lines`, s.lines);
          break;
        case 'talk':
          person(F, `${S}.person`, s.person);
          lines(F, `${S}.lines`, s.lines);
          bag(F, `${S}.take`, s.take);
          bag(F, `${S}.give`, s.give);
          break;
        case 'slot': case 'build': case 'fly': plan(F, `${S}.plan`, s.plan); break;
        case 'escort': station(F, `${S}.from`, s.from); station(F, `${S}.to`, s.to); break;
        case 'defend': case 'uplink': station(F, `${S}.near`, s.near); break;
      }
      if (s.type === 'visit') bag(F, `${S}.give`, s.give);
    });
    const r = q?.rewards;
    bag(F, `${P}.rewards.items`, r?.items);
    list(r?.plans).forEach((x, j) => {
      if (plan(F, `${P}.rewards.plans[${j}]`, x) && !builtPlans.has(x)) c.err(`${P}.rewards.plans[${j}]`, `ship plans are not rewards: "${x}" is no build job's design (slot/build/fly steps)`, F);
    });
    list(r?.recipes).forEach((x, j) => licence(F, `${P}.rewards.recipes[${j}]`, x));
    list(r?.licences).forEach((x, j) => ref(F, `${P}.rewards.licences[${j}]`, 'sector licence (quests.json restricted)', licences, x));
    for (const [k] of entries(r?.reputation)) ref(F, `${P}.rewards.reputation.${k}`, 'reputation (quests.json reputations)', reputations, k);
    list(r?.codex).forEach((x, j) => record(F, `${P}.rewards.codex[${j}]`, x));
  });
  // Requirement cycles: those quests can never be offered
  const state = new Map<string, number>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { c.err(`quests (${id})`, `requirement cycle: ${[...trail.slice(trail.indexOf(id)), id].join(' -> ')}`, F); return; }
    state.set(id, 1);
    for (const r of list(quests.get(id)?.requires)) if (quests.has(r)) visit(r, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of quests.keys()) visit(id, []);
  for (const [rid, rep] of entries(qf?.reputations)) {
    list(rep?.vendor?.stations).forEach((s, i) => station(F, `reputations.${rid}.vendor.stations[${i}]`, s));
    list(rep?.vendor?.stock).forEach((s, i) => item(F, `reputations.${rid}.vendor.stock[${i}].item`, s?.item));
  }
  for (const [sid] of restricted) sys(F, `restricted.${sid}`, sid);
}
