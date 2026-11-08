/**
 * The hangar palette's subcategories (no DOM): each category tab splits into a few groups, and weapons also filter by
 * whether they need ammunition and by mount. Pure so it can be tested; HangarPalette shows the chips and remembers the
 * choice (`loadFilters` / `saveFilters`, per viewer in localStorage).
 *
 * A weapon's role comes from its data, never a list of ids: held or pulsed beams, guided (homing) rounds, area rounds
 * (a blast radius), clip and charge guns (bursts), then plain direct fire; repair and point defence are support.
 */

import type { Catalog, FunctionDef, ShipTuning } from '@space-game/common';
import { partMount } from '@space-game/common';
import type { CompTab } from '../ui/componentGuide';
import type { PaletteRow } from './paletteModel';

export const ALL = 'all';

export type WeaponRole = 'direct' | 'burst' | 'beam' | 'guided' | 'area' | 'support';

export interface SubDef { id: string; label: string; hint?: string }

const WEAPON_SUBS: SubDef[] = [
  { id: 'direct', label: 'Direct', hint: 'One shot at a time, in a straight line' },
  { id: 'burst', label: 'Burst', hint: 'Clips and charged shots' },
  { id: 'beam', label: 'Beam', hint: 'Held beams and pulse lasers' },
  { id: 'guided', label: 'Guided', hint: 'Rounds that steer to a target' },
  { id: 'area', label: 'Area', hint: 'Rounds that burst on landing' },
  { id: 'support', label: 'Support', hint: 'Repair and point defence' },
];

/** Non-weapon groups: by structure function or by model family */
const GROUPS: Record<Exclude<CompTab, 'weapons'>, { sub: SubDef; match: string[] }[]> = {
  structure: [
    { sub: { id: 'hull', label: 'Hull' }, match: ['hull'] },
    { sub: { id: 'armor', label: 'Armour' }, match: ['armor'] },
    { sub: { id: 'cargo', label: 'Cargo' }, match: ['cargo'] },
    { sub: { id: 'core', label: 'Core' }, match: ['core'] },
  ],
  engines: [
    { sub: { id: 'thrust', label: 'Engines' }, match: ['ion', 'afterburner', 'plasma'] },
    { sub: { id: 'jump', label: 'Jump' }, match: ['jumpcoil'] },
    { sub: { id: 'steer', label: 'Steering', hint: 'Strafers and gyros' }, match: ['strafer', 'gyro'] },
  ],
  power: [
    { sub: { id: 'make', label: 'Generators' }, match: ['reactor'] },
    { sub: { id: 'store', label: 'Storage', hint: 'Batteries, capacitors and drive cells' }, match: ['battery', 'capacitor', 'drive_cell'] },
    { sub: { id: 'link', label: 'Links', hint: 'Relays, feeds and chargers' }, match: ['relay', 'feed', 'dynamo'] },
  ],
  shields: [
    { sub: { id: 'shield', label: 'Shields' }, match: ['shield'] },
    { sub: { id: 'plating', label: 'Plating' }, match: ['plating'] },
  ],
  utility: [
    { sub: { id: 'mine', label: 'Mining', hint: 'Lasers, bores and siphons' }, match: ['mining', 'demolition', 'siphon'] },
    { sub: { id: 'tools', label: 'Tools', hint: 'Scanners, constructors and beams' }, match: ['scanner', 'constructor', 'repair', 'tow'] },
    { sub: { id: 'machines', label: 'Machines', hint: 'Fabricators, refiners, mine bays and clamps' }, match: ['fabricator', 'refiner', 'minebay', 'clamp'] },
  ],
};

/** A weapon's role, from its firing model and its tuning */
export function weaponRole(f: FunctionDef, tuning: ShipTuning | undefined): WeaponRole {
  const w = f.weapon ? tuning?.weapons?.[f.weapon] : undefined;
  if (w?.heal || w?.pointDefence || f.fire?.model === 'auto') return 'support';
  if (w?.type === 'beam' || f.fire?.model === 'beam' || w?.pulse) return 'beam';
  if ((w?.homing ?? 0) > 0) return 'guided';
  if (w?.splash || w?.emp) return 'area';
  if (f.fire?.model === 'clip' || f.fire?.model === 'charge') return 'burst';
  return 'direct';
}

/** Does the weapon pay for its rounds with ammunition items (it has an ammo crate in tuning) */
export function usesAmmo(f: FunctionDef): boolean {
  return f.fire?.model === 'ammo';
}

/** The groups a tab splits into (just the tab's own when it has one; `ALL` is the first chip and not listed) */
export function subsOf(tab: CompTab): SubDef[] {
  return tab === 'weapons' ? WEAPON_SUBS : GROUPS[tab].map((g) => g.sub);
}

/** Which group of its tab a function sits in (null: none, it shows under All only) */
export function subOfFn(tab: CompTab, f: FunctionDef, tuning: ShipTuning | undefined): string | null {
  if (tab === 'weapons') return f.weapon ? weaponRole(f, tuning) : null;
  const key = tab === 'structure' ? f.id : f.family ?? '';
  return GROUPS[tab].find((g) => g.match.includes(key))?.sub.id ?? null;
}

export type AmmoFilter = 'any' | 'ammo' | 'none';
export type MountFilter = 'any' | 'fixed' | 'turret';

export interface FilterState {
  /** The group chosen under each tab (absent: All) */
  sub: Partial<Record<CompTab, string>>;
  ammo: AmmoFilter;
  mount: MountFilter;
}

export function emptyFilters(): FilterState {
  return { sub: {}, ammo: 'any', mount: 'any' };
}

/** The rows of `tab` that pass the filters (the ammo and mount ones apply to weapons only) */
export function applyFilters(rows: readonly PaletteRow[], tab: CompTab, st: FilterState, catalog: Catalog, tuning: ShipTuning | undefined): PaletteRow[] {
  const sub = st.sub[tab] ?? ALL;
  return rows.filter((r) => {
    const f = catalog.functions.get(r.fn);
    if (!f) return true;
    if (sub !== ALL && subOfFn(tab, f, tuning) !== sub) return false;
    if (tab === 'weapons' && f.weapon) {
      if (st.ammo !== 'any' && usesAmmo(f) !== (st.ammo === 'ammo')) return false;
      if (st.mount !== 'any' && partMount(catalog, { fn: f.id }) !== st.mount) return false;
    }
    return true;
  });
}

/** How many of `rows` fall in each group (and `ALL`), for the chips' counts; groups with none are left out of the result */
export function subCounts(rows: readonly PaletteRow[], tab: CompTab, catalog: Catalog, tuning: ShipTuning | undefined): Map<string, number> {
  const out = new Map<string, number>([[ALL, rows.length]]);
  for (const r of rows) {
    const f = catalog.functions.get(r.fn);
    const s = f ? subOfFn(tab, f, tuning) : null;
    if (s) out.set(s, (out.get(s) ?? 0) + 1);
  }
  return out;
}

const KEY = 'hangar.palette.filters.v1';

function clean(v: unknown): FilterState {
  const out = emptyFilters();
  if (!v || typeof v !== 'object') return out;
  const o = v as Partial<FilterState>;
  if (o.sub && typeof o.sub === 'object') {
    for (const [tab, id] of Object.entries(o.sub)) {
      if (tab in GROUPS || tab === 'weapons') {
        const ok = subsOf(tab as CompTab).some((s) => s.id === id);
        if (ok) out.sub[tab as CompTab] = id as string;
      }
    }
  }
  if (o.ammo === 'ammo' || o.ammo === 'none') out.ammo = o.ammo;
  if (o.mount === 'fixed' || o.mount === 'turret') out.mount = o.mount;
  return out;
}

/** The remembered choice (storage can be blocked or empty: then nothing is filtered) */
export function loadFilters(storage: Pick<Storage, 'getItem'> | null = safeStorage()): FilterState {
  try {
    const raw = storage?.getItem(KEY);
    return raw ? clean(JSON.parse(raw)) : emptyFilters();
  } catch {
    return emptyFilters();
  }
}

export function saveFilters(st: FilterState, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(st));
  } catch { /* blocked storage: the choice just isn't kept */ }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
