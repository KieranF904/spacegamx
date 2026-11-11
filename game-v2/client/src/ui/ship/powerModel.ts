/**
 * @contract client.ui.ship.power-model
 * owns:       the Ship window's Power tab and the HUD's power margin, worked out from the ports core the client already
 *             has: per generator its output against what it gives flat out, the stores' charge, the parts starved
 *             (no line in, short flat out in the load test, or short now), whether firing everything browns out, and
 *             the margin now (supply less the steady loads and what the keys ask of the engines and guns)
 * needs:      common power (ShipDerived.ports PortsLayout, PortsState, portsLoadTestCached, roles), ships/portsReport
 *             (portsReport, loadRow); no server message: everything is the layout, the predicted state and the load test
 * invariants: a sparrow's two reactors give 70/s between them; a part with no line in is starved; the margin is
 *             supply less the steady loads and the active draws, negative when the keys ask more than the generators
 *             make — client/src/ui/ship/powerModel.test.ts
 * extend:     a new row kind is one more field on PowerSummary filled in powerSummary()
 */

import {
  P_RELAY, P_TOOL, P_WEAPON, TK_ENGINE, portsLoadTestCached,
  type Charge, type PortsLayout, type ShipDerived,
} from '@space-game/common';
import { loadRow, portsReport, type LoadRow } from '../../ships/portsReport';

/** eu a tick to E a second */
const eps = (euTick: number): number => (euTick * 60) / 256;

export interface GenRow {
  part: number;
  name: string;
  /** E/s its lines can carry out of it */
  output: number;
  /** E/s it gives with everything running (the load test: boosting, dodging, firing) */
  draw: number;
  /** draw / output, 0..1 */
  load: number;
}

export interface StoreRow {
  part: number;
  name: string;
  /** E held, E it holds full, 0..1 */
  held: number;
  cap: number;
  fill: number;
}

export interface StarvedRow {
  part: number;
  name: string;
  /** Why: no line in at all, short flat out (its settled share), or short now */
  why: 'unfed' | 'flatOut' | 'now';
  /** Its share (0..1) */
  share: number;
}

export interface PowerSummary {
  /** E/s the generators make */
  supply: number;
  gens: GenRow[];
  stores: StoreRow[];
  /** The stores together, % */
  gauge: number;
  starved: StarvedRow[];
  /** Firing everything (and cruising): does it brown out, and the load test's row */
  fire: LoadRow | null;
  /** Everything at once: boosting, dodging, firing */
  all: LoadRow | null;
  fireBrownout: boolean;
}

/** E/s each generator's out lines carry at most (a touch block's output on its first member) */
function genOutput(L: PortsLayout, g: number): number {
  if (L.touchClus[g] >= 0) return L.touchClus[g] === g ? eps(L.touchOut[g]) : 0;
  let s = 0;
  for (let x = L.outStart[g]; x < L.outStart[g + 1]; x++) s += L.linkCap[L.outLink[x]];
  return eps(s);
}

/**
 * The Power tab's summary. `name(i)`: a part's display name. The load tests are cached per design (common
 * portsLoadTestCached), so a redraw costs a lookup.
 */
export function powerSummary(d: ShipDerived, charge: Charge, name: (i: number) => string): PowerSummary {
  const L = d.ports;
  const e = charge.e;
  const both = portsLoadTestCached(d, 'both');
  const fire = portsLoadTestCached(d, 'fire');
  const gens: GenRow[] = [];
  for (const g of L.gens) {
    const output = genOutput(L, g);
    let draw = 0;
    if (both) for (let x = L.outStart[g]; x < L.outStart[g + 1]; x++) draw += both.flow[L.outLink[x]] ?? 0;
    // (A touch block shares its output over every member's links: summed on its first member)
    if (both && L.touchClus[g] >= 0 && L.touchClus[g] === g) {
      draw = 0;
      for (let m = g; m >= 0; m = L.touchNext[m]) for (let x = L.outStart[m]; x < L.outStart[m + 1]; x++) draw += both.flow[L.outLink[x]] ?? 0;
    }
    if (L.touchClus[g] >= 0 && L.touchClus[g] !== g) continue;
    gens.push({ part: g, name: name(g), output, draw, load: output > 0 ? Math.min(1, draw / output) : 0 });
  }
  const stores: StoreRow[] = [];
  for (const r of L.relays) {
    if (L.role[r] !== P_RELAY || L.carrier[r] || L.cap[r] <= 0) continue;
    const held = e ? e.held[r] : L.cap[r];
    stores.push({ part: r, name: name(r), held: held / 256, cap: L.cap[r] / 256, fill: Math.max(0, Math.min(1, held / L.cap[r])) });
  }
  let gHeld = 0, gCap = 0;
  for (const s of stores) { gHeld += s.held; gCap += s.cap; }
  const starved: StarvedRow[] = [];
  const seen = new Set<number>();
  for (const p of portsReport(L).unfed) { seen.add(p); starved.push({ part: p, name: name(p), why: 'unfed', share: 0 }); }
  // (Short now: a tool (a shield, a machine) that got less than it wanted this tick)
  if (e) for (const t of L.tools) if (!seen.has(t) && e.sat[t] < 255 && (L.shield[t] || L.machine[t] || L.tow[t])) {
    if (L.machine[t] && !(e.mach & (1 << (L.machine[t] - 1)))) continue;
    seen.add(t);
    starved.push({ part: t, name: name(t), why: 'now', share: e.sat[t] / 255 });
  }
  if (both) for (let p = 0; p < L.n; p++) {
    if (seen.has(p) || !both.used[p] || both.end[p] >= 0.995) continue;
    if (L.role[p] !== P_WEAPON && L.role[p] !== P_TOOL && !L.thrusters.includes(p)) continue;
    seen.add(p);
    starved.push({ part: p, name: name(p), why: 'flatOut', share: both.end[p] });
  }
  return {
    supply: L.supply,
    gens,
    stores,
    gauge: gCap > 0 ? (100 * gHeld) / gCap : 100,
    starved,
    fire: fire ? loadRow(fire, name) : null,
    all: both ? loadRow(both, name) : null,
    fireBrownout: !!fire && fire.firstBrown >= 0,
  };
}

/** What the keys ask now (the HUD's margin) */
export interface PowerAsk {
  thrust: boolean;
  boost: boolean;
  firing: boolean;
}

export interface PowerMargin {
  /** E/s spare (negative: a deficit the stores pay) */
  margin: number;
  /** The stores' charge, % */
  gauge: number;
  /** Short now: a deficit with the stores near empty, or a shield going without */
  starved: boolean;
}

/** E/s the engines burn boosting (their boosted burn), cruising (burn) */
function engineBurn(L: PortsLayout, boost: boolean): number {
  let s = 0;
  for (const p of L.thrusters) if (L.thrustKind[p] === TK_ENGINE) s += boost ? L.bBurn[p] : L.burn[p];
  return eps(s);
}

/** The HUD's power margin now: supply less the steady loads (shields, machines at work) and what the keys ask */
export function powerMargin(d: ShipDerived, charge: Charge, ask: PowerAsk): PowerMargin {
  const L = d.ports, e = charge.e;
  let use = L.shieldDraw;
  if (e) for (const t of L.tools) if (L.machine[t] && (e.mach & (1 << (L.machine[t] - 1)))) use += eps(L.rate[t]);
  if (ask.thrust || ask.boost) use += engineBurn(L, ask.boost);
  if (ask.firing) use += L.weaponDraw;
  const margin = L.supply - use;
  let held = 0;
  for (const r of L.relays) if (!L.carrier[r] && L.cap[r] > 0) held += e ? e.held[r] : L.cap[r];
  const gauge = L.gaugeMax > 0 ? Math.min(100, (100 * held) / L.gaugeMax) : 100;
  let shieldShort = false;
  if (e) for (const t of L.tools) if (L.shield[t] && e.sat[t] < 250) { shieldShort = true; break; }
  return { margin, gauge, starved: (margin < 0 && gauge < 5) || shieldShort };
}
