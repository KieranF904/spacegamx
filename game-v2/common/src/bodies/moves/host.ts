/**
 * Moves on both sides (decision-inputs stage 4, CAPS.MOVES; docs/design/decision-inputs.md): what a boss's or a custom
 * enemy's move reads and does, tick by tick, as a host each side implements. The server runs a move once, for real; a
 * client running the boss's body runs the same move from the same decision (move, argument, seed) on its tick-aligned
 * layer, and draws what it gives (telegraphs, beams, glows, strikes' looks, launch flashes, straight shots) instead of
 * being sent them.
 *
 *   reads    the tick, its own pose as its step reads it, another ship's (a pilot's: after its own step, before that
 *            tick's pulls and contacts), its structure (parts on and working), the system's rock
 *   fx       a message every client draws (bossTelegraph, bossBeam, detonation, effect): the server sends it to the
 *            clients that don't work it out, a client running the move makes it itself
 *   shoot    a straight shell (its spread seeded by its owner, tick and place in the tick: both sides alike)
 *   cap      the density cap's shots kept (it reads every pilot near: the server's, sent as a CAP decision when it drops any)
 *   work     what only the server does: damage, pulls, homing shells, mobs, messages a hit sets off. Absent on a client
 *   origin   the tick of the decision what it does now comes of (a move's MOVE, a HARASS, a PERSONAL, a custom move's
 *            start): the server sends it to a client that started running the body after that tick
 *
 * A move never reads the server's RNG: its rolls come from its decision's seed (moveRng).
 */
import type { ServerMessage } from '../../network/protocol.js';
import type { Catalog } from '../../ships/catalog.js';
import type { ShipState } from '../../ships/state.js';
import type { PlacedGeom } from '../../ships/grid.js';
import type { Terrain } from '../../terrain.js';
import { hashInts, mulberry32 } from '../../math/rng.js';
import { isRuined } from '../../ships/stages.js';
import type { PullDecl } from '../../sim/pullFields.js';

export interface MovePose { x: number; y: number; angle: number; vx: number; vy: number }

/** A straight shell: its kind, from where, which way, its damage scale (× its kind's), × its kind's speed (a cannon's) */
export interface MoveShot { kind: string; x: number; y: number; angle: number; scale: number; speed?: number }

/** How a hit hurts (damage.ts) */
export interface MoveHurt { type: 'kinetic' | 'thermal'; pen: number }

/** What only the server does */
export interface MoveWork {
  /** Living pilots in its system */
  players(): number[];
  /** The part of a pilot's ship a segment crosses within a half-width (-1: none) */
  segmentHit(id: number, x0: number, y0: number, x1: number, y1: number, half: number): number;
  damage(id: number, part: number, amount: number, how: MoveHurt): void;
  splash(x: number, y: number, radius: number, amount: number): void;
  /** A push on a ship's velocity that isn't a pull field (a pull on anything but a pilot: the server's alone) */
  push(id: number, dx: number, dy: number): void;
  /**
   * A pull on the next tick (sim/pullFields.ts: a field every pilot's step works out, on every end; `key` names it
   * among this body's). Said every tick it goes on; the first time, its record goes to every client of the system
   */
  pull?(key: string, d: PullDecl): void;
  /** A homing shell (its guide is the server's: a row, or a guide SYNC) */
  homing(kind: string, x: number, y: number, angle: number, scale: number, target: number): void;
  /** A mob out of it (-1: none) */
  mob(kind: string, x: number, y: number, angle: number, speed: number, scale: number, target?: number): number;
  /** A message every client gets: what a hit set off (a strike's flash on the ship it struck) */
  say(msg: ServerMessage): void;
  /** Its damage scale (its def's damage × rage) */
  readonly damageScale: number;
}

export interface MoveHost {
  tick(): number;
  /** Its own pose as its step reads it (before its own step this tick) */
  me(): MovePose;
  /** Another ship as its step reads it (null: not held) */
  pose(id: number): MovePose | null;
  /** Its structure */
  ship(): ShipState;
  readonly catalog: Catalog;
  geometry(ship: ShipState): PlacedGeom[];
  readonly cellSize: number;
  terrain(): Terrain | null | undefined;
  fx(msg: ServerMessage): void;
  shoot(s: MoveShot): void;
  /** Of a volley's shots (out of (x, y) along `angles`), the ones kept by the density cap */
  cap(x: number, y: number, angles: number[]): number[];
  /** Can it launch mobs (the server: if it has any; a client: as the server's decision said) */
  readonly mobs: boolean;
  /**
   * A part's state at the tick (PART_STATE bits), as its PART decisions said (a client: part damage is the server's).
   * Absent: its structure as it is (the server's, live)
   */
  part?(i: number): number;
  work?: MoveWork;
  /** The decision what it does now comes of */
  origin: MoveOrigin;
}

/**
 * The decision what a move does comes of: its tick, and whose it is (a personal attack's or a harassing shot's pilot: only
 * that pilot's client works it out; -1 any client running the body). The server sends what it does to a client that
 * isn't running the body, began running it after that tick, or isn't `who`
 */
export interface MoveOrigin { readonly t: number; readonly who: number }
/** What no client works out (it goes from the server to every client) */
export const NO_ORIGIN: MoveOrigin = { t: -Infinity, who: -1 };

/** A staged boss's part as its moves read it (a PART decision's state): gone (shot off, shed), a wreck (a ruin piece worn out) */
export const PART_STATE = { GONE: 1, RUINED: 2 } as const;

/** A part's state on a ship (PART_STATE bits) */
export function partState(catalog: Catalog, ship: ShipState, i: number): number {
  return (ship.derived.alive[i] ? 0 : PART_STATE.GONE) | (isRuined(catalog, ship, i) ? PART_STATE.RUINED : 0);
}

/** A move's rolls: drawn from its decision's seed and the tick it started, never the server's RNG */
export function moveRng(seed: number, tick: number, salt = 0): () => number {
  return mulberry32(hashInts(seed & 0xffff, tick, salt, 0x6d0e));
}

/** A shell's seed (Weapons.spawn `seed`): its owner, its tick, its place among that owner's shells that tick */
export function moveShotSeed(owner: number, tick: number, n: number): string {
  return `m${owner}:${tick}:${n}`;
}

/**
 * The density cap (rework 2.3): of a volley's shots (out of (x, y) along `angles`), those kept so no pilot has more than
 * `most` passing within `r` of it; past that a volley's later shots are dropped (its order: the same every run).
 * `pilots`: their positions, in the order they count
 */
export function densityCap(x: number, y: number, angles: readonly number[], pilots: readonly { x: number; y: number }[], most: number, r: number,
  cos: (a: number) => number, sin: (a: number) => number, hyp: (a: number, b: number) => number): number[] {
  const near = pilots.map(() => 0);
  return angles.filter((a) => {
    const ux = cos(a), uy = sin(a);
    const hits = pilots.map((q) => {
      const dx = q.x - x, dy = q.y - y, along = dx * ux + dy * uy;
      return along > -r && hyp(dx - ux * Math.max(0, along), dy - uy * Math.max(0, along)) < r;
    });
    if (hits.some((h, k) => h && near[k] >= most)) return false;
    hits.forEach((h, k) => { if (h) near[k]++; });
    return true;
  });
}

/** The angles a CAP decision's mask drops (bit i: the i-th angle dropped) */
export function capMask(angles: readonly number[], kept: readonly number[]): number {
  let m = 0, j = 0;
  for (let i = 0; i < angles.length && i < 30; i++) {
    if (j < kept.length && kept[j] === angles[i]) j++;
    else m |= 1 << i;
  }
  return m;
}

export function uncap(angles: readonly number[], mask: number): number[] {
  return angles.filter((_, i) => i >= 30 || !(mask & (1 << i)));
}
