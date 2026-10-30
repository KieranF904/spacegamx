/**
 * Simulation level of detail for pilotless ships.
 *
 * Every pilotless ship (hostile packs, bosses, wards, traffic, derelicts,
 * people's craft) is in one of two tiers:
 *
 *   live     the whole pipeline (ShipBridge.tick): its AI, flight, guns,
 *            shields, contacts, hits.
 *   distant  out of all of that. Every STEP ticks it's moved along what it's
 *            doing, coarsely (its Intent: flying to a point at a pace, holding
 *            station, drifting), by the same integrator flight uses (thrust
 *            against FRICTION) at its own cruise speed and turn rate, so on
 *            the map it moves as a real ship would. Nothing hits it and it
 *            hits nothing; every part, its shield, battery, heat and guns'
 *            cooldowns are kept as they were (ShipBridge.wake catches them up).
 *
 * A distant ship goes live the moment a pilot comes within PROMOTE_RADIUS of
 * it (past the furthest a client sees ships, SHIP_VIEW_OUT, plus a margin):
 * it's live and flying before any client can see it, and long before it
 * could pick a fight (aggro ranges are a few thousand). A pilot spooling a
 * jump counts along the whole of its reach, so ships where it lands are woken
 * while it charges. A live ship goes distant once no pilot has been within
 * DEMOTE_RADIUS of it for DEMOTE_AFTER (the gap is the hysteresis), never
 * while it's busy: fighting, hurt or shooting lately, EMP'd, burning, under
 * repair, mid-jump, a ward while its system is occupied, a boss mid-move
 * (ShipBridge.sleepBlocker and the host's `busy`). In a system nobody is in,
 * everything that isn't busy goes distant at the next check.
 */

import {
  InSystem, Position, Velocity, Rotation, FRICTION, BOOST_FACTOR, WORLD_SIZE,
  stepFlight, FULL_CHARGE, type ShipDerived, type ShipState, type Blueprint, type ShipTuning,
} from '@space-game/common';
import type { ShipBridge } from './ShipBridge.js';

/** What a pilotless ship is doing, as far as a distant one needs to know */
export type Intent =
  /** Fly to a point and stop within `arrive`; thrusting `pace` of the time (packs cruise in pulses; 0: coasting) */
  | { kind: 'goto'; x: number; y: number; arrive: number; pace?: number }
  /** Engines off: it coasts to a stop and keeps its heading */
  | { kind: 'hold' }
  /** A wreck: it coasts and keeps turning */
  | { kind: 'drift' }
  /** Fixed where it stands (a structure) */
  | { kind: 'fixed' };

export interface LodHost {
  tick(): number;
  /**
   * Where pilots are, by system: only systems someone is in. Each entry is a
   * segment [x0, y0, x1, y1] (a pilot where it is: x1 = x0, y1 = y0; one
   * spooling a jump: from where it is out along the jump's reach)
   */
  observers(): Map<number, number[]>;
  /**
   * What a ship is doing, coarsely. null: it can't be flown cheaply now (it
   * stays live, or wakes); undefined: nothing in particular (the bridge's own
   * then: its autopilot, a wreck's drift, holding still)
   */
  intent?(eid: number): Intent | null | undefined;
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
/** Distant ships move every this many ticks (5 Hz), staggered by id */
export const STEP = 12;
/** "Lately", for ShipBridge.sleepBlocker: hurt within this, or shooting */
export const RECENT = { damaged: 60 * 10, fired: 60 * 5 };

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
    const s = Math.hypot(body.vx, body.vy);
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

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Squared distance from a point to a segment */
function segDist2(px: number, py: number, s: number[], i: number): number {
  const x0 = s[i], y0 = s[i + 1], dx = s[i + 2] - x0, dy = s[i + 3] - y0;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2)) : 0;
  const ex = px - (x0 + dx * t), ey = py - (y0 + dy * t);
  return ex * ex + ey * ey;
}

/** Is any observer within r of (x, y) */
function near(obs: number[] | undefined, x: number, y: number, r: number): boolean {
  if (!obs) return false;
  const r2 = r * r;
  for (let i = 0; i < obs.length; i += 4) if (segDist2(x, y, obs, i) < r2) return true;
  return false;
}

/**
 * One distant ship's motion over `dt` ticks: thrust (at `pace` of full, the
 * duty of a pack cruising in pulses) along the way to its point, coasting in
 * once friction alone would bring it there; the nose turning to the way it's
 * going at its own rate. Exactly `dt` ticks of flight's integrator
 * (v = (v + a) × FRICTION, x += v) with the thrust held, in closed form.
 */
export function stepDistant(
  b: { x: number; y: number; vx: number; vy: number; angle: number; angVel: number },
  intent: Intent, cruise: Cruise, dt: number,
): void {
  const F = FRICTION, Fn = Math.pow(F, dt);
  // Sum over the dt ticks of F^k (k = 1..dt): how far a velocity carries before it's gone
  const carry = (F * (1 - Fn)) / (1 - F);
  let ax = 0, ay = 0;
  if (intent.kind === 'fixed') { b.vx = 0; b.vy = 0; b.angVel = 0; return; }
  if (intent.kind === 'goto') {
    const dx = intent.x - b.x, dy = intent.y - b.y, dist = Math.hypot(dx, dy);
    const speed = Math.hypot(b.vx, b.vy);
    // Friction alone stops it within v × F / (1 - F): it thrusts until that's all that's left
    const coast = (speed * F) / (1 - F);
    const pace = intent.pace ?? 1;
    if (dist > intent.arrive && dist - intent.arrive > coast && pace > 0 && cruise.speed > 0) {
      // Thrust a that holds `speed` against friction: speed = a F / (1 - F)
      const a = (cruise.speed * (1 - F)) / F * pace;
      ax = (dx / dist) * a; ay = (dy / dist) * a;
      // Never further than its point (a coarse step mustn't fly it past and back)
      const reach = (Math.hypot(b.vx * carry, b.vy * carry)) + a * (F / (1 - F)) * (dt - carry);
      if (reach > dist - intent.arrive * 0.5) { const k = Math.max(0, (dist - intent.arrive * 0.5 - speed * carry) / Math.max(1e-6, reach - speed * carry)); ax *= k; ay *= k; }
    }
    // The nose comes round to where it's going (or the way it's moving, coasting in)
    const want = ax || ay ? Math.atan2(ay, ax) : speed > 0.5 ? Math.atan2(b.vy, b.vx) : b.angle;
    const err = wrap(want - b.angle), turn = cruise.turn * dt;
    b.angle = wrap(b.angle + Math.max(-turn, Math.min(turn, err)));
    b.angVel = 0;
  } else if (intent.kind === 'drift') {
    // (A wreck's slow spin is kept: anchored ships keep theirs)
    b.angle = wrap(b.angle + b.angVel * dt);
  } else {
    b.angVel = 0;
  }
  // dt ticks of v' = (v + a) F, x' = x + v'
  const tail = (F / (1 - F)) * (dt - carry);
  b.x = Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, b.x + b.vx * carry + ax * tail));
  b.y = Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, b.y + b.vy * carry + ay * tail));
  b.vx = b.vx * Fn + ax * carry;
  b.vy = b.vy * Fn + ay * carry;
}

export interface LodStats {
  live: number;
  distant: number;
  promoted: number;
  demoted: number;
  /** Why ships that could have gone distant stayed live, at the last check */
  blocked: Record<string, number>;
}

export class SimLod {
  /** Off: every ship stays live (the old behaviour; the bench's --no-lod) */
  enabled = true;
  /** Last tick a pilot was within DEMOTE_RADIUS of each live pilotless ship */
  private seen = new Map<number, number>();
  /** Last tick each distant ship was moved */
  private stepped = new Map<number, number>();
  private counts = { promoted: 0, demoted: 0 };
  private blocked: Record<string, number> = {};

  constructor(private host: LodHost, private ships: ShipBridge) {}

  /** Once a tick, before ShipBridge.tick: wake what's come into range, put to sleep what's long out of it, move the distant */
  tick(): void {
    const now = this.host.tick();
    const dormant = this.ships.dormantShips();
    if (!this.enabled) {
      for (const eid of [...dormant.keys()]) this.wake(eid);
      return;
    }
    const obs = this.host.observers();
    const watched = this.host.watched?.();

    // Wake: every tick (a pilot arriving from a gate or a jump is caught before the next snapshot)
    for (const [eid] of [...dormant]) {
      const ship = this.ships.get(eid);
      if (!ship) { this.stepped.delete(eid); continue; }
      const r = ship.derived.radius;
      if (watched?.has(eid) || near(obs.get(InSystem.systemId[eid]), Position.x[eid], Position.y[eid], PROMOTE_RADIUS + r)) this.wake(eid);
    }

    // Sleep: what nobody's been near for a while (everything, where nobody is), unless it's busy
    if (now % DEMOTE_CHECK === 0) {
      this.blocked = {};
      for (const id of this.seen.keys()) if (!this.ships.has(id) || dormant.has(id)) this.seen.delete(id);
      for (const id of this.stepped.keys()) if (!dormant.has(id)) this.stepped.delete(id);
      for (const [eid, ship] of this.ships.bodies) {
        if (dormant.has(eid) || ship.kind !== 'ship') continue;
        const o = obs.get(InSystem.systemId[eid]);
        if (o && (watched?.has(eid) || near(o, Position.x[eid], Position.y[eid], DEMOTE_RADIUS + ship.derived.radius))) { this.seen.set(eid, now); continue; }
        if (!this.seen.has(eid)) this.seen.set(eid, now);
        // (A system nobody's in: at once)
        if (o && now - this.seen.get(eid)! < DEMOTE_AFTER) continue;
        const why = this.ships.sleepBlocker(eid, RECENT) ?? (this.host.busy?.(eid) ? 'busy' : this.intentOf(eid) ? null : 'no intent');
        if (why) { if (why !== 'pilot') this.blocked[why] = (this.blocked[why] ?? 0) + 1; continue; }
        if (this.ships.sleep(eid, RECENT)) { this.counts.demoted++; this.stepped.set(eid, now); this.seen.delete(eid); }
      }
    }

    // Move the distant, each every STEP ticks (staggered)
    for (const [eid] of [...dormant]) {
      if ((eid + now) % STEP !== 0) continue;
      const ship = this.ships.get(eid);
      if (!ship) continue;
      const intent = this.host.busy?.(eid) ? null : this.intentOf(eid);
      // Something's come up it can't do cheaply (a pack sent to raid is still a goto: this is a fight starting)
      if (!intent) { this.wake(eid); continue; }
      const dt = Math.max(1, Math.min(STEP * 4, now - (this.stepped.get(eid) ?? now - STEP)));
      this.stepped.set(eid, now);
      const b = { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], angle: Rotation.angle[eid], angVel: ship.angVel };
      stepDistant(b, intent, cruiseOf(ship, this.ships.tuning), dt);
      this.ships.moveDistant(eid, b);
    }
  }

  /** What it's doing, coarsely: a structure stays put; the host's say; else its autopilot, a wreck's drift, or holding still */
  intentOf(eid: number): Intent | null {
    if (this.ships.isPinned(eid)) return { kind: 'fixed' };
    const i = this.host.intent?.(eid);
    if (i !== undefined) return i;
    const ap = this.ships.autopilotOf(eid);
    if (ap) return { kind: 'goto', x: ap.x, y: ap.y, arrive: ap.arriveRadius };
    if (this.ships.isAnchored(eid)) return { kind: 'drift' };
    // (Flown by something that hasn't said what it's doing: kept live)
    if (this.ships.hasController(eid)) return null;
    return { kind: 'hold' };
  }

  private wake(eid: number): void {
    this.ships.wake(eid);
    this.stepped.delete(eid);
    this.seen.set(eid, this.host.tick());
    this.counts.promoted++;
  }

  stats(): LodStats {
    let live = 0;
    const dormant = this.ships.dormantShips();
    for (const [eid, s] of this.ships.bodies) if (s.kind === 'ship' && !dormant.has(eid)) live++;
    return { live, distant: dormant.size, promoted: this.counts.promoted, demoted: this.counts.demoted, blocked: { ...this.blocked } };
  }
}
