/**
 * The Flash Screen's world half (the shared half and its numbers: common/src/ships/features/flash). The bridge tells it
 * when a ship's shield breaks (`onShieldBreak`): the screens' share is back whole FLASH_RESTORE_TICKS later (`tick`),
 * and the screens bloom white where the ship is, for everyone in the system.
 */
import { InSystem, EffectType, FLASH_RESTORE_TICKS } from '@space-game/common';
import type { FeatureInstance, ShipsOf, TellCap, WorldCap } from '../types.js';
import { SimPass } from '../../../sim/SystemClocks.js';

/** What the Flash Screen asks of the game: the clock, the ships' records, the bloom */
export type FlashHost = Pick<WorldCap, 'getTick'> & ShipsOf<'get'> & Pick<TellCap, 'effect'>;

export class Flash implements FeatureInstance {
  /** Ships whose Flash Screens are on their way back: the tick they return, and the points */
  private readonly due = new Map<number, number>();

  constructor(private readonly host: FlashHost) {}

  /** The ship's shield just broke (it held something a moment ago, and holds nothing now) */
  onShieldBreak(eid: number): void {
    const ship = this.host.ships.get(eid);
    const max = ship?.derived.fx?.flash?.max ?? 0;
    if (!ship || max <= 0) return;
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
}
