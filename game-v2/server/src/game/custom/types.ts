/**
 * Custom enemies on the server (docs/enemies/custom-roster.md). Their moves are common's (bodies/moves/custom.ts: the
 * same on every client running their bodies); the commander (Enemies' think) picks a move when it may; its body (common
 * bodies/custom) flies it on both sides; what it does to the world (beams, shells, pulls, mines, EMP rings) is done each
 * tick of the move by its explicit steps, through the work the server gives them here (CustomEnemies.act). A piece is
 * read at the tick it acts ("structure at the tick", decision-inputs rule 6): shot off on tick k, it does nothing from
 * tick k + 1.
 */
import type { ServerMessage, MoveOrder, MoveOrigin, CustomStats, CustomMoveState } from '@space-game/common';
import type { ShipBridge } from '../../ships/ShipBridge.js';
import type { Mobs } from '../Mobs.js';

export type { CustomStats };

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
  fire?(owner: number, kind: string, x: number, y: number, angle: number, damageScale: number, opts?: { target?: number; speed?: number; seed?: string }): void;
  send?(systemNum: number, msg: ServerMessage): void;
  /** A move's look, not to the clients that work it out (CAPS.MOVES: GameServer.moveFx) */
  moveFx?(systemNum: number, eid: number, origin: MoveOrigin, msg: ServerMessage): void;
  /** A decision for its body (its pieces gone, GONE: its clients' moves read them on the tick) */
  decide?(eid: number, op: number, args: readonly number[]): void;
  /** A move's straight shell, its row not to the clients that work it out (GameServer.moveShot) */
  moveShot?(owner: number, kind: string, x: number, y: number, angle: number, damageScale: number, speed: number | undefined, seed: string, origin: MoveOrigin): void;
}

/** One custom enemy's life on the server (what its moves left behind: CustomMoveState) */
export interface CustomLive extends CustomMoveState {
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
}
