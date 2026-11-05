// Refit player ship plans for the battery rules (common/src/ships/energy.ts): ships whose battery can't
// carry a boost for long turn spare generators into batteries (same shapes, so power routing is unchanged),
// keeping enough generators to fight on (engines thrusting and every gun firing) without draining.
// The starter (sparrow-t) is a test fixture: left as it is.
//   npx vite-node scripts/add-batteries.ts
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createShipState, parseBlueprint, serializeBlueprint, validateBlueprint, loadCatalog, energyTuning, type Blueprint } from '../common/src/index';
import { loadShipConfigFromDisk } from '../server/src/ships/loadShipConfig';

const data = join(__dirname, '../data');
const raw = loadShipConfigFromDisk(data);
const catalog = loadCatalog(raw.catalog, { overlapShrink: raw.tuning.overlapShrink });
const et = energyTuning(raw.tuning);
/** Seconds of boost a refit aims for at least */
const WANT_BOOST = 1.5;

const derive = (bp: Blueprint) => createShipState(catalog, raw.tuning, 0, bp, 0).derived;
const boostSeconds = (bp: Blueprint) => {
  const d = derive(bp), e = d.energy;
  const draw = e.engineDraw * (1 + et.boostDraw * (d.boostDrain ?? 1));
  return draw <= e.spare ? Infinity : e.max / (draw - e.spare);
};

const dir = join(data, 'ships/blueprints');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'sparrow-t.json')) {
  const bp = parseBlueprint(readFileSync(join(dir, f), 'utf8'));
  const before = boostSeconds(bp);
  if (before >= WANT_BOOST) continue;
  // Furthest generators from the core first (the core's neighbours keep feeding it)
  const core = bp.parts.find((p) => p.fn === 'core');
  const gens = bp.parts.filter((p) => p.fn === 'generator')
    .sort((a, b) => Math.hypot(b.x - (core?.x ?? 0), b.y - (core?.y ?? 0)) - Math.hypot(a.x - (core?.x ?? 0), a.y - (core?.y ?? 0)));
  let changed = 0;
  for (const g of gens) {
    if (boostSeconds(bp) >= WANT_BOOST) break;
    g.fn = 'battery';
    const d = derive(bp);
    // Keep enough generators to fight without draining, and a valid design
    if (d.energy.spare < d.energy.engineDraw + d.energy.weaponDraw || !validateBlueprint(catalog, bp, raw.tuning, null).ok) { g.fn = 'generator'; continue; }
    changed++;
  }
  if (!changed) { console.log(`${f}: boost ${before.toFixed(2)}s, no spare generators to convert`); continue; }
  writeFileSync(join(dir, f), serializeBlueprint(bp));
  console.log(`${f}: ${changed} generator(s) → batteries; boost ${before.toFixed(2)}s → ${boostSeconds(bp).toFixed(2)}s`);
}
