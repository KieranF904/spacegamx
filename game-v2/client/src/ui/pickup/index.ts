/**
 * @contract client.ui.pickup
 * owns:       the pickup windows built and wired as one set (docs/design/loot-pickup-2026-11.md): the pickup panel (F), the auto-pickup lists (drawn in the Ship window's Pickup tab; the cargo panel's chip opens it there), the catalogue picker; their per-frame show/hide and their keys (F, Esc, Enter)
 * needs:      PickupPanelUI, AutoPickupPanel, CataloguePicker, CargoPanelUI (the chip, its place), PilotState; npm: @space-game/common
 * invariants: none of them holds a key the ship flies with: Esc closes the top one, the catalogue swallows keys only while it is open; F (after the ship's own keys: the build overlay flips a part with it) toggles the pickup panel — client/src/app/keys.test.ts
 * extend:     a new pickup window is built here and given its place in update() and onKey()
 */

import type { ClientMessage } from '@space-game/common';
import type { PilotState } from '../../econ/clientEcon';
import type { CargoPanelUI } from '../CargoPanelUI';
import { PickupPanelUI } from './PickupPanelUI';
import { AutoPickupPanel } from './AutoPickupPanel';
import { CataloguePicker } from './CataloguePicker';
import { closeAsk } from './askBox';

export class PickupWindows {
  readonly panel: PickupPanelUI;
  readonly auto: AutoPickupPanel;
  readonly picker: CataloguePicker;

  constructor(pilot: PilotState, send: (m: ClientMessage) => void, sound: (id: string) => void, cargo: CargoPanelUI) {
    this.panel = new PickupPanelUI(pilot, send, sound);
    this.picker = new CataloguePicker(pilot, send, sound);
    this.auto = new AutoPickupPanel(pilot, this.picker, send, sound);
    // (The chip opens the Ship window's Pickup tab: app/windows.ts sets openLists)
    cargo.onAutoPickup = () => this.openLists?.();
  }

  /** Open the auto-pickup lists (the Ship window on its Pickup tab) */
  openLists: (() => void) | null = null;

  /** The pickup panel is listing what's in reach (Enter is its: the chat box leaves it alone then) */
  get takesEnter(): boolean { return this.panel.isOpen && !this.picker.isOpen; }

  /** Each frame: all of it hidden while docked, in a menu, the hangar or the gun range */
  update(blocked: boolean): void {
    this.panel.update(blocked);
    if (blocked) { this.picker.close(); closeAsk(); }
  }

  /** A key (the modal chain, keys.ts): true if one of these took it. (F is a global key after the ship's: keys.ts POST_KEYS) */
  onKey(code: string): boolean {
    if (this.picker.isOpen) {
      if (code === 'Escape') this.picker.close();
      return true;
    }
    if (code === 'Escape' && this.panel.isOpen) { this.panel.close(); return true; }
    return false;
  }
}
