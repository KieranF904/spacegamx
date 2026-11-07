/**
 * Other ships' guns on their clients' tick layers (common sim/otherGuns.ts): the server's side. Each armed ship some
 * client may step the guns of (a pilot; an AI pilot while its body flies it) has a lane here, stepped every tick by the
 * lane step its clients run, from what they have: the real ship's pose (what their replicas hold while in step; a ship
 * keyframed in a window has that window told and its lane sent again), its controls as replicated (control rows, gun
 * rows; an AI's body's), the lane's own state. Then:
 *
 *   diff     what the lane fired against what the real ship fired (its fire records), tick by tick: a tick they differ
 *            on (an ammunition round, a gun the server's state alone held back or fired: a sheltered pilot, a bot
 *            aiming off the input grid) is told, its fire records sent as before; one the lane fired on and the real
 *            ship didn't gets a TELL_NONE record (SnapshotBuilder)
 *   state    the lane's state against the real ship's (laneHash), at each snapshot round: off (a shield drawing on the
 *            stores, damage, a tow), the lane is put back to the real ship's (a new lane version: every client deriving
 *            it gets a gunSync), at most once per FIX_GAP ticks a ship
 *   rows     a pilot's gun controls (its triggers, its cursor distance on the input's 4-unit grid) as they change:
 *            gun rows (gunCtl), packed once a round for every client. The distance goes exactly only where the lanes
 *            need it: on a tick a trigger changes, while one is held, and SEMI_BUFFER ticks after (a semi-automatic
 *            gun's click still fires). Held, exactly is as the guns stepped on it: a pilot's guns hold their distance
 *            and take the cursor's only on a gun's due ticks, its fire tick and halfway to its next (common ships/guns.ts
 *            distDue, ShipState.heldDist: the same on every end), so it goes about twice a fire interval, only when
 *            that changes it. Not firing, a turret points straight at the aim and carries nothing (ships/guns.ts
 *            stepGuns), so there it goes roughly (idleDue: when the change would turn a gun's line to the aim by
 *            IDLE_TURN, sooner the bigger it is, at most every IDLE_MIN_GAP ticks, at least every IDLE_MAX_GAP if it
 *            moved at all): its clients' turrets look right (OtherGuns.distAt eases between). The server's lane steps
 *            on the controls as sent, as its clients' lanes do; what differs from the real ship (idle aim) is left out
 *            of the hash (laneHash)
 *   clients  a client steps a ship's lane only while it's worth it (forClient): the ship held, near its own (GUN_REACH,
 *            kept to GUN_KEEP), and lately firing or its trigger held (GUN_ACTIVE). Until then its fire records go as
 *            before; the first volley after a quiet spell goes told, with the gunSync. A lane it no longer should step
 *            (gone far) is dropped with an empty gunSync
 *
 * Point defence (server features/support/pointDefence.ts) fires at threats only the server sees: each shot is a TELL_PD
 * fire record (always told), put into the lane as its clients put it in (lanePd).
 */
import {
  Input, Position, Velocity, Rotation, ReplicaMode, SEMI_BUFFER, shipPointToWorld, quantizeCursorDist, gunStateOf, firedRec, sameRecs, laneRecords, lanePilot,
  lanePilotless, lanePd, laneRemap, laneHash, laneOf, pdParts, packGunRow, packGunSync, ownStructure, TELL_PD, TELL_NONE, trigWord, TRIG_BUTTONS,
  type FlightBody, type GunCtl, type LaneRec, type OwnExtras, type ReplicaEnv, type ServerGunSyncMessage, type ShipState,
  type SimEnv, type SimEvent, type FieldEnv,
} from '@space-game/common';
import type { ShipBridge } from '../../ships/ShipBridge.js';


/** Ticks after a lane is put back to the real ship's in which it isn't again (a shield draining the stores every hit) */
export const GUN_FIX_GAP = 60;
/**
 * Not firing, a pilot's aim distance goes to its lanes' clients when the change since the last sent would turn some
 * gun's line to the aim point by IDLE_TURN radians (0.5°) at IDLE_MIN_GAP ticks since (250 ms), proportionally less the
 * longer since (IDLE_TURN · IDLE_MIN_GAP / ticks: a small change waits longer), and any change at IDLE_MAX_GAP (3 s)
 */
export const IDLE_TURN = 0.5 * (Math.PI / 180);
export const IDLE_MIN_GAP = 15;
export const IDLE_MAX_GAP = 180;
/** Ticks of told ticks kept (longer than the widest snapshot window) */
const KEEP_TICKS = 120;
/** A client starts stepping a ship's guns within this of its own ship, and stops past GUN_KEEP (world units) */
export const GUN_REACH = 8000;
export const GUN_KEEP = 10000;
/** ...and only once the ship has fired within this many ticks, or holds its trigger */
export const GUN_ACTIVE = 600;

export interface GunNetHost {
  tick(): number;
  ships(): ShipBridge;
  /** The replicas' world where a ship is (the same the shadows step in: Replication's host.env) */
  env(eid: number): ReplicaEnv;
}

export interface GunLane {
  kind: 'pilot' | 'ai';
  x: OwnExtras;
  /** Its version: bumped when it's put back to the real ship's (every client deriving it then gets a gunSync) */
  ver: number;
  fixAt: number;
  /** Point-defence parts (left out of the hash) */
  pd: number[];
  /** The tick it was last stepped to */
  at: number;
  /** Ticks whose records are told (the lane's differ from the real ship's), and those where nothing really fired */
  told: Set<number>;
  none: Set<number>;
  /**
   * A pilot's gun controls now as its clients' lanes have them (gun rows step from it: the distance its guns stepped on
   * while a trigger is held, rough while not), and their changes since the last round: [tick, bits, dist/4]
   */
  ctl: GunCtl;
  /** The pilot's cursor distance last tick, the tick the distance last went, and the last tick it must go exactly */
  exactDist: number;
  distAt: number;
  /**
   * Its cursor distance for drawing where its lane isn't stepped (the status row's hundreds: SnapshotBuilder
   * roughCursor): the idle rule's, firing or not (idle, what its lanes got), and the tick it last moved
   */
  rough: number;
  roughAt: number;
  exactTo: number;
  sent: GunCtl;
  events: [number, number, number][];
  /** This round's row, packed once for every client (null: none due) */
  row?: number[] | null;
  /** Its last snapshot round's tick, and the first tick of that round's span */
  round: number;
  roundFrom: number;
  /** Its body as the tick before ended (a pilot's lane steps its flight from it) */
  before?: FlightBody;
  /** The last tick it fired (or its trigger was held): a client starts stepping it only while it's lately active */
  active: number;
  /** The real ship's record and structure its lane is of (a respawn, a rebuild: the lane starts again) */
  ship: ShipState;
  derived: ShipState['derived'];
}

const SIM_FIELDS: FieldEnv = { central: null };
const SIM_ENV: SimEnv = { tick: 0, tuning: undefined as unknown as SimEnv['tuning'], gravity: null, fields: SIM_FIELDS, terrain: null };
const EVENTS: SimEvent[] = [];
const LANE_RECS: LaneRec[] = [];

const bodyOf = (eid: number, ship: ShipState): FlightBody => ({
  x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], angle: Rotation.angle[eid], angVel: ship.angVel,
  jump: ship.jump, jumpScale: ship.jumpScale, jumpAim: ship.jumpAim, jumpTo: ship.jumpTo, cargo: ship.cargo, dodge: ship.dodge, dodgeDir: ship.dodgeDir,
});

export class GunNet {
  readonly lanes = new Map<number, GunLane>();
  /** Lane versions, one count for every lane (a lane made again never repeats one a client holds) */
  private verSeq = 0;
  /**
   * idleChanges: ticks a pilot's exact distance changed with no trigger held (what went before the idle rule);
   * idleSent: those that went (idleDue); exactChanges: ticks it changed with a trigger held or changing (what went
   * before the held-distance rule); exactSent: distance changes that went exactly (as the guns stepped on it)
   */
  readonly stats = { steps: 0, toldTicks: 0, noneTicks: 0, fixes: 0, syncs: 0, derivedRecs: 0, toldRecs: 0, pdRecs: 0, idleChanges: 0, idleSent: 0, exactChanges: 0, exactSent: 0 };

  /** gunSyncs by why (a lane new to the client, a new version, its ship keyframed) */
  readonly why: Record<string, number> = {};
  private whyNow = '';
  constructor(private readonly host: GunNetHost) {}

  private armed(ship: ShipState | undefined): ship is ShipState {
    return !!ship && ship.kind === 'ship' && (ship.derived.weapons.length > 0 || ship.derived.miners.length > 0);
  }

  /** A lane for this ship (made from the real ship as it is now: its first step is the next tick's) */
  private lane(eid: number, kind: GunLane['kind'], ship: ShipState): GunLane | null {
    let l = this.lanes.get(eid);
    if (l && l.kind !== kind) { this.lanes.delete(eid); l = undefined; }
    if (l) return l;
    const b = this.host.ships();
    const now = this.host.tick();
    const ctl = kind === 'pilot' ? pilotCtl(eid) : { bits: 0, dist: 0 };
    l = {
      kind, x: laneOf(gunStateOf(ship), b.chargeOf(eid)), ver: ++this.verSeq, fixAt: -Infinity, pd: pdParts(ship, b.tuning), at: now,
      told: new Set(), none: new Set(), ctl, sent: { ...ctl }, events: [], exactDist: ctl.dist, distAt: now, rough: ctl.dist, roughAt: now, exactTo: -Infinity, ship, derived: ship.derived, round: now, roundFrom: now, active: -Infinity,
    };
    this.lanes.set(eid, l);
    return null;
  }

  /** A pilot about to fly tick t: its body as t - 1 ended (its lane's flight steps from it) */
  beforePilot(eid: number): void {
    const ship = this.host.ships().get(eid);
    const l = this.lanes.get(eid);
    if (l && ship) l.before = bodyOf(eid, ship);
  }

  /**
   * A pilot's guns have run tick t (bridge weapons.ts stepWeapons): its fire records since `from` in the bridge's list.
   * Its lane's tick, its gun controls' change, the diff
   */
  pilot(eid: number, from: number): void {
    const b = this.host.ships(), ship = b.get(eid);
    if (!this.armed(ship)) { this.lanes.delete(eid); return; }
    const t = this.host.tick();
    const g = pilotCtl(eid);
    const l = this.lane(eid, 'pilot', ship);
    if (!l) return;
    this.ctlTick(eid, l, ship, g, t);
    const rc = b.replicaCtl.get(eid), before = l.before;
    l.before = undefined;
    // (Not flown this tick (docked): no lane, a new one when it flies again. Its body before not known, or a tick
    // missed: it starts again from the real ship's state)
    if (!rc || rc.mode !== ReplicaMode.Player) { this.lanes.delete(eid); return; }
    // (A respawn: it starts again from the real ship. A rebuild: its stores moved onto the new structure, as the real ship's)
    if (!before || l.at !== t - 1 || l.ship !== ship) { this.restart(eid, l, ship); return; }
    this.track(l, ship);
    const env = this.simEnv(eid, t);
    EVENTS.length = 0;
    // (on its controls as its clients' lanes have them)
    const x = lanePilot(eid, l.x, before, bodyOf(eid, ship), rc.bits, rc.q, l.ctl, ownStructure(ship.derived, ship), env, EVENTS);
    this.settle(eid, l, x, ship, t, from);
  }

  /**
   * An AI ship's guns have run tick t (bridge pilotless.ts stepPilotless): its trigger, lead and distance as its
   * orders had them (its body's: bodies/aiPilot.ts), its pose as they fired; flown by its body (`bodied`) or not (no lane)
   */
  pilotless(eid: number, from: number, bodied: boolean, fire: boolean, aim: number | undefined, aimDist: number): void {
    const b = this.host.ships(), ship = b.get(eid);
    if (!bodied || !this.armed(ship)) { this.lanes.delete(eid); return; }
    const t = this.host.tick();
    const l = this.lane(eid, 'ai', ship);
    if (!l) return;
    const rc = b.replicaCtl.get(eid);
    if (!rc) { this.lanes.delete(eid); return; }
    if (l.at !== t - 1 || l.ship !== ship) { this.restart(eid, l, ship); return; }
    this.track(l, ship);
    EVENTS.length = 0;
    const x = lanePilotless(eid, l.x, bodyOf(eid, ship), rc.bits, fire, aim, aimDist, ship, t, b.tuning, EVENTS);
    this.settle(eid, l, x, ship, t, from);
  }

  /**
   * A pilot's gun controls on tick t into what its clients' lanes get (a gun row event when they change): the triggers
   * always, the distance exactly while they need it (a trigger held or changing, SEMI_BUFFER ticks after), else idleDue.
   * Exactly is as the real ship's guns stepped on it (ShipState.heldDist): held through, a pilot's guns take the
   * cursor's distance only on a gun's due ticks (common ships/guns.ts distDue), so it goes only as it's applied
   */
  private ctlTick(eid: number, l: GunLane, ship: ShipState, g: GunCtl, t: number): void {
    // (The bits are the trigger word: a held trigger is its button bits, not the group selection that rides above them)
    const held = (g.bits & TRIG_BUTTONS) !== 0;
    if (held) l.exactTo = t + SEMI_BUFFER;
    const exact = held || g.bits !== l.ctl.bits || t <= l.exactTo;
    if (g.dist !== l.exactDist) { if (exact) this.stats.exactChanges++; else this.stats.idleChanges++; }
    l.exactDist = g.dist;
    const want = exact && ship.heldDist !== undefined ? quantizeCursorDist(ship.heldDist) * 4 : g.dist;
    let dist = l.ctl.dist;
    if (want !== dist && (exact || this.idleDue(eid, ship, l.ctl.dist, want, t - l.distAt))) {
      dist = want;
      l.distAt = t;
      if (exact) this.stats.exactSent++; else this.stats.idleSent++;
    }
    // (Drawing elsewhere: what its lanes got while idle; while firing, the cursor's by the idle rule, not every held step)
    if (!exact) { if (dist !== l.rough) { l.rough = dist; l.roughAt = t; } }
    else if (g.dist !== l.rough && this.idleDue(eid, ship, l.rough, g.dist, t - l.roughAt)) { l.rough = g.dist; l.roughAt = t; }
    if (l.ctl.bits !== g.bits || l.ctl.dist !== dist) { l.ctl = { bits: g.bits, dist }; l.events.push([t, g.bits, dist / 4]); }
  }

  /**
   * Is a pilot's idle distance due to go (from `was`, sent `gap` ticks ago, to `now`): the most any gun's line from its
   * pivot (a turret's) or muzzle (a fixed gun's) to the aim point turns, against IDLE_TURN · IDLE_MIN_GAP / gap
   */
  private idleDue(eid: number, ship: ShipState, was: number, now: number, gap: number): boolean {
    if (gap < IDLE_MIN_GAP) return false;
    if (gap >= IDLE_MAX_GAP) return true;
    const a = Input.targetAngle[eid], ca = Math.cos(a), sa = Math.sin(a), cs = this.host.ships().tuning.cellSize;
    const pose = { x: Position.x[eid], y: Position.y[eid], angle: Rotation.angle[eid] };
    const line = (px: number, py: number, d: number) => (d > 0 ? Math.atan2(pose.y + sa * d - py, pose.x + ca * d - px) : a);
    let turn = 0;
    for (const w of ship.derived.weapons) {
      const [px, py] = shipPointToWorld(ship, pose, w.window ? w.window.pivot : w.muzzle, cs);
      const d = Math.abs(line(px, py, now) - line(px, py, was));
      turn = Math.max(turn, Math.min(d, 2 * Math.PI - d));
    }
    return turn * gap >= IDLE_TURN * IDLE_MIN_GAP;
  }

  /** (A rebuild since its last tick: its stores onto the new structure, as the server's rebuild moved the real ship's: laneRemap) */
  private track(l: GunLane, ship: ShipState): void {
    if (ship.derived === l.derived) return;
    laneRemap(l.x, l.derived, ship.derived);
    l.derived = ship.derived;
    l.pd = pdParts(ship, this.host.ships().tuning);
  }

  /** (The lane missed a tick: it starts again from the real ship's state, a new version) */
  private restart(eid: number, l: GunLane, ship: ShipState): void {
    const b = this.host.ships();
    l.x = laneOf(gunStateOf(ship), b.chargeOf(eid));
    l.ver = ++this.verSeq;
    l.ship = ship;
    l.derived = ship.derived;
    l.pd = pdParts(ship, b.tuning);
    l.at = this.host.tick();
  }

  /** The lane's tick done: point defence's shots put in, what it fired against what the real ship fired */
  private settle(eid: number, l: GunLane, x: OwnExtras, ship: ShipState, t: number, from: number): void {
    const fired = this.host.ships().fired;
    const real: LaneRec[] = [];
    for (let i = from; i < fired.length; i++) {
      const f = fired[i];
      if (f.owner !== eid || f.tick !== t) continue;
      if (f.ammo === TELL_PD) { lanePd(x, ship, f.part); continue; }
      real.push(firedRec(f));
    }
    l.x = x;
    l.at = t;
    this.stats.steps++;
    laneRecords(EVENTS, ship, this.host.ships().tuning, LANE_RECS);
    if (real.length || LANE_RECS.length || (l.kind === 'pilot' && (l.ctl.bits & TRIG_BUTTONS))) l.active = t;
    if (!sameRecs(LANE_RECS, real)) {
      l.told.add(t);
      this.stats.toldTicks++;
      if (!real.length) { l.none.add(t); this.stats.noneTicks++; }
    }
  }

  private simEnv(eid: number, t: number): SimEnv {
    const e = this.host.env(eid);
    SIM_ENV.tick = t; SIM_ENV.tuning = this.host.ships().tuning; SIM_ENV.gravity = e.gravity; SIM_ENV.terrain = e.terrain ?? null; SIM_ENV.hazard = e.hazard;
    SIM_FIELDS.central = e.central; SIM_FIELDS.lodestones = e.lodestones;
    return SIM_ENV;
  }

  /**
   * A snapshot round begins: lanes of ships gone go; each lane against its real ship (off: put back, a new version, at
   * most once per GUN_FIX_GAP); a pilot's gun row for the round. `due`: the systems in this round (all: undefined)
   */
  beginRound(due?: (eid: number) => boolean): void {
    const b = this.host.ships(), now = this.host.tick();
    for (const [eid, l] of this.lanes) {
      const ship = b.get(eid);
      if (!ship) { this.lanes.delete(eid); continue; }
      if (due && !due(eid)) continue;
      // (This round's span: a gunSync now has its records told from its start, the earlier rounds' as they were decided)
      l.roundFrom = l.round + 1;
      l.round = now;
      if (l.at !== now) continue;
      // (A respawn: the lane starts again; a rebuild this tick: its stores onto the new structure now, as its clients' are)
      if (ship !== l.ship) { this.restart(eid, l, ship); continue; }
      this.track(l, ship);
      if (laneHash(eid, l.x, l.pd) !== laneHash(eid, laneOf(gunStateOf(ship), b.chargeOf(eid)), l.pd) && now - l.fixAt >= GUN_FIX_GAP) {
        l.x = laneOf(gunStateOf(ship), b.chargeOf(eid));
        l.ver = ++this.verSeq;
        l.fixAt = now;
        this.stats.fixes++;
      }
      l.row = l.kind === 'pilot' && l.events.length ? packGunRow(eid, l.events.map(([t, bits, d]) => [now - t, bits, d] as [number, number, number]), l.sent.dist / 4) : null;
    }
  }

  /** The round done for the systems it was for: rows sent, old told ticks forgotten */
  endRound(due?: (eid: number) => boolean): void {
    const now = this.host.tick();
    for (const [eid, l] of this.lanes) {
      if (due && !due(eid)) continue;
      l.events.length = 0;
      l.sent = { ...l.ctl };
      l.row = null;
      for (const t of l.told) if (t < now - KEEP_TICKS) l.told.delete(t);
      for (const t of l.none) if (t < now - KEEP_TICKS) l.none.delete(t);
    }
  }

  /** Per client: the lanes it holds (their versions) and the tick each started on its end (its gunSync's) */
  private readonly known = new WeakMap<object, Map<number, { ver: number; from: number }>>();

  /**
   * One client's share of the round (SnapshotBuilder): the gunSyncs it's owed (a lane it holds a ship of and should
   * step but hasn't got, or has an old version of: its hash drifted; a ship keyframed now keeps its lane, and gets an
   * empty `keep` one telling where this round's told span starts), the gun rows of the lanes it steps, the TELL_NONE records of its window, and which
   * fire records it works out itself (`derives`). `holds`: it holds the ship (a keyframe of it is known); `runs`: it
   * flies that AI's body; `keyed`: the ships keyframed in this snapshot; `since`: its last snapshot's tick
   */
  forClient(conn: object, self: number, holds: (id: number) => boolean, runs: (id: number) => boolean, keyed: ReadonlySet<number>, since: number): GunClient {
    const now = this.host.tick();
    let known = this.known.get(conn);
    if (!known) this.known.set(conn, (known = new Map()));
    const out: GunClient = { syncs: [], rows: [], none: [], keyedFrom: new Map(), derives: () => false, steps: () => false };
    const sx = Position.x[self], sy = Position.y[self];
    for (const [eid, l] of this.lanes) {
      if (eid === self) continue;
      let k = known.get(eid);
      if (l.at !== now || !holds(eid) || (l.kind === 'ai' && !runs(eid))) {
        // (still held, but no lane to step: dropped on its end too)
        if (k && holds(eid)) out.syncs.push(this.dropOf(eid, l));
        known.delete(eid);
        continue;
      }
      // (Near enough and lately active to be worth stepping: GUN_REACH, GUN_KEEP, GUN_ACTIVE)
      const dx = Position.x[eid] - sx, dy = Position.y[eid] - sy, d2 = dx * dx + dy * dy;
      if (k && d2 > GUN_KEEP * GUN_KEEP) { out.syncs.push(this.dropOf(eid, l)); known.delete(eid); k = undefined; continue; }
      if (!k && (d2 > GUN_REACH * GUN_REACH || now - l.active > GUN_ACTIVE)) continue;
      // (Keyframed, the lane in step: no gunSync, its lane's state stands; this round's span is told, as rows, and its
      // client is told where that span starts)
      if (k && k.ver === l.ver && keyed.has(eid)) {
        const from = l.round === now && l.roundFrom <= now ? l.roundFrom : now;
        out.keyedFrom.set(eid, from);
        out.syncs.push({ type: 'gunSync', id: eid, t: now, z: [], w: from, keep: 1 });
        this.why.keyed = (this.why.keyed ?? 0) + 1;
        continue;
      }
      if (!k || k.ver !== l.ver) {
        this.whyNow = !k ? 'new' : 'ver';
        const m = this.syncOf(eid);
        if (m) { out.syncs.push(m); known.set(eid, { ver: l.ver, from: now }); }
        else known.delete(eid);
        continue;
      }
      if (l.row) out.rows.push(l.row);
      for (const t of l.none) if (t > since && t > k.from && t <= now) out.none.push([eid, now - t, 256 * TELL_NONE, 0]);
    }
    const kn = known, lanes = this.lanes;
    // (Its lane of the owner, in step since before tick t)
    out.steps = (owner, t) => { const k = kn.get(owner), l = lanes.get(owner); return !!k && !!l && k.ver === l.ver && t > k.from; };
    out.derives = (owner, t) => out.steps(owner, t) && !lanes.get(owner)!.told.has(t) && !((out.keyedFrom.get(owner) ?? Infinity) <= t);
    return out;
  }

  /** An empty gunSync: its client stops stepping the lane (from this round's start: its earlier rounds were decided then) */
  private dropOf(eid: number, l: GunLane): ServerGunSyncMessage {
    this.why.drop = (this.why.drop ?? 0) + 1;
    const now = this.host.tick();
    return { type: 'gunSync', id: eid, t: now, z: [], ...(l.round === now && l.roundFrom <= now ? { w: l.roundFrom } : {}) };
  }

  /** A gunSync of a lane as it is now (its controls with it: its rows step from them) */
  syncOf(eid: number): ServerGunSyncMessage | null {
    const l = this.lanes.get(eid);
    if (!l || l.at !== this.host.tick()) return null;
    this.stats.syncs++;
    const m = packGunSync(eid, l.at, l.x, l.ctl);
    // (its records are told from this round's start: an earlier round's, decided then, its client works out from what it had)
    if (l.round === l.at && l.roundFrom <= l.at) m.w = l.roundFrom;
    this.why[this.whyNow] = (this.why[this.whyNow] ?? 0) + 1;
    return m;
  }
}

/** A client's share of a round (GunNet.forClient) */
export interface GunClient {
  syncs: ServerGunSyncMessage[];
  /** Gun rows (gunCtl) */
  rows: number[][];
  /** TELL_NONE fire records */
  none: number[][];
  /** Ships keyframed in this snapshot with their lanes standing: the first tick whose records are told (as rows) */
  keyedFrom: Map<number, number>;
  /** Does it work out this ship's fire records of tick t itself (no record goes) */
  derives(owner: number, t: number): boolean;
  /** Does it step this ship's guns through tick t (a told point-defence shot goes to it) */
  steps(owner: number, t: number): boolean;
}

/** A pilot's gun controls as its input set them (the triggers; the cursor distance on the input's grid) */
function pilotCtl(eid: number): GunCtl {
  return { bits: trigWord(Input.fireLeft[eid] === 1, Input.fireRight[eid] === 1, Input.weaponGroups[eid]), dist: quantizeCursorDist(Input.cursorDist[eid]) * 4 };
}

