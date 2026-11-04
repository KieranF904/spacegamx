/**
 * Custom enemies' bodies (docs/enemies/custom-roster.md): what a design's module (bodies/custom/<id>.ts) is given and
 * changes. A custom enemy flies on the enemy AI's pilot (bodies/aiPilot.ts) with an order of its own (CUSTOM:
 * bodies/custom/order.ts); its module changes that flight by the move it's making and the pieces it has lost. Pure of
 * its inputs, detTrig maths only, the same on the server and on a client's tick-aligned layer (CAPS.PILOTS).
 */

import type { WantRec } from '../decisions.js';
import type { BodyPose } from '../stagedFlight.js';

/** What the pilot flies with this tick before the module changes it: its motion (screen axes, -1..1), heading, boost */
export interface CustomFlight { mx: number; my: number; face: number; boost: boolean }

/** A custom enemy's step, as its module reads it */
export interface CustomCtx {
  w: WantRec;
  id: number;
  t: number;
  me: BodyPose;
  tgt: BodyPose;
  /** Its pieces gone as the commander last saw them (a bit a group: bodies/custom/roster.json order) */
  gone: number;
  /** The move under way (its index in the module's `moves`; -1: none) and how many ticks into it */
  move: number;
  k: number;
  /** The move's argument (an angle in the 13-bit aim quantisation, or a small number) and its 8-bit seed */
  arg: number;
  seed: number;
}

/** One move: its name (the stats table's key, factions.json custom) and how long it lasts (ticks) */
export interface MoveSpec { name: string; ticks: number }

export interface CustomDesign {
  /** Its design (bodies/custom/roster.json) */
  id: string;
  moves: readonly MoveSpec[];
  /** Its fighting range and reach as its pieces leave it (default: as ordered) */
  ranges?(c: CustomCtx, range: number, reach: number): [number, number];
  /** This tick's flight: the enemy AI's (`f`), changed by its move and what it has lost */
  fly?(c: CustomCtx, f: CustomFlight): void;
}
