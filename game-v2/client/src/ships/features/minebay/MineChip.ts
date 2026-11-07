/**
 * The Mine Bay's HUD chip: mines loaded of the bays' capacity, READY or the cooldown left, and the drop key. Shown while
 * the ship has a working Mine Bay. Its element is made on first use, so importing the feature touches no DOM.
 */

export interface MineHud {
  loaded: number;
  capacity: number;
  /** Seconds until a bay can drop (0: ready) */
  wait: number;
}

export class MineChip {
  private root?: HTMLDivElement;
  private key = '';

  private make(): HTMLDivElement {
    const root = document.createElement('div');
    root.style.cssText = `position: fixed; left: 50%; bottom: 322px; transform: translateX(-50%); z-index: 860; display: none; pointer-events: none;
      padding: 3px 12px 4px; border-radius: 999px; background: rgba(8, 14, 26, 0.72); border: 1px solid rgba(239, 68, 68, 0.35);
      font: 600 11px 'Segoe UI', system-ui, sans-serif; letter-spacing: 1.2px; color: #fca5a5; text-align: center; white-space: nowrap;`;
    root.dataset.hudAvoid = '1';
    document.body.appendChild(root);
    return (this.root = root);
  }

  /** Each frame: the magazines (null: hidden), and the drop key */
  update(s: MineHud | null, keyName: string): void {
    const key = s ? `${s.loaded}|${s.capacity}|${Math.ceil(s.wait * 10)}|${keyName}` : '';
    if (key === this.key) return;
    this.key = key;
    if (!s && !this.root) return;
    const root = this.root ?? this.make();
    root.style.display = s ? 'block' : 'none';
    if (!s) return;
    const state = s.loaded <= 0 ? 'EMPTY' : s.wait > 0 ? `${s.wait.toFixed(1)} s` : 'READY';
    root.innerHTML = `MINES ${s.loaded}/${s.capacity} · ${state} · <kbd style="color:#e5ecf7">${keyName}</kbd>`;
  }
}
