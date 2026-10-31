/**
 * The Stabiliser Anchor's HUD chip, over the jump gauge (common/src/ships/anchor.ts):
 * spooling in or out (a filling bar: no thrust and no benefits yet, the
 * vulnerable window), braced (what it gives, and the key to let go), or
 * nothing while the anchor is stowed.
 */

import type { BracePhase } from '@space-game/common';

export class BraceIndicator {
  private root: HTMLDivElement;
  private label: HTMLSpanElement;
  private bar: HTMLElement;
  private key = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = `position: fixed; left: 50%; bottom: 228px; transform: translateX(-50%); z-index: 860; display: none; pointer-events: none;
      padding: 5px 14px 6px; border-radius: 999px; background: rgba(8, 14, 26, 0.82); border: 1px solid rgba(125, 211, 252, 0.45);
      font: 600 11px 'Segoe UI', system-ui, sans-serif; letter-spacing: 1.5px; color: #7dd3fc; text-align: center; min-width: 200px;
      box-shadow: 0 0 14px rgba(125, 211, 252, 0.18);`;
    this.root.innerHTML = `<span></span><div style="margin-top:4px; height:3px; border-radius:2px; background:rgba(125,160,210,0.18); overflow:hidden"><i style="display:block; height:100%; width:0; background:currentColor"></i></div>`;
    this.label = this.root.firstElementChild as HTMLSpanElement;
    this.bar = this.root.querySelector('i') as HTMLElement;
    this.root.dataset.hudAvoid = '1';
    document.body.appendChild(this.root);
  }

  /** Each frame: the anchor's phase (null: hidden), the brace key, and what bracing gives (for the braced line) */
  update(s: { phase: BracePhase; progress: number } | null, keyName: string, gives: string): void {
    const show = !!s && s.phase !== 'free';
    const key = show ? `${s!.phase}|${Math.round(s!.progress * 40)}|${keyName}` : '';
    if (key === this.key) return;
    this.key = key;
    this.root.style.display = show ? 'block' : 'none';
    if (!show) return;
    const braced = s!.phase === 'braced';
    const col = braced ? '#7dd3fc' : '#fbbf24';
    this.root.style.color = col;
    this.root.style.borderColor = braced ? 'rgba(125, 211, 252, 0.55)' : 'rgba(251, 191, 36, 0.5)';
    this.root.style.boxShadow = braced ? '0 0 16px rgba(125, 211, 252, 0.3)' : 'none';
    this.label.innerHTML = braced
      ? `⚓ BRACED · ${gives} · <kbd style="color:#e5ecf7">${keyName}</kbd> to let go`
      : s!.phase === 'bracing' ? '⚓ BRACING · NO THRUST' : '⚓ LETTING GO · NO THRUST';
    (this.bar.parentElement as HTMLElement).style.display = braced ? 'none' : 'block';
    this.bar.style.width = `${Math.round(s!.progress * 100)}%`;
  }
}
