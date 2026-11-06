/**
 * Other ships' guns on this client's tick layer, stepped from their inputs (common sim/otherGuns.ts): each armed ship
 * the server sent a gunSync of has a lane here, stepped beside its replica every tick the replica set steps it
 * (ShipReplicaSet side steps): a pilot on its control rows and gun rows (gunCtl), an AI pilot on its body's trigger and
 * lead (its driver: CAPS.PILOTS). What a lane fired on a tick becomes fire rows at the snapshot that confirms the tick
 * (`confirm`, before the snapshot's fire rows are built into shells: ShipClient.preSnapshot), named by shot id, so the
 * server sends none: only the ticks it tells (they replace the lane's), TELL_NONE (nothing fired), TELL_PD (a point-
 * defence shot, into the lane: lanePd). Its shells end on their own (`expire`: the server sends no removal at their
 * life's end). Ahead of the snapshots, the PT layer draws them (client predict/kinds/gunsKind.ts reads `eventsAt`).
 */
import {
  ReplicaMode, laneRecords, laneFireRow, lanePilot, lanePilotless, lanePd, laneRemap, laneHash, unpackGunSync, unpackGunRow, gunRowId, ownStructure,
  isOtherShotWire, TELL_NONE, TELL_PD,
  type FlightBody, type GunCtl, type LaneRec, type OwnExtras, type ReplicaEnv, type ReplicaSideSteps, type ServerGunCtlMessage,
  type ServerGunSyncMessage, type ServerSnapshotMessage, type ShipDerived, type ShipReplicaSet, type ShipState, type ShipTuning, type SimEnv,
  type SimEvent, type SimInput, type Step, type FieldEnv,
} from '@space-game/common';

export interface OtherGunsHost {
  reps: ShipReplicaSet;
  ship(id: number): ShipState | undefined;
  tuning: ShipTuning;
  self(): number;
}

/** Ticks of lane states and events kept */
const KEEP = 300;

interface Lane {
  /** Its gunSync's tick: it steps from the tick after */
  from: number;
  states: Map<number, OwnExtras>;
  events: Map<number, SimEvent[]>;
  /** A pilot's gun controls by the tick they took effect (held between), sorted */
  ctlTicks: number[];
  ctls: Map<number, GunCtl>;
  /** The distance its gun rows step from (4-unit steps) */
  base: number;
  /** Point-defence shots told, by tick */
  pd: Map<number, number[]>;
  /** Ticks an AI's body didn't fly it (its driver blind: what it fired isn't known here) */
  blind: Set<number>;
  /** The structure it flew each tick with (a rebuild between two: its stores move onto the new one, laneRemap) */
  dv: Map<number, ShipDerived>;
  /** Events of ticks at or before `from` its last lane fired, still to be confirmed (onGunSync) */
  carry: Map<number, readonly SimEvent[]>;
  /** Dropped (an empty gunSync): gone once its carry is confirmed */
  drop?: boolean;
  /** This snapshot's told span (its ship keyframed with its lane standing): ticks from it come as rows */
  toldFrom?: number;
  /**
   * The state it had at the first tick a rewind dropped: a keyframe at that tick isn't stepped again, so the lane steps
   * on from what it had there (its ship's gun state stands through a keyframe: no gunSync)
   */
  stash?: { t: number; x: OwnExtras; d?: ShipDerived };
}

const SIM_FIELDS: FieldEnv = { central: null };
const SIM_ENV: SimEnv = { tick: 0, tuning: undefined as unknown as SimEnv['tuning'], gravity: null, fields: SIM_FIELDS, terrain: null };
const RECS: LaneRec[] = [];

export class OtherGuns implements ReplicaSideSteps {
  private readonly lanes = new Map<number, Lane>();
  /** Shells built from lanes and not yet removed: the tick their life ends on (inclusive) */
  private readonly live = new Map<number, number>();
  private confirmedTo = -Infinity;
  readonly stats = { syncs: 0, steps: 0, derived: 0, told: 0, none: 0, pd: 0, blind: 0, expired: 0, gaps: 0 };

  constructor(private readonly host: OtherGunsHost) {
    host.reps.setSideSteps(this);
  }

  reset(): void {
    this.lanes.clear();
    this.syncs.clear();
    this.live.clear();
    this.confirmedTo = -Infinity;
  }

  has(id: number): boolean {
    const l = this.lanes.get(id);
    return !!l && !l.drop;
  }

  /** Its lane's state as tick t ended (undefined: not stepped there) */
  stateAt(id: number, t: number): Readonly<OwnExtras> | undefined {
    return this.lanes.get(id)?.states.get(t);
  }

  /** Its lane's fire and fx events of tick t, as last stepped (undefined: not stepped there, or not its to know) */
  eventsAt(id: number, t: number): readonly SimEvent[] | undefined {
    const l = this.lanes.get(id);
    return l && t > l.from && !l.blind.has(t) ? l.events.get(t) : undefined;
  }

  /** A pilot's gun controls on tick t (held from the last change at or before it) */
  ctlAt(id: number, t: number): GunCtl | undefined {
    const l = this.lanes.get(id);
    return l ? ctlOf(l, t) : undefined;
  }

  /**
   * A pilot's aim distance to draw its turrets by at tick t (fractional: the render tick). Not firing, its distance
   * comes only roughly (server GunNet idleDue), so between two such changes it's eased from one to the next; held
   * otherwise (a trigger held: each tick's exact, as the lane steps). Undefined: no lane of it
   */
  distAt(id: number, t: number): number | undefined {
    const l = this.lanes.get(id);
    if (!l || l.drop) return undefined;
    return easedDist(l.ctlTicks, l.ctls, t);
  }

  /** Its lane's hash as tick t ended (the PT layer's check) */
  hashAt(id: number, t: number): number | undefined {
    const x = this.lanes.get(id)?.states.get(t), ship = this.host.ship(id);
    return x && ship ? laneHash(id, x, pdOf(ship, this.host.tuning)) : undefined;
  }

  /** gunSyncs waiting for their snapshot (the lane they replace still has ticks of that window to give: install) */
  private readonly syncs = new Map<number, ServerGunSyncMessage>();

  /** A gunSync: its lane as tick m.t ended, exact; it takes over at its snapshot (install) */
  onGunSync(m: ServerGunSyncMessage): void {
    this.syncs.set(m.id, m);
  }

  /**
   * A gunSync's snapshot is in (its rows and keyframes applied): the lane it had gives the ticks of the window before the
   * server's told span (m.w: rounds that sent this client nothing, decided then), stepped there with the window's rows;
   * then the new lane starts at m.t, stepped again from the next tick
   */
  private install(m: ServerGunSyncMessage): void {
    // (Its ship keyframed, its lane standing: this snapshot's told span starts at m.w; it steps on from what it has)
    if (m.keep) { const l = this.lanes.get(m.id); if (l) l.toldFrom = m.w ?? m.t + 1; return; }
    const d = this.host.ship(m.id)?.derived;
    const old = this.lanes.get(m.id), carry = new Map<number, readonly SimEvent[]>();
    if (old && m.w !== undefined && m.w - 1 > this.confirmedTo) {
      this.host.reps.at(m.id, m.w - 1);
      for (let t = Math.max(this.confirmedTo, old.from) + 1; t < m.w; t++) { const e = this.eventsAt(m.id, t); if (e) carry.set(t, e); }
    }
    // (An empty one: it stops stepping that ship's guns; its lane stays only for what it carries into this snapshot)
    const drop = !m.z.length;
    const { x, k } = drop ? { x: null, k: { bits: 0, dist: 0 } } : unpackGunSync(m);
    const l: Lane = { from: m.t, states: new Map(x ? [[m.t, x]] : []), events: new Map(), ctlTicks: [m.t], ctls: new Map([[m.t, k]]), base: k.dist / 4, pd: new Map(), blind: new Set(), dv: new Map(d ? [[m.t, d]] : []), carry, drop };
    this.lanes.set(m.id, l);
    this.stats.syncs++;
    if (!drop) this.host.reps.rewind(m.id, m.t + 1);
  }

  /** Pilots' gun-control changes (gunCtl, before its snapshot): each from the tick it took effect; ticks stepped already, again */
  onGunCtl(m: ServerGunCtlMessage): void {
    for (const row of m.r) {
      const id = gunRowId(row), l = this.lanes.get(id);
      if (!l) continue;
      const evs = unpackGunRow(row, l.base);
      if (evs.length) l.base = evs[evs.length - 1][2];
      let first = Infinity;
      for (const [ago, bits, d] of evs) {
        const t = m.t - ago;
        if (t <= l.from) continue;
        if (!l.ctls.has(t)) { l.ctlTicks.push(t); l.ctlTicks.sort((a, b) => a - b); }
        l.ctls.set(t, { bits, dist: d * 4 });
        first = Math.min(first, t);
      }
      if (first !== Infinity) this.host.reps.rewind(id, first);
    }
  }

  /** ShipReplicaSet: ship `id` was stepped through tick t (its state before, after, the input it flew) */
  stepped(id: number, t: number, mode: ReplicaMode, prev: Readonly<Step>, now: Readonly<Step>, input: Readonly<SimInput>, derived: ShipDerived, env: ReplicaEnv): void {
    const l = this.lanes.get(id);
    if (!l || l.drop || t <= l.from) return;
    let px = l.states.get(t - 1);
    if (!px && l.stash?.t === t - 1) { px = l.stash.x; if (l.stash.d) l.dv.set(t - 1, l.stash.d); }
    const ship = this.host.ship(id);
    if (!px || !ship || ship.kind !== 'ship') { this.stats.gaps++; return; }
    // (Rebuilt between the two ticks: its stores onto the new structure, as the server's rebuild moves the real ship's)
    const was = l.dv.get(t - 1);
    if (was && was !== derived) { const c = { ...px, charge: px.charge }; laneRemap(c, was, derived); px = c; }
    const events: SimEvent[] = [];
    let x: OwnExtras;
    if (mode === ReplicaMode.Player) {
      SIM_ENV.tick = t; SIM_ENV.tuning = this.host.tuning; SIM_ENV.gravity = env.gravity; SIM_ENV.terrain = env.terrain ?? null; SIM_ENV.hazard = env.hazard;
      SIM_FIELDS.central = env.central; SIM_FIELDS.lodestones = env.lodestones;
      x = lanePilot(id, px, prev.body, now.body, now.bits, now.q, ctlOf(l, t), ownStructure(derived, ship), SIM_ENV, events);
    } else if (mode === ReplicaMode.Pilotless) {
      // (Its body's trigger and lead; a tick its driver didn't fly it, what it fired isn't known here)
      if (input.gunAim === undefined) { l.blind.add(t); this.stats.blind++; } else l.blind.delete(t);
      x = lanePilotless(id, px, now.body, now.bits, !!input.fire, input.gunAim ?? undefined, input.aimDist, ship, t, this.host.tuning, events, derived);
    } else { this.stats.gaps++; return; }
    for (const part of l.pd.get(t) ?? []) lanePd(x, ship, part);
    l.states.set(t, x);
    l.events.set(t, events);
    l.dv.set(t, derived);
    this.stats.steps++;
    if (l.states.size > KEEP + 60) for (const mp of [l.states, l.events, l.dv] as Map<number, unknown>[]) for (const k of [...mp.keys()]) if (k < t - KEEP && k !== l.from) mp.delete(k);
  }

  /** ShipReplicaSet: its steps from tick t on are gone (what the lane worked out from them goes; its gunSync's stays) */
  rewound(id: number, t: number): void {
    const l = this.lanes.get(id);
    if (!l) return;
    if (t === -Infinity) { this.lanes.delete(id); return; }
    const x = l.states.get(t);
    if (x && t > l.from) l.stash = { t, x, d: l.dv.get(t) };
    for (const k of [...l.states.keys()]) if (k >= t && k > l.from) { l.states.delete(k); l.events.delete(k); l.dv.delete(k); }
  }

  /** A ship gone (removed, out of view): its lane goes */
  remove(id: number): void {
    this.lanes.delete(id);
  }

  /**
   * A snapshot, its keyframes, rows, causes, decisions and syncs in (ShipClient.preSnapshot, before its fire rows are
   * built): its told point-defence shots into the lanes, then each lane's records of the ticks it confirms, as fire rows
   * named by shot id, onto `m.fire`, bar the ticks the snapshot tells (a row of its own for that ship and tick) and a
   * ship keyframed in it (its window's shells come as rows)
   */
  confirm(m: ServerSnapshotMessage): void {
    for (const [id, sync] of this.syncs) if (sync.t <= m.tick) { this.syncs.delete(id); this.install(sync); }
    const from = this.confirmedTo;
    this.confirmedTo = m.tick;
    const told = new Set<string>();
    for (const f of m.fire ?? []) {
      const owner = f[0], t = m.tick - f[1], code = Math.floor(f[2] / 256) % 256, l = this.lanes.get(owner);
      if (code !== TELL_PD) { told.add(`${owner}:${t}`); if (code === TELL_NONE) this.stats.none++; continue; }
      if (!l || t <= l.from) continue;
      let at = l.pd.get(t);
      if (!at) l.pd.set(t, (at = []));
      if (!at.includes(f[2] % 256)) { at.push(f[2] % 256); this.host.reps.rewind(owner, t); }
      this.stats.pd++;
    }
    if (from === -Infinity || !this.lanes.size) return;
    const self = this.host.self(), keyed = new Set(m.ships?.map((k) => k[0]));
    for (const [id, l] of this.lanes) {
      const ship = this.host.ship(id);
      // (keyframed with no gunSync: the server tells that ship's window)
      if (id === self || !ship || (keyed.has(id) && l.from !== m.tick && l.toldFrom === undefined)) continue;
      // (Stepped to the snapshot's tick, as it stands now; a ship keyframed in it has a gunSync with it, from its tick)
      if (l.drop || this.host.reps.at(id, m.tick)) for (let t = from + 1; t <= m.tick; t++) {
        if (told.has(`${id}:${t}`) || (l.toldFrom !== undefined && t >= l.toldFrom)) { this.stats.told++; continue; }
        const evs = t > l.from ? this.eventsAt(id, t) : l.carry.get(t);
        if (!evs?.length) continue;
        laneRecords(evs, ship, this.host.tuning, RECS);
        for (const r of RECS) { (m.fire ??= []).push(laneFireRow(id, m.tick, r)); this.stats.derived++; }
      }
      l.carry.clear();
      l.toldFrom = undefined;
      if (l.drop) { this.lanes.delete(id); continue; }
      for (const k of l.pd.keys()) if (k < m.tick - KEEP) l.pd.delete(k);
      for (const k of l.blind) if (k < m.tick - KEEP) l.blind.delete(k);
      while (l.ctlTicks.length > 1 && l.ctlTicks[1] <= m.tick - KEEP) l.ctls.delete(l.ctlTicks.shift()!);
    }
  }

  /** A shell built from a lane's record (a fire row's): it ends on its own at the end of tick `until` */
  built(id: number, until: number): void {
    if (isOtherShotWire(id)) this.live.set(id, until);
  }

  /** At a snapshot at `tick`: the lanes' shells whose life has ended, removed (pushed onto `removed`) */
  expire(tick: number, removed: number[]): void {
    for (const [id, until] of this.live) {
      if (until > tick) continue;
      this.live.delete(id);
      removed.push(id);
      this.stats.expired++;
    }
  }

  /** Shells gone otherwise (a hit record spent them, a removal the server sent) */
  gone(ids: Iterable<number>): void {
    for (const id of ids) this.live.delete(id);
  }
}

function ctlOf(l: Lane, t: number): GunCtl {
  const k = l.ctlTicks;
  let lo = 0, hi = k.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (k[mid] <= t) lo = mid + 1; else hi = mid; }
  return (lo ? l.ctls.get(k[lo - 1]) : undefined) ?? { bits: 0, dist: 0 };
}

/**
 * The distance between gun-control changes (`ticks` sorted, `ctls` by tick) at tick t: from a change with no trigger
 * held to the next (also none held) it goes linearly from one's distance to the other's; otherwise the last change's
 */
export function easedDist(ticks: readonly number[], ctls: ReadonlyMap<number, GunCtl>, t: number): number {
  let lo = 0, hi = ticks.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ticks[mid] <= t) lo = mid + 1; else hi = mid; }
  if (!lo) return ctls.get(ticks[0])?.dist ?? 0;
  const t0 = ticks[lo - 1], a = ctls.get(t0)!;
  if (lo >= ticks.length || a.bits) return a.dist;
  const t1 = ticks[lo], b = ctls.get(t1)!;
  if (b.bits) return a.dist;
  return a.dist + ((b.dist - a.dist) * (t - t0)) / (t1 - t0);
}

const PD = new WeakMap<ShipDerived, number[]>();
function pdOf(ship: ShipState, tuning: ShipTuning): number[] {
  let p = PD.get(ship.derived);
  if (!p) { p = []; for (const w of ship.derived.weapons) if (tuning.weapons?.[w.kind]?.pointDefence) p.push(w.part); PD.set(ship.derived, p); }
  return p;
}

export type { FlightBody };
