import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { asteroidComposition, makeAsteroidParams, outlierScale, registerRockTypes, type Bag, type MiningTable } from '@space-game/common';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { Mining, type MiningHost } from './Mining.js';

const files = readGameDataFiles(join(__dirname, '../../../data'));
const table = files.mining as unknown as MiningTable;
registerRockTypes(table);

function host() {
  const calls = { crumbled: [] as number[], shed: [] as { eid: number; stage: number; size: number; left: number }[], respawned: 0, ore: 0 };
  const h: MiningHost = {
    spawnChunk: (_s, _x, _y, _vx, _vy, items: Bag) => { calls.ore += Object.values(items).reduce((a, b) => a + b, 0); },
    awardXp: () => {}, notify: () => {}, tick: () => 0,
    respawn: () => { calls.respawned++; },
    crumble: (eid) => { calls.crumbled.push(eid); m.onBroken(eid, 0, 0); },
    shed: (eid, stage, size, left) => { calls.shed.push({ eid, stage, size, left }); },
  };
  const m = new Mining(h, table);
  return { m, calls };
}

const LASER = { yield: 1, hardness: 3 };

describe('outlier asteroids', () => {
  it('about one rock in 130 is an outlier, several times the size, the same on every side', () => {
    let n = 0;
    const N = 40000;
    for (let i = 0; i < N; i++) if (outlierScale('seed', 'sol', 0, i, 'asteroid_metal')) n++;
    expect(n / N).toBeGreaterThan(0.005);
    expect(n / N).toBeLessThan(0.01);
    // Found one: its params come out big, flagged, and identical each time (client and server derive them alike)
    let i = 0;
    while (!outlierScale('seed', 'sol', 0, i, 'asteroid_ice')) i++;
    const belt = { innerRadius: 1000, outerRadius: 2000, count: 10 };
    const a = makeAsteroidParams('sol', i, 'seed', 0, belt), b = makeAsteroidParams('sol', i, 'seed', 0, belt);
    expect(a).toEqual(b);
    expect(a.outlier).toBe(true);
    expect(a.size).toBeGreaterThan(80 * 2.5 * 3);
    // An ordinary neighbour is just as it was before outliers
    expect(makeAsteroidParams('sol', i + 1, 'seed', 0, belt).outlier).toBeUndefined();
    // Comets and gas pockets never are
    expect(outlierScale('seed', 'sol', 0, i, 'comet')).toBe(0);
  });

  it('most are a lump of common ore', () => {
    let common = 0, ordinary = 0;
    for (let k = 0; k < 200; k++) {
      const big = asteroidComposition(table, 'rock_cobaltite', `sol:${k}:0`, 1000, 1, 0);
      const usual = asteroidComposition(table, 'rock_cobaltite', `sol:${k}:0`, 1000, 1);
      common += big.ores.iron_ore;
      ordinary += usual.ores.iron_ore;
      expect(big.stage).toEqual({ at: 0, of: table.outliers!.stages.length });
      expect(usual.stage).toBeUndefined();
    }
    expect(common).toBeGreaterThan(ordinary * 1.8);
  });

  it('is mined down a stage at a time, each a smaller rock with the ore left, until the last breaks up', () => {
    const { m, calls } = host();
    const stages = table.outliers!.stages;
    const whole = 1000;
    const units = (s: number) => Math.max(3, Math.round(whole * s * table.unitsPerSize));
    let eid = 1, left: number | undefined;
    for (let stage = 0; stage < stages.length; stage++) {
      m.register(eid, 0, 7, 'asteroid_metal', 'sol:7:0', whole * stages[stage], 1, { stage, wholeSize: whole, left });
      expect(m.remaining(eid)).toBe(units(stages[stage]));
      // Mine it hard: it gives only its stage's share, then breaks away
      for (let k = 0; k < 400 && !calls.crumbled.includes(eid); k++) m.extract(eid, 99, 200, LASER, 0, 0, 1, 0);
      expect(calls.crumbled).toContain(eid);
      if (stage + 1 < stages.length) {
        const s = calls.shed.at(-1)!;
        expect(s).toEqual({ eid, stage: stage + 1, size: whole * stages[stage + 1], left: units(stages[stage + 1]) });
        left = s.left;
        expect(calls.respawned).toBe(0);
      }
      eid++;
    }
    // The last stage broke up like any rock: it grows back later, and nothing was lost on the way
    expect(calls.shed.length).toBe(stages.length - 1);
    m.tick();
    expect(calls.ore).toBeGreaterThanOrEqual(units(1));
  });

  it('blasted apart, a stage still leaves the next (what that can hold of the ore left)', () => {
    const { m, calls } = host();
    m.register(5, 0, 3, 'asteroid_metal', 'sol:3:0', 1000, 1, { stage: 0, wholeSize: 1000 });
    m.onBroken(5, 0, 0);
    expect(calls.shed).toEqual([{ eid: 5, stage: 1, size: 750, left: Math.round(750 * table.unitsPerSize) }]);
  });
});
