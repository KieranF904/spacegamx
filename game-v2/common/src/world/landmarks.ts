/**
 * @contract common.world.landmarks
 * owns:       landmark tracking ("orbit with"): a system's moving landmarks (orbiting stations, planets, moons, orbiting
 *             stillstones) as plain records, where each is at a tick, each one's tracking zone (inner radius, fade band),
 *             the carry of a point in a zone for one tick (pilots' ships, debris), a loot pod's hold on the zone its anchor
 *             was laid in, the nearest zone a point is in (a save's landmark offset), and the rule's word in the wire hash
 * needs:      data/schemas (types), constants (stationInteractRadius, TICK_RATE), asteroid/orbit (a station's orbit),
 *             math/detTrig, ships/physics (the ship position grid); no I/O, no wall clock, no Math.random
 * invariants: the weight is 1 inside `inner`, 0 at and past `outer`, smooth and monotonic between; a point carried at
 *             weight 1 keeps its offset from the landmark exactly, for any number of ticks; positions are a function of
 *             the record and the tick alone — common/src/world/landmarks.test.ts
 * extend:     a new kind of landmark is a branch in systemLandmarks that fills a record (circles `c` or an orbit `k`);
 *             the step (sim/step.ts) and the save (server game/pilots/persist.ts) read records only. A change to what is
 *             carried or how changes LANDMARK_CARRY_RULE (a protocol bump: network/wireHash.ts)
 *
 * Rules (docs/design/landmark-tracking-2026-11.md): the carry is a displacement, never a velocity: the landmark's own
 * move from tick t - 1 to t (on the ships' position grid), times the weight where the ship stood as t - 1 ended. Zones
 * that overlap: the strongest weight wins, a tie going to the landmark with the smaller inner radius (the list's order).
 * Both ends work it out from the same records (the server builds them once a system; its clients get them in
 * systemInfo), so nothing of it is sent per tick.
 */

import type { LodestoneData, PlanetData, StationData, TrackingData } from '../data/schemas.js';
import { TICK_RATE, stationInteractRadius } from '../constants.js';
import { calcOrbitStateRaw, scaledOrbitTick, stationOrbitTimeScale } from '../asteroid/orbit.js';
import { dcos, dsin } from '../math/detTrig.js';
import { quantizeShipValue } from '../ships/physics.js';

const TICKS_PER_MINUTE = TICK_RATE * 60;

/** A zone's size where the data gives none: `inner` of the landmark's own, the fade band as wide again */
export const LANDMARK_TRACKING = {
  /** The fade band's outer edge, × the inner radius */
  outerFactor: 2,
  /** A planet's or moon's inner radius: this × its radius, and at least its radius + `bodyMargin` (a surface is descended to from within 900 of its edge) */
  bodyFactor: 1.5,
  bodyMargin: 900,
} as const;

/** A moving landmark, as both ends hold it (plain data: it goes in systemInfo as it is) */
export interface Landmark {
  /** `station:<id>`, `planet:<id>`, `moon:<planet id>:<index>`, `stone:<id>`: what a save names it by */
  id: string;
  name: string;
  inner: number;
  outer: number;
  /** Circles about the system centre, summed: [radius, phase, minutes a turn] each (a planet; a planet and its moon) */
  c?: number[];
  /** A station's orbit: [type, semi-major axis, eccentricity, argument of periapsis, mean anomaly at the epoch, epoch tick, clock rate] */
  k?: number[];
  /** Whole world units (a stillstone's spot is: ships/jumpFields.ts lodestonePosition) */
  r?: 1;
}

/** A system's landmarks, by inner radius ascending (the order is the tie-break) */
export type LandmarkSet = readonly Landmark[];

function zone(inner: number, t: TrackingData | undefined): { inner: number; outer: number } {
  const i = Math.max(1, t?.inner ?? inner);
  return { inner: i, outer: Math.max(i + 1, t?.outer ?? i * LANDMARK_TRACKING.outerFactor) };
}

function bodyInner(radius: number): number {
  return Math.max(radius * LANDMARK_TRACKING.bodyFactor, radius + LANDMARK_TRACKING.bodyMargin);
}

/**
 * A system's moving landmarks: its orbiting stations (inner: the docking ring, stationInteractRadius), its planets and
 * their moons (inner: 1.5 × the radius, at least the radius + 900) and its orbiting stillstones (inner: the charging
 * field, size + field). What keeps still has no zone: a ship that keeps still stays by it anyway.
 */
export function systemLandmarks(
  sys: { planets?: readonly PlanetData[]; lodestones?: readonly LodestoneData[] } | null | undefined,
  stations: readonly StationData[],
  jump: { lodestoneSize: number; lodestoneField: number },
): Landmark[] {
  const out: Landmark[] = [];
  for (const st of stations) {
    const o = st.orbit;
    const a = o?.semiMajorAxis ?? 0, type = o?.orbitType ?? 0;
    if (!o || a <= 0 || type === 255 || type === 3) continue;
    // (As the server's station entity holds them: single precision, components.ts Station)
    const k = [type, Math.fround(a), Math.fround(o.eccentricity ?? 0), Math.fround(o.argPeriapsis ?? 0), Math.fround(o.meanAnomaly0 ?? 0), o.epochTick ?? 0,
      Math.fround((o as { timeScale?: number }).timeScale ?? stationOrbitTimeScale(a))];
    out.push({ id: `station:${st.id}`, name: st.name, ...zone(stationInteractRadius(st.radius, st.design), st.tracking), k });
  }
  for (const p of sys?.planets ?? []) {
    const own = [p.orbit.radius, p.orbit.phase, p.orbit.period];
    if (p.orbit.period) out.push({ id: `planet:${p.id}`, name: p.name, ...zone(bodyInner(p.radius), p.tracking), c: own });
    (p.moons ?? []).forEach((m, i) => {
      if (!p.orbit.period && !m.period) return;
      out.push({ id: `moon:${p.id}:${i}`, name: m.name ?? `${p.name} moon ${i + 1}`, ...zone(bodyInner(m.radius), m.tracking), c: [...own, m.distance, m.phase, m.period] });
    });
  }
  for (const l of sys?.lodestones ?? []) {
    if (!l.orbit || !l.orbit.period) continue;
    out.push({ id: `stone:${l.id}`, name: l.name ?? 'Stillstone', ...zone((l.size ?? jump.lodestoneSize) + jump.lodestoneField, l.tracking), c: [l.orbit.radius, l.orbit.phase, l.orbit.period], r: 1 });
  }
  // (Smallest zone first: where two carry alike, the smaller one, the more particular place, wins)
  return out.map((l, i) => ({ l, i })).sort((a, b) => a.l.inner - b.l.inner || a.i - b.i).map((e) => e.l);
}

const AT = { x: 0, y: 0 };

/** Where a landmark is at a tick, as its body is placed (a planet: world/planets.ts; a station: the server's orbit system). Scratch: read before the next call */
export function landmarkAt(l: Landmark, tick: number): { readonly x: number; readonly y: number } {
  let x = 0, y = 0;
  if (l.k) {
    const k = l.k;
    const s = calcOrbitStateRaw(k[0], k[1], k[2], k[3], k[4], k[5], scaledOrbitTick(tick, k[5], k[6]));
    x = s.x; y = s.y;
  } else if (l.c) {
    const c = l.c;
    for (let i = 0; i + 2 < c.length; i += 3) {
      const a = c[i + 2] ? c[i + 1] + (tick / (c[i + 2] * TICKS_PER_MINUTE)) * Math.PI * 2 : c[i + 1];
      x += dcos(a) * c[i]; y += dsin(a) * c[i];
    }
    if (l.r) { x = Math.round(x); y = Math.round(y); }
  }
  AT.x = x; AT.y = y;
  return AT;
}

/** A set's landmarks on the ships' position grid, kept for the last ticks asked (a rollback steps a short span again) */
const SLOTS = 64;
interface Kept { ticks: Float64Array; pos: Float64Array }
const KEPT = new WeakMap<LandmarkSet, Kept>();

/** Offset into the kept positions of tick `tick`'s row: [x0, y0, x1, y1, ...] in the set's order */
function rowOf(set: LandmarkSet, tick: number): number {
  let m = KEPT.get(set);
  const n = set.length;
  if (!m || m.pos.length !== SLOTS * 2 * n) KEPT.set(set, (m = { ticks: new Float64Array(SLOTS).fill(NaN), pos: new Float64Array(SLOTS * 2 * n) }));
  const slot = ((tick % SLOTS) + SLOTS) % SLOTS, at = slot * 2 * n;
  if (m.ticks[slot] !== tick) {
    for (let i = 0; i < n; i++) {
      const p = landmarkAt(set[i], tick);
      m.pos[at + 2 * i] = quantizeShipValue('pos', p.x); m.pos[at + 2 * i + 1] = quantizeShipValue('pos', p.y);
    }
    m.ticks[slot] = tick;
  }
  return at;
}

/** Where landmark `i` of a set is at a (whole) tick, on the ships' position grid: what the carry and a save's offset are measured from */
export function landmarkPosition(set: LandmarkSet, i: number, tick: number): { x: number; y: number } {
  const at = rowOf(set, tick), pos = KEPT.get(set)!.pos;
  return { x: pos[at + 2 * i], y: pos[at + 2 * i + 1] };
}

/**
 * How much of a landmark's move a ship `d` from its centre is carried by: 1 inside `inner`, 0 at and past `outer`, a
 * smoothstep between (continuous in value and slope at both edges, never rising with distance)
 */
export function carryWeight(d: number, inner: number, outer: number): number {
  if (d <= inner) return 1;
  if (d >= outer) return 0;
  const u = (d - inner) / (outer - inner);
  return 1 - u * u * (3 - 2 * u);
}

/** The zone a point is in: which landmark (its index in the set), how strongly, and the point's offset from it */
export interface ZoneAt { i: number; w: number; dx: number; dy: number }

/**
 * The zone holding (x, y) at `tick` (the landmarks where they are at that tick): the strongest weight, the first in
 * the set on a tie. Writes into `out` and returns it, or null where no zone reaches
 */
export function landmarkZoneAt(set: LandmarkSet, tick: number, x: number, y: number, out: ZoneAt = { i: -1, w: 0, dx: 0, dy: 0 }): ZoneAt | null {
  const n = set.length;
  if (!n) return null;
  const at = rowOf(set, tick), pos = KEPT.get(set)!.pos;
  let best = -1, w = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) {
    const l = set[i], dx = x - pos[at + 2 * i], dy = y - pos[at + 2 * i + 1];
    // (A box first: most ships are in no zone at all)
    if (dx >= l.outer || dx <= -l.outer || dy >= l.outer || dy <= -l.outer) continue;
    const d2 = dx * dx + dy * dy;
    if (d2 >= l.outer * l.outer) continue;
    const wi = d2 <= l.inner * l.inner ? 1 : carryWeight(Math.sqrt(d2), l.inner, l.outer);
    if (wi > w) { best = i; w = wi; bx = dx; by = dy; if (wi === 1) break; }
  }
  if (best < 0) return null;
  out.i = best; out.w = w; out.dx = bx; out.dy = by;
  return out;
}

/** One tick's carry: the displacement to add, the landmark it is from and its weight */
export interface Carry { dx: number; dy: number; i: number; w: number }

const ZONE: ZoneAt = { i: -1, w: 0, dx: 0, dy: 0 };

/**
 * Tick `tick`'s carry of a ship that stood at (x, y) as tick - 1 ended: the move from tick - 1 to tick of the landmark
 * whose zone it stood in then, times its weight there. False (and `out` untouched) where it stood in none. A ship that
 * does nothing else and is carried at weight 1 keeps its offset from the landmark exactly: both ends of the move are on
 * the grid the ship's own position is rounded to.
 */
export function landmarkCarry(set: LandmarkSet, tick: number, x: number, y: number, out: Carry): boolean {
  const z = landmarkZoneAt(set, tick - 1, x, y, ZONE);
  if (!z) return false;
  const pos = KEPT.get(set)!.pos, a = rowOf(set, tick - 1) + 2 * z.i;
  const x0 = pos[a], y0 = pos[a + 1];
  const b = rowOf(set, tick) + 2 * z.i;
  out.dx = z.w * (pos[b] - x0); out.dy = z.w * (pos[b + 1] - y0); out.i = z.i; out.w = z.w;
  return true;
}

const CARRY: Carry = { dx: 0, dy: 0, i: -1, w: 0 };

/** landmarkCarry onto a body's position, back on the grid. Returns whether it was carried */
export function carryBody(set: LandmarkSet, tick: number, x: number, y: number, body: { x: number; y: number }): boolean {
  if (!landmarkCarry(set, tick, x, y, CARRY)) return false;
  body.x = quantizeShipValue('pos', body.x + CARRY.dx);
  body.y = quantizeShipValue('pos', body.y + CARRY.dy);
  return true;
}

// ------------------------------------------------------------------------------------------- a save's landmark offset

/** Where a saved pilot was by a landmark (profile.position.at): its id and the pilot's offset from its centre */
export interface LandmarkOffset { id: string; dx: number; dy: number }

/** The landmark offset to save for a pilot at (x, y) at `tick` (in a zone, inner or fade band), or null in open space */
export function landmarkOffsetAt(set: LandmarkSet, tick: number, x: number, y: number): LandmarkOffset | null {
  const z = landmarkZoneAt(set, Math.floor(tick), x, y);
  return z ? { id: set[z.i].id, dx: Math.round(z.dx), dy: Math.round(z.dy) } : null;
}

/** Where a saved landmark offset is at `tick`: the landmark's spot now plus the offset. Null: no such landmark here any more */
export function landmarkOffsetPoint(set: LandmarkSet, tick: number, at: Readonly<LandmarkOffset>): { x: number; y: number } | null {
  const i = set.findIndex((l) => l.id === at.id);
  if (i < 0) return null;
  const p = landmarkPosition(set, i, Math.floor(tick));
  return { x: Math.round(p.x + at.dx), y: Math.round(p.y + at.dy) };
}

// --------------------------------------------------------------------------------------------- loot pods (podDrift)

/**
 * A loot pod's hold on a landmark. A pod is not stepped: both ends place it from its drift anchor (constants.ts
 * podDrift), so its carry is a closed form too: the zone and weight where its anchor was laid, kept until it is
 * anchored again, times the landmark's move since the anchor's tick. A pod dropped in an inner zone stays by the
 * landmark exactly; one dropped in open space is never picked up by a landmark passing later.
 */
export interface PodHold {
  /** The landmark (its index in the set) and the weight at the anchor */
  i: number;
  w: number;
  /** Where the landmark was at the anchor's tick */
  x0: number;
  y0: number;
}

/** The hold of a pod anchored at (x, y) on (whole) tick `tick`, or null in open space */
export function podHold(set: LandmarkSet | undefined, x: number, y: number, tick: number): PodHold | null {
  if (!set?.length) return null;
  const z = landmarkZoneAt(set, tick, x, y, ZONE);
  if (!z) return null;
  const at = landmarkAt(set[z.i], tick);
  return { i: z.i, w: z.w, x0: at.x, y0: at.y };
}

/** How far a held pod has been carried from its anchor by `tick` (any tick, a fraction too: drawing), into `out` */
export function podCarry(set: LandmarkSet, h: Readonly<PodHold>, tick: number, out: { x: number; y: number }): { x: number; y: number } {
  const at = landmarkAt(set[h.i], tick);
  out.x = h.w * (at.x - h.x0); out.y = h.w * (at.y - h.y0);
  return out;
}

/**
 * What is carried and how, as one word in the wire hash (network/wireHash.ts): both ends must step the same rule, so
 * a change to it (who is carried, the weight curve, where in the step, the records' shape) is a protocol bump.
 */
export const LANDMARK_CARRY_RULE = 'v1:pilots+debris(step,strongest,smoothstep,grid.01)+pods(anchor-hold)';
