/**
 * @contract client.ui.power-margin
 * owns:       the HUD's power readout, bottom right (it replaced the pool-era ENERGY bar): the spare power now (the
 *             generators less the steady loads and what the keys ask), or the deficit the stores pay; amber in deficit,
 *             red when starved; the stores' charge as a thin bar under it; a click opens the Ship window's Power tab
 * needs:      powerModel.powerMargin (ui/ship), domWrite; npm: @space-game/common (types)
 * invariants: the numbers are powerMargin's (the ports layout and the predicted state, nothing sent) —
 *             client/src/ui/ship/powerModel.test.ts
 * extend:     another figure is one more element written in update()
 */

import type { Charge, ShipDerived } from '@space-game/common';
import { setHtml, setStyle } from '../domWrite';
import { powerMargin, type PowerAsk } from '../ship/powerModel';

const CSS = `
.sgpm { position: fixed; right: 16px; bottom: 60px; display: none; z-index: 880; min-width: 96px; padding: 5px 9px 6px; border-radius: 8px; cursor: pointer;
  background: rgba(8, 14, 26, 0.82); border: 1px solid rgba(125, 160, 210, 0.3); font: 600 12px 'Segoe UI', system-ui, sans-serif; color: #cfe0f5; text-align: right; }
.sgpm:hover { border-color: rgba(125, 211, 252, 0.6); }
.sgpm .l { font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 2px; color: #6f8099; display: block; }
.sgpm .v { font-size: 15px; font-variant-numeric: tabular-nums; }
.sgpm .b { height: 3px; border-radius: 2px; background: rgba(255,255,255,0.08); margin-top: 3px; overflow: hidden; }
.sgpm .b i { display: block; height: 100%; background: #7dd3fc; }
`;

export class PowerMargin {
  private root: HTMLDivElement | null = null;
  private val!: HTMLElement;
  private bar!: HTMLElement;
  onClick: (() => void) | null = null;

  private make(): HTMLDivElement {
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
    const root = document.createElement('div');
    root.className = 'sgpm';
    root.dataset.hudAvoid = '1';
    root.title = 'Spare power: what your generators make less what is drawing now. Amber: the stores are paying; red: short. Click: the Ship window\'s Power tab';
    root.innerHTML = '<span class="l">POWER</span><span class="v"></span><div class="b"><i></i></div>';
    this.val = root.querySelector('.v') as HTMLElement;
    this.bar = root.querySelector('.b i') as HTMLElement;
    root.addEventListener('mousedown', (e) => e.stopPropagation());
    root.addEventListener('click', () => this.onClick?.());
    document.body.appendChild(root);
    return (this.root = root);
  }

  /** Each frame: `d` null hides it */
  update(d: ShipDerived | null | undefined, charge: Charge, ask: PowerAsk): void {
    if (!d?.ports) { if (this.root) setStyle(this.root, 'display', 'none'); return; }
    const root = this.root ?? this.make();
    setStyle(root, 'display', 'block');
    const m = powerMargin(d, charge, ask);
    const v = Math.round(m.margin);
    const color = m.starved ? '#f87171' : v < 0 ? '#fbbf24' : '#86efac';
    setHtml(this.val, `<span style="color:${color}">${v >= 0 ? '+' : '−'}${Math.abs(v)}/s</span>`);
    setStyle(this.bar, 'width', `${Math.round(m.gauge)}%`);
    setStyle(this.bar, 'background', m.gauge < 10 ? '#f87171' : '#7dd3fc');
  }
}
