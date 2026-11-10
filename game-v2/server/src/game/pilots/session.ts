/**
 * @contract server.pilots.session
 * owns:       a connection's session lifecycle: attach as a guest, login (load or start the saved profile), resume a kept guest, detach (save, release), adopt (a lingering session moves to a new connection)
 * needs:      Pilots (sessions, store, bank, banking, guests, frozen, devStash, opts, host), pilots/{cargo, death, persist, lease}; npm: @space-game/common
 * invariants: a profile that fails to load or migrate is never saved over (the session stays `loading`) — server/src/game/pilots/guests.test.ts
 *             a disconnect saves twice if the first try fails, and keeps the lease if a save failed — server/src/game/pilots/lease.test.ts
 * extend:     none: the rules each step applies live in pilots/*.ts and profile/; this is the order they run in
 */

import { newProfile, migrateProfile, refundRetiredSkills, cloneJson, type PlayerProfile } from '@space-game/common';
import type { Pilots, PilotConn, Session } from '../Pilots.js';
import * as cargo from './cargo.js';
import * as death from './death.js';
import * as persist from './persist.js';
import * as lease from './lease.js';

/** A new connection plays as a guest until it logs in */
export function attach(self: Pilots, conn: PilotConn): void {
  const s: Session = { conn, profile: newProfile(self.opts.starter), dirty: false, lastSave: self.now(), atStation: false };
  for (const bp of self.opts.guestShips ?? []) {
    const slot = s.profile.hangar.indexOf(null);
    if (slot >= 0) s.profile.hangar[slot] = { blueprint: cloneJson(bp), hp: {}, ghosts: [] };
  }
  self.sessions.set(conn, s);
  self.bank.ensure(s.profile, self.now());
  persist.applyProfile(self, s, false);
  // (A guest's ship is where the world put it, beside Sol Central; in the tutorial that is the yard instead)
  const yard = self.tutorialSpawn?.(conn, false);
  if (yard) self.host.place(conn, yard.system, yard.x, yard.y);
  self.sendBank(s, true);
  self.emit(conn, { type: 'login' });
}

/** Logged in: load (or start) their saved profile and put them back where they were */
export async function login(self: Pilots, conn: PilotConn, userId: number): Promise<void> {
  let raw: unknown = null;
  const before = self.sessions.get(conn);
  // Until it's loaded, the profile in hand (a guest's) mustn't be saved over theirs
  if (before) before.loading = true;
  let failed = false;
  try {
    raw = await self.store.load(userId);
  } catch (e) {
    failed = true;
    console.error(`[Pilots] could not load profile ${userId}:`, e);
  } finally {
    if (before) before.loading = false;
  }
  const s = self.sessions.get(conn);
  if (!s || conn.userId !== userId) return; // left (or switched account) while loading
  // A save we couldn't read isn't an empty one: never start them afresh over it
  if (failed) { s.loading = true; self.toast(conn, 'Your save could not be loaded right now: progress self session will not be saved. Try reconnecting.', 'bad'); return; }
  // A save we can't make sense of is kept as it is (never saved over), like one we couldn't read
  let profile: PlayerProfile;
  try {
    // (A save older than OLDEST_PROFILE_VERSION throws: logged below, and kept as it is)
    profile = raw
      ? migrateProfile(raw, self.opts.starter, self.econ.ships, { econ: self.econ })
      : newProfile(self.opts.starter);
  } catch (e) {
    s.loading = true;
    console.error(`[Pilots] could not migrate profile ${userId}:`, e);
    self.toast(conn, 'Your save could not be loaded right now: progress self session will not be saved. Try reconnecting.', 'bad');
    return;
  }
  s.profile = profile;
  // (An upgraded save is written back at once: a migration never runs twice)
  s.dirty = !raw || (raw as { version?: unknown }).version !== profile.version;
  if (cargo.structureToMaterials(self, s.profile)) s.dirty = true;
  if (refundRetiredSkills(s.profile)) s.dirty = true;
  // The repair bank: made full at a first login, refilled to now; the free part pays for what a lost ship is owed
  if (!s.profile.bank) s.dirty = true;
  self.bank.ensure(s.profile, self.now());
  self.banking.payOwedFree(s);
  persist.applyProfile(self, s, true);
  self.sendBank(s, true);
  death.sendWreck(self, s);
  if (!raw) self.toast(conn, 'Welcome, pilot. Your Sparrow is fuelled and ready at Sol Central.', 'good');
  death.showNotices(self, s);
  self.emit(conn, { type: 'login' });
}

/**
 * A guest joined with their browser's key (conn.guestId): the pilot kept under it, if any, is theirs again as they left
 * it (their ship, hold, place and tutorial step: what a signed-in pilot's login loads from their save). False: none
 * kept (a new guest: the fresh profile they were given stands), or they left or signed in meanwhile
 */
export async function resumeGuest(self: Pilots, conn: PilotConn): Promise<boolean> {
  const id = conn.guestId;
  if (!id) return false;
  const kept = await self.guests.take(id);
  const s = self.sessions.get(conn);
  if (!kept || !s || s.loading || conn.userId !== null || conn.guestId !== id) return false;
  let profile: PlayerProfile;
  try {
    profile = migrateProfile(kept.profile, self.opts.starter, self.econ.ships, { econ: self.econ });
  } catch (e) {
    console.error(`[Pilots] could not migrate a kept guest profile (${conn.username}):`, e);
    return false;
  }
  s.profile = profile;
  s.dirty = false;
  s.profileSent = undefined; s.itemsKey = undefined; s.bankSent = undefined;
  if (cargo.structureToMaterials(self, s.profile)) s.dirty = true;
  if (refundRetiredSkills(s.profile)) s.dirty = true;
  self.bank.ensure(s.profile, self.now());
  persist.applyProfile(self, s, true);
  self.sendBank(s, true);
  death.sendWreck(self, s);
  self.emit(conn, { type: 'login' });
  return true;
}

/** Disconnected: capture where they are and save (twice if the first try fails), then give the account up to other servers */
export async function detach(self: Pilots, conn: PilotConn): Promise<void> {
  const s = self.sessions.get(conn);
  if (!s) return;
  self.sessions.delete(conn);
  const userId = conn.userId;
  if (s.loading) { if (userId !== null) await lease.release(self, userId); return; }
  // (Gone from the gun range: the real profile back first, as it was, so that is what's saved)
  const real = self.frozen.get(conn);
  if (real) { self.frozen.delete(conn); s.profile = real; }
  persist.capture(self, s);
  await persist.save(self, s);
  if (s.dirty && userId !== null) await persist.save(self, s);
  self.devStash.delete(conn);
  // (A save that failed keeps the lease: it runs out by itself, and no other server loads the stale profile meanwhile)
  if (userId !== null && !s.dirty) await lease.release(self, userId);
}

/**
 * A signed-in pilot came back to the ship they left in space (their old connection's session, kept while it lingered):
 * the session moves to the new connection as it is (nothing loaded, the ship untouched) and the client is told it all
 */
export function adopt(self: Pilots, from: PilotConn, to: PilotConn): boolean {
  const s = self.sessions.get(from);
  if (!s) return false;
  self.sessions.delete(from);
  self.sessions.delete(to);
  const frozen = self.frozen.get(from);
  self.frozen.delete(from);
  if (frozen) self.frozen.set(to, frozen);
  s.conn = to;
  s.loading = false;
  s.profileSent = undefined; s.itemsKey = undefined; s.bankSent = undefined;
  self.sessions.set(to, s);
  self.sendProfile(to);
  self.sendItems(to);
  self.sendBank(s, true);
  self.emit(to, { type: 'login' });
  return true;
}
