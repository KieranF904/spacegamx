/**
 * @contract protocol.mines
 * owns:       the Mine Bay messages: a drop asked for and made (the record every end derives its mines from), mines
 *             gone, magazines changed
 * needs:      type-only import of ships/features/minebay (MineDrop)
 * invariants: every client-sent type here is one the server dispatches, and the set of dispatched types is pinned by
 *             name — server/src/golden/structure.test.ts
 *             the server types the client handles itself are exactly the pinned set (a type with no entry in the
 *             client table fails) — client/src/app/serverMessages.test.ts
 * extend:     a new message is an interface plus a member of this area's client / server union below; then its
 *             handler (server/src/net/handlers) or its entry in client/src/app/serverMessages.ts, and the golden pins
 *             (UPDATE_GOLDEN=1 on structure.test.ts)
 */

/**
 * The Mine Bay on the wire (docs/design/groups-mines-docking.md, "Mine bay"). JSON messages, all decisions or rare
 * events: a drop asked for, a drop made (the record every end derives its mines from: ships/features/minebay/minebay.ts
 * MineDrop), mines gone, and the pilot's magazines when they change. Nothing about a mine is streamed.
 */

import type { MineDrop } from '../ships/features/minebay/minebay.js';

// ============================================ client -> server

/**
 * Drop a batch from the ship's Mine Bays (the key press). The server picks the bay (the fullest ready one). `tick`: the
 * input tick the pilot pressed on (its own predicted tick, as inputs carry); the server drops on that tick when it is
 * still ahead (no more than an input's lead), else at once. Absent: at once
 */
export interface ClientMineDropMessage { type: 'mineDrop'; tick?: number }

export type MinesClientMessage = ClientMineDropMessage;

// ============================================ server -> client

/**
 * A drop made: to every client holding the dropping ship, and again (each live drop) to a client that comes to hold a
 * field it hadn't (its first sight of the owner, entering the system)
 */
export interface ServerMinesLaidMessage extends MineDrop { type: 'minesLaid' }

/** Why a mine went: it went off (`blast`, the triggering ship's id in `by`), fizzled at its life's end or past the cap (`fizzle`), or its owner's field was cleared (`clear`: the owner left or died) */
export type MineEnd = 'blast' | 'fizzle' | 'clear';

/**
 * Mines that went on `tick` (mineId names). A life's end is derived and never sent; the cap's and a clear's fizzles
 * are told at once (rare events). A blast (stage M2) is told only to a client that can't find it itself on its tick
 * layer (common ships/features/minebay/blasts.ts), just before the snapshot that closes the window it went off in.
 * Damage goes the usual way (damage sums and HP)
 */
export interface ServerMinesGoneMessage { type: 'minesGone'; tick: number; ids: number[]; how: MineEnd; by?: number }

/**
 * Mines that did NOT go off on `tick`, though this client's search would find them going off then (a ship only the
 * server knows can't set them off: dormant, jumping, a berthed owner): they stay live, a blast found or predicted for
 * them is taken back, and from now on their ends are told to this client (it no longer searches them). Sent just
 * before the snapshot that closes the window
 */
export interface ServerMinesKeptMessage { type: 'minesKept'; tick: number; ids: number[] }

/**
 * The pilot's own magazines (each Mine Bay's loaded mines by blueprint uid) and when the next drop is ready: sent when
 * they change, and as the answer to a press the server could not drop (`refused`: the client's predicted drop goes).
 * `readyBy`: each bay's own cooldown end (the tick it may drop again), while any is still cooling
 */
export interface ServerMineBayMessage { type: 'mineBay'; loaded: Record<number, number>; readyAt: number; readyBy?: Record<number, number>; refused?: boolean }

export type MinesServerMessage = ServerMinesLaidMessage | ServerMinesGoneMessage | ServerMinesKeptMessage | ServerMineBayMessage;
