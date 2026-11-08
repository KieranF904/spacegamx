/**
 * @contract server.net.handlers.bank
 * owns:       the repair bank messages: bankDeposit at a station and the dev-only devBank tools
 * needs:      HandlerRegistry (net/dispatch.ts), ServerCtx, ClientConnection, the game modules reached through ctx;
 *             @space-game/common
 * invariants: the types it registers are part of the pinned dispatched set — server/src/golden/structure.test.ts
 * extend:     a new bank message is a t.on line; the rules are game/RepairBank.ts
 */

/**
 * The repair bank's messages (docs/design/field-fabrication.md, section 7): `bankDeposit` (at a station, from the hold or
 * storage, only what a bank takes) and `devBank` (dev servers only: fill or empty the free part, clear or grant deposits).
 * The rules are game/RepairBank.ts; the sessions and the messages back are Pilots'.
 */
import type { HandlerRegistry } from '../dispatch.js';
import type { ServerCtx } from '../ServerCtx.js';
import type { ClientConnection } from '../ClientConnection.js';

/** May this connection use the dev bank tools? An admin on a dev server, or the flags that open the hangar anywhere / free building: never on production */
export function devBankAllowed(ctx: ServerCtx, conn: ClientConnection): boolean {
  return ctx.shipEditAnywhere || ctx.freeBuild(conn) || ctx.admin.devTools(conn);
}

/** A bag from a client: item id to whole count, a few entries, nothing else */
function bagOf(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, n] of Object.entries(raw as Record<string, unknown>).slice(0, 64)) {
    if (typeof n === 'number' && Number.isFinite(n) && n >= 1) out[id] = Math.floor(n);
  }
  return out;
}

export function registerBankHandlers(t: HandlerRegistry): void {
  t.on('bankDeposit', (ctx, conn, msg) => {
    const from = msg.from === 'cargo' || msg.from === 'storage' ? msg.from : undefined;
    ctx.pilots.bankDeposit(conn, bagOf(msg.items), from);
  });
  t.on('devBank', (ctx, conn, msg) => {
    if (!devBankAllowed(ctx, conn)) { ctx.pilots.toast(conn, 'The dev bank tools are only on a dev server', 'warn'); return; }
    const action = typeof msg.action === 'string' ? msg.action : '';
    ctx.pilots.devBank(conn, action, bagOf(msg.items));
  });
}
