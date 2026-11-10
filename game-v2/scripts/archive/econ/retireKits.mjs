/**
 * One-off: the repair kits and insurance bonds are retired (docs/design/field-fabrication.md). Rewrites every reference
 * in the game data to the material pack that takes the kit's place:
 *
 *   repair_kit          -> pack_hull
 *   field_repair_kit    -> pack_wiring
 *   nanite_repair_kit   -> pack_optics
 *   insurance_bond      -> pack_mechanism
 *
 * Drops (bosses.json, factions.json), quest rewards and stakes (quests.json) and vendor lists (stations.json) change in
 * place. The three hand-formatted files (bosses, factions, quests) are edited as text so their layout stays; a bag that
 * would end up with the same key twice, or a list with the same id twice, is merged / deduplicated (stations.json) or
 * reported (the others) before anything is written.
 *
 * data/items.json and data/recipes.json lose the kit and bond entries (the migration, common/src/econ/fieldUpdate.ts,
 * carries the old recipes' inputs, so saves still convert). Run: node scripts/econ/retireKits.mjs   (safe to re-run)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');
export const MAP = {
  repair_kit: 'pack_hull',
  field_repair_kit: 'pack_wiring',
  nanite_repair_kit: 'pack_optics',
  insurance_bond: 'pack_mechanism',
};
const OLD = Object.keys(MAP);

const read = (f) => fs.readFileSync(path.join(dataDir, f), 'utf8');
const write = (f, t) => fs.writeFileSync(path.join(dataDir, f), t);

/** Collisions a plain rename would make: an object with two keys becoming one, a list with an id twice */
function collisions(node, where, out) {
  if (Array.isArray(node)) {
    const seen = new Set();
    node.forEach((v, i) => {
      if (typeof v === 'string' && (OLD.includes(v) || Object.values(MAP).includes(v))) {
        const to = MAP[v] ?? v;
        if (seen.has(to)) out.push(`${where}[${i}] ${v}`);
        seen.add(to);
      }
      collisions(v, `${where}[${i}]`, out);
    });
  } else if (node && typeof node === 'object') {
    const keys = Object.keys(node);
    const seen = new Set();
    for (const k of keys) {
      if (OLD.includes(k) || Object.values(MAP).includes(k)) {
        const to = MAP[k] ?? k;
        if (seen.has(to)) out.push(`${where}.${k}`);
        seen.add(to);
      }
    }
    for (const k of keys) collisions(node[k], `${where}.${k}`, out);
  }
  return out;
}

function retextFile(f) {
  let t = read(f);
  const clash = collisions(JSON.parse(t), f, []);
  if (clash.length) throw new Error(`${f}: renaming would duplicate ${clash.join(', ')}: merge those by hand first`);
  let n = 0;
  for (const [from, to] of Object.entries(MAP)) {
    t = t.replace(new RegExp(`"${from}"`, 'g'), () => { n++; return `"${to}"`; });
  }
  JSON.parse(t);
  write(f, t);
  console.log(`${f}: ${n} references renamed`);
}

for (const f of ['bosses.json', 'factions.json', 'quests.json']) retextFile(f);

// stations.json: a vendor list may already hold the pack: dedupe after renaming
{
  const doc = JSON.parse(read('stations.json'));
  let n = 0;
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (typeof node[i] === 'string' && MAP[node[i]]) { node[i] = MAP[node[i]]; n++; } else walk(node[i]);
      }
      const seen = new Set();
      for (let i = node.length - 1; i >= 0; i--) {
        if (typeof node[i] !== 'string') continue;
        if (Object.values(MAP).includes(node[i]) && seen.has(node[i])) node.splice(i, 1);
        else seen.add(node[i]);
      }
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        if (MAP[k]) throw new Error(`stations.json: key ${k} (merge by hand)`);
        walk(node[k]);
      }
    }
  };
  walk(doc);
  write('stations.json', JSON.stringify(doc, null, 2).replace(/\n/g, '\r\n') + '\r\n');
  console.log(`stations.json: ${n} vendor entries renamed`);
}

// items.json and recipes.json: the retired entries go
{
  const items = JSON.parse(read('items.json'));
  const before = items.items.length;
  items.items = items.items.filter((i) => !OLD.includes(i.id));
  write('items.json', JSON.stringify(items, null, 2).replace(/\n/g, '\r\n') + '\r\n');
  console.log(`items.json: ${before - items.items.length} items removed`);
  const rec = JSON.parse(read('recipes.json'));
  const b2 = rec.craft.length;
  rec.craft = rec.craft.filter((r) => !OLD.includes(r.id));
  write('recipes.json', JSON.stringify(rec, null, 2).replace(/\n/g, '\r\n') + '\r\n');
  console.log(`recipes.json: ${b2 - rec.craft.length} recipes removed`);
}
