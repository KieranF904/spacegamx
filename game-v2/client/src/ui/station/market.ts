/**
 * Station tab: Market.
 *
 * Owns: the sell and buy columns, the market-cycle strip (wanted, glutted), the sell filter, and the where-pays-more scan (asked at most every 20 s; the reply lands in setScan).
 * Needs: StationCtx (the pilot, the station message, send/sound, render to redraw).
 * Extend: a new row tag goes in marketRow(); a new request type is a send() in the row buttons.
 */

import {
  ServerMarketScanMessage, Bag, buyPrice, RARITY_COLOR, unitSellPrice, saleTotal,
} from '@space-game/common';
import { itemTipHtml, showTip, hideTip } from '../windowKit';
import { itemIcon } from '../itemIcons';
import { esc } from './shared';
import type { StationCtx } from './shared';

export class MarketTab {
  constructor(private c: StationCtx) {}
  private get d() { return this.c.d; }
  private get st() { return this.c.st; }
  // Market
  private sellFilter = '';
  scan: ServerMarketScanMessage | null = null;
  /** performance.now() of the last scan request; 0 asks again on the next render */
  scanAsked = 0;
  render(b: HTMLElement): void {
    const p = this.d.pilot;
    const items = p.econ.items;
    const st = this.st!;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr; gap:14px; height: min(560px, calc(100vh - 230px));';

    // Sell: everything you have
    const sellCol = document.createElement('div');
    sellCol.className = 'sgw-col';
    sellCol.innerHTML = `<h4>Sell <span class="r">from cargo, then storage</span></h4>`;
    const oreInHold = p.cargo.filter((s) => items.get(s.id)?.category === 'mineral').reduce((t, s) => t + s.n, 0);
    // This market cycle: what's wanted here, and what's glutted
    const cyc = document.createElement('div');
    cyc.style.cssText = 'grid-column: 1 / -1; display:flex; flex-wrap:wrap; gap:6px 14px; align-items:center; color:#a9b6c9; font-size:12px; padding:2px 2px 4px;';
    const mins = Math.round((st.cycleEndsIn ?? 0) / 60000);
    const chips = (ids: string[] | undefined, color: string) => (ids ?? []).map((id) => `<span style="color:${color}; border:1px solid ${color}55; border-radius:999px; padding:1px 8px">${esc(items.name(id))} ${Math.round(((st.demand[id] ?? 1) - 1) * 100) > 0 ? '+' : ''}${Math.round(((st.demand[id] ?? 1) - 1) * 100)}%</span>`).join('');
    cyc.innerHTML = `<b style="color:#86efac">WANTED HERE</b>${chips(st.wanted, '#86efac') || '<span>nothing special</span>'}<b style="color:#fca5a5; margin-left:8px">OVERSUPPLIED</b>${chips(st.glut, '#fca5a5') || '<span>nothing</span>'}`
      + `<span style="margin-left:auto; color:#8394ad">Prices change in ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`} · selling a lot of one thing lowers its price for a while</span>`;
    grid.appendChild(cyc);
    grid.style.gridTemplateRows = 'auto 1fr';
    if (oreInHold) {
      const all = document.createElement('button');
      all.className = 'sgw-btn good';
      all.style.marginBottom = '8px';
      const worth = p.cargo.filter((s) => items.get(s.id)?.category === 'mineral').reduce((t, s) => t + saleTotal(items, s.id, s.n, st.demand[s.id] ?? 1, st.sat?.[s.id] ?? 0), 0);
      all.textContent = `Sell all ore in your cargo (${oreInHold}) · ${worth.toLocaleString()} cr`;
      all.onclick = () => { this.d.send({ type: 'marketSellAll' }); this.d.sound('sell', 0.6); };
      sellCol.appendChild(all);
    }
    const search = document.createElement('input');
    search.className = 'sgw-input';
    search.placeholder = 'Filter…';
    search.value = this.sellFilter;
    search.style.marginBottom = '8px';
    search.oninput = () => { this.sellFilter = search.value; listSell(); };
    const sellList = document.createElement('div');
    sellList.style.cssText = 'overflow-y:auto; flex:1;';
    sellCol.append(search, sellList);
    const merged: Bag = {};
    for (const s of [...p.cargo, ...p.storage]) merged[s.id] = (merged[s.id] ?? 0) + s.n;
    const here = (id: string) => unitSellPrice(items, id, st.demand[id] ?? 1, st.sat?.[id] ?? 0);
    const listSell = () => {
      const q = this.sellFilter.trim().toLowerCase();
      const ids = Object.keys(merged).filter((id) => !q || items.name(id).toLowerCase().includes(q))
        .sort((a, b) => here(b) * merged[b] - here(a) * merged[a]);
      sellList.replaceChildren(...ids.map((id) => this.marketRow(id, merged[id], here(id), 'sell', st.demand[id])));
      if (!ids.length) sellList.innerHTML = '<div class="sgw-empty">Nothing to sell</div>';
    };
    listSell();
    // Where pays more (asked now and then)
    const ids = Object.keys(merged).filter((id) => (items.get(id)?.value ?? 0) > 0);
    if (ids.length && performance.now() - this.scanAsked > 20000) {
      this.scanAsked = performance.now();
      this.d.send({ type: 'marketScan', items: ids });
    }

    const buyCol = document.createElement('div');
    buyCol.className = 'sgw-col';
    buyCol.innerHTML = `<h4>Buy <span class="r">delivered to storage</span></h4>`;
    const buyList = document.createElement('div');
    buyList.style.cssText = 'overflow-y:auto; flex:1;';
    buyList.replaceChildren(...st.sells.map((id) => this.marketRow(id, this.c.have(id), buyPrice(items, id), 'buy')));
    if (!st.sells.length) buyList.innerHTML = '<div class="sgw-empty">This station has nothing for sale</div>';
    buyCol.append(buyList);
    grid.append(sellCol, buyCol);
    b.append(grid);
  }

  private marketRow(id: string, have: number, price: number, mode: 'sell' | 'buy', demand?: number): HTMLElement {
    const items = this.d.pilot.econ.items;
    const d = items.get(id);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:6px 4px; border-bottom:1px solid rgba(140,170,220,0.07);';
    const img = document.createElement('img');
    img.src = itemIcon(this.d.pilot.econ, id);
    img.style.cssText = 'width:34px; height:34px; flex-shrink:0;';
    const name = document.createElement('div');
    name.style.cssText = 'flex:1; min-width:0;';
    const st = this.st!;
    const wanted = mode === 'sell' && st.wanted?.includes(id), glut = mode === 'sell' && st.glut?.includes(id);
    let tag = demand && demand !== 1 ? ` <small style="color:${demand > 1 ? '#86efac' : '#fca5a5'}">${wanted ? 'WANTED ' : glut ? 'OVERSUPPLIED ' : ''}${demand > 1 ? '+' : ''}${Math.round((demand - 1) * 100)}%</small>` : '';
    const sat = mode === 'sell' ? st.sat?.[id] ?? 0 : 0;
    const base = mode === 'sell' ? unitSellPrice(items, id, demand ?? 1, 0) : price;
    if (sat > 0 && base > 0 && price < base * 0.97) tag += ` <small style="color:#fbbf24" title="Lots sold here lately. The price recovers over the next half hour or so">sold a lot −${Math.round((1 - price / base) * 100)}%</small>`;
    // Better prices elsewhere
    const best = mode === 'sell' ? this.scan?.best[id]?.[0] : undefined;
    const elsewhere = best && best.price > price * 1.08 ? ` · <span style="color:#7dd3fc" title="${esc(this.scan!.best[id].map((b) => `${b.name} (${b.system}): ${b.price} cr`).join('\n'))}">pays ${best.price} at ${esc(best.name)}</span>` : '';
    name.innerHTML = `<div style="color:${d ? RARITY_COLOR[d.rarity] : '#ccc'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(items.name(id))}${tag}</div>`
      + `<div style="color:#8394ad; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${mode === 'sell' ? `have ${have}` : have ? `you have ${have}` : '&nbsp;'} · <span class="sgw-credits">${price.toLocaleString()} cr</span> each${elsewhere}</div>`;
    row.append(img, name);
    row.addEventListener('mousemove', (e) => showTip(itemTipHtml(this.d.pilot.econ, id, { count: have }), e.clientX, e.clientY));
    row.addEventListener('mouseleave', hideTip);
    const amounts = mode === 'sell' ? [1, 10, have] : [1, 5, 20];
    for (const n of [...new Set(amounts)].filter((n) => n > 0 && (mode === 'buy' || n <= have))) {
      const btn = document.createElement('button');
      btn.className = 'sgw-btn' + (mode === 'sell' ? '' : ' primary');
      btn.style.padding = '5px 9px';
      const all = mode === 'sell' && n === have && have > 10;
      btn.textContent = all ? `All` : `${mode === 'sell' ? 'Sell' : 'Buy'} ${n}`;
      btn.title = `${(mode === 'sell' ? saleTotal(items, id, n, demand ?? 1, this.st?.sat?.[id] ?? 0) : price * n).toLocaleString()} cr`;
      if (mode === 'buy' && this.d.pilot.credits < price * n) btn.classList.add('off');
      btn.onclick = () => {
        this.d.send(mode === 'sell' ? { type: 'marketSell', id, n } : { type: 'marketBuy', id, n });
        this.d.sound(mode === 'sell' ? 'sell' : 'credits', 0.6);
      };
      row.appendChild(btn);
    }
    return row;
  }
}
