/**
 * Who was last in combat, and when: damage dealt or taken, from any source (docs/bosses/rework-2026-11.md 7.1, 8).
 * Leaving a boss arena needs a pilot quiet for GATE.quiet ticks; an enemy heals after LIFE.idle quiet ticks. Fed by
 * the ship bridge's damage report (GameServer notifyDamage), one entry per ship, forgotten with the ship.
 */

export class CombatClock {
  private last = new Map<number, number>();

  /** Damage landed: both sides are in combat at this tick */
  note(target: number, source: number, tick: number): void {
    this.last.set(target, tick);
    if (source >= 0 && source !== target) this.last.set(source, tick);
  }

  /** The last tick it dealt or took damage (-Infinity: never) */
  lastOf(eid: number): number {
    return this.last.get(eid) ?? -Infinity;
  }

  /** Ticks since it was last in combat (Infinity: never) */
  quietFor(eid: number, tick: number): number {
    return tick - this.lastOf(eid);
  }

  /** Its ship is gone (its number may be reused) */
  forget(eid: number): void {
    this.last.delete(eid);
  }

  /** Drop entries quiet longer than `age` (nothing asks about them: an entity number reused starts quiet) */
  prune(tick: number, age: number): void {
    for (const [e, t] of this.last) if (tick - t > age) this.last.delete(e);
  }

  /** (dev) treat it as quiet from long ago */
  clear(eid: number): void {
    this.last.delete(eid);
  }
}
