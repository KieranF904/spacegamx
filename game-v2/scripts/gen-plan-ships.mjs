// Pre-made player ship plans from text layouts (front at the top), built of models (docs/parts-redesign.md):
//   npm run build:common && node scripts/gen-plan-ships.mjs   → data/ships/blueprints/<file>.json
// Legend as in scripts/lib/layout.mjs, plus N = mining laser, O = scanner, X = cargo hold. Each module letter is the
// starter model of its kind (layout.mjs PLAYER_MODELS); K (conduit) is plain hull: power runs on wires, auto-wired.
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { build, asModels } from './lib/layout.mjs';
import { loadCatalog, serializeBlueprint, validateBlueprint } from '../common/dist/index.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '../data');
const read = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const out = join(DATA, 'ships/blueprints');
const models = read('ships/models.json');
const tuning = read('ships/tuning.json');
const catalog = loadCatalog({ pieces: read('ships/pieces.json'), functions: read('ships/functions.json'), materials: read('ships/materials.json'), models }, { overlapShrink: tuning.overlapShrink });

const PLANS = {
  // The first ship a pilot builds: a mining laser up front, a real hold, one gun
  prospector: ['Prospector', 'alloy', [
    '..N..',
    '.WKW.',
    '<XCX>',
    'AHGHA',
    '.TGT.',
  ]],
};

for (const [file, [name, material, rows]] of Object.entries(PLANS)) {
  const bp = asModels(build(name, material, rows), models.models);
  const v = validateBlueprint(catalog, bp, tuning, null);
  if (!v.ok) throw new Error(`${name}: ${v.errors.map((e) => e.message).join('; ')}`);
  writeFileSync(join(out, `${file}.json`), serializeBlueprint(bp));
}
console.log(`${Object.keys(PLANS).length} plan(s) written to ${out}`);
