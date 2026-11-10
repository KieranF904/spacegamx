/**
 * The Flash Screen's world half (the shared half and its numbers: common/src/ships/features/flash). The bridge tells it
 * when a ship's shield breaks (`onShieldBreak`): each Flash Screen whose own store is full spends it and its points are
 * back at once (flashPay; the pilot hears the spent store as a correction, sim/ownStep.ts ownSync); the others' points
 * are back whole FLASH_RESTORE_TICKS later (`tick`). Either way the screens bloom white where the ship is, for everyone
 * in the system.
 */
import { InSystem, EffectType, FLASH_RESTORE_TICKS, flashPay, fullPortsCharge } from '@space-game/common';
import type { FeatureInstance, ShipsOf, TellCap, WorldCap } from '../types.js';
import { SimPass } from '../../../sim/SystemClocks.js';

/** What the Flash Screen asks of the game: the clock, the ships' records and stores, the bloom */
export type FlashHost = Pick<WorldCap, 'getTick'> & ShipsOf<'get' | 'chargeOf' | 'setCharge'> & Pick<TellCap, 'effect'>;

export class Flash implements FeatureInstance {
  /** Ships whose Flash Screens are on their way back: the tick they return, and the points */
  private readonly due = new Map<number, { at: number; pts: number }>();

  constructor(private readonly host: FlashHost) {}

  /** The ship's shield just broke (it held something a moment ago, and holds nothing now) */
  onShieldBreak(eid: number): void {
    const ship = this.host.ships.get(eid);
    const flash = ship?.derived.fx?.flash;
    if (!ship || !flash || !(flash.max > 0)) return;
    const L = ship.derived.ports;
    let c = this.host.ships.chargeOf(eid);
    // (No state yet: everything full, its stores too. Made now, so the spending has somewhere to go)
    if (!c.e || c.e.held.length !== L.n) { c = fullPortsCharge(ship.derived); this.host.ships.setCharge(eid, c); }
    let now = 0, later = 0;
    flash.parts.forEach((p, k) => { if (flashPay(L, c.e!, p)) now += flash.pts[k]; else later += flash.pts[k]; });
    if (now > 0) this.restore(eid, now);
    if (later > 0 && !this.due.has(eid)) this.due.set(eid, { at: this.host.getTick() + FLASH_RESTORE_TICKS, pts: later });
  }

  tick(): void {
    if (this.due.size === 0) return;
    const now = this.host.getTick();
    for (const [eid, d] of this.due) {
      if (now < d.at || !SimPass.on(InSystem.systemId[eid])) continue;
      this.due.delete(eid);
      const max = this.host.ships.get(eid)?.derived.fx?.flash?.max ?? 0;
      if (max > 0) this.restore(eid, Math.min(max, d.pts));
    }
  }

  onShipRebuilt(eid: number): void {
    // (Its Flash Screens are gone: nothing to wait for)
    if (this.due.has(eid) && !((this.host.ships.get(eid)?.derived.fx?.flash?.max ?? 0) > 0)) this.due.delete(eid);
  }

  onLeave(eid: number): void { this.due.delete(eid); }

  /** Whether a return is pending for this ship (tests) */
  waiting(eid: number): boolean { return this.due.has(eid); }

  private restore(eid: number, pts: number): void {
    const ship = this.host.ships.get(eid);
    if (!ship) return;
    ship.shield = Math.min(ship.derived.shieldMax, ship.shield + pts);
    this.host.effect(eid, EffectType.ShieldFlash);
  }
}
