/**
 * What a kind on the PT timeline reads of another ship past the confirmed tick (a mob's target, a boss's, a move's
 * aim), without touching the tick-accurate layer. Reading the replica layer itself past the snapshots (preAt / at of
 * another pilot there) steps that ship ahead in the layer, and something kept from those steps is read by the ST that
 * is stepped later: a mob's ST drifted off the server's (server net/decisions/ptWorld.test.ts, "mites at a weaving
 * pilot"; suspected: contact pairs found on the layer for ticks past the snapshot, ContactWorld's memo). So past C:
 *
 *   your own ship   its own layer (the prediction is its truth there; never asked past the predicted tick)
 *   a ship on PT    the ship kind's PT (`pt`: PtStLayer's ring), when there is one
 *   another pilot   its ST at C stepped on alone on held controls (ShipReplicaSet.stepAlone: replicaStep), kept here
 *   anything else   the replica layer (a body flown by its decisions: its driver reads through this too)
 *
 * At or before C: the replica layer, as the snapshots' runners read it.
 */
import { ReplicaMode, type FlightBody, type ReplicaState, type ShipReplicaSet } from '@space-game/common';

export interface AheadReadsHost {
  reps: ShipReplicaSet;
  /** The confirmed tick (the newest snapshot's) */
  confirmed(): number;
  self(): number;
  /** The ship kind's PT of a ship at tick t (as it ended t), if it has one */
  pt?(id: number, t: number): FlightBody | null;
}

export class AheadReads {
  /** Held-input paths of pilots past C: [C's tick, states from C on] */
  private readonly held = new Map<number, { from: number; states: ReplicaState[] }>();

  constructor(private readonly host: AheadReadsHost) {}

  /** As the server's step reads a ship at tick t: a pilot after its own step, before that tick's causes */
  now(id: number, t: number): FlightBody | null {
    const h = this.host, c = h.confirmed();
    if (t <= c || id === h.self()) return h.reps.preAt(id, t);
    return this.ahead(id, t);
  }

  /** A ship as it ended tick t */
  at(id: number, t: number): FlightBody | null {
    const h = this.host, c = h.confirmed();
    if (t <= c || id === h.self()) return h.reps.at(id, t)?.body ?? null;
    return this.ahead(id, t);
  }

  private ahead(id: number, t: number): FlightBody | null {
    const h = this.host;
    const pt = h.pt?.(id, t);
    if (pt) return pt;
    if (h.reps.modeOf(id) !== ReplicaMode.Player) return h.reps.at(id, t)?.body ?? null;
    const c = h.confirmed();
    let p = this.held.get(id);
    if (!p || p.from !== c) {
      const st = h.reps.at(id, c) as ReplicaState | null;
      if (!st) return null;
      this.held.set(id, (p = { from: c, states: [st] }));
    }
    while (p.from + p.states.length - 1 < t) {
      const prev = p.states[p.states.length - 1], k = p.from + p.states.length;
      const next = h.reps.stepAlone(id, prev, k, prev.bits, prev.q);
      if (!next) break;
      p.states.push(next);
    }
    return p.states[Math.min(t - p.from, p.states.length - 1)]?.body ?? null;
  }

  /** Forget the held paths (a new confirmed tick makes them afresh anyway) */
  clear(): void {
    this.held.clear();
  }
}
