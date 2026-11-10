/**
 * @contract client.hangar.stats-simple
 * owns:       the hangar's right-hand ship section in Simple mode: top speed, turn, firepower, hull (and shield), power balance
 * needs:      HangarHost (deps, derived, bp, unsaved, overlays, deltaNow), shipSummary, build/simpleStats, build/statDelta (flowOf)
 * invariants: every row carries its data-sd span, so the stat-delta chips fill in as in Advanced — client/src/ships/hangar/hangarViews.test.ts
 * extend:     a stat kept in Simple is one row here and one key in build/simpleStats.ts
 */

import { shipSummary } from '../shipSummary';
import { flowOf } from '../build/statDelta';
import { powerBalance } from '../build/simpleStats';
import type { HangarHost } from './host';

/** The five stats a new pilot needs, plus a button for the power flow overlay (U) */
export function simpleSummaryHtml(host: HangarHost): string {
  const { catalog, tuning, econ } = host.deps;
  const now = shipSummary(catalog, tuning, econ, host.bp);
  if (!now) return '<div style="color:#8ea0bd; margin-bottom:10px">Place a core to see what this ship can do.</div>';
  const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');
  const row = (label: string, value: string, sd: string, tip = '') =>
    `<div style="display:flex; justify-content:space-between; gap:8px; padding:4px 0; border-bottom:1px solid #18223a" title="${tip}"><span style="color:#8ea0bd">${label}</span><span><b style="color:#e5ecf7">${value}</b><span data-sd="${sd}"></span></span></div>`;
  let html = `<div style="color:#ffb547; font-weight:bold; margin-bottom:6px; letter-spacing:1px">SHIP</div>`;
  html += row('Top speed', `${n0(now.topSpeed)} m/s`, 'topSpeed', 'Flat out, without boost');
  html += row('Turn', Number.isFinite(now.turn180) ? `${now.turn180.toFixed(1)} s` : "can't turn", 'turn180', 'Seconds for a half turn');
  html += row('Firepower', `${n0(now.dps)} dmg/s`, 'dps', `${now.guns} gun${now.guns === 1 ? '' : 's'}`);
  html += row('Hull', `${n0(now.hull)} hp`, 'hull', 'Every part\'s hit points together');
  if (now.shield > 0 || host.deltaNow?.lines.some((l) => l.key === 'shield')) html += row('Shield', n0(now.shield), 'shield');
  if (host.derived) {
    const f = flowOf(host.derived), p = powerBalance(f.made, f.drawn, f.gens);
    html += row('Power', `<span style="color:${p.short ? '#f87171' : '#4ade80'}">${p.text}</span>${p.short ? ` <span style="color:#f87171; font-size:11px">· ${p.short}</span>` : ''}`, 'power', 'What your generators make against what the ship uses flat out');
  }
  const on = host.overlays.energy;
  html += `<div style="display:flex; justify-content:flex-end; padding:6px 0"><button data-act="energy" style="background:${on ? '#24406b' : '#0f1626'}; color:#cfd8e6; border:1px solid ${on ? '#5fd4c4' : '#2a3a5a'}; border-radius:4px; padding:2px 8px; cursor:pointer; font-size:11px" title="Show how power flows through the ship (U)">${on ? 'Power flow ✓' : 'Show power flow'}</button></div>`;
  return html + '<div style="margin-bottom:8px"></div>';
}
