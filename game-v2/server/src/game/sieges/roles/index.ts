/**
 * How a siege's hostiles fight, by role (a roster entry's `role`). Without
 * one a ship is sent at the bastion and fights whatever's near, as its
 * faction does. A new role is a file here and an entry in ROLES.
 */

import type { SiegeSpawn } from '../rules.js';
import type { Run, SiegeCtx } from '../types.js';
import { artillery } from './artillery.js';
import { escort } from './escort.js';
import { runner } from './runner.js';
import { sapper } from './sapper.js';

export interface SiegeRole {
  id: string;
  /** Its tuning over the roster's (a ship's reach and aggro) */
  tune?(s: SiegeSpawn): SiegeSpawn;
  /** Just come in: these ships of this role, all from one lot (a front, the stream) */
  onSpawn?(ctx: SiegeCtx, run: Run, eids: number[]): void;
  /** Every step (10 ticks), for each of its ships still flying */
  step?(ctx: SiegeCtx, run: Run, eid: number, now: number): void;
}

export const ROLES: Record<string, SiegeRole> = { artillery, escort, runner, sapper };

// (bastionAt is its own file: the roles import it, and this file imports them)
export { bastionAt } from './bastion.js';
