/**
 * Mining cadence: how often drops come and how much ore, for a starter's guns and a Mk I mining laser on Sol's Mk I
 * rock (steady fire, no travel or aim: the mining itself). Reads data/mining.json as it is.
 *
 *   npx tsx src/bench/miningCadence.ts
 *
 * Prints, per rig: the mean time between drops and ore a second on a big rock, the time to the first drop on a fresh
 * rock (mean and median of 400), and how long a typical Sol Chondrite (size 25, 52, 80) lasts and what it gives.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { registerRockTypes, type Bag, type MiningTable } from '@space-game/common';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { Mining, type MiningHost, type MiningTool } from '../game/Mining.js';
import { PayoutDice } from '../game/payoutDice.js';

const here = dirname(fileURLToPath(import.meta.url));
const table = readGameDataFiles(join(here, '../../../data')).mining as unknown as MiningTable;
registerRockTypes(table);

interface Rig { name: string; guns: { tool: MiningTool; dps: number; hit: number }[] }
const gun = { yield: table.tools.fixed.yield, hardness: 1 };
const RIGS: Rig[] = [
  { name: "Starter's 2 Pips (112 dps)", guns: [{ tool: gun, dps: 56, hit: 28 }, { tool: gun, dps: 56, hit: 28 }] },
  { name: 'Mk I mining laser (42 dps)', guns: [{ tool: { yield: table.tools.miner.yield, hardness: 2, grade: 1 }, dps: 42, hit: 42 / 60 }] },
];

/** Mine rock `eid` (registered by `setup`) with `rig` until `stop` or `seconds`: drop times (s) and ore */
function run(rig: Rig, size: number, seconds: number, rocks = 1, seed = 'cadence') {
  let t = 0, gone = false;
  const drops: { at: number; ore: number }[] = [];
  const h: MiningHost = {
    spawnChunk: (_s, _x, _y, _vx, _vy, items: Bag) => { drops.push({ at: t / 60, ore: Object.values(items).reduce((a, b) => a + b, 0) }); },
    awardXp: () => {}, notify: () => {}, tick: () => t, respawn: () => {}, crumble: () => { gone = true; }, rockTier: () => 1,
  };
  const out: { drops: typeof drops; life: number }[] = [];
  for (let k = 0; k < rocks; k++) {
    const m = new Mining(h, table, new PayoutDice(`${seed}:${k}`));
    m.register(1, 0, 0, 'asteroid_metal', `sol:${k}`, size, 1);
    drops.length = 0; gone = false;
    const owed = rig.guns.map(() => 0);
    for (t = 0; t < seconds * 60 && !gone; t++) {
      rig.guns.forEach((g, i) => {
        owed[i] += g.dps / 60;
        while (owed[i] >= g.hit && !gone) { owed[i] -= g.hit; m.extract(1, 99, g.hit, g.tool, 0, 0, 1, 0); }
      });
    }
    out.push({ drops: [...drops], life: t / 60 });
  }
  return out;
}

const f = (n: number, d = 2) => n.toFixed(d);
for (const rig of RIGS) {
  const [big] = run(rig, 1e6, 3000);
  const ore = big.drops.reduce((a, b) => a + b.ore, 0);
  const firsts = run(rig, 1e6, 120, 400, 'first').map((r) => r.drops[0]?.at ?? 120).sort((a, b) => a - b);
  console.log(`\n${rig.name}`);
  console.log(`  big rock: a drop every ${f(3000 / big.drops.length)} s, ${f(ore / 3000, 3)} ore/s (${f((ore / 3000) * 60, 1)} ore/min), ${f(ore / big.drops.length)} ore a drop`);
  console.log(`  first drop on a fresh rock: mean ${f(firsts.reduce((a, b) => a + b, 0) / firsts.length)} s, median ${f(firsts[firsts.length >> 1])} s, 90th ${f(firsts[Math.floor(firsts.length * 0.9)])} s`);
  for (const size of [25, 52, 80]) {
    const rs = run(rig, size, 600, 200, `life${size}`);
    const life = rs.reduce((a, r) => a + r.life, 0) / rs.length, got = rs.reduce((a, r) => a + r.drops.reduce((x, d) => x + d.ore, 0), 0) / rs.length;
    const n = rs.reduce((a, r) => a + r.drops.length, 0) / rs.length;
    console.log(`  Chondrite size ${size} (${Math.round(size * table.unitsPerSize)} units): mined out in ${f(life, 1)} s, ${f(got, 1)} ore in ${f(n, 1)} drops`);
  }
}
