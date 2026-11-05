/**
 * The PT/ST layer's world in the game (modes C2/C3): ST from the replica layer at a confirmed tick, PT steps by each
 * ship's input source:
 *   other pilots   held last input (common CtlChangeInputs, 'assumed', with no changes ahead: what it flew the tick
 *                  before), stepped with the replica set's own step (ShipReplicaSet.stepAlone: replicaStep -> stepShip)
 *   AI             its decisions ('decided': the replica layer flies it from its body, BodyRunner), read off that layer
 *                  stepped ahead (as mode C1 draws it)
 * Fixed: your own ship on its tick layer (never stepped past the prediction here). Bosses stay interpolated.
 */
import { CtlChangeInputs, EntityType, ReplicaMode, ReplicaState, type FlightBody } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { ShipClient } from '../../ships/ShipClient';
import type { PtStWorld } from './ptst';

/** (Drones and dummies are ship bodies: EntityType.ShipBody; debris too, left out by its replica mode) */
const KINDS = [EntityType.Player, EntityType.Enemy, EntityType.NPC, EntityType.ShipBody];
const MODES = new Set([ReplicaMode.Player, ReplicaMode.Pilotless, ReplicaMode.Anchored]);
/** Contact circle: this share of the ship's bounding radius (a hull fills less than its bounding circle) */
const HULL_SHARE = 0.8;

export class ReplicaPtWorld implements PtStWorld {
  private readonly held = new CtlChangeInputs('assumed', () => undefined);
  private readonly prev = { id: 0, body: undefined as unknown as FlightBody, ctl: { bits: 0, q: 0 } };
  private list: number[] = [];
  private told = new Set<number>();

  constructor(private readonly state: GameState, private readonly sc: ShipClient) {}

  ships(): readonly number[] {
    const s = this.state, reps = this.sc.replicas, self = s.playerId;
    this.told = new Set(this.sc.bodies.told());
    this.list.length = 0;
    for (const type of KINDS) {
      for (const e of s.entities.ofType(type)) {
        if (e.id === self || this.told.has(e.id) || !reps.has(e.id)) continue;
        const m = reps.modeOf(e.id);
        if (m === undefined || !MODES.has(m) || !this.sc.store.get(e.id)?.derived) continue;
        this.list.push(e.id);
      }
    }
    return this.list;
  }

  st(id: number, t: number): ReplicaState | null {
    if (t > this.state.serverTick) return null;
    return (this.sc.replicas.at(id, t) as ReplicaState | null) ?? null;
  }

  step(id: number, prev: ReplicaState, t: number): ReplicaState | null {
    const reps = this.sc.replicas;
    if (this.sc.bodies.ahead(id)) {
      // (Decided: its body flies it on the replica layer; a copy, so the PT layer's contacts can't reach the ring)
      const s = reps.at(id, t);
      return s ? new ReplicaState(id, reps.modeOf(id) ?? prev.mode, { ...s.body }, s.bits, s.q) : null;
    }
    const p = this.prev;
    p.id = id; p.body = prev.body; p.ctl.bits = prev.bits; p.ctl.q = prev.q;
    const input = this.held.inputAt(t, p);
    return reps.stepAlone(id, prev, t, input.bits, input.q);
  }

  shape(id: number): { r: number; inv: number } | null {
    const d = this.sc.store.get(id)?.derived;
    return d && d.mass > 0 ? { r: d.radius * HULL_SHARE, inv: 1 / d.mass } : null;
  }

  pushable(id: number): boolean {
    return !this.sc.bodies.ahead(id);
  }

  fixed(t: number): readonly ReplicaState[] {
    // (Only what its layer has stepped: asking it further would step your own ship, and fire what it fires, early)
    const s = t <= this.state.predictedTick ? this.sc.replicas.ring.get(this.state.playerId, t) : undefined;
    return s ? [s as ReplicaState] : [];
  }
}
