/**
 * The pilot's banks beside the ENERGY gauge (common/src/ships/circuits.ts, energy.ts; docs/design/rework-2026-11.md
 * §2.4): a thin bar for each Capacitor bank (amber) and Drive Cell bank (blue), at most four, numbered as in the
 * hangar. The ENERGY gauge itself shows the whole ship. A bank that feeds parts short of power this tick flashes red.
 */

import { BROWNOUT, type Charge, type ShipDerived } from '@space-game/common';
import { setStyle } from './domWrite';

const CSS = `
  #bankBars { display: flex; gap: 3px; align-items: flex-end; }
  #bankBars .cb { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  #bankBars .cb-bar { width: 6px; height: 64px; border-radius: 3px; border: 1px solid rgba(160, 190, 230, 0.55);
    background: rgba(100, 140, 200, 0.12); position: relative; overflow: hidden; }
  #bankBars .cb-fill { position: absolute; left: 0; right: 0; bottom: 0; transition: height 0.1s ease-out; }
  #bankBars .cb-l { font: 700 10px 'Segoe UI', sans-serif; line-height: 10px; }
  #bankBars .cb.brown .cb-bar { border-color: #ef4444; animation: cb-flash 0.35s steps(2) infinite; }
  #bankBars .cb.brown .cb-l { color: #f87171 !important; }
  @keyframes cb-flash { 0% { background: rgba(239, 68, 68, 0.45); } 100% { background: rgba(239, 68, 68, 0.08); } }
  #boostBarRow { display: flex; gap: 6px; align-items: flex-end; }
`;

/** The most bank bars shown */
const MAX_BARS = 4;

export class BankBars {
  private wrap: HTMLElement | null = null;
  private layout: ShipDerived['power'] | null = null;
  private bars: { el: HTMLElement; fill: HTMLElement; bank: number; pct: number; brown: boolean }[] = [];

  constructor() {
    const hud = document.getElementById('boostHud'), bar = document.getElementById('boostBar');
    if (!hud || !bar) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    // (The ENERGY bar keeps its place: the banks sit to its left, on the same baseline)
    const row = document.createElement('div');
    row.id = 'boostBarRow';
    hud.insertBefore(row, bar);
    this.wrap = document.createElement('div');
    this.wrap.id = 'bankBars';
    row.append(this.wrap, bar);
  }

  update(d: ShipDerived | null | undefined, c: Charge): void {
    if (!this.wrap) return;
    const L = d?.power ?? null;
    // (The layout only changes with the ship's derived power layout, so compare its identity: no per-frame string)
    if (L !== this.layout) {
      this.layout = L;
      this.wrap.innerHTML = '';
      this.bars = [];
      const n = L ? Math.min(L.banks.length, MAX_BARS) : 0;
      for (let k = 0; k < n; k++) {
        const B = L!.banks[k];
        const el = document.createElement('div');
        el.className = 'cb';
        const col = B.kind === 'drive' ? '#60a5fa' : '#fbbf24';
        el.innerHTML = `<div class="cb-bar"><div class="cb-fill" style="background:${col}"></div></div><span class="cb-l" style="color:${col}">${k + 1}</span>`;
        this.wrap.appendChild(el);
        this.bars.push({ el, fill: el.querySelector('.cb-fill') as HTMLElement, bank: k, pct: -1, brown: false });
      }
    }
    if (!L || !this.bars.length) return;
    for (const b of this.bars) {
      const v = c.b[b.bank];
      const pct = v === undefined || !Number.isFinite(v) ? 100 : Math.max(0, Math.min(100, v));
      setStyle(b.fill, 'height', `${pct.toFixed(1)}%`);
      // (Browning out: a feed group this bank feeds got less than it asked, this tick's predicted power step: energy.ts powerTick)
      let brown = false;
      for (let f = 0; f < L.feeds.length && !brown; f++) {
        if (!L.feeds[f].banks.includes(b.bank)) continue;
        if (Math.min(c.eng?.[f] ?? 1, c.gun?.[f] ?? 1) < BROWNOUT) brown = true;
      }
      const r = Math.round(pct);
      if (r === b.pct && brown === b.brown) continue;
      b.pct = r;
      b.brown = brown;
      b.el.classList.toggle('brown', brown);
      const B = L.banks[b.bank];
      b.el.title = `Bank ${b.bank + 1} (${B.kind === 'drive' ? 'Drive Cells' : 'Capacitors'}): ${r}% of ${Math.round(B.cap)}${brown ? ' · short of power' : ''}`;
    }
  }
}
