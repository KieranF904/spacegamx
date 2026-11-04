/**
 * Simulation level of detail for pilotless ships.
 *
 * Every pilotless ship (hostile packs, bosses, wards, traffic, derelicts,
 * people's craft) is in one of two tiers:
 *
 *   live     the whole pipeline (ShipBridge.tick): its AI, flight, guns,
 *            shields, contacts, hits.
 *   distant  out of all of that. It flies a route worked out by time: a leg
 *            at a time (common ships/farRoute.ts: a straight course at its own
 *            measured cruise speed, at its pace, the turns rounded off by the
 *            velocity it had), each planned once, when the last ends, from
 *            what it's doing (its Intent: flying to a point at a pace,
 *            holding station, drifting, keeping its place in a loose pack).
 *            Where it is is only worked out when something needs it: the
 *            map's dots, a look for pilots nearing, a wake. The same route
 *            gives the same place however often it's asked (each ship rolls
 *            its own dice for its turns). Nothing hits it and it hits
 *            nothing; every part, its shield, battery, heat and guns'
 *            cooldowns are kept as they were (ShipBridge.wake catches them up).
 *
 * A distant ship goes live the moment a pilot comes within PROMOTE_RADIUS of
 * it (past the furthest a client sees ships, SHIP_VIEW_OUT, plus a margin):
 * it's live and flying before any client can see it, and long before it
 * could pick a fight (aggro ranges are a few thousand). It's looked at again
 * when a pilot could next have got there (its distance from the nearest, at
 * its speed and OBSERVER_SPEED for theirs; at most MAX_CHECK apart, so what
 * reads its components is never far behind), and at once in a system where a
 * pilot has just arrived or moved faster than that (a gate, a jump). A pilot
 * spooling a jump counts along the whole of its reach, so ships where it
 * lands are woken while it charges. A live ship goes distant once no pilot
 * has been within DEMOTE_RADIUS of it for DEMOTE_AFTER (the gap is the
 * hysteresis), never while it's busy: fighting, hurt or shooting lately,
 * EMP'd, burning, under repair, mid-jump, a ward while its system is occupied,
 * a boss mid-move (ShipBridge.sleepBlocker and the host's `busy`). In a system
 * nobody is in, everything that isn't busy goes distant at the next check
 * (and a remembered system's are taken out altogether: game/SystemMemory.ts).
 */

import {
  InSystem, Position, Velocity, Rotation, FRICTION, BOOST_FACTOR, WORLD_SIZE, CARRY,
  stepFlight, FULL_CHARGE, legAt, legFrom, legTo, legArrival, coastLeg, nextSeed, MIN_LEG, PATROL_ARRIVE,
  patrolOf, patrolPoint, patrolFrom, patrolNext,
  type Leg, type Motion, type Patrol, type PatrolState, type ShipDerived, type ShipState, type Blueprint, type ShipTuning, datan2, dcos, dhypot, dsin,
} from '@space-game/common';
import type { ShipBridge } from './ShipBridge.js';
import { SimPass } from '../sim/SystemClocks.js';

/** What a pilotless ship is doing, as far as a distant one needs to know */
export type Intent =
  /** Fly to a point and stop within `arrive`; thrusting `pace` of the time (packs cruise in pulses; 0: coasting); thought again by `until` */
  | { kind: 'goto'; x: number; y: number; arrive: number; pace?: number; until?: number }
  /**
   * Patrolling round a home that stays put, point to point (`wp` first) at
   * `pace`, for as long as nothing changes (its orders: replan): its points
   * are rolled by its own dice (common farRoute.ts Patrol), so the map is told
   * it once and works out the rest
   */
  | { kind: 'patrol'; x: number; y: number; roam: number; pace?: number; wp?: { x: number; y: number } }
  /** Engines off: it coasts to a stop and keeps its heading (until `until`, if it says) */
  | { kind: 'hold'; until?: number }
  /** A wreck: it coasts and keeps turning */
  | { kind: 'drift' }
  /** Fixed where it stands (a structure) */
  | { kind: 'fixed' }
  /** Keeping its place in a pack that moves as one: its lead's way, this far off it */
  | { kind: 'follow'; lead: number; dx: number; dy: number };

/**
 * Where a distant ship is when it's asked what it's doing next, at the tick
 * its last leg ends (a planner works from this, not from its components:
 * they're only written now and then), and its own dice
 */
export interface Plan { tick: number; x: number; y: number; vx: number; vy: number; rng: () => number }

export interface LodHost {
  tick(): number;
  /**
   * Where pilots are, by system: only systems someone is in. Each entry is a
   * segment [x0, y0, x1, y1] (a pilot where it is: x1 = x0, y1 = y0; one
   * spooling a jump: from where it is out along the jump's reach)
   */
  observers(): Map<number, number[]>;
  /**
   * What a ship is doing, coarsely, from `at`. null: it can't be flown
   * cheaply now (it stays live, or wakes); undefined: nothing in particular
   * (the bridge's own then: its autopilot, a wreck's drift, holding still)
   */
  intent?(eid: number, at: Plan): Intent | null | undefined;
  /** Mustn't go distant now (fighting, a ward while its system's occupied, a boss mid-move) */
  busy?(eid: number): boolean;
  /** Ships that must be live wherever they are (pilots' selected targets) */
  watched?(): Set<number>;
}

/** Furthest a client sees ships (GameServer SHIP_VIEW_OUT) and the margin past it a distant ship wakes at */
export const PROMOTE_RADIUS = 48000 + 4000;
/** No pilot within this for DEMOTE_AFTER ticks, a ship goes distant */
export const DEMOTE_RADIUS = 64000;
export const DEMOTE_AFTER = 60 * 10;
/** How often live ships are looked at for going distant (ticks) */
export const DEMOTE_CHECK = 30;
/** "Lately", for ShipBridge.sleepBlocker: hurt within this, or shooting */
export const RECENT = { damaged: 60 * 10, fired: 60 * 5 };
/** A distant ship is looked at (and its components written) at least this often, ticks */
export const MAX_CHECK = 60 * 10;
/** The fastest a pilot is taken to close on a far ship between looks (world units a tick); faster, its system is looked over at once */
export const OBSERVER_SPEED = 80;
/** A leg with no end of its own is thought again after this (ticks) */
const REASK = 60 * 10;
/** Most legs a ship is caught up by in one go (a long absence is capped before this: SystemMemory) */
const MAX_LEGS = 5000;

/** A design's cruise speed (world units a tick, engines full on) and turn rate (radians a tick) */
export interface Cruise { speed: number; turn: number }

const K = { friction: FRICTION, boostFactor: BOOST_FACTOR, worldSize: WORLD_SIZE };

/**
 * Its cruise speed and turn rate, measured once by flying it (stepFlight, no
 * gravity): full thrust from rest until it stops gaining, and a quarter turn
 * from still. Cached by blueprint and what changes how it flies.
 */
const cruiseCache = new WeakMap<Blueprint, Map<string, Cruise>>();
/** (and by the structure itself: a rebuild makes a new one) */
const byDerived = new WeakMap<ShipDerived, Cruise>();
export function cruiseOf(ship: ShipState, tuning: ShipTuning): Cruise {
  const d = ship.derived;
  const known = byDerived.get(d);
  if (known) return known;
  let byBp = cruiseCache.get(ship.blueprint);
  if (!byBp) cruiseCache.set(ship.blueprint, (byBp = new Map()));
  const key = `${d.mass.toFixed(1)}:${d.drive.toFixed(3)}:${d.turn ?? 0}`;
  let c = byBp.get(key);
  if (!c) byBp.set(key, (c = measureCruise(d, tuning)));
  byDerived.set(d, c);
  return c;
}

function measureCruise(d: ShipDerived, tuning: ShipTuning): Cruise {
  if (!(d.mass > 0)) return { speed: 0, turn: 0 };
  const up = -Math.PI / 2;
  const boost = { charge: FULL_CHARGE, drainRate: 0 };
  const body = { x: 0, y: 0, vx: 0, vy: 0, angle: up, angVel: 0, jump: 0 };
  const go = { forward: true, backward: false, left: false, right: false, boost: false, targetAngle: up };
  let speed = 0;
  for (let i = 0; i < 1200; i++) {
    stepFlight(body, go, d, tuning, boost, K);
    const s = dhypot(body.vx, body.vy);
    if (i > 60 && s - speed < 1e-4) { speed = s; break; }
    speed = s;
  }
  const turnBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0, jump: 0 };
  const hold = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: Math.PI / 2 };
  let ticks = 0;
  for (; ticks < 1200; ticks++) {
    stepFlight(turnBody, hold, d, tuning, boost, K);
    if (Math.abs(turnBody.angle - Math.PI / 2) < 0.05) break;
  }
  return { speed, turn: (Math.PI / 2) / Math.max(1, ticks + 1) };
}

const wrap = (a: number) => datan2(dsin(a), dcos(a));

/** Squared distance from a point to a segment */
function segDist2(px: number, py: number, s: number[], i: number): number {
  const x0 = s[i], y0 = s[i + 1], dx = s[i + 2] - x0, dy = s[i + 3] - y0;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0;
  const ex = px - (x0 + dx * t), ey = py - (y0 + dy * t);
  return ex * ex + ey * ey;
}

/** How far the nearest observer is from (x, y) */
function nearest(obs: number[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < obs.length; i += 4) best = Math.min(best, segDist2(x, y, obs, i));
  return Math.sqrt(best);
}

/** Where a distant ship is: a place and velocity, its heading and spin */
export interface FarPose extends Motion { angle: number; angVel: number }

/** A distant ship's route: the leg it's on and when it ends, its heading on it, when it's next looked at */
interface Far {
  /** Its leg, from tick t0 */
  t0: number;
  leg: Leg;
  /** Its heading at t0, the way it's coming round to at `turn` (radians a tick); a wreck's spin instead */
  a0: number;
  aim: number;
  turn: number;
  spin: number;
  /** The tick this leg ends (what it does next is planned then), and its next look for pilots */
  end: number;
  check: number;
  /** Its route's number (a new one when what it's doing changes, not with a patrol's every leg: the map's dots are resent then) */
  seq: number;
  /** Its dice */
  seed: number;
  /** The fastest it goes on this leg (for when it's next looked at) */
  speed: number;
  /** On patrol: its legs come one from the last without asking (patrolNext) */
  patrol?: { p: Patrol; s: PatrolState };
}

export interface LodStats {
  live: number;
  distant: number;
  promoted: number;
  demoted: number;
  /** Legs planned, and looks for pilots nearing, since the start */
  legs: number;
  looks: number;
  /** Why ships that could have gone distant stayed live, at the last check */
  blocked: Record<string, number>;
}

export class SimLod {
  /** Off: every ship stays live (the old behaviour; the bench's --no-lod) */
  enabled = true;
  /** Last tick a pilot was within DEMOTE_RADIUS of each live pilotless ship */
  private seen = new Map<number, number>();
  /** Each distant ship's route */
  private far = new Map<number, Far>();
  /** Last tick's observers (a system's are looked over again when they jump) */
  private lastObs = new Map<number, number[]>();
  private counts = { promoted: 0, demoted: 0, legs: 0, looks: 0 };
  /** Routes planned (each its own number: the map resends a dot when its route's changes) */
  private routes = 0;
  private blocked: Record<string, number> = {};

  constructor(private host: LodHost, private ships: ShipBridge) {}

  /** Once a tick, before ShipBridge.tick: wake what's come into range, put to sleep what's long out of it, plan the legs that are due */
  tick(): void {
    const now = this.host.tick();
    const dormant = this.ships.dormantShips();
    if (!this.enabled) {
      for (const eid of [...dormant.keys()]) this.wake(eid);
      return;
    }
    const obs = this.host.observers();
    const watched = this.host.watched?.();
    const jumped = this.jumped(obs);

    // Sleep: what nobody's been near for a while (everything, where nobody is), unless it's busy
    if (now % DEMOTE_CHECK === 0) {
      this.blocked = {};
      for (const id of this.seen.keys()) if (!this.ships.has(id) || dormant.has(id)) this.seen.delete(id);
      for (const id of this.far.keys()) if (!dormant.has(id)) this.far.delete(id);
      for (const [eid, ship] of this.ships.bodies) {
        if (dormant.has(eid) || ship.kind !== 'ship' || !SimPass.on(InSystem.systemId[eid])) continue;
        const o = obs.get(InSystem.systemId[eid]);
        if (o && (watched?.has(eid) || nearest(o, Position.x[eid], Position.y[eid]) < DEMOTE_RADIUS + ship.derived.radius)) { this.seen.set(eid, now); continue; }
        if (!this.seen.has(eid)) this.seen.set(eid, now);
        // (A system nobody's in: at once)
        if (o && now - this.seen.get(eid)! < DEMOTE_AFTER) continue;
        const why = this.ships.sleepBlocker(eid, RECENT) ?? (this.host.busy?.(eid) ? 'busy' : this.intentOf(eid, this.here(eid, now)) ? null : 'no intent');
        if (why) { if (why !== 'pilot') this.blocked[why] = (this.blocked[why] ?? 0) + 1; continue; }
        if (this.ships.sleep(eid, RECENT)) { this.counts.demoted++; this.seen.delete(eid); this.adopt(eid, now); }
      }
    }

    // A pilot's selected target is live wherever it is
    if (watched) for (const eid of watched) if (dormant.has(eid)) this.wake(eid);

    // The distant: plan the legs that have ended, look for pilots where they're due (or the system's had someone arrive)
    for (const [eid] of dormant) {
      // (Another pass's: crowd dilation, sim/SystemClocks.ts)
      if (!SimPass.on(InSystem.systemId[eid])) continue;
      const ship = this.ships.get(eid);
      if (!ship) { this.far.delete(eid); continue; }
      const far = this.far.get(eid) ?? this.adopt(eid, now);
      if (!far || !this.advance(eid, far, now)) continue;
      const sys = InSystem.systemId[eid];
      if (far.check > now && !jumped.has(sys)) continue;
      const o = obs.get(sys);
      const p = this.at(far, now);
      this.ships.moveDistant(eid, p);
      this.counts.looks++;
      if (!o) { far.check = Infinity; continue; }
      const gap = nearest(o, p.x, p.y) - (PROMOTE_RADIUS + ship.derived.radius);
      if (gap <= 0) { this.wake(eid); continue; }
      far.check = now + Math.max(1, Math.min(MAX_CHECK, Math.floor(gap / (far.speed + OBSERVER_SPEED))));
    }
  }

  /**
   * Take on a ship that's just gone distant: its route from `from` (its
   * components unless told where it was; a remembered system's ships come
   * back with where they were when it was left, and are caught up from then:
   * game/SystemMemory.ts). The ship must be asleep (ShipBridge.sleep).
   */
  adopt(eid: number, from = this.host.tick(), pose?: FarPose): Far | undefined {
    const ship = this.ships.get(eid);
    if (!ship || !this.ships.isDormant(eid)) return undefined;
    const p = pose ?? this.here(eid, from);
    const far: Far = {
      t0: from, leg: coastLeg(p), a0: p.angle, aim: p.angle, turn: 0, spin: p.angVel, end: from, check: this.host.tick(), seq: 0,
      seed: (Math.imul(eid, 0x9e3779b1) ^ Math.imul(from | 0, 0x85ebca6b)) >>> 0, speed: 0,
    };
    this.far.set(eid, far);
    return this.plan(eid, far, from, { ...p, tick: from, rng: () => this.roll(far) }) ? far : undefined;
  }

  /** Its orders have changed (a pack sent somewhere): what it does next is planned now, from where it's got to */
  replan(eid: number): void {
    const far = this.far.get(eid);
    if (!far || !this.advance(eid, far, this.host.tick())) return;
    const now = this.host.tick(), p = this.at(far, now);
    far.t0 = now; far.leg = coastLeg(p); far.a0 = p.angle; far.aim = p.angle; far.end = now; far.patrol = undefined;
  }

  /** Where a ship is now (a distant one's route worked out; a live one's components) */
  where(eid: number): FarPose {
    const far = this.far.get(eid), now = this.host.tick();
    if (far && this.advance(eid, far, now)) return this.at(far, now);
    return { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], angle: Rotation.angle[eid], angVel: this.ships.get(eid)?.angVel ?? 0 };
  }

  /**
   * A distant ship's leg as from now, and its route's count (it changes when
   * the route does: not with each of a patrol's legs); on patrol, the patrol
   * and where it's got to (null: it's live)
   */
  track(eid: number): { leg: Leg; seq: number; patrol?: { p: Patrol; s: PatrolState } } | null {
    const far = this.far.get(eid), now = this.host.tick();
    if (!far || !this.advance(eid, far, now)) return null;
    const leg = legFrom(far.leg, now - far.t0);
    leg.x = Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, leg.x));
    leg.y = Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, leg.y));
    return { leg, seq: far.seq, ...(far.patrol ? { patrol: far.patrol } : {}) };
  }

  /** What it's doing, coarsely: a structure stays put; the host's say; else its autopilot, a wreck's drift, or holding still */
  intentOf(eid: number, at: Plan): Intent | null {
    if (this.ships.isPinned(eid)) return { kind: 'fixed' };
    const i = this.host.intent?.(eid, at);
    if (i !== undefined) return i;
    const ap = this.ships.autopilotOf(eid);
    if (ap) return { kind: 'goto', x: ap.x, y: ap.y, arrive: ap.arriveRadius };
    if (this.ships.isAnchored(eid)) return { kind: 'drift' };
    // (Flown by something that hasn't said what it's doing: kept live)
    if (this.ships.hasController(eid)) return null;
    return { kind: 'hold' };
  }

  /** Where its components have it, as a plan from now (a live ship about to go distant) */
  private here(eid: number, tick: number): Plan & FarPose {
    let s = (eid * 2654435761) >>> 0;
    return {
      tick, x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], angle: Rotation.angle[eid], angVel: this.ships.get(eid)?.angVel ?? 0,
      rng: () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296),
    };
  }

  /** A ship's own dice (a route rolls the same however often it's looked at) */
  private roll(far: Far): number {
    far.seed = nextSeed(far.seed);
    return far.seed / 4294967296;
  }

  /** Its leg at tick t */
  private at(far: Far, t: number): FarPose {
    const dt = t - far.t0;
    const m = legAt(far.leg, dt) as FarPose;
    m.x = Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, m.x));
    m.y = Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, m.y));
    if (far.spin) m.angle = wrap(far.a0 + far.spin * dt);
    else { const err = wrap(far.aim - far.a0), turn = far.turn * Math.max(0, dt); m.angle = wrap(far.a0 + Math.max(-turn, Math.min(turn, err))); }
    m.angVel = far.spin;
    return m;
  }

  /** Plan its legs that have ended by `upTo` (false: it's woken, or gone) */
  private advance(eid: number, far: Far, upTo: number): boolean {
    for (let n = 0; far.end <= upTo; n++) {
      if (n >= MAX_LEGS) { far.end = upTo + REASK; break; }
      if (far.patrol) { this.patrolOn(far); continue; }
      if (!this.plan(eid, far, far.end, { ...this.at(far, far.end), tick: far.end, rng: () => this.roll(far) })) return false;
    }
    return this.far.get(eid) === far;
  }

  /** Its next leg, from `p` at tick t, by what it's doing (false: it can't be flown cheaply now, and it's woken) */
  private plan(eid: number, far: Far, t: number, p: Plan & FarPose): boolean {
    const ship = this.ships.get(eid);
    if (!ship) { this.far.delete(eid); return false; }
    // (Caught up from the past, nothing can be woken: it coasts a while and is asked again)
    const live = t >= this.host.tick();
    const intent = live && this.host.busy?.(eid) ? null : this.intentOf(eid, p);
    if (!intent && live) { this.wake(eid); return false; }
    const c = cruiseOf(ship, this.ships.tuning);
    let leg = coastLeg(p), end = t + REASK, aim = p.angle, spin = 0;
    far.patrol = undefined;
    if (intent?.kind === 'patrol' && c.speed * (intent.pace ?? 1) > 0) {
      // Its first point the one it was making for (unless it's there), the rest rolled
      const pt = patrolOf(intent.x, intent.y, intent.roam, c.speed * (intent.pace ?? 1));
      const wp = intent.wp && dhypot(intent.wp.x - p.x, intent.wp.y - p.y) > PATROL_ARRIVE ? { ...intent.wp, seed: far.seed } : patrolPoint(pt, far.seed);
      far.patrol = { p: pt, s: patrolFrom(pt, t, p, wp.x, wp.y, wp.seed) };
      far.a0 = p.angle; far.turn = c.turn; far.spin = 0;
      this.patrolLeg(far);
      far.seq = ++this.routes;
      return true;
    }
    if (!intent || intent.kind === 'hold' || intent.kind === 'patrol') end = (intent?.kind === 'hold' ? intent.until : undefined) ?? end;
    else if (intent.kind === 'fixed') { leg = { ...leg, vx: 0, vy: 0 }; end = Infinity; }
    else if (intent.kind === 'drift') { spin = p.angVel; end = Infinity; }
    else {
      // Where it's going and how fast: a point at its pace, or keeping its place off its lead (its way's end, at its speed)
      let tx: number, ty: number, speed: number, arrive: number, until: number | undefined;
      if (intent.kind === 'follow') {
        const lead = this.far.get(intent.lead);
        if (lead && intent.lead !== eid && this.advance(intent.lead, lead, t)) {
          const L = legFrom(lead.leg, t - lead.t0), hold = L.thrust < 0 ? REASK : L.thrust;
          tx = L.x + L.vx * CARRY + L.wx * hold + intent.dx; ty = L.y + L.vy * CARRY + L.wy * hold + intent.dy;
          speed = dhypot(L.wx, L.wy); arrive = 200; until = lead.end;
        } else {
          // (Its lead's live, or gone: where it is now, near enough, asked again soon)
          tx = Position.x[intent.lead] + intent.dx; ty = Position.y[intent.lead] + intent.dy;
          speed = c.speed * 0.58; arrive = 300; until = t + 120;
        }
      } else {
        tx = intent.x; ty = intent.y; speed = c.speed * (intent.pace ?? 1); arrive = intent.arrive; until = intent.until;
      }
      if (speed > 0) {
        leg = legTo(p, tx, ty, speed);
        const arr = legArrival(leg, tx, ty, arrive);
        end = t + (arr < 0 ? leg.thrust + CARRY * 3 : arr);
      }
      if (until !== undefined) end = Math.min(end, until);
      if (leg.wx || leg.wy) aim = datan2(leg.wy, leg.wx);
    }
    far.t0 = t; far.leg = leg; far.a0 = p.angle; far.aim = aim; far.turn = c.turn; far.spin = spin;
    far.end = end === Infinity ? Infinity : Math.ceil(Math.max(t + MIN_LEG, end));
    far.speed = Math.max(dhypot(leg.vx, leg.vy), dhypot(leg.wx, leg.wy));
    far.seq = ++this.routes;
    this.counts.legs++;
    return true;
  }

  /** On to a patrol's next leg (its heading carried on from the last) */
  private patrolOn(far: Far): void {
    const was = this.at(far, far.end);
    far.patrol!.s = patrolNext(far.patrol!.p, far.patrol!.s);
    far.a0 = was.angle;
    this.patrolLeg(far);
  }

  /** A patrol's leg as its route */
  private patrolLeg(far: Far): void {
    const s = far.patrol!.s, leg = s.leg;
    far.t0 = s.t0; far.leg = leg; far.end = s.end;
    far.aim = leg.wx || leg.wy ? datan2(leg.wy, leg.wx) : far.a0;
    far.speed = Math.max(dhypot(leg.vx, leg.vy), dhypot(leg.wx, leg.wy));
    this.counts.legs++;
  }

  /** Systems whose observers have moved further than OBSERVER_SPEED since last tick, or come or gone (theirs are looked over at once) */
  private jumped(obs: Map<number, number[]>): Set<number> {
    const out = new Set<number>();
    for (const [sys, o] of obs) {
      const was = this.lastObs.get(sys);
      if (!was || was.length !== o.length) { out.add(sys); continue; }
      for (let i = 0; i < o.length; i++) if (Math.abs(o[i] - was[i]) > OBSERVER_SPEED) { out.add(sys); break; }
    }
    this.lastObs = obs;
    return out;
  }

  private wake(eid: number): void {
    const far = this.far.get(eid);
    // (Where its route has it: its components are only written now and then)
    if (far) this.ships.moveDistant(eid, this.at(far, this.host.tick()));
    this.far.delete(eid);
    this.ships.wake(eid);
    this.seen.set(eid, this.host.tick());
    this.counts.promoted++;
  }

  stats(): LodStats {
    let live = 0;
    const dormant = this.ships.dormantShips();
    for (const [eid, s] of this.ships.bodies) if (s.kind === 'ship' && !dormant.has(eid)) live++;
    return { live, distant: dormant.size, promoted: this.counts.promoted, demoted: this.counts.demoted, legs: this.counts.legs, looks: this.counts.looks, blocked: { ...this.blocked } };
  }
}
