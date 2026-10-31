/**
 * The pilot's per-circuit charge (local circuits: common/src/ships/circuits.ts, energy.ts), beside the ENERGY gauge:
 * a thin bar for each circuit that has stores, lettered and coloured as in the hangar's power view (Steady cyan; each
 * Surge bank violet, S1, S2...), and one for the
 * core's own store. A circuit that browns out this tick (it can't give all that's asked of it) flashes red, bar or not.
 * Shown only when there's more than the one store to tell apart (the gauge says it all for a ship with one).
 */

import { BROWNOUT, circuitCharges, type Charge, type ShipDerived } from '@space-game/common';
import { circuitColor, DEAD_NET, SURGE_COLOR } from '../ships/wireEdit';
import { setStyle, setText } from './domWrite';

const CSS = `
  #circuitBars { display: flex; gap: 3px; align-items: flex-end; }
  #circuitBars .cb { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  #circuitBars .cb-bar { width: 6px; height: 64px; border-radius: 3px; border: 1px solid rgba(160, 190, 230, 0.55);
    background: rgba(100, 140, 200, 0.12); position: relative; overflow: hidden; }
  #circuitBars .cb-fill { position: absolute; left: 0; right: 0; bottom: 0; transition: height 0.1s ease-out; }
  #circuitBars .cb-l { font: 700 10px 'Segoe UI', sans-serif; line-height: 10px; }
  #circuitBars .cb.brown .cb-bar { border-color: #ef4444; animation: cb-flash 0.35s steps(2) infinite; }
  #circuitBars .cb.brown .cb-l { color: #f87171 !important; }
  @keyframes cb-flash { 0% { background: rgba(239, 68, 68, 0.45); } 100% { background: rgba(239, 68, 68, 0.08); } }
  #boostBarRow { display: flex; gap: 6px; align-items: flex-end; }
`;

export class CircuitBars {
  private wrap: HTMLElement | null = null;
  private sig = '';
  private bars: { el: HTMLElement; fill: HTMLElement; circuit: number; key: string }[] = [];

  constructor() {
    const hud = document.getElementById('boostHud'), bar = document.getElementById('boostBar');
    if (!hud || !bar) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    // (The ENERGY bar keeps its place: the circuits sit to its left, on the same baseline)
    const row = document.createElement('div');
    row.id = 'boostBarRow';
    hud.insertBefore(row, bar);
    this.wrap = document.createElement('div');
    this.wrap.id = 'circuitBars';
    row.append(this.wrap, bar);
  }

  update(d: ShipDerived | null | undefined, c: Charge): void {
    if (!this.wrap) return;
    const all = d?.power ? circuitCharges(d, c) : [];
    // (a Surge bank by its own key: it shares its circuit's number)
    const key = (x: (typeof all)[number]) => (x.bank !== undefined ? `k${x.bank}` : `c${x.circuit}`);
    // (stores on no circuit at all aren't shown, but for Surge banks: the hangar warns of them)
    const shown = all.filter((x) => x.cap > 0 && (x.bank !== undefined || x.circuit < 0 || d!.power!.circuits[x.circuit].net >= 0));
    const lettered = d?.power?.circuits.filter((x) => x.letter).length ?? 0;
    const visible = shown.length >= 2 || lettered >= 2;
    const powered = (x: (typeof all)[number]) => x.circuit >= 0 && d!.power!.circuits[x.circuit].generators.length > 0;
    const sig = visible ? shown.map((x) => `${key(x)}:${x.letter}:${powered(x) ? 1 : 0}`).join('|') : '';
    if (sig !== this.sig) {
      this.sig = sig;
      this.wrap.innerHTML = '';
      this.bars = [];
      for (const x of visible ? shown : []) {
        const el = document.createElement('div');
        el.className = 'cb';
        // (as the hangar has it: Steady cyan, a Surge bank violet, a circuit with no generator grey, the core's store pale)
        const col = x.bank !== undefined ? SURGE_COLOR : x.circuit < 0 ? '#cbd5e1' : powered(x) ? circuitColor(x.letter) : DEAD_NET;
        el.innerHTML = `<div class="cb-bar"><div class="cb-fill" style="background:${col}"></div></div><span class="cb-l" style="color:${col}">${x.circuit < 0 && x.bank === undefined ? '◆' : x.letter}</span>`;
        this.wrap.appendChild(el);
        this.bars.push({ el, fill: el.querySelector('.cb-fill') as HTMLElement, circuit: x.circuit, key: key(x) });
      }
    }
    if (!visible || !d?.power) return;
    // This tick's share per circuit (the predicted power step's: energy.ts powerTick)
    const L = d.power, share = new Map<number, number>();
    L.feeds.forEach((f, k) => {
      const v = Math.min(c.eng?.[k] ?? 1, c.gun?.[k] ?? 1);
      share.set(f.circuit, Math.min(share.get(f.circuit) ?? 1, v));
    });
    for (const b of this.bars) {
      const x = all.find((y) => key(y) === b.key);
      if (!x) continue;
      setStyle(b.fill, 'height', `${x.pct.toFixed(1)}%`);
      const bank = x.bank !== undefined;
      const brown = !bank && b.circuit >= 0 && (share.get(b.circuit) ?? 1) < BROWNOUT;
      b.el.classList.toggle('brown', brown);
      b.el.title = bank ? `Surge bank ${x.letter}: ${Math.round(x.pct)}% of ${Math.round(x.cap)}` : b.circuit < 0 ? `The core's store: ${Math.round(x.pct)}% of ${Math.round(x.cap)}` : `Circuit ${x.letter}: ${Math.round(x.pct)}% of ${Math.round(x.cap)}${brown ? ' · browning out' : ''}`;
    }
  }
}
