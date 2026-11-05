// npm run wire:sync [--skip]
// Appends every model, material and piece id in data/ships that isn't yet in the wire dictionary
// (common/src/network/binaryCodec.ts' fixed head + common/src/network/wire-dictionary.json) to the manifest's
// "ids". Append-only: never reorders or removes. Ids in the manifest's "skip" list are ignored.
// --skip : put the missing ids in "skip" instead (keep them off the wire; no protocol change).
// Afterwards run `npm run wire:bump "reason"` (the dictionary is part of the pinned wire hash).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = join(root, 'common/src/network/wire-dictionary.json');
const json = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

/** The fixed head of DICTIONARY, read from binaryCodec.ts (the string literals between its brackets) */
export function headIds() {
  const src = readFileSync(join(root, 'common/src/network/binaryCodec.ts'), 'utf8');
  const a = src.indexOf('const DICTIONARY_HEAD');
  const b = src.indexOf('\n];', a);
  const body = src.slice(a, b).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  return [...body.matchAll(/'([^'\n]+)'/g)].map((m) => m[1]);
}

/** Model, material and piece ids in data/ships, in file order */
export function dataIds() {
  return [
    ...json('data/ships/models.json').models.map((m) => m.id),
    ...json('data/ships/materials.json').materials.map((m) => m.id),
    ...json('data/ships/pieces.json').pieces.map((m) => m.id),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const known = new Set([...headIds(), ...manifest.ids, ...manifest.skip]);
  const missing = [...new Set(dataIds())].filter((id) => !known.has(id));
  if (!missing.length) console.log('wire dictionary is up to date.');
  else {
    manifest[process.argv.includes('--skip') ? 'skip' : 'ids'].push(...missing);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
    console.log(`${process.argv.includes('--skip') ? 'skipped' : 'appended'} ${missing.length}: ${missing.join(', ')}`);
    if (!process.argv.includes('--skip')) console.log('The wire changed: now run  npm run wire:bump "<reason>"');
  }
}
