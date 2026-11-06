/**
 * The kinds of ship on the PT layer (ptst.ts) and its tuning: a registry, each kind saying which ships are its own,
 * how one is stepped a tick on PT, whether contacts there move it, and how far behind your own shells it is drawn
 * (where your shells meet it on the tick layer: sim/timeline.ts hitStateTick). The first kind in PT_KINDS that claims
 * a ship has it. A new kind (a track stepping some other ship its own way) registers with registerPtKind; nothing in
 * the layer or the draw path names a kind.
 *
 *   ai       flown from its decisions, hits found here (BodyRunner.ahead: AI pilots, custom enemies; not bosses): read
 *            off the replica layer stepped ahead ('decided'); contacts there don't move it (its body's path)
 *   pilot    another pilot (replica mode Player): held last input ('assumed': common CtlChangeInputs with no change
 *            ahead), stepped by the replica set's own step (ShipReplicaSet.stepAlone: replicaStep)
 *   rows     anything else flown by control rows (dummies, haulers, anchored wrecks): held last input, as a pilot
 */
import { AHEAD_BACK, CtlChangeInputs, ReplicaMode, ReplicaState, type FlightBody } from '@space-game/common';
import type { PtHost } from './world';

export interface PtShipKind {
  readonly name: string;
  /** Is this ship of this kind (asked in registry order: the first that says yes has it) */
  claims(id: number, host: PtHost): boolean;
  /** One tick from `prev` (its PT at t - 1): a new state, `prev` untouched. Null: can't (it drops off PT) */
  step(id: number, prev: ReplicaState, t: number, host: PtHost): ReplicaState | null;
  /** Do PT contacts move it */
  readonly pushable: boolean;
  /** Ticks behind your own shells' draw tick it is drawn at (and its shells) */
  readonly drawBack: number;
}

/**
 * Level of detail (the crowd rule, docs/areas/networking.md "Other ships: the PT/ST layer"): ships further than `reach`
 * from your own ship (at the confirmed tick) stay on the plain confirmed view (interpolated at the render tick); one
 * on PT leaves it past `reach * leaveShare`. At most `maxShips` on PT, nearest first (one on PT counted that much
 * nearer: no churn at the edge). A ship going onto PT or off it is eased between the two poses (modes.ts ptstHook)
 */
export const PT_TUNING = { reach: 6000, leaveShare: 1.15, maxShips: 48 };

const HELD = new CtlChangeInputs('assumed', () => undefined);
const PREV = { id: 0, body: undefined as unknown as FlightBody, ctl: { bits: 0, q: 0 } };

/** Held last input: what it flew the tick before, through the replica set's own step */
function heldStep(id: number, prev: ReplicaState, t: number, host: PtHost): ReplicaState | null {
  PREV.id = id; PREV.body = prev.body; PREV.ctl.bits = prev.bits; PREV.ctl.q = prev.q;
  const input = HELD.inputAt(t, PREV);
  return host.reps.stepAlone(id, prev, t, input.bits, input.q);
}

/** A pilot is hit-tested at tick t as it ended t, anyone else as it ended t - 1: drawn that far behind your shells */
const PILOT_BACK = AHEAD_BACK - 1;

export const PT_KINDS: PtShipKind[] = [
  {
    name: 'ai',
    claims: (id, h) => h.bodies.ahead(id),
    step(id, prev, t, h) {
      // (Decided: its body flies it on the replica layer; a copy, so the PT layer's contacts can't reach the ring)
      const s = h.reps.at(id, t);
      return s ? new ReplicaState(id, h.reps.modeOf(id) ?? prev.mode, { ...s.body }, s.bits, s.q) : null;
    },
    pushable: false,
    drawBack: AHEAD_BACK,
  },
  { name: 'pilot', claims: (id, h) => h.reps.modeOf(id) === ReplicaMode.Player, step: heldStep, pushable: true, drawBack: PILOT_BACK },
  { name: 'rows', claims: () => true, step: heldStep, pushable: true, drawBack: AHEAD_BACK },
];

/** Add a kind ahead of `before` (by name; default ahead of the catch-all 'rows') */
export function registerPtKind(k: PtShipKind, before = 'rows'): void {
  const old = PT_KINDS.findIndex((x) => x.name === k.name);
  if (old >= 0) PT_KINDS.splice(old, 1);
  const i = PT_KINDS.findIndex((x) => x.name === before);
  PT_KINDS.splice(i < 0 ? PT_KINDS.length : i, 0, k);
}

export function kindOf(id: number, host: PtHost): PtShipKind {
  for (const k of PT_KINDS) if (k.claims(id, host)) return k;
  return PT_KINDS[PT_KINDS.length - 1];
}
