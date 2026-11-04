/**
 * The Flash Screen's world half (the shared half and its numbers: common/src/ships/features/flash). The bridge tells it
 * when a ship's shield breaks (`onShieldBreak`). If a Capacitor bank touching a Flash Screen can pay for the screens'
 * share, the share is back at once and the banks lose the energy; otherwise it is back whole FLASH_RESTORE_TICKS later
 * (`tick`). Either way the screens bloom white where the ship is, for everyone in the system.
 */
import { InSystem, EffectType, FLASH_RESTORE_TICKS, flashPay, type Charge } from '@space-game/common';
import type { FeatureHost, FeatureInstance } from '../types.js';
import { SimPass } from '../../../sim/SystemClocks.js';

export class Flash implements FeatureInstance {
  /** Ships whose Flash Screens are on their way back: the tick they return, and the points */
  private readonly due = new Map<number, number>();
  private readonly held: number[] = [];
  private readonly left: number[] = [];

  constructor(private readonly host: FeatureHost) {}

  /** The ship's shield just broke (it held something a moment ago, and holds nothing now) */
  onShieldBreak(eid: number): void {
    const ship = this.host.ships.get(eid);
    const max = ship?.derived.fx?.flash?.max ?? 0;
    if (!ship || max <= 0) return;
    if (this.payFromBanks(eid, max)) { this.restore(eid, max); return; }
    if (!this.due.has(eid)) this.due.set(eid, this.host.getTick() + FLASH_RESTORE_TICKS);
  }

  tick(): void {
    if (this.due.size === 0) return;
    const now = this.host.getTick();
    for (const [eid, at] of this.due) {
      if (now < at || !SimPass.on(InSystem.systemId[eid])) continue;
      this.due.delete(eid);
      const max = this.host.ships.get(eid)?.derived.fx?.flash?.max ?? 0;
      if (max > 0) this.restore(eid, max);
    }
  }

  onShipRebuilt(eid: number): void {
    // (Its Flash Screens are gone: nothing to wait for)
    if (this.due.has(eid) && !((this.host.ships.get(eid)?.derived.fx?.flash?.max ?? 0) > 0)) this.due.delete(eid);
  }

  onLeave(eid: number): void { this.due.delete(eid); }

  /** Whether a return is pending for this ship (tests) */
  waiting(eid: number): boolean { return this.due.has(eid); }

  private restore(eid: number, max: number): void {
    const ship = this.host.ships.get(eid);
    if (!ship) return;
    ship.shield = Math.min(ship.derived.shieldMax, ship.shield + max);
    this.host.effect(eid, EffectType.ShieldFlash);
  }

  /** The Capacitor banks touching a Flash Screen pay FLASH_BANK_COST a point, or nothing is taken */
  private payFromBanks(eid: number, max: number): boolean {
    const ship = this.host.ships.get(eid);
    const L = ship?.derived.power, flash = ship?.derived.fx?.flash;
    if (!ship || !L || !flash) return false;
    const banks: number[] = [];
    for (let b = 0; b < L.banks.length; b++) {
      const B = L.banks[b];
      if (B.kind !== 'cap') continue;
      for (const i of flash.parts) if (B.shields.includes(i)) { banks.push(b); break; }
    }
    if (banks.length === 0) return false;
    const c: Charge = this.host.ships.chargeOf(eid);
    this.held.length = 0;
    for (const b of banks) this.held.push((L.banks[b].cap * Math.max(0, Math.min(100, c.b[b] ?? 100))) / 100);
    if (!flashPay(this.held, max, this.left)) return false;
    const nb = L.banks.map((_, b) => c.b[b] ?? 100);
    banks.forEach((b, k) => { nb[b] = L.banks[b].cap > 0 ? Math.round((this.left[k] / L.banks[b].cap) * 100000) / 1000 : 0; });
    this.host.ships.setCharge(eid, { ...c, b: nb });
    return true;
  }
}
