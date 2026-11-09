/**
 * @contract server.replication
 * owns:       ship replication's state and its public face: every ship's shadow, keyframe versions, the snapshot window
 *             (beginSnapshot / endSnapshot), and the questions the snapshot path asks (keysFor, heldByte, versions)
 * needs:      ReplicationHost, ShipBridge, replication/{step, forClient, ownShip, workable, env, contactFx, types}
 * invariants: a ship's keyframe goes only when its shadow left the real ship — server/src/net/replication.test.ts
 *             bytes sent per client unchanged — server/src/golden/frameHash.test.ts
 *             tick order unchanged — tickOrder.json
 * extend:     the per-tick step is replication/step.ts; a client's share replication/forClient.ts; own ships replication/ownShip.ts
 *
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
  Position, Velocity, Rotation, ReplicaMode, packKeyframe, replicaHash, replicasByte,
  type FlightBody, type KeyframeRow, type ControlRow, type ReplicaEnv, type ServerContactMessage,
} from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';
import type { ContactWindow } from './causes/contactsFor.js';
import {
  newOwnStats, newCauseStats, newContactStats, newBodyStats,
  type ReplicationCore, type ReplicationHost, type Shadow, type Kept,
} from './replication/types.js';
import { endTick, work } from './replication/step.js';
import type { OwnCause } from '../ships/bridge/ownCauses.js';
import type { WorkedCauses } from './causes/shadowCauses.js';
import { forClient } from './replication/forClient.js';
import { ContactFx } from './replication/contactFx.js';

export type { ReplicationHost, Kept } from './replication/types.js';

export class Replication implements ReplicationCore {
  readonly shadows = new Map<number, Shadow>();
  /** Pairs of debris that knocked since the last snapshot (a client with one in view and not the other is off on it) */
  readonly knocks: [number, number][] = [];
  /** Keyframes sent (for the stats) */
  keyframes = 0;
  /** Why ships left their predicted path (for the stats) */
  readonly reasons: Record<string, number> = {};
  why(r: string): void { this.reasons[r] = (this.reasons[r] ?? 0) + 1; }
  /** Pilots' own ships (CAPS.OWN_SIM): causes told, keyframes of their own ship and why, exceptions rows */
  readonly ownStats = newOwnStats();
  /** Other ships' causes (CAPS.CAUSES): ticks a ship's were worked out, rows sent, contacts sent without state, keyframes for ones a client couldn't work out */
  readonly causeStats = newCauseStats();
  /**
   * Pullers whose clients' replicas weren't the real ship as a tick began (a shadow of it off: a keyframe due), by the
   * tick their fields acted on: no client works a pull of theirs out for that tick, it is told (forClient)
   */
  readonly pullOff = new Map<number, Set<number>>();
  /** Each client's last tick its pulls were judged through (forClient: by its `known` map, one per connection) */
  readonly pullsJudged = new WeakMap<object, number>();
  /** Contacts its clients found themselves (CAPS.CONTACTS): rows not sent (own rows, records' sides), ships left out */
  readonly contactStats = newContactStats();
  /** Bodies' clients' shadow of a ship its body flies (Shadow.bodied): stepped as their tick layer steps it */
  readonly bodyStats = newBodyStats();
  /** Docking Clamps' envs, one per host env (replication/env.ts) */
  readonly clampEnvs = new WeakMap<ReplicaEnv, ReplicaEnv>();
  /** Contacts' sparks lately (replication/contactFx.ts) */
  private readonly fx = new ContactFx(this.contactStats);

  /** A contact's sparks (GameServer notifyContact): every other client got them at once */
  noteContactFx(tick: number, sys: number, a: number, b: number, msg: ServerContactMessage): void {
    this.fx.noteContactFx(tick, sys, a, b, msg);
  }

  /** A CONTACTS client's sparks since it was last handed them: those of pairs it doesn't find itself (`found`: its window's) */
  contactFxFor(conn: object, sys: number, found: ContactWindow | null, now: number): ServerContactMessage[] {
    return this.fx.contactFxFor(conn, sys, found, now);
  }

  constructor(readonly host: ReplicationHost, readonly ships: ShipBridge) {}

  real(eid: number): FlightBody {
    const s = this.ships.get(eid)!;
    return { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], angle: Rotation.angle[eid], angVel: s.angVel, jump: s.jump, jumpScale: s.jumpScale, jumpAim: s.jumpAim, jumpTo: s.jumpTo, cargo: s.cargo, dodge: s.dodge, dodgeDir: s.dodgeDir };
  }

  /**
   * After the tick (bodies rounded): step every shadow and see whether it still matches (replication/step.ts)
   */
  endTick(): void {
    endTick(this);
  }

  /** One shadow's causes worked out for a tick (replication/step.ts) */
  work(eid: number, s: Shadow, causes: OwnCause[], tick: number): WorkedCauses | null {
    return work(this, eid, s, causes, tick);
  }

  /**
   * One client's share: keyframes for ships it's new to or behind on, control changes and causes for the rest
   * (replication/forClient.ts). `known` is the client's ship → keyframe version; `since` its last snapshot's tick
   */
  forClient(systemId: number, self: number, known: Map<number, number>, snapshotTick: number, view?: Set<number>, held?: ReadonlyMap<number, unknown>, synced?: (id: number) => number | undefined, bodies?: (id: number) => boolean, kept?: Kept, readers?: (ships: KeyframeRow[]) => Iterable<number>, live?: ReadonlySet<number>, since?: number, pins?: (id: number) => boolean | undefined): { ships: KeyframeRow[]; ctl: ControlRow[]; own?: number[][]; ownRebuild?: number; causes?: number[][]; caused?: number[]; found?: ContactWindow } {
    return forClient(this, systemId, self, known, snapshotTick, view, held, synced, bodies, kept, readers, live, since, pins);
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
  readonly goneCaused = new Map<number, number>();

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
        s.own.ctl = [];
      }
    }
  }

  ownWhy(w: string): void {
    this.ownStats.keyframes++;
    this.ownStats.why[w] = (this.ownStats.why[w] ?? 0) + 1;
  }

  /** A ship's controls on the last tick stepped (CAPS.OWN_SIM: what its client's own check hashes with its state) */
  controlsOf(eid: number): { bits: number; q: number } | null {
    const s = this.shadows.get(eid);
    return s ? { bits: s.bits, q: s.q } : null;
  }
}
