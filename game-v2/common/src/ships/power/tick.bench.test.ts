/**
 * Microbench (not CI): the energy tick's cost on the biggest bundled ships, and no heap growth over 100k ticks.
 * POWER_BENCH=1 npx vitest run common/src/ships/power/tick.bench.test.ts (with NODE_OPTIONS=--expose-gc for the heap check)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../blueprint.js';
import { SHIP_DATA_DIR } from '../testData.js';
import { GUN_BEAM, PHASE_THRUST, PHASE_WEAPON, buildEnergyLayout } from './layout.js';
import { createEnergyState } from './state.js';
import { beamStep, energyTick, gunReady, spendShot } from './tick.js';
import { type PartSpec, blueprintInput, genFn, layoutInput, storeFn } from './testData.js';

const SHIPS = ['enemy/maw_heart_titan.json', 'hammerhead.json', 'bastion-dreadnought.json', 'sparrow-t.json', 'dense'];

/** A worst case: 15 x 15 single cells, every one touching four (generators, Batteries, Pips, Ion Drives, shields) */
function dense(): PartSpec[] {
  const kinds = [genFn('t_gen', 35), storeFn('t_bat', 300, 150, 50), 'cannon_pip', 'engine_ion_drive', storeFn('t_bat', 300, 150, 50), 'shield_deflector'];
  const out: PartSpec[] = [];
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) out.push(['sq', kinds[(x + 2 * y) % kinds.length], x, y, 'N']);
  return out;
}

describe.runIf(process.env.POWER_BENCH)('energy tick bench', () => {
  for (const file of SHIPS) {
    it(file, () => {
      // (the input, rebuild and all, outside the timer: only the layout build is timed)
      const input = file === 'dense' ? layoutInput(dense()) : blueprintInput(parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints', file), 'utf-8')));
      const t0 = performance.now();
      const L = buildEnergyLayout(input);
      const build = performance.now() - t0;
      const e = createEnergyState(L);
      const active = new Uint8Array(L.n);
      for (let x = L.phase[PHASE_THRUST]; x < L.phase[PHASE_THRUST + 1]; x++) active[L.cons[x]] = 1;
      const ctl = { active, boosting: true, toolWant: null, reload: false };
      const wpn = Array.from(L.cons.subarray(L.phase[PHASE_WEAPON], L.phase[PHASE_WEAPON + 1]));
      const step = () => {
        energyTick(L, e, ctl);
        for (let k = 0; k < wpn.length; k++) {
          const p = wpn[k];
          if (L.gun[p] === GUN_BEAM) beamStep(L, e, p, true);
          else if (gunReady(L, e, p)) spendShot(L, e, p);
        }
      };
      for (let t = 0; t < 5000; t++) step();
      const gc = (globalThis as { gc?: () => void }).gc;
      gc?.();
      const heap0 = process.memoryUsage().heapUsed;
      const N = 100000, s = performance.now();
      for (let t = 0; t < N; t++) step();
      const us = ((performance.now() - s) * 1000) / N;
      gc?.();
      const grew = process.memoryUsage().heapUsed - heap0;
      console.log(`${file}: ${L.n} parts, ${L.links} links, build ${build.toFixed(1)} ms, ${us.toFixed(2)} us/tick (with guns), heap ${gc ? '' : '(no gc) '}${(grew / 1024).toFixed(0)} KB`);
      if (gc) expect(grew).toBeLessThan(256 * 1024);
    });
  }
});
