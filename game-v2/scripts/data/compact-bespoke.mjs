// Rewrite data/ships/bespoke/*.json in the compact form (scripts/lib/compactJson.mjs), checking the parsed content is unchanged:
//   node scripts/data/compact-bespoke.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { compactJson } from '../lib/compactJson.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../data/ships/bespoke');
let before = 0, after = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
  const raw = readFileSync(join(dir, f), 'utf8');
  const text = compactJson(JSON.parse(raw));
  if (!isDeepStrictEqual(JSON.parse(text), JSON.parse(raw))) throw new Error(`${f}: content changed, not written`);
  writeFileSync(join(dir, f), text);
  before += raw.length; after += text.length;
}
console.log(`bespoke: ${before} -> ${after} bytes`);
