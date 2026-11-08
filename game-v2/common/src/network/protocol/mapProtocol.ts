/**
 * @contract protocol.map
 * owns:       system-map dots, routes, info and populations messages and their pack/unpack helpers
 * needs:      ships/farRoute (Leg, Patrol, PatrolState)
 * invariants: pack and unpack are inverse — common/src/network/protocol.test.ts
 * extend:     a new map field is a stride constant plus pack and unpack helpers here
 */
import { patrolFrom, type Leg, type Patrol, type PatrolState } from '../../ships/farRoute.js';
export interface ServerMapDotsMessage {
  type: 'mapDots';
  tick: number;
  dots: number[];
  routes?: number[];
  info?: number[];
  gone?: number[];
  names?: (number | string)[];
  full?: 1;
  pts?: number[];
}
export const MAP_PT_STRIDE = 3;
/** A hostile whose tier is due goes again only once it has moved this far (world units): one sitting still costs nothing */
export const MAP_PT_SLACK = 60;

/**
 * Hostile populations of the client's system (common world/populations.ts): which of each nest's and zone's packs'
 * ships are alive, each pack's group, and whether it's loaded (real ships, sent as ships) or a ghost (the client works
 * out where it is). `p`: for each spawner that changed, [spawner index, slots, ...a packPopSlot code a slot]; `full`:
 * every spawner (a new system or connection): what isn't in it is all dead. Sent only when something changes: a
 * death, a ship back, a pack loaded or put back.
 */
export interface ServerPopsMessage {
  type: 'pops';
  p: number[];
  full?: 1;
  /** Nomads' lures of the spawners in `p` that have one: [spawner index, l1, s1, l2, s2] each (common Lure, packLure) */
  n?: number[];
}
export const MAP_DOT_STRIDE = 8;
export const MAP_ROUTE_STRIDE = 13;
export const MAP_INFO_STRIDE = 3;
/** How far a live ship's dot may stray from where the client carries it before it's sent again (world units) */
export const MAP_DOT_SLACK = 250;

/** What a map dot is (MAP_INFO rows, decoded) */
export interface MapDot { id: number; kind: number; rank: number; calm: boolean; faction: number; rating: number }

/** A ship's leg as the map is sent it (rounded: what the client will have) */
export function packMapLeg(out: number[], id: number, l: Leg): void {
  out.push(id, Math.round(l.x / 10), Math.round(l.y / 10), Math.round(l.vx * 100), Math.round(l.vy * 100),
    Math.round(l.wx * 100), Math.round(l.wy * 100), l.thrust < 0 ? -1 : Math.round(l.thrust));
}

export function unpackMapLegs(dots: number[]): { id: number; leg: Leg }[] {
  const out: { id: number; leg: Leg }[] = [];
  for (let i = 0; i + MAP_DOT_STRIDE <= dots.length; i += MAP_DOT_STRIDE) {
    out.push({ id: dots[i], leg: { x: dots[i + 1] * 10, y: dots[i + 2] * 10, vx: dots[i + 3] / 100, vy: dots[i + 4] / 100,
      wx: dots[i + 5] / 100, wy: dots[i + 6] / 100, thrust: dots[i + 7] } });
  }
  return out;
}

/** A patrolling ship's route as the map is sent it (`tick`: the message's) */
export function packMapRoute(out: number[], id: number, tick: number, p: Patrol, s: PatrolState): void {
  out.push(id, tick - s.t0, s.from.x, s.from.y, s.from.vx, s.from.vy, s.tx, s.ty, p.hx, p.hy, p.roam, p.speed, s.seed);
}

export function unpackMapRoutes(routes: number[], tick: number): { id: number; patrol: Patrol; state: PatrolState }[] {
  const out: { id: number; patrol: Patrol; state: PatrolState }[] = [];
  for (let i = 0; i + MAP_ROUTE_STRIDE <= routes.length; i += MAP_ROUTE_STRIDE) {
    const r = (k: number) => routes[i + k];
    const patrol: Patrol = { hx: r(8), hy: r(9), roam: r(10), speed: r(11) };
    out.push({ id: r(0), patrol, state: patrolFrom(patrol, tick - r(1), { x: r(2), y: r(3), vx: r(4), vy: r(5) }, r(6), r(7), r(12)) });
  }
  return out;
}

export function mapDotFlags(d: Omit<MapDot, 'id' | 'rating'>): number {
  return (d.kind & 7) | ((d.rank & 3) << 3) | (d.calm ? 32 : 0) | ((d.faction + 1) << 6);
}

export function packMapInfo(out: number[], d: MapDot): void {
  out.push(d.id, mapDotFlags(d), Math.round(d.rating));
}

export function unpackMapInfo(info: number[]): MapDot[] {
  const out: MapDot[] = [];
  for (let i = 0; i + MAP_INFO_STRIDE <= info.length; i += MAP_INFO_STRIDE) {
    const f = info[i + 1];
    out.push({ id: info[i], kind: f & 7, rank: (f >> 3) & 3, calm: (f & 32) !== 0, faction: (f >> 6) - 1, rating: info[i + 2] });
  }
  return out;
}

/** One of a station's defence turrets fired on a hostile ship (for the effect) */
