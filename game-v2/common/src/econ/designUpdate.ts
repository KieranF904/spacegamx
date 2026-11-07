/**
 * The design update (PROFILE_VERSION 5, Kieran 2026-11): ships move to the
 * ports power core. Each pilot's saved ships are swapped for remakes made on
 * the new core (data/ships/designUpdate.json says which, per username, per
 * hangar slot and saved design); what isn't mapped is broken down into
 * storage instead (the ship wipe). Only ships change: XP, level, credits,
 * storage, skills, quests, plans, recipes, licences and the rest stay.
 *
 * migrateProfile (profile.ts) runs this once, on any save below v5: the game
 * at login (server/src/game/Pilots.ts) and the bulk tool at the deploy
 * (scripts/db/designUpdate.ts) give it the same mapping, so a pilot the bulk
 * run misses is swapped at their next login, never wiped.
 */

import type { Blueprint } from '../ships/types.js';
import type { ShipTuning } from '../ships/tuning.js';
import type { Economy } from './economy.js';
import type { PlayerProfile, ShipRecord, StarterKit } from './profile.js';
import type { ShipLoadout } from './loadout.js';
import { loadoutKinds } from './loadout.js';
import { cratesFor } from '../ships/launch.js';
import { partItemId } from './items.js';
import { salvageParts } from './salvage.js';
import { addTo, type Bag } from './stacks.js';
import { unlocks } from './unlocks.js';

/** One saved ship's swap: the blueprint id to put in its place, and the save it was made from */
export interface DesignSwap {
  /** An id under data/ships/blueprints: "remakes/<file>" for a hand-made remake, a bare id for a library ship */
  blueprint: string;
  /** A stock library ship (the current one replaces the old) */
  stock?: boolean;
  /** The save it was made from: a save that no longer matches has changed since, and is wiped instead */
  was: { name: string; parts: number };
}

/** One account's entry: "wipe" (ships broken down, a fresh starter), or swaps by hangar slot and design index (0-based) */
export type DesignUpdateAccount = 'wipe' | { slots?: Record<string, DesignSwap>; designs?: Record<string, DesignSwap> };

/** data/ships/designUpdate.json as written */
export interface DesignUpdateFile { about?: string; accounts: Record<string, DesignUpdateAccount> }

/** The mapping with its blueprints resolved (what migrateProfile is given) */
export interface DesignUpdate {
  accounts: Record<string, DesignUpdateAccount>;
  /** Every blueprint id the mapping names that was found */
  blueprints: Record<string, Blueprint>;
}

/** The mapping's blueprints looked up (`find`: an id to its blueprint, or undefined); ids not found are listed in `missing` */
export function resolveDesignUpdate(file: DesignUpdateFile, find: (id: string) => Blueprint | undefined): DesignUpdate & { missing: string[] } {
  const blueprints: Record<string, Blueprint> = {};
  const missing: string[] = [];
  for (const acc of Object.values(file.accounts ?? {})) {
    if (acc === 'wipe' || !acc) continue;
    for (const s of [...Object.values(acc.slots ?? {}), ...Object.values(acc.designs ?? {})]) {
      if (s.blueprint in blueprints || missing.includes(s.blueprint)) continue;
      const bp = find(s.blueprint);
      if (bp) blueprints[s.blueprint] = bp; else missing.push(s.blueprint);
    }
  }
  return { accounts: file.accounts ?? {}, blueprints, missing };
}

/** What a saved ship was before any migration touched it (the `was` check) */
export interface SaveFingerprint { name: string; parts: number }

export const fingerprint = (bp: Blueprint | null | undefined): SaveFingerprint | null =>
  bp && Array.isArray(bp.parts) ? { name: String(bp.name ?? ''), parts: bp.parts.length } : null;

/** Why a ship was broken down rather than swapped */
export type WipeReason = 'account wiped' | 'not mapped' | 'changed since' | 'remake missing' | 'loaner';

export interface SwappedShip {
  /** Hangar slot (0-based) or design index */
  slot?: number;
  design?: number;
  from: SaveFingerprint;
  /** The blueprint id swapped in, and the name it has now */
  to: string;
  name: string;
  /** Wasn't whole (lost, or still being built): it's on order on the new layout, what was built refunded */
  onOrder?: boolean;
}

export interface WipedShip {
  slot?: number;
  design?: number;
  /** v1 roster record */
  roster?: boolean;
  from: SaveFingerprint;
  why: WipeReason;
}

/** What the design update did to one profile (scripts/db/designUpdate.ts reports it; the pilot gets a notice) */
export interface DesignUpdateReport {
  /** "swap": the account's mapping was used; "wipe": the account is to be wiped, or isn't in the mapping */
  mode: 'swap' | 'wipe';
  swapped: SwappedShip[];
  wiped: WipedShip[];
  /** Ship records gone: hangar slots (the active ship among them, loaners too) and roster */
  slotsDeleted: number;
  designsDeleted: number;
  /** What went to storage: built parts of wiped ships (and of swapped ones that weren't whole) as materials, gems as they are */
  refund: Bag;
  /** The hold, moved to storage */
  cargoMoved: Bag;
  /** Fabricator jobs that were for a ship: kept, their output going to storage */
  jobsDetached: number;
  debtForgiven: number;
  /** Leftover plan:* items (plans are no longer items), from the hold, storage and the quick bar */
  planItemsDropped: Bag;
  /** No ship left: a fresh starter in slot 1 */
  freshStarter: boolean;
  /** The slot flown afterwards (0-based) */
  activeSlot: number;
}

/** What the v5 step is given beyond the profile */
export interface DesignUpdateInput {
  econ: Economy;
  kit: StarterKit;
  /** The account's entry (undefined: not in the mapping, so wiped) and the mapping's blueprints */
  account?: DesignUpdateAccount;
  blueprints?: Record<string, Blueprint>;
  /** The hangar slots and designs as saved, before any migration (by index) */
  was: { slots: (SaveFingerprint | null)[]; designs: (SaveFingerprint | null)[] };
  /** Ship tuning (which crates each gun takes): without it a swapped ship's loadout is reset */
  tuning?: ShipTuning;
}

const addBag = (bag: Bag, id: string, n: number) => { if (n > 0) bag[id] = (bag[id] ?? 0) + n; };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const sameSave = (a: SaveFingerprint | null | undefined, b: SaveFingerprint) => !!a && a.name === b.name && a.parts === b.parts;

/** A record's built parts (not ghosts, not at 0 HP) as materials in full, plus its socketed gems; an old save's loaner gives nothing */
function breakDown(econ: Economy, rec: ShipRecord, refund: Bag, stock: Bag | null): void {
  if (rec.loaner) return;
  const ghosts = new Set(rec.ghosts ?? []);
  const hp = (uid: number) => rec.hp?.[uid];
  let built = rec.blueprint.parts.filter((q) => !ghosts.has(q.uid));
  if (stock) {
    // (A stock part taken out of a damaged one first: what's left is what was added)
    built = [...built].sort((a, b) => (hp(a.uid) === 0 ? 0 : 1) - (hp(b.uid) === 0 ? 0 : 1)).filter((q) => {
      const id = partItemId(q);
      if ((stock[id] ?? 0) <= 0) return true;
      stock[id]--;
      return false;
    });
  }
  for (const [id, n] of Object.entries(salvageParts(econ, built.filter((q) => hp(q.uid) !== 0), 1))) addBag(refund, id, n);
  // (A gem is lost with its part: none back from one at 0 HP)
  for (const q of rec.blueprint.parts) if (hp(q.uid) !== 0) for (const g of q.gems ?? []) addBag(refund, g, 1);
}

/** A loadout trimmed to the crates the new design's guns take (and first picks for gun kinds it has); undefined if nothing's left */
function keepLoadout(tuning: ShipTuning | undefined, econ: Economy, bp: Blueprint, saved: ShipLoadout | undefined): ShipLoadout | undefined {
  if (!saved || !tuning) return undefined;
  const kinds = loadoutKinds(econ.ships, tuning, bp);
  const crates = new Set(kinds.flatMap((k) => cratesFor(tuning, k)));
  const load = Object.fromEntries(Object.entries(saved.load).filter(([c]) => crates.has(c)));
  const first = Object.fromEntries(Object.entries(saved.first ?? {}).filter(([k, c]) => kinds.includes(k) && crates.has(c)));
  if (!Object.keys(load).length && !Object.keys(first).length) return undefined;
  return { load, ...(Object.keys(first).length ? { first } : {}) };
}

/**
 * The remake in a record's place, whole (Kieran 2026-11-07: a lost or unfinished ship is given back built too;
 * the on-order path is kept for `wholeOnly: false`)
 */
function swapRecord(input: DesignUpdateInput, rec: ShipRecord, swap: DesignSwap, bp: Blueprint, refund: Bag, wholeOnly = true): { rec: ShipRecord; onOrder: boolean } {
  const blueprint = clone(bp);
  const whole = wholeOnly || (!rec.lost && !(rec.ghosts ?? []).length);
  const plan = swap.stock ? swap.blueprint : rec.plan;
  const ammo = keepLoadout(input.tuning ?? input.econ.tuning, input.econ, blueprint, rec.ammo);
  const base: ShipRecord = { blueprint, hp: {}, ghosts: [], ...(plan ? { plan } : {}), ...(Number.isFinite(rec.rank) ? { rank: rec.rank } : {}), ...(ammo ? { ammo } : {}) };
  if (whole) return { rec: base, onOrder: false };
  breakDown(input.econ, rec, refund, null);
  const core = blueprint.parts.find((q) => q.fn === 'core');
  base.ghosts = [...(core ? [core.uid] : []), ...blueprint.parts.filter((q) => q !== core).map((q) => q.uid)];
  return { rec: { ...base, auto: true, ...(rec.lost ? { lost: true } : {}), ...(rec.paused ? { paused: true } : {}) }, onOrder: true };
}

const flyable = (r: ShipRecord | null | undefined): r is ShipRecord => {
  if (!r || r.lost || r.loaner) return false;
  const core = r.blueprint.parts.find((q) => q.fn === 'core');
  return !!core && !(r.ghosts ?? []).includes(core.uid);
};

/**
 * (v5) The design update on one profile (migrateProfile has already brought
 * the rest up to date). Per hangar slot and saved design: if the account's
 * mapping names it and the save still matches its `was`, the remake goes in
 * its place (the remake's name, full HP; a lost or unfinished ship comes back
 * on order on the new layout, what had been built refunded; its ammo loadout
 * kept where the new guns take it; its plan kept, or the library ship's for a
 * stock swap). Anything else is broken down into storage, in full (built
 * parts at salvageParts 1, socketed gems as themselves; nothing for a loaner,
 * a ghost part or a part at 0 HP). A pilot left with no ship gets a fresh
 * starter in slot 1 (and then a stock Sparrow T gives back only the parts it
 * had beyond the starter's); one left with only unfinished ships a loaner.
 * Everyone: docked at home, hold moved to storage, plan:* items dropped,
 * ship-bound fabricator jobs kept for storage, the wreck marker cleared, the
 * v1 roster emptied, and a one-time login notice. Rebuild debt is forgiven
 * only when every ship went. XP, level, credits, storage, skills, quests,
 * plans, recipes, licences, reputation and the codex are untouched.
 */
export function designUpdateShips(p: PlayerProfile, input: DesignUpdateInput): DesignUpdateReport {
  const { econ, kit } = input;
  const acc = input.account && input.account !== 'wipe' ? input.account : undefined;
  const report: DesignUpdateReport = {
    mode: acc ? 'swap' : 'wipe', swapped: [], wiped: [], slotsDeleted: 0, designsDeleted: 0, refund: {}, cargoMoved: {},
    jobsDetached: 0, debtForgiven: 0, planItemsDropped: {}, freshStarter: false, activeSlot: 0,
  };
  const refund = report.refund;
  const noRemake: WipeReason = input.account === 'wipe' ? 'account wiped' : 'not mapped';

  // Hangar slots: swapped, or to be broken down (after: the stock rule depends on whether any ship is left)
  const toBreak: ShipRecord[] = [];
  const hangar: (ShipRecord | null)[] = p.hangar.map((rec, slot) => {
    if (!rec) return null;
    const from = input.was.slots[slot] ?? fingerprint(rec.blueprint)!;
    const swap = acc?.slots?.[String(slot)];
    const bp = swap ? input.blueprints?.[swap.blueprint] : undefined;
    const why: WipeReason | null = rec.loaner ? 'loaner' : !swap ? noRemake : !sameSave(input.was.slots[slot], swap.was) ? 'changed since' : !bp ? 'remake missing' : null;
    if (why || !swap || !bp) {
      report.wiped.push({ slot, from, why: why ?? 'remake missing' });
      toBreak.push(rec);
      return null;
    }
    const s = swapRecord(input, rec, swap, bp, refund);
    report.swapped.push({ slot, from, to: swap.blueprint, name: s.rec.blueprint.name, ...(s.onOrder ? { onOrder: true } : {}) });
    return s.rec;
  });
  // (The v1 roster: unused, but anything in it is broken down too)
  const inHangar = new Set(p.hangar);
  for (const rec of p.roster) if (rec && !inHangar.has(rec)) { report.wiped.push({ roster: true, from: fingerprint(rec.blueprint)!, why: noRemake }); toBreak.push(rec); }
  report.slotsDeleted = toBreak.length;
  const left = hangar.some(Boolean);
  // The free starter: its stock parts (once, for the first Sparrow T not lost), only when a fresh one replaces it
  let stock: Bag | null = null;
  if (!left) { stock = {}; for (const q of kit.blueprint.parts) addBag(stock, partItemId(q), 1); }
  for (const rec of toBreak) {
    const free = stock && !rec.loaner && !rec.lost && rec.plan === kit.planFile;
    breakDown(econ, rec, refund, free ? stock : null);
    if (free) stock = null;
  }

  // Designs: swapped in place, or gone
  const designs = (p.designs ?? []).map((bp, i) => {
    if (!bp) return null;
    const from = input.was.designs[i] ?? fingerprint(bp)!;
    const swap = acc?.designs?.[String(i)];
    const remake = swap ? input.blueprints?.[swap.blueprint] : undefined;
    const why: WipeReason | null = !swap ? noRemake : !sameSave(input.was.designs[i], swap.was) ? 'changed since' : !remake ? 'remake missing' : null;
    if (why || !swap || !remake) { report.wiped.push({ design: i, from, why: why ?? 'remake missing' }); report.designsDeleted++; return null; }
    report.swapped.push({ design: i, from, to: swap.blueprint, name: remake.name });
    return clone(remake);
  });
  if (designs.some(Boolean)) p.designs = designs; else delete p.designs;

  // Plans aren't items any more: what's left of them goes
  const isPlan = (id: string) => id.startsWith('plan:');
  for (const list of [p.cargo, p.storage]) for (const s of list) if (isPlan(s.id)) addBag(report.planItemsDropped, s.id, s.n);
  p.cargo = p.cargo.filter((s) => !isPlan(s.id));
  p.storage = p.storage.filter((s) => !isPlan(s.id));
  p.quickbar = p.quickbar.map((id) => (id && isPlan(id) ? null : id));
  // The hold to storage, and the refund
  for (const s of p.cargo) { addBag(report.cargoMoved, s.id, s.n); addTo(p.storage, s.id, s.n); }
  p.cargo = [];
  for (const [id, n] of Object.entries(refund)) addTo(p.storage, id, n);
  // Jobs keep running, for storage
  p.jobs = p.jobs.map((j) => {
    if (j.for === undefined && j.slot === undefined) return j;
    report.jobsDetached++;
    const { for: _for, slot: _slot, ...rest } = j;
    return rest;
  });
  delete p.wreck;
  p.roster = [];

  // What's flown
  const starter = (): ShipRecord => ({ blueprint: clone(kit.blueprint), hp: {}, ghosts: [], plan: kit.planFile });
  if (!left) {
    report.freshStarter = true;
    report.debtForgiven = p.debt ?? 0;
    delete p.debt;
    p.hangar = Array.from({ length: Math.max(1, unlocks(p).hangarSlots) }, () => null);
    p.hangar[0] = starter();
    p.activeSlot = 0;
  } else {
    while (hangar.length < unlocks(p).hangarSlots) hangar.push(null);
    p.hangar = hangar;
    let slot = flyable(hangar[p.activeSlot]) ? p.activeSlot : hangar.findIndex(flyable);
    if (slot < 0) {
      // (Every ship left is still being built: the first is flown as it is, its unbuilt parts owed to the repair bank, as
      // when a ship is lost; no loaner any more, v6)
      slot = hangar.findIndex(Boolean);
      const r = hangar[slot]!;
      const core = r.blueprint.parts.find((q) => q.fn === 'core');
      delete r.lost; delete r.auto; delete r.paused; delete r.rank;
      r.ghosts = (r.ghosts ?? []).filter((u) => u !== core?.uid);
      r.owed = [...r.ghosts];
      r.hp = {};
    }
    p.activeSlot = slot;
  }
  p.ship = p.hangar[p.activeSlot]!;
  report.activeSlot = p.activeSlot;
  // Home: the starter kit's position is inside the star, so they appear at their home station (Pilots.homePoint)
  p.position = { ...kit.position };
  (p.notices ??= []).push(designUpdateNotice(report, kit));
  return report;
}

const listed = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The one-time login message: what was rebuilt, what was broken down (and only then the refund), where they are */
export function designUpdateNotice(r: DesignUpdateReport, kit: StarterKit): { text: string; items?: Bag } {
  const parts: string[] = [];
  const ships = r.swapped.filter((s) => s.slot !== undefined);
  const designs = r.swapped.filter((s) => s.design !== undefined);
  if (ships.length) {
    parts.push(`Your ships have been rebuilt for the new power system: ${listed(ships.map((s) => `your ${s.from.name} in slot ${s.slot! + 1} is now the ${s.name}${s.onOrder ? " (still being built: you can fly it once it's whole)" : ''}`))}.`);
  }
  if (designs.length) parts.push(`Your saved design${designs.length > 1 ? 's were' : ' was'} remade too: ${listed(designs.map((s) => `${s.from.name} is now ${s.name}`))}.`);
  const gone = r.wiped.filter((w) => w.why !== 'loaner' && w.design === undefined);
  if (r.freshStarter) parts.push(`Ships now run on the new power system, so your hangar has been reset: you have a fresh ${kit.blueprint.name} in slot 1.`);
  else if (gone.length) parts.push(`${listed(gone.map((w) => `the ${w.from.name}`)).replace(/^t/, 'T')} could not be rebuilt, so ${gone.length > 1 ? 'they were' : 'it was'} broken down into storage.`);
  const lostDesigns = r.wiped.filter((w) => w.design !== undefined);
  if (lostDesigns.length) parts.push(`Your saved design${lostDesigns.length > 1 ? 's' : ''} ${listed(lostDesigns.map((w) => w.from.name))} could not be remade and ${lostDesigns.length > 1 ? 'were' : 'was'} removed.`);
  parts.push("You're docked at home.");
  if (r.debtForgiven) parts.push(`Your rebuild loan (${r.debtForgiven} credits) is forgiven.`);
  if (Object.keys(r.cargoMoved).length) parts.push('Your hold was moved to storage.');
  const refunded = Object.keys(r.refund).length > 0;
  if (r.freshStarter) parts.push(refunded ? 'Your old ships were broken down into storage' : "Your old ships had nothing to break down beyond the starter's parts");
  else if (refunded) parts.push('Added to your storage');
  return { text: parts.join(' '), ...(refunded ? { items: { ...r.refund } } : {}) };
}
