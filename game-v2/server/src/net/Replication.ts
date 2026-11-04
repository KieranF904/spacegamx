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
  replicaStep, replicaAngle, packKeyframe, packControlRow, flightSignature, applyOwnCauses, quantizeShipBody, OWN_CAUSE,
  type ShipState, CELL_HOLD_TICKS, cellMemberHash,
} from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';
import type { OwnCause } from '../ships/bridge/ownCauses.js';
import { workCauses, recordCauses, settleContacts, causeRow, causeRecords, type CauseEvent, type WorkedCauses } from './causes/shadowCauses.js';

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
}

/** (A shadow rounded as every body is at a tick's end) */
const quantizeOwn = (b: FlightBody): void => quantizeShipBody(b);

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
  bodied?: { body: FlightBody; version: number; cver: number; gen: number; diverged: boolean; caused: boolean; rebuilds: number };
  /** Its control changes of earlier windows, [tick, bits, q], the last CELL_HOLD_TICKS and more (the focus grid's logs, CAPS.FOCUS) */
  log?: number[];
}

/** How far back control changes are kept for the focus grid's logs (ticks): the hold, and a second to answer in */
const LOG_TICKS = CELL_HOLD_TICKS + 120;

const sameDock = (a: Shadow['dock'], b: Shadow['dock']) => (!a && !b) || (!!a && !!b && a.station === b.station && a.ox === b.ox && a.oy === b.oy);

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
  readonly ownStats = { causes: 0, pull: 0, contact: 0, contactState: 0, rebuild: 0, keyframes: 0, exc: 0, why: {} as Record<string, number> };
  /** Other ships' causes (CAPS.CAUSES): ticks a ship's were worked out, rows sent, contacts sent without state, keyframes for ones a client couldn't work out */
  readonly causeStats = { worked: 0, failed: {} as Record<string, number>, rows: 0, stateless: 0, unworkable: 0 };

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
    for (const id of this.shadows.keys()) if (!this.ships.has(id)) this.shadows.delete(id);
    const docks = this.host.docks?.();
    const occupied = this.host.occupied?.();
    for (const [eid, ship] of this.ships.bodies) {
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
      const bits = dock ? 0 : rec?.bits ?? CTL.hold;
      const q = dock ? 0 : rec?.q ?? 0;
      let s = this.shadows.get(eid);
      if (!s) {
        this.shadows.set(eid, { mode, body: this.real(eid), bits, q, version: 1, cver: 1, gen: 1, diverged: false, caused: false, causes: [], rebuilds: ship.rebuilds, sig: flightSignature(ship.derived), dock, events: [], qSent: q });
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
        if (sig !== s.sig) {
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
    const want = this.host.ownControls?.(eid);
    o.excLast = !want || want.bits !== bits || want.q !== q;
    if (o.excLast) o.exc = true;
    if (this.host.ownLate?.(eid)) return hard('late input');
    if (mode !== ReplicaMode.Player) return hard('mode');
    if (o.hard) { s.body = this.real(eid); return; }
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
    replicaStep(ReplicaMode.Pilotless, b, { bits: by.bits, targetAngle: replicaAngle(ReplicaMode.Pilotless, by.q) }, derived, this.ships.tuning, this.host.env(eid), tick);
    this.bodyStats.stepped++;
    // (Its causes: CAUSES clients running it work them out; the rest are sent a keyframe of it)
    if (worked) {
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
  keysFor(eid: number, self: number, known: ReadonlyMap<number, number>, causes = false): boolean {
    const s = this.shadows.get(eid);
    if (!s) return true;
    if (eid === self) return !!s.own && known.get(eid) !== s.own.version;
    if (s.bodied && known.get(eid)! < 0) return known.get(eid) !== (causes ? s.bodied.cver : s.bodied.version);
    return known.get(eid) !== (causes ? s.cver : s.version);
  }

  /**
   * A ship as every holder of it has it now (the focus grid's dropped-cell record, CAPS.FOCUS): its keyframe version and
   * the hash of its shadow and controls (cells.ts cellMemberHash). Null: no shadow, debris (stepped as a world), docked, or off its path
   */
  cellMember(eid: number): { version: number; h: number } | null {
    const s = this.shadows.get(eid);
    // (Docked ones ride their station, their shadow not stepped: they come back as new)
    if (!s || s.mode === ReplicaMode.Drift || s.mode === ReplicaMode.Docked || s.diverged) return null;
    return { version: s.version, h: cellMemberHash(eid, s.body, s.bits, s.q) };
  }

  /** Its control changes after tick T, through this window's ([tick, bits, q]: a dropped cell's log, CAPS.FOCUS) */
  eventsSince(eid: number, T: number): [number, number, number][] {
    const s = this.shadows.get(eid), out: [number, number, number][] = [];
    if (!s) return out;
    for (const a of [s.log ?? [], s.events]) for (let i = 0; i + 2 < a.length; i += 3) if (a[i] > T) out.push([a[i], a[i + 1], a[i + 2]]);
    return out;
  }

  /** A ship's keyframe version (bumped whenever it left its predicted path) */
  versionOf(eid: number): number {
    return this.shadows.get(eid)?.version ?? 0;
  }

  /** Before building snapshots: ships that left their predicted path get a new keyframe */
  beginSnapshot(): void {
    for (const [eid, s] of this.shadows) {
      // Gone since the tick ended (taken out of the world between): nothing to send
      if (!this.ships.has(eid)) { this.shadows.delete(eid); continue; }
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
        s.version = s.cver = ++s.gen;
        s.body = this.real(eid);
      } else if (s.caused) s.version = ++s.gen;
      s.caused = false;
    }
  }

  /** After the snapshots: the control changes have been delivered */
  endSnapshot(): void {
    this.knocks.length = 0;
    this.ships.debrisNet.clearTouched();
    const keep = this.host.tick() - LOG_TICKS;
    for (const s of this.shadows.values()) {
      // (Kept a while for the focus grid's logs: a dropped cell's ships fast-forward from them)
      if (s.events.length) { (s.log ??= []).push(...s.events); s.events = []; }
      if (s.log) { let n = 0; while (n < s.log.length && s.log[n] < keep) n += 3; if (n) s.log.splice(0, n); }
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
   * changes for the rest. `known` is the client's ship → keyframe version.
   * `own`: its own ship too (CAPS.OWN_SHOTS): the very rows everyone else gets of
   * it, so it has its ship as the server's shadow has it, tick by tick, beside its
   * prediction (its own shells are built from that: SnapshotBuilder, ownShots.ts)
   */
  forClient(systemId: number, self: number, known: Map<number, number>, snapshotTick: number, view?: Set<number>, held?: ReadonlyMap<number, unknown>, own = false, synced?: (id: number) => number | undefined, bodies?: (id: number) => boolean, causes = false): { ships: KeyframeRow[]; ctl: ControlRow[]; own?: number[][]; ownRebuild?: number; causes?: number[][]; caused?: number[] } {
    const ships: KeyframeRow[] = [];
    const ctl: ControlRow[] = [];
    const out: { own?: number[][]; ownRebuild?: number; causes?: number[][]; caused?: number[] } = {};
    // (Which version of a ship this client goes by: CAPS.CAUSES clients' moves only when causes don't explain it)
    const ver = (s: Shadow) => (causes ? s.cver : s.version);
    const bver = (s: Shadow) => (causes ? s.bodied!.cver : s.bodied!.version);
    // Its own ship, stepped by itself (CAPS.OWN_SIM): this window's causes, the real controls only where its inputs
    // don't say them, and a keyframe only when it can't have its ship otherwise (first, before the others' versions move on)
    const mine = own && this.host.ownSim?.(self) ? this.shadows.get(self) : undefined;
    if (mine?.own && InSystem.systemId[self] === systemId && (!view || view.has(self))) this.ownFor(self, mine, mine.own, known, snapshotTick, ships, ctl, out, synced, causes);
    for (const id of known.keys()) if (!this.shadows.has(id)) known.delete(id);
    // (Not sent its own: what it has of it goes stale, so it starts again from a keyframe when it is)
    if (!own) known.delete(self);
    // (A piece of debris knocked by one this client doesn't step, out of view or not had yet: what it has of it is off)
    if (view) {
      const steps = (x: number) => view.has(x) && (known.has(x) || !!held?.has(x));
      for (const [a, c] of this.knocks) { const sa = steps(a), sc = steps(c); if (sa !== sc) known.delete(sa ? a : c); }
    }
    // (CAPS.CAUSES: ships whose causes go this snapshot, and those keyframed: a contact with one of them carries its state)
    const caused: [number, Shadow][] = [];
    const keyed = new Set<number>();
    for (const [eid, s] of this.shadows) {
      if ((eid === self && (!own || mine?.own)) || InSystem.systemId[eid] !== systemId) continue;
      // Debris it's working out itself (unconfirmed): nothing yet (SnapshotBuilder sends it all if it isn't confirmed)
      if (held?.has(eid)) continue;
      // Out of the client's view: nothing (and a keyframe when it comes back)
      if (view && !view.has(eid)) { known.delete(eid); continue; }
      // (Causes it can't work out: a contact with a ship whose structure it hasn't got as the pass had it: a keyframe)
      if (causes && s.causes.length && !this.workable(s, synced, self, mine, view)) { known.delete(eid); this.causeStats.unworkable++; }
      // Flown by its body on this client's tick layer (CAPS.BODIES): a keyframe only when its bodied shadow left the ship
      if (s.bodied && bodies?.(eid)) {
        if (known.get(eid) !== bver(s)) {
          known.set(eid, bver(s));
          ships.push(s.keyRow ??= packKeyframe({ id: eid, mode: s.mode, body: this.real(eid), ctl: { bits: s.bits, targetAngle: 0 }, q: s.q, dock: s.dock ?? undefined }));
          this.keyframes++;
          this.bodyStats.keyframes++;
          keyed.add(eid);
        } else if (causes && s.causes.length) caused.push([eid, s]);
        continue;
      }
      if (known.get(eid) !== ver(s)) {
        known.set(eid, ver(s));
        ships.push(s.keyRow ??= packKeyframe({ id: eid, mode: s.mode, body: this.real(eid), ctl: { bits: s.bits, targetAngle: 0 }, q: s.q, dock: s.dock ?? undefined }));
        this.keyframes++;
        keyed.add(eid);
        continue;
      }
      if (causes && s.causes.length) caused.push([eid, s]);
      if (s.events.length) {
        if (!s.ctlRow) {
          const events: [number, number, number][] = [];
          for (let i = 0; i < s.events.length; i += 3) events.push([snapshotTick - s.events[i], s.events[i + 1], s.events[i + 2]]);
          s.ctlRow = packControlRow(eid, events, s.qSent);
        }
        ctl.push(s.ctlRow);
      }
    }
    // Their causes (CAPS.CAUSES), a contact without the other's state where its replica of the other is the pass's: in
    // step (no keyframe of it since the contact, none now) and not flown by its body here
    if (caused.length) {
      const ownKeyed = !!mine?.own && known.get(self) !== mine.own.version;
      const inStep = (o: number, cver: number) => {
        if (o === self) return !!mine?.own && !ownKeyed;
        const os = this.shadows.get(o);
        return !!os && !keyed.has(o) && !(os.bodied && bodies?.(o)) && os.cver === cver && known.get(o) === os.cver;
      };
      const { rows, stateless } = causeRecords(caused.map(([eid, s]) => [eid, s.causes] as const), snapshotTick,
        (e) => !!e.contact && e.contact.inStep && inStep(e.contact.other, e.contact.cver), (e) => !!e.contact && this.before(e.contact, synced));
      this.causeStats.rows += rows.length;
      this.causeStats.stateless += stateless;
      out.causes = rows;
      // (Every ship a record names: its client leaves hits on them this window to the records, SelfHits.onCaused)
      const ids = new Set<number>();
      for (const r of rows) { ids.add(r[2]); if (r[1] === OWN_CAUSE.CONTACT) ids.add(r[3]); }
      out.caused = [...ids];
    }
    return { ships, ctl, ...out };
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
  private workable(s: Shadow, synced: ((id: number) => number | undefined) | undefined, self: number, mine: Shadow | undefined, view?: Set<number>): boolean {
    for (const e of s.causes) {
      const c = e.contact;
      if (!c) continue;
      // (Its own ship: it has the structure it flew each tick with)
      if (c.other === self) { if (!mine?.own) return false; continue; }
      const now = this.ships.get(c.other)?.rebuilds, has = synced ? synced(c.other) : now;
      if (has === c.rebuilds || (now === c.rebuilds && (!view || view.has(c.other)))) continue;
      return false;
    }
    return true;
  }

  /** One pilot's own ship (CAPS.OWN_SIM): see forClient */
  private ownFor(eid: number, s: Shadow, o: OwnShadow, known: Map<number, number>, snapshotTick: number, ships: KeyframeRow[], ctl: ControlRow[], out: { own?: number[][]; ownRebuild?: number }, synced?: (id: number) => number | undefined, causes = false): void {
    // (A contact whose other it can't have as the pass had it: rebuilt since, or a ship this client doesn't have)
    for (const e of o.events) {
      const c = e.contact;
      if (!c) continue;
      // (Rebuilt since, while its client still had it as it was: it keeps that structure when the new one comes, OTHER_BEFORE)
      const now = this.ships.get(c.other)?.rebuilds ?? -1;
      c.before = this.before(c, synced);
      if (!known.has(c.other) || (now !== c.rebuilds && !c.before)) { o.version--; this.ownWhy('contact: other not had'); break; }
    }
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
      const os = c && this.shadows.get(c.other), v = c && (causes ? c.cver : c.version);
      const rekeyed = !!c && (causes ? os?.cver : os?.version) !== v;
      const r = causeRow(e, snapshotTick, !!c && !!c.preStep && !rekeyed && known.get(c.other) === v);
      rows.push(r);
      this.ownStats.causes++;
      if (r[1] === OWN_CAUSE.PULL) this.ownStats.pull++;
      else if (r[1] === OWN_CAUSE.CONTACT) { this.ownStats.contact++; if (r.length > 4) this.ownStats.contactState++; }
      else { this.ownStats.rebuild++; out.ownRebuild = Math.max(out.ownRebuild ?? -Infinity, e.tick); }
    }
    out.own = rows;
  }
}
