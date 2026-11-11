/**
 * @contract validate.loot
 * owns:       loot.json's tables (items exist, weights above 0, sane amounts) and every drops / eliteDrop in factions.json and bosses.json naming one
 * needs:      validate/context (the ids and reference helpers), validateShapes helpers
 * invariants: the real data has no errors, and a dangling table or a bad weight is caught — server/src/data/validateGameData.test.ts
 * extend:     a new place that rolls tables is one more spec() call below
 */

import { type V, entries } from './context.js';
import { isObj, list } from '../validateShapes.js';

export function validateLoot(v: V): void {
  const { c, f, item, design, factions } = v;
  const L = 'loot.json';
  const tables = new Map(entries(f.loot?.tables));
  for (const [id, t] of tables) {
    const P = `tables.${id}`;
    if (!list(t?.entries).length) c.err(`${P}.entries`, 'a table needs at least one entry', L);
    if (t?.nothing !== undefined && !(typeof t.nothing === 'number' && t.nothing >= 0)) c.err(`${P}.nothing`, 'nothing is a weight, 0 or more', L);
    list(t?.entries).forEach((e, i) => {
      const p = `${P}.entries[${i}]`;
      item(L, `${p}.item`, e?.item);
      if (t?.kind !== 'always' && !(typeof e?.weight === 'number' && e.weight > 0)) c.err(`${p}.weight`, 'a weighted entry needs a weight above 0', L);
      const lo = e?.min ?? 1, hi = e?.max ?? lo;
      if (!(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 1 && hi >= lo)) c.err(p, 'amounts are whole numbers, 1 <= min <= max', L);
    });
  }
  // Who rolls them
  const table = (file: string, path: string, id: unknown) => {
    if (id !== undefined && !(typeof id === 'string' && tables.has(id))) c.err(path, `unknown loot table "${String(id)}" (loot.json)`, file);
  };
  const spec = (file: string, path: string, s: any) => {
    if (!isObj(s)) return;
    list(s.drops).forEach((d, i) => {
      table(file, `${path}.drops[${i}].table`, d?.table);
      if (!(Number.isInteger(d?.rolls) && d.rolls >= 1)) c.err(`${path}.drops[${i}].rolls`, 'rolls is a whole number, 1 or more', file);
    });
    table(file, `${path}.eliteDrop`, s.eliteDrop);
  };
  const F = 'factions.json';
  for (const [id, def] of entries(f.factions?.factions)) {
    spec(F, `factions.${id}`, def);
    for (const [ship, s] of entries(def?.ships)) spec(F, `factions.${id}.ships.${ship}`, s);
  }
  for (const [sid, sp] of entries(f.factions?.spawns)) {
    for (const [ship, s] of entries(sp?.loot)) {
      design(F, `spawns.${sid}.loot.${ship}`, ship);
      if (![...factions.values()].some((fd) => isObj(fd?.ships?.[ship]))) c.warn(`spawns.${sid}.loot.${ship}`, `"${ship}" is in no faction's ships table`, F);
      spec(F, `spawns.${sid}.loot.${ship}`, s);
    }
  }
  for (const [id, b] of entries(f.bosses?.bosses)) spec('bosses.json', `bosses.${id}`, b);
}
