// Refit ship plans for bigger engines: pairs of side-by-side single-cell thrusters facing the
// same way become one two-cell thruster (more push for its size), wherever the design stays valid.
// (The starter, sparrow-t, is a test fixture: leave it as it is.)
//   npx vite-node scripts/merge-thrusters.ts [--write]
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadCatalog, parseBlueprint, serializeBlueprint, validateBlueprint, placeGeometry, SIDE_NORMAL, type Blueprint, type PlacedPart, type Rot, type Side } from '../common/src/index';
import { loadShipConfigFromDisk } from '../server/src/ships/loadShipConfig';

const data = join(__dirname, '../data');
const raw = loadShipConfigFromDisk(data);
const catalog = loadCatalog(raw.catalog, { overlapShrink: raw.tuning.overlapShrink });
const write = process.argv.includes('--write');
const dir = join(data, 'ships/blueprints');

const cellsOf = (p: PlacedPart) => placeGeometry(catalog, p).cells.map(([x, y]) => `${x},${y}`).sort().join('|');

for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'sparrow-t.json')) {
  const text = readFileSync(join(dir, f), 'utf8');
  let bp: Blueprint = parseBlueprint(text);
  const ok0 = validateBlueprint(catalog, bp, raw.tuning, null).ok;
  let merged = 0;
  for (let guard = 0; guard < 200; guard++) {
    const singles = bp.parts.filter((p) => p.fn === 'thruster' && p.piece === 'sq' && p.facing);
    let done = false;
    for (const a of singles) {
      const n = SIDE_NORMAL[a.facing as Side];
      const t = [Math.abs(n[1]), Math.abs(n[0])];
      const b = singles.find((q) => q !== a && q.facing === a.facing && q.material === a.material && q.x === a.x + t[0] && q.y === a.y + t[1]);
      if (!b) continue;
      // The rect2 that covers exactly these two cells, keeping the facing
      const want = [`${a.x},${a.y}`, `${b.x},${b.y}`].sort().join('|');
      for (const rot of [0, 1, 2, 3] as Rot[]) for (const flip of [false, true]) for (const [x, y] of [[a.x, a.y], [b.x, b.y]]) {
        if (done) continue;
        const cand: PlacedPart = { ...a, piece: 'rect2', rot, flip, x, y };
        if (cellsOf(cand) !== want) continue;
        const next = { ...bp, parts: [...bp.parts.filter((p) => p !== a && p !== b), cand] };
        if (!validateBlueprint(catalog, next, raw.tuning, null).ok) continue;
        bp = next; merged++; done = true;
      }
      if (done) break;
    }
    if (!done) break;
  }
  const ok = validateBlueprint(catalog, bp, raw.tuning, null).ok;
  console.log(`${f.padEnd(26)} merged ${merged} pair${merged === 1 ? '' : 's'} ${ok0 && !ok ? '(INVALID: skipped)' : ''}`);
  if (write && merged && ok) writeFileSync(join(dir, f), serializeBlueprint(bp));
}
