/**
 * @contract client.predict.kind.shells
 * owns:       other ships' shells on the PT timeline: their guns stepped from inputs, records drawn as predicted shells and taken back when wrong
 * needs:      @space-game/common (sim/otherGuns lanes), PtStLayer, ptKinds
 * invariants: a tick whose lane records changed has its drawn shells taken back and the new ones drawn — none pinned
 * extend:     gun behaviour lives in common sim/otherGuns.ts; the kind is registered in worldKinds.ts
 */
/**
 * Other ships' shells on the PT timeline (C3, the default, and C2): what other ships' guns fire ahead of the snapshots,
 * drawn on the tick they fire, where the ship is drawn (its PT pose at its draw tick), instead of a round trip late.
 *
 * Their guns are stepped from their inputs (common sim/otherGuns.ts; the tick layer's lanes: ships/guns/OtherGuns.ts):
 *
 *   ai     an AI pilot on PT (shipKinds.ts `ai`) is the replica layer stepped ahead on its body: its lane steps there too,
 *          so what it fires ahead is the tick layer's own (OtherGuns.eventsAt past the confirmed tick)
 *   pilot  another pilot on held last input (shipKinds.ts `pilot`): its lane stepped here, beside its PT ship, from the
 *          tick layer's lane at the confirmed tick, on its last known gun controls (trigger and cursor distance held)
 *
 * Each tick's records (laneRecords) are drawn as predicted shells (WeaponFx.predict: the snapshot's built shell, the
 * same shot, takes the drawn one over: WeaponFx.claim). Each advance the records of every tick in (confirmed, head]
 * are held to what was drawn: a tick whose records changed (a re-stepped ship, a mispredicted trigger, a decision)
 * has what it drew taken back (`wrong`) and the new drawn. A pilot's lane at the confirmed tick is checked against
 * the tick layer's by hash (`confirm`): off, it's stepped again from there.
 */
import {
  laneRecords, lanePilot, laneHash, ownStructure,
  type FlightBody, type GunCtl, type LaneRec, type OwnExtras, type ReplicaEnv, type ReplicaState, type ShipState, type ShipTuning,
  type SimEnv, type SimEvent, type FieldEnv,
} from '@space-game/common';
import { noPtStats, type PtKind } from '../ptKinds';
import type { PtStLayer } from '../ptst';

export interface ShellsKindHost {
  layer: PtStLayer;
  /** The PT kind a ship on the layer has (shipKinds.ts: 'ai', 'pilot', 'rows') */
  kind(id: number): string | undefined;
  guns: {
    has(id: number): boolean;
    stateAt(id: number, t: number): Readonly<OwnExtras> | undefined;
    eventsAt(id: number, t: number): readonly SimEvent[] | undefined;
    ctlAt(id: number, t: number): GunCtl | undefined;
    hashAt(id: number, t: number): number | undefined;
  };
  ship(id: number): ShipState | undefined;
  tuning: ShipTuning;
  env(): ReplicaEnv;
  confirmed(): number;
  /** A ship on the tick layer where its guns fired on tick t (its replica after t's step, before t's causes) */
  pose(id: number, t: number): FlightBody | null;
  /** Draw a record's shells ahead: a volley fired on tick t from `pose` (a pilot's: spawned a tick earlier). Handles */
  draw(owner: number, t: number, rec: LaneRec, pose: FlightBody, pilot: boolean): number[];
  retract(handle: number): void;
}

interface Drawn { key: string; handles: number[] }
interface Held {
  /** A pilot's lane on PT by tick, the PT ship states each was stepped from, the tick layer's lane it started from */
  lane: Map<number, OwnExtras>;
  evs: Map<number, SimEvent[]>;
  basis: Map<number, ReplicaState>;
  seed?: Readonly<OwnExtras>;
  drawn: Map<number, Drawn>;
}

const SIM_FIELDS: FieldEnv = { central: null };
const SIM_ENV: SimEnv = { tick: 0, tuning: undefined as unknown as SimEnv['tuning'], gravity: null, fields: SIM_FIELDS, terrain: null };
const RECS: LaneRec[] = [];
/** What a tick's drawing was of: its records, and the pose they fired from (a shell's spawn) */
const keyOf = (recs: readonly LaneRec[], pose: { x: number; y: number; angle: number } | null | undefined) =>
  recs.some((r) => r.n > 0) ? `${pose ? `${pose.x},${pose.y},${pose.angle}` : '-'}/${recs.map((r) => `${r.part}:${r.code}:${r.aimQ}:${r.aug}:${r.n}`).join('|')}` : '';

export class ShellsKind implements PtKind {
  readonly name = 'shells';
  readonly order = 40;
  readonly stats = noPtStats();
  private readonly held = new Map<number, Held>();
  private confirmed = -Infinity;

  constructor(private readonly host: ShellsKindHost) {
    // (a re-stepped ship: its lane on PT is stepped again from there, its drawn records held to the new: advance)
    host.layer.addTrack({ name: 'shells', restepped: (c, ids) => { for (const id of ids) this.dirty(id, c); }, reset: () => this.reset() });
  }

  reset(): void {
    for (const h of this.held.values()) for (const d of h.drawn.values()) for (const x of d.handles) this.host.retract(x);
    this.held.clear();
    this.confirmed = -Infinity;
    Object.assign(this.stats, noPtStats());
  }

  has(id: number): boolean {
    return this.held.has(id);
  }

  private dirty(id: number, c: number): void {
    const h = this.held.get(id);
    if (!h) return;
    for (const t of [...h.lane.keys()]) if (t > c) { h.lane.delete(t); h.evs.delete(t); h.basis.delete(t); }
  }

  confirm(c: number): void {
    if (c <= this.confirmed) return;
    const prev = this.confirmed;
    this.confirmed = c;
    for (const [id, h] of this.held) {
      // (The ticks it drew ahead that the snapshots now make final: drawn otherwise than its lane on the tick layer fired
      // them (a re-step, a trigger let go), taken back; the snapshot's own shells are drawn as they come)
      const ship = this.host.ship(id);
      if (ship && prev !== -Infinity) for (let t = Math.max(prev + 1, c - 64); t <= c; t++) {
        const d = h.drawn.get(t);
        if (!d) continue;
        laneRecords(this.host.guns.eventsAt(id, t) ?? [], ship, this.host.tuning, RECS);
        if (d.key === keyOf(RECS, this.host.pose(id, t))) continue;
        this.stats.wrong += d.handles.length;
        for (const x of d.handles) this.host.retract(x);
        h.drawn.set(t, { key: '', handles: [] });
      }
      // (A pilot's lane on PT against the tick layer's at c: off (a trigger it didn't hold as guessed), stepped again)
      const x = h.lane.get(c), st = this.host.guns.stateAt(id, c);
      if (x && st) {
        this.stats.checks++;
        // (agreeing, its chain on PT stands: the tick layer's lane at c is its seed from here)
        if (laneHash(id, x) === laneHash(id, st)) { this.stats.matches++; h.seed = st; }
        else { this.stats.misses++; this.stats.resteps++; h.lane.clear(); h.evs.clear(); h.basis.clear(); h.seed = undefined; }
      }
      for (const m of [h.lane, h.evs, h.basis] as Map<number, unknown>[]) for (const t of m.keys()) if (t < c) m.delete(t);
      for (const t of h.drawn.keys()) if (t <= c - 4) h.drawn.delete(t);
    }
  }

  advance(to: number): void {
    const t0 = performance.now(), L = this.host.layer, c = this.host.confirmed();
    const head = Math.min(to, L.head);
    const live = L.ids();
    for (const [id, h] of this.held) {
      if (live.has(id) && this.host.guns.has(id)) continue;
      // (Off PT: what it drew ahead goes back; the snapshots' shells are drawn as they come)
      for (const [t, d] of h.drawn) if (t > c) for (const x of d.handles) this.host.retract(x);
      this.held.delete(id);
    }
    for (const id of live) {
      const kind = this.host.kind(id), ship = this.host.ship(id);
      if ((kind !== 'ai' && kind !== 'pilot') || !ship || !this.host.guns.has(id)) continue;
      let h = this.held.get(id);
      if (!h) this.held.set(id, (h = { lane: new Map(), evs: new Map(), basis: new Map(), drawn: new Map() }));
      let valid = true;
      for (let t = c + 1; t <= head; t++) {
        let evs: readonly SimEvent[] | undefined;
        if (kind === 'ai') evs = this.host.guns.eventsAt(id, t);
        else { const r = this.pilotTick(id, h, t, c, ship, valid); valid = r.valid; evs = r.evs; }
        laneRecords(evs ?? [], ship, this.host.tuning, RECS);
        const s = L.ring.get(id, t) as ReplicaState | undefined;
        const key = keyOf(RECS, s?.body), had = h.drawn.get(t);
        if (had && had.key === key) continue;
        if (had) { this.stats.wrong += had.handles.length; for (const x of had.handles) this.host.retract(x); }
        const handles: number[] = [];
        if (s) for (const r of RECS) if (r.n > 0 && r.code === 0) handles.push(...this.host.draw(id, t, r, s.body, kind === 'pilot'));
        this.stats.ahead += handles.length;
        h.drawn.set(t, { key, handles });
      }
      this.stats.steps++;
    }
    this.stats.ticks++;
    this.stats.advanceMs += performance.now() - t0;
  }

  /**
   * A pilot's lane on PT at tick t: kept while what it was stepped from is (the PT ship at t, the same object; the tick
   * before kept too, or the tick layer's lane at the confirmed tick, the same object), else stepped now (and so every
   * tick after it)
   */
  private pilotTick(id: number, h: Held, t: number, c: number, ship: ShipState, valid: boolean): { evs: readonly SimEvent[] | undefined; valid: boolean } {
    const L = this.host.layer;
    const prevS = L.ring.get(id, t - 1) as ReplicaState | undefined, nowS = L.ring.get(id, t) as ReplicaState | undefined;
    if (!prevS || !nowS) return { evs: undefined, valid: false };
    let ok = valid;
    if (t - 1 === c) { const seed = this.host.guns.stateAt(id, c); if (seed !== h.seed) { h.seed = seed; ok = false; } }
    if (ok && h.lane.has(t) && h.basis.get(t) === nowS) return { evs: h.evs.get(t), valid: true };
    const prev = t - 1 === c ? h.seed : h.lane.get(t - 1);
    if (!prev) return { evs: undefined, valid: false };
    const env = this.host.env();
    SIM_ENV.tick = t; SIM_ENV.tuning = this.host.tuning; SIM_ENV.gravity = env.gravity; SIM_ENV.terrain = env.terrain ?? null; SIM_ENV.hazard = env.hazard;
    SIM_FIELDS.central = env.central; SIM_FIELDS.lodestones = env.lodestones;
    // (its trigger and cursor distance held from the last the snapshots told)
    const g = this.host.guns.ctlAt(id, c) ?? { bits: 0, dist: 0 };
    const events: SimEvent[] = [];
    const x = lanePilot(id, prev, prevS.body, nowS.body, nowS.bits, nowS.q, g, ownStructure(ship.derived, ship), SIM_ENV, events);
    h.lane.set(t, x);
    h.evs.set(t, events);
    h.basis.set(t, nowS);
    this.stats.restepTicks++;
    return { evs: events, valid: false };
  }
}
