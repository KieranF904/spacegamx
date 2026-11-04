/**
 * What moved a pilot's ship this tick besides its own controls, as each happened (CAPS.OWN_SIM; common
 * network/ownTick.ts, docs/design/confirmed-hits.md part G): a pull's push, a contact (with the other body as the
 * contact pass had it), a rebuild's recentring. Replication (net/Replication.ts) takes them after the tick, works them
 * out on its shadow of the ship with the very functions its client runs, and hands them to that client as causes.
 * Kept for pilots only, whatever their caps (a contact is rare and costs a few numbers).
 */
import type { OwnShape, ShipState, Vec2 } from '@space-game/common';
import { CONTACT_BIG_BODY } from '@space-game/common';

export interface OwnPull { kind: 0; dvx: number; dvy: number }
export interface OwnContact {
  kind: 1;
  other: number;
  /** CONTACT_FLAG bits: OTHER_PINNED, SECOND, SELF_PINNED (STATE is decided per client when it's sent) */
  flags: number;
  /** The other body as the pass had it just before this pair */
  pre: { x: number; y: number; angle: number; vx: number; vy: number };
  self: OwnShape;
  otherShape: OwnShape;
  /** The other's rebuild count then (a client with a later structure of it can't work the contact out) */
  otherRebuilds: number;
}
export interface OwnRebuild { kind: 2; from: Vec2; to: Vec2 }
export type OwnCause = OwnPull | OwnContact | OwnRebuild;

/** A ship's structure as a contact reads it */
export function ownShape(ship: ShipState, geom: OwnShape['geom']): OwnShape {
  const d = ship.derived;
  return { geom, alive: d.alive, com: d.com, mass: d.mass, radius: d.radius, big: ship.blueprint.parts.length > CONTACT_BIG_BODY };
}

export class OwnCauses {
  /** This tick's causes, by pilot */
  private readonly now = new Map<number, OwnCause[]>();

  add(eid: number, c: OwnCause): void {
    let l = this.now.get(eid);
    if (!l) this.now.set(eid, (l = []));
    l.push(c);
  }

  /** A pilot's causes this tick (and forgotten) */
  take(eid: number): OwnCause[] | undefined {
    const l = this.now.get(eid);
    if (l) this.now.delete(eid);
    return l;
  }

  clear(): void {
    this.now.clear();
  }
}
