/**
 * @contract server.game.tutorial
 * owns:       the training yard: its stationary drones, each pilot's own damage counters on them, marker events (rings, stop zones, jumps, docking), the boundary (trainees held in, everyone else
 *             kept out), leaving (skip or graduate: the starter pack and the one-way exit; a returner's own ship back instead, no pack) and the pilot's tutorialState
 * needs:      TutorialHost, Pilots (profiles, give, toast), common/tutorial, TutorialSteps
 * invariants: one pilot's hits never touch another's counter; the shared bodies never change (no hp loss, no movement);
 *             a pilot who has left is never placed in, or left in, the yard — server/src/game/tutorial/tutorial.test.ts
 * extend:     a new thing that happens in the yard is a TutorialEvent (common/tutorial/types.ts) emitted through
 *             `onEvent`; a new step is data (data/tutorial.json) plus a case in TutorialSteps
 */

import { Position, Velocity, InSystem, EffectType, registeredFunction, dhypot, dcos, dsin, objectLive, objectBroken, brokenIds, objectPos, inTutorial, leftTutorial, newTutorial, nextStep, TUTORIAL_PANELS, TUTORIAL_INDEX_BASE } from '@space-game/common';
import type { TutorialData, TutorialProfile, TutorialObjectDef, TutorialEvent, ServerMessage, ClientTutorialReportMessage, Bag } from '@space-game/common';
import type { PilotConn, Pilots } from '../Pilots.js';
import { TutorialSteps } from './TutorialSteps.js';

export interface TutorialHost {
  readonly data: TutorialData;
  tick(): number;
  send(conn: PilotConn, msg: ServerMessage): void;
  systemNum(id: string): number;
  /** Pilots flying right now (alive, in the world) */
  flying(): Iterable<{ conn: PilotConn; eid: number }>;
  /** Move a pilot (any system, at rest) */
  travel(conn: PilotConn, system: number, x: number, y: number): void;
  isJumping(eid: number): boolean;
  /** Let a docked pilot out (before moving them) */
  undock(conn: PilotConn): void;
  /** A stationary drone body in the shared sim at (x, y): its entity */
  createBody(index: number, def: TutorialObjectDef, x: number, y: number): number;
  /** The starter home station a graduate gets back (Sol Central) */
  starterHome(): string;
  /** A graduate's beginner jobs are handed out now (Quests.onLogin again) */
  openStarters(conn: PilotConn): void;
}

/** Spacing, in ticks, between boundary reminders to one pilot */
const BOUNDARY_COOLDOWN = 180;
/** The soft wall puts a pilot back this far inside the leash */
const EDGE_BACK = 600;

export class Tutorial {
  readonly data: TutorialData;
  readonly steps: TutorialSteps;
  /** Training bodies by entity, and the entity of each object id */
  private readonly byEid = new Map<number, TutorialObjectDef>();
  private readonly eidOf = new Map<string, number>();
  private readonly listeners: ((conn: PilotConn, ev: TutorialEvent) => void)[] = [];
  /** Per pilot entity: the markers they are inside now, the zones stopped in (ticks), whether the last tick was mid-jump */
  private readonly inside = new Map<number, Set<string>>();
  private readonly stopped = new Map<number, Map<string, number>>();
  private readonly jumping = new Set<number>();
  private readonly nudged = new Map<number, number>();

  constructor(private readonly host: TutorialHost, private readonly pilots: Pilots) {
    this.data = host.data;
    this.steps = new TutorialSteps(this);
    // A pilot who joins is told where they stand
    // (A pilot coming back to a step starts it over: the objects they broke ahead of it are whole again, nothing is granted twice)
    pilots.onEvent((conn, ev) => {
      if (ev.type !== 'login') return;
      const t = this.stateOf(conn);
      if (t && !t.left) this.steps.entered(conn, t.step, false);
      this.sendState(conn);
    });
  }

  // ------------------------------------------------------------ the yard's bodies

  /** Make the stationary drones (the world's start, after the yard's system has its belt). Idempotent */
  build(): void {
    if (this.byEid.size) return;
    this.data.objects.forEach((o, i) => {
      if (o.kind !== 'drone') return;
      const at = objectPos(this.data, o);
      const eid = this.host.createBody(TUTORIAL_INDEX_BASE + i, o, at.x, at.y);
      if (eid < 0) return;
      this.byEid.set(eid, o);
      this.eidOf.set(o.id, eid);
    });
  }

  /** The training object a body is, if it is one */
  objectOf(eid: number): TutorialObjectDef | undefined { return this.byEid.get(eid); }
  isBody(eid: number): boolean { return this.byEid.has(eid); }
  entityOf(objectId: string): number | undefined { return this.eidOf.get(objectId); }
  def(id: string): TutorialObjectDef | undefined { return this.data.objects.find((o) => o.id === id); }

  // ------------------------------------------------------------ who is in training

  /** The connection of a pilot entity */
  pilotOf(pid: number): PilotConn | undefined { return this.pilots.connOf(pid); }
  /** A pilot's saved tutorial progress */
  stateOf(conn: PilotConn): TutorialProfile | undefined { return this.pilots.get(conn)?.tutorial; }

  /** Is this pilot in the tutorial now? */
  active(conn: PilotConn): boolean {
    return inTutorial(this.pilots.get(conn)?.tutorial);
  }

  /** Where a pilot in the tutorial appears: where they left off in the yard (`resume`) or a fresh spot by its station; none if they are not in it */
  spawnFor(conn: PilotConn, resume: boolean): { system: number; x: number; y: number } | null {
    const p = this.pilots.get(conn);
    if (!p || !inTutorial(p.tutorial)) return null;
    const y = this.data.yard, system = this.host.systemNum(y.system);
    if (system < 0) return null;
    if (resume && p.position.system === y.system && dhypot(p.position.x - y.center.x, p.position.y - y.center.y) <= y.leash) return { system, x: p.position.x, y: p.position.y };
    const a = (conn.playerId * 2.399) % (Math.PI * 2);
    return { system, x: y.center.x + dcos(a) * y.spawnRadius, y: y.center.y + dsin(a) * y.spawnRadius };
  }

  // ------------------------------------------------------------ hits

  /**
   * A shot or beam from `shooter` hit a body. Returns true when the body is a training object: the caller then does
   * nothing else to it (no hp loss, no mining), the damage having been counted here for that pilot alone.
   */
  hit(eid: number, shooter: number, damage: number): boolean {
    const o = this.byEid.get(eid);
    if (!o) return false;
    const conn = this.pilots.connOf(shooter);
    const p = conn && this.pilots.get(conn);
    if (!conn || !p || !(damage > 0) || !o.hp || !objectLive(p.tutorial, o) || this.ahead(p.tutorial, o)) return true;
    const hits = (p.tutorial.hits ??= {});
    hits[o.id] = Math.min(o.hp, (hits[o.id] ?? 0) + damage);
    this.pilots.markDirty(conn);
    if (objectBroken(p.tutorial, o)) this.broke(conn, o);
    return true;
  }

  /** Is the object's step one this pilot has not reached? (It is hidden from them: it counts nothing, though it still collides) */
  private ahead(t: TutorialProfile, o: TutorialObjectDef): boolean {
    const at = this.data.steps.findIndex((s) => s.id === o.step), now = this.data.steps.findIndex((s) => s.id === t.step);
    return at >= 0 && now >= 0 && at > now;
  }

  /** The pilot's counter on an object reached its hp: it breaks for them alone */
  private broke(conn: PilotConn, o: TutorialObjectDef): void {
    const eid = this.eidOf.get(o.id);
    if (eid === undefined) return;
    const at = objectPos(this.data, o);
    // The break is shown to them only
    this.host.send(conn, { type: 'effect', effectType: EffectType.AsteroidBreak, x: Math.round(at.x), y: Math.round(at.y), data: [o.radius, 30] });
    this.sendState(conn);
    this.onEvent(conn.playerId, { kind: 'objectBroken', object: o.id, step: o.step });
  }

  /** Zero this pilot's counters on a step's objects (the step engine does it when a step starts, so objects they broke ahead of time can be done properly) */
  resetObjects(conn: PilotConn, step: string): void {
    const t = this.pilots.get(conn)?.tutorial;
    if (!t?.hits) return;
    for (const o of this.data.objects) if (o.step === step) delete t.hits[o.id];
    if (!Object.keys(t.hits).length) delete t.hits;
    this.pilots.markDirty(conn);
  }

  // ------------------------------------------------------------ events

  /** Hear every event (the step engine and other modules) */
  subscribe(fn: (conn: PilotConn, ev: TutorialEvent) => void): void { this.listeners.push(fn); }

  /** Something happened to a pilot in the yard. Ignored for pilots not in the tutorial */
  onEvent(pid: number, ev: TutorialEvent): void {
    const conn = this.pilots.connOf(pid);
    if (!conn || !this.active(conn)) return;
    this.steps.advance(pid, ev);
    for (const fn of this.listeners) fn(conn, ev);
  }

  /** The pilot docked (Docking.handleDock) */
  docked(conn: PilotConn, station: string): void {
    this.onEvent(conn.playerId, { kind: 'docked', station });
  }

  /** The client reported something only it can see (tutorialReport) */
  report(conn: PilotConn, msg: ClientTutorialReportMessage): void {
    const t = this.pilots.get(conn)?.tutorial;
    if (!t || t.left) return;
    if (msg.kind === 'ack') {
      if (msg.step !== undefined && msg.step !== t.step) return;
      this.onEvent(conn.playerId, { kind: 'ack', step: t.step });
    } else if (msg.kind === 'panel' && typeof msg.panel === 'string' && (TUTORIAL_PANELS as readonly string[]).includes(msg.panel)) {
      this.onEvent(conn.playerId, { kind: 'panelOpened', panel: msg.panel });
    }
  }

  // ------------------------------------------------------------ steps

  /** Mark a step done and move the pilot on to the next (the step engine's one way to advance) */
  completeStep(conn: PilotConn, id: string): void {
    const p = this.pilots.get(conn);
    if (!p || p.tutorial.left || p.tutorial.step !== id) return;
    const t = p.tutorial;
    if (!t.done.includes(id)) t.done.push(id);
    const next = nextStep(this.data, id);
    t.step = next ?? id;
    this.pilots.markDirty(conn);
    if (next) this.steps.entered(conn, next, true);
    this.sendState(conn);
    // (A step is progress worth keeping at once: a server restarted or killed now resumes the pilot here)
    this.pilots.saveNow(conn);
  }

  /** Put a step's grant in the pilot's storage */
  grant(conn: PilotConn, items: Bag): void {
    this.pilots.give(conn, { ...items }, { toStorage: true, source: 'tutorial', quiet: true });
    this.pilots.toast(conn, 'Training gear added to your storage.', 'info');
    this.pilots.sendItems(conn);
  }

  /** Put a step's holdGrant in the pilot's hold (what the field fabricator builds from); what does not fit goes to storage */
  grantHold(conn: PilotConn, items: Bag): void {
    const left = this.pilots.give(conn, { ...items }, { source: 'tutorial', quiet: true });
    if (Object.keys(left).length) this.pilots.give(conn, left, { toStorage: true, source: 'tutorial', quiet: true });
    this.pilots.toast(conn, Object.keys(left).length ? 'Training gear added (some to your storage: your hold is full).' : 'Training gear added to your hold.', 'info');
    this.pilots.sendItems(conn);
  }

  /** The server tick (the step engine's timers) */
  nowTick(): number { return this.host.tick(); }

  /** Forget which markers the pilot is inside, so one they stand in counts when its step comes */
  rearm(pid: number): void { this.clearPilot(pid); }

  // ------------------------------------------------------------ what other modules saw

  /** The pilot's hold took in items (a pod's contents): the mining lesson counts them */
  collected(conn: PilotConn, taken: Bag): void {
    if (!this.active(conn)) return;
    for (const [item, n] of Object.entries(taken)) if (n > 0) this.onEvent(conn.playerId, { kind: 'collected', item, n });
  }

  /** How many of `items` (anything, if none are named) the pilot has in the hold */
  held(conn: PilotConn, items?: string[]): number {
    let n = 0;
    for (const s of this.pilots.get(conn)?.cargo ?? []) if (!items || items.includes(s.id)) n += s.n;
    return n;
  }

  /** Ore finished going through the refinery (`used`: ore id -> units) */
  refined(conn: PilotConn, used: Bag): void {
    if (!this.active(conn)) return;
    const item = Object.keys(used)[0];
    if (item) this.onEvent(conn.playerId, { kind: 'refined', item });
  }

  /**
   * A hangar save added parts to a design. `built`: the part was paid for (not a ghost). Placing any part is the hangar
   * lesson; a built part that makes power is the power lesson. Only the active ship counts (it is the one that flies).
   */
  partsPlaced(conn: PilotConn, parts: { fn: string; built: boolean }[]): void {
    if (!this.active(conn) || !parts.length) return;
    this.onEvent(conn.playerId, { kind: 'partPlaced', fn: parts[0].fn });
    if (parts.some((q) => q.built && (registeredFunction(q.fn)?.produce ?? 0) > 0)) this.onEvent(conn.playerId, { kind: 'powered' });
  }

  /** A world build plan was saved (field fabrication): `added` parts are new in the design */
  fieldPlanned(eid: number, added: number): void {
    if (added > 0) this.onEvent(eid, { kind: 'fieldPlanned', n: added });
  }

  /** The pilot's field fabricator finished a part onto their ship */
  fieldBuilt(eid: number, fn: string): void { this.onEvent(eid, { kind: 'fieldBuilt', fn }); }

  // ------------------------------------------------------------ leaving

  /**
   * Leave training: skip at any step, or graduate. Grants the starter pack, moves the pilot out of the yard to Sol's normal start (beside Sol Central) and
   * marks them left for good (the yard is then unreachable for them). Does nothing for a pilot who has already left.
   */
  leave(conn: PilotConn): boolean {
    const p = this.pilots.get(conn);
    if (!p || p.tutorial.left) return false;
    if (this.pilots.isAway(conn)) return this.leaveVisit(conn);
    const pack = this.data.starterPack;
    const done = p.tutorial.done;
    p.tutorial = leftTutorial(done);
    this.clearPilot(conn.playerId);
    this.steps.forget(conn.playerId);
    p.home = this.host.starterHome();
    this.pilots.give(conn, { ...pack.items }, { toStorage: true, source: 'tutorial', quiet: true });
    if (pack.credits > 0) this.pilots.addCredits(conn, pack.credits);
    if (conn.docked) this.host.undock(conn);
    const spot = this.pilots.homePoint(conn);
    if (spot) this.host.travel(conn, spot.system, spot.x, spot.y);
    this.host.openStarters(conn);
    this.pilots.toast(conn, 'You have left training. Your starter pack is in storage, and Sol is open.', 'good');
    this.pilots.markDirty(conn);
    this.pilots.sendProfile(conn);
    this.pilots.sendItems(conn);
    this.sendState(conn);
    this.pilots.saveNow(conn);
    return true;
  }

  /**
   * A returning pilot (saved before the yard) leaves: skipped at any step or graduated, the same. Nothing the yard gave stays and no starter pack
   * comes: their own ship and state are back exactly as they were (Pilots.endVisit), where they were, and the yard is closed to them for good.
   */
  private leaveVisit(conn: PilotConn): boolean {
    this.clearPilot(conn.playerId);
    this.steps.forget(conn.playerId);
    if (conn.docked) this.host.undock(conn);
    if (!this.pilots.endVisit(conn)) return false;
    this.pilots.toast(conn, 'Back in your own ship, just as you left it.', 'good');
    this.sendState(conn);
    this.pilots.saveNow(conn);
    return true;
  }

  /**
   * Put a pilot back into training (the admin `/tutorial reset|step` command, for re-testing): at the first step, or at
   * `at` with every step before it marked done. Moves them to the yard. False: no such step, or no profile/yard.
   */
  restart(conn: PilotConn, at?: string): boolean {
    const p = this.pilots.get(conn);
    const steps = this.data.steps;
    const i = at ? steps.findIndex((s) => s.id === at) : 0;
    if (!p || i < 0 || !steps.length) return false;
    p.tutorial = { ...newTutorial(), step: steps[i].id, done: steps.slice(0, i).map((s) => s.id) };
    this.clearPilot(conn.playerId);
    this.steps.forget(conn.playerId);
    if (conn.docked) this.host.undock(conn);
    const spot = this.spawnFor(conn, false);
    if (spot) this.host.travel(conn, spot.system, spot.x, spot.y);
    this.steps.entered(conn, steps[i].id, true);
    this.pilots.markDirty(conn);
    this.sendState(conn);
    this.pilots.saveNow(conn);
    return true;
  }

  private clearPilot(eid: number): void {
    this.inside.delete(eid);
    this.stopped.delete(eid);
    this.jumping.delete(eid);
    this.nudged.delete(eid);
  }

  // ------------------------------------------------------------ state

  /** This pilot's tutorial state, to them alone */
  sendState(conn: PilotConn): void {
    const t = this.pilots.get(conn)?.tutorial;
    if (!t) return;
    const got = t.left ? undefined : this.steps.gotOf(conn.playerId, t.step);
    this.host.send(conn, { type: 'tutorialState', step: t.left ? '' : t.step, done: [...t.done], left: t.left, broken: t.left ? [] : brokenIds(t, this.data), passed: t.left ? [] : this.steps.passedOf(conn.playerId, t.step), ...(got !== undefined ? { got } : {}), ...(t.returner && !t.left ? { returner: true } : {}) });
  }

  // ------------------------------------------------------------ the tick

  /** Once a tick: markers, jumps, and the yard's boundary */
  tick(): void {
    this.steps.tick();
    const y = this.data.yard;
    const system = this.host.systemNum(y.system);
    const now = this.host.tick();
    for (const { conn, eid } of this.host.flying()) {
      if (InSystem.systemId[eid] !== system) { this.clearPilot(eid); continue; }
      const px = Position.x[eid], py = Position.y[eid];
      const d = dhypot(px - y.center.x, py - y.center.y);
      const p = this.pilots.get(conn);
      if (!p) continue;
      if (!inTutorial(p.tutorial)) {
        // A pilot who has left (or never was in it) is kept out of the yard: all of it is the trainees'
        if (!conn.docked) this.turnAway(conn, eid, now);
        continue;
      }
      if (d > y.leash) { this.edge(conn, eid, px, py, d, now); continue; }
      if (conn.docked) continue;
      this.markers(conn, eid, px, py);
      this.jumps(conn, eid, px, py);
    }
  }

  /**
   * A trainee at the yard's edge: a soft wall. They are stopped just inside (never out of the system by crossing a
   * boundary), and the client is asked once in a while whether to leave training (Leave = the Leave training button,
   * Stay or no answer = nothing)
   */
  private edge(conn: PilotConn, eid: number, px: number, py: number, d: number, now: number): void {
    const y = this.data.yard, k = Math.max(0, y.leash - EDGE_BACK) / d;
    this.host.travel(conn, this.host.systemNum(y.system), y.center.x + (px - y.center.x) * k, y.center.y + (py - y.center.y) * k);
    if ((this.nudged.get(eid) ?? -Infinity) > now - BOUNDARY_COOLDOWN) return;
    this.nudged.set(eid, now);
    this.host.send(conn, { type: 'tutorialEdge' });
    this.pilots.toast(conn, 'Use Leave training to leave the yard.', 'info');
  }

  /** A pilot who is not in training is in the yard: out to where they belong */
  private turnAway(conn: PilotConn, eid: number, now: number): void {
    if ((this.nudged.get(eid) ?? -Infinity) > now - BOUNDARY_COOLDOWN) return;
    this.nudged.set(eid, now);
    const spot = this.pilots.homePoint(conn);
    if (!spot) return;
    this.host.travel(conn, spot.system, spot.x, spot.y);
    this.pilots.toast(conn, 'The training yard is closed to you.', 'info');
  }

  /** Rings passed and zones stopped in */
  private markers(conn: PilotConn, eid: number, px: number, py: number): void {
    const t = this.pilots.get(conn)!.tutorial;
    let inside = this.inside.get(eid);
    if (!inside) this.inside.set(eid, (inside = new Set()));
    const speed = dhypot(Velocity.x[eid], Velocity.y[eid]);
    for (const o of this.data.objects) {
      if (o.kind !== 'ring' && o.kind !== 'zone') continue;
      const at = objectPos(this.data, o);
      const within = dhypot(px - at.x, py - at.y) <= o.radius && objectLive(t, o);
      if (!within) { inside.delete(o.id); this.stopped.get(eid)?.delete(o.id); continue; }
      if (o.kind === 'ring') {
        if (!inside.has(o.id)) { inside.add(o.id); this.onEvent(eid, { kind: 'ringPassed', ring: o.id, step: o.step }); }
        continue;
      }
      // A zone: slow enough for long enough, once per visit
      let zs = this.stopped.get(eid);
      if (!zs) this.stopped.set(eid, (zs = new Map()));
      if (speed >= this.data.yard.stopSpeed) { zs.set(o.id, 0); inside.delete(o.id); continue; }
      if (inside.has(o.id)) continue;
      const n = (zs.get(o.id) ?? 0) + 1;
      zs.set(o.id, n);
      if (n >= this.data.yard.stopTicks) { inside.add(o.id); this.onEvent(eid, { kind: 'zoneStopped', zone: o.id, step: o.step }); }
    }
  }

  /** A jump finishing (the burn ending) */
  private jumps(conn: PilotConn, eid: number, px: number, py: number): void {
    const burning = this.host.isJumping(eid);
    if (burning) { this.jumping.add(eid); return; }
    if (!this.jumping.delete(eid)) return;
    let exit: string | undefined;
    for (const o of this.data.objects) {
      if (o.kind !== 'exit') continue;
      const at = objectPos(this.data, o);
      if (dhypot(px - at.x, py - at.y) <= o.radius) exit = o.id;
    }
    this.onEvent(eid, { kind: 'jumped', x: Math.round(px), y: Math.round(py), exit });
  }

  /** A pilot's connection ended: forget the per-pilot bookkeeping */
  forget(conn: PilotConn): void { this.clearPilot(conn.playerId); this.steps.forget(conn.playerId); }
}

