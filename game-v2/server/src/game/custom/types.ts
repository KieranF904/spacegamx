/**
 * Custom enemies on the server (docs/enemies/custom-roster.md): what a design's moves (custom/moves/<id>.ts) are given.
 * The commander (Enemies' think) picks a move when it may; its body (common bodies/custom) flies it on both sides; what
 * it does to the world (beams, shells, pulls, mines, EMP rings) is done here, each tick of the move, by its explicit
 * steps. A piece is read at the tick it acts ("structure at the tick", decision-inputs rule 6): shot off on tick k, it
 * does nothing from tick k + 1.
 */
import type { ServerMessage, MoveOrder } from '@space-game/common';
import type { ShipBridge } from '../../ships/ShipBridge.js';
import type { Mobs } from '../Mobs.js';

/** A design's numbers (factions.json custom.designs) */
export interface CustomStats {
  range: number;
  reach: number;
  firepower: number;
  /** Most HP of each destroyable piece at Mk I */
  hp: Record<string, number>;
  /** Each move's numbers (`every`: ticks between its starts at least) */
  moves: Record<string, Record<string, number>>;
  /** Guns that fire between moves, by the piece they're on: a shell kind, ticks between shots, damage scale, reach */
  guns?: Record<string, { kind: string; every: number; damage: number; reach: number }>;
  /** Anything else a design reads (the Censer's brazier, the Sower's panniers) */
  [extra: string]: unknown;
}

export interface CustomTable {
  grades: { hp: number[]; damage: number[] };
  /** Ship type → design */
  types: Record<string, string>;
  designs: Record<string, CustomStats>;
}

export interface CustomHost {
  tick(): number;
  readonly ships: ShipBridge;
  readonly mobs?: Mobs;
  /** Living pilots in a system */
  players(systemNum: number): number[];
  /** A shot from the ship (tuning.json weapons kind), `damageScale` × the kind's */
  fire?(owner: number, kind: string, x: number, y: number, angle: number, damageScale: number, opts?: { target?: number; speed?: number }): void;
  send?(systemNum: number, msg: ServerMessage): void;
  /** A flash where something comes out of its hull */
  launchFx?(systemNum: number, x: number, y: number): void;
}

/** One custom enemy's life on the server */
export interface CustomLive {
  design: string;
  /** Its place in common bodies/custom/roster.json */
  index: number;
  stats: CustomStats;
  /** Its damage scale (its grade's, factions.json custom.grades) */
  dmg: number;
  move: MoveOrder | null;
  /** No move before this tick */
  next: number;
  /** Its pieces gone as last seen (a bit each) */
  gone: number;
  /** Each gun's next shot */
  guns: Record<string, number>;
  /** What a move left behind (a harpoon's tether, slag pools, shells on their way down) */
  tether?: { target: number; until: number };
  pools?: { x: number; y: number; until: number }[];
  due?: { x: number; y: number; at: number; group: string }[];
}

/** What a design's moves see this tick */
export interface Act {
  eid: number;
  num: number;
  now: number;
  /** Its target (a pilot's ship, or a ward) */
  target: number;
  /** How far its target is */
  d: number;
  live: CustomLive;
  host: CustomHost;
  /** Is this piece still on (now: the structure at this tick) */
  has(group: string): boolean;
  /** Where a piece is in the world (its mount, else its middle) and the way its mount points (null: it's gone, unless `evenGone`) */
  at(group: string, evenGone?: boolean): { x: number; y: number; dir: number } | null;
  rng(): number;
}

export interface DesignMoves {
  /** A move to start now (null: none yet): its index in the common module's moves and its argument */
  pick(a: Act): { move: number; arg: number } | null;
  /** The move under way, `k` ticks in */
  step?(a: Act, move: MoveOrder, k: number): void;
  /** Every tick it's fighting (guns, a tether, pools) */
  always?(a: Act): void;
  /** Pieces it has just lost (a bit each) */
  lost?(a: Act, newly: number): void;
}
