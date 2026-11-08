// Gun shape rules migration (ships/gunFacing.ts): turn every model gun in the bundled designs so its barrel follows its
// turn, keeping the barrel where it pointed. Dry run by default (prints each change and whether the gun's power inputs
// stay where they were); --write patches only the changed gun's line in each file.
//   npx vite-node scripts/ships/gun-facing.ts [--write]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint, loadCatalog, validateBlueprint, migrateGunFacings } from '../../common/src/index';
import { loadShipConfigFromDisk } from '../../server/src/ships/loadShipConfig';

const write = process.argv.includes('--write');
const data = join(__dirname, '../../data');
const raw = loadShipConfigFromDisk(data);
const catalog = loadCatalog(raw.catalog, { overlapShrink: raw.tuning.overlapShrink });
const SKIP = new Set(['gen-gunship-1.json']);

const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.json') && !SKIP.has(f)) files.push(p); } };
walk(join(data, 'ships/blueprints'));

let nFiles = 0, nGuns = 0, nDiffer = 0, nTurned = 0, nStuck = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const bp = parseBlueprint(text);
  const m = migrateGunFacings(catalog, bp);
  if (!m.changes.length) continue;
  nFiles++;
  const rel = file.slice(data.length + 1).replace(/\\/g, '/');
  const okBefore = validateBlueprint(catalog, bp, raw.tuning).ok, okAfter = validateBlueprint(catalog, m.blueprint, raw.tuning).ok;
  console.log(`${rel}  (valid before ${okBefore}, after ${okAfter})`);
  for (const c of m.changes) {
    nGuns++; if (c.wiring === 'differs') nDiffer++; if (c.how === 'turned') nTurned++; if (c.how === 'stuck') nStuck++;
    console.log(`   ${String(c.uid).padStart(3)} ${c.fn.padEnd(24)} ${c.how.padEnd(7)} rot ${c.from.rot}${c.from.flip ? 'f' : ''}@${c.from.x},${c.from.y} ${c.from.facing} -> rot ${c.to.rot}${c.to.flip ? 'f' : ''}@${c.to.x},${c.to.y} ${c.to.facing}  ${c.moved ? 'footprint moved ' : ''}wiring ${c.wiring}`);
  }
  if (write && m.changed) {
    const byUid = new Map(m.blueprint.parts.map((p) => [p.uid, p]));
    const touched = new Set(m.changes.filter((c) => c.how !== 'stuck').map((c) => c.uid));
    const out = text.split('\n').map((line) => {
      const t = line.trim().replace(/,$/, '');
      if (!t.startsWith('{"uid"')) return line;
      let o: any; try { o = JSON.parse(t); } catch { return line; }
      if (!touched.has(o.uid)) return line;
      const q = byUid.get(o.uid)!;
      o.x = q.x; o.y = q.y; o.rot = q.rot; o.flip = q.flip; o.facing = q.facing;
      return line.slice(0, line.indexOf('{')) + JSON.stringify(o) + (line.trimEnd().endsWith(',') ? ',' : '');
    }).join('\n');
    writeFileSync(file, out);
  }
}
console.log(`\n${nFiles} designs, ${nGuns} guns changed (${nDiffer} with power inputs elsewhere, ${nTurned} turned in place, ${nStuck} stuck)${write ? ' - written' : ' - dry run'}`);
