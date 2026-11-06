/**
 * The autopilot's route through a system: a few waypoints round what's in
 * the way, and how long it takes with the jump drive.
 *
 * What's in the way is a handful of big circles: the star (or black hole) and
 * its heat, planets and moons, stations, hostile packs you can see, nests out
 * past the safe band, bosses' lairs. The route is the shortest path on the
 * visibility graph round them (a ring of points just outside each circle),
 * with a little extra cost for the dangerous bands so it keeps to safer space
 * when that's no great detour.
 *
 * Time is worked out by running the drive along the route: fly (boosting),
 * jump whenever the drive is ready and a jump beats flying the rest of the
 * leg, and fly on while it cools down (faster in a star's charging ring). A
 * route can call at a stillstone ("lodestone" in the code) on the way: the
 * drive charges there and its next jump reaches further (less at a scarred
 * one; a dead or shattered one has no field). It's taken only when that's
 * quicker overall, and never at one that's camped.
 *
 * Pure (no DOM, no state): Autopilot builds the inputs and follows the plan.
 */

import {
  planetPosition, moonOffset, nestPosition, nestReach, lodestonePosition, lodestoneLive, lodestoneChargeOf, lodestoneFieldRadius,
  inSolarRing, fieldRangeBoost, type StarSystemData, type JumpTuning, type LodestoneData,
} from '@space-game/common';
import bossData from '../../../data/bosses.json';

export interface XY { x: number; y: number }

export type ObstacleKind = 'star' | 'planet' | 'station' | 'pack' | 'boss' | 'nest';
export interface Obstacle { x: number; y: number; r: number; kind: ObstacleKind }

/** A hostile ship you can see (ShipBody kind 3): rank 2 a boss; calm, a passive pack nobody's provoked */
export interface SeenHostile { x: number; y: number; rank: number; calm: boolean }

/** The ship as the route sees it */
export interface PlanShip {
  /** Average flying speed (world units / tick, boosting as the batteries allow) */
  vFly: number;
  /** The jump drive (null: none, or don't use it) */
  drive: DriveModel | null;
}

export interface DriveModel {
  jt: JumpTuning;
  /** Its own reach (unboosted) and cooldown (ticks) */
  range: number;
  cooldown: number;
  /** Now: ticks until it's ready (0: ready), and ticks of a stillstone's priming left (negative: a scarred one's) */
  cool: number;
  primed: number;
}

export interface RouteLeg { from: XY; to: XY; mode: 'fly' | 'jump' }

export interface RoutePlan {
  /** Waypoints after the start; the last is the goal */
  points: XY[];
  /** Which of them is a stillstone it calls at (-1: none), which one, and how far from its centre to hold (inside its field, off the stone) */
  lodestone: number;
  lodestoneName?: string;
  lodestoneData?: LodestoneData;
  lodestoneHold?: number;
  /** How it goes (fly and jump stretches) and how long (ticks) */
  legs: RouteLeg[];
  eta: number;
  /** What it routed round */
  obstacles: Obstacle[];
}

/** Ticks a jump takes beyond its spool and burn before you're on your way again (the coast's tail) */
export const JUMP_SETTLE = 50;
/** Clearance round obstacles' waypoints (world units, beyond their own berth) */
const NODE_PAD = 400;
/** Waypoints round each obstacle */
const RING = 8;
/** Extra cost per unit flown in a band of this danger */
const DANGER_COST: Record<string, number> = { safe: 0, contested: 0.1, hostile: 0.3 };

const BOSSES = (bossData as { bosses: Record<string, { system?: string; lair?: XY }> }).bosses;

/** The star's berth: its surface plus its heat (hazards.json nearStar) and a margin; a black hole's pull further */
export function starBerth(sys: Pick<StarSystemData, 'centralBody' | 'starRadius'> | undefined): number {
  const cb = sys?.centralBody as { type?: string; radius?: number; gravity?: { horizon?: number } } | undefined;
  if (!cb || cb.type === 'none') return 0;
  const r = Math.max(cb.gravity?.horizon ?? 0, cb.radius ?? sys?.starRadius ?? 0);
  if (r <= 0) return 0;
  return cb.type === 'black_hole' ? r + 2500 + 4000 : r + 1500 + 1500;
}

/** How dangerous the band at this distance from the centre is */
export function bandDanger(sys: Pick<StarSystemData, 'regions'> | undefined, r: number): string {
  const regions = sys?.regions;
  if (!regions?.length) return 'safe';
  for (const g of regions) if (r <= g.outer) return g.danger;
  return regions[regions.length - 1].danger;
}

/** Everything in the way in a system now */
export function systemObstacles(
  sys: StarSystemData | undefined, tick: number, hostiles: readonly SeenHostile[], stations: readonly (XY & { r: number })[],
): Obstacle[] {
  const out: Obstacle[] = [];
  const star = starBerth(sys);
  if (star > 0) out.push({ x: 0, y: 0, r: star, kind: 'star' });
  for (const p of sys?.planets ?? []) {
    const at = planetPosition(p, tick);
    out.push({ x: at.x, y: at.y, r: p.radius + 700, kind: 'planet' });
    p.moons?.forEach((m, i) => {
      const o = moonOffset(p, i, tick);
      out.push({ x: at.x + o.x, y: at.y + o.y, r: (m.radius ?? 300) + 400, kind: 'planet' });
    });
  }
  for (const s of stations) out.push({ x: s.x, y: s.y, r: s.r + 500, kind: 'station' });
  // Nests out past the safe band: their packs are about
  for (const n of sys?.nests ?? []) {
    const reach = nestReach(n, sys?.planets);
    if (bandDanger(sys, (reach.min + reach.max) / 2) === 'safe') continue;
    const at = nestPosition(n, sys?.planets, tick);
    out.push({ x: at.x, y: at.y, r: 3500, kind: 'nest' });
  }
  for (const b of Object.values(BOSSES)) {
    if (sys && b.system === sys.id && b.lair) out.push({ x: b.lair.x, y: b.lair.y, r: 6000, kind: 'boss' });
  }
  // Packs: hostiles close together go round as one
  const packs: { x: number; y: number; n: number; spread: number; boss: boolean; calm: boolean; members: SeenHostile[] }[] = [];
  for (const h of hostiles) {
    const near = packs.find((p) => Math.hypot(p.x - h.x, p.y - h.y) < 3000);
    if (near) {
      near.members.push(h);
      near.x += (h.x - near.x) / (near.n + 1); near.y += (h.y - near.y) / (near.n + 1); near.n++;
      near.boss ||= h.rank === 2; near.calm &&= h.calm;
    } else packs.push({ x: h.x, y: h.y, n: 1, spread: 0, boss: h.rank === 2, calm: h.calm, members: [h] });
  }
  for (const p of packs) {
    const spread = Math.max(0, ...p.members.map((m) => Math.hypot(m.x - p.x, m.y - p.y)));
    const berth = p.boss ? 6000 : p.calm ? 1200 : 3500;
    out.push({ x: p.x, y: p.y, r: spread + berth, kind: p.boss ? 'boss' : 'pack' });
  }
  return out;
}

/** Does the segment a→b pass inside any of the circles (each grown by `pad`)? */
export function segmentClear(a: XY, b: XY, obstacles: readonly Obstacle[], pad = 0): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  for (const o of obstacles) {
    const r = o.r + pad;
    let t = len2 > 0 ? ((o.x - a.x) * dx + (o.y - a.y) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + dx * t - o.x, py = a.y + dy * t - o.y;
    if (px * px + py * py < r * r) return false;
  }
  return true;
}

/** Inside any of them? */
export function insideAny(p: XY, obstacles: readonly Obstacle[], pad = 0): Obstacle | null {
  for (const o of obstacles) if (Math.hypot(p.x - o.x, p.y - o.y) < o.r + pad) return o;
  return null;
}

/** Ticks a jump of the drive takes, start to on your way (the same however far it goes: flight.ts jumpChargeNeed) */
export function jumpTicks(jt: JumpTuning): number {
  return jt.chargeTicks + jt.burnTicks + JUMP_SETTLE;
}

/** Is it worth jumping `left` along a leg now (the drive ready), rather than flying it? */
export function jumpPays(left: number, ship: PlanShip): boolean {
  const d = ship.drive;
  return !!d && left >= d.jt.minRange && jumpTicks(d.jt) < left / Math.max(1, ship.vFly);
}

/**
 * Run the drive along a route from `start` through `points`: how it goes and
 * how long it takes. At the stillstone (index; `lode` is which), the drive is
 * primed and, if it's cooling down, it waits there while the field charges it.
 */
export function routeTime(
  start: XY, points: readonly XY[], ship: PlanShip, sys: Pick<StarSystemData, 'centralBody'> | undefined, lodestone = -1, lode?: LodestoneData,
): { eta: number; legs: RouteLeg[] } {
  const legs: RouteLeg[] = [];
  const push = (from: XY, to: XY, mode: 'fly' | 'jump') => {
    const last = legs[legs.length - 1];
    if (last && last.mode === 'fly' && mode === 'fly' && last.to.x === from.x && last.to.y === from.y) last.to = to;
    else legs.push({ from, to, mode });
  };
  const v = Math.max(1, ship.vFly), d = ship.drive;
  let t = 0, cool = d?.cool ?? 0, primed = d?.primed ?? 0;
  let at = start;
  points.forEach((p, i) => {
    const L = Math.hypot(p.x - at.x, p.y - at.y);
    const ux = (p.x - at.x) / Math.max(1e-6, L), uy = (p.y - at.y) / Math.max(1e-6, L);
    let s = 0;
    const pos = (k: number): XY => (k >= L ? p : { x: at.x + ux * k, y: at.y + uy * k });
    for (let guard = 0; s < L - 1 && guard < 100; guard++) {
      const left = L - s, here = pos(s);
      if (d && cool <= 0 && jumpPays(left, ship)) {
        const reach = d.range * fieldRangeBoost(inSolarRing(here.x, here.y, sys?.centralBody, d.jt), primed, d.jt);
        const k = Math.min(reach, left);
        push(here, pos(s + k), 'jump');
        t += jumpTicks(d.jt); s += k; primed = 0;
        cool = d.cooldown - JUMP_SETTLE;
        continue;
      }
      // Fly: the rest of the leg, or until the drive's ready when a jump would pay then
      let k = left;
      if (d && cool > 0 && left >= d.jt.minRange) {
        const rate = 1 + (inSolarRing(here.x, here.y, sys?.centralBody, d.jt) ? d.jt.solarCharge : 0);
        k = Math.min(left, (cool / rate) * v);
      }
      const ticks = k / v;
      const rate = d && inSolarRing(here.x, here.y, sys?.centralBody, d.jt) ? 1 + d.jt.solarCharge : 1;
      push(here, pos(s + k), 'fly');
      t += ticks; s += k; cool = Math.max(0, cool - ticks * rate); primed = primed > 0 ? Math.max(0, primed - ticks) : Math.min(0, primed + ticks);
    }
    if (i === lodestone && d) {
      primed = lode?.state === 'scarred' ? -d.jt.lodestonePrimeTicks : d.jt.lodestonePrimeTicks;
      if (cool > 0) { t += cool / (1 + (lode ? lodestoneChargeOf(lode, d.jt) : d.jt.lodestoneCharge)); cool = 0; }
    }
    at = p;
  });
  return { eta: t, legs };
}

/** The extra cost of flying a→b through dangerous bands */
function dangerCost(a: XY, b: XY, sys: StarSystemData | undefined): number {
  if (!sys?.regions?.length) return 0;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let k = 0;
  const n = 6;
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n;
    k += DANGER_COST[bandDanger(sys, Math.hypot(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f))] ?? 0;
  }
  return (len * k) / n;
}

/** A stillstone it's safe to call at: not in the star's berth, nor near a nest, a boss or a pack */
function lodestoneSafe(p: XY, obstacles: readonly Obstacle[]): boolean {
  for (const o of obstacles) {
    const d = Math.hypot(p.x - o.x, p.y - o.y);
    if (o.kind === 'star' || o.kind === 'planet' || o.kind === 'station' ? d < o.r : d < o.r + 2500) return false;
  }
  return true;
}

/**
 * Plan a route from `from` to `to`. Circles the start or the goal is inside
 * shrink to just short of them (you can always fly straight out, or straight in).
 */
export function planRoute(opts: {
  sys: StarSystemData | undefined; tick: number; from: XY; to: XY; ship: PlanShip; obstacles: Obstacle[];
  /** Don't call at stillstones (for comparison) */
  noLodestones?: boolean;
}): RoutePlan {
  const { sys, from, to, ship } = opts;
  const obstacles = opts.obstacles.map((o) => {
    const ds = Math.hypot(from.x - o.x, from.y - o.y), dg = Math.hypot(to.x - o.x, to.y - o.y);
    const r = Math.min(o.r, ds * 0.97, dg * 0.97);
    return r === o.r ? o : { ...o, r };
  }).filter((o) => o.r > 50);

  // Nodes: start, goal, safe stillstones with a field (not dead or shattered), and a ring round each obstacle (circumscribing it, plus clearance)
  const nodes: XY[] = [from, to];
  const lode: { node: number; name: string; data: LodestoneData }[] = [];
  if (ship.drive && !opts.noLodestones) {
    for (const l of sys?.lodestones ?? []) {
      if (!lodestoneLive(l)) continue;
      const p = lodestonePosition(l, opts.tick);
      if (!lodestoneSafe(p, opts.obstacles)) continue;
      lode.push({ node: nodes.length, name: l.name ?? ship.drive.jt.lodestoneName, data: l });
      nodes.push(p);
    }
  }
  const ringR = 1 / Math.cos(Math.PI / RING);
  for (const o of obstacles) {
    for (let k = 0; k < RING; k++) {
      const a = (k / RING) * Math.PI * 2 + 0.3;
      const p = { x: o.x + Math.cos(a) * (o.r + NODE_PAD) * ringR, y: o.y + Math.sin(a) * (o.r + NODE_PAD) * ringR };
      if (!insideAny(p, obstacles)) nodes.push(p);
    }
  }
  const n = nodes.length;
  // Edge costs, worked out as Dijkstra needs them (and kept for the second search)
  const cost = new Float64Array(n * n).fill(-1);
  const edge = (i: number, j: number): number => {
    const k = i < j ? i * n + j : j * n + i;
    if (cost[k] < 0) {
      const a = nodes[i], b = nodes[j];
      cost[k] = segmentClear(a, b, obstacles) ? Math.hypot(b.x - a.x, b.y - a.y) + dangerCost(a, b, sys) : Infinity;
    }
    return cost[k];
  };
  const search = (src: number) => {
    const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    dist[src] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0) break;
      done[u] = 1;
      for (let v = 0; v < n; v++) {
        if (done[v]) continue;
        const c = edge(u, v);
        if (c === Infinity) continue;
        if (best + c < dist[v]) { dist[v] = best + c; prev[v] = u; }
      }
    }
    return { dist, prev };
  };
  const chain = (prev: Int32Array, end: number): number[] => {
    const out: number[] = [];
    for (let i = end; i >= 0; i = prev[i]) out.push(i);
    return out.reverse();
  };
  const fromS = search(0);
  if (!Number.isFinite(fromS.dist[1])) {
    // Boxed in (shouldn't happen): straight there
    const r = routeTime(from, [to], ship, sys);
    return { points: [to], lodestone: -1, legs: r.legs, eta: r.eta, obstacles };
  }
  const direct = chain(fromS.prev, 1).slice(1).map((i) => nodes[i]);
  const dr = routeTime(from, direct, ship, sys);
  let plan: RoutePlan = { points: direct, lodestone: -1, legs: dr.legs, eta: dr.eta, obstacles };
  if (lode.length) {
    const fromG = search(1);
    for (const l of lode) {
      if (fromS.dist[1] * 1.6 < fromS.dist[l.node] + fromG.dist[l.node]) continue;
      const there = chain(fromS.prev, l.node).slice(1);
      const on = chain(fromG.prev, l.node).reverse().slice(1);
      const points = [...there, ...on].map((i) => nodes[i]);
      const r = routeTime(from, points, ship, sys, there.length - 1, l.data);
      // (A real saving, or it isn't worth the detour)
      if (r.eta < plan.eta * 0.97 && r.eta < dr.eta - 30) {
        const jt = ship.drive!.jt, hold = lodestoneFieldRadius(l.data, jt) - jt.lodestoneField * 0.5;
        plan = { points, lodestone: there.length - 1, lodestoneName: l.name, lodestoneData: l.data, lodestoneHold: hold, legs: r.legs, eta: r.eta, obstacles };
      }
    }
  }
  return plan;
}
