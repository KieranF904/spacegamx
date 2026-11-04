/**
 * Boss arenas' barriers, the server's side (docs/bosses/rework-2026-11.md 7.1; the shared rules: common world/gates.ts).
 * The barrier itself is solid terrain on both sides, so nothing here stops shots or ships: this is passing it.
 *
 *   interact   within GATE.reach of the barrier: entering is free; leaving needs GATE.quiet ticks out of combat
 *              (CombatClock), or the pilot is told why not and how long is left
 *   passing    the ship is put just past the barrier on the other side, stopped, keeping its heading
 *              (a teleport: an own-ship keyframe; rails on the shared flight step are a later step)
 *   death      a pilot who died or logged in inside is put outside (`placeOutside`): you never come back inside
 *   crossing   whoever passes inward is reported (`onEnter`): the boss's lifecycle wakes from it
 *
 * Who is inside an arena (`present`) is what the boss counts as its pilots (personal attacks, recovery).
 */

import { Position, Velocity, InSystem, GATE, insideArena, nearGate, passPoint, terrainRadius, type ArenaDef } from '@space-game/common';
import type { CombatClock } from './CombatClock.js';

export interface GatesHost {
  tick(): number;
  /** A system's arena (systems.json `arena`), by its number */
  arenaOf(num: number): ArenaDef | undefined;
  /** Living pilots in a system */
  players(num: number): number[];
  /** A ship's collision radius against terrain (its derived radius), or -1 if it has no ship */
  shipRadius(eid: number): number;
  /** Put a ship somewhere (its client is told: an own-ship keyframe) */
  teleport(eid: number, x: number, y: number): void;
  /** A notice to one pilot */
  toast(eid: number, text: string, kind: 'info' | 'warn'): void;
  /** A shimmer where a ship goes through */
  warpFx(num: number, x: number, y: number, out: boolean): void;
  readonly combat: CombatClock;
}

export class ArenaGates {
  /** Called with a pilot who passed inward */
  onEnter: ((num: number, eid: number) => void) | null = null;
  /** Ships that count as pilots present though they aren't players (the dev tools' dummy pilots), by system */
  extras: ((num: number) => number[]) | null = null;

  constructor(private host: GatesHost) {}

  /** Who was last in combat, and last hurt (leaving; a boss's recovery) */
  get combat(): CombatClock {
    return this.host.combat;
  }

  /** The arena a ship is in the system of, if any */
  arenaAt(eid: number): ArenaDef | undefined {
    return this.host.arenaOf(InSystem.systemId[eid]);
  }

  /** Is this ship inside its system's arena */
  inside(eid: number): boolean {
    const a = this.arenaAt(eid);
    return !!a && insideArena(a, Position.x[eid], Position.y[eid]);
  }

  /** The pilots inside a system's arena (living players, then the dev tools' dummies) */
  present(num: number): number[] {
    const a = this.host.arenaOf(num);
    if (!a) return [];
    const out = this.host.players(num).filter((p) => insideArena(a, Position.x[p], Position.y[p]));
    for (const d of this.extras?.(num) ?? []) if (insideArena(a, Position.x[d], Position.y[d])) out.push(d);
    return out;
  }

  /** Ticks this pilot must still wait to leave (0: free to go) */
  leaveWait(eid: number): number {
    return Math.max(0, GATE.quiet - this.host.combat.quietFor(eid, this.host.tick()));
  }

  /**
   * The interact key: true if it was about the barrier (near one), whether or not it let them through. Entering is
   * free; leaving needs them out of combat
   */
  interact(eid: number): boolean {
    const a = this.arenaAt(eid);
    if (!a) return false;
    const x = Position.x[eid], y = Position.y[eid];
    if (!nearGate(a, x, y)) return false;
    const r = this.host.shipRadius(eid);
    if (r < 0) return true;
    const inward = !insideArena(a, x, y);
    if (!inward) {
      const wait = this.leaveWait(eid);
      if (wait > 0) { this.host.toast(eid, `In combat: ${(wait / 60).toFixed(1)} s before you can leave`, 'warn'); return true; }
    }
    this.pass(eid, a, inward, terrainRadius(r));
    return true;
  }

  private pass(eid: number, a: ArenaDef, inward: boolean, shipR: number): void {
    const num = InSystem.systemId[eid];
    const to = passPoint(a, Position.x[eid], Position.y[eid], shipR, inward);
    this.host.warpFx(num, Position.x[eid], Position.y[eid], true);
    this.host.teleport(eid, to.x, to.y);
    // (through and stopped: nothing carries it back into the barrier)
    Velocity.x[eid] = 0; Velocity.y[eid] = 0;
    this.host.warpFx(num, to.x, to.y, false);
    if (inward) this.onEnter?.(num, eid);
  }

  /** A pilot inside an arena (died there, logged out there) is put outside, at its `outside` point */
  placeOutside(eid: number): boolean {
    const a = this.arenaAt(eid);
    if (!a || !insideArena(a, Position.x[eid], Position.y[eid])) return false;
    this.host.teleport(eid, a.outside.x, a.outside.y);
    Velocity.x[eid] = 0; Velocity.y[eid] = 0;
    return true;
  }
}
