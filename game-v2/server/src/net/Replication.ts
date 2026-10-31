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
  replicaStep, replicaAngle, packKeyframe, packControlRow, flightSignature,
} from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';

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
}

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
}

const sameDock = (a: Shadow['dock'], b: Shadow['dock']) => (!a && !b) || (!!a && !!b && a.station === b.station && a.ox === b.ox && a.oy === b.oy);

export class Replication {
  private shadows = new Map<number, Shadow>();
  /** Keyframes sent (for the stats) */
  keyframes = 0;
  /** Why ships left their predicted path (for the stats) */
  readonly reasons: Record<string, number> = {};
  private why(r: string): void { this.reasons[r] = (this.reasons[r] ?? 0) + 1; }

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
      const dock = docks ? docks.get(eid) ?? null : this.host.dockOf(eid);
      const mode = dock ? ReplicaMode.Docked : rec?.mode ?? ReplicaMode.Pilotless;
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
      if (s.diverged || mode === ReplicaMode.Docked) continue;
      if (occupied && !occupied.has(InSystem.systemId[eid])) { s.diverged = true; continue; }
      replicaStep(mode, s.body, { bits, targetAngle: replicaAngle(mode, q) }, rec?.derived ?? ship.derived, this.ships.tuning, this.host.env(eid), tick);
      // (The real state, as real() has it, read in place: this runs for every ship every tick)
      const rx = Position.x[eid], ry = Position.y[eid], rvx = Velocity.x[eid], rvy = Velocity.y[eid], ra = Rotation.angle[eid];
      const b = s.body;
      if (b.x !== rx || b.y !== ry || b.vx !== rvx || b.vy !== rvy || b.angle !== ra || b.angVel !== ship.angVel
        || (b.jump ?? 0) !== (ship.jump ?? 0) || (b.jumpScale ?? 1) !== (ship.jumpScale ?? 1)
        // (The hold's mass: a load taken on or off needs a keyframe carrying it)
        || (b.cargo ?? 0) !== (ship.cargo ?? 0)
        // (A Burst Strafer's counter and way: strafer.ts)
        || (b.dodge ?? 0) !== (ship.dodge ?? 0) || (b.dodgeDir ?? 0) !== (ship.dodgeDir ?? 0)) {
        s.diverged = true;
        this.why(`${ReplicaMode[mode]}:${(b.cargo ?? 0) !== (ship.cargo ?? 0) ? 'cargo' : (b.dodge ?? 0) !== (ship.dodge ?? 0) || (b.dodgeDir ?? 0) !== (ship.dodgeDir ?? 0) ? 'dodge' : b.x !== rx || b.y !== ry ? 'pos' : b.vx !== rvx || b.vy !== rvy ? 'vel' : b.angle !== ra || b.angVel !== ship.angVel ? 'turn' : 'jump'}`);
      }
    }
    this.ships.replicaCtl.clear();
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
      if (!s.diverged) continue;
      s.diverged = false;
      s.version++;
      s.body = this.real(eid);
    }
  }

  /** After the snapshots: the control changes have been delivered */
  endSnapshot(): void {
    for (const s of this.shadows.values()) {
      if (s.events.length) s.events = [];
      s.qSent = s.q;
    }
  }

  /**
   * One client's share: keyframes for ships it's new to or behind on, control
   * changes for the rest. `known` is the client's ship → keyframe version.
   */
  forClient(systemId: number, self: number, known: Map<number, number>, snapshotTick: number, view?: Set<number>): { ships: KeyframeRow[]; ctl: ControlRow[] } {
    const ships: KeyframeRow[] = [];
    const ctl: ControlRow[] = [];
    for (const id of known.keys()) if (!this.shadows.has(id)) known.delete(id);
    for (const [eid, s] of this.shadows) {
      if (eid === self || InSystem.systemId[eid] !== systemId) continue;
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
    return { ships, ctl };
  }
}
