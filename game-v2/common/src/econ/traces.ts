/**
 * Rare traces (aurum, voidglass, pale iridium, singularity dust): never mined
 * as such, they come out of their carrier ores at the refinery, at a known
 * rate per 100 units by the tier of the rock the ore came from (data/mining.json
 * traces). A rate, not a roll: each pilot carries a ledger, so two pilots doing
 * the same work end up with the same traces.
 *
 * Mining a carrier ore adds what it will yield to the ledger; refining that
 * ore pays it out, in proportion to the carrier ore refined (whole units, the
 * fraction kept for next time). Ore never remembers which rock it came from;
 * the ledger does that for it.
 */

import type { Bag } from './stacks.js';

export interface TraceDef {
  /** Ores that carry it */
  from: string[];
  /** Units per 100 units of carrier ore, by rock tier (index 0..5) */
  per100: number[];
  /** × this from a rock with a gem seam */
  seamMul?: number;
  /** Only from rocks whose type has a traceMul (the mega rocks) */
  megaOnly?: boolean;
}

/** One trace's account: owed (not yet paid out), the carrier ore it rides in, and the paid-out fraction carried */
export interface TraceAccount { owed: number; ore: number; carry: number }
export type TraceLedger = Record<string, TraceAccount>;

/** Where a unit of ore came from */
export interface TraceSource { tier: number; seam: boolean; traceMul?: number; traceBoost?: Record<string, number> }

/** What one unit of `ore` from this rock will yield at the refinery, per trace */
export function traceYield(traces: Record<string, TraceDef> | undefined, ore: string, src: TraceSource): Bag {
  const out: Bag = {};
  for (const [id, t] of Object.entries(traces ?? {})) {
    if (id.startsWith('_') || !t.from.includes(ore)) continue;
    if (t.megaOnly && !src.traceMul) continue;
    const rate = (t.per100[Math.max(0, Math.min(t.per100.length - 1, src.tier))] ?? 0) / 100;
    const k = rate * (src.traceMul ?? 1) * (src.seam ? t.seamMul ?? 1 : 1) * (src.traceBoost?.[id] ?? 1);
    if (k > 0) out[id] = k;
  }
  return out;
}

/** `units` of `ore` mined from a rock: its traces are owed */
export function accrueTraces(ledger: TraceLedger, traces: Record<string, TraceDef> | undefined, ore: string, units: number, src: TraceSource): void {
  for (const [id, k] of Object.entries(traceYield(traces, ore, src))) {
    const a = (ledger[id] ??= { owed: 0, ore: 0, carry: 0 });
    a.owed += k * units;
    a.ore += units;
  }
}

/** Carrier ores refined (`used`: ore id → units): the share of what's owed that they carried, in whole units */
export function releaseTraces(ledger: TraceLedger, traces: Record<string, TraceDef> | undefined, used: Bag, mul = 1): Bag {
  const out: Bag = {};
  for (const [id, t] of Object.entries(traces ?? {})) {
    const a = ledger[id];
    if (!a || id.startsWith('_')) continue;
    const n = t.from.reduce((s, o) => s + (used[o] ?? 0), 0);
    if (n <= 0 || a.owed <= 0) continue;
    const share = a.ore > 0 ? Math.min(1, n / a.ore) : 1;
    const pay = a.owed * share;
    a.owed -= pay;
    a.ore = Math.max(0, a.ore - n);
    a.carry += pay * mul;
    const whole = Math.floor(a.carry + 1e-9);
    if (whole > 0) { out[id] = whole; a.carry -= whole; }
    if (a.owed < 1e-9 && a.ore === 0 && a.carry < 1e-9) delete ledger[id];
  }
  return out;
}
