/**
 * The hangar's power report for a ports design (common/src/ships/power/ports.ts): what the generators make, what the
 * stores hold, and which parts the routing leaves out (a gun, engine, shield or tool with nothing feeding its in ports, or
 * with one of them open; a generator with a line going nowhere). Pure, so it can be tested; HangarUI shows it. Also the
 * load test's rows (loadRow) and a port's tooltip (portTipHtml), in words.
 */
import type { ShipDerived, PortsLoadResult, PortsScenario, PortsView } from '@space-game/common';
import { PS_CLASH, PS_LINKED, PS_OPEN, PS_SPARE, PS_WASTE, portsView } from '@space-game/common';

type PortsLayout = NonNullable<ShipDerived['ports']>;

export interface PortsReport {
  /** E/s the generators make, E the stores and the core hold, links in the ship */
  supply: number;
  store: number;
  links: number;
  /** Consumers with no line in at all (they get no power) */
  unfed: number[];
  /** Consumers fed on some in ports, with others open (they get less than they could take) */
  partly: number[];
  /** Generators with an out port facing nothing (that line's power is lost) */
  wasting: number[];
  /** Pairs of parts whose ports clash (two outs or two ins face each other), once a pair: [a, b, dir] */
  clashing: [number, number, 0 | 1][];
}

export function portsReport(L: PortsLayout): PortsReport {
  const unfed: number[] = [], partly: number[] = [], wasting: number[] = [];
  const consumers = [...L.weapons, ...L.thrusters, ...L.tools].sort((a, b) => a - b);
  for (const p of consumers) {
    const linked = L.inStart[p + 1] - L.inStart[p] > 0;
    if (!linked) unfed.push(p);
    else if (L.openIn[p]) partly.push(p);
  }
  for (const g of L.gens) if (L.openOut[g]) wasting.push(g);
  const clashing: [number, number, 0 | 1][] = [];
  for (const p of portsView(L).ports) if (p.state === PS_CLASH && p.part < p.to) clashing.push([p.part, p.to, p.dir]);
  return { supply: L.supply, store: L.gaugeMax / 256, links: L.links, unfed, partly, wasting, clashing };
}

/** The report's warnings, in plain words (name: a part's display name by index) */
export function portsWarnings(r: PortsReport, name: (i: number) => string): string[] {
  return [
    ...r.unfed.map((i) => `${name(i)} has no power: nothing feeds its in port`),
    ...r.partly.map((i) => `${name(i)} has an open in port: it gets less than it could take`),
    ...r.wasting.map((i) => `${name(i)} gives into nothing on one side: that line is wasted`),
    ...r.clashing.map(([a, b, dir]) => `${name(a)} and ${name(b)} clash: two ${dir === 1 ? 'outs' : 'ins'} face each other and nothing crosses`),
  ];
}

// ---- The ports load test and the port tooltip, in words (common power/portsLoadTest.ts, power/portStates.ts)

/** The load test's scenarios as the POWER panel names them */
export const SCENARIO_LABEL: Record<PortsScenario, string> = { fire: 'Firing, cruising', boost: 'Boosting', both: 'Boosting and firing' };

export interface LoadRow {
  scenario: PortsScenario;
  label: string;
  /** What happens, in a few words, and its tone */
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'dim';
  /** The stores, in a few words */
  stores: string;
}

const secs = (t: number) => `${t.toFixed(t < 10 ? 1 : 0)} s`;
const pctText = (v: number) => `${Math.round(v * 100)}%`;

/** One POWER panel row from a scenario's result: full power throughout, or how long, then the share each kind settles to */
export function loadRow(r: PortsLoadResult, name: (i: number) => string): LoadRow {
  const label = SCENARIO_LABEL[r.scenario];
  const any = r.used.some((u) => u === 1);
  const stores = r.storeEmptyAt >= 0 ? `stores empty at ${secs(r.storeEmptyAt)}` : r.storeLow < 99.5 ? `stores hold ${r.seconds} s+ (down to ${Math.round(r.storeLow)}%)` : 'stores stay full';
  if (!any) return { scenario: r.scenario, label, text: 'nothing to run', tone: 'dim', stores };
  if (r.firstBrown < 0) return { scenario: r.scenario, label, text: `full power for ${r.seconds} s+`, tone: 'ok', stores };
  const kinds: string[] = [];
  if (r.guns < 0.995) kinds.push(`guns ${pctText(r.guns)}`);
  if (r.engines < 0.995) kinds.push(`engines ${pctText(r.engines)}`);
  if (r.tools < 0.995) kinds.push(`tools ${pctText(r.tools)}`);
  const worst = Math.min(r.guns, r.engines, r.tools);
  const lead = r.firstBrown < 0.05 ? `${name(r.firstPart)} short from the start` : `full power ${secs(r.firstBrown)}, ${name(r.firstPart)} short first`;
  return { scenario: r.scenario, label, text: kinds.length ? `${lead}; then ${kinds.join(' · ')}` : `${lead}; it catches up`, tone: worst < 0.5 ? 'bad' : 'warn', stores };
}

export interface PortTipCtx {
  name(i: number): string;
  /** The link's average E/s in the chosen scenario, and that scenario's label (no load test: omitted) */
  flow?: (link: number) => number;
  scenario?: string;
}
const STATE_WORDS: Record<number, [string, string]> = {
  [PS_LINKED]: ['Linked', '#4ade80'],
  [PS_OPEN]: ['Open', '#f87171'],
  [PS_WASTE]: ['Wasted', '#fb923c'],
  [PS_CLASH]: ['Clash', '#f87171'],
  [PS_SPARE]: ['Spare', '#94a3b8'],
};
const tipRow = (k: string, v: string) => `<div style="display:flex; justify-content:space-between; gap:12px; padding:2px 0; border-bottom:1px solid #18223a"><span style="color:#8ea0bd">${k}</span><b style="color:#e5ecf7; font-weight:600; text-align:right">${v}</b></div>`;
const escT = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A port's tooltip: whose, which way, its rating, what it links to (or why nothing crosses), and the flow on it in the load test */
export function portTipHtml(v: PortsView, k: number, c: PortTipCtx): string {
  const p = v.ports[k], [word, col] = STATE_WORDS[p.state], own = escT(c.name(p.part));
  const kind = p.aug ? 'Augment input' : p.dir === 1 ? 'Out port' : 'In port';
  let html = `<div style="display:flex; gap:6px; align-items:center"><span style="width:9px; height:9px; border-radius:2px; flex:none; background:${p.dir === 1 ? '#fbbf24' : '#60a5fa'}"></span><b style="color:#e5ecf7">${kind}</b><span style="color:#8ea0bd">· ${own}</span></div>`;
  html += `<div style="color:${col}; font-size:11px; margin:1px 0 5px">${word}</div>`;
  html += tipRow('Rated', `${Math.round(p.rate)} E/s`);
  const other = p.to >= 0 ? escT(c.name(p.to)) : '';
  if (p.state === PS_LINKED) {
    const l = v.links[p.link];
    html += tipRow(p.dir === 1 ? 'Gives to' : 'Takes from', other);
    if (l) html += tipRow('Link carries', `up to ${Math.round(l.cap)} E/s`);
    if (l && c.flow) {
      const f = c.flow(l.id), u = l.cap > 0 ? f / l.cap : 0;
      html += tipRow(`Flow${c.scenario ? ` (${escT(c.scenario.toLowerCase())})` : ''}`, `<span style="color:${u > 0.98 ? '#fbbf24' : '#e5ecf7'}">${f < 10 ? f.toFixed(1) : Math.round(f)} E/s · ${Math.round(u * 100)}%</span>`);
    }
  } else if (p.state === PS_CLASH) {
    html += `<div style="margin-top:5px; color:#fca5a5">It faces ${other}'s ${p.dir === 1 ? 'out' : 'in'} port: two ${p.dir === 1 ? 'outs' : 'ins'} on one edge pass nothing. Turn one of them (R) or mirror it (F).</div>`;
  } else if (p.state === PS_OPEN) {
    html += `<div style="margin-top:5px; color:#fca5a5">Nothing feeds it: the ${own} is short up to ${Math.round(p.rate)} E/s. Put a generator's or a store's out port against this edge.</div>`;
  } else if (p.state === PS_WASTE) {
    html += `<div style="margin-top:5px; color:#fdba74">It gives into nothing: up to ${Math.round(p.rate)} E/s is lost. Face it into a store's, a line's or a consumer's in port.</div>`;
  } else {
    html += `<div style="margin-top:5px; color:#94a3b8">Nothing across: power stays where it is. Free for another line.</div>`;
  }
  return html;
}
