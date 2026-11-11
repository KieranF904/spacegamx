/**
 * @contract server.pilots.backups
 * owns:       backup ships: the free starter a death puts a pilot in, the backups offered at the respawn, and the choice
 * needs:      Pilots (sessions, opts.starter, ships.validate, death rules), common backups.ts rules; npm: @space-game/common
 * invariants: the starter is always offered, and a ship over the backup rules never is — server/src/game/pilots/death.test.ts
 *             the free starter's parts are never refunded, scrapped or salvaged — server/src/game/pilots/death.test.ts
 * extend:     a new backup rule goes in common econ/backups.ts backupRefusal
 */
/**
 * Backups (docs/design/death-rework-2026-11.md). A death loses the ship (death.ts) and makes the free starter the ship
 * flown: a fresh record whose every part is `free` (ShipRecord.free). It sits in a free hangar bay, or a berth past the
 * bays, and goes again once the pilot flies anything else, so it never piles up. At the respawn they may take one of
 * their own ships instead, if it qualifies (backupRefusal) and stands (not lost, its core built).
 */

import { backupRefusal, cloneJson, coreOf, setActiveShip, unlocks, type BackupOption, type PlayerProfile, type ShipRecord } from '@space-game/common';
import type { Pilots, Session } from '../Pilots.js';

/** A fresh free starter: the starter design, every part free */
export function freeStarter(self: Pilots): ShipRecord {
  const bp = cloneJson(self.opts.starter.blueprint);
  return { blueprint: bp, hp: {}, ghosts: [], plan: self.opts.starter.planFile, free: bp.parts.map((q) => q.uid) };
}

/** Is this the free starter as it was issued (every part of it free: nothing of the pilot's on it) */
export function isFreeStarter(rec: ShipRecord | null | undefined): boolean {
  if (!rec?.free?.length) return false;
  const free = new Set(rec.free);
  return rec.blueprint.parts.every((q) => free.has(q.uid));
}

/** Empty a hangar slot (one past the pilot's bays goes altogether), as Hangar's own does */
export function dropSlot(p: PlayerProfile, slot: number): void {
  const bays = unlocks(p).hangarSlots;
  if (slot >= bays && p.hangar.length > bays) {
    p.hangar.splice(slot, 1);
    if (p.activeSlot > slot) p.activeSlot--;
  } else {
    p.hangar[slot] = null;
  }
}

/** Fly the free starter: in `slot` (a lost starter's own), else the first empty bay, else a berth past the bays */
export function flyStarter(self: Pilots, p: PlayerProfile, slot = -1): void {
  let at = slot >= 0 && slot < p.hangar.length ? slot : p.hangar.indexOf(null);
  if (at < 0) { p.hangar.push(null); at = p.hangar.length - 1; }
  setActiveShip(p, freeStarter(self), at);
}

/** The backups a pilot may respawn in: the starter first, then their own ships that qualify and stand */
export function backupOptions(self: Pilots, p: PlayerProfile): BackupOption[] {
  const starter = self.opts.starter.blueprint;
  const out: BackupOption[] = [{ slot: -1, name: starter.name, built: starter.parts.length, parts: starter.parts.length }];
  p.hangar.forEach((rec, slot) => {
    if (!rec || rec.lost || isFreeStarter(rec)) return;
    const core = coreOf(rec.blueprint.parts);
    const ghosts = new Set(rec.ghosts ?? []);
    if (!core || ghosts.has(core.uid)) return;
    if (backupRefusal(self.ships.catalog, rec.blueprint, starter, self.death.backupCost)) return;
    // (One that no longer passes the ship rules would only fly a loaner in its place: persist.ts flyLoaner)
    if (!self.ships.validate(rec.blueprint, { mounting: false, devParts: true }).ok) return;
    const built = rec.blueprint.parts.filter((q) => !ghosts.has(q.uid) && (rec.hp[q.uid] ?? 1) > 0).length;
    out.push({ slot, name: rec.blueprint.name, built, parts: rec.blueprint.parts.length });
  });
  return out;
}

/**
 * The respawn: fly the backup chosen (a slot backupOptions offers) in place of the free starter the death gave them.
 * Nothing to choose unless they are in the free starter (a death); a choice not on offer keeps the starter
 */
export function chooseBackup(self: Pilots, s: Session, slot: number | undefined): void {
  const p = s.profile;
  if (slot === undefined || !Number.isInteger(slot) || slot < 0 || !isFreeStarter(p.ship) || p.hangar[p.activeSlot] !== p.ship) return;
  if (!backupOptions(self, p).some((o) => o.slot === slot)) {
    self.toast(s.conn, 'That ship can\'t be a backup: you are in the starter', 'warn');
    return;
  }
  const was = p.activeSlot;
  const rec = p.hangar[slot]!;
  setActiveShip(p, rec, slot);
  dropSlot(p, was);
  s.dirty = true;
}
