/**
 * @contract server.pilots.cargo
 * owns:       the hold and storage: capacity, give/take, move, store, jettison, use, scrap
 * needs:      Pilots (sessions, econ, host, ships), common/econ bags; npm: bitecs
 * invariants: cargo never exceeds capacity: give() takes only what fits, a move to the hold clips, only toStorage skips it — server/src/game/pilots/cargo.test.ts
 * extend:     a new item action is a handleX here and a message handler calling it
 */

import { hasComponent } from 'bitecs';
import { FULL_CHARGE, Player, Position, Velocity, Rotation, InSystem, Dead, Boost, PlayerProfile, Bag, holdClass, sweeps, STORE_SWEEPS, type StoreSweep, countOf, addTo, removeFrom, SALVAGE, skillValue, salvageOf, isStructuralItem, parsePartItemId, dcos, dsin } from '@space-game/common';
import type { Pilots, PilotConn } from '../Pilots.js';

export function cargoCapacity(self: Pilots, conn: PilotConn): number {
  const nav = self.sessions.get(conn)?.profile.skills.navigation ?? 0;
  return Math.floor((self.ships.get(conn.playerId)?.derived.cargoCapacity ?? 0) * (1 + skillValue('navigation', nav)));
}

export function cargoUsed(self: Pilots, profile: PlayerProfile): number {
  return profile.cargo.reduce((t, s) => t + s.n * self.econ.items.volume(s.id), 0);
}

/** Mass of what's in a pilot's hold (common/src/ships/load.ts: a full hold flies heavy); storage weighs nothing */
export function cargoMass(self: Pilots, eid: number): number {
  const conn = self.connOf(eid);
  const s = conn && self.sessions.get(conn);
  return s ? self.econ.items.massOf(s.profile.cargo) : 0;
}

/** Room left in cargo, in volume units */
export function cargoFree(self: Pilots, conn: PilotConn): number {
  const s = self.sessions.get(conn);
  return s ? Math.max(0, cargoCapacity(self, conn) - cargoUsed(self, s.profile)) : 0;
}

/** Near enough a station to reach storage */
export function atStation(self: Pilots, conn: PilotConn): boolean {
  const eid = conn.playerId;
  if (!hasComponent(self.host.world, Player, eid) || hasComponent(self.host.world, Dead, eid)) return false;
  return conn.docked !== null || self.host.stationInRange(eid) >= 0;
}

/**
 * Put items in cargo as far as there's room. Returns what didn't fit.
 * `toStorage` sends them straight to storage instead (quest rewards, crafting).
 */
export function give(self: Pilots, conn: PilotConn, items: Bag, opts: { toStorage?: boolean; source?: string; at?: { x: number; y: number }; quiet?: boolean } = {}): Bag {
  const s = self.sessions.get(conn);
  if (!s) return items;
  // Structure is never kept as items: it arrives as what it's made of
  if (Object.keys(items).some(isStructuralItem)) {
    const flat: Bag = {};
    for (const [id, n] of Object.entries(items)) {
      const part = isStructuralItem(id) ? parsePartItemId(id) : null;
      if (part) for (const [m, k] of Object.entries(self.econ.recipes.partInputs(part))) flat[m] = (flat[m] ?? 0) + k * n;
      else flat[id] = (flat[id] ?? 0) + n;
    }
    items = flat;
  }
  const left: Bag = {};
  const got: Bag = {};
  let free = opts.toStorage ? Infinity : cargoFree(self, conn);
  for (const [id, n] of Object.entries(items)) {
    if (!self.econ.items.has(id) || n <= 0) continue;
    const vol = self.econ.items.volume(id);
    const fit = opts.toStorage ? n : Math.min(n, Math.floor(free / vol + 1e-9));
    if (fit > 0) {
      addTo(opts.toStorage ? s.profile.storage : s.profile.cargo, id, fit);
      got[id] = fit;
      free -= fit * vol;
    }
    if (fit < n) left[id] = n - fit;
  }
  if (Object.keys(got).length) {
    s.dirty = true;
    self.sendItems(conn);
    if (!opts.quiet) self.host.send(conn, { type: 'gained', items: got, source: opts.source, x: opts.at?.x, y: opts.at?.y });
    self.emit(conn, { type: 'items', items: got, source: opts.source });
    if (opts.source === 'mined') {
      self.bumpStat(conn, 'mined', Object.values(got).reduce((t, k) => t + k, 0));
      for (const [id, k] of Object.entries(got)) self.bumpStat(conn, `mined:${id}`, k);
    }
  }
  return left;
}

/** Take items from cargo then storage (storage only at a station); false (taking nothing) if short */
export function take(self: Pilots, conn: PilotConn, need: Bag, from: 'cargo' | 'storage' | 'any' = 'any'): boolean {
  const s = self.sessions.get(conn);
  if (!s) return false;
  const useStorage = from === 'storage' || (from === 'any' && atStation(self, conn));
  const useCargo = from !== 'storage';
  const have = (id: string) => (useCargo ? countOf(s.profile.cargo, id) : 0) + (useStorage ? countOf(s.profile.storage, id) : 0);
  if (!Object.entries(need).every(([id, n]) => have(id) >= n)) return false;
  for (const [id, n] of Object.entries(need)) {
    const fromStore = useStorage ? removeFrom(s.profile.storage, id, n) : 0;
    if (fromStore < n && useCargo) removeFrom(s.profile.cargo, id, n - fromStore);
  }
  s.dirty = true;
  self.sendItems(conn);
  return true;
}

/** Take every one of an item, wherever it is (a job's own items, when it's abandoned) */
export function removeEverywhere(self: Pilots, conn: PilotConn, id: string): number {
  const s = self.sessions.get(conn);
  if (!s) return 0;
  const n = removeFrom(s.profile.cargo, id, countOf(s.profile.cargo, id)) + removeFrom(s.profile.storage, id, countOf(s.profile.storage, id));
  if (n > 0) { s.dirty = true; self.sendItems(conn); }
  return n;
}

/** How many of an item the pilot can use right now (cargo, plus storage at a station) */
export function available(self: Pilots, conn: PilotConn, id: string): number {
  const s = self.sessions.get(conn);
  if (!s) return 0;
  return countOf(s.profile.cargo, id) + (atStation(self, conn) ? countOf(s.profile.storage, id) : 0);
}

export function handleMove(self: Pilots, conn: PilotConn, msg: { id: string; n: number; to: 'cargo' | 'storage' }): void {
  const s = self.sessions.get(conn);
  if (!s || typeof msg.id !== 'string' || !Number.isFinite(msg.n)) return;
  if (!atStation(self, conn)) return self.toast(conn, 'Storage is only reachable at a station', 'warn');
  const from = msg.to === 'cargo' ? s.profile.storage : s.profile.cargo;
  const to = msg.to === 'cargo' ? s.profile.cargo : s.profile.storage;
  let n = Math.min(Math.max(1, Math.floor(msg.n)), countOf(from, msg.id));
  if (msg.to === 'cargo') n = Math.min(n, Math.floor(cargoFree(self, conn) / self.econ.items.volume(msg.id) + 1e-9));
  if (n <= 0) return self.toast(conn, msg.to === 'cargo' ? 'Cargo hold is full' : 'Nothing to move', 'warn');
  removeFrom(from, msg.id, n);
  addTo(to, msg.id, n);
  s.dirty = true;
  self.sendItems(conn);
}

/**
 * A quick storage control (at a station): every stack in the hold of the
 * kinds it sweeps (common econ/loadout.ts). Only 'all' takes ammunition,
 * the loadout's crates, utility (consumables, the quick bar) and job items.
 */
export function handleStore(self: Pilots, conn: PilotConn, what: unknown): void {
  const s = self.sessions.get(conn);
  if (!s || !STORE_SWEEPS.includes(what as StoreSweep)) return;
  if (!atStation(self, conn)) return self.toast(conn, 'Storage is only reachable at a station', 'warn');
  const p = s.profile;
  const ctx = { loadout: self.loadout?.(p).load, quickbar: p.quickbar };
  let n = 0;
  for (const st of [...p.cargo]) {
    if (!sweeps(what as StoreSweep, holdClass(st.id, self.econ.items.get(st.id), ctx))) continue;
    const k = removeFrom(p.cargo, st.id, st.n);
    addTo(p.storage, st.id, k);
    n += k;
  }
  if (!n) return self.toast(conn, 'Nothing in the hold of that kind', 'info');
  s.dirty = true;
  self.sendItems(conn);
}

export function handleJettison(self: Pilots, conn: PilotConn, msg: { id: string; n: number }): void {
  const s = self.sessions.get(conn);
  const eid = conn.playerId;
  if (!s || typeof msg.id !== 'string' || !hasComponent(self.host.world, Player, eid) || hasComponent(self.host.world, Dead, eid)) return;
  const want = Math.floor(Number(msg.n));
  const n = removeFrom(s.profile.cargo, msg.id, Number.isFinite(want) && want >= 1 ? want : 1);
  if (n <= 0) return;
  const a = Rotation.angle[eid] + Math.PI;
  const r = (self.ships.get(eid)?.derived.radius ?? 40) + 40;
  self.host.spawnPod(InSystem.systemId[eid], Position.x[eid] + dcos(a) * r, Position.y[eid] + dsin(a) * r,
    Velocity.x[eid] + dcos(a) * 1.5, Velocity.y[eid] + dsin(a) * 1.5, { [msg.id]: n }, eid);
  s.dirty = true;
  self.sendItems(conn);
}

/** Consumables */
export function handleUse(self: Pilots, conn: PilotConn, msg: { id: string }): void {
  const s = self.sessions.get(conn);
  const eid = conn.playerId;
  if (!s || typeof msg.id !== 'string') return;
  const def = self.econ.items.get(msg.id);
  if (!def || available(self, conn, msg.id) <= 0) return;
  const alive = hasComponent(self.host.world, Player, eid) && !hasComponent(self.host.world, Dead, eid);
  if (!alive) return;
  switch (msg.id) {
    case 'scanner_charge':
      take(self, conn, { scanner_charge: 1 });
      self.host.send(conn, { type: 'scanPulse', seconds: 30 });
      return;
    case 'boost_cell':
      // Tops up every battery (energy.ts)
      if (Boost.fuel[eid] >= 99.5) return self.toast(conn, 'Your batteries are full', 'info');
      take(self, conn, { boost_cell: 1 });
      self.ships.setCharge(eid, FULL_CHARGE);
      return;
    default:
      self.toast(conn, `${def.name} can't be used like that`, 'info');
  }
}

/** Scrap modules from storage (or the hold) at a station: SALVAGE of their minerals as ore, their components in full */
export function scrapItem(self: Pilots, conn: PilotConn, id: string, n: number): void {
  const s = self.sessions.get(conn);
  if (!s) return;
  if (!s.atStation) return self.toast(conn, 'Scrap parts at a station', 'warn');
  if (!parsePartItemId(id)) return self.toast(conn, 'Only ship parts can be scrapped', 'info');
  const k = Math.min(available(self, conn, id), Math.max(1, n || 1));
  if (k <= 0) return;
  take(self, conn, { [id]: k });
  const salvage = salvageOf(self.econ, { [id]: k });
  give(self, conn, salvage, { toStorage: true, source: 'salvaged' });
  self.toast(conn, `Scrapped ${k} × ${self.econ.items.name(id)}`, 'info');
  self.saveNow(conn);
}

/**
 * Structure isn't kept as items any more (it's paid in materials when it's
 * placed): turn any in storage or the hold back into what it's made of.
 * True if anything changed.
 */
export function structureToMaterials(self: Pilots, p: PlayerProfile): boolean {
  let changed = false;
  for (const list of [p.storage, p.cargo]) {
    for (const st of [...list]) {
      if (!isStructuralItem(st.id)) continue;
      const part = parsePartItemId(st.id)!;
      removeFrom(list, st.id, st.n);
      for (const [id, k] of Object.entries(self.econ.recipes.partInputs(part))) addTo(p.storage, id, k * st.n);
      changed = true;
    }
  }
  return changed;
}
