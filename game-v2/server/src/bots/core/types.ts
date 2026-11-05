/**
 * The bots' shared types. A TASK (bots/tasks) decides what to do from what it can see; a DRIVER (bots/drivers) is how the
 * ship is flown and its station work done. The task never knows which driver it has, so one task runs, and keeps the same
 * stats, whether the ship is a simulated player (client-input driver: real input and station messages on a real
 * connection) or a server-side NPC (npc driver: the server's own pilotless-ship API, no connection).
 */

export type Bag = Record<string, number>;

/** What a trip's time is spent on (BotStats keeps a tally for each) */
export const PHASES = ['setup', 'docked', 'travelOut', 'mining', 'collecting', 'travelBack', 'docking'] as const;
export type Phase = typeof PHASES[number];

export interface Pose { x: number; y: number; vx: number; vy: number; angle: number }

/**
 * The ship's controls, as a player has them: the four move keys (screen-relative, as mouse-steer flies), boost, the aim
 * (the world angle and distance to the cursor) and the mining laser (right mouse). They stay as set until set again.
 */
export interface Controls {
  forward: boolean; backward: boolean; left: boolean; right: boolean; boost: boolean;
  aim: number; aimDist: number; mine: boolean;
}

export const idle = (aim = 0): Controls => ({ forward: false, backward: false, left: false, right: false, boost: false, aim, aimDist: 0, mine: false });

export type DepositMode = 'store' | 'sell';

export interface DepositResult {
  /** What left the hold */
  items: Bag;
  /** Credits received (sell mode; 0 when stored) */
  credits: number;
  /** What the same ore would fetch at this station's market (stored or sold) */
  valueIfSold: number;
}

/** How a ship is flown and what a pilot can do from its seat. The task calls these; nothing else about the server. */
export interface PilotDriver {
  readonly kind: 'client' | 'npc';
  readonly name: string;
  /** The ship's entity id */
  readonly eid: number;
  /** Once a tick, before the task thinks: note what changed (hold, power) */
  observe(): void;
  pose(): Pose;
  radius(): number;
  /** Berthed in a station */
  docked(): boolean;
  /** What is in the hold (ore by id), its capacity and what is free (volume units) */
  hold(): { items: Bag; capacity: number; free: number };
  /** Short of power this tick (a mining laser or engines at less than their draw) */
  brownout(): boolean;
  set(c: Controls): void;
  /** Press dock: true when the station took the ship */
  dock(): boolean;
  undock(): void;
  deposit(mode: DepositMode): DepositResult;
  /** Once a tick, after the task thinks: send what changed */
  flush(): void;
  close(): void;
}
