/**
 * @contract client.ship.render.bank-glow
 * owns:       the pilot's own Capacitor and Drive Cell members glowing by their bank's charge
 * needs:      BankGlowHost (charge, geometry), pixi Graphics; npm: @space-game/common, pixi.js
 * invariants: redrawn only when a bank's charge moves a step — none pinned
 * extend:     a new bank kind is one more colour in drawBankGlow
 */

import { Graphics } from 'pixi.js';
import type { Charge, ShipState } from '@space-game/common';
import type { ShipSource } from '../ShipStore';
import type { BodyView } from './viewTypes';

export interface BankGlowHost {
  charge(): Charge;
  geometry(ship: ShipState): ReturnType<ShipSource['geometry']>;
}

/**
 * The pilot's own Capacitor and Drive Cell members glow with their bank's charge (rework 2026-11 section 2.4): amber and
 * blue, brightest full, dark drained. Redrawn only when a bank's charge moves a step
 */
export function drawBankGlow(h: BankGlowHost, view: BodyView, ship: ShipState, cs: number, own: boolean): void {
  const L = own && ship.kind === 'ship' ? ship.derived.power : undefined;
  let b = view.bankGlow;
  if (!L || !L.banks.length) { if (b) b.g.visible = false; return; }
  if (!b) {
    const g = new Graphics();
    g.blendMode = 'add';
    b = view.bankGlow = { g, sig: -1, ship: null, rebuilds: -1 };
    view.container.addChildAt(g, Math.max(0, view.container.getChildIndex(view.guns)));
  }
  b.g.visible = true;
  const charge = h.charge().b;
  let sig = 1;
  for (let k = 0; k < L.banks.length; k++) sig = (Math.imul(sig, 31) + Math.round((charge[k] ?? 100) / 5)) | 0;
  if (sig === b.sig && ship === b.ship && ship.rebuilds === b.rebuilds) return;
  b.sig = sig; b.ship = ship; b.rebuilds = ship.rebuilds;
  const geoms = h.geometry(ship), [cx, cy] = ship.derived.com, g = b.g.clear();
  for (let k = 0; k < L.banks.length; k++) {
    const B = L.banks[k], pct = Math.max(0, Math.min(100, charge[k] ?? 100)) / 100, color = B.kind === 'drive' ? 0x3b82f6 : 0xf59e0b;
    for (const i of B.parts) {
      const poly = geoms[i]?.polygon;
      if (!poly || !ship.derived.alive[i]) continue;
      poly.forEach(([x, y], j) => (j ? g.lineTo((x - cx) * cs, (y - cy) * cs) : g.moveTo((x - cx) * cs, (y - cy) * cs)));
      g.closePath().fill({ color, alpha: 0.05 + 0.5 * pct });
    }
  }
}
