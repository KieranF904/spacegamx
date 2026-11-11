/**
 * @contract client.ui.backup-picker
 * owns:       the respawn screen's choice of backup ship: the options the `backups` message offers, the one picked, and
 *             the `respawn` message's `backup` field
 * needs:      the DOM, settings/keybindings (the respawn key's name); npm: @space-game/common
 * invariants: the starter is always first and the default; a pick not on offer sends none — client/src/ui/BackupPicker.test.ts
 * extend:     a new line on an option goes in backupLabel
 */
/**
 * Backups (docs/design/death-rework-2026-11.md): a death loses the ship and the server offers the ships the pilot may
 * come back in, the free starter first. While dead, a row of buttons under the DESTROYED overlay: one click respawns in
 * that ship; the respawn key (and the rally buttons) respawn in the one picked last, the starter if none.
 */

import type { BackupOption, ClientMessage, ServerBackupsMessage } from '@space-game/common';
import { boundKeyName } from '../input/keybindings';
import { settings } from '../settings/Settings';

const CSS = `
.bk-pick { position: fixed; left: 50%; top: calc(50% + 120px); transform: translateX(-50%); display: none; flex-direction: column; align-items: center; gap: 6px; z-index: 2300; max-width: min(92vw, 640px); }
.bk-pick .bk-h { font: 12px system-ui, sans-serif; color: #fbbf24; text-align: center; }
.bk-pick .bk-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.bk-pick .sgw-btn.on { outline: 2px solid #fbbf24; }
`;

/** An option's button text: its name, and how much of it stands */
export function backupLabel(o: BackupOption): string {
  if (o.slot < 0) return `${o.name} (starter, free)`;
  return o.built < o.parts ? `${o.name} · ${o.built}/${o.parts} parts` : o.name;
}

export class BackupPicker {
  private options: BackupOption[] = [];
  private lost: string | undefined;
  private picked = -1;
  private visible = false;
  private el: HTMLDivElement | null = null;
  private send: ((m: ClientMessage) => void) | null = null;

  /** Where the respawn goes (the network) */
  bind(send: (m: ClientMessage) => void): void {
    this.send = send;
  }

  /** The `backups` message: what's on offer now (the starter is picked until they choose) */
  set(msg: ServerBackupsMessage): void {
    this.options = msg.options ?? [];
    this.lost = msg.lost;
    this.picked = -1;
    this.render();
  }

  show(on: boolean): void {
    this.visible = on;
    this.render();
  }

  /** The respawn message's choice: the ship picked, if it's on offer (none: the starter) */
  choice(): { backup?: number } {
    return this.picked >= 0 && this.options.some((o) => o.slot === this.picked) ? { backup: this.picked } : {};
  }

  /** Respawn now, in this option */
  respawn(slot: number): void {
    this.picked = slot;
    this.send?.({ type: 'respawn', ...this.choice() });
  }

  private render(): void {
    if (typeof document === 'undefined') return;
    if (!this.el) {
      const style = document.createElement('style');
      style.textContent = CSS;
      this.el = document.createElement('div');
      this.el.className = 'bk-pick';
      document.head.appendChild(style);
      document.body.appendChild(this.el);
    }
    const el = this.el;
    if (!this.visible || this.options.length < 1) { el.style.display = 'none'; return; }
    el.replaceChildren();
    const head = document.createElement('div');
    head.className = 'bk-h';
    const key = boundKeyName('respawn', settings.data.bindings);
    head.textContent = `${this.lost ? `Your ${this.lost} is in your hangar, to be built again. ` : ''}Respawn in (${key}: the one picked):`;
    const row = document.createElement('div');
    row.className = 'bk-row';
    for (const o of this.options) {
      const b = document.createElement('button');
      b.className = `sgw-btn${o.slot === (this.picked >= 0 ? this.picked : -1) ? ' on' : ''}`;
      b.textContent = backupLabel(o);
      b.onclick = () => this.respawn(o.slot);
      row.appendChild(b);
    }
    el.append(head, row);
    el.style.display = 'flex';
  }
}

/** The one picker (the death, the respawn key and the rally buttons share it) */
export const backupPicker = new BackupPicker();
