/**
 * @contract client.ships.plan-cost
 * owns:       what a build plan needs against what is in the hold (and what packs cover), the shortfall, and a build-time estimate; the same for a hangar slot against storage
 * needs:      @space-game/common (econ field rules, packs, recipes)
 * invariants: needs, shortfalls and times come from the server's own rules (fieldBuildInputs, fabWork, attachWork, jobTicks) — client/src/ships/build/planCost.test.ts
 *             parts the fabricator tier can't make add no time and are counted apart — client/src/ships/build/planCost.test.ts
 * extend:     a new stall reason is one more branch in stallNotes
 */
import { FIELD_TPS, attachWork, canFabricate, fabWork, fieldBuildInputs, fieldPay, isStructural, jobTicks, packDefs, partItemId, tierRule } from '@space-game/common';
import type { Bag, Economy, MachineView, PackMode, PlacedPart } from '@space-game/common';

/** One material the plan takes: how many, and how many the hold has */
export interface CostLine { id: string; need: number; have: number }

export interface CostReadout {
  /** Everything the plan takes, most needed first */
  lines: CostLine[];
  /** What the hold (with packs, if allowed) can't pay */
  short: Bag;
  /** Parts counted, and those of them already finished in the hold (only attaching) */
  parts: number;
  fromHold: number;
  /** Parts this fabricator can't make (no time counted for them) */
  unmakeable: number;
  /** Estimated seconds of work at the machine's pace, if everything needed were there */
  seconds: number;
  /** Stalls to mention: cargo full, no power, off */
  notes: string[];
}

export interface FieldCostOpts {
  /** The fabricator's tier (0: the core's own) */
  tier: number;
  /** What the hold has of an item */
  have(id: string): number;
  /** How packs may pay (default off) */
  mode?: PackMode;
}

export const emptyReadout = (): CostReadout => ({ lines: [], short: {}, parts: 0, fromHold: 0, unmakeable: 0, seconds: 0, notes: [] });

/**
 * The cost of building `missing` parts (planned or lost, not the disconnected ones: the caller leaves those out) in the
 * field. A non-structural part whose finished item is in the hold costs only attaching it; the rest cost their recipe
 * inputs, fabricating and attaching. Time is each job's ticks at the machine's tier speed, one after another
 */
export function planCost(econ: Economy, missing: readonly PlacedPart[], o: FieldCostOpts): CostReadout {
  const out = emptyReadout();
  const need: Bag = {};
  const held: Bag = {};
  const speed = tierRule('fabricator', o.tier).speed;
  let ticks = 0;
  for (const p of missing) {
    const spec = { fn: p.fn, material: p.material, piece: p.piece };
    const item = partItemId(p);
    out.parts++;
    if (!isStructural(p.fn) && o.have(item) > (held[item] ?? 0)) {
      held[item] = (held[item] ?? 0) + 1;
      out.fromHold++;
      ticks += jobTicks(attachWork(econ.ships, p), speed);
      continue;
    }
    if (!canFabricate(econ.ships, o.tier, spec)) { out.unmakeable++; continue; }
    for (const [id, n] of Object.entries(fieldBuildInputs(econ, spec))) need[id] = (need[id] ?? 0) + n;
    ticks += jobTicks(fabWork(econ, spec), speed) + jobTicks(attachWork(econ.ships, p), speed);
  }
  out.seconds = ticks / FIELD_TPS;
  const mode = o.mode ?? 'off';
  out.short = fieldPay(need, o.have, mode === 'off' ? [] : packDefs(econ.items), mode).short;
  out.lines = Object.keys(need).map((id) => ({ id, need: need[id], have: o.have(id) })).sort((a, b) => b.need - a.need || (a.id < b.id ? -1 : 1));
  return out;
}

/** Why the fabricator wouldn't run on, from its last state (none given: the core's own is assumed) */
export function stallNotes(m: Readonly<MachineView> | undefined, hasWork: boolean): string[] {
  if (!m || !hasWork) return [];
  if (!m.on) return ['fabricator is off'];
  const notes: string[] = [];
  if (m.blocked === 'cargo') notes.push('cargo is full');
  else if (m.blocked === 'grade') notes.push('needs a better fabricator');
  if (m.tier > 0 && m.job && !m.drawing && !m.blocked) notes.push('short of power');
  return notes;
}

/** A readout with the machine's stalls added */
export function withMachine(r: CostReadout, m: Readonly<MachineView> | undefined): CostReadout {
  return { ...r, notes: [...r.notes, ...stallNotes(m, r.parts > 0)] };
}

/** "under a minute", "about 4 min", "about 1 h 20 min" */
export function durationText(seconds: number): string {
  if (!(seconds > 0)) return 'no time';
  if (seconds < 45) return 'under a minute';
  const min = Math.round(seconds / 60);
  if (min < 60) return `about ${min} min`;
  const h = Math.floor(min / 60), r = min % 60;
  return r ? `about ${h} h ${r} min` : `about ${h} h`;
}

/** What a hangar slot's unbuilt design takes at the station: item lines against storage and the hold, and the work */
export interface StationReadout {
  lines: CostLine[];
  /** What neither storage nor the queue has and can't be refined from what is there: gather or buy it */
  short: Bag;
  seconds: number;
  /** Parts the pilot can't make yet */
  blocked: number;
}

/**
 * `need`: the unbuilt parts' bill (ghostBill: modules as items, structure as plate). Each item left after storage and what
 * is on its way is fabricated (its recipe's time each) or, if a material, refined (a batch's time). The materials a
 * module's recipe takes, less what storage holds, are refined in turn when they can be, else they are short. Station
 * times are summed, one job after another: a rough figure, since the hangar runs a refinery and a fabricator side by side
 */
export function stationCost(econ: Economy, need: Bag, have: (id: string) => number, coming: Bag, canMake: (id: string) => boolean): StationReadout {
  const out: StationReadout = { lines: [], short: {}, seconds: 0, blocked: 0 };
  const direct: Bag = {};
  const gross: Bag = {};
  for (const id of Object.keys(need)) {
    const n = need[id], stored = Math.min(n, have(id));
    out.lines.push({ id, need: n, have: have(id) });
    const left = n - stored - Math.min(coming[id] ?? 0, n - stored);
    if (left <= 0) continue;
    if (econ.recipes.refining.has(id)) { direct[id] = left; continue; }
    const r = econ.recipes.recipeFor(id);
    if (!r || !canMake(id)) { out.blocked++; continue; }
    out.seconds += (r.time ?? 0) * left;
    for (const [m, k] of Object.entries(r.inputs)) gross[m] = (gross[m] ?? 0) + k * left;
  }
  const mats: Bag = { ...direct };
  for (const m of Object.keys(gross)) {
    const k = Math.max(0, gross[m] - have(m));
    if (k > 0) mats[m] = (mats[m] ?? 0) + k;
  }
  for (const [m, n] of Object.entries(mats)) {
    const r = econ.recipes.refining.get(m);
    if (!r) { out.short[m] = n; continue; }
    out.seconds += Math.ceil(n / Math.max(1, r.out)) * (r.time ?? 2);
  }
  out.lines.sort((a, b) => b.need - a.need || (a.id < b.id ? -1 : 1));
  return out;
}
