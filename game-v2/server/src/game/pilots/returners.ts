/**
 * @contract server.pilots.returners
 * owns:       a pilot saved before the training yard who has never been through it (tutorial.unseen): at login their real profile is set aside
 *             untouched and a fresh training profile flies the yard; leaving (skip or graduate) puts the real one back exactly as it was
 * needs:      Pilots (sessions, away, bank, opts, tutorialSpawn), pilots/persist; npm: @space-game/common
 * invariants: nothing done in the yard reaches the real profile, and every save writes it whole beside the training profile (persist.persistable:
 *             the document is the real profile with the training one under `yard`), so a restart mid-yard loses neither;
 *             a pilot who has left (or finished) is never sent in again; a server with no yard never sets anyone aside — server/src/game/tutorial/returners.test.ts
 * extend:     a new thing the yard grants goes to the training profile only: nothing here ever copies from it to the real one
 */

import { newProfile, newTutorial, leftTutorial, inTutorial } from '@space-game/common';
import type { Pilots, PilotConn, Session } from '../Pilots.js';
import * as persist from './persist.js';

/**
 * A profile was just loaded into the session (login, or a kept guest): if it is a returner's, make the training profile the one in play and
 * the real one the session's `away`. A saved yard (a visit in progress) is resumed as it was; otherwise an unseen pilot starts a visit.
 * Run before the profile is put into the world. A server with no yard sets nobody aside (a saved visit's training profile is just dropped)
 */
export function arrive(self: Pilots, s: Session): void {
  const real = s.profile, saved = real.yard;
  delete real.yard;
  if (!self.tutorialSpawn) return;
  if (saved && inTutorial(saved.tutorial)) {
    self.away.set(s.conn, real);
    s.profile = saved;
    s.dirty = false;
    self.bank.ensure(saved, self.now());
  } else if (real.tutorial.unseen) {
    const play = newProfile(self.opts.starter);
    play.tutorial = { ...newTutorial(), returner: true };
    self.away.set(s.conn, real);
    s.profile = play;
    self.bank.ensure(play, self.now());
    // (Saved at once: the document then holds both)
    s.dirty = true;
  }
}

/** Is this pilot on a returner's visit (their real profile set aside)? */
export function isAway(self: Pilots, conn: PilotConn): boolean {
  return self.away.has(conn);
}

/**
 * The visit is over (skipped or graduated): the real profile back, exactly as it was, marked as through the yard for good, and their own ship
 * put back where it was (the station gone or unsafe: at their home station, as at any login). The training profile and all it held are dropped.
 * False: not on a visit
 */
export function restore(self: Pilots, conn: PilotConn): boolean {
  const s = self.sessions.get(conn), real = self.away.get(conn);
  if (!s || !real) return false;
  self.away.delete(conn);
  real.tutorial = leftTutorial(s.profile.tutorial.done);
  s.profile = real;
  s.profileSent = undefined; s.itemsKey = undefined; s.bankSent = undefined;
  s.dirty = true;
  self.bank.ensure(real, self.now());
  persist.applyProfile(self, s, true);
  self.sendBank(s, true);
  return true;
}
