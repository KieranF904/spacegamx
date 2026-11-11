/**
 * @contract server.net.handlers.guest-account
 * owns:       the convertGuest message: a guest registers, the lobby-made account takes their pilot, and the connection is the
 *             account's from then on (an expired guest, who had no ship, is given one)
 * needs:      HandlerRegistry (net/dispatch.ts), ServerCtx (userDB, pilots, social, contrib), ClientConnection, net/auth setRanks;
 *             @space-game/common, bitecs
 * invariants: the account is the one the lobby vouches for by session token, never a name the client says — server/src/game/pilots/convert.test.ts
 *             the types it registers are part of the pinned dispatched set — server/src/golden/structure.test.ts
 * extend:     the move itself is game/pilots/convert.ts; this checks who asks and tells the client
 */

/**
 * `convertGuest { token }`: the client has just made an account at the lobby (which checks the name, email and password and
 * limits attempts) and sends its session. A guest only; Pilots.convertGuest moves the pilot, or says why not.
 */
import type { HandlerRegistry } from '../dispatch.js';
import type { ServerCtx } from '../ServerCtx.js';
import type { ClientConnection } from '../ClientConnection.js';
import { entityExists, removeEntity } from 'bitecs';
import { Player, PROTOCOL_VERSION, TICK_RATE } from '@space-game/common';
import { setRanks } from '../auth.js';
import { neutralInput } from './flight.js';

/** Longest session token taken (the lobby's are 64 hex digits) */
const TOKEN_MAX = 256;

export function registerGuestAccountHandlers(t: HandlerRegistry): void {
  t.on('convertGuest', (ctx, conn, msg) => {
    // (Async: a throw inside is a rejected promise the dispatch try/catch can't see)
    convert(ctx, conn, msg.token).catch((e) => { ctx.fault('convertGuest', e); fail(ctx, conn, 'Something went wrong registering. Try again.'); });
  });
}

function fail(ctx: ServerCtx, conn: ClientConnection, error: string): void {
  ctx.send(conn.ws, { type: 'guestConverted', success: false, error });
}

/** An expired guest had no ship in the world: they get one now, as after a respawn (net/handlers/flight.ts handleRespawn), with their pilot on it */
function bringShip(ctx: ServerCtx, conn: ClientConnection): void {
  const old = conn.playerId;
  const eid = ctx.createPlayer();
  conn.playerId = eid;
  neutralInput(eid);
  conn.scheduledInputs.length = 0;
  Player.clientId[eid] = Player.clientId[old];
  if (entityExists(ctx.world, old)) removeEntity(ctx.world, old);
  ctx.pilots.enterRegistered(conn);
  ctx.send(conn.ws, { type: 'welcome', playerId: eid, protocol: PROTOCOL_VERSION, tickRate: TICK_RATE, serverTime: Date.now() });
}

async function convert(ctx: ServerCtx, conn: ClientConnection, raw: unknown): Promise<void> {
  const token = typeof raw === 'string' && raw.length > 0 && raw.length <= TOKEN_MAX ? raw : '';
  if (!conn.joined || conn.userId !== null) return fail(ctx, conn, 'Only a guest can register.');
  if (!token) return fail(ctx, conn, 'Your new account could not be checked. Sign in with it instead.');
  const { user, error } = ctx.userDB.checkSession
    ? await ctx.userDB.checkSession(token)
    : { user: await ctx.userDB.validateSession(token), error: '' };
  if (!user) return fail(ctx, conn, error || 'Your new account could not be checked. Sign in with it instead.');
  const hidden = ctx.pilots.isExpiredGuest(conn);
  const r = await ctx.pilots.convertGuest(conn, user.id, user.username);
  if (!r.ok) return fail(ctx, conn, r.error);
  if (hidden && ctx.clients.has(conn.ws)) bringShip(ctx, conn);
  // (The connection is the account's now: as a sign-in at join would have made it)
  conn.authToken = token;
  setRanks(ctx, conn, user);
  conn.isContributor = ctx.contrib.hasRank(user.id, user.username);
  ctx.social.join(conn);
  console.log(`Player ${conn.playerId} registered as ${user.username}`);
  ctx.send(conn.ws, { type: 'guestConverted', success: true });
  ctx.send(conn.ws, {
    type: 'authResult', success: true, username: conn.username, isAdmin: conn.isAdmin,
    ...(conn.isOwner ? { isOwner: true } : {}), isContributor: ctx.contrib.allowed(conn),
  });
}
