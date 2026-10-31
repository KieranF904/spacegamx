/**
 * The Burst Strafer's HUD chip, over the jump gauge (common/src/ships/features/strafer): READY (lit) or a ring filling
 * over the short cooldown, the dodge key, a flash while a burst runs, LOW POWER when the circuit can't pay for a full
 * burst the way you'd dodge now, and which ways the strafers can't push (if any). Shown while a ship has strafers fitted.
 * Its element is made on first use, so importing the feature (keybindings does) touches no DOM.
 */

export interface DodgeHud {
  phase: 'ready' | 'burst' | 'cooling' | 'held';
  /** Cooldown left (0..1) */
  cooling: number;
  /** How much of a burst the way you'd dodge now the ship could pay for (0..1: strafer.ts dodgeAffordable) */
  afford: number;
  /** The ways it can dodge, as arrows (ship-relative), when it can't dodge every way; '' when it can */
  ways: string;
}

export class DodgeIndicator {
  private root?: HTMLDivElement;
  private key = '';

  private make(): HTMLDivElement {
    const root = document.createElement('div');
    root.style.cssText = `position: fixed; left: 50%; bottom: 262px; transform: translateX(-50%); z-index: 860; display: none; pointer-events: none;
      padding: 3px 12px 4px; border-radius: 999px; background: rgba(8, 14, 26, 0.72); border: 1px solid rgba(244, 114, 182, 0.35);
      font: 600 11px 'Segoe UI', system-ui, sans-serif; letter-spacing: 1.2px; color: #f9a8d4; text-align: center; white-space: nowrap;`;
    root.dataset.hudAvoid = '1';
    document.body.appendChild(root);
    return (this.root = root);
  }

  /** Each frame: the dodge's state (null: hidden), and the dodge key */
  update(s: DodgeHud | null, keyName: string): void {
    const low = !!s && s.afford < 0.999;
    const key = s ? `${s.phase}|${Math.round(s.cooling * 12)}|${low ? Math.round(s.afford * 10) : 'ok'}|${keyName}|${s.ways}` : '';
    if (key === this.key) return;
    this.key = key;
    if (!s && !this.root) return;
    const root = this.root ?? this.make();
    root.style.display = s ? 'block' : 'none';
    if (!s) return;
    const bursting = s.phase === 'burst';
    const ready = s.phase === 'ready' || s.phase === 'held';
    const dot = ready
      ? `<b style="display:inline-block; width:9px; height:9px; margin:0 3px; border-radius:50%; background:${low ? '#fbbf24' : '#f472b6'}; box-shadow:0 0 6px ${low ? '#fbbf24' : '#f472b6'}"></b>`
      : `<b style="display:inline-block; width:9px; height:9px; margin:0 3px; border-radius:50%; background:conic-gradient(#f472b6 ${Math.round((1 - s.cooling) * 360)}deg, rgba(244,114,182,0.15) 0)"></b>`;
    const power = low
      ? ` <span style="color:${s.afford < 0.25 ? '#f87171' : '#fbbf24'}; font-weight:600">${s.afford < 0.25 ? 'NO POWER' : `LOW POWER ${Math.round(s.afford * 100)}%`}</span>`
      : '';
    root.style.borderColor = bursting ? 'rgba(244, 114, 182, 0.9)' : low ? 'rgba(251, 191, 36, 0.45)' : 'rgba(244, 114, 182, 0.35)';
    root.style.boxShadow = bursting ? '0 0 14px rgba(244, 114, 182, 0.45)' : 'none';
    root.innerHTML = `DODGE ${dot}<kbd style="color:#e5ecf7; font-weight:600">${keyName}</kbd>${power}${s.ways ? ` <span style="color:#9aa7b8; font-weight:400">${s.ways} only</span>` : ''}`;
  }
}
