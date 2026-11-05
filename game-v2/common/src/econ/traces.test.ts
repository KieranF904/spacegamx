import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { accrueTraces, releaseTraces, traceYield, type TraceLedger } from './traces.js';
import type { MiningTable } from './mining.js';

const mining = JSON.parse(readFileSync(join(__dirname, '../../../data/mining.json'), 'utf-8')) as MiningTable;
const traces = mining.traces!;

describe('rare traces', () => {
  it('come at the table rate for the rock tier: none from tier 1, more the deeper you go', () => {
    expect(traceYield(traces, 'copper_ore', { tier: 1, seam: false })).toEqual({});
    expect(traceYield(traces, 'copper_ore', { tier: 2, seam: false }).aurum).toBeCloseTo(0.002);
    expect(traceYield(traces, 'copper_ore', { tier: 5, seam: false }).aurum).toBeCloseTo(0.02);
    // Gem seams triple voidglass; singularity dust only from the mega rocks
    expect(traceYield(traces, 'crystal', { tier: 3, seam: true }).voidglass).toBeCloseTo(0.012);
    expect(traceYield(traces, 'neutronium_ore', { tier: 5, seam: false }).singularity_dust).toBeUndefined();
    expect(traceYield(traces, 'neutronium_ore', { tier: 5, seam: false, traceMul: 3 }).singularity_dust).toBeCloseTo(0.015);
  });

  it('are a rate, not a roll: 1,000 units of tier-4 copper refined give exactly 12 aurum, whatever the batch sizes', () => {
    for (const batches of [[1000], [100, 400, 500], Array(40).fill(25)]) {
      const ledger: TraceLedger = {};
      accrueTraces(ledger, traces, 'copper_ore', 1000, { tier: 4, seam: false });
      let aurum = 0;
      for (const n of batches) aurum += releaseTraces(ledger, traces, { copper_ore: n }).aurum ?? 0;
      expect(aurum).toBe(12);
      expect(ledger.aurum).toBeUndefined();
    }
  });

  it('pay out in proportion to the carrier ore refined, the fraction carried over', () => {
    const ledger: TraceLedger = {};
    accrueTraces(ledger, traces, 'copper_ore', 500, { tier: 5, seam: false });
    expect(releaseTraces(ledger, traces, { copper_ore: 250 }).aurum).toBe(5);
    // Other ore releases nothing
    expect(releaseTraces(ledger, traces, { iron_ore: 500 })).toEqual({});
    expect(releaseTraces(ledger, traces, { copper_ore: 250 }).aurum).toBe(5);
  });
});
