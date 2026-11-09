/**
 * Join and sign-in: the join / authLogin / authRegister messages, the guest-name rules and the HTTP auth endpoints.
 * Moved verbatim from GameServer (the receiver `this` became `ctx`, the helpers take ctx first). Security-critical: a
 * guest can't pose as a registered or admin name, a banned or expired token never becomes a guest, and a protocol
 * mismatch closes the socket (4002). `conn.joined = true` still comes before the first await.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { PROTOCOL_VERSION, PROTOCOL_MISMATCH_CLOSE, PROTOCOL_MISMATCH_REASON, fullCaps } from '@space-game/common';
import type { ClientConnection } from './ClientConnection.js';
import type { HandlerRegistry } from './dispatch.js';
import type { ServerCtx } from './ServerCtx.js';
import { notifier } from '../auth/pushover.js';
import { activity } from '../activity/index.js';

/** The join and sign-in messages */
export function registerAuthHandlers(t: HandlerRegistry): void {
  t.on('join', (ctx, conn, msg) => {
    // (Async: a throw inside is a rejected promise the receive() try/catch can't see)
    handleJoin(ctx, conn, msg).catch((e) => ctx.fault('join', e));
  });
  t.on('authLogin', (ctx, conn, msg) => {
    handleAuthLogin(ctx, conn, msg).catch((e) => ctx.fault('authLogin', e));
  });
  t.on('authRegister', (ctx, conn, msg) => {
    handleAuthRegister(ctx, conn, msg).catch((e) => ctx.fault('authRegister', e));
  });
}

export async function handleJoin(ctx: ServerCtx, conn: ClientConnection, msg: any): Promise<void> {
  // A client built for another wire format can't talk to us: it shows "new version, reload"
  // (one that doesn't say predates the handshake, and the format it knows hasn't changed since)
  // Nor can one without the full netcode (common network/hits.ts DEFAULT_CAPS): there's no base protocol to fall back
  // on. A join that says neither its protocol nor its caps is an in-process tool (tests, benches, bots): it gets the full set
  const said = msg.protocol !== undefined || msg.caps !== undefined;
  if ((msg.protocol !== undefined && msg.protocol !== PROTOCOL_VERSION) || (said && !fullCaps(msg.caps))) {
    activity.protocol(msg.protocol, PROTOCOL_VERSION);
    conn.ws.close?.(PROTOCOL_MISMATCH_CLOSE, PROTOCOL_MISMATCH_REASON);
    return;
  }
  if (gated(ctx, conn)) return;
  conn.joined = true;
  if (msg.token) {
    // Authenticated join - validate token
    const { user, error } = ctx.userDB.checkSession
      ? await ctx.userDB.checkSession(msg.token)
      : { user: await ctx.userDB.validateSession(msg.token), error: '' };
    if (user) {
      conn.username = user.username;
      conn.userId = user.id;
      setRanks(ctx, conn, user);
      conn.isContributor = ctx.contrib.hasRank(user.id, user.username);
      conn.authToken = msg.token;
      ctx.loginPilot(conn, user.id).catch((e) => ctx.fault('login', e));
      console.log(`Player ${conn.playerId} authenticated as ${user.username}${user.is_owner ? ' (owner)' : user.is_admin ? ' (admin)' : ''}`);
      // (a notice to Kieran's phone on the live server; not for admins)
      if (!user.is_admin && !user.is_owner) notifier.join(user.username, false, online(ctx));
    } else {
      // Expired, signed out or banned (or the lobby's unreachable): back to the sign-in screen, not in as a guest
      rejectAuth(ctx, conn, error || 'Your session has ended. Sign in again.');
      return;
    }
  } else {
    // Guest join
    // (A name only: a string, no control characters, a sensible length; it goes to everyone near)
    const name = typeof msg.username === 'string' ? msg.username.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 24) : '';
    // (Nor anyone's account: a guest can't pose as a known pilot or an admin)
    // (Only asking the lobby waits: with no lobby to ask, a guest's join goes through at once, as it always has)
    const owner = name ? signedInOwner(ctx, name) ?? (ctx.userDB.admin ? await accountOwner(ctx, name) : null) : null;
    if (owner) {
      rejectAuth(ctx, conn, `"${name}" is ${owner === 'admin' ? "an admin's" : "a registered pilot's"} name. Sign in to fly as them, or pick another name.`);
      return;
    }
    conn.username = name || `Guest_${Math.floor(Math.random() * 10000)}`;
    conn.userId = null;
    conn.isAdmin = ctx.everyoneAdmin || ctx.guestAdmin;
    conn.isOwner = false;
    conn.isContributor = false;
    notifier.join(conn.username, true, online(ctx));
  }
  activity.join(conn);

  // Send auth result back
  ctx.send(conn.ws, {
    type: 'authResult',
    success: true,
    username: conn.username,
    isAdmin: conn.isAdmin,
    ...(conn.isOwner ? { isOwner: true } : {}),
    isContributor: ctx.contrib.allowed(conn),
  });
}

/** A server update is about to restart us (server/src/update): no new sign-ins. True if it refused this one */
function gated(ctx: ServerCtx, conn: ClientConnection): boolean {
  const why = ctx.joinGate?.();
  if (!why) return false;
  rejectAuth(ctx, conn, why);
  return true;
}

export async function handleAuthLogin(ctx: ServerCtx, conn: ClientConnection, msg: any): Promise<void> {
  if (gated(ctx, conn)) return;
  const result = await ctx.userDB.login(msg.username, msg.password, conn.address);
  if (result.success) {
    conn.username = result.user.username;
    conn.userId = result.user.id;
    ctx.loginPilot(conn, result.user.id).catch((e) => ctx.fault('login', e));
    setRanks(ctx, conn, result.user);
    conn.isContributor = ctx.contrib.hasRank(result.user.id, result.user.username);
    conn.authToken = result.token;
    
    ctx.send(conn.ws, {
      type: 'authResult',
      success: true,
      username: result.user.username,
      token: result.token,
      isAdmin: conn.isAdmin,
      ...(conn.isOwner ? { isOwner: true } : {}),
      isContributor: ctx.contrib.allowed(conn),
    });
  } else {
    rejectAuth(ctx, conn, result.error);
  }
}

/** An account's ranks on its connection: owner > admin > pilot (an owner passes every admin check) */
function setRanks(ctx: ServerCtx, conn: ClientConnection, user: { is_admin: boolean; is_owner?: boolean }): void {
  conn.isOwner = !!user.is_owner;
  conn.isAdmin = user.is_admin || conn.isOwner || ctx.guestAdmin;
}

/** Pilots on the server now (joined connections) */
function online(ctx: ServerCtx): number {
  let n = 0;
  for (const c of ctx.clients.values()) if (c.joined) n++;
  return n;
}

export function signedInOwner(ctx: ServerCtx, name: string): 'admin' | 'pilot' | null {
  const lower = name.toLowerCase();
  for (const c of ctx.clients.values()) {
    if (c.userId !== null && c.username.toLowerCase() === lower) return c.isAdmin ? 'admin' : 'pilot';
  }
  return null;
}

export async function accountOwner(ctx: ServerCtx, name: string): Promise<'admin' | 'pilot' | null> {
  try {
    const account = await ctx.userDB.admin?.get(name);
    return account ? (account.isAdmin ? 'admin' : 'pilot') : null;
  } catch {
    return null;
  }
}

export function rejectAuth(ctx: ServerCtx, conn: ClientConnection, error: string | undefined): void {
  activity.refused(conn, error);
  ctx.send(conn.ws, { type: 'authResult', success: false, error });
  // A moment for the answer to get out before the socket closes
  setTimeout(() => conn.ws.close?.(), 250);
}

export async function handleAuthRegister(ctx: ServerCtx, conn: ClientConnection, msg: any): Promise<void> {
  if (gated(ctx, conn)) return;
  const result = await ctx.userDB.register(msg.username, msg.email, msg.password, conn.address);
  if (result.success) {
    conn.username = result.user.username;
    conn.userId = result.user.id;
    ctx.loginPilot(conn, result.user.id).catch((e) => ctx.fault('login', e));
    setRanks(ctx, conn, result.user);
    conn.isContributor = ctx.contrib.hasRank(result.user.id, result.user.username);
    conn.authToken = result.token;
    
    ctx.send(conn.ws, {
      type: 'authResult',
      success: true,
      username: result.user.username,
      token: result.token,
      isAdmin: conn.isAdmin,
      ...(conn.isOwner ? { isOwner: true } : {}),
      isContributor: ctx.contrib.allowed(conn),
    });
  } else {
    rejectAuth(ctx, conn, result.error);
  }
}

export async function handleHttpAuth(ctx: ServerCtx, req: IncomingMessage, res: ServerResponse, action: 'register' | 'login' | 'validate', address?: string): Promise<void> {
  // (A sign-in is a few hundred bytes: anything past 16 KB is refused, not held in memory)
  let body = '', tooBig = false;
  req.on('data', (chunk: { toString(): string }) => {
    if (tooBig) return;
    body += chunk.toString();
    if (body.length > 16 * 1024) { tooBig = true; body = ''; }
  });
  req.on('error', () => {});
  req.on('end', async () => {
    try {
      if (tooBig) throw new Error('request too large');
      const data = JSON.parse(body);
      if (!data || typeof data !== 'object') throw new Error('not an object');
      res.setHeader('Content-Type', 'application/json');

      if (action === 'register') {
        const result = await ctx.userDB.register(data.username, data.email, data.password, address);
        if (result.success) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, username: result.user.username, token: result.token, isAdmin: result.user.is_admin }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: result.error }));
        }
      } else if (action === 'login') {
        const result = await ctx.userDB.login(data.username, data.password, address);
        if (result.success) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, username: result.user.username, token: result.token, isAdmin: result.user.is_admin }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: result.error }));
        }
      } else if (action === 'validate') {
        const user = await ctx.userDB.validateSession(data.token);
        if (user) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, username: user.username, isAdmin: user.is_admin }));
        } else {
          res.writeHead(401);
          res.end(JSON.stringify({ success: false, error: 'Invalid or expired session' }));
        }
      }
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
    }
  });
}
