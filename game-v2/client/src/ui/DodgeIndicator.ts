/**
 * The Burst Strafer's HUD chip, over the jump gauge (common/src/ships/strafer.ts): a pip per charge (lit: ready;
 * the next one filling), the dodge key, and a flash while a burst runs. Shown while a ship has strafers fitted.
 */

export class DodgeIndicator {
  private root: HTMLDivElement;
  private key = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = `position: fixed; left: 50%; bottom: 262px; transform: translateX(-50%); z-index: 860; display: none; pointer-events: none;
      padding: 3px 12px 4px; border-radius: 999px; background: rgba(8, 14, 26, 0.72); border: 1px solid rgba(244, 114, 182, 0.35);
      font: 600 11px 'Segoe UI', system-ui, sans-serif; letter-spacing: 1.2px; color: #f9a8d4; text-align: center; white-space: nowrap;`;
    this.root.dataset.hudAvoid = '1';
    document.body.appendChild(this.root);
  }

  /** Each frame: the charges (null: hidden), whether a burst is running, and the dodge key */
  update(s: { ready: number; max: number; refill: number; bursting: boolean; sides: string } | null, keyName: string): void {
    const show = !!s && s.max > 0;
    const key = show ? `${s!.ready}|${s!.max}|${Math.round(s!.refill * 10)}|${s!.bursting}|${keyName}|${s!.sides}` : '';
    if (key === this.key) return;
    this.key = key;
    this.root.style.display = show ? 'block' : 'none';
    if (!show) return;
    const pip = (i: number) => {
      if (i < s!.ready) return '<b style="display:inline-block; width:9px; height:9px; margin:0 2px; border-radius:50%; background:#f472b6; box-shadow:0 0 6px #f472b6"></b>';
      if (i === s!.ready) return `<b style="display:inline-block; width:9px; height:9px; margin:0 2px; border-radius:50%; background:conic-gradient(#f472b6 ${Math.round(s!.refill * 360)}deg, rgba(244,114,182,0.15) 0)"></b>`;
      return '<b style="display:inline-block; width:9px; height:9px; margin:0 2px; border-radius:50%; background:rgba(244,114,182,0.15)"></b>';
    };
    this.root.style.borderColor = s!.bursting ? 'rgba(244, 114, 182, 0.9)' : 'rgba(244, 114, 182, 0.35)';
    this.root.style.boxShadow = s!.bursting ? '0 0 14px rgba(244, 114, 182, 0.45)' : 'none';
    this.root.innerHTML = `DODGE ${Array.from({ length: s!.max }, (_, i) => pip(i)).join('')} <kbd style="color:#e5ecf7; font-weight:600">${keyName}</kbd>${s!.sides ? ` <span style="color:#9aa7b8; font-weight:400">${s!.sides}</span>` : ''}`;
  }
}
