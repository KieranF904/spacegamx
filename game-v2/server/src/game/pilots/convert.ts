/**
 * @contract server.pilots.convert
 * owns:       a guest registering: their whole profile (in play, or kept past their 3 days) moves to the new account's profile,
 *             once; the kept guest record is consumed
 * needs:      Pilots (sessions, store, guests, converting, now, host), pilots/{persist, lease}; npm: @space-game/common
 * invariants: the profile goes only to an account that has none (never merged), and only once: the kept record is gone with
 *             it, and a second try, or two guests into one account, are refused — server/src/game/pilots/convert.test.ts
 *             a guest past their 3 days is registered from the kept record, never played: no ship of theirs is in the world and
 *             their messages are dropped till then — server/src/game/pilots/convert.test.ts
 * extend:     none: what a profile holds is not looked at (it is moved whole); the account itself is the lobby's
 */

import { migrateProfile, cloneJson, type PlayerProfile } from '@space-game/common';
import type { Pilots, PilotConn, Session } from '../Pilots.js';
import * as persist from './persist.js';
import * as lease from './lease.js';

export type Converted = { ok: true } | { ok: false; error: string };

const refuse = (error: string): Converted => ({ ok: false, error });

/**
 * The guest `conn` registers as account `userId` (named `username`; the lobby made it a moment ago and the caller checked its
 * session). The guest's profile is saved as that account's, the kept record consumed, and the connection becomes the account's
 * (still in the world, nothing reloaded). Refused, and nothing changed, if the account already has a profile
 */
export async function convertGuest(self: Pilots, conn: PilotConn, userId: number, username: string): Promise<Converted> {
  const s = self.sessions.get(conn);
  if (!s || conn.userId !== null) return refuse('You are already signed in.');
  if (s.loading && !s.guestBlocked) return refuse('Still loading your pilot. Try again in a moment.');
  // (One at a time: a guest registering twice, or two guests into one account, race the same empty profile)
  if (s.converting || self.converting.has(userId)) return refuse('Registering already. Wait a moment.');
  s.converting = true;
  self.converting.add(userId);
  try {
    return await run(self, s, userId, username);
  } finally {
    s.converting = false;
    self.converting.delete(userId);
  }
}

async function run(self: Pilots, s: Session, userId: number, username: string): Promise<Converted> {
  const conn = s.conn;
  const guestId = conn.guestId ?? null;
  const gone = () => self.sessions.get(conn) !== s || conn.userId !== null;

  // The pilot to move: the one in play, or (past their 3 days) the one kept
  let moving: PlayerProfile;
  if (s.guestBlocked) {
    const kept = guestId ? await self.guests.take(guestId) : null;
    if (!kept) return refuse('This guest account has been wiped.');
    try {
      moving = migrateProfile(kept.profile, self.opts.starter, self.econ.ships, { econ: self.econ });
    } catch (e) {
      console.error(`[Pilots] could not migrate a kept guest profile to register it (${conn.username}):`, e);
      return refuse('This guest account could not be read.');
    }
  } else {
    persist.capture(self, s);
    moving = cloneJson(persist.persistable(self, conn, s.profile));
  }

  // The account: held by this server, and with no profile (a guest is never merged into a pilot)
  const held = await lease.claim(self, userId);
  if (!held.ok) return refuse("That account is active in another region. Try again in a moment.");
  let existing: unknown;
  try {
    existing = await self.store.load(userId);
  } catch (e) {
    console.error(`[Pilots] could not check the profile of ${userId} to register a guest:`, e);
    await lease.release(self, userId);
    return refuse('Could not reach the save store. Try again in a moment.');
  }
  if (existing !== null && existing !== undefined) {
    await lease.release(self, userId);
    return refuse('That account already has a pilot, so a guest cannot be merged into it. Sign in with it instead.');
  }
  if (gone()) { await lease.release(self, userId); return refuse('You left while registering.'); }

  // Saved first, then the guest's record consumed, then the connection becomes the account's (no await between those two)
  moving.updatedAt = new Date(self.now()).toISOString();
  try {
    await self.store.save(userId, moving, lease.serverId(self));
  } catch (e) {
    console.error(`[Pilots] could not save the registered guest as ${userId}:`, e);
    await lease.release(self, userId);
    return refuse('Could not save your pilot. Nothing was changed; try again.');
  }
  // (Even if they left while it saved: a guest saved on their way out is kept again meanwhile, and goes with it)
  if (guestId) self.guests.consume(guestId);
  if (gone()) { await lease.release(self, userId); return { ok: true }; }
  conn.userId = userId;
  conn.username = username;
  conn.guestId = null;
  s.guestBlocked = false;
  s.dirty = false;
  s.lastSave = self.now();
  if (s.loading) {
    // (The pilot kept past their 3 days takes the place of the empty one this connection was given: in the world once the
    // connection has a ship again, Pilots.enterRegistered)
    s.loading = false;
    s.profile = moving;
  }
  return { ok: true };
}
