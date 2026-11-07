/**
 * Station tab: Quartermasters.
 *
 * Owns: the faction quartermasters' standing bars and stock, and the Buy button (vendorBuy); the vendors reply lands in setVendors.
 * Needs: StationCtx (the pilot, the station id, send/sound).
 * Extend: a new stock detail goes in the row html inside render().
 */

import {
  ServerVendorsMessage, RARITY_COLOR,
} from '@space-game/common';
import { itemTipHtml, showTip, hideTip } from '../windowKit';
import { itemIcon } from '../itemIcons';
import { esc } from './shared';
import type { StationCtx } from './shared';

export class VendorsTab {
  constructor(private c: StationCtx) {}
  private get d() { return this.c.d; }
  private get st() { return this.c.st; }
  vendorsMsg: ServerVendorsMessage | null = null;
  render(b: HTMLElement): void {
    const m = this.vendorsMsg;
    if (!m || m.station !== this.st?.id) { b.innerHTML = '<div class="sgw-empty">Calling the quartermasters…</div>'; return; }
    const items = this.d.pilot.econ.items;
    const wrap = document.createElement('div');
    wrap.style.cssText = `display:grid; grid-template-columns: repeat(${Math.min(2, m.vendors.length)}, 1fr); gap:14px;`;
    for (const v of m.vendors) {
      const col = document.createElement('div');
      col.className = 'sgw-col';
      const toNext = v.next !== undefined ? Math.max(0, Math.min(100, ((v.standing - [0, 5, 15, 35, 70, 120][Math.max(0, v.rank)]) / Math.max(1, v.next - [0, 5, 15, 35, 70, 120][Math.max(0, v.rank)])) * 100)) : 100;
      col.innerHTML = `<h4>${esc(v.name)}<span class="r">${esc(v.rankName)} · standing ${v.standing}${v.discount ? ` · ${Math.round(v.discount * 100)}% off` : ''}</span></h4>
        <div style="color:#8394ad; font-size:12px; margin-bottom:4px">${esc(v.description)}</div>
        <div class="sgw-bar"><i style="width:${toNext}%"></i></div>
        <div style="color:#8394ad; font-size:11px; margin:-6px 0 8px">${v.next !== undefined ? `${v.next - v.standing} more standing to ${esc(v.nextName ?? '')}: their jobs and bounties pay it` : 'The highest rank they give'}</div>`;
      for (const s of v.stock) {
        const d = items.get(s.item);
        const row = document.createElement('div');
        row.style.cssText = `display:flex; align-items:center; gap:10px; padding:6px 4px; border-bottom:1px solid rgba(140,170,220,0.07); opacity:${s.locked ? 0.55 : 1}`;
        row.innerHTML = `<img src="${itemIcon(this.d.pilot.econ, s.item)}" style="width:32px; height:32px; flex-shrink:0">
          <div style="flex:1; min-width:0"><div style="color:${d ? RARITY_COLOR[d.rarity] : '#ccc'}">${esc(items.name(s.item))}</div>
          <div style="color:#8394ad; font-size:11px">${s.locked ? `🔒 needs ${esc(s.rankName)}` : `<span class="sgw-credits">${s.price.toLocaleString()} cr</span>`}</div></div>`;
        row.addEventListener('mousemove', (e) => showTip(itemTipHtml(this.d.pilot.econ, s.item, { count: this.c.have(s.item) }), e.clientX, e.clientY));
        row.addEventListener('mouseleave', hideTip);
        if (!s.locked) {
          const btn = document.createElement('button');
          btn.className = 'sgw-btn primary';
          btn.style.padding = '5px 10px';
          btn.textContent = 'Buy';
          if (this.d.pilot.credits < s.price) btn.classList.add('off');
          btn.onclick = () => { this.d.send({ type: 'vendorBuy', faction: v.faction, item: s.item, n: 1 }); this.d.sound('credits', 0.6); };
          row.appendChild(btn);
        }
        col.appendChild(row);
      }
      wrap.appendChild(col);
    }
    if (!m.vendors.length) wrap.innerHTML = '<div class="sgw-empty">No quartermasters here.</div>';
    b.appendChild(wrap);
  }
}
