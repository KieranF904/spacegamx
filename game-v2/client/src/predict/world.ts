/**
 * The PT/ST layer's world over the client's tick layer (ptst.ts PtStWorld): ST from the replica layer at a confirmed
 * tick; PT steps by each ship's kind (shipKinds.ts); the tick's contact pass the server's (contacts.ts RealContacts) over
 * the PT ships and your own ship, which is fixed here (stepped on its own layer, never past its prediction).
 *
 * Which ships: those the host holds on its replica layer with their structure, flown (not docked, not debris), not
 * your own, not a boss whose hits are told (BodyRunner.told: drawn as it is), within the level of detail's reach of
 * your own ship (shipKinds.ts PT_TUNING). The host is the game (Prediction.ts over GameState / ShipClient) or the crowd
 * bench's probe (server bench/crowd/probe.ts over its FakeHitsClient): the same tick layer either way.
 */
import { CONTACT_BIG_BODY, ReplicaMode, type ReplicaState, type ShipDerived, type ShipReplicaSet, type ShipTuning } from '@space-game/common';
import type { StructSource } from '../ships/ShipStore';
import type { PtStWorld } from './ptst';
import { RealContacts, type PtShape } from './contacts';
import { PT_TUNING, kindOf, type PtShipKind } from './shipKinds';

/** What the PT layer reads of the client */
export interface PtHost {
  reps: ShipReplicaSet;
  store: StructSource;
  bodies: { ahead(id: number): boolean; told(): Iterable<number> };
  tuning: ShipTuning;
  /** Its own ship's id */
  self(): number;
  /** The newest tick a snapshot has told */
  confirmed(): number;
  /** The own prediction's tick */
  predicted(): number;
  /** The ships it could predict (any held ship id: the PT world filters them) */
  candidates(): Iterable<number>;
  /** The structure a ship flew tick t with (default its current one) */
  derivedAt?(id: number, t: number): ShipDerived | null | undefined;
}

const MODES = new Set([ReplicaMode.Player, ReplicaMode.Pilotless, ReplicaMode.Anchored]);

export class ReplicaPtWorld implements PtStWorld {
  readonly contacts: RealContacts;
  private list: number[] = [];
  private readonly kinds = new Map<number, PtShipKind>();
  /** Ships left out for the level of detail at the last list (the overlay's count) */
  lodOut = 0;

  constructor(private readonly host: PtHost) {
    this.contacts = new RealContacts((id, t) => this.shape(id, t), host.tuning, (id, t) => host.reps.clampPartner(id, t));
  }

  ships(): readonly number[] {
    const h = this.host, reps = h.reps, self = h.self(), c = h.confirmed();
    const told = new Set(h.bodies.told());
    const me = reps.at(self, c)?.body;
    const near: [number, number][] = [];
    this.lodOut = 0;
    for (const id of h.candidates()) {
      if (id === self || told.has(id) || !reps.has(id)) continue;
      const m = reps.modeOf(id);
      if (m === undefined || !MODES.has(m) || !h.store.get(id)?.derived) continue;
      let d2 = 0;
      if (me) {
        const b = reps.at(id, c)?.body;
        if (!b) continue;
        // (One on PT already has its distance shrunk by the leave share: it stays until it's clearly out, no churn at the edge)
        const share = this.kinds.has(id) ? PT_TUNING.leaveShare : 1;
        d2 = ((b.x - me.x) ** 2 + (b.y - me.y) ** 2) / (share * share);
        if (d2 > PT_TUNING.reach * PT_TUNING.reach) { this.lodOut++; continue; }
      }
      near.push([id, d2]);
    }
    if (near.length > PT_TUNING.maxShips) { near.sort((a, b) => a[1] - b[1]); this.lodOut += near.length - PT_TUNING.maxShips; near.length = PT_TUNING.maxShips; }
    this.list.length = 0;
    const keep = new Set<number>();
    for (const [id] of near) {
      this.list.push(id);
      keep.add(id);
      this.kinds.set(id, kindOf(id, h));
    }
    for (const id of this.kinds.keys()) if (!keep.has(id)) this.kinds.delete(id);
    return this.list;
  }

  /** The kind a ship on the layer was given (shipKinds.ts) */
  kind(id: number): PtShipKind | undefined {
    return this.kinds.get(id);
  }

  st(id: number, t: number): ReplicaState | null {
    if (t > this.host.confirmed()) return null;
    return (this.host.reps.at(id, t) as ReplicaState | null) ?? null;
  }

  step(id: number, prev: ReplicaState, t: number): ReplicaState | null {
    return (this.kinds.get(id) ?? kindOf(id, this.host)).step(id, prev, t, this.host);
  }

  pushable(id: number): boolean {
    return this.kinds.get(id)?.pushable ?? true;
  }

  fixed(t: number): readonly ReplicaState[] {
    // (Only what its layer has stepped: asking it further would step your own ship, and fire what it fires, early)
    const h = this.host;
    const s = t <= h.predicted() ? h.reps.ring.get(h.self(), t) : undefined;
    return s ? [s as ReplicaState] : [];
  }

  /** A ship's structure as the contact pass reads it at tick t */
  private shape(id: number, t: number): PtShape | null {
    const h = this.host, s = h.store.get(id);
    if (!s || s.kind !== 'ship') return null;
    const d = h.derivedAt?.(id, t) ?? s.derived;
    if (!d || !(d.mass > 0)) return null;
    return { mass: d.mass, radius: d.radius, geom: h.store.geometry(s), alive: d.alive, com: d.com, big: s.blueprint.parts.length > CONTACT_BIG_BODY };
  }
}
