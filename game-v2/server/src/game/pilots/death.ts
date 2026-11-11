/**
 * @contract server.pilots.death
 * owns:       what dying costs a pilot: the ship lost to a plan, the wreck and its salvage, the backup they come back in, and the notices on return
 * needs:      Pilots (sessions, host, ships, death rules), pilots/backups.ts; npm: @space-game/common
 * invariants: the lost ship goes to its hangar slot as its design with every part missing; the starter leaves no plan — server/src/game/pilots/death.test.ts
 *             a wreck holds all of the hold, is its pilot's alone for wreckOwnerMinutes, open to all for wreckOpenMinutes, then gone — server/src/game/pilots/death.test.ts
 *             its salvage is refined materials from the bills of salvageShare of the parts, never a part — server/src/game/pilots/death.test.ts
 *             a death inside a boss chamber leaves its wreck outside it — server/src/game/pilots/death.test.ts
 *             a destroyed loaner costs its pilot's cargo as any death does, but not the loaner or the saved ship — server/src/game/pilots/loaner.test.ts
 * extend:     a new loss or notice is a step in onDestroyed / showNotices
 */

import { Bag, setActiveShip, adjacency, blueprintGeometry, cloneJson, computeJoins, coreIndex, coreOutwards, isStarterDesign, mulberry32,
  type PlacedPart, type ShipRecord } from '@space-game/common';
import type { Pilots, PilotConn, Session } from '../Pilots.js';
import { backupOptions, flyStarter, isFreeStarter } from './backups.js';
import * as persist from './persist.js';

/**
 * The pilot's ship was destroyed (docs/design/death-rework-2026-11.md). The ship is lost: it goes back to its hangar
 * slot as its design with every part missing, on order, to be fabricated and built again in full. Everything in the
 * hold, what was inside its machines and a share of its parts (salvageShare) drop in a wreck where it died (outside a
 * boss chamber), its pilot's alone for a while, then anyone's, then gone. They come back in the free starter, or a
 * backup of their own they pick at the respawn (backups.ts). Losing the starter itself makes no plan: it's the floor.
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
  // (Safe space costs no less than anywhere since the death rework; telemetry still notes it)
  const safe = !!self.host.safeAt?.(systemNum, x, y);
  self.track(conn, 'death', { system: self.host.systemId(systemNum), x: Math.round(x), y: Math.round(y), safe, ship: p.ship.blueprint.name, parts: p.ship.blueprint.parts.length, cargo: p.cargo.reduce((n, st) => n + st.n, 0), deaths: (p.stats.deaths ?? 0) + 1, ...cause });
  // All of the hold goes with the wreck
  const cargo: Bag = {};
  for (const st of p.cargo) if (st.n > 0) cargo[st.id] = (cargo[st.id] ?? 0) + st.n;
  p.cargo = [];
  // A loaner lost (flown while the saved ship fails the rules: persist.ts flyLoaner): the cargo goes as in any death, but
  // the loaner itself costs nothing (no salvage, no plan) and the saved ship is untouched, back as its record, so the
  // respawn checks it again (and flies another loaner if it still fails)
  if (self.loaners.has(p.ship) && p.hangar[p.activeSlot]) { loanerLost(self, s, systemNum, x, y, vx, vy, cargo); return; }
  const rec = p.ship, slot = p.activeSlot;
  // The wreck also holds the machines' contents (or what was saved of them) and a share of the ship's parts
  const inMachines = self.fieldHooks.machineContents?.(conn.playerId) ?? rec.field?.held ?? {};
  for (const [id, n] of Object.entries(inMachines)) if (n > 0) cargo[id] = (cargo[id] ?? 0) + n;
  for (const [id, n] of Object.entries(salvage(self, rec))) cargo[id] = (cargo[id] ?? 0) + n;
  // The starter (as issued, or as a new pilot is given it) is the floor: no plan of it, another in its place
  const floor = isFreeStarter(rec) || isStarterDesign(rec.blueprint, self.opts.starter.blueprint);
  if (!floor) loseShip(self, p, rec);
  flyStarter(self, p, floor ? slot : -1);
  let note = floor
    ? `Your ${rec.blueprint.name} was destroyed: you're back in a starter`
    : `Your ${rec.blueprint.name} was lost. Its design is in your hangar, every part to be made again; you're back in a backup`;
  note += leaveWreck(self, s, systemNum, x, y, vx, vy, cargo);
  self.toast(conn, note, 'warn');
  p.stats.deaths = (p.stats.deaths ?? 0) + 1;
  s.dirty = true;
  self.sendItems(conn);
  self.host.send(conn, { type: 'backups', options: backupOptions(self, p), ...(floor ? {} : { lost: rec.blueprint.name }) });
  sendWreck(self, s);
  self.host.hangarChanged?.(conn);
  void persist.save(self, s);
}

/**
 * The share of the ship's standing parts that survive as salvage (salvageShare of them, picked by the payout dice),
 * each as the refined materials of its bill (plate, wire...: docs/design/loot-pickup-2026-11.md B), never as a part;
 * the components in a bill don't come back. The free starter's parts never come back
 */
function salvage(self: Pilots, rec: ShipRecord): Bag {
  const ghosts = new Set(rec.ghosts ?? []), free = new Set(rec.free ?? []);
  const standing = rec.blueprint.parts.filter((q) => !ghosts.has(q.uid) && !free.has(q.uid) && (rec.hp[q.uid] ?? 1) > 0);
  const n = Math.round(standing.length * self.death.salvageShare);
  const out: Bag = {};
  if (n <= 0) return out;
  const dice = self.salvageDice ??= self.host.payout?.('wreck salvage') ?? mulberry32(0x5a1);
  const pool: PlacedPart[] = [...standing];
  for (let k = 0; k < n && pool.length; k++) {
    const q = pool.splice(Math.floor(dice() * pool.length), 1)[0];
    for (const [id, m] of Object.entries(self.econ.recipes.partInputs(q))) if (self.econ.items.get(id)?.category === 'refined') out[id] = (out[id] ?? 0) + m;
  }
  return out;
}

/**
 * The ship is lost: its record becomes its design with every part missing (ghosts, core outwards; the core too), lost
 * and on order (Hangar: it can't be flown until it's whole, and its order can't be called off). Nothing of it is kept:
 * its gems, what its machines held, its loaded mines (its switches stay)
 */
function loseShip(self: Pilots, p: Session['profile'], rec: ShipRecord): void {
  const bp = cloneJson(rec.blueprint);
  for (const q of bp.parts) { delete q.gems; delete q.mods; }
  rec.blueprint = bp;
  const core = coreIndex(bp.parts);
  const adj = adjacency(bp.parts.length, computeJoins(blueprintGeometry(self.ships.catalog, bp)));
  rec.ghosts = core >= 0 ? coreOutwards(bp.parts.map((q) => q.uid), bp.parts, adj, core) : bp.parts.map((q) => q.uid);
  rec.hp = {};
  delete rec.owed;
  delete rec.unbuilt;
  delete rec.free;
  if (rec.field) {
    const { fabOn, refOn, packs, recipe } = rec.field;
    rec.field = { ...(fabOn ? { fabOn } : {}), ...(refOn ? { refOn } : {}), ...(packs ? { packs } : {}), ...(recipe ? { recipe } : {}) };
    if (!Object.keys(rec.field).length) delete rec.field;
  }
  rec.lost = true;
  rec.auto = true;
  rec.paused = false;
  // (Its order goes after the ones already running)
  rec.rank = p.hangar.reduce((m, r) => (r?.auto && r !== rec ? Math.max(m, r.rank ?? 0) : m), 0) + 1;
}

/**
 * The wreck: all the dying ship held. Its pilot's alone for wreckOwnerMinutes, then anyone's for wreckOpenMinutes, then
 * gone; marked on their map. A death inside a boss chamber leaves it outside, where they'd come back (host.wreckSpot).
 * Returns the note to add to their message ('' if nothing was dropped)
 */
function leaveWreck(self: Pilots, s: Session, systemNum: number, x: number, y: number, vx: number, vy: number, cargo: Bag): string {
  if (!Object.keys(cargo).length) return '';
  const { conn, profile: p } = s;
  const D = self.death;
  const spot = self.host.wreckSpot?.(systemNum, x, y);
  const moved = !!spot && (spot.system !== systemNum || spot.x !== x || spot.y !== y);
  if (spot) ({ system: systemNum, x, y } = spot);
  if (moved) { vx = 0; vy = 0; }
  const sysId = self.host.systemId(systemNum);
  const key = self.keyOf(conn);
  const kept = !!(self.host.spawnWreck && key && sysId);
  const own = D.wreckOwnerMinutes * 60, life = own + D.wreckOpenMinutes * 60;
  const eid = kept ? self.host.spawnWreck!(systemNum, x, y, vx * 0.3, vy * 0.3, cargo, key!, own, life) : self.host.spawnPod(systemNum, x, y, vx * 0.5, vy * 0.5, cargo);
  if (!kept || eid < 0) return '';
  const now = self.now();
  p.wreck = { system: sysId!, x: Math.round(x), y: Math.round(y), until: now + own * 1000, gone: now + life * 1000 };
  return `. Your wreck holds your cargo and some salvage${moved ? ', outside the chamber' : ''}: it's marked on your map, yours alone for ${D.wreckOwnerMinutes} minutes, then anyone's for ${D.wreckOpenMinutes}`;
}

/** The loaner lost: its pilot's cargo is wrecked as in any death, nothing else is (the loaner is free, the saved ship as it was) */
function loanerLost(self: Pilots, s: Session, systemNum: number, x: number, y: number, vx: number, vy: number, cargo: Bag): void {
  const { conn, profile: p } = s;
  p.ship = p.hangar[p.activeSlot]!;
  const wreck = leaveWreck(self, s, systemNum, x, y, vx, vy, cargo);
  self.toast(conn, `The loaner was destroyed: it costs you nothing, and you respawn in another${wreck}`, 'info');
  p.stats.deaths = (p.stats.deaths ?? 0) + 1;
  s.dirty = true;
  self.sendItems(conn);
  sendWreck(self, s);
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

/** Tell them where their wreck is and how long it's theirs, then open to all (or that it's gone) */
export function sendWreck(self: Pilots, s: Session): void {
  const w = s.profile.wreck;
  const now = self.now();
  // (A wreck saved before the rework has no `gone`: it went when its keeping ran out)
  const gone = w?.gone ?? w?.until ?? 0;
  if (!w || gone <= now) {
    if (w) { s.profile.wreck = undefined; s.dirty = true; }
    self.host.send(s.conn, { type: 'wreck', gone: true });
    return;
  }
  const own = Math.max(0, w.until - now);
  self.host.send(s.conn, { type: 'wreck', system: w.system, x: w.x, y: w.y, seconds: Math.round(own / 1000), open: Math.round((gone - now - own) / 1000) });
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
