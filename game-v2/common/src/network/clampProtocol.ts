/**
 * Docking Clamps on the wire (docs/design/groups-mines-docking.md, "Docking clamps"). JSON messages, all decisions or
 * rare events. Whether two clamps are lined up is worked out on each client for the prompt (ships/features/clamp
 * clampLinedUp); the server decides, from both pilots' presses, the lock, a swap of who steers and an undock, and every
 * end steps the joined pair from those records alike.
 */

import type { ClampOffset } from '../ships/features/clamp/clamp.js';

// ============================================ client -> server

/**
 * The dock key pressed: lined up with a ship (`with`, its entity id) on these clamps, ask to lock (or agree to its
 * pilot's ask). The lock happens when both pilots have pressed within CLAMP.pressWindow and the server finds them lined up
 */
export interface ClientClampDockMessage { type: 'clampDock'; with: number; clamp: number; theirs: number }

/** Docked: ask to swap who steers (or agree to the other pilot's ask). Both must press within CLAMP.pressWindow */
export interface ClientClampSwapMessage { type: 'clampSwap' }

/** Docked: let go (either pilot, alone) */
export interface ClientClampUndockMessage { type: 'clampUndock' }

export type ClampClientMessage = ClientClampDockMessage | ClientClampSwapMessage | ClientClampUndockMessage;

// ============================================ server -> client

/** The other pilot pressed (dock or swap) and waits for you: shown in the prompt until `until` (a tick) */
export interface ServerClampAskMessage { type: 'clampAsk'; from: number; what: 'dock' | 'swap'; until: number }

/**
 * Two ships locked (or the steering swapped: the same record with the new leader), from `tick` on: `leader` steers, the
 * other (`follower`) rides at `offset` in its frame (ships/features/clamp clampOffset), clamps `lc` and `fc` (blueprint
 * uids). To every client holding either ship, and again to one that comes to hold them
 */
export interface ServerClampLinkMessage {
  type: 'clampLink';
  tick: number;
  leader: number;
  follower: number;
  lc: number;
  fc: number;
  offset: ClampOffset;
}

/** Why a link broke */
export type ClampBreak = 'undock' | 'death' | 'gone' | 'jump' | 'station' | 'part';

/** The two ships let go on `tick` (each then flies alone from the pose the pair left it at; an undock pushes them apart) */
export interface ServerClampBreakMessage {
  type: 'clampBreak'; tick: number; a: number; b: number; why: ClampBreak;
  /** An undock's push apart on `a` (the leader) on `tick`, world units a tick (`b` gets the reverse); absent: none */
  push?: [number, number];
}

export type ClampServerMessage = ServerClampAskMessage | ServerClampLinkMessage | ServerClampBreakMessage;
