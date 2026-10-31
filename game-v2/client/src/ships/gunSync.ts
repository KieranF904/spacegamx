/**
 * The gun-state correction, client side (docs/design/rework-2026-11.md §3.3). Your guns' clips and charges are
 * stepped forward by your own client (guns.ts stepGuns, never on a replay), so a missed or extra shot leaves them
 * out of step with the server's. The pilot row's last slot carries the server's (guns.ts packGunState); each predicted
 * tick's own values are kept here, and a gun takes the server's value only once the two have disagreed for
 * GUN_STATE_PATIENCE ticks running, so normal latency never snaps a pip.
 *
 * Fixed-size history (HISTORY ticks × GUN_STATE_MAX guns): recording a tick allocates nothing.
 */

import { GUN_STATE_MAX, GUN_STATE_PATIENCE, applyGunState, carriesGunState, gunStateAt, gunStateValue, type ShipState } from '@space-game/common';

/** Ticks of our own gun state kept (more than the prediction ever runs ahead of the server) */
const HISTORY = 128;

export class GunSync {
  private readonly vals = new Int32Array(HISTORY * GUN_STATE_MAX);
  private readonly parts = new Int32Array(HISTORY * GUN_STATE_MAX).fill(-1);
  private readonly ticks = new Float64Array(HISTORY).fill(-1);
  /** By part index: the server tick it first disagreed at (absent: agreeing) */
  private readonly since = new Map<number, number>();
  private ship: ShipState | null = null;

  /** After a predicted tick of your guns: what they hold now */
  record(ship: ShipState, tick: number): void {
    if (ship !== this.ship) { this.ship = ship; this.since.clear(); this.ticks.fill(-1); }
    const slot = ((tick % HISTORY) + HISTORY) % HISTORY, at = slot * GUN_STATE_MAX;
    let n = 0;
    for (const w of ship.derived.weapons) {
      if (n >= GUN_STATE_MAX || !carriesGunState(w)) continue;
      this.parts[at + n] = w.part;
      this.vals[at + n] = gunStateValue(ship, w);
      n++;
    }
    for (let k = n; k < GUN_STATE_MAX; k++) this.parts[at + k] = -1;
    this.ticks[slot] = tick;
  }

  /**
   * A pilot row from the server at `tick`: each gun it carries against what we predicted for that tick. Returns how
   * many guns took the server's value (after GUN_STATE_PATIENCE ticks of disagreeing).
   */
  onRow(ship: ShipState, data: ArrayLike<number>, tick: number): number {
    if (ship !== this.ship) return 0;
    const at = gunStateAt(data), count = data[at] | 0;
    const slot = ((tick % HISTORY) + HISTORY) % HISTORY;
    if (this.ticks[slot] !== tick) return 0;
    let adopted = 0;
    for (let i = 0; i < count && i < GUN_STATE_MAX; i++) {
      const part = data[at + 1 + 2 * i], v = data[at + 2 + 2 * i];
      let mine: number | undefined;
      for (let k = 0; k < GUN_STATE_MAX; k++) if (this.parts[slot * GUN_STATE_MAX + k] === part) { mine = this.vals[slot * GUN_STATE_MAX + k]; break; }
      if (mine === undefined) continue;
      if (mine === v) { this.since.delete(part); continue; }
      const from = this.since.get(part);
      if (from === undefined || from > tick) { this.since.set(part, tick); continue; }
      if (tick - from < GUN_STATE_PATIENCE) continue;
      const w = ship.derived.weapons.find((x) => x.part === part);
      if (w) { applyGunState(ship, w, v); adopted++; }
      this.since.delete(part);
    }
    return adopted;
  }
}
