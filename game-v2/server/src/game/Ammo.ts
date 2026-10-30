/**
 * Ammunition: guns whose tuning names an `ammo` crate (tuning.json weapons)
 * fire from crates in the hold. Each volley spends a round; an emptied crate
 * is opened from cargo; with none left the gun fires plain rounds (the same
 * shells, so every client's tracers still agree, at a share of the damage and
 * with none of its effects). A gun can take other crates too (items.json
 * ammoFor: sabot slugs, chaff canisters...), whose rounds change what the
 * server works out (damage, pierce, burning...), never the shells' flight.
 * Each ship in the hangar has a loadout (common econ/loadout.ts): the crates
 * to carry and which each gun opens first. Docking, launching and switching
 * ships top the hold up from storage to it, and its crates are opened before
 * any others. The storage controls never sweep them (Pilots.handleStore).
 */

import {
  ShipTuning, ShipState, ShipRecord, PlayerProfile, Catalog, Bag, countOf, addTo, removeFrom, weaponDef, cratesFor, chooseCrate,
  loadoutKinds, shipLoadout, crateOrder, DEFAULT_CRATES, MAX_LOADOUT_CRATES, type WeaponMods, type ItemCatalog,
} from '@space-game/common';
import type { Pilots, PilotConn } from './Pilots.js';

export { DEFAULT_CRATES };
const DRY = 0.4;

export class Ammo {
  /** Pilots told they're firing plain rounds (until they have ammunition again) */
  private dry = new Set<PilotConn>();
  /** Every crate each weapon kind takes, the standard one first */
  private crates = new Map<string, string[]>();

  /** Resend the hangar (a slot's loadout changed) */
  hangar?: (conn: PilotConn) => void;

  constructor(private pilots: Pilots, private tuning: ShipTuning, private catalog: Catalog) {
    void (pilots.econ.items as ItemCatalog);
    pilots.loadout = (p) => ({ load: this.loadoutOf(p.ship), first: this.firstOf(p) });
    for (const kind of Object.keys(tuning.weapons ?? {})) {
      const c = cratesFor(tuning, kind);
      if (c.length) this.crates.set(kind, c);
    }
  }

  /** Does this gun need ammunition (else it fires plain shells for free, and special crates are a choice) */
  private needs(kind: string): boolean {
    return !!weaponDef(this.tuning, kind).ammo;
  }

  /** A crate's rounds and what they change */
  private crate(item: string, kind: string): { rounds: number; mods?: WeaponMods } {
    const d = this.pilots.econ.items.get(item);
    return { rounds: d?.ammoFor?.rounds ?? weaponDef(this.tuning, kind).ammo?.rounds ?? 1, mods: d?.ammoFor?.mods };
  }

  /** A gun of `kind` fires a volley: spend a round. Its damage share, whether it's a plain round, and which crate (and its mods) */
  spend(conn: PilotConn, kind: string, free = false): { scale: number; dry: boolean; mods?: WeaponMods; item?: string } {
    const crates = this.crates.get(kind);
    const p = crates && this.pilots.get(conn);
    if (!crates || !p) return { scale: 1, dry: false };
    const ammo = p.ammo ?? { open: {}, load: {} };
    // The loadout's crates open before any others; its first pick before those
    const pick = chooseCrate(crateOrder(crates, this.loadoutOf(p.ship)), this.firstOf(p)[kind], ammo.open, (c) => countOf(p.cargo, c) > 0);
    if (pick) {
      p.ammo = ammo;
      if (pick.opening) {
        removeFrom(p.cargo, pick.item, 1);
        ammo.open[pick.item] = this.crate(pick.item, kind).rounds;
        this.pilots.markDirty(conn);
        this.pilots.sendItems(conn);
        this.pilots.sendProfile(conn);
      }
      if (--ammo.open[pick.item] <= 0) { delete ammo.open[pick.item]; this.pilots.sendProfile(conn); }
      this.dry.delete(conn);
      return { scale: 1, dry: false, mods: this.crate(pick.item, kind).mods, item: pick.item };
    }
    // A free gun with no special crates aboard just fires
    if (free || !this.needs(kind)) return { scale: 1, dry: false };
    const dry = weaponDef(this.tuning, kind).ammo?.dry ?? DRY;
    if (!this.dry.has(conn)) {
      this.dry.add(conn);
      this.pilots.sendProfile(conn);
      this.pilots.toast(conn, `Out of ammunition for the ${kind}: firing plain rounds (${Math.round(dry * 100)}% damage)`, 'warn');
    }
    return { scale: dry, dry: true };
  }

  /** Open this kind of crate first (for the gun it's for), on the ship you fly */
  prefer(conn: PilotConn, item: string): void {
    const p = this.pilots.get(conn);
    const kind = this.pilots.econ.items.get(item)?.ammoFor?.weapon;
    if (!p || !kind || !this.crates.get(kind)?.includes(item)) return;
    const lo = (p.ship.ammo ??= { load: this.saved(p.ship) });
    (lo.first ??= {})[kind] = item;
    this.pilots.markDirty(conn);
    this.pilots.sendProfile(conn);
    this.hangar?.(conn);
    this.pilots.toast(conn, `${this.pilots.econ.items.name(item)} load first`, 'info');
  }

  /** A ship's loadout as it stands, written out in full (so changing one crate keeps the defaults of the rest) */
  private saved(rec: ShipRecord): Record<string, number> {
    const out: Record<string, number> = { ...rec.ammo?.load };
    const eff = this.loadoutOf(rec);
    for (const kind of loadoutKinds(this.catalog, this.tuning, rec.blueprint)) for (const c of this.crates.get(kind) ?? []) out[c] = eff[c] ?? 0;
    return out;
  }

  /** Each record's loadout as last worked out, for the design and loadout it was worked out from (spend asks every volley) */
  private loadouts = new WeakMap<ShipRecord, { bp: ShipRecord['blueprint']; ammo: ShipRecord['ammo']; load: Bag }>();

  /** What a ship carries: crate → count (econ/loadout.ts) */
  loadoutOf(rec: ShipRecord | undefined): Bag {
    if (!rec) return {};
    const c = this.loadouts.get(rec);
    if (c && c.bp === rec.blueprint && c.ammo === rec.ammo) return c.load;
    const load = shipLoadout(this.catalog, this.tuning, rec.blueprint, rec.ammo);
    this.loadouts.set(rec, { bp: rec.blueprint, ammo: rec.ammo, load });
    return load;
  }

  /** Each gun kind's first crate on a ship: its own pick, else the one an old save named */
  firstOf(p: PlayerProfile): Record<string, string> {
    return { ...p.ammo?.prefer, ...p.ship.ammo?.first };
  }

  /**
   * Set a hangar slot's loadout (any slot; the ship you fly is topped up at
   * once if you're at a station). Only crates its guns take, whole counts up
   * to MAX_LOADOUT_CRATES; a first pick must be one of that gun's crates.
   */
  setLoadout(conn: PilotConn, slot: number, load: unknown, first: unknown): void {
    const p = this.pilots.get(conn);
    const rec = Number.isInteger(slot) ? p?.hangar[slot] : undefined;
    if (!p || !rec || !load || typeof load !== 'object') return;
    const kinds = loadoutKinds(this.catalog, this.tuning, rec.blueprint);
    const allowed = new Set(kinds.flatMap((k) => this.crates.get(k) ?? []));
    const next: Record<string, number> = {};
    for (const [id, n] of Object.entries(load as Record<string, unknown>)) {
      if (!allowed.has(id) || typeof n !== 'number' || !Number.isFinite(n)) continue;
      next[id] = Math.max(0, Math.min(MAX_LOADOUT_CRATES, Math.floor(n)));
    }
    const picks: Record<string, string> = {};
    for (const [kind, id] of Object.entries(first && typeof first === 'object' ? first as Record<string, unknown> : {})) {
      if (kinds.includes(kind) && typeof id === 'string' && this.crates.get(kind)?.includes(id)) picks[kind] = id;
    }
    // Kinds not mentioned keep what they had
    rec.ammo = { load: { ...this.saved(rec), ...next }, ...(Object.keys(picks).length || rec.ammo?.first ? { first: { ...rec.ammo?.first, ...picks } } : {}) };
    this.pilots.markDirty(conn);
    if (rec === p.ship) {
      this.pilots.sendProfile(conn);
      if (this.pilots.atStation(conn)) this.restock(conn, { report: true });
    }
    this.hangar?.(conn);
  }

  /**
   * Top the hold up from storage to the loadout of the ship you fly (at a
   * station), as far as storage and the hold allow. `report`: say what's
   * short (and where more comes from); `quiet`: but not that it's all aboard.
   */
  restock(conn: PilotConn, opts: { report?: boolean; quiet?: boolean } = {}): { moved: Bag; short: Bag } {
    const p = this.pilots.get(conn);
    const moved: Bag = {}, short: Bag = {};
    if (!p || !this.pilots.atStation(conn)) return { moved, short };
    const items = this.pilots.econ.items;
    for (const [item, want] of Object.entries(this.loadoutOf(p.ship))) {
      const need = want - countOf(p.cargo, item);
      if (need <= 0) continue;
      const n = Math.min(need, countOf(p.storage, item), Math.floor(this.pilots.cargoFree(conn) / Math.max(1e-9, items.volume(item)) + 1e-9));
      if (n > 0) {
        removeFrom(p.storage, item, n);
        addTo(p.cargo, item, n);
        moved[item] = n;
      }
      if (n < need) short[item] = need - n;
    }
    const list = (b: Bag) => Object.entries(b).map(([id, n]) => `${n} × ${items.name(id)}`).join(', ');
    if (Object.keys(moved).length) {
      this.pilots.markDirty(conn);
      this.pilots.sendItems(conn);
      this.pilots.toast(conn, `Loadout restocked from storage: ${list(moved)}`, 'info');
    }
    if (opts.report && Object.keys(short).length) {
      const full = Object.keys(short).some((id) => countOf(p.storage, id) > 0);
      this.pilots.toast(conn, `Short of your loadout: ${list(short)}. ${full ? 'The hold is full. ' : ''}Make more at a fabricator (or order it in the hangar), or buy it at a market that sells it.`, 'warn');
    } else if (opts.report && !Object.keys(moved).length && !opts.quiet) {
      this.pilots.toast(conn, 'Your loadout is all aboard', 'info');
    }
    return { moved, short };
  }

  /** A pilot whose guns take ammunition, logging in for the first time since they did: a few crates from the armoury, in storage */
  firstIssue(conn: PilotConn, ship: ShipState | undefined): void {
    const p = this.pilots.get(conn);
    if (!p || p.ammo || !ship) return;
    const kinds = [...new Set(ship.derived.weapons.filter((w) => this.needs(w.kind) && this.crates.has(w.kind)).map((w) => this.crates.get(w.kind)![0]))];
    if (!kinds.length) return;
    p.ammo = { open: {}, load: {} };
    const bag: Record<string, number> = {};
    for (const item of kinds) bag[item] = DEFAULT_CRATES;
    this.pilots.give(conn, bag, { toStorage: true, quiet: true });
    this.pilots.markDirty(conn);
    this.pilots.toast(conn, `Your guns take ammunition now: the armoury left ${kinds.map((i) => `${DEFAULT_CRATES} × ${this.pilots.econ.items.name(i)}`).join(', ')} in storage. Make more at any fabricator.`, 'info');
  }

  forget(conn: PilotConn): void {
    this.dry.delete(conn);
  }
}
