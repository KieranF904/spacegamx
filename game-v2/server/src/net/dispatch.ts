/**
 * @contract server.net.dispatch
 * owns:       client message dispatch: the drops and limits every message passes, and the one handler per message
 *             type
 * needs:      @space-game/common ClientMessage (type), ServerCtx and ClientConnection (type-only), the gun range's
 *             message gate (game/gunRange/messageGate.ts); nothing from GameServer at runtime
 * invariants: the handler table is exactly the pinned set of client types — server/src/net/dispatch.test.ts
 *             non-messages, pre-join and rate-limited messages are dropped, and an expired guest's all but registering; a second handler for a type is refused —
 *             server/src/net/dispatch.test.ts
 *             nothing under net/ imports GameServer at runtime — server/src/net/dispatch.test.ts
 * extend:     a new client message is a handler registered with t.on(type, ...) in an area file under net/handlers;
 *             PRE_JOIN is the only list to touch here
 */

/**
 * Client message dispatch: the drops and limits every message goes through, then one handler per message type from
 * a table built once (GameServer.buildMessageHandlers; later cuts register areas from net/handlers/*).
 *
 * A type with no handler is dropped silently, as anything a hostile client makes up must be. Callers wrap dispatch
 * in the same try as before (GameServer.connect's receive), so a throwing handler is a logged fault.
 *
 * Imports GameServer nothing at runtime: ServerCtx and ClientConnection are type-only.
 */
import type { ClientMessage } from '@space-game/common';
import type { ClientConnection } from './ClientConnection.js';
import type { ServerCtx } from './ServerCtx.js';
import { passesInRange } from '../game/gunRange/messageGate.js';

/** Messages a connection may send before it has joined */
export const PRE_JOIN = new Set(['join', 'ping']);
/** All an expired guest (past their 3 days, only to register: game/pilots/convert.ts) may send: the connection's own upkeep and registering */
export const EXPIRED_GUEST_OK = new Set(['join', 'ping', 'stateHash', 'packedResync', 'convertGuest']);
/** Input flood guard: inputs queued per connection per tick (the rest are dropped) */
export const MAX_INPUTS_PER_TICK = 16;

export type MessageType = ClientMessage['type'];
export type MessageOf<K extends MessageType> = Extract<ClientMessage, { type: K }>;
export type Handler<M = any> = (ctx: ServerCtx, conn: ClientConnection, msg: M) => void;
/** Handlers by message type, read only once built */
export type HandlerTable = ReadonlyMap<string, Handler>;

/** Collects handlers (one per type; a second one for a type is a bug and throws) */
export class HandlerRegistry {
  private readonly table = new Map<string, Handler>();

  on<K extends MessageType>(type: K, fn: Handler<MessageOf<K>>): void {
    if (this.table.has(type)) throw new Error(`message ${type} has two handlers`);
    this.table.set(type, fn as Handler);
  }

  /** The finished table (registering more after this is not meant to happen) */
  freeze(): HandlerTable {
    return this.table;
  }
}

/** Register an area's handlers (each net/handlers/* file exports one such function) */
export function registerHandlers(table: HandlerRegistry, area: (table: HandlerRegistry) => void): void {
  area(table);
}

/** Run one message from a connection: drop what isn't a message, or isn't allowed yet or now; then its handler */
export function dispatch(table: HandlerTable, ctx: ServerCtx, conn: ClientConnection, msg: ClientMessage): void {
  // (Anything that isn't a typed message object is dropped: a hostile client can send any JSON)
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  if (!conn.joined && !PRE_JOIN.has(msg.type)) return;
  // (An expired guest has no ship in the world and plays nothing: only registering and the connection's upkeep pass)
  if (!EXPIRED_GUEST_OK.has(msg.type) && ctx.pilots?.isExpiredGuest(conn)) return;
  // (In the gun range only flying, talking and the range's own messages pass: game/gunRange/messageGate.ts)
  if (ctx.gunRange?.isVisitor(conn) && !passesInRange(msg.type)) return;
  if (!conn.isAdmin && !ctx.limiter.allow(conn, msg.type)) {
    if (msg.type === 'chat') ctx.send(conn.ws, { type: 'systemMessage', text: 'Slow down: too many messages at once.', color: '#fca5a5' });
    return;
  }
  table.get(msg.type)?.(ctx, conn, msg);
}
