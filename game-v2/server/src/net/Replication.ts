/**
 * Ship replication: send what clients can't work out for themselves, and
 * nothing else.
 *
 * Every ship body has a shadow here: the state a client would have, stepped
 * each tick with the controls the real ship used (common/src/ships/replica.ts).
 * After the tick the shadow is compared with the real ship. While they agree,
 * clients only need the control changes. When they don't (a collision, a
 * blast, an EMP, running dry of boost, a rebuild, docking), the ship is marked
 * and the next snapshot carries a keyframe of its real state.
 *
 * Each client remembers which keyframe version of each ship it has; one that's
 * behind (or new to the ship) gets the keyframe, the rest get control changes.
 *
 * Causes (net/causes/shadowCauses.ts): what moved a ship besides its controls in a tick (a contact, a rebuild's
 * recentring, a pilot's pull) is worked out on its shadow too, by the function clients run. A client that takes them
 * (CAPS.CAUSES; a pilot's own ship, CAPS.OWN_SIM) is sent the causes and keeps its replica exact; the rest get a
 * keyframe. Two versions, from one count: `version` moves whenever anything but controls moved the ship, `cver` (the
 * CAUSES clients') only when the shadow, causes and all, left the real ship.
 */

import {
  Position, Velocity, Rotation, InSystem, FlightBody, ReplicaMode, ReplicaEnv, CTL, KeyframeRow, ControlRow,
  replicaStep, replicaAngle, packKeyframe, packControlRow, flightSignature, applyOwnCauses, cargoBefore, quantizeShipBody, OWN_CAUSE,
  type ShipState, replicaHash, replicasByte, CTL_POWER_MASK, CTL_SHARE_MASK, CTL_NO_BOOST,
} from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';

/** CTL bits a pilot's own client works out itself (its engines' power, share, a refused boost: common sim/ownStep.ts) */
const OWN_DERIVED_BITS = CTL_POWER_MASK | CTL_SHARE_MASK | CTL_NO_BOOST;
import type { OwnCause } from '../ships/bridge/ownCauses.js';
import { workCauses, recordCauses, settleContacts, causeRow, causeRecords, type CauseEvent, type WorkedCauses } from './causes/shadowCauses.js';
import { contactWindow, type ContactWindow } from './causes/contactsFor.js';
import type { ServerContactMessage } from '@space-game/common';
import { SimPass } from '../sim/SystemClocks.js';

export interface ReplicationHost {
  tick(): number;
  /** Gravity, the central body and the lodestones where this entity is */
  env(eid: number): ReplicaEnv;
  /** Berthed at a station: which, and the offset from it */
  dockOf(eid: number): { station: number; ox: number; oy: number } | null;
  /** Every berthed ship this tick (one pass over the clients, instead of dockOf per ship) */
  docks?(): Map<number, { station: number; ox: number; oy: number }>;
  /** Systems with a client in them (nobody sees a shadow anywhere else) */
  occupied?(): Set<number>;
  /** CAPS.OWN_SIM: this pilot's client steps its own ship itself (network/ownTick.ts) */
  ownSim?(eid: number): boolean;
  /** ...with the controls its inputs say for this tick (null: none yet) */
  ownControls?(eid: number): { bits: number; q: number } | null;
  /** ...and an input of its wasn't applied on its target tick since this was last asked (late, or dropped) */
  ownLate?(eid: number): boolean;
}

/**
 * A pilot's own ship as its client steps it (CAPS.OWN_SIM). The shadow is then exactly that: stepped with the controls
 * the ship flew, and the causes of anything else that moved it worked out on it by the client's own function; only
 * what that still misses (`hard`: the client can't have it) costs it a keyframe of its own ship.
 */
interface OwnShadow {
  /** Its own keyframe version (what its client was last given of its own ship: counting down from -1, never one of the shared versions) */
  version: number;
  /** This window's causes (the same events as the shadow's own list) */
  events: CauseEvent[];
  /** The ship flew this window with controls its inputs don't say (the engines short of power, an EMP, the cold...) */
  exc: boolean;
  /** ...on the last tick stepped (the next window starts from those) */
  excLast: boolean;
  /** The controls on the window's first tick (an exceptions row starts from them) */
  first: [number, number, number] | null;
  /** Something its client can't work out moved it this window: a keyframe of its own ship goes */
  hard: boolean;
  /** Why (the stats) */
  why?: string;
  /** Not flown by its pilot (docked) since its last keyframe, in this mode: no keyframe again till it moves (stepOwn) */
  held?: ReplicaMode;
  heldDock?: Shadow['dock'];
}

/** (A shadow rounded as every body is at a tick's end) */
const quantizeOwn = (b: FlightBody): void => quantizeShipBody(b);
/** The same pose and motion (a docked ship's shadow against the real one) */
const sameBody = (a: FlightBody, b: FlightBody) => a.x === b.x && a.y === b.y && a.vx === b.vx && a.vy === b.vy && a.angle === b.angle && a.angVel === b.angVel;

interface Shadow {
  mode: ReplicaMode;
  body: FlightBody;
  bits: number;
  q: number;
  /** Keyframe version: bumped whenever clients must be resent the real state */
  version: number;
  /** CAPS.CAUSES clients' keyframe version: bumped only when the shadow, its causes worked out, left the ship */
  cver: number;
  /** The count both versions are taken from (so a version names one state, whoever holds it) */
  gen: number;
  /**
   * A piece of debris: the keyframe version of clients running it (CAPS.DEBRIS) or keeping each structure by tick
   * (CAPS.STRUCTS): bumped only when it left what they work out (not for its rebuilds)
   */
  dver: number;
  /** A piece of debris rebuilt this window (those clients worked it out; the rest get a keyframe) */
  lived?: boolean;
  diverged: boolean;
  /** A cause moved it this window (worked out on the shadow: clients without CAUSES get a keyframe) */
  caused: boolean;
  /** This window's causes (CAPS.CAUSES) */
  causes: CauseEvent[];
  /** Its body after this tick's step and before its causes, and those causes (a contact another ship's client works out reads it) */
  pre?: FlightBody;
  preTick?: number;
  worked?: WorkedCauses;
  workedTick?: number;
  rebuilds: number;
  /** Its structure's flight signature (a rebuild that changes it needs a keyframe) */
  sig: string;
  dock: { station: number; ox: number; oy: number } | null;
  /** Control changes since the last snapshot: [tick, bits, q] */
  events: number[];
  /** The aim as of the last snapshot (what clients have: control rows step from it) */
  qSent: number;
  /** This snapshot's keyframe and control row, each packed once for every client that gets it */
  keyRow?: KeyframeRow;
  ctlRow?: ControlRow;
  /** The tick it was last stepped on (a contact on that tick with the replica as stepped: the client has it) */
  stepped?: number;
  /** Its pilot's client steps it itself (CAPS.OWN_SIM) */
  own?: OwnShadow;
  /**
   * Flown by its body (CAPS.BODIES, common bodies/): the ship as a client running the body has it, stepped with the
   * controls and push the body made. Its own keyframe versions (counting down from -1, as an own ship's): a client that
   * runs the body is sent a keyframe only when this leaves the real ship (a contact, a shed, an EMP), never rows
   */
  bodied?: { body: FlightBody; version: number; cver: number; gen: number; diverged: boolean; caused: boolean; rebuilds: number; stepped?: number; pre?: FlightBody; preTick?: number; worked?: WorkedCauses; workedTick?: number };
}

const sameDock = (a: Shadow['dock'], b: Shadow['dock']) => (!a && !b) || (!!a && !!b && a.station === b.station && a.ox === b.ox && a.oy === b.oy);

/** How long a removed ship's causes are remembered (causedInWindow): longer than the widest snapshot window */
const GONE_CAUSED_TICKS = 16;

/** A client's kept structures of a ship (CAPS.STRUCTS: ClientConnection.shipSynced kept), its rebuild counts oldest first; undefined: none kept */
export type Kept = (id: number) => readonly number[] | undefined;

const sameVec = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];

export class Replication {
  private shadows = new Map<number, Shadow>();
  /** Pairs of debris that knocked since the last snapshot (a client with one in view and not the other is off on it) */
  private readonly knocks: [number, number][] = [];
  /** Keyframes sent (for the stats) */
  keyframes = 0;
  /** Why ships left their predicted path (for the stats) */
  readonly reasons: Record<string, number> = {};
  private why(r: string): void { this.reasons[r] = (this.reasons[r] ?? 0) + 1; }
  /** Pilots' own ships (CAPS.OWN_SIM): causes told, keyframes of their own ship and why, exceptions rows */
  readonly ownStats = { causes: 0, pull: 0, contact: 0, contactState: 0, rebuild: 0, cargo: 0, keyframes: 0, exc: 0, why: {} as Record<string, number> };
  /** Other ships' causes (CAPS.CAUSES): ticks a ship's were worked out, rows sent, contacts sent without state, keyframes for ones a client couldn't work out */
  readonly causeStats = { worked: 0, failed: {} as Record<string, number>, rows: 0, stateless: 0, unworkable: 0 };
  /** Contacts its clients found themselves (CAPS.CONTACTS): rows not sent (own rows, records' sides), ships left out */
  readonly contactStats = { found: 0, ownRows: 0, records: 0, leftOut: 0, windows: 0, fxSent: 0, fxFound: 0 };
  /** Contacts' sparks lately (CAPS.CONTACTS clients get those of pairs they don't find at their snapshot: contactFxFor) */
  private readonly fxPending: { tick: number; sys: number; a: number; b: number; msg: ServerContactMessage }[] = [];
  /** ...and the tick each such client was handed them up to */
  private readonly fxTo = new WeakMap<object, number>();

  /** A contact's sparks (GameServer notifyContact): every other client got them at once */
  noteContactFx(tick: number, sys: number, a: number, b: number, msg: ServerContactMessage): void {
    this.fxPending.push({ tick, sys, a, b, msg });
    let n = 0;
    while (n < this.fxPending.length && this.fxPending[n].tick < tick - 128) n++;
    if (n) this.fxPending.splice(0, n);
  }

  /** A CONTACTS client's sparks since it was last handed them: those of pairs it doesn't find itself (`found`: its window's) */
  contactFxFor(conn: object, sys: number, found: ContactWindow | null, now: number): ServerContactMessage[] {
    const from = this.fxTo.get(conn) ?? now - 1;
    this.fxTo.set(conn, now);
    const out: ServerContactMessage[] = [];
    for (const f of this.fxPending) {
      if (f.tick <= from || f.tick > now || f.sys !== sys) continue;
      if (found?.pair(f.a, f.b, f.tick)) { this.contactStats.fxFound++; continue; }
      out.push(f.msg);
      this.contactStats.fxSent++;
    }
    return out;
  }

  constructor(private host: ReplicationHost, private ships: ShipBridge) {}

  private real(eid: number): FlightBody {
    const s = this.ships.get(eid)!;
    return { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], angle: Rotation.angle[eid], angVel: s.angVel, jump: s.jump, jumpScale: s.jumpScale, cargo: s.cargo, dodge: s.dodge, dodgeDir: s.dodgeDir };
  }

  /**
   * After the tick (bodies rounded): step every shadow and see whether it still
   * matches. Ships in systems nobody is in aren't stepped: they're marked out
   * of step, so whoever arrives gets their real state (keyframes always carry it).
   */
  endTick(): void {
    const tick = this.host.tick();
    for (const [id, s] of this.shadows) {
      if (this.ships.has(id)) continue;
      // (Gone with causes this window, which then never go: what clients have of it at its end is off, causedInWindow)
      if (s.causes.length) this.goneCaused.set(id, tick);
      this.shadows.delete(id);
    }
    for (const [id, t] of this.goneCaused) if (t < tick - GONE_CAUSED_TICKS) this.goneCaused.delete(id);
    const docks = this.host.docks?.();
    const occupied = this.host.occupied?.();
    for (const [eid, ship] of this.ships.bodies) {
      // (Another pass's: crowd dilation, sim/SystemClocks.ts)
      if (!SimPass.on(InSystem.systemId[eid])) continue;
      // Distant (ships/SimLod.ts): no client has it in view (it wakes before it can be); whoever gets it next gets its real state
      if (this.ships.isDormant(eid)) {
        const s = this.shadows.get(eid);
        if (s) s.diverged = true;
        continue;
      }
      const rec = this.ships.replicaCtl.get(eid);
      // (What moved a pilot's ship besides its controls this tick: taken whoever's client it is, so none are left over)
      const causes = ship.kind === 'ship' ? this.ships.ownCauses.take(eid) : undefined;
      const dock = docks ? docks.get(eid) ?? null : this.host.dockOf(eid);
      // (A piece of debris spawned this tick had no step yet: it drifts from the next, so it starts as Drift, not a keyframe later)
      const mode = dock ? ReplicaMode.Docked : rec?.mode ?? (ship.kind === 'debris' ? ReplicaMode.Drift : ReplicaMode.Pilotless);
      // (Debris drifts with no controls: 0, as flight.ts records it from its first step; hold here sent a control row next tick)
      const bits = dock ? 0 : rec?.bits ?? (ship.kind === 'debris' ? 0 : CTL.hold);
      const q = dock ? 0 : rec?.q ?? 0;
      let s = this.shadows.get(eid);
      if (!s) {
        this.shadows.set(eid, { mode, body: this.real(eid), bits, q, version: 1, cver: 1, gen: 1, dver: 1, diverged: false, caused: false, causes: [], rebuilds: ship.rebuilds, sig: flightSignature(ship.derived), dock, events: [], qSent: q });
        continue;
      }
      if (mode !== s.mode || !sameDock(dock, s.dock)) { if (!s.diverged) this.why('mode'); s.diverged = true; s.mode = mode; s.dock = dock; if (s.bodied) s.bodied.diverged = true; }
      if (bits !== s.bits || q !== s.q) {
        s.bits = bits;
        s.q = q;
        s.events.push(tick, bits, q);
      }
      // This tick's causes as rows, once for every client that takes them (a pilot's own, CAPS.OWN_SIM; any, CAPS.CAUSES)
      const worked = causes?.length ? this.work(eid, s, causes, tick) : null;
      // A rebuild that changes how it flies: clients get the new structure with the next snapshot, so resend its state
      // too, unless it went as a cause (its clients fly the old structure until its tick)
      if (ship.rebuilds !== s.rebuilds) {
        s.rebuilds = ship.rebuilds;
        const sig = flightSignature(ship.derived);
        // (A piece of debris rebuilt: clients running it (CAPS.DEBRIS) worked its crumbling out, recentring and all, and
        // clients keeping each structure by tick (CAPS.STRUCTS) recentre it from its sync; the rest get a keyframe)
        if (mode === ReplicaMode.Drift) { s.sig = sig; s.lived = true; }
        else if (sig !== s.sig) {
          s.sig = sig;
          if (!worked?.rows.some((r) => r[0] === OWN_CAUSE.REBUILD)) { if (!s.diverged) this.why('rebuild'); s.diverged = true; if (s.bodied) s.bodied.diverged = true; }
        }
      }
      // (Flown by its body: the shadow its body-running clients have, whatever the others need)
      if (rec?.body && mode === ReplicaMode.Pilotless) this.stepBodied(eid, s, rec.body, rec.derived ?? ship.derived, tick, worked);
      else if (s.bodied) s.bodied.diverged = true;
      // A pilot whose client steps its own ship: its shadow is that, whatever the others need (stepOwn)
      if (ship.kind === 'ship' && this.host.ownSim?.(eid)) { this.stepOwn(eid, s, mode, bits, q, rec?.derived ?? ship.derived, tick, worked); continue; }
      if (s.own) s.own = undefined;
      if (s.diverged || mode === ReplicaMode.Docked) continue;
      if (occupied && !occupied.has(InSystem.systemId[eid])) { s.diverged = true; continue; }
      // Debris is stepped as a world (drift and knocks, common ships/debris.ts), alike by clients: only a piece something
      // else moved (bridge/debrisNet.ts) is off what they have
      if (mode === ReplicaMode.Drift) {
        if (this.ships.debrisNet.touched.has(eid)) { s.diverged = true; this.why('Drift:moved'); }
        continue;
      }
      // (The hold's mass it flew this step with, if that changed: a CARGO cause goes in first)
      if (worked) cargoBefore(s.body, worked.rows);
      replicaStep(mode, s.body, { bits, targetAngle: replicaAngle(mode, q) }, rec?.derived ?? ship.derived, this.ships.tuning, this.host.env(eid), tick);
      s.stepped = tick;
      // Its causes, worked out as its clients work them out (ones that can't be: a keyframe for everyone)
      if (causes?.length) {
        if (!worked) { if (!s.diverged) this.why(`${ReplicaMode[mode]}:uncaused`); s.diverged = true; continue; }
        s.pre = { ...s.body };
        s.preTick = tick;
        if (!applyOwnCauses(s.body, worked.rows, worked.env)) { if (!s.diverged) this.why(`${ReplicaMode[mode]}:cause`); s.diverged = true; continue; }
        s.caused = true;
      }
      // (The real state, as real() has it, read in place: this runs for every ship every tick)
      const rx = Position.x[eid], ry = Position.y[eid], rvx = Velocity.x[eid], rvy = Velocity.y[eid], ra = Rotation.angle[eid];
      const b = s.body;
      if (b.x !== rx || b.y !== ry || b.vx !== rvx || b.vy !== rvy || b.angle !== ra || b.angVel !== ship.angVel
        || (b.jump ?? 0) !== (ship.jump ?? 0) || (b.jumpScale ?? 1) !== (ship.jumpScale ?? 1)
        // (The hold's mass: a load taken on or off needs a keyframe carrying it)
        || (b.cargo ?? 0) !== (ship.cargo ?? 0)
        // (A Burst Strafer's counter and way: ships/features/strafer)
        || (b.dodge ?? 0) !== (ship.dodge ?? 0) || (b.dodgeDir ?? 0) !== (ship.dodgeDir ?? 0)) {
        s.diverged = true;
        this.why(`${ReplicaMode[mode]}:${causes?.length ? 'caused:' : ''}${(b.cargo ?? 0) !== (ship.cargo ?? 0) ? 'cargo' : (b.dodge ?? 0) !== (ship.dodge ?? 0) || (b.dodgeDir ?? 0) !== (ship.dodgeDir ?? 0) ? 'dodge' : b.x !== rx || b.y !== ry ? 'pos' : b.vx !== rvx || b.vy !== rvy ? 'vel' : b.angle !== ra || b.angVel !== ship.angVel ? 'turn' : 'jump'}`);
      }
    }
    this.ships.replicaCtl.clear();
    this.ships.ownCauses.clear();
    for (const pair of this.ships.debrisNet.pairs) this.knocks.push(pair);
    // Contacts this tick: whether a client's replica of the other, before the tick's causes, was the contact pass's
    // (stepped this tick, in step, the very numbers): then the row needn't carry the other's state
    const other = (id: number) => this.shadows.get(id);
    for (const s of this.shadows.values()) if (s.causes.length) settleContacts(s.causes, tick, other);
  }

  /**
   * A ship's causes this tick as rows, recorded for the window once (every path that steps a shadow of it works them
   * out from these); null: they can't be sent (why: causeStats), every shadow of it is off (a keyframe)
   */
  private work(eid: number, s: Shadow, causes: OwnCause[], tick: number): WorkedCauses | null {
    const w = workCauses(causes, s.causes, this.ships.tuning.cellSize, this.ships.tuning.collision?.restitution ?? 0.3);
    if (typeof w === 'string') {
      this.causeStats.failed[w] = (this.causeStats.failed[w] ?? 0) + 1;
      s.diverged = true;
      if (s.bodied) s.bodied.diverged = true;
      if (s.own && !s.own.hard) { s.own.why = w; s.own.hard = true; }
      if (s.own) s.body = this.real(eid);
      return null;
    }
    recordCauses(s.causes, w, tick);
    s.worked = w;
    s.workedTick = tick;
    this.causeStats.worked++;
    return w;
  }

  /**
   * A pilot's own ship, as its client steps it (CAPS.OWN_SIM, network/ownTick.ts): its replica step with the controls
   * it flew, then this tick's causes worked out by the client's own function (applyOwnCauses) from what the server's
   * step had (the other body as the contact pass saw it). Then it is the real ship, or something moved it that its
   * client can't work out (`hard`): a keyframe of its own ship. The others get a keyframe as before whenever anything
   * but its controls moved it.
   */
  private stepOwn(eid: number, s: Shadow, mode: ReplicaMode, bits: number, q: number, derived: ShipState['derived'], tick: number, worked: WorkedCauses | null): void {
    const o = s.own ??= { version: -1, events: [], exc: false, excLast: false, first: null, hard: true, why: 'start' };
    o.first ??= [tick, bits, q];
    const hard = (why: string) => { if (!o.hard) o.why = why; o.hard = true; s.diverged = true; s.body = this.real(eid); };
    // Its controls: what its inputs say, or (the engines short of power, an EMP, the cold, an override) the window's
    // real controls go to it (ownFor)
    // (Its engines' power, share and a refused boost it works out itself, its own step being the whole one, stores and
    // all (common sim/ownStep.ts): no row for those; the held controls, aim and hazard bits it can't)
    const want = this.host.ownControls?.(eid);
    o.excLast = !want || want.bits !== (bits & ~OWN_DERIVED_BITS) || want.q !== q;
    if (o.excLast) o.exc = true;
    if (this.host.ownLate?.(eid)) return hard('late input');
    // (Not flown by its pilot: its client has it from its last keyframe, so another only when that's out of date. Docked,
    // its keyframe says where at its station (it rides the station as every client's docked replica does); else when it moved)
    if (mode !== ReplicaMode.Player) {
      const same = o.held === mode && (mode === ReplicaMode.Docked ? sameDock(o.heldDock ?? null, s.dock) : sameBody(s.body, this.real(eid)));
      // (Its shadow stays what its keyframe carried: what its client has, and checks against. A docked ship's velocity
      // isn't its client's to follow)
      // (Nor its controls: held neutral there, no exceptions row)
      if (same) { if (o.hard) s.body = this.real(eid); o.exc = o.excLast = false; return; }
      o.held = mode;
      o.heldDock = s.dock;
      return hard('mode');
    }
    // (Flown again (undocked): from a keyframe)
    if (o.held !== undefined) { o.held = undefined; o.heldDock = undefined; return hard('mode'); }
    if (o.hard) { s.body = this.real(eid); return; }
    if (worked) cargoBefore(s.body, worked.rows);
    replicaStep(mode, s.body, { bits, targetAngle: replicaAngle(mode, q) }, derived, this.ships.tuning, this.host.env(eid), tick);
    if (worked) {
      s.pre = { ...s.body };
      s.preTick = tick;
      if (!applyOwnCauses(s.body, worked.rows, worked.env)) return hard('cause');
      // (Its own rows are the shadow's window events: the others' CAUSES clients get them too, the rest a keyframe of it)
      for (let i = s.causes.length - worked.rows.length; i < s.causes.length; i++) o.events.push(s.causes[i]);
      if (!s.caused) this.why(`${ReplicaMode[mode]}:caused`);
      s.caused = true;
    } else {
      quantizeOwn(s.body);
    }
    s.stepped = tick;
    const b = s.body, ship = this.ships.get(eid)!;
    if (b.x !== Position.x[eid] || b.y !== Position.y[eid] || b.vx !== Velocity.x[eid] || b.vy !== Velocity.y[eid] || b.angle !== Rotation.angle[eid] || b.angVel !== ship.angVel
      || (b.jump ?? 0) !== (ship.jump ?? 0) || (b.jumpScale ?? 1) !== (ship.jumpScale ?? 1) || (b.cargo ?? 0) !== (ship.cargo ?? 0)
      || (b.dodge ?? 0) !== (ship.dodge ?? 0) || (b.dodgeDir ?? 0) !== (ship.dodgeDir ?? 0)) {
      hard(worked ? 'unexplained, with causes' : 'unexplained');
    }
  }

  /** Bodies' clients' shadow of a ship its body flies (Shadow.bodied): stepped as their tick layer steps it */
  readonly bodyStats = { stepped: 0, keyframes: 0, why: {} as Record<string, number> };
  private stepBodied(eid: number, s: Shadow, by: { bits: number; q: number; ix: number; iy: number }, derived: ShipState['derived'], tick: number, worked: WorkedCauses | null): void {
    const ship = this.ships.get(eid)!;
    const sb = s.bodied ??= { body: this.real(eid), version: -1, cver: -1, gen: -1, diverged: true, caused: false, rebuilds: ship.rebuilds };
    const rebuilt = sb.rebuilds !== ship.rebuilds;
    sb.rebuilds = ship.rebuilds;
    if (sb.diverged) return;
    const b = sb.body;
    b.vx += by.ix; b.vy += by.iy;
    if (worked) cargoBefore(b, worked.rows);
    replicaStep(ReplicaMode.Pilotless, b, { bits: by.bits, targetAngle: replicaAngle(ReplicaMode.Pilotless, by.q) }, derived, this.ships.tuning, this.host.env(eid), tick);
    this.bodyStats.stepped++;
    sb.stepped = tick;
    // (Its causes: CAUSES clients running it work them out; the rest are sent a keyframe of it)
    if (worked) {
      sb.pre = { ...b };
      sb.preTick = sb.workedTick = tick;
      sb.worked = worked;
      if (!applyOwnCauses(b, worked.rows, worked.env)) { sb.diverged = true; return; }
      sb.caused = true;
    }
    if (b.x !== Position.x[eid] || b.y !== Position.y[eid] || b.vx !== Velocity.x[eid] || b.vy !== Velocity.y[eid] || b.angle !== Rotation.angle[eid] || b.angVel !== ship.angVel) {
      sb.diverged = true;
      const w = (rebuilt ? 'rebuilt:' : '') + (b.x !== Position.x[eid] || b.y !== Position.y[eid] ? 'pos' : b.vx !== Velocity.x[eid] || b.vy !== Velocity.y[eid] ? 'vel' : 'turn');
      this.bodyStats.why[w] = (this.bodyStats.why[w] ?? 0) + 1;
    }
  }

  /** Its bodied shadow's keyframe version (CAPS.BODIES clients' known version of it), or undefined: not flown by its body */
  bodyVersionOf(eid: number): number | undefined {
    return this.shadows.get(eid)?.bodied?.version;
  }

  /**
   * Will this snapshot bring a client a keyframe of this ship (what it had of it is off): its own ship (CAPS.OWN_SIM)
   * by its own versions, any other by the shared ones. Asked before forClient
   */
  keysFor(eid: number, self: number, known: ReadonlyMap<number, number>): boolean {
    const s = this.shadows.get(eid);
    if (!s) return true;
    if (eid === self) return !!s.own && known.get(eid) !== s.own.version;
    if (s.bodied && known.get(eid)! < 0) return known.get(eid) !== s.bodied.cver;
    return known.get(eid) !== s.cver;
  }

  /**
   * The check's byte for every ship a CAUSES client holds now (its own check adds it, network/causes.ts replicasByte):
   * the shadow it has of each (in step: its causes clients' version; one its body flies there, that one), no debris, none docked
   */
  heldByte(known: ReadonlyMap<number, number>, self: number, bodies?: (id: number) => boolean): number {
    let sum = 0;
    for (const [id, v] of known) {
      const s = this.shadows.get(id);
      if (id === self || !s || s.mode === ReplicaMode.Drift || s.mode === ReplicaMode.Docked || this.ships.get(id)?.kind !== 'ship') continue;
      const b = s.bodied && bodies?.(id) && v === s.bodied.cver ? s.bodied.body : v === s.cver ? s.body : null;
      if (b) sum = (sum + replicaHash(id, b)) >>> 0;
    }
    return replicasByte(sum);
  }

  /** A keyframe of this ship added to a client's snapshot after its forClient (BodyNet.readersOf) */
  keyNow(eid: number, known: Map<number, number>, ships: KeyframeRow[]): void {
    const s = this.shadows.get(eid);
    if (!s || !known.has(eid)) return;
    known.set(eid, s.bodied ? s.bodied.cver : s.cver);
    ships.push(s.keyRow ??= packKeyframe({ id: eid, mode: s.mode, body: this.real(eid), ctl: { bits: s.bits, targetAngle: 0 }, q: s.q, dock: s.dock ?? undefined }));
    this.keyframes++;
    if (s.bodied) this.bodyStats.keyframes++;
  }

  /** A pilot's own ship not flown by them (docked) as its client has it: its last keyframe's body (stepOwn); null otherwise */
  ownHeld(eid: number): FlightBody | null {
    const s = this.shadows.get(eid);
    return s?.own?.held !== undefined ? s.body : null;
  }

  /** Ships removed lately that had causes in their last window, and when (causedInWindow) */
  private readonly goneCaused = new Map<number, number>();

  /**
   * Did something besides its controls move this ship in its window so far (or before it was removed lately)? Its
   * causes go only with it: one leaving a client's view (dying) leaves that client's replica of it off at the end
   */
  causedInWindow(eid: number): boolean {
    return !!this.shadows.get(eid)?.causes.length || this.goneCaused.has(eid);
  }

  /** A ship's keyframe version (bumped whenever it left its predicted path) */
  versionOf(eid: number): number {
    return this.shadows.get(eid)?.version ?? 0;
  }

  /**
   * A pilot's own ship as its own client goes by (CAPS.OWN_SIM): its own keyframe version, moved only when something
   * its client can't work out moved it (stepOwn, ownFor); undefined while its client doesn't step it. A contact or a
   * pull moves `version` (everyone else's keyframe), not this: its client worked that out on its tick layer
   */
  ownVersionOf(eid: number): number | undefined {
    return this.shadows.get(eid)?.own?.version;
  }

  /** Before building snapshots: ships that left their predicted path get a new keyframe */
  beginSnapshot(due?: (eid: number) => boolean): void {
    for (const [eid, s] of this.shadows) {
      // Gone since the tick ended (taken out of the world between): nothing to send
      if (!this.ships.has(eid)) { this.shadows.delete(eid); continue; }
      // (A system whose round this isn't: a wider window, crowd fallbacks; its window goes on)
      if (due && !due(eid)) continue;
      s.keyRow = s.ctlRow = undefined;
      // (A pilot's own, CAPS.OWN_SIM: something its client couldn't work out moved it: a keyframe of its own ship)
      if (s.own?.hard) {
        s.own.version--;
        s.own.hard = false;
        this.ownWhy(s.own.why ?? '?');
        s.own.why = undefined;
      }
      const sb = s.bodied;
      if (sb?.diverged) { sb.diverged = false; sb.version = sb.cver = --sb.gen; sb.body = this.real(eid); }
      else if (sb?.caused) sb.version = --sb.gen;
      if (sb) sb.caused = false;
      // (Off its path: a keyframe for everyone. Moved by causes only: for those who don't take them)
      if (s.diverged) {
        s.diverged = false;
        s.version = s.cver = s.dver = ++s.gen;
        s.body = this.real(eid);
      } else if (s.lived) s.version = s.cver = ++s.gen;
      else if (s.caused) s.version = ++s.gen;
      s.caused = s.lived = false;
    }
  }

  /** After the snapshots: the control changes have been delivered */
  endSnapshot(due?: (eid: number) => boolean): void {
    if (due) { let n = 0; for (const k of this.knocks) if (!due(k[0]) && !due(k[1])) this.knocks[n++] = k; this.knocks.length = n; }
    else this.knocks.length = 0;
    this.ships.debrisNet.clearTouched(due);
    for (const [eid, s] of this.shadows) {
      if (due && !due(eid)) continue;
      if (s.events.length) s.events = [];
      s.qSent = s.q;
      if (s.causes.length) { s.causes = []; s.worked = undefined; }
      if (s.own) {
        s.own.events = [];
        // (The next window starts from this one's last controls: still exceptional, they go again)
        s.own.exc = s.own.excLast;
        s.own.first = null;
      }
    }
  }

  private ownWhy(w: string): void {
    this.ownStats.keyframes++;
    this.ownStats.why[w] = (this.ownStats.why[w] ?? 0) + 1;
  }

  /** A ship's controls on the last tick stepped (CAPS.OWN_SIM: what its client's own check hashes with its state) */
  controlsOf(eid: number): { bits: number; q: number } | null {
    const s = this.shadows.get(eid);
    return s ? { bits: s.bits, q: s.q } : null;
  }

  /**
   * One client's share: keyframes for ships it's new to or behind on, control
   * changes and causes for the rest. `known` is the client's ship → keyframe version. Its own ship goes too: the
   * causes of what moved it besides its inputs (it steps it itself), a keyframe only when it can't have it otherwise.
   * `since`: its last snapshot's tick, the window it finds contact pairs over itself (net/causes/contactsFor.ts)
   */
  forClient(systemId: number, self: number, known: Map<number, number>, snapshotTick: number, view?: Set<number>, held?: ReadonlyMap<number, unknown>, synced?: (id: number) => number | undefined, bodies?: (id: number) => boolean, kept?: Kept, readers?: (ships: KeyframeRow[]) => Iterable<number>, live?: ReadonlySet<number>, since?: number): { ships: KeyframeRow[]; ctl: ControlRow[]; own?: number[][]; ownRebuild?: number; causes?: number[][]; caused?: number[]; found?: ContactWindow } {
    const ships: KeyframeRow[] = [];
    const ctl: ControlRow[] = [];
    const out: { own?: number[][]; ownRebuild?: number; causes?: number[][]; caused?: number[]; ownEvents?: CauseEvent[]; found?: ContactWindow } = {};
    // (The ships it held before this snapshot: the ones it may take in its own contact pass)
    const before = since !== undefined ? new Set(known.keys()) : null;
    if (before) this.ships.contactLog.wanted = true;
    // (Which version of a ship this client goes by: moved only when causes don't explain it; a piece of debris, only
    // when it left what it works out)
    const ver = (s: Shadow) => (s.mode === ReplicaMode.Drift ? s.dver : s.cver);
    const bver = (s: Shadow) => s.bodied!.cver;
    // Its own ship, stepped by itself (CAPS.OWN_SIM): this window's causes, the real controls only where its inputs
    // don't say them, and a keyframe only when it can't have its ship otherwise (first, before the others' versions move on)
    const mine = this.host.ownSim?.(self) ? this.shadows.get(self) : undefined;
    if (mine?.own && InSystem.systemId[self] === systemId && (!view || view.has(self))) this.ownFor(self, mine, mine.own, known, snapshotTick, ships, ctl, out, synced, kept, bodies);
    for (const id of known.keys()) if (!this.shadows.has(id)) known.delete(id);
    // (A piece of debris knocked by one this client doesn't step, out of view or not had yet: what it has of it is off)
    if (view) {
      const steps = (x: number) => view.has(x) && (known.has(x) || !!held?.has(x));
      for (const [a, c] of this.knocks) { const sa = steps(a), sc = steps(c); if (sa !== sc) known.delete(sa ? a : c); }
    }
    // (CAPS.CAUSES: ships whose causes go this snapshot, and those keyframed: a contact with one of them carries its state)
    const caused: [number, Shadow][] = [];
    const keyed = new Set<number>();
    for (const [eid, s] of this.shadows) {
      if ((eid === self && mine?.own) || InSystem.systemId[eid] !== systemId) continue;
      // Debris it's working out itself (unconfirmed): nothing yet (SnapshotBuilder sends it all if it isn't confirmed)
      if (held?.has(eid)) continue;
      // Out of the client's view: nothing (and a keyframe when it comes back)
      if (view && !view.has(eid)) { known.delete(eid); continue; }
      // (Causes it can't work out: a contact with a ship whose structure it hasn't got as the pass had it: a keyframe)
      if (s.causes.length && !this.workable(s, synced, self, mine, view, eid, kept)) { known.delete(eid); this.causeStats.unworkable++; }
      // Flown by its body on this client's tick layer (CAPS.BODIES): a keyframe only when its bodied shadow left the ship
      if (s.bodied && bodies?.(eid)) {
        if (known.get(eid) !== bver(s)) {
          known.set(eid, bver(s));
          ships.push(s.keyRow ??= packKeyframe({ id: eid, mode: s.mode, body: this.real(eid), ctl: { bits: s.bits, targetAngle: 0 }, q: s.q, dock: s.dock ?? undefined }));
          this.keyframes++;
          this.bodyStats.keyframes++;
          keyed.add(eid);
        } else if (s.causes.length) caused.push([eid, s]);
        continue;
      }
      if (known.get(eid) !== ver(s)) {
        known.set(eid, ver(s));
        ships.push(s.keyRow ??= packKeyframe({ id: eid, mode: s.mode, body: this.real(eid), ctl: { bits: s.bits, targetAngle: 0 }, q: s.q, dock: s.dock ?? undefined }));
        this.keyframes++;
        keyed.add(eid);
        continue;
      }
      if (s.causes.length) caused.push([eid, s]);
      if (s.events.length) {
        if (!s.ctlRow) {
          const events: [number, number, number][] = [];
          for (let i = 0; i < s.events.length; i += 3) events.push([snapshotTick - s.events[i], s.events[i + 1], s.events[i + 2]]);
          s.ctlRow = packControlRow(eid, events, s.qSent);
        }
        ctl.push(s.ctlRow);
      }
    }
    // (A body it runs reads a ship keyframed now: what the body made of it this window was off too, so the body's ship
    // goes again as well (BodyNet.readersOf). Before any contact is settled: one with that ship then carries its state)
    if (readers && ships.length) {
      for (const id of readers(ships)) {
        const n = ships.length;
        this.keyNow(id, known, ships);
        if (ships.length === n) continue;
        keyed.add(id);
        const i = caused.findIndex(([e]) => e === id);
        if (i >= 0) caused.splice(i, 1);
      }
    }
    // (CAPS.CONTACTS: the window's contacts it finds itself, between ships it held before and holds in step: neither
    // as own rows nor as records, net/causes/contactsFor.ts)
    const found = before ? this.found(systemId, self, before, known, ships, snapshotTick, since!, mine, view, held, synced, kept) : null;
    if (found) {
      out.found = found;
      if (out.own && out.ownEvents) {
        const keep = out.own.map((_, i) => !found.found(self, out.ownEvents![i]));
        if (keep.includes(false)) {
          this.contactStats.ownRows += keep.filter((k) => !k).length;
          out.own = out.own.filter((_, i) => keep[i]);
          out.ownEvents = out.ownEvents.filter((_, i) => keep[i]);
          if (!out.own.length) out.own = undefined;
        }
      }
    }
    // (Its own ship's contacts with a ship keyframed now after all (new to it, or one it couldn't work out): the other's
    // state goes, its replica of the other before the keyframe isn't the pass's)
    if (out.own && out.ownEvents) {
      for (let i = 0; i < out.own.length; i++) {
        const r = out.own[i], e = out.ownEvents[i];
        if (r[1] === OWN_CAUSE.CONTACT && r.length === 4 && keyed.has(r[2])) out.own[i] = causeRow(e, snapshotTick, false);
      }
    }
    out.ownEvents = undefined;
    // Their causes (CAPS.CAUSES), a contact without the other's state where its replica of the other is the pass's: in
    // step (no keyframe of it since the contact, none now) and not flown by its body here
    if (caused.length || found?.leftOut.length) {
      // (Its own ship keyframed now: ownFor's, first in the list)
      const ownKeyed = ships.some((k) => k[0] === self);
      const inStep = (c: NonNullable<CauseEvent['contact']>) => {
        const o = c.other;
        if (o === self) return c.inStep && !!mine?.own && !ownKeyed;
        const os = this.shadows.get(o);
        if (!os || keyed.has(o)) return false;
        // (One flown by its body here: its bodied shadow is what this client has of it)
        if (os.bodied && bodies?.(o)) return !!c.bodyStep && os.bodied.cver === c.bcver && known.get(o) === os.bodied.cver;
        return c.inStep && os.cver === c.cver && known.get(o) === os.cver;
      };
      // (Contacts it finds itself go as no record, CAPS.CONTACTS)
      const lists = caused.map(([eid, s]) => {
        if (!found) return [eid, s.causes] as const;
        const l = s.causes.filter((e) => !found.found(eid, e));
        this.contactStats.records += s.causes.length - l.length;
        return [eid, l] as const;
      });
      const { rows, stateless } = causeRecords(lists, snapshotTick,
        (e) => !!e.contact && inStep(e.contact), (e) => !!e.contact && this.before(e.contact, synced));
      this.causeStats.rows += rows.length;
      this.causeStats.stateless += stateless;
      // (Ships it leaves out of its own contact pass this window: one record naming each twice, last)
      if (found) for (const id of found.leftOut) rows.push([0, OWN_CAUSE.CONTACT, id, id, 0]);
      if (rows.length) out.causes = rows;
      // (Every ship a record names: its client leaves hits on them this window to the records, SelfHits.onCaused; and
      // every ship a pair it finds touched, ContactWorld)
      const ids = new Set<number>(found?.touched);
      for (const r of rows) { ids.add(r[2]); if (r[1] === OWN_CAUSE.CONTACT) ids.add(r[3]); }
      out.caused = [...ids];
    } else if (found?.touched.size) {
      out.caused = [...found.touched];
    }
    return { ships, ctl, ...out };
  }

  /**
   * The window's contacts a CONTACTS client finds itself (net/causes/contactsFor.ts): the ships it takes are the ones it
   * held before this snapshot and holds in step through it (no keyframe now, still in view, in this system, ships; its
   * own when it steps it, CAPS.OWN_SIM)
   */
  private found(systemId: number, self: number, before: ReadonlySet<number>, known: ReadonlyMap<number, number>, ships: KeyframeRow[], snapshotTick: number, since: number, mine: Shadow | undefined, view?: Set<number>, held?: ReadonlyMap<number, unknown>, synced?: (id: number) => number | undefined, kept?: Kept): ContactWindow {
    const keyed = new Set(ships.map((k) => k[0]));
    const take = new Set<number>();
    for (const id of before) {
      if (!known.has(id) || keyed.has(id) || held?.has(id) || InSystem.systemId[id] !== systemId || this.ships.get(id)?.kind !== 'ship') continue;
      if (id === self ? !mine?.own : !this.shadows.has(id) || (view && !view.has(id))) continue;
      take.add(id);
    }
    const w = contactWindow({
      log: this.ships.contactLog, systemId, from: since, to: snapshotTick, held: take,
      docked: (id) => this.shadows.get(id)?.mode === ReplicaMode.Docked,
      events: (id) => this.shadows.get(id)?.causes,
      structOk: (id, rb) => {
        if (kept?.(id)?.includes(rb)) return true;
        const now = this.ships.get(id)?.rebuilds;
        return now === rb && (synced?.(id) === now || id === self || !!view?.has(id));
      },
    });
    this.contactStats.windows++;
    this.contactStats.leftOut += w.leftOut.length;
    this.contactStats.found += w.count;
    return w;
  }

  /** A contact's other, rebuilt since while its client still has it as it was: it keeps that structure (OTHER_BEFORE) */
  private before(c: NonNullable<CauseEvent['contact']>, synced?: (id: number) => number | undefined): boolean {
    const now = this.ships.get(c.other)?.rebuilds ?? -1, has = synced ? synced(c.other) : now;
    return now !== c.rebuilds && has === c.rebuilds;
  }

  /**
   * Can a client work this window's causes of a ship out: has it each contact's other's structure as the pass had it
   * (or will it, by this frame's sync: one in view rebuilt no further since; syncs go before the snapshot)
   */
  private workable(s: Shadow, synced: ((id: number) => number | undefined) | undefined, self: number, mine: Shadow | undefined, view?: Set<number>, eid?: number, kept?: Kept): boolean {
    for (const e of s.causes) {
      if (e.rebuild && !this.rebuildOk(eid!, e, s.causes, synced, kept)) return false;
      const c = e.contact;
      if (!c) continue;
      // (Its own ship: it has the structure it flew each tick with)
      if (c.other === self) { if (!mine?.own) return false; continue; }
      // (Keeping every structure by its tick, CAPS.STRUCTS: the one the other had then)
      if (kept?.(c.other)?.includes(c.rebuilds)) continue;
      const now = this.ships.get(c.other)?.rebuilds, has = synced ? synced(c.other) : now;
      if (has === c.rebuilds || (now === c.rebuilds && (!view || view.has(c.other)))) continue;
      return false;
    }
    return true;
  }

  /**
   * Can its client work a rebuild out: it recentres from the structure it has before this frame's sync to the one
   * after, so those must be the rebuild's either side (none of its other rebuilds in between: a death's, say, that
   * isn't a cause)
   */
  private rebuildOk(eid: number, e: CauseEvent, window: readonly CauseEvent[], synced?: (id: number) => number | undefined, kept?: Kept): boolean {
    const r = e.rebuild!;
    // (Keeping every structure by its tick, CAPS.STRUCTS: this rebuild's and the one before it, in that order)
    const k = kept?.(eid);
    if (k) {
      const pr = this.ships.structLog.around(eid, e.tick), i = pr ? k.indexOf(pr[1].rebuilds) : -1;
      return !!pr && i > 0 && k[i - 1] === pr[0].rebuilds && sameVec(pr[1].com, r.to) && sameVec(pr[0].com, r.from);
    }
    // (Else from the one it has before this frame's sync to the one after: a second in the window has the one between)
    if (window.filter((w) => w.rebuild).length > 1) return false;
    const ship = this.ships.get(eid);
    if (!ship || ship.derived.com[0] !== r.to[0] || ship.derived.com[1] !== r.to[1]) return false;
    const has = synced ? synced(eid) : undefined, had = has === undefined ? undefined : this.ships.debrisNet.comAt(eid, has);
    return !!had && had[0] === r.from[0] && had[1] === r.from[1];
  }

  /** One pilot's own ship (CAPS.OWN_SIM): see forClient */
  private ownFor(eid: number, s: Shadow, o: OwnShadow, known: Map<number, number>, snapshotTick: number, ships: KeyframeRow[], ctl: ControlRow[], out: { own?: number[][]; ownRebuild?: number; ownEvents?: CauseEvent[] }, synced?: (id: number) => number | undefined, kept?: Kept, bodied?: (id: number) => boolean): void {
    // (A contact whose other it can't have as the pass had it: rebuilt since, or a ship this client doesn't have)
    for (const e of o.events) {
      const c = e.contact;
      if (!c) continue;
      // (Rebuilt since, while its client still had it as it was: it keeps that structure when the new one comes, OTHER_BEFORE)
      const now = this.ships.get(c.other)?.rebuilds ?? -1;
      c.before = this.before(c, synced);
      if (!known.has(c.other) || (now !== c.rebuilds && !c.before && !kept?.(c.other)?.includes(c.rebuilds))) { o.version--; this.ownWhy('contact: other not had'); break; }
    }
    // (A rebuild it can't work out from the structures it has either side of this frame's sync)
    for (const e of o.events) if (e.rebuild && !this.rebuildOk(eid, e, o.events, synced, kept)) { o.version--; this.ownWhy('rebuild not had'); break; }
    if (known.get(eid) !== o.version) {
      known.set(eid, o.version);
      ships.push(s.keyRow ??= packKeyframe({ id: eid, mode: s.mode, body: this.real(eid), ctl: { bits: s.bits, targetAngle: 0 }, q: s.q, dock: s.dock ?? undefined }));
      this.keyframes++;
      return;
    }
    if (o.exc && o.first) {
      // The window's real controls from its first tick (the client puts them in place of its inputs'), from aim 0
      const ev: [number, number, number][] = [[snapshotTick - o.first[0], o.first[1], o.first[2]]];
      for (let i = 0; i < s.events.length; i += 3) if (s.events[i] > o.first[0]) ev.push([snapshotTick - s.events[i], s.events[i + 1], s.events[i + 2]]);
      ctl.push(packControlRow(eid, ev, 0));
      this.ownStats.exc++;
    }
    if (!o.events.length) return;
    const rows: number[][] = [];
    for (const e of o.events) {
      const c = e.contact;
      // (Its replica of the other is what the contact pass had: the state stays out. Not if the other gets a keyframe
      // now or had one since (the client's replica of it moved), nor if it was rebuilt since: its client steps it with
      // the new structure from its last keyframe on. Its versions: the ones this client goes by)
      const os = c && this.shadows.get(c.other), v = c && c.cver;
      const rekeyed = !!c && os?.cver !== v;
      // (One flown by its body on this client (CAPS.BODIES): its bodied shadow is what the client has of it, its own
      // versions counting down; in step then and not keyframed since, the state stays out too)
      const ran = !!c && !!os?.bodied && (bodied?.(c.other) ?? false) && (known.get(c.other) ?? 0) < 0;
      const stateless = !!c && (ran ? !!c.bodyPreStep && os!.bodied!.cver === c.bcver && known.get(c.other) === c.bcver
        : !!c.preStep && !rekeyed && known.get(c.other) === v);
      const r = causeRow(e, snapshotTick, stateless);
      rows.push(r);
      this.ownStats.causes++;
      if (r[1] === OWN_CAUSE.PULL) this.ownStats.pull++;
      else if (r[1] === OWN_CAUSE.CONTACT) { this.ownStats.contact++; if (r.length > 4) this.ownStats.contactState++; }
      else if (r[1] === OWN_CAUSE.CARGO) this.ownStats.cargo++;
      else { this.ownStats.rebuild++; out.ownRebuild = Math.max(out.ownRebuild ?? -Infinity, e.tick); }
    }
    out.own = rows;
    out.ownEvents = o.events;
  }
}
