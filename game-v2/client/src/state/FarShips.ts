/**
 * Far ships for the system map: the ships of this system past the snapshot's
 * ship view (mapDots: pilotless ones, some of them distant on the server,
 * server/src/ships/SimLod.ts; and other pilots). Each is a leg in closed form
 * (common ships/farRoute.ts) carried on exactly as the server reckons it, or a
 * patrol (round a home that stays put: its legs worked out here as the server
 * works them out, from its dice), so the server only sends a ship again when
 * its way changes (a distant one's route, a live one straying from where it's
 * drawn), what it is when that's new or changes, and the ones gone. When a
 * ship's new leg has it a little off from where it was being drawn, the
 * difference is eased out over a moment instead of jumping.
 */

import { unpackMapLegs, unpackMapRoutes, unpackMapInfo, legAt, patrolNext, MAP_PT_STRIDE, type Leg, type MapDot, type Patrol, type PatrolState, type ServerMapDotsMessage } from '@space-game/common';

/** How long a correction takes to ease out (ticks); a hostile's place (pts: sent every 1-5 s) glides over longer */
const EASE_TICKS = 40;
const PT_EASE_TICKS = 100;

export interface FarShip extends MapDot {
  name?: string;
  /** Where its leg has it now, and how it's moving (world units, a tick) */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Where it's drawn now (world units) */
  renderX: number;
  renderY: number;
}

/** A ship's leg from `tick` (on patrol: the leg it's got to, moved on as time passes), and the correction being eased out */
interface Track { leg: Leg; tick: number; patrol?: { p: Patrol; s: PatrolState }; ox: number; oy: number; eased: number; ease?: number }

/** Most of a patrol's legs worked out in one go (a list left alone a long while just carries on from there) */
const MAX_LEGS = 2000;

export class FarShips {
  private tracks = new Map<number, Track>();
  private looks = new Map<number, MapDot>();
  private names = new Map<number, string>();
  /** The system the list is for (it's dropped on a jump to another) */
  private system = '';

  /** What's changed: `tick` is the server tick now (as the client has it), to ease from where each was being drawn */
  apply(msg: ServerMapDotsMessage, system: string, tick: number): void {
    if (system !== this.system) this.clear(system);
    // (A fresh list: what it hasn't got is gone. Names stay: the server tells each one once)
    if (msg.full) { this.tracks.clear(); this.looks.clear(); }
    const names = msg.names ?? [];
    for (let i = 0; i + 1 < names.length; i += 2) this.names.set(names[i] as number, String(names[i + 1]));
    for (const d of unpackMapInfo(msg.info ?? [])) this.looks.set(d.id, d);
    const take = (id: number, next: Track) => {
      const old = this.tracks.get(id);
      if (old) {
        // Where it's drawn now, against where the new leg puts it now: that gap is eased out
        const was = this.at(old, tick), now = this.at(next, tick);
        next.ox = was.x - now.x; next.oy = was.y - now.y;
        // (A long way off: it jumped, or it's a new ship with an old number)
        if (Math.hypot(next.ox, next.oy) > 6000) next.ox = next.oy = 0;
      }
      this.tracks.set(id, next);
    };
    for (const { id, leg } of unpackMapLegs(msg.dots)) take(id, { leg, tick: msg.tick, ox: 0, oy: 0, eased: tick });
    for (const { id, patrol, state } of unpackMapRoutes(msg.routes ?? [], msg.tick)) take(id, { leg: state.leg, tick: state.t0, patrol: { p: patrol, s: state }, ox: 0, oy: 0, eased: tick });
    // (Hostiles' places: held where they were last seen, the step from the last one eased)
    const pts = msg.pts ?? [];
    for (let i = 0; i + MAP_PT_STRIDE <= pts.length; i += MAP_PT_STRIDE) {
      take(pts[i], { leg: { x: pts[i + 1] * 10, y: pts[i + 2] * 10, vx: 0, vy: 0, wx: 0, wy: 0, thrust: -1 }, tick: msg.tick, ox: 0, oy: 0, eased: tick, ease: PT_EASE_TICKS });
    }
    for (const id of msg.gone ?? []) { this.tracks.delete(id); this.looks.delete(id); }
  }

  clear(system = ''): void {
    this.tracks.clear();
    this.looks.clear();
    this.names.clear();
    this.system = system;
  }

  /** Every far ship at server tick `tick` (`skip`: ones the client has as real entities now) */
  list(system: string, tick: number, skip?: (id: number) => boolean): FarShip[] {
    if (system !== this.system) return [];
    const out: FarShip[] = [];
    for (const [id, t] of this.tracks) {
      if (skip?.(id)) continue;
      const p = this.at(t, tick), m = legAt(t.leg, tick - t.tick);
      const look = this.looks.get(id) ?? { id, kind: 0, rank: 0, calm: false, faction: -1, rating: 0 };
      out.push({ ...look, id, name: this.names.get(id), x: m.x, y: m.y, vx: m.vx, vy: m.vy, renderX: p.x, renderY: p.y });
    }
    return out;
  }

  get size(): number {
    return this.tracks.size;
  }

  private at(t: Track, tick: number): { x: number; y: number } {
    // (On patrol: on to the leg it's got to by now)
    for (let n = 0; t.patrol && tick >= t.patrol.s.end && n < MAX_LEGS; n++) {
      t.patrol.s = patrolNext(t.patrol.p, t.patrol.s);
      t.leg = t.patrol.s.leg; t.tick = t.patrol.s.t0;
    }
    const p = legAt(t.leg, tick - t.tick);
    const e = Math.max(0, 1 - (tick - t.eased) / (t.ease ?? EASE_TICKS));
    // (Smoothstep: no kink at either end)
    const s = e * e * (3 - 2 * e);
    return { x: p.x + t.ox * s, y: p.y + t.oy * s };
  }
}
