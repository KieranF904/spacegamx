/**
 * Far ships for the system map: the ships of this system past the snapshot's
 * ship view (mapDots, once a second; some of them distant on the server:
 * server/src/ships/SimLod.ts). Each is carried on along its velocity between
 * lists, and when a new list puts it somewhere a little different, the
 * difference is eased out over a moment instead of jumping.
 */

import { unpackMapDots, type MapDot, type ServerMapDotsMessage } from '@space-game/common';

/** How long a list's corrections take to ease out (ticks), and how far past its list a dot is carried on at most */
const EASE_TICKS = 40;
const CARRY_TICKS = 150;

export interface FarShip extends MapDot {
  name?: string;
  /** Where it's drawn now (world units) */
  renderX: number;
  renderY: number;
}

interface Track { dot: MapDot; tick: number; ox: number; oy: number; eased: number }

export class FarShips {
  private tracks = new Map<number, Track>();
  private names = new Map<number, string>();
  /** The system the list is for (it's dropped on a jump to another) */
  private system = '';

  /** A new list: `tick` is the server tick now (as the client has it), to ease from where each was being drawn */
  apply(msg: ServerMapDotsMessage, system: string, tick: number): void {
    if (system !== this.system) this.clear(system);
    const names = msg.names ?? [];
    for (let i = 0; i + 1 < names.length; i += 2) this.names.set(names[i] as number, String(names[i + 1]));
    const next = new Map<number, Track>();
    for (const d of unpackMapDots(msg.dots)) {
      const old = this.tracks.get(d.id);
      let ox = 0, oy = 0;
      if (old) {
        // Where it's drawn now, against where the new list puts it now: that gap is eased out
        const was = this.at(old, tick), now = this.carry(d, msg.tick, tick);
        ox = was.x - now.x; oy = was.y - now.y;
        // (A long way off: it jumped, or it's a new ship with an old number)
        if (Math.hypot(ox, oy) > 6000) ox = oy = 0;
      }
      next.set(d.id, { dot: d, tick: msg.tick, ox, oy, eased: tick });
    }
    // (Names stay: one in view for a while comes back to the list unnamed, the server having told it once)
    this.tracks = next;
  }

  clear(system = ''): void {
    this.tracks.clear();
    this.names.clear();
    this.system = system;
  }

  /** Every far ship at server tick `tick` (`skip`: ones the client has as real entities now) */
  list(system: string, tick: number, skip?: (id: number) => boolean): FarShip[] {
    if (system !== this.system) return [];
    const out: FarShip[] = [];
    for (const [id, t] of this.tracks) {
      if (skip?.(id)) continue;
      const p = this.at(t, tick);
      out.push({ ...t.dot, name: this.names.get(id), renderX: p.x, renderY: p.y });
    }
    return out;
  }

  get size(): number {
    return this.tracks.size;
  }

  private carry(d: MapDot, from: number, tick: number): { x: number; y: number } {
    const k = Math.max(0, Math.min(CARRY_TICKS, tick - from));
    return { x: d.x + d.vx * k, y: d.y + d.vy * k };
  }

  private at(t: Track, tick: number): { x: number; y: number } {
    const p = this.carry(t.dot, t.tick, tick);
    const e = Math.max(0, 1 - (tick - t.eased) / EASE_TICKS);
    // (Smoothstep: no kink at either end)
    const s = e * e * (3 - 2 * e);
    return { x: p.x + t.ox * s, y: p.y + t.oy * s };
  }
}
