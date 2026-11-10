/**
 * Debris, worked out alike on the server and every client (docs/areas/networking/crowd-structs-cargo-debris.md "Debris").
 *
 * Debris is transient and harmless (ships pass through it), so it is kept cheap on the wire: when a part's loss splits
 * a ship, each client works out the pieces itself from what it already has (the ship's blueprint, its pose at the
 * split's tick, the parts that left), and only confirms it got the same (an 8-bit hash, ack on its input). Then debris
 * drifts, and knocks into other debris, by the same steps here on both sides: deterministic trig (math/detTrig.ts),
 * pairs in entity id order, push only (no damage). What only the server can know (a shot on debris, a piece crumbling,
 * a blast's shove) still comes from the server; a piece that drifted off what clients have gets a keyframe.
 */

import { dsincos, dhypot } from '../math/detTrig.js';
import { convexPenetration } from './geometry.js';
import { quantizeShipBody, quantizeShipValue } from './physics.js';
import { createShipState, type ShipState } from './state.js';
import { hashInts, seededRng } from './rng.js';
import type { Blueprint, Vec2 } from './types.js';
import type { Catalog } from './catalog.js';
import type { ShipTuning } from './tuning.js';
import type { FlightBody, GravityWell } from './flight.js';

/** A debris body's status row data (snapshot ShipBody row: no kind, no faction, nothing): a client makes it itself */
export const DEBRIS_STATUS: readonly number[] = [0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0];

/** The blueprint a group of a ship's parts leaves as */
export function debrisBlueprint(parent: Blueprint, group: readonly number[]): Blueprint {
  return { name: `${parent.name} debris`, catalogVersion: parent.catalogVersion, parts: group.map((i) => parent.parts[i]) };
}

/** A split's random numbers: seeded by the ship, the tick and which group (both sides draw the same) */
export function splitRng(parentId: number, tick: number, k: number): () => number {
  return seededRng(hashInts(parentId, tick, k));
}

/** The parent as a split sees it: its pose on the replicated grid (what clients step), so both sides start alike */
export function splitPose(x: number, y: number, angle: number, vx: number, vy: number, angVel: number): FlightBody {
  return {
    x: quantizeShipValue('pos', x), y: quantizeShipValue('pos', y), angle: quantizeShipValue('angle', angle),
    vx: quantizeShipValue('vel', vx), vy: quantizeShipValue('vel', vy), angVel: quantizeShipValue('angVel', angVel),
  };
}

/** A piece's spin: the parent's, plus a seeded kick (the split's first random number) */
export function debrisSpin(parentAngVel: number, rng: () => number, pushSpin: number): number {
  return parentAngVel + (rng() - 0.5) * 2 * pushSpin;
}

const SC: [number, number] = [0, 0];

/**
 * Where a piece starts: at its own centre of mass in the parent's frame, moving as that point of the parent did,
 * plus a small seeded push (and `fling`: thrown out from the middle). The random numbers after the spin's (and any
 * crumble times the caller draws first)
 */
export function debrisMotion(pose: FlightBody, parentCom: Vec2, debrisCom: Vec2, cellSize: number, angVel: number,
  rng: () => number, pushSpeed: number, fling = 0): FlightBody {
  // (localToWorldDir with deterministic trig)
  const lx = (debrisCom[0] - parentCom[0]) * cellSize, ly = (debrisCom[1] - parentCom[1]) * cellSize;
  dsincos(pose.angle + Math.PI / 2, SC);
  const rx = lx * SC[1] - ly * SC[0], ry = lx * SC[0] + ly * SC[1];
  const push = pushSpeed * (0.5 + rng());
  const dir = rng() * Math.PI * 2;
  dsincos(dir, SC);
  const pAng = pose.angVel;
  const body: FlightBody = {
    x: pose.x + rx, y: pose.y + ry, angle: pose.angle, angVel,
    vx: pose.vx - pAng * ry + SC[1] * push,
    vy: pose.vy + pAng * rx + SC[0] * push,
  };
  if (fling > 0) {
    const l = dhypot(rx, ry) || 1, f = fling * (0.6 + 0.8 * rng());
    body.vx += (rx / l) * f;
    body.vy += (ry / l) * f;
  }
  quantizeShipBody(body);
  return body;
}

/** The 8-bit check a client sends back for a piece it worked out (its spawn state, on the replicated grid) */
export function debrisHash(b: FlightBody): number {
  const h = hashInts(Math.round(b.x * 100), Math.round(b.y * 100), Math.round(b.vx * 1e4), Math.round(b.vy * 1e4),
    Math.round(b.angle * 1e5), Math.round(b.angVel * 1e6));
  return (h ^ (h >>> 8) ^ (h >>> 16) ^ (h >>> 24)) & 0xff;
}

/** Connected groups of `parts` over the blueprint's joins, in the order a rebuild finds orphans (rebuild.ts components) */
export function partGroups(count: number, joins: readonly [number, number][], parts: ReadonlySet<number>): number[][] {
  const adj: number[][] = Array.from({ length: count }, () => []);
  for (const [a, b] of joins) if (parts.has(a) && parts.has(b)) { adj[a].push(b); adj[b].push(a); }
  const seen = new Array<boolean>(count).fill(false);
  const out: number[][] = [];
  for (let i = 0; i < count; i++) {
    if (seen[i] || !parts.has(i)) continue;
    const group: number[] = [];
    const stack = [i];
    seen[i] = true;
    while (stack.length) {
      const u = stack.pop()!;
      group.push(u);
      for (const v of adj[u]) if (!seen[v]) { seen[v] = true; stack.push(v); }
    }
    group.sort((a, b) => a - b);
    out.push(group);
  }
  return out;
}

/**
 * Parts a ship sheds whole at its rebuild point (a boss's plates, a stage blown away), each group a piece of its own:
 * `fling` each thrown out from the ship's middle this fast, `crumble` each part crumbling within this many ticks (0: as
 * any piece), `aloof` only to be seen (it knocks nothing, nothing hits it). Its pieces come before the split's others
 */
export interface ShedSpec { groups: number[][]; fling: number; crumble: number; aloof: boolean }

/** A shed's crumble times: each part within `crumble` ticks of `tick` (the random numbers after the spin's) */
export function shedCrumble(tick: number, crumble: number, n: number, rng: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(tick + Math.round(crumble * (0.5 + 0.5 * rng())));
  return out;
}

/** Sheds on the wire (debrisSplit `g`): each [fling, crumble, aloof 0/1, then each group as its length and its parts] */
export function packSheds(sheds: readonly ShedSpec[]): number[][] {
  return sheds.map((s) => [s.fling, s.crumble, s.aloof ? 1 : 0, ...s.groups.flatMap((g) => [g.length, ...g])]);
}

export function unpackSheds(rows: readonly (readonly number[])[], max = 4096): ShedSpec[] {
  return rows.map((r) => {
    const groups: number[][] = [];
    for (let i = 3; i < r.length;) {
      const n = Math.max(0, Math.min(max, r[i] | 0));
      groups.push(r.slice(i + 1, i + 1 + n).map((v) => v | 0));
      i += 1 + n;
    }
    return { fling: Number(r[0]) || 0, crumble: r[1] | 0, aloof: !!r[2], groups };
  });
}

/** One piece a client worked out from a split */
export interface DerivedDebris {
  id: number; ship: ShipState; body: FlightBody; hash: number;
  /** The parent's parts it is (its blueprint's, in order) */
  parts: number[];
  /** Shed: each part's crumble time (a shed with its own), and whether it's only to be seen */
  decay?: number[];
  aloof?: boolean;
}

/**
 * A client's side of a split (the server's: ships/bridge/rebuild.ts spawnDebris, with the same functions): the pieces
 * a ship's rebuild point made, as entities `ids` (the server's, in order), at `tick`, from the parent as it was then:
 * first what it shed (`sheds`, each group whole), then `parts` (what then joined nothing, as connected groups).
 * `parent` is the client's copy of the ship before the split (its structure as the server had it then: the caller
 * checks the rebuild count); `pose` its replicated state at `tick`; `hpOf` each part's HP as last sent. null when the
 * groups don't match the ids (the server sends the pieces then).
 */
export function deriveSplit(catalog: Catalog, tuning: ShipTuning, parent: ShipState, parentId: number, tick: number,
  ids: readonly number[], parts: ReadonlySet<number>, joins: readonly [number, number][], pose: FlightBody, hpOf: (part: number) => number,
  sheds: readonly ShedSpec[] = []): DerivedDebris[] | null {
  const shed = sheds.flatMap((s) => s.groups.map((g) => ({ g, s })));
  const groups = [...shed.map((e) => e.g), ...partGroups(parent.blueprint.parts.length, joins, parts)];
  if (groups.length !== ids.length || groups.some((g) => !g.length || g.some((i) => !(i >= 0 && i < parent.blueprint.parts.length)))) return null;
  const p = splitPose(pose.x, pose.y, pose.angle, pose.vx, pose.vy, pose.angVel);
  const out: DerivedDebris[] = [];
  groups.forEach((g, k) => {
    const s = shed[k]?.s;
    const rng = splitRng(parentId, tick, k);
    const spin = debrisSpin(p.angVel, rng, tuning.debris.pushSpin);
    const ship = createShipState(catalog, tuning, ids[k], debrisBlueprint(parent.blueprint, g), tick, { kind: 'debris', hp: g.map(hpOf), angVel: spin });
    const decay = s && s.crumble > 0 ? shedCrumble(tick, s.crumble, g.length, rng) : undefined;
    const body = debrisMotion(p, parent.derived.com, ship.derived.com, tuning.cellSize, spin, rng, tuning.debris.pushSpeed, s?.fling ?? 0);
    ship.angVel = body.angVel;
    out.push({ id: ids[k], ship, body, hash: debrisHash(body), parts: g, decay, aloof: s?.aloof });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Drift and knocks
// ---------------------------------------------------------------------------

/** What drifting needs (flight.ts FlightConstants' share of it) */
export interface DriftConstants { friction: number; worldSize: number; gravity?: GravityWell | null }

/** One tick of a piece of debris drifting: gravity, spin, friction, then rounded (deterministic: no Math trig, no `**`) */
export function stepDebrisBody(body: FlightBody, k: DriftConstants): void {
  const g = k.gravity;
  if (g) {
    const r = Math.sqrt(body.x * body.x + body.y * body.y);
    if (r >= 1e-6) {
      const m = Math.max(r, g.minRadius);
      const a = g.strength / (m * m);
      body.vx -= (body.x / r) * a;
      body.vy -= (body.y / r) * a;
    }
  }
  let a = body.angle + body.angVel;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  body.angle = a;
  body.angVel *= k.friction;
  body.vx *= k.friction;
  body.vy *= k.friction;
  body.x = Math.max(-k.worldSize, Math.min(k.worldSize, body.x + body.vx));
  body.y = Math.max(-k.worldSize, Math.min(k.worldSize, body.y + body.vy));
  quantizeShipBody(body);
}

/**
 * A new piece's grace (ticks after the tick it spawned at): it takes force only from its parent's break-up (its spawn
 * motion) and applies none and receives none from anything else: no knocks (stepDebrisWorld). Its spawn is all a client
 * needs to have its motion exactly, whatever is about; after it, it knocks as any piece does. (Shots still hit it: that
 * is damage, not force, and a piece shot is told from then on)
 */
export const DEBRIS_GRACE_TICKS = 90;

/** Is a piece spawned at tick `born` still in its grace on tick `tick`'s step? */
export function debrisYoung(born: number | undefined, tick: number): boolean {
  return born !== undefined && tick - born <= DEBRIS_GRACE_TICKS;
}

/** A piece of debris for the knocks: its state (stepped in place) and shape */
export interface DebrisBody {
  id: number;
  body: FlightBody;
  mass: number;
  /** Bounding radius, world units */
  radius: number;
  /** Centre of mass, grid units */
  com: Vec2;
  /** Its parts' convex pieces (shrunk, so parts that merely touch don't knock), grid units */
  pieces: readonly (readonly Vec2[])[];
  /** Held where it is this tick (a client's keyframe for it): it pushes, isn't pushed and isn't stepped */
  fixed?: boolean;
  /** The tick it spawned at (its grace: DEBRIS_GRACE_TICKS); unset, none */
  born?: number;
}

interface WorldPiece { poly: Vec2[]; x0: number; x1: number; y0: number; y1: number }

function worldPiecesOf(d: DebrisBody, cs: number): WorldPiece[] {
  const [cx, cy] = d.com;
  dsincos(d.body.angle + Math.PI / 2, SC);
  const s = SC[0], c = SC[1], px = d.body.x, py = d.body.y;
  const out: WorldPiece[] = [];
  for (const piece of d.pieces) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const poly = piece.map(([x, y]) => {
      const lx = (x - cx) * cs, ly = (y - cy) * cs;
      const wx = px + lx * c - ly * s, wy = py + lx * s + ly * c;
      if (wx < x0) x0 = wx;
      if (wx > x1) x1 = wx;
      if (wy < y0) y0 = wy;
      if (wy > y1) y1 = wy;
      return [wx, wy] as Vec2;
    });
    out.push({ poly, x0, x1, y0, y1 });
  }
  return out;
}

/**
 * One tick (`tick`'s step) of every piece of debris in a system: each drifts (stepDebrisBody), then overlapping pieces
 * are pushed apart and bounce, push only, pairs in id order (`list` must be sorted by id); a piece in its grace
 * (debrisYoung) takes no part in the knocks. The same on the server and in every client's replicas. Returns the pairs
 * that touched (the server keyframes a piece whose partner some client lacks).
 */
export function stepDebrisWorld(list: readonly DebrisBody[], k: DriftConstants, cellSize: number, restitution: number, tick?: number): [number, number][] {
  for (const d of list) if (!d.fixed) stepDebrisBody(d.body, k);
  const touched: [number, number][] = [];
  const n = list.length;
  if (n < 2) return touched;
  const pieces: (WorldPiece[] | undefined)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const A = list[i];
    if (tick !== undefined && debrisYoung(A.born, tick)) continue;
    for (let j = i + 1; j < n; j++) {
      const B = list[j];
      if (A.fixed && B.fixed) continue;
      if (tick !== undefined && debrisYoung(B.born, tick)) continue;
      const dx = B.body.x - A.body.x, dy = B.body.y - A.body.y, rr = A.radius + B.radius;
      if (dx * dx + dy * dy > rr * rr) continue;
      const pa = (pieces[i] ??= worldPiecesOf(A, cellSize)), pb = (pieces[j] ??= worldPiecesOf(B, cellSize));
      let deepest: { depth: number; nx: number; ny: number } | null = null;
      for (const p of pa) {
        for (const q of pb) {
          if (p.x1 < q.x0 || q.x1 < p.x0 || p.y1 < q.y0 || q.y1 < p.y0) continue;
          const pen = convexPenetration(p.poly, q.poly);
          if (pen && (!deepest || pen.depth > deepest.depth)) deepest = pen;
        }
      }
      if (!deepest) continue;
      const invA = A.fixed || !(A.mass > 0) ? 0 : 1 / A.mass, invB = B.fixed || !(B.mass > 0) ? 0 : 1 / B.mass;
      if (invA + invB === 0) continue;
      const { nx, ny, depth } = deepest;
      const corr = depth / (invA + invB);
      A.body.x -= nx * corr * invA; A.body.y -= ny * corr * invA;
      B.body.x += nx * corr * invB; B.body.y += ny * corr * invB;
      const vrel = (B.body.vx - A.body.vx) * nx + (B.body.vy - A.body.vy) * ny;
      if (vrel < 0) {
        const jImp = -(1 + restitution) * vrel / (invA + invB);
        A.body.vx -= jImp * invA * nx; A.body.vy -= jImp * invA * ny;
        B.body.vx += jImp * invB * nx; B.body.vy += jImp * invB * ny;
      }
      quantizeShipBody(A.body);
      quantizeShipBody(B.body);
      // (moved: their pieces are worked out afresh for the next pair)
      pieces[i] = pieces[j] = undefined;
      touched.push([A.id, B.id]);
    }
  }
  return touched;
}

// ---------------------------------------------------------------------------
// On the wire (ServerDebrisSplitMessage)
// ---------------------------------------------------------------------------

/** Entity ids as the first, then each as the step from the one before (debris ids come mostly one after another) */
export function packIds(ids: readonly number[]): number[] {
  return ids.map((id, i) => (i ? id - ids[i - 1] : id));
}

export function unpackIds(packed: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < packed.length; i++) out.push(i ? out[i - 1] + packed[i] : packed[i]);
  return out;
}

/** Sorted part indices as runs: [gap before the run, its length, ...] (a ship blown apart is a handful of numbers) */
export function packRuns(parts: readonly number[]): number[] {
  const out: number[] = [];
  let next = 0;
  for (let i = 0; i < parts.length;) {
    let j = i;
    while (j + 1 < parts.length && parts[j + 1] === parts[j] + 1) j++;
    out.push(parts[i] - next, j - i + 1);
    next = parts[j] + 1;
    i = j + 1;
  }
  return out;
}

export function unpackRuns(runs: readonly number[], max = 4096): number[] {
  const out: number[] = [];
  let at = 0;
  for (let i = 0; i + 1 < runs.length; i += 2) {
    at += Math.max(0, runs[i] | 0);
    for (let k = 0; k < (runs[i + 1] | 0) && at < max; k++) out.push(at++);
  }
  return out;
}
