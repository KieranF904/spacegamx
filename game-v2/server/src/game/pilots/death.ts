/**
 * @contract server.pilots.death
 * owns:       what dying costs a pilot: the wreck, the secure hold, the rebuilt ship, and the notices on return
 * needs:      Pilots (sessions, host, ships, bank), DeathRules; npm: @space-game/common
 * invariants: a wreck is only for its pilot for wreckMinutes — none pinned
 * extend:     a new loss or notice is a step in onDestroyed / showNotices
 */

import { Bag, setActiveShip, secureHold, SALVAGE, salvageParts } from '@space-game/common';
import type { Pilots, PilotConn, Session } from '../Pilots.js';
import * as persist from './persist.js';

/**
 * The pilot's ship was destroyed. Their cargo drops where they died, in a wreck kept for them, with what was inside the
 * ship's machines and SALVAGE of its minerals (all of them in safe space); nothing goes to storage. There is no loaner
 * and no insurance: they respawn at home in the same design, the core free, and the repair bank pays for the rest
 * (RepairBank.ts respawn): the free part at once, core outward, then the deposits over time. An empty bank means a bare core.
 */
export function onDestroyed(self: Pilots, conn: PilotConn, systemNum: number, x: number, y: number, vx: number, vy: number, cause: Record<string, unknown> = {}): void {
  const s = self.sessions.get(conn);
  if (!s) return;
  // The gun range's cheat ship lost: nothing dropped, salvaged or counted, and the real profile stays frozen as it was; the
  // respawn flies the same cheat ship again at the range's door (pilots/freeze.ts, game/gunRange)
  if (self.frozen.has(conn)) {
    self.onFrozenDeath?.(conn);
    return;
  }
  const p = s.profile;
  // A borrowed library ship (dev: devSwapShip) lost: nothing salvaged, no wreck, your own ship back as it was
  const borrowed = self.devStash.get(conn);
  if (borrowed) {
    self.devStash.delete(conn);
    setActiveShip(p, borrowed.rec, borrowed.slot);
    self.toast(conn, 'The borrowed ship was destroyed (dev): you respawn in your own', 'info');
    s.dirty = true;
    return;
  }
  const D = self.death;
  const safe = !!self.host.safeAt?.(systemNum, x, y);
  self.track(conn, 'death', { system: self.host.systemId(systemNum), x: Math.round(x), y: Math.round(y), safe, ship: p.ship.blueprint.name, parts: p.ship.blueprint.parts.length, cargo: p.cargo.reduce((n, st) => n + st.n, 0), deaths: (p.stats.deaths ?? 0) + 1, ...cause });
  // The hold: kept whole in safe space; elsewhere its secure stacks stay (its most valuable few), the rest goes with the wreck
  const cargo: Bag = {};
  if (!safe) {
    const secure = secureHold(p.cargo, (id) => self.econ.items.get(id)?.value ?? 0, D.secureStacks, D.secureUnits);
    const kept: typeof p.cargo = [];
    for (const st of p.cargo) {
      const k = secure.get(st) ?? 0;
      if (k > 0) kept.push({ ...st, n: k });
      if (st.n - k > 0) cargo[st.id] = (cargo[st.id] ?? 0) + st.n - k;
    }
    p.cargo = kept;
  }
  const rec = p.ship;
  const standing = new Set(rec.ghosts ?? []);
  const built = rec.blueprint.parts.filter((q) => !standing.has(q.uid));
  // The wreck also holds the machines' contents (or what was saved of them) and the built parts' minerals
  const inMachines = self.fieldHooks.machineContents?.(conn.playerId) ?? rec.field?.held ?? {};
  for (const [id, n] of Object.entries(inMachines)) if (n > 0) cargo[id] = (cargo[id] ?? 0) + n;
  for (const [id, n] of Object.entries(salvageParts(self.econ, built, safe ? 1 : SALVAGE))) cargo[id] = (cargo[id] ?? 0) + n;
  // (Nothing is inside the machines now, and a recycling queue means nothing on a ship that is all ghosts)
  if (rec.field) { delete rec.field.held; delete rec.field.recycle; if (!Object.keys(rec.field).length) delete rec.field; }
  // Back in the same design: the core free, the free part pays core outward, the rest is owed
  self.bank.ensure(p, self.now());
  const back = self.bank.respawn(p, rec, (uid) => self.isClaimed(conn.playerId, uid));
  const deposits = Object.keys(p.bank?.deposits ?? {}).length > 0;
  let note = `Your ${rec.blueprint.name} was destroyed. ` + (back.owed <= 0
    ? 'Your repair bank rebuilt all of it'
    : back.paid > 0
      ? `Your repair bank rebuilt ${back.paid} part${back.paid > 1 ? 's' : ''}; ${back.owed} more come back ${deposits ? 'from your deposits and ' : ''}as the bank refills`
      : `You are back as a bare core: ${back.owed} part${back.owed > 1 ? 's' : ''} come back ${deposits ? 'from your deposits and ' : ''}as your repair bank refills`);
  // The wreck: kept for its pilot a while, marked on their map
  const sysId = self.host.systemId(systemNum);
  const key = self.keyOf(conn);
  if (Object.keys(cargo).length) {
    const kept = !!(self.host.spawnWreck && key && sysId);
    const eid = kept ? self.host.spawnWreck!(systemNum, x, y, vx * 0.3, vy * 0.3, cargo, key!, D.wreckMinutes * 60) : self.host.spawnPod(systemNum, x, y, vx * 0.5, vy * 0.5, cargo);
    if (kept && eid >= 0) {
      p.wreck = { system: sysId!, x: Math.round(x), y: Math.round(y), until: self.now() + D.wreckMinutes * 60_000 };
      note += `. Your wreck holds your cargo and the rest of its materials: it's marked on your map and kept for you for ${D.wreckMinutes} minutes`;
    }
  }
  if (!safe && p.cargo.length) note += `. Your secure hold kept ${p.cargo.length} stack${p.cargo.length > 1 ? 's' : ''}`;
  self.toast(conn, note, 'warn');
  p.stats.deaths = (p.stats.deaths ?? 0) + 1;
  s.dirty = true;
  self.sendItems(conn);
  sendWreck(self, s);
  self.sendBank(s, true);
  void persist.save(self, s);
}

/** A pilot recovered their wreck (its pod was emptied) */
export function wreckRecovered(self: Pilots, key: string): void {
  for (const s of self.sessions.values()) {
    if (self.keyOf(s.conn) !== key || !s.profile.wreck) continue;
    s.profile.wreck = undefined;
    s.dirty = true;
    self.toast(s.conn, 'Wreck recovered: everything in it is in your hold', 'good');
    sendWreck(self, s);
  }
}

/** Tell them where their wreck is (or that it's gone) */
export function sendWreck(self: Pilots, s: Session): void {
  const w = s.profile.wreck;
  if (!w || w.until <= self.now()) {
    if (w) { s.profile.wreck = undefined; s.dirty = true; }
    self.host.send(s.conn, { type: 'wreck', gone: true });
    return;
  }
  self.host.send(s.conn, { type: 'wreck', system: w.system, x: w.x, y: w.y, seconds: Math.round((w.until - self.now()) / 1000) });
}

/** One-time messages left on the profile (a migration's: the v5 ship wipe's refund), shown once and cleared */
export function showNotices(self: Pilots, s: Session): void {
  const list = s.profile.notices;
  if (!list?.length) return;
  for (const n of list) {
    const items = Object.entries(n.items ?? {}).sort((a, b) => b[1] - a[1]);
    const shown = items.slice(0, 12).map(([id, k]) => `${k} ${self.econ.items.get(id)?.name ?? id}`);
    if (items.length > shown.length) shown.push(`and ${items.length - shown.length} more`);
    self.toast(s.conn, shown.length ? `${n.text}: ${shown.join(', ')}` : n.text, 'info');
  }
  delete s.profile.notices;
  s.dirty = true;
}
