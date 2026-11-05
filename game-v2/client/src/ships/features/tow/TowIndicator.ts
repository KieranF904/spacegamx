/**
 * The Tow Beam's HUD chip (common/src/ships/features/tow/tow.ts): while towing, what it tows, the load it puts on the
 * ship, and the key to let go; the salvage hint (bring it into a station's reach). Hidden otherwise. Its element is
 * made on first use, so importing the feature (keybindings does) touches no DOM.
 */

export class TowIndicator {
  private root?: HTMLDivElement;
  private key = '';

  private make(): HTMLDivElement {
    const root = document.createElement('div');
    root.style.cssText = `position: fixed; left: 50%; bottom: 292px; transform: translateX(-50%); z-index: 860; display: none; pointer-events: none;
      padding: 4px 14px 5px; border-radius: 999px; background: rgba(8, 14, 26, 0.82); border: 1px solid rgba(250, 204, 21, 0.5);
      font: 600 11px 'Segoe UI', system-ui, sans-serif; letter-spacing: 1.2px; color: #facc15; text-align: center; white-space: nowrap;
      box-shadow: 0 0 12px rgba(250, 204, 21, 0.18);`;
    root.dataset.hudAvoid = '1';
    document.body.appendChild(root);
    return (this.root = root);
  }

  /** Each frame: what's towed (null: hidden), the thrust it costs (0..1), and the tow key */
  update(s: { what: string; thrustLoss: number } | null, keyName: string): void {
    const key = s ? `${s.what}|${Math.round(s.thrustLoss * 100)}|${keyName}` : '';
    if (key === this.key) return;
    this.key = key;
    if (!s && !this.root) return;
    const root = this.root ?? this.make();
    root.style.display = s ? 'block' : 'none';
    if (!s) return;
    root.innerHTML = `⛓ TOWING ${s.what.toUpperCase()} · −${Math.round(s.thrustLoss * 100)}% thrust · into a station to salvage · <kbd style="color:#e5ecf7">${keyName}</kbd> to let go`;
  }
}
