// Rewrite blueprint files in the canonical format (serializeBlueprint):
//   npx vite-node scripts/canon-blueprints.ts data/ships/blueprints/arrow.json ...
import { readFileSync, writeFileSync } from 'fs';
import { parseBlueprint, serializeBlueprint } from '../common/src/index';
for (const f of process.argv.slice(2)) writeFileSync(f, serializeBlueprint(parseBlueprint(readFileSync(f, 'utf8'))));
