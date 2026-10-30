// Every design's energy budget under the battery rules (common/src/ships/energy.ts), to spot ships that
// run dry too fast in a fight (balancing aid):
//   npx vite-node scripts/ship-energy.ts
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createShipState, parseBlueprint, loadCatalog, energyTuning } from '../common/src/index';
import { loadShipConfigFromDisk } from '../server/src/ships/loadShipConfig';

const data = join(__dirname, '../data');
const raw = loadShipConfigFromDisk(data);
const catalog = loadCatalog(raw.catalog, { overlapShrink: raw.tuning.overlapShrink });
const et = energyTuning(raw.tuning);

/** Seconds a full battery lasts at this draw (Infinity: it charges) */
const lasts = (max: number, spare: number, draw: number) => (draw <= spare ? Infinity : max / (draw - spare));
const fmt = (s: number) => (s === Infinity ? '  ∞ ' : `${s.toFixed(s < 10 ? 1 : 0).padStart(4)}s`);

const dirs: [string, string][] = [['player', join(data, 'ships/blueprints')], ['enemy', join(data, 'ships/blueprints/enemy')]];
for (const [label, dir] of dirs) {
  console.log(`\n== ${label}       battery  spare  engines  guns   cruise  fight  boost  guns-only`);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const bp = parseBlueprint(readFileSync(join(dir, f), 'utf8'));
    const d = createShipState(catalog, raw.tuning, 0, bp, 0).derived;
    const e = d.energy;
    const boost = e.engineDraw * (1 + et.boostDraw * (d.boostDrain ?? 1));
    const flag = lasts(e.max, e.spare, e.engineDraw + e.weaponDraw) < 12 || e.spare < e.engineDraw * 0.8 ? '  ⚠' : '';
    console.log(`${f.replace('.json', '').padEnd(24)} ${String(e.max).padStart(6)} ${e.spare.toFixed(0).padStart(6)} ${e.engineDraw.toFixed(0).padStart(7)} ${e.weaponDraw.toFixed(0).padStart(6)}  `
      + `${fmt(lasts(e.max, e.spare, e.engineDraw))} ${fmt(lasts(e.max, e.spare, e.engineDraw + e.weaponDraw))} ${fmt(lasts(e.max, e.spare, boost))} ${fmt(lasts(e.max, e.spare, e.weaponDraw))}${flag}`);
  }
}
