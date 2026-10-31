/**
 * Gun sounds that follow the firing models (docs/design/rework-2026-11.md §3, §7): a rising charge whine while a charge
 * gun gathers, a clack as a clip seats, the reload vent on a clip's last round, the Chainsaw's spin-up.
 *
 * Your own guns are read off the gun state your client steps (guns.ts); other ships' clip guns are counted by their
 * fire events, a round for each, so the vent plays on the last one with no state on the wire. Nothing here allocates
 * per tick beyond the map entries of ships in sight.
 */

import type { ShipState, WeaponInfo } from '@space-game/common';

type Play = (id: string, at?: { x: number; y: number }, volume?: number, pitch?: number) => (() => void) | null;

/** A clip gun that goes this many ticks without firing is reloading its partial clip (guns.ts CLIP_IDLE): the count starts over */
const COUNT_IDLE = 60;

export class GunFeel {
  /** Your guns, by part: last tick's reload and charge and spin, so edges are heard once */
  private prevReload: number[] = [];
  private prevCharge: number[] = [];
  private prevSpin: number[] = [];
  private whine: ((() => void) | null)[] = [];
  /** Other ships' clip guns: owner * 256 + part → rounds fired since the clip was full, and the tick of the last */
  private counts = new Map<number, { n: number; tick: number }>();

  constructor(private play: Play) {}

  /** After a predicted tick of your own guns (never on a replay) */
  own(ship: ShipState, tick: number): void {
    void tick;
    for (const w of ship.derived.weapons) {
      const p = w.part, f = w.fire;
      if (f.model === 'clip') {
        const rl = ship.reload[p] ?? 0, was = this.prevReload[p] ?? 0;
        // A reload finished (the clip seated), or a regrown round came back
        if (was > 0 && rl <= 0) this.play('gun_clack', undefined, 0.5);
        // The last round just went: the vent
        if (!f.regrow && (ship.rounds[p] ?? 0) <= 0 && rl > 0 && was <= 0) this.play('gun_vent', undefined, 0.5);
        this.prevReload[p] = rl;
      } else if (f.model === 'charge') {
        const c = ship.charge[p] ?? 0, was = this.prevCharge[p] ?? 0;
        if (c > 0 && was <= 0) {
          // Pitched so the whine lasts about as long as the gather
          this.whine[p] = this.play('gun_charge', undefined, 0.45, 1.4 / Math.max(0.6, (f.charge ?? 60) / 60));
        } else if ((c <= 0 || c < was) && this.whine[p]) {
          this.whine[p]!();
          this.whine[p] = null;
        }
        this.prevCharge[p] = c;
      }
      if (f.spin) {
        const s = ship.spin[p] ?? 0, was = this.prevSpin[p] ?? 0;
        if (s > 0 && was <= 0) this.play('gun_spin', undefined, 0.4);
        this.prevSpin[p] = s;
      }
    }
  }

  /** Your ship was rebuilt, respawned or left: forget the edges (and cut a whine) */
  reset(): void {
    for (const stop of this.whine) stop?.();
    this.whine.length = 0;
    this.prevReload.length = 0;
    this.prevCharge.length = 0;
    this.prevSpin.length = 0;
  }

  /** A charge started on another ship's gun (a charge-start fire event) */
  otherCharge(at: { x: number; y: number }, w: WeaponInfo): (() => void) | null {
    return this.play('gun_charge', at, 0.7, 1.4 / Math.max(0.6, (w.fire.charge ?? 60) / 60));
  }

  /** Another ship's clip gun fired a round (a fire event): the vent on the last round of its clip */
  otherRound(owner: number, w: WeaponInfo, tick: number, at: { x: number; y: number }): void {
    const f = w.fire;
    if (f.model !== 'clip' || f.regrow) return;
    const key = owner * 256 + w.part;
    let c = this.counts.get(key);
    if (!c || tick - c.tick > COUNT_IDLE) this.counts.set(key, (c = { n: 0, tick }));
    c.n += f.rounds ?? 1;
    c.tick = tick;
    if (c.n >= (f.clip ?? 1)) {
      c.n = 0;
      this.play('gun_vent', at, 0.6);
    }
    while (this.counts.size > 512) this.counts.delete(this.counts.keys().next().value!);
  }
}
