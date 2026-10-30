// Ship ratings for every design, at every grade (balancing aid):
//   npx vite-node scripts/ship-ratings.ts
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createShipState, rateShip, regrade, parseBlueprint, loadCatalog, type Blueprint } from '../common/src/index';
import { loadShipConfigFromDisk } from '../server/src/ships/loadShipConfig';

const data = join(__dirname, '../data');
const raw = loadShipConfigFromDisk(data);
const cfg = { tuning: raw.tuning, catalog: loadCatalog(raw.catalog, { overlapShrink: raw.tuning.overlapShrink }) };
const factions = JSON.parse(readFileSync(join(data, 'factions.json'), 'utf8'));
const hpScaleOf = (design: string) => {
  for (const f of Object.values<any>(factions.factions)) if (design in f.ships) return f.hpScale ?? 1;
  return 1;
};

const rate = (bp: Blueprint, hpScale = 1) => {
  const s = createShipState(cfg.catalog, cfg.tuning, 0, bp, 0);
  const r = rateShip(cfg.catalog, cfg.tuning, s, hpScale);
  return `${r.rating.toFixed(1).padStart(6)} (${Math.round(r.firepower)} dps, ${Math.round(r.toughness)} hp)`;
};

const dirs: [string, string][] = [['player', join(data, 'ships/blueprints')], ['enemy', join(data, 'ships/blueprints/enemy')]];
for (const [label, dir] of dirs) {
  console.log(`\n== ${label}`);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const bp = parseBlueprint(readFileSync(join(dir, f), 'utf8'));
    const name = f.replace('.json', '');
    const hs = label === 'enemy' ? hpScaleOf(name) : 1;
    const row = [1, 2, 3, 4, 5].map((g) => rate(regrade(cfg.catalog, bp, g), hs).split(' (')[0]).join(' ');
    console.log(`${name.padEnd(26)} as built ${rate(bp, hs)}   Mk I-V: ${row}`);
  }
}

// What each system sends: its packs' ships together (rating of the summed firepower and toughness), weighted as they're picked
import { ratingOf } from '../common/src/index';
console.log('\n== systems (pack ratings at the system grade)');
for (const [sys, sp] of Object.entries<any>(factions.spawns)) {
  const grade = sp.grade ?? 1;
  const groups = [...(sp.groups ?? []), ...(sp.zones ?? []).flatMap((z: any) => z.groups)];
  const rows: string[] = [];
  let sum = 0, w = 0;
  for (const g of groups) {
    let fp = 0, t = 0;
    const hs = factions.factions[g.faction]?.hpScale ?? 1;
    for (const type of g.ships) {
      const bp = parseBlueprint(readFileSync(join(data, 'ships/blueprints/enemy', `${type}.json`), 'utf8'));
      const r = rateShip(cfg.catalog, cfg.tuning, createShipState(cfg.catalog, cfg.tuning, 0, regrade(cfg.catalog, bp, grade), 0), hs);
      fp += r.firepower; t += r.toughness;
    }
    const pr = ratingOf(fp, t);
    rows.push(`${g.ships.join('+')}=${pr.toFixed(0)}`);
    sum += pr * (g.weight ?? 1); w += g.weight ?? 1;
  }
  console.log(`${sys.padEnd(14)} Mk ${grade}  avg pack ${(sum / w).toFixed(1).padStart(5)}   ${rows.join('  ')}`);
}
