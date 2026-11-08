/**
 * PlayerProfile: everything saved about a pilot between sessions.
 *
 * Stored as one JSON document per account (JsonProfileStore writes a file,
 * PostgresProfileStore a jsonb row). `version` lets old saves be upgraded by
 * migrateProfile() whenever the shape changes.
 */

import type { Blueprint, FunctionDef } from '../ships/types.js';
import type { Catalog } from '../ships/catalog.js';
import { migrateBlueprint, migrateItemBag, migratePartItem } from '../ships/migrate.js';
import { migrateGunFacings } from '../ships/gunFacing.js';
import { modelLicensed } from './market.js';
import { Stack, Bag, cleanStacks, addTo } from './stacks.js';
import { levelAt } from './levels.js';
import { retireSchematics } from './retired.js';
import { unlocks } from './unlocks.js';
import type { TraceLedger } from './traces.js';
import type { Outpost } from './outpost.js';
import type { ShipLoadout } from './loadout.js';
import type { Economy } from './economy.js';
import { fieldUpdate } from './fieldUpdate.js';
import { designUpdateShips, fingerprint, type DesignUpdate, type DesignUpdateReport } from './designUpdate.js';
import type { ShipTuning } from '../ships/tuning.js';
import { cleanBank, type RepairBank } from './field/bank.js';
import { cleanFieldRecord, type FieldRecord } from './field/record.js';

/** An order at the fabricator: `n` of `item`, `made` so far */
export interface FabOrder { id: number; item: string; n: number; made: number }

function cleanWreck(v: unknown): { wreck?: PlayerProfile['wreck'] } {
  const w = v as PlayerProfile['wreck'];
  return w && typeof w.system === 'string' && Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.until) ? { wreck: { system: w.system, x: w.x, y: w.y, until: w.until } } : {};
}

function cleanOutpost(v: unknown): { outpost?: Outpost } {
  const r = rec<unknown>(v);
  if (typeof r.site !== 'string') return {};
  const tracks = Object.fromEntries(Object.entries(rec<unknown>(r.tracks)).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => [k, Math.floor(n as number)]));
  const b = rec<unknown>(r.build);
  const build = typeof b.track === 'string' && typeof b.tier === 'number' && typeof b.readyAt === 'number' ? { build: { track: b.track, tier: b.tier, readyAt: b.readyAt } } : {};
  return { outpost: { site: r.site, tracks, ...build } };
}

function cleanAmmo(v: unknown): { ammo?: PlayerProfile['ammo'] } {
  const r = rec<unknown>(v);
  const counts = (x: unknown) => Object.fromEntries(Object.entries(rec<unknown>(x)).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => [k, Math.floor(n as number)]));
  const open = counts(r.open), load = counts(r.load);
  const prefer = Object.fromEntries(Object.entries(rec<unknown>(r.prefer)).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  return Object.keys(open).length || Object.keys(load).length || Object.keys(prefer).length
    ? { ammo: { open, load, ...(Object.keys(prefer).length ? { prefer } : {}) } } : {};
}

/** A ship's loadout as saved: whole crate counts (0 kept: it means none) and first picks */
function cleanLoadout(v: unknown): { ammo?: ShipLoadout } {
  const r = rec<unknown>(v);
  const load = Object.fromEntries(Object.entries(rec<unknown>(r.load)).filter(([, n]) => typeof n === 'number' && Number.isFinite(n) && n >= 0).map(([k, n]) => [k, Math.floor(n as number)]));
  const first = Object.fromEntries(Object.entries(rec<unknown>(r.first)).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  if (!Object.keys(load).length && !Object.keys(first).length) return {};
  return { ammo: { load, ...(Object.keys(first).length ? { first } : {}) } };
}

function cleanTraces(v: unknown): { traces?: TraceLedger } {
  const out: TraceLedger = {};
  for (const [id, a] of Object.entries(rec<{ owed?: unknown; ore?: unknown; carry?: unknown }>(v))) {
    if (!a || typeof a !== 'object') continue;
    const owed = num(a.owed, 0), ore = num(a.ore, 0), carry = num(a.carry, 0);
    if (owed > 0 || ore > 0 || carry > 0) out[id] = { owed: Math.max(0, owed), ore: Math.max(0, ore), carry: Math.max(0, carry) };
  }
  return Object.keys(out).length ? { traces: out } : {};
}

/** Records (absent from older saves: none found yet); only found ones can be fresh */
function cleanNotices(v: unknown): { notices?: ProfileNotice[] } {
  const out: ProfileNotice[] = [];
  for (const n of Array.isArray(v) ? v : []) {
    const r = rec<unknown>(n);
    if (typeof r.text !== 'string') continue;
    const items = Object.fromEntries(Object.entries(rec<unknown>(r.items)).filter(([, k]) => typeof k === 'number' && k > 0)) as Bag;
    out.push({ text: r.text, ...(Object.keys(items).length ? { items } : {}) });
  }
  return out.length ? { notices: out } : {};
}

function cleanCodex(v: unknown): PlayerProfile['codex'] {
  const r = rec<unknown>(v);
  const found = [...new Set(strs(r.found))];
  return { found, fresh: strs(r.fresh).filter((id) => found.includes(id)) };
}

export const QUICKBAR_SLOTS = 5;

export const PROFILE_VERSION = 6;

/** A ship as saved: its design and each part's HP fraction by uid (absent = full, 0 = destroyed) */
export interface ShipRecord {
  blueprint: Blueprint;
  hp: Record<number, number>;
  /** Parts designed but not built yet (uids, core outwards): the hangar fills them as parts arrive */
  ghosts?: number[];
  /** The ship plan it was started from (quests look for it) */
  plan?: string;
  /** Lost in battle: being rebuilt from its salvage, and can't be flown until it's whole again */
  lost?: boolean;
  /** The hangar is building it: refining, fabricating and fitting what it needs as materials allow */
  auto?: boolean;
  /** On order but held: the hangar starts nothing new for it (and its jobs wait) */
  paused?: boolean;
  /** Order priority: lower goes first (econ/orders.ts) */
  rank?: number;
  /** Old saves only (loaners are gone, v6): nothing writes it, and the field update drops such records */
  loaner?: boolean;
  /** Ghosts owed to a death (uids): parts of its own design the repair bank rebuilds, apart from planned (field plan) ones it never pays (server/src/game/RepairBank.ts) */
  owed?: number[];
  /** Its ammunition loadout (econ/loadout.ts): crates to carry, topped up from storage at a station, and which each gun opens first */
  ammo?: ShipLoadout;
  /** Field work kept between sessions: machine switches, the recycling queue, planned parts waiting, what the machines hold (econ/field/record.ts) */
  field?: FieldRecord;
}

/**
 * A fabricator job: `count` runs of a recipe, one after another, each taking
 * `unitMs`. Each run's output goes to storage as it finishes (wall-clock ms).
 */
export interface CraftJob {
  id: number;
  recipe: string;
  station: string;
  /** Output of one run */
  out: Bag;
  count: number;
  /** Runs delivered so far */
  done: number;
  unitMs: number;
  startedAt: number;
  readyAt: number;
  /** Queued by a hangar order: the ship it's for, and its slot */
  for?: string;
  slot?: number;
  /** Held: it waits (others in its queue move up) until resumed, keeping the progress of its current run */
  paused?: boolean;
  heldMs?: number;
}

export interface QuestProgress {
  stage: number;
  progress: number;
  /** Free-form per-quest state (targets spawned, items delivered, ...) */
  data?: Record<string, number | string | boolean>;
}

export interface PlayerProfile {
  version: number;
  credits: number;
  /** Rebuild loan still owed (repaid from a share of credits earned); absent when clear */
  debt?: number;
  /** Where their last ship went down outside safe space, kept for them until `until` (wall ms) */
  wreck?: { system: string; x: number; y: number; until: number };
  xp: number;
  level: number;
  skillPoints: number;
  skills: Record<string, number>;
  cargo: Stack[];
  storage: Stack[];
  /** The ship you fly: always the same object as hangar[activeSlot] */
  ship: ShipRecord;
  /** Hangar slots (null = empty); the active one is the ship you fly */
  hangar: (ShipRecord | null)[];
  /** Designs saved for later (not ships: blueprints to load into a hangar slot), up to the pilot's design slots */
  designs?: (Blueprint | null)[];
  /** Things to fabricate once their materials are in: refining what's short as ore comes in (server/src/game/Hangar.ts) */
  fabOrders?: FabOrder[];
  activeSlot: number;
  /** (v1) unused */
  roster: ShipRecord[];
  /** Quick bar (keys 1-5): item ids, or null */
  quickbar: (string | null)[];
  /** Ship plans known (blueprint file names) */
  plans: string[];
  /** Fabricator recipes learned (beyond the starter ones) */
  recipes: string[];
  jobs: CraftJob[];
  /** Jobs: in progress, done, heard about (leads), and what's been said (dialogue flags) */
  /** rumours: hidden jobs heard of (a hint only); rumourDay: the day each station last gave one */
  quests: { active: Record<string, QuestProgress>; done: string[]; known: string[]; flags: string[]; fresh?: string[]; rumours?: string[]; rumourDay?: Record<string, number> };
  reputation: Record<string, number>;
  /** Jump gate licences (gate ids or system ids) */
  licences: string[];
  position: { system: string; x: number; y: number };
  /** Respawn station (the last station docked at) */
  home: string;
  stats: Record<string, number>;
  /** Rare traces owed by ore mined and not yet refined (econ/traces.ts); absent when none */
  traces?: TraceLedger;
  /** Your station (econ/outpost.ts), once chartered */
  outpost?: Outpost;
  /**
   * Ammunition (server/src/game/Ammo.ts): rounds left in each opened crate.
   * (`load` and `prefer` are from before loadouts were the ship's: what was
   * carried when last leaving a station, and which crate opens first. They
   * move to the active ship's loadout on load, so they stay empty.)
   */
  ammo?: { open: Record<string, number>; load: Record<string, number>; prefer?: Record<string, string> };
  /** Records found (data/codex.json ids, in the order found), and those not opened yet */
  codex: { found: string[]; fresh: string[] };
  /** One-time messages for the next login (Pilots.login shows them, then clears them); absent when none */
  notices?: ProfileNotice[];
  /** The repair bank (econ/field/bank.ts; docs/design/field-fabrication.md): absent until the server first fills it */
  bank?: RepairBank;
  createdAt: string;
  updatedAt: string;
}

/** A one-time message: its text, and the items it lists (shown by name) */
export interface ProfileNotice { text: string; items?: Bag }

export interface StarterKit {
  blueprint: Blueprint;
  planFile: string;
  credits: number;
  storage: Bag;
  home: string;
  position: { system: string; x: number; y: number };
}

/** What a brand-new pilot starts with, around the starter ship (GameServer, and the db scripts, so they never drift apart) */
export function starterKit(blueprint: Blueprint): StarterKit {
  return {
    blueprint,
    planFile: 'sparrow-t',
    credits: 300,
    storage: {
      iron_ore: 40, nickel_ore: 20, silicate: 20, copper_ore: 10,
      alloy_plate: 14, copper_wire: 6, pack_hull: 2, boost_cell: 2,
    },
    home: 'sol_station_central',
    // (Inside the star, so never "where they left off": a new pilot appears at their home station, Pilots.homePoint)
    position: { system: 'sol', x: 0, y: 0 },
  };
}

export function newProfile(kit: StarterKit, now = new Date().toISOString()): PlayerProfile {
  const p: PlayerProfile = {
    version: PROFILE_VERSION,
    credits: kit.credits,
    xp: 0,
    level: 1,
    skillPoints: 0,
    skills: {},
    cargo: [],
    storage: Object.entries(kit.storage).map(([id, n]) => ({ id, n })),
    ship: { blueprint: JSON.parse(JSON.stringify(kit.blueprint)), hp: {}, ghosts: [], plan: kit.planFile },
    hangar: [],
    activeSlot: 0,
    roster: [],
    quickbar: ['boost_cell', 'scanner_charge', null, null, null],
    plans: [kit.planFile],
    recipes: [],
    jobs: [],
    quests: { active: {}, done: [], known: [], flags: [] },
    reputation: {},
    licences: [],
    position: { ...kit.position },
    home: kit.home,
    stats: {},
    codex: { found: [], fresh: [] },
    createdAt: now,
    updatedAt: now,
  };
  p.hangar = [p.ship, ...Array.from({ length: unlocks(p).hangarSlots - 1 }, () => null)];
  return p;
}

/** Keep `ship` and the active hangar slot the same record */
export function setActiveShip(p: PlayerProfile, rec: ShipRecord, slot = p.activeSlot): void {
  p.activeSlot = slot;
  p.hangar[slot] = rec;
  p.ship = rec;
}

const validRecord = (s: unknown): s is ShipRecord =>
  !!s && typeof s === 'object' && !!(s as ShipRecord).blueprint && Array.isArray((s as ShipRecord).blueprint.parts);

function cleanRecord(s: ShipRecord): ShipRecord {
  return {
    blueprint: s.blueprint,
    hp: s.hp && typeof s.hp === 'object' ? s.hp : {},
    ghosts: Array.isArray(s.ghosts) ? s.ghosts.filter((u) => typeof u === 'number') : [],
    plan: typeof s.plan === 'string' ? s.plan : undefined,
    ...(s.lost ? { lost: true } : {}),
    ...(s.auto ? { auto: true } : {}),
    ...(s.paused ? { paused: true } : {}),
    ...(Number.isFinite(s.rank) ? { rank: s.rank } : {}),
    ...(s.loaner ? { loaner: true } : {}),
    ...(Array.isArray(s.owed) && s.owed.some(Number.isInteger) ? { owed: s.owed.filter((u) => Number.isInteger(u)) } : {}),
    ...cleanLoadout(s.ammo),
    ...cleanFieldRecord(s.field),
  };
}

function cleanJob(j: CraftJob): CraftJob {
  // v1 jobs were one run each
  const count = Number.isFinite(j.count) && j.count > 0 ? j.count : 1;
  const unitMs = Number.isFinite(j.unitMs) && j.unitMs > 0 ? j.unitMs : Math.max(1, (j.readyAt - j.startedAt) / count);
  return { ...j, count, done: Number.isFinite(j.done) ? j.done : 0, unitMs };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const rec = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {});

/** A ship record with its legacy parts as models (ships/migrate.ts): new parts take their old part's HP and ghost place; models with no room go to `refund` */
export function migrateShipRecord(catalog: Catalog, rec: ShipRecord, refund: Bag): ShipRecord {
  const m = migrateBlueprint(catalog, rec.blueprint);
  if (!m.changed) return rec;
  const hp = { ...rec.hp };
  let ghosts = [...(rec.ghosts ?? [])];
  for (const { uid, from } of m.added) {
    if (rec.hp[from] !== undefined) hp[uid] = rec.hp[from];
    const at = ghosts.indexOf(from);
    if (at >= 0) ghosts = [...ghosts.slice(0, at + 1), uid, ...ghosts.slice(at + 1)];
  }
  // (An unbuilt part's model was never had: nothing back for it)
  const ghost = new Set(rec.ghosts ?? []);
  for (const { uid, item } of m.refund) if (!ghost.has(uid)) refund[item] = (refund[item] ?? 0) + 1;
  return { ...rec, blueprint: m.blueprint, hp, ghosts };
}

const mapStacks = (catalog: Catalog, list: Stack[], usable: (m: FunctionDef) => boolean): Stack[] => {
  const out: Stack[] = [];
  for (const s of list) for (const [id, n] of Object.entries(migrateItemBag(catalog, { [s.id]: s.n }, usable))) addTo(out, id, n);
  return out;
};

/**
 * (v4) Modules are models now (docs/parts-redesign.md §7): every ship,
 * design, part item and fabricator job's output with its legacy parts as
 * their models; models that found no room on a ship go to storage. A built
 * part keeps its model; loose items (hold, storage, jobs' outputs) become
 * only models the pilot can fit, smaller copies if need be (ships/migrate.ts
 * migrateItemStack). Licences are kept (a legacy fn: licence still teaches
 * its family). Ships stay unwired: they're auto-wired whenever they're built
 * (ships/wires.ts).
 */
export function migrateProfileParts(p: PlayerProfile, catalog: Catalog): void {
  const refund: Bag = {};
  p.hangar = p.hangar.map((rec) => (rec ? migrateShipRecord(catalog, rec, refund) : null));
  setActiveShip(p, p.hangar[p.activeSlot] ?? migrateShipRecord(catalog, p.ship, refund), p.activeSlot);
  if (p.designs) p.designs = p.designs.map((b) => (b ? migrateBlueprint(catalog, b).blueprint : null));
  const usable = (m: FunctionDef) => modelLicensed(m, p.recipes, p.level);
  p.cargo = mapStacks(catalog, p.cargo, usable);
  p.storage = mapStacks(catalog, p.storage, usable);
  p.jobs = p.jobs.map((j) => ({ ...j, recipe: migratePartItem(catalog, j.recipe), out: migrateItemBag(catalog, j.out, usable) }));
  if (p.fabOrders) p.fabOrders = p.fabOrders.map((o) => ({ ...o, item: migratePartItem(catalog, o.item) }));
  p.quickbar = p.quickbar.map((id) => (id ? migratePartItem(catalog, id) : id));
  for (const [id, n] of Object.entries(refund)) addTo(p.storage, id, n);
}

/** What migrateProfile can be given beyond the kit */
export interface MigrateOptions {
  /** The economy (item and recipe books): the v5 design update needs it to break ships down. Without it a save older than v5 keeps its ships (and its version, to be upgraded later) */
  econ?: Economy;
  /** The design update mapping (data/ships/designUpdate.json, resolved): without it every ship of a save below v5 is broken down (the ship wipe) */
  designUpdate?: DesignUpdate;
  /** The account name the mapping is keyed by (none: not in the mapping, so wiped) */
  username?: string;
  /** Ship tuning (which crates each gun takes): keeps a swapped ship's ammo loadout where its new guns take it */
  tuning?: ShipTuning;
  /** Told what the design update did, when it runs */
  onDesignUpdate?: (r: DesignUpdateReport) => void;
  /** The wall clock (ms) the v6 field update starts the repair bank at (default: now) */
  now?: number;
}

/**
 * Bring any saved profile up to the current version, filling anything missing
 * from a fresh profile. Unknown or broken fields fall back to defaults rather
 * than failing the login. Without the ship catalogue (`catalog`) a save older
 * than v4 keeps its parts as they are (and its version, to be upgraded later);
 * without the economy (`opts.econ`) a save older than v5 keeps its ships.
 * Below v5 the design update runs: given the mapping (`opts.designUpdate`)
 * and the account's `opts.username`, mapped ships are swapped for their
 * remakes; the rest (every ship of an account not mapped) are broken down.
 */
export function migrateProfile(raw: unknown, kit: StarterKit, catalog?: Catalog, opts: MigrateOptions = {}): PlayerProfile {
  const base = newProfile(kit);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const was = num(r.version, 1);
  // (v1 is the first version: future migrations go here, e.g. if (r.version === 1) { ...; r.version = 2 })
  const ship = validRecord(r.ship) ? cleanRecord(r.ship) : undefined;
  const pos = rec<number | string>(r.position);
  const quests = rec<unknown>(r.quests);
  const out: PlayerProfile = {
    version: PROFILE_VERSION,
    credits: Math.max(0, Math.floor(num(r.credits, base.credits))),
    debt: Math.max(0, Math.floor(num(r.debt, 0))) || undefined,
    ...cleanWreck(r.wreck),
    xp: Math.max(0, num(r.xp, 0)),
    // Always the level its XP makes it (the curve changes; the XP stands)
    level: levelAt(Math.max(0, num(r.xp, 0))),
    skillPoints: Math.max(0, Math.floor(num(r.skillPoints, 0))),
    skills: rec<number>(r.skills),
    cargo: cleanStacks(Array.isArray(r.cargo) ? (r.cargo as Stack[]) : []),
    storage: cleanStacks(Array.isArray(r.storage) ? (r.storage as Stack[]) : base.storage),
    ship: ship ?? base.ship,
    hangar: [],
    activeSlot: 0,
    roster: [],
    quickbar: Array.isArray(r.quickbar) ? Array.from({ length: QUICKBAR_SLOTS }, (_, i) => (typeof (r.quickbar as unknown[])[i] === 'string' ? (r.quickbar as string[])[i] : null)) : base.quickbar,
    plans: strs(r.plans).length ? strs(r.plans) : base.plans,
    recipes: strs(r.recipes),
    jobs: Array.isArray(r.jobs) ? (r.jobs as CraftJob[]).filter((j) => j && typeof j.recipe === 'string').map(cleanJob) : [],
    quests: { active: rec<QuestProgress>(quests.active), done: strs(quests.done), known: strs(quests.known), flags: strs(quests.flags), ...(strs(quests.fresh).length ? { fresh: strs(quests.fresh) } : {}), ...(strs(quests.rumours).length ? { rumours: strs(quests.rumours) } : {}), ...(Object.keys(rec<number>(quests.rumourDay)).length ? { rumourDay: rec<number>(quests.rumourDay) } : {}) },
    reputation: rec<number>(r.reputation),
    licences: strs(r.licences),
    position: typeof pos.system === 'string' ? { system: pos.system, x: num(pos.x, base.position.x), y: num(pos.y, base.position.y) } : base.position,
    home: typeof r.home === 'string' ? r.home : base.home,
    stats: rec<number>(r.stats),
    ...cleanTraces(r.traces),
    ...cleanAmmo(r.ammo),
    ...cleanOutpost(r.outpost),
    codex: cleanCodex(r.codex),
    ...cleanNotices(r.notices),
    ...((b) => (b ? { bank: b } : {}))(cleanBank(r.bank)),
    ...(Array.isArray(r.fabOrders) ? { fabOrders: (r.fabOrders as FabOrder[]).filter((o) => o && typeof o.item === 'string' && typeof o.n === 'number').map((o) => ({ id: num(o.id, 0), item: o.item, n: Math.floor(o.n), made: Math.floor(num(o.made, 0)) })) } : {}),
    ...(Array.isArray(r.designs) ? { designs: (r.designs as unknown[]).map((b) => (b && typeof b === 'object' && Array.isArray((b as Blueprint).parts) && typeof (b as Blueprint).name === 'string' ? (b as Blueprint) : null)) } : {}),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : base.createdAt,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : base.updatedAt,
  };
  // Hangar slots (v2): v1 saves had only the one ship; the extra slots start empty (as many as the pilot's level gives)
  const slots = Array.isArray(r.hangar) ? (r.hangar as unknown[]).map((s) => (validRecord(s) ? cleanRecord(s) : null)) : [];
  while (slots.length < unlocks(out).hangarSlots) slots.push(null);
  const active = Math.max(0, Math.min(slots.length - 1, Math.floor(num(r.activeSlot, 0))));
  out.hangar = slots;
  setActiveShip(out, out.ship, active);
  // (The ships as saved, before anything below changes them: the design update checks them against its `was`)
  const saved = was < 5 ? { slots: out.hangar.map((s) => fingerprint(s?.blueprint)), designs: (out.designs ?? []).map((b) => fingerprint(b)) } : null;
  // Loadouts (v3): the crates last carried out, and the first picks, become the ship's own loadout
  if (out.ammo && (Object.keys(out.ammo.load).length || out.ammo.prefer)) {
    if (!out.ship.ammo) out.ship.ammo = { load: { ...out.ammo.load }, ...(out.ammo.prefer ? { first: { ...out.ammo.prefer } } : {}) };
    out.ammo = { open: out.ammo.open, load: {} };
  }
  // The schematics are retired: held ones go (a legendary one as its artefact), and the licences they taught (econ/retired.ts)
  retireSchematics(out);
  // Models (v4)
  if (was < 4) {
    if (!catalog) { out.version = Math.min(was, 3); return out; }
    migrateProfileParts(out, catalog);
  }
  // The design update (v5): ships swapped for their remakes on the ports core, or broken down (econ/designUpdate.ts)
  if (was < 5) {
    if (!opts.econ) { out.version = 4; return out; }
    const account = opts.username !== undefined ? opts.designUpdate?.accounts[opts.username] : undefined;
    const r = designUpdateShips(out, { econ: opts.econ, kit, account, blueprints: opts.designUpdate?.blueprints, was: saved!, tuning: opts.tuning });
    opts.onDesignUpdate?.(r);
  }
  // The field update (v6): kits and bonds become bank deposits, loaners go (econ/fieldUpdate.ts)
  if (was < 6) {
    if (!opts.econ) { out.version = 5; return out; }
    fieldUpdate(out, opts.econ, kit, opts.now);
  }
  // Gun shape rules (ships/gunFacing.ts): a gun's barrel follows its turn, so a ship or design saved with a gun facing
  // another way has the gun turned to keep its barrel where it was. Safe on every load (a gun already right is left alone)
  if (catalog) migrateProfileGunFacings(out, catalog);
  return out;
}

/** Every ship and design of a profile with its guns' barrels following their turn (ships/gunFacing.ts) */
export function migrateProfileGunFacings(p: PlayerProfile, catalog: Catalog): void {
  const record = (rec: ShipRecord): ShipRecord => {
    const m = migrateGunFacings(catalog, rec.blueprint);
    return m.changed ? { ...rec, blueprint: m.blueprint } : rec;
  };
  p.hangar = p.hangar.map((rec) => (rec ? record(rec) : null));
  setActiveShip(p, p.hangar[p.activeSlot] ?? record(p.ship), p.activeSlot);
  if (p.designs) p.designs = p.designs.map((b) => (b ? migrateGunFacings(catalog, b).blueprint : null));
}
