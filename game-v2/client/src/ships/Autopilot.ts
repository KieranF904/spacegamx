/**
 * Autopilot: flies the local ship to a destination with the same controls a
 * pilot has (screen-relative thrust, turn to an aim angle, the jump drive), so
 * prediction and the server see nothing special.
 *
 * Destinations are a station, a jump gate, a point, a party member or "the job
 * you're following". Another system is reached step by step (route.ts): at a
 * gate, or over a planet you're going down to, it presses X for you; it flies
 * into rifts, and out past a surface's edge to climb back to orbit. Long legs use the jump drive when it's ready,
 * and boost while the batteries are over half full (down to half, then it waits for them to recharge a little).
 * In a system it follows a route (routePlan.ts): round the star, planets, stations, hostile packs, nests
 * and lairs; jumping where that's quicker, and by a lodestone when that pays.
 * Arriving at a station opens its screen. Any flight key or a click takes back control.
 */

import { EntityType, StarSystemData, QuestTarget, FRICTION, jumpTuning, ShipTuning } from '@space-game/common';
import type { GameState } from '../state/GameState';
import systemsData from '../../../data/systems.json';
import { routeStep } from './route';
import {
  planRoute, routeTime, systemObstacles, segmentClear, insideAny, jumpPays,
  type Obstacle, type PlanShip, type RoutePlan, type RouteLeg, type SeenHostile,
} from './routePlan';

const SYSTEMS = (systemsData as { systems: StarSystemData[] }).systems;

export type AutoDest =
  | { kind: 'station'; system: string; name: string }
  | { kind: 'gate'; system: string; to: string; name: string }
  | { kind: 'point'; system: string; x: number; y: number; name: string }
  /** Somewhere in another system (arrive by its gate) */
  | { kind: 'system'; system: string; name: string }
  | { kind: 'objective'; name: string }
  | { kind: 'player'; id: number; system: string; name: string };

export interface AutoControls {
  forward: boolean; backward: boolean; left: boolean; right: boolean; boost: boolean;
  targetAngle: number;
  jump: boolean;
  cursorDist: number;
}

export interface AutopilotHost {
  state: GameState;
  tuning: ShipTuning;
  /** The local ship's forward acceleration (world units / tick²), 0 with no ship */
  accel(): number;
  /** How much harder the engines push boosting (×), and the batteries' charge (0-100, the HUD's gauge) */
  boostFactor(): number;
  energy(): number;
  jumpPhase(): 'ready' | 'charging' | 'burn' | 'cooldown';
  jumpReach(): number;
  objective(): QuestTarget | null;
  /** Where a party member is (system id), when known */
  memberSystem?(id: number): string | undefined;
  interact(): void;
  arrived(dest: AutoDest, station: string | null): void;
  /** Ticks until the controls sent now take effect (the input delay) */
  lead?(): number;
  /** The jump drive for route planning: its reach (unboosted) and cooldown, ticks until it's ready, priming left */
  drive?(): { range: number; cooldown: number; cool: number; primed: number } | null;
  message(text: string, color?: string): void;
}

/** The next step on the shortest route (route.ts): a gate, a rift, down to a planet or up off one */
export { routeStep, routeHops } from './route';

const GATE_RADIUS = 260;
const STATION_ARRIVE = 650;
const POINT_ARRIVE = 350;
/** Boost down to half the batteries, and start again once they're back over this */
const BOOST_FLOOR = 50;
const BOOST_RESUME = 60;
/** Plan the route again this often (ticks) */
const REPLAN_TICKS = 120;
/** Average flying speed as a share of boosted top speed (the boost comes and goes with the batteries) */
export const FLY_SHARE = 0.62;
/** Ticks to speed up at the start and stop at the end, on top of the route's time (for the ETA) */
const STOP_TICKS = 90;

/** The route as the map draws it: fly and jump stretches from where you are, a lodestone call, how long the rest takes (ticks) */
export interface RouteView { legs: RouteLeg[]; eta: number; lodestone: { x: number; y: number } | null; lodestoneName?: string }

export class Autopilot {
  private dest: AutoDest | null = null;
  /** What happens on arrival, for the HUD ("will dock"; a right-click's order) */
  private note = '';
  private lastTarget: { x: number; y: number; system: string } | null = null;
  private targetVel = { x: 0, y: 0 };
  private lastInteract = -Infinity;
  /** Rough leg info for the HUD */
  private status = { dist: 0, via: '' as string, label: '' };
  private hud: HTMLDivElement;
  private stuckTicks = 0;
  /** Boosting, until the batteries are down to half (then not again until they're back over BOOST_RESUME) */
  private boosting = false;
  /** Steering's memory: braking or not, and the last heading (autoSteer) */
  private steer = newSteerMemory();
  /** The system it was in last tick (going through a gate or a rift changes it) */
  private lastSystem: string | null = null;
  /** The route through this system (routePlan.ts), where along it we are, and whether we've called at its lodestone */
  private route: { system: string; goal: { x: number; y: number }; plan: RoutePlan; idx: number; lodestoneDone: boolean } | null = null;
  private replanIn = 0;
  private etaIn = 0;
  private view: RouteView | null = null;

  constructor(private host: AutopilotHost) {
    this.hud = document.createElement('div');
    this.hud.style.cssText = `position: fixed; left: 50%; bottom: 236px; transform: translateX(-50%); display: none; z-index: 880;
      padding: 6px 16px; border-radius: 999px; background: rgba(6, 22, 18, 0.85); border: 1px solid rgba(74, 222, 128, 0.55);
      color: #bbf7d0; font: 600 12px 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.6px; pointer-events: none; white-space: nowrap;
      box-shadow: 0 0 18px rgba(74, 222, 128, 0.15);`;
    document.body.appendChild(this.hud);
  }

  get active(): boolean {
    return this.dest !== null;
  }

  get destination(): AutoDest | null {
    return this.dest;
  }

  /** The route ahead in this system, for the map */
  routeView(): RouteView | null {
    return this.dest && this.route?.system === this.host.state.systemId ? this.view : null;
  }

  /** Where it's steering in this system (for the map's route line) */
  heading(): { x: number; y: number } | null {
    const t = this.lastTarget;
    return this.dest && t && t.system === this.host.state.systemId && Number.isFinite(t.x) ? t : null;
  }

  engage(dest: AutoDest, note = ''): void {
    this.dest = dest;
    this.note = note;
    this.lastTarget = null;
    this.stuckTicks = 0;
    this.steer = newSteerMemory();
    this.lastSystem = this.host.state.systemId;
    this.route = this.view = null;
    this.host.message(note ? `Autopilot → ${dest.name}, ${note}` : `Autopilot: heading for ${dest.name}`, '#86efac');
  }

  cancel(reason?: string): void {
    if (!this.dest) return;
    this.dest = null;
    this.hud.style.display = 'none';
    if (reason) this.host.message(reason, '#9fd8ff');
  }

  setHidden(hidden: boolean): void {
    if (hidden) this.hud.style.display = 'none';
  }

  /** Where we're steering this tick (a gate on the way, or the destination itself) */
  private target(): { x: number; y: number; kind: 'gate' | 'station' | 'point'; station?: string; via?: string; reach?: number; press?: boolean } | null {
    const d = this.dest!;
    const state = this.host.state;
    const here = state.systemId;
    let system: string, station: string | undefined, x: number | undefined, y: number | undefined;
    switch (d.kind) {
      case 'objective': {
        const t = this.host.objective();
        if (!t) return null;
        system = t.system; station = t.station; x = t.x; y = t.y;
        this.status.label = t.label;
        break;
      }
      case 'player': {
        const e = state.entities.get(d.id);
        system = e ? here : this.host.memberSystem?.(d.id) ?? d.system;
        if (e) { x = e.renderX; y = e.renderY; }
        break;
      }
      case 'station': system = d.system; station = d.name; break;
      case 'gate': system = d.system; break;
      case 'point': system = d.system; x = d.x; y = d.y; break;
      case 'system': system = d.system; break;
    }
    if (system !== here) {
      const me = state.entities.get(state.playerId);
      const g = routeStep(here, system, state.getRawServerTick(), me ? { x: me.renderX, y: me.renderY } : undefined);
      if (!g) return null;
      return { x: g.x, y: g.y, kind: 'gate', via: g.label, reach: g.reach, press: g.kind === 'gate' || g.kind === 'planet' };
    }
    if (d.kind === 'gate') {
      const g = SYSTEMS.find((s) => s.id === here)?.portals.find((p) => p.targetSystem === d.to);
      return g ? { x: g.position.x, y: g.position.y, kind: 'gate', via: `gate to ${SYSTEMS.find((s) => s.id === d.to)?.name ?? d.to}`, press: true } : null;
    }
    if (station) {
      for (const e of state.entities.values()) {
        if (e.type === EntityType.Station && e.name === station) return { x: e.renderX, y: e.renderY, kind: 'station', station };
      }
      return null;
    }
    if (x !== undefined && y !== undefined) return { x, y, kind: 'point' };
    // A whole system (or a job "somewhere in" it): you're there
    return { x: NaN, y: NaN, kind: 'point' };
  }

  /** One input tick: the controls to send, or null to leave the pilot's own */
  tick(): AutoControls | null {
    if (!this.dest) return null;
    const state = this.host.state;
    // Through a gate or a rift: a new system, so nothing it knew about the old one's targets holds
    const from = this.lastSystem;
    this.lastSystem = state.systemId;
    if (from !== null && from !== state.systemId) {
      this.lastTarget = null;
      this.targetVel = { x: 0, y: 0 };
      this.steer = newSteerMemory();
      this.stuckTicks = 0;
      this.route = this.view = null;
      // Through the gate (or the rift) it was flying to: that's the trip done, not a reason to fly back for it
      const d = this.dest;
      if (d.kind === 'gate' ? state.systemId === d.to : (d.kind === 'point' || d.kind === 'station') && d.system === from) {
        const name = SYSTEMS.find((s) => s.id === state.systemId)?.name ?? state.systemId;
        this.arrive(null);
        this.host.message(`Autopilot: arrived in ${name}`, '#86efac');
        return null;
      }
    }
    const me = state.entities.get(state.playerId);
    const a = this.host.accel();
    if (!me || a <= 0) return null;
    const t = this.target();
    if (!t) { this.cancel('Autopilot: no route to that destination'); return null; }
    if (Number.isNaN(t.x)) {
      const name = this.dest.name;
      this.arrive(null);
      this.host.message(`Autopilot: arrived in ${name}`, '#86efac');
      return null;
    }
    // The target's own motion (stations orbit): match it on arrival
    if (this.lastTarget && this.lastTarget.system === state.systemId && Math.hypot(t.x - this.lastTarget.x, t.y - this.lastTarget.y) < 200) {
      this.targetVel.x += ((t.x - this.lastTarget.x) - this.targetVel.x) * 0.2;
      this.targetVel.y += ((t.y - this.lastTarget.y) - this.targetVel.y) * 0.2;
    } else {
      this.targetVel = { x: 0, y: 0 };
    }
    this.lastTarget = { x: t.x, y: t.y, system: state.systemId };

    // The route there (routePlan.ts): waypoints round what's in the way, maybe by a lodestone
    const plan = this.followRoute(me, t, a);
    const final = plan.idx >= plan.points.length - 1;
    const wp = final ? t : plan.points[plan.idx];

    // The controls we send now apply a few ticks on (the input delay): steer from where we'll be by then
    const lead = this.host.lead?.() ?? 0;
    const dx = wp.x - (me.x + me.vx * lead), dy = wp.y - (me.y + me.vy * lead);
    const dist = Math.hypot(dx, dy);
    // (Waypoints stand still; the destination may move)
    const tvx = final ? this.targetVel.x : 0, tvy = final ? this.targetVel.y : 0;
    const rvx = me.vx - tvx, rvy = me.vy - tvy;
    const relSpeed = Math.hypot(rvx, rvy);
    const toGo = dist + plan.after;
    this.status.dist = toGo;
    this.status.via = t.kind === 'gate' ? t.via ?? '' : '';

    // Arrived? (Where we are now: X goes straight to the server, without the input delay)
    const arriveR = t.kind === 'gate' ? t.reach ?? GATE_RADIUS : t.kind === 'station' ? STATION_ARRIVE : POINT_ARRIVE;
    if (final && Math.hypot(t.x - me.x, t.y - me.y) < arriveR) {
      if (t.kind === 'gate') {
        // Gates and planets: X. (Rifts and a surface's edge take you on their own: reach 0, so never "arrived")
        const now = performance.now();
        if (now - this.lastInteract > 1200) { this.lastInteract = now; this.host.interact(); }
      } else if (relSpeed < 2.5) {
        this.arrive(t.station ?? null);
        return null;
      }
    }

    // Jump drive: on a leg long enough that a jump beats flying it, line up on the waypoint, then hold J until the burn starts
    const phase = this.host.jumpPhase();
    const angTo = Math.atan2(dy, dx);
    const facingErr = Math.abs(wrap(angTo - me.angle));
    if (phase === 'burn') {
      this.render();
      return { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: angTo, jump: false, cursorDist: 0 };
    }
    const ship = this.planShip(a);
    const legLeft = Math.max(0, dist - (final ? (t.kind === 'gate' ? 900 : 1500) : 0));
    const jumpLeg = !plan.holding && jumpPays(legLeft, ship);
    if (phase === 'charging' || (phase === 'ready' && jumpLeg && facingErr < 0.04)) {
      // (Sliding sideways would throw the jump off its line; and never land somewhere bad)
      const side = Math.abs(me.vx * Math.sin(angTo) - me.vy * Math.cos(angTo));
      const reach = this.host.jumpReach();
      const jd = Math.max(0, Math.min(reach, legLeft));
      const land = { x: me.x + Math.cos(angTo) * jd, y: me.y + Math.sin(angTo) * jd };
      if (phase === 'charging' || (side < 4 && !insideAny(land, plan.obstacles))) {
        this.render();
        return { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: angTo, jump: true, cursorDist: jd };
      }
    }

    // Boost on long legs while the batteries are over half
    const energy = this.host.energy();
    if (energy <= BOOST_FLOOR) this.boosting = false;
    else if (energy >= BOOST_RESUME) this.boosting = true;
    const stopR = !final ? 0 : t.kind === 'gate' ? 0 : arriveR * 0.4;
    const brakeIn = (d: number) => Math.sqrt(2 * a * 0.6 * d) + d * (1 - FRICTION) * 0.8;
    const boostFactor = Math.max(1, this.host.boostFactor());
    const vBoost = (a * boostFactor * FRICTION) / (1 - FRICTION);
    // (Boosting while it can still stop at unboosted braking from the boosted speed)
    let braking = brakeIn(Math.max(0, toGo - stopR));
    // Round a corner no faster than it can turn (sharper, slower), not stopping at each waypoint
    if (!final) braking = Math.min(braking, brakeIn(dist) + vBoost * plan.corner);
    // Holding at a stillstone while its field charges the drive (just off the stone)
    if (plan.holding) braking = brakeIn(Math.max(0, dist - plan.holdR));
    const boost = this.boosting && toGo > 4000 && braking > vBoost * 0.85;
    // Cruise: a speed we can still shed in the distance left (friction and reverse thrust)
    const vmax = (a * (boost ? boostFactor : 1) * FRICTION) / (1 - FRICTION);
    // A jump to come on this leg: point along it so it can line up
    const far = jumpLeg && phase !== 'cooldown';
    const { ix, iy, targetAngle, err } = autoSteer({ dx, dy, rvx, rvy, a, vmax, vStop: braking, far, lead }, this.steer);
    // Not getting anywhere (blocked, out of thrust): give up rather than spin forever
    if (!plan.holding && relSpeed < 0.2 && err > a * 2) { if (++this.stuckTicks > 60 * 20) { this.cancel('Autopilot: stuck, handing back control'); return null; } }
    else this.stuckTicks = 0;
    this.render();
    return { forward: iy < 0, backward: iy > 0, left: ix < 0, right: ix > 0, boost, targetAngle, jump: false, cursorDist: 0 };
  }

  /** The ship as the route planner sees it */
  private planShip(a: number): PlanShip {
    const vBoost = (a * Math.max(1, this.host.boostFactor()) * FRICTION) / (1 - FRICTION);
    const d = this.host.drive?.() ?? null;
    return { vFly: vBoost * FLY_SHARE, drive: d ? { jt: jumpTuning(this.host.tuning), ...d } : null };
  }

  /** What's in the way here now (routePlan.ts systemObstacles) */
  private obstaclesNow(): Obstacle[] {
    const state = this.host.state;
    const hostiles: SeenHostile[] = [], stations: { x: number; y: number; r: number }[] = [];
    for (const e of state.entities.values()) {
      if (e.type === EntityType.ShipBody && e.data?.[0] === 3) hostiles.push({ x: e.renderX, y: e.renderY, rank: e.data?.[4] ?? 0, calm: e.data?.[9] === 1 && e.data?.[4] !== 2 });
      else if (e.type === EntityType.Station) stations.push({ x: e.renderX, y: e.renderY, r: e.data?.[8] ?? 300 });
    }
    return systemObstacles(SYSTEMS.find((s) => s.id === state.systemId), state.getRawServerTick(), hostiles, stations);
  }

  /**
   * Keep a route to `t` and say where along it we are: planned on the way in,
   * planned again every couple of seconds (a new one taken if the old is
   * blocked now or the new one is clearly quicker, so it doesn't dither between
   * two ways round), and when the destination moves off it. Waypoints we can
   * already see past are skipped, so corners are cut, not visited; a lodestone
   * on the route is called at (and waited at while the drive is cooling down).
   */
  private followRoute(me: { x: number; y: number; vx: number; vy: number }, t: { x: number; y: number }, a: number): {
    points: { x: number; y: number }[]; idx: number; after: number; corner: number; holding: boolean; holdR: number; obstacles: Obstacle[];
  } {
    const state = this.host.state;
    const sys = SYSTEMS.find((s) => s.id === state.systemId);
    const tick = state.getRawServerTick();
    const r = this.route;
    const phase = this.host.jumpPhase();
    const busy = phase === 'charging' || phase === 'burn';
    const moved = !r || Math.hypot(r.goal.x - t.x, r.goal.y - t.y) > 1500;
    if (!r || r.system !== state.systemId || ((moved || this.replanIn-- <= 0) && !busy)) {
      this.replanIn = REPLAN_TICKS;
      const ship = this.planShip(a);
      const fresh = planRoute({ sys, tick, from: me, to: t, ship, obstacles: this.obstaclesNow() });
      let keep = !!r && r.system === state.systemId && !moved;
      if (keep && r) {
        // The route we're on, as things stand now: still clear, and not much slower?
        const rest = [...r.plan.points.slice(r.idx, -1), t];
        let clear = true, at: { x: number; y: number } = me;
        for (const p of rest) { if (!segmentClear(at, p, fresh.obstacles)) { clear = false; break; } at = p; }
        const lode = r.plan.lodestone >= r.idx && !r.lodestoneDone ? r.plan.lodestone - r.idx : -1;
        keep = clear && routeTime(me, rest, ship, sys, lode, r.plan.lodestoneData).eta < fresh.eta * 1.12 + 60;
        if (keep) r.plan.obstacles = fresh.obstacles;
      }
      if (!keep) this.route = { system: state.systemId, goal: { x: t.x, y: t.y }, plan: fresh, idx: 0, lodestoneDone: false };
      this.etaIn = 0;
    }
    const route = this.route!;
    const pts = route.plan.points;
    const last = pts.length - 1;
    const ld = route.plan.lodestone;
    // At the stillstone: primed now; if the drive's cooling down, wait in the field (off the stone) until it's ready
    let holding = false;
    if (ld >= 0 && route.idx === ld && !route.lodestoneDone) {
      const p = pts[ld];
      if (Math.hypot(p.x - me.x, p.y - me.y) < (route.plan.lodestoneHold ?? 0) + jumpTuning(this.host.tuning).lodestoneField * 0.2) {
        if (phase === 'cooldown') holding = true;
        else route.lodestoneDone = true;
      }
    }
    if (!holding) {
      // On past waypoints we're at, or can see past (but not past the lodestone we're calling at)
      while (route.idx < last && !(route.idx === ld && !route.lodestoneDone)) {
        const p = pts[route.idx], next = route.idx + 1 === last ? t : pts[route.idx + 1];
        if (Math.hypot(p.x - me.x, p.y - me.y) < 600 || segmentClear(me, next, route.plan.obstacles, 200)) route.idx++;
        else break;
      }
    }
    // The rest of the way after the waypoint we're making for, and how sharp the turn there is
    const at = (i: number) => (i >= last ? t : pts[i]);
    let after = 0, corner = 1;
    for (let i = route.idx; i < last; i++) after += Math.hypot(at(i + 1).x - at(i).x, at(i + 1).y - at(i).y);
    if (route.idx < last) {
      const p = at(route.idx), q = at(route.idx + 1);
      const a1 = Math.atan2(p.y - me.y, p.x - me.x), a2 = Math.atan2(q.y - p.y, q.x - p.x);
      corner = Math.max(0.2, Math.cos(Math.abs(wrap(a2 - a1)) / 2));
    }
    // The route for the map, with how long the rest takes (now and then: it's not free)
    if (this.etaIn-- <= 0) {
      this.etaIn = 30;
      const rest = [...pts.slice(route.idx, -1), t];
      const lode = ld >= route.idx && !route.lodestoneDone ? ld - route.idx : -1;
      const rt = routeTime(me, rest, this.planShip(a), sys, lode, route.plan.lodestoneData);
      this.view = { legs: rt.legs, eta: rt.eta + STOP_TICKS, lodestone: lode >= 0 ? rest[lode] : null, lodestoneName: route.plan.lodestoneName };
    }
    return { points: pts, idx: route.idx, after: holding ? 0 : after, corner, holding, holdR: route.plan.lodestoneHold ?? 150, obstacles: route.plan.obstacles };
  }

  private arrive(station: string | null): void {
    const d = this.dest!;
    this.dest = null;
    this.hud.style.display = 'none';
    this.host.arrived(d, station);
  }

  private render(): void {
    const d = this.dest;
    if (!d) return;
    const name = d.kind === 'objective' ? this.status.label || d.name : d.name;
    const km = this.status.dist >= 1000 ? `${(this.status.dist / 1000).toFixed(1)} km` : `${Math.round(this.status.dist)} m`;
    const via = this.status.via ? ` · via ${this.status.via}` : '';
    const jump = this.host.jumpPhase() === 'charging' ? ' · spooling jump' : this.host.jumpPhase() === 'burn' ? ' · jumping' : '';
    const v = this.view;
    const eta = v ? ` · ${etaText(v.eta)}` : '';
    const lode = v?.lodestone ? ` · via ${v.lodestoneName ?? 'stillstone'}` : '';
    const note = this.note ? ` (${this.note})` : '';
    this.hud.textContent = `AUTOPILOT → ${name}${note} · ${km}${eta}${via}${lode}${jump} · any flight key takes over`;
    this.hud.style.display = 'block';
  }
}

export interface SteerInput {
  /** To the target, and our velocity relative to it */
  dx: number; dy: number;
  rvx: number; rvy: number;
  /** Forward acceleration (world units / tick²) and top speed at the current thrust (boosted or not) */
  a: number; vmax: number;
  /** The fastest we can be going and still stop in the distance left */
  vStop: number;
  /** Line up on the target for a jump */
  far: boolean;
  /** Ticks until these controls take effect (dx, dy are from where we'll be by then) */
  lead?: number;
}

/** What the steering remembers from tick to tick */
export interface SteerMemory { braking: boolean; aim: number | null }

export const newSteerMemory = (): SteerMemory => ({ braking: false, aim: null });

/**
 * One tick of steering towards a target: the screen direction to thrust (the
 * nearest of eight) and where to point the nose.
 *
 * The nose points at the target (leaning into any drift to cancel it), and
 * turns round to brake only when it's going faster than it can stop in the
 * distance left, then stays turned round until it arrives (a flip and burn,
 * not a nose that swings back and forth). Over top speed with plenty of room
 * (the boost running out, the end of a jump) it just coasts down.
 */
export function autoSteer(s: SteerInput, mem: SteerMemory): { ix: number; iy: number; targetAngle: number; err: number } {
  const { dx, dy, rvx, rvy, a } = s;
  const dist = Math.hypot(dx, dy);
  const ux = dx / Math.max(1e-6, dist), uy = dy / Math.max(1e-6, dist);
  const along = rvx * ux + rvy * uy;
  const vCruise = s.vmax * 0.92;
  // The speed to hold along the line to the target (over cruise speed but able to stop: coast, friction sheds it)
  const want = along > s.vStop ? s.vStop : along > vCruise ? along : Math.min(vCruise, s.vStop);
  const ex = ux * want - rvx, ey = uy * want - rvy;
  const err = Math.hypot(ex, ey);
  const eAlong = ex * ux + ey * uy;
  // Turn round to brake once it needs a real burn to stop in time (slow, the reverse thrusters will do);
  // face forward again only if it's fallen well short. (Steering for `lead` ticks on, we're behind the
  // braking curve by as much as it falls in that time before a brake we ask for even starts)
  const slack = a * 6 + (s.lead ?? 0) * (a + (1 - FRICTION) * along);
  if (!mem.braking && eAlong < -slack && along > a * 25) mem.braking = true;
  else if (mem.braking && eAlong > a * 12) mem.braking = false;
  // Where to point: a steady heading (the target, or back along our motion), plus the correction we need
  // (so the main engine does the work), weighted so small corrections barely move the nose
  const K = a * 30;
  let hx: number, hy: number;
  if (mem.braking) {
    const v = Math.hypot(rvx, rvy);
    // (Fading out as we slow, where "back along our motion" stops meaning much)
    const w = K / Math.max(v, a * 10);
    hx = -rvx * w + ex; hy = -rvy * w + ey;
  } else {
    // (Only the sideways part: speeding up or slowing a little, or the boost coming and going, isn't worth turning for)
    hx = ux * K + ex - ux * eAlong; hy = uy * K + ey - uy * eAlong;
  }
  let targetAngle: number;
  if (s.far && !mem.braking) targetAngle = Math.atan2(dy, dx);
  else if (Math.hypot(hx, hy) < a * 2 && mem.aim !== null) targetAngle = mem.aim;
  else targetAngle = Math.atan2(hy, hx);
  mem.aim = targetAngle;
  let ix = 0, iy = 0;
  if (err > a * 0.6) {
    // The nearest of the eight screen directions
    const k = Math.round(Math.atan2(ey, ex) / (Math.PI / 4));
    ix = Math.round(Math.cos(k * Math.PI / 4));
    iy = Math.round(Math.sin(k * Math.PI / 4));
  }
  return { ix, iy, targetAngle, err };
}

/** A route's time, for people: "40 s", "2 min 5 s" */
export function etaText(ticks: number): string {
  const s = Math.max(1, Math.round(ticks / 60));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
