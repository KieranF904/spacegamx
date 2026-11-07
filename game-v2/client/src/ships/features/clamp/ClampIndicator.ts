/**
 * Docking Clamps' HUD chip: the prompt ("Press H to dock"), the other pilot's waiting press, ours waiting for theirs,
 * and while docked who steers and the keys. Hidden otherwise. Its element is made on first use (importing the feature
 * touches no DOM).
 */

export class ClampIndicator {
  private root?: HTMLDivElement;
  private text = '';

  private make(): HTMLDivElement {
    const root = document.createElement('div');
    root.style.cssText = `position: fixed; left: 50%; bottom: 322px; transform: translateX(-50%); z-index: 860; display: none; pointer-events: none;
      padding: 4px 14px 5px; border-radius: 999px; background: rgba(8, 14, 26, 0.82); border: 1px solid rgba(94, 234, 212, 0.5);
      font: 600 11px 'Segoe UI', system-ui, sans-serif; letter-spacing: 1.2px; color: #5eead4; text-align: center; white-space: nowrap;
      box-shadow: 0 0 12px rgba(94, 234, 212, 0.18);`;
    root.dataset.hudAvoid = '1';
    document.body.appendChild(root);
    return (this.root = root);
  }

  /** Each frame: the line to show (empty: hidden) */
  update(text: string): void {
    if (text === this.text) return;
    this.text = text;
    if (!text && !this.root) return;
    const root = this.root ?? this.make();
    root.style.display = text ? 'block' : 'none';
    root.textContent = text;
  }
}
