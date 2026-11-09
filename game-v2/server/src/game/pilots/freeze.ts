/**
 * @contract server.pilots.freeze
 * owns:       a pilot's profile set aside while they fly a ship that must never touch it (the gun range's cheat ship):
 *             the real profile frozen as it was, a throwaway copy in play (no hold, no storage, no other ships), and the
 *             real one put back untouched
 * needs:      Pilots (sessions, frozen), pilots/persist; npm: @space-game/common
 * invariants: nothing done while frozen reaches the real profile: every save writes the frozen one, the gives, takes and
 *             awards refuse, and a cheat ship is never captured into any profile — server/src/game/gunRange/isolation.test.ts
 * extend:     a new item or progress path in Pilots returns early for `self.frozen.has(conn)`
 */

import { cloneJson, setActiveShip, type Blueprint, type PlayerProfile, type ShipRecord } from '@space-game/common';
import type { Pilots, PilotConn } from '../Pilots.js';
import * as persist from './persist.js';

/**
 * Set the pilot's profile aside and fly `ship` on a throwaway copy of it. The real one is captured and saved first, as it
 * stands (a server lost meanwhile has it, never the range). False (nothing done): no session, still loading, already
 * frozen, or flying a borrowed dev ship.
 */
export function freeze(self: Pilots, conn: PilotConn, ship: Blueprint): boolean {
  const s = self.sessions.get(conn);
  if (!s || s.loading || self.frozen.has(conn) || self.devStash.has(conn)) return false;
  persist.capture(self, s);
  void persist.save(self, s);
  const real = s.profile;
  self.frozen.set(conn, real);
  const play = cloneJson(real) as PlayerProfile;
  // (Nothing of value in play: an item can't be traded, dropped or spent out of it, whatever a path forgets to check)
  play.cargo = [];
  play.storage = [];
  play.hangar = play.hangar.map(() => null);
  setActiveShip(play, rangeRecord(ship), play.activeSlot);
  s.profile = play;
  s.dirty = false;
  s.itemsKey = undefined;
  persist.reapplyShip(self, conn);
  self.sendItems(conn);
  return true;
}

/** Fly another ship on the throwaway profile (the range's weapon picker); false unless frozen */
export function swapFrozenShip(self: Pilots, conn: PilotConn, ship: Blueprint): boolean {
  const s = self.sessions.get(conn);
  if (!s || !self.frozen.has(conn)) return false;
  setActiveShip(s.profile, rangeRecord(ship), s.profile.activeSlot);
  persist.reapplyShip(self, conn);
  return true;
}

/**
 * The real profile back, exactly as it was frozen (the throwaway copy is dropped, never captured). `apply`: put its ship
 * on the entity now (false when the entity is dead or going: a respawn or the next login applies it). False: not frozen.
 */
export function thaw(self: Pilots, conn: PilotConn, apply = true): boolean {
  const s = self.sessions.get(conn), real = self.frozen.get(conn);
  self.frozen.delete(conn);
  if (!s || !real) return false;
  s.profile = real;
  s.itemsKey = undefined;
  if (apply) persist.reapplyShip(self, conn);
  else self.sendProfile(conn);
  self.sendItems(conn);
  self.sendBank(s, true);
  return true;
}

function rangeRecord(ship: Blueprint): ShipRecord {
  return { blueprint: cloneJson(ship), hp: {}, ghosts: [] };
}
