/**
 * The Ship window's Power tab (the ports core: powerModel.ts): each generator's output against what it gives with
 * everything running, the stores' charge, the parts starved, and whether firing everything browns the ship out (the
 * hangar's load test). Replaces the pool-era energy view.
 */
import { setHtml } from '../../domWrite';
import { powerMargin, powerSummary } from '../powerModel';
import { tabRoot, sec, meter, row, note, num, rate, pct, esc } from './view';
import type { ShipTab } from '../shipTabs';

const TONE = { ok: 'sgsw-ok', warn: 'sgsw-warn', bad: 'sgsw-bad', dim: 'sgsw-dim' } as const;
const WHY = { unfed: 'no line in', flatOut: 'short flat out', now: 'short now' } as const;

export function powerTab(): ShipTab {
  let root: HTMLElement | null = null;
  return {
    id: 'power', label: 'Power', title: 'Generators, stores and what runs short', live: 300,
    render(body, ctx) {
      root = tabRoot(body, root, () => document.createElement('div'));
      const ship = ctx.ship();
      if (!ship?.derived.ports) { setHtml(root, note('No ship to show.')); return; }
      const name = (i: number) => ctx.fnName(ship.blueprint.parts[i]?.fn ?? '');
      const p = powerSummary(ship.derived, ctx.charge(), name);
      const inp = ctx.statusInput();
      const m = powerMargin(ship.derived, ctx.charge(), { thrust: !!inp?.thrust.on, boost: !!inp?.thrust.boost, firing: false });
      let html = sec('Now', `${num(p.supply)}/s made`);
      html += row('Spare power', `<b class="${m.starved ? 'sgsw-bad' : m.margin < 0 ? 'sgsw-warn' : 'sgsw-ok'}">${rate(m.margin)}</b>`);
      html += row('Stores', `${Math.round(p.gauge)}%`, meter(p.gauge / 100, p.gauge < 10 ? '#f87171' : '#7dd3fc'));
      if (p.fireBrownout && p.fire) html += note(`Firing everything browns out: ${esc(p.fire.text)}.`, p.fire.tone === 'bad' ? 'sgsw-bad' : 'sgsw-warn');
      else if (p.fire) html += note(`Firing everything: ${esc(p.fire.text)}.`, 'sgsw-ok');

      html += sec('Generators', 'output · given with everything on');
      if (!p.gens.length) html += note('No generator: only the stores give power, until they run dry.', 'sgsw-warn');
      for (const g of p.gens) {
        const hot = g.load >= 0.99;
        html += row(esc(g.name), `${num(g.output)}/s · <span class="${hot ? 'sgsw-warn' : ''}">${num(g.draw)}/s</span>`, meter(g.load, hot ? '#fbbf24' : '#86efac'));
      }

      html += sec('Stores and boost', `${Math.round(p.gauge)}%`);
      if (!p.stores.length) html += note('No stores: what the generators make is used as it comes.');
      for (const s of p.stores) html += row(esc(s.name), `${num(s.held)} / ${num(s.cap)}`, meter(s.fill, s.fill < 0.1 ? '#f87171' : '#7dd3fc'));

      html += sec('Starved', p.starved.length ? `${p.starved.length}` : 'none');
      if (!p.starved.length) html += note('Every part gets its full power, even with everything running.', 'sgsw-ok');
      for (const s of p.starved) html += row(`<span class="sgsw-bad">${esc(s.name)}</span>`, `${WHY[s.why]}${s.why === 'unfed' ? '' : ` · ${pct(s.share)}`}`);

      html += sec('Load test');
      for (const r of [p.fire, p.all]) if (r) html += row(esc(r.label), `<span class="${TONE[r.tone]}">${esc(r.text)}</span>`);
      html += note('Worked out from your design: what each part gets with the guns firing (and the engines boosting) for 12 seconds.');
      setHtml(root, html);
    },
  };
}
