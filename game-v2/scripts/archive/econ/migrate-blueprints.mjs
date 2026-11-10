// The starter and library ships (data/ships/blueprints/*.json; not the enemy/ or dev/ designs) with their legacy
// parts as models (docs/parts-redesign.md §7, common/src/ships/migrate.ts), in place; and the legacy part items the
// game's data names (quest rewards, station stock) as their models'. Run after `npm run build:common`:
//   node scripts/econ/migrate-blueprints.mjs
// The starter (sparrow-t, the loaner too) keeps to the models a new pilot can make, so it flies as it always did.
// Ships stay unwired: they're auto-wired when built (common/src/ships/wires.ts).

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadCatalog, parseBlueprint, serializeBlueprint, validateBlueprint, migrateBlueprint, migratePartItem } from '../../../common/dist/index.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const tuning = read('ships/tuning.json');
const catalog = loadCatalog({ pieces: read('ships/pieces.json'), functions: read('ships/functions.json'), materials: read('ships/materials.json'), models: read('ships/models.json') }, { overlapShrink: tuning.overlapShrink });
/** Plans a new pilot starts with: only what they could make themselves */
const STARTER = { 'sparrow-t': 0 };

const dir = join(DATA, 'ships/blueprints');
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
  const name = f.slice(0, -5);
  const bp = parseBlueprint(readFileSync(join(dir, f), 'utf8'));
  const m = migrateBlueprint(catalog, bp, { maxLevel: STARTER[name] });
  if (!m.changed) { console.log(`${name}: no legacy parts`); continue; }
  const v = validateBlueprint(catalog, m.blueprint, tuning, null);
  if (!v.ok) throw new Error(`${name}: ${v.errors.map((e) => e.message).join('; ')}`);
  if (m.refund.length) console.warn(`${name}: ${m.refund.length} part(s) had no model that fits and became hull (${m.refund.map((r) => r.item).join(', ')})`);
  writeFileSync(join(dir, f), serializeBlueprint(m.blueprint));
  console.log(`${name}: ${bp.parts.length} -> ${m.blueprint.parts.length} parts`);
}

// Legacy part items named in the data
for (const f of ['quests.json', 'stations.json']) {
  const text = readFileSync(join(DATA, f), 'utf8');
  let n = 0;
  const out = text.replace(/"(part:[a-z_]+:[a-z_0-9]+:[a-z0-9_]+)"/g, (s, id) => {
    const to = migratePartItem(catalog, id);
    if (to === id) return s;
    n++;
    return JSON.stringify(to);
  });
  if (n) { writeFileSync(join(DATA, f), out); console.log(`${f}: ${n} part item(s)`); }
}
