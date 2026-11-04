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
 */

import {
  Position, Velocity, Rotation, InSystem, FlightBody, ReplicaMode, ReplicaEnv, CTL, KeyframeRow, ControlRow,
  replicaStep, replicaAngle, packKeyframe, packControlRow, flightSignature, applyOwnCauses, quantizeShipBody, OWN_CAUSE, CONTACT_FLAG,
  type OwnCauseEnv, type ShipState,
} from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';
import type { OwnCause, OwnContact } from '../ships/bridge/ownCauses.js';

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

/** A cause its client is told, at its tick: the row as the server works it out (a contact with the other's state) */
interface OwnEvent {
  tick: number;
  /** [kind, ...] */
  row: number[];
  /** A contact: whether the client's replica of the other is the pass's (then the row goes without its state) */
  contact?: { other: number; inStep: boolean; version: number; rebuilds: number; before?: boolean };
}

/**
 * A pilot's own ship as its client steps it (CAPS.OWN_SIM). The shadow is then exactly that: stepped with the controls
 * the ship flew, and the causes of anything else that moved it worked out on it by the client's own function; only
 * what that still misses (`hard`: the client can't have it) costs it a keyframe of its own ship.
 */
interface OwnShadow {
  /** Its own keyframe version (what its client was last given of its own ship: counting down from -1, never one of the shared versions) */
  version: number;
  /** This window's causes */
  events: OwnEvent[];
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
  diverged: boolean;
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
}

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
        this.shadows.set(eid, { mode, body: this.real(eid), bits, q, version: 1, diverged: false, rebuilds: ship.rebuilds, sig: flightSignature(ship.derived), dock, events: [], qSent: q });
        continue;
      }
      if (mode !== s.mode || !sameDock(dock, s.dock)) { if (!s.diverged) this.why('mode'); s.diverged = true; s.mode = mode; s.dock = dock; }
      if (bits !== s.bits || q !== s.q) {
        s.bits = bits;
        s.q = q;
        s.events.push(tick, bits, q);
      }
      // A rebuild that changes how it flies: clients get the new structure with the next snapshot, so resend its state too
      if (ship.rebuilds !== s.rebuilds) {
        s.rebuilds = ship.rebuilds;
        const sig = flightSignature(ship.derived);
        if (sig !== s.sig) { if (!s.diverged) this.why('rebuild'); s.sig = sig; s.diverged = true; }
      }
      // A pilot whose client steps its own ship: its shadow is that, whatever the others need (stepOwn)
      if (ship.kind === 'ship' && this.host.ownSim?.(eid)) { this.stepOwn(eid, s, mode, bits, q, rec?.derived ?? ship.derived, tick, causes); continue; }
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
        this.why(`${ReplicaMode[mode]}:${(b.cargo ?? 0) !== (ship.cargo ?? 0) ? 'cargo' : (b.dodge ?? 0) !== (ship.dodge ?? 0) || (b.dodgeDir ?? 0) !== (ship.dodgeDir ?? 0) ? 'dodge' : b.x !== rx || b.y !== ry ? 'pos' : b.vx !== rvx || b.vy !== rvy ? 'vel' : b.angle !== ra || b.angVel !== ship.angVel ? 'turn' : 'jump'}`);
      }
    }
    this.ships.replicaCtl.clear();
    this.ships.ownCauses.clear();
    for (const pair of this.ships.debrisNet.pairs) this.knocks.push(pair);
    // Contacts this tick: whether a client's replica of the other was the contact pass's (stepped this tick, in step,
    // the very numbers): then the row needn't carry the other's state
    for (const s of this.shadows.values()) {
      const ev = s.own?.events;
      if (!ev) continue;
      for (let i = ev.length - 1; i >= 0 && ev[i].tick === tick; i--) {
        const c = ev[i].contact;
        if (!c) continue;
        const o = this.shadows.get(c.other), r = ev[i].row;
        c.version = o?.version ?? -1;
        c.inStep = !!o && !o.own && o.stepped === tick && o.body.x === r[3] && o.body.y === r[4] && o.body.angle === r[5] && o.body.vx === r[6] && o.body.vy === r[7];
      }
    }
  }

  /**
   * A pilot's own ship, as its client steps it (CAPS.OWN_SIM, network/ownTick.ts): its replica step with the controls
   * it flew, then this tick's causes worked out by the client's own function (applyOwnCauses) from what the server's
   * step had (the other body as the contact pass saw it). Then it is the real ship, or something moved it that its
   * client can't work out (`hard`): a keyframe of its own ship. The others get a keyframe as before whenever anything
   * but its controls moved it.
   */
  private stepOwn(eid: number, s: Shadow, mode: ReplicaMode, bits: number, q: number, derived: ShipState['derived'], tick: number, causes: OwnCause[] | undefined): void {
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
    if (causes?.length) {
      const rows: number[][] = [];
      const contacts = new Map<number, OwnContact>();
      let rebuilt: { from: [number, number]; to: [number, number] } | null = null, self: OwnContact['self'] | null = null;
      for (const c of causes) {
        if (c.kind === 0) rows.push([OWN_CAUSE.PULL, c.dvx, c.dvy]);
        else if (c.kind === 1) {
          if (contacts.has(c.other)) return hard('contact twice');
          contacts.set(c.other, c);
          self ??= c.self;
          rows.push([OWN_CAUSE.CONTACT, c.other, c.flags | CONTACT_FLAG.STATE, c.pre.x, c.pre.y, c.pre.angle, c.pre.vx, c.pre.vy]);
        } else {
          // (Two in a window: its client has only the last structure, not the one between)
          if (rebuilt || o.events.some((e) => e.row[0] === OWN_CAUSE.REBUILD)) return hard('rebuilt twice in a window');
          rebuilt = { from: [c.from[0], c.from[1]], to: [c.to[0], c.to[1]] };
          rows.push([OWN_CAUSE.REBUILD]);
        }
      }
      const env: OwnCauseEnv = {
        cellSize: this.ships.tuning.cellSize, restitution: this.ships.tuning.collision?.restitution ?? 0.3, self,
        other: (id) => { const c = contacts.get(id); return c ? { shape: c.otherShape, body: { ...c.pre } } : null; },
        rebuilt: () => rebuilt,
      };
      if (!applyOwnCauses(s.body, rows, env)) return hard('cause');
      for (const r of rows) {
        const c = r[0] === OWN_CAUSE.CONTACT ? contacts.get(r[1])! : null;
        o.events.push({ tick, row: r, contact: c ? { other: c.other, inStep: false, version: -1, rebuilds: c.otherRebuilds } : undefined });
      }
      // (The others' replicas of it: a keyframe, as ever)
      if (!s.diverged) this.why(`${ReplicaMode[mode]}:caused`);
      s.diverged = true;
    } else {
      quantizeOwn(s.body);
    }
    s.stepped = tick;
    const b = s.body, ship = this.ships.get(eid)!;
    if (b.x !== Position.x[eid] || b.y !== Position.y[eid] || b.vx !== Velocity.x[eid] || b.vy !== Velocity.y[eid] || b.angle !== Rotation.angle[eid] || b.angVel !== ship.angVel
      || (b.jump ?? 0) !== (ship.jump ?? 0) || (b.jumpScale ?? 1) !== (ship.jumpScale ?? 1) || (b.cargo ?? 0) !== (ship.cargo ?? 0)
      || (b.dodge ?? 0) !== (ship.dodge ?? 0) || (b.dodgeDir ?? 0) !== (ship.dodgeDir ?? 0)) {
      hard(causes?.length ? 'unexplained, with causes' : 'unexplained');
    }
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
      if (!s.diverged) continue;
      s.diverged = false;
      s.version++;
      s.body = this.real(eid);
    }
  }

  /** After the snapshots: the control changes have been delivered */
  endSnapshot(): void {
    this.knocks.length = 0;
    this.ships.debrisNet.clearTouched();
    for (const s of this.shadows.values()) {
      if (s.events.length) s.events = [];
      s.qSent = s.q;
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
  forClient(systemId: number, self: number, known: Map<number, number>, snapshotTick: number, view?: Set<number>, held?: ReadonlyMap<number, unknown>, own = false, synced?: (id: number) => number | undefined): { ships: KeyframeRow[]; ctl: ControlRow[]; own?: number[][]; ownRebuild?: number } {
    const ships: KeyframeRow[] = [];
    const ctl: ControlRow[] = [];
    const out: { own?: number[][]; ownRebuild?: number } = {};
    // Its own ship, stepped by itself (CAPS.OWN_SIM): this window's causes, the real controls only where its inputs
    // don't say them, and a keyframe only when it can't have its ship otherwise (first, before the others' versions move on)
    const mine = own && this.host.ownSim?.(self) ? this.shadows.get(self) : undefined;
    if (mine?.own && InSystem.systemId[self] === systemId && (!view || view.has(self))) this.ownFor(self, mine, mine.own, known, snapshotTick, ships, ctl, out, synced);
    for (const id of known.keys()) if (!this.shadows.has(id)) known.delete(id);
    // (Not sent its own: what it has of it goes stale, so it starts again from a keyframe when it is)
    if (!own) known.delete(self);
    // (A piece of debris knocked by one this client doesn't step, out of view or not had yet: what it has of it is off)
    if (view) {
      const steps = (x: number) => view.has(x) && (known.has(x) || !!held?.has(x));
      for (const [a, c] of this.knocks) { const sa = steps(a), sc = steps(c); if (sa !== sc) known.delete(sa ? a : c); }
    }
    for (const [eid, s] of this.shadows) {
      if ((eid === self && (!own || mine?.own)) || InSystem.systemId[eid] !== systemId) continue;
      // Debris it's working out itself (unconfirmed): nothing yet (SnapshotBuilder sends it all if it isn't confirmed)
      if (held?.has(eid)) continue;
      // Out of the client's view: nothing (and a keyframe when it comes back)
      if (view && !view.has(eid)) { known.delete(eid); continue; }
      if (known.get(eid) !== s.version) {
        known.set(eid, s.version);
        ships.push(s.keyRow ??= packKeyframe({ id: eid, mode: s.mode, body: this.real(eid), ctl: { bits: s.bits, targetAngle: 0 }, q: s.q, dock: s.dock ?? undefined }));
        this.keyframes++;
      } else if (s.events.length) {
        if (!s.ctlRow) {
          const events: [number, number, number][] = [];
          for (let i = 0; i < s.events.length; i += 3) events.push([snapshotTick - s.events[i], s.events[i + 1], s.events[i + 2]]);
          s.ctlRow = packControlRow(eid, events, s.qSent);
        }
        ctl.push(s.ctlRow);
      }
    }
    return { ships, ctl, ...out };
  }

  /** One pilot's own ship (CAPS.OWN_SIM): see forClient */
  private ownFor(eid: number, s: Shadow, o: OwnShadow, known: Map<number, number>, snapshotTick: number, ships: KeyframeRow[], ctl: ControlRow[], out: { own?: number[][]; ownRebuild?: number }, synced?: (id: number) => number | undefined): void {
    // (A contact whose other it can't have as the pass had it: rebuilt since, or a ship this client doesn't have)
    for (const e of o.events) {
      const c = e.contact;
      if (!c) continue;
      // (Rebuilt since, while its client still had it as it was: it keeps that structure when the new one comes, OTHER_BEFORE)
      const now = this.ships.get(c.other)?.rebuilds ?? -1, has = synced ? synced(c.other) : now;
      c.before = now !== c.rebuilds && has === c.rebuilds;
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
      const r = [snapshotTick - e.tick, ...e.row];
      const c = e.contact;
      // (Its replica of the other is what the contact pass had: the state stays out. Not on the snapshot's own tick if the
      // other gets a keyframe with it: that tick is then the keyframe's on the client, the other as the contact left it)
      const rekeyed = c && this.shadows.get(c.other)?.version !== c.version;
      if (c?.before) r[3] |= CONTACT_FLAG.OTHER_BEFORE;
      // (and not if it was rebuilt since: its client steps it with the new structure from its last keyframe on)
      if (c && c.inStep && !rekeyed && !c.before && known.get(c.other) === c.version) { r[3] &= ~CONTACT_FLAG.STATE; r.length = 4; }
      rows.push(r);
      this.ownStats.causes++;
      if (r[1] === OWN_CAUSE.PULL) this.ownStats.pull++;
      else if (r[1] === OWN_CAUSE.CONTACT) { this.ownStats.contact++; if (r.length > 4) this.ownStats.contactState++; }
      else { this.ownStats.rebuild++; out.ownRebuild = Math.max(out.ownRebuild ?? -Infinity, e.tick); }
    }
    out.own = rows;
  }
}
