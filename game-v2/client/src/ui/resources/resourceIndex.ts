/**
 * @contract client.ui.resource-index
 * owns:       the resource dictionary's entries: one per ore, gem, refined material, component, pack, ammo crate, cut gem and drop, each with how to get it and what it is used for, derived from the game data
 * needs:      common/ (FIELD only), sourceIndex + tiers, the data/*.json shapes in GameData below (no I/O, no DOM)
 * invariants: every ore, refined, component, pack and ammo item has an entry, and an entry with no known source is marked notObtainable — client/src/ui/resources/resourceIndex.test.ts
 *             a mined ore lists the systems whose belts hold a rock that drops it — client/src/ui/resources/resourceIndex.test.ts
 *             a refined item lists its recipe — client/src/ui/resources/resourceIndex.test.ts
 * extend:     a new way of getting an item is one function in SOURCES below; a hand-written line is one entry in data/guideHints.json
 */

import { FIELD } from '@space-game/common';
import { buildSourceIndex, isPublicSystem, rockSystemMap, type ItemColumns, type SourceIndex } from './sourceIndex';
import { TIER_LABEL, tierOf } from './tiers';

/** The categories the dictionary filters by (ship parts are generated and left out) */
export type ResourceCategory = 'ore' | 'refined' | 'component' | 'pack' | 'ammo' | 'gem' | 'drop';

export const CATEGORY_LABEL: Record<ResourceCategory, string> = {
  ore: 'Ore', refined: 'Refined', component: 'Components', pack: 'Packs', ammo: 'Ammo', gem: 'Cut gems', drop: 'Drops',
};
export const CATEGORY_ORDER: ResourceCategory[] = ['ore', 'refined', 'component', 'pack', 'ammo', 'gem', 'drop'];

export type SourceKind = 'mined' | 'seam' | 'trace' | 'refine' | 'fabricate' | 'cut' | 'drop' | 'bought' | 'quest' | 'salvage';
export const SOURCE_LABEL: Record<SourceKind, string> = {
  mined: 'Mined', seam: 'Gem seams', trace: 'Refining trace', refine: 'Refined', fabricate: 'Fabricated', cut: 'Cut',
  drop: 'Dropped', bought: 'Bought', quest: 'Job reward', salvage: 'Salvage',
};
const KIND_ORDER = Object.keys(SOURCE_LABEL) as SourceKind[];

export interface ResourceSource {
  kind: SourceKind;
  text: string;
  /** The places, one per line (systems with their danger, stations) */
  where?: string[];
}

export interface ResourceEntry {
  id: string;
  name: string;
  category: ResourceCategory;
  color: string;
  rarity: string;
  value: number;
  description: string;
  sources: ResourceSource[];
  usedFor: string[];
  hint?: string;
  /** The icon-chip columns (sourceIndex.ts) */
  cols: ItemColumns;
  /** No source in the data yet (shown as such, never silently empty) */
  notObtainable: boolean;
}

// --- The data this reads (the shapes of data/*.json, only the parts used)

type Bag = Record<string, number>;
interface ItemRow {
  id: string; name: string; category: string; rarity: string; value: number; color: string; description: string;
  pack?: Bag; trace?: boolean; quest?: string; socket?: { type: string; level: number }; ammoFor?: { weapon: string; rounds: number };
}
interface RockType { hardness: number; ores: Bag; name?: string; traceBoost?: Bag; gas?: boolean }
interface DropRow { item: string; chance: number; min: number; max: number }
interface Named { id: string; name: string }
export interface GameData {
  items: ItemRow[];
  recipes: {
    refining: { id: string; inputs: Bag; out: number; time?: number; level?: number }[];
    craft: { id: string; out: Bag; inputs: Bag; time: number; starter?: boolean; level?: number; quest?: string }[];
    parts: { plates: Record<string, string>; extras: Record<string, Bag> };
    models?: Record<string, { inputs: Bag }>;
  };
  mining: {
    types: Record<string, RockType>;
    fields: Record<string, Record<string, number>>;
    oreHardness: Record<string, number>;
    danger: Record<string, { seamChance: number; boost: Bag }>;
    seams: { gem: string; hardness: number; minTier: number; weight: number }[];
    traces: Record<string, { from: string[]; per100: number[]; megaOnly?: boolean }>;
  };
  systems: {
    id: string; name: string; danger: number; sector?: string; starColor?: string; asteroidField?: string; asteroidBelt?: { extra?: { field?: string }[] }; nests?: { faction?: string }[];
    private?: boolean; tutorial?: boolean; gunRange?: unknown; surface?: unknown; instance?: unknown;
  }[];
  stations: { id: string; name: string; system: string; market?: { sells?: string[] } }[];
  bosses: Record<string, { name: string; system: string; faction?: string; design?: string; loot?: DropRow[] }>;
  factions: Record<string, { name: string; color?: string; ships?: Record<string, unknown>; loot?: DropRow[] }>;
  quests: {
    reputations: Record<string, { name: string; vendor?: { stock?: { item: string; rank: number }[] } }>;
    quests: { id: string; name: string; giver?: string; person?: string; level?: number; rewards?: { items?: Bag; recipes?: string[] } }[];
  };
  people: { id: string; name: string }[];
  rules: { events?: { salvage?: { goods?: string[]; rare?: string[] } } };
  station: { tracks: Record<string, { name: string; tiers: { cost?: Bag }[] }> };
  gems: { cuts: Record<string, { inputs: Bag }>; types: Record<string, { name: string; material: string }> };
  materials: Named[];
  models: (Named & { family?: string })[];
  functions: Named[];
  /** data/guideHints.json */
  hints: Record<string, string>;
}

// --- Small helpers

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const secs = (t: number) => (t >= 120 ? `${Math.round(t / 60)} min` : `${t} s`);
/** "a, b, c and 4 more" */
function some(list: string[], max = 6): string {
  return list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
}

const CATEGORY_OF: Record<string, ResourceCategory | undefined> = {
  mineral: 'ore', gem: 'ore', volatile: 'ore', refined: 'refined', component: 'component', ammo: 'ammo', jewel: 'gem', artefact: 'drop', quest: 'drop',
};
function categoryOf(it: ItemRow): ResourceCategory | undefined {
  if (it.category === 'consumable') return it.pack ? 'pack' : 'component';
  return CATEGORY_OF[it.category];
}

/** The lookups every source function needs */
interface Ctx {
  d: GameData;
  name(id: string): string;
  bag(b: Bag): string;
  system(id: string): string;
  /** Systems (with danger) whose belts hold each rock type */
  rockSystems: Map<string, { id: string; name: string; danger: number }[]>;
}

function makeCtx(d: GameData): Ctx {
  const names = new Map(d.items.map((i) => [i.id, i.name]));
  const sys = new Map(d.systems.map((s) => [s.id, s]));
  const rockSystems = rockSystemMap(d);
  return {
    d,
    name: (id) => names.get(id) ?? cap(id),
    bag: (b) => Object.entries(b).map(([id, n]) => `${n} ${names.get(id) ?? cap(id)}`).join(' + '),
    system: (id) => sys.get(id)?.name ?? cap(id),
    rockSystems,
  };
}

// --- Ways to get an item: one function each, in the order they show

type SourceFn = (c: Ctx, it: ItemRow) => ResourceSource[];

const mined: SourceFn = (c, it) => {
  const { types, oreHardness, danger } = c.d.mining;
  const hard = oreHardness[it.id] ?? 1;
  const out: { share: number; src: ResourceSource }[] = [];
  for (const [rockId, rock] of Object.entries(types)) {
    const w = rock.ores[it.id];
    if (!w) continue;
    const where = c.rockSystems.get(rockId);
    if (!where?.length) continue;
    const share = w / Object.values(rock.ores).reduce((a, b) => a + b, 0);
    out.push({
      share,
      src: { kind: 'mined', text: `${rock.name ?? cap(rockId)}: ${TIER_LABEL[tierOf('rock', share)]} share of its ore${rock.hardness > 1 ? ` (hardness ${rock.hardness} rock)` : ''}`, where: where.map((s) => `${s.name} (danger ${s.danger})`) },
    });
  }
  if (!out.length) return [];
  out.sort((a, b) => b.share - a.share);
  const srcs = out.map((o) => o.src);
  const rich = Object.entries(danger).filter(([, v]) => (v.boost[it.id] ?? 1) > 1).map(([k]) => Number(k)).sort((a, b) => a - b);
  const notes: string[] = [];
  if (hard > 1) notes.push(`the ore itself is hardness ${hard}: your tool has to crack that`);
  if (rich.length) notes.push(`turns up more in systems of danger ${rich[0]} and up`);
  if (notes.length) srcs[0] = { ...srcs[0], text: `${srcs[0].text}; ${notes.join('; ')}` };
  return srcs;
};

const seam: SourceFn = (c, it) => {
  const s = c.d.mining.seams.find((x) => x.gem === it.id);
  if (!s) return [];
  const where = c.d.systems.filter((x) => isPublicSystem(x) && x.danger >= s.minTier && x.asteroidField);
  return [{
    kind: 'seam', text: `Gem seams in belt rock, hardness ${s.hardness}, in systems of danger ${s.minTier} and up (more seams the higher the danger)`,
    where: where.sort((a, b) => a.danger - b.danger).map((x) => `${x.name} (danger ${x.danger})`),
  }];
};

const trace: SourceFn = (c, it) => {
  const t = c.d.mining.traces[it.id];
  if (!t) return [];
  const first = t.per100.findIndex((v) => v > 0);
  return [{
    kind: 'trace',
    text: `Never a rock of its own: some turns up when you refine ${some(t.from.map(c.name), 4)}${t.megaOnly ? ' (only ore from Neutron Slugs)' : ''}${first >= 0 ? `, if it was mined in a system of danger ${first} or more` : ''}. Station refinery upgrades raise the rate`,
  }];
};

const refine: SourceFn = (c, it) => c.d.recipes.refining.filter((r) => r.id === it.id).map((r) => ({
  kind: 'refine' as const,
  text: `Refinery: ${c.bag(r.inputs)} makes ${r.out === 1 ? 'one' : r.out} (${secs(r.time ?? 0)} at a station refinery${r.level ? `; known from level ${r.level}` : ''}). A refiner on your ship does it too, slower`,
}));

const fabricate: SourceFn = (c, it) => c.d.recipes.craft.filter((r) => r.out[it.id]).map((r) => {
  const n = r.out[it.id];
  const learn = r.quest ? `learned from the job "${c.d.quests.quests.find((q) => q.id === r.quest)?.name ?? r.quest}"` : r.starter ? 'known from the start' : r.level ? `learned from level ${r.level}` : '';
  return {
    kind: 'fabricate' as const,
    text: `Fabricator: ${c.bag(r.inputs)} makes ${n === 1 ? 'one' : n}${r.time ? ` (${secs(r.time)})` : ' (instant)'}${learn ? `; ${learn}` : ''}`,
  };
});

const cut: SourceFn = (c, it) => {
  if (!it.socket) return [];
  const type = c.d.gems.types[it.socket.type];
  const cutRule = c.d.gems.cuts[String(it.socket.level)];
  if (!type || !cutRule) return [];
  return [{ kind: 'cut', text: `Cut at a station: ${c.bag(cutRule.inputs)} and one ${c.name(type.material)}${it.socket.level > 1 ? ' (it can fail, and returns half)' : ''}` }];
};

const drop: SourceFn = (c, it) => {
  const rows: { chance: number; line: string }[] = [];
  const add = (who: string, loot: DropRow[] | undefined, where?: string) => {
    for (const l of loot ?? []) if (l.item === it.id) rows.push({ chance: l.chance, line: `${who}${where ? ` (${where})` : ''}: ${TIER_LABEL[tierOf('drop', l.chance)]} chance, ${l.min === l.max ? l.min : `${l.min}-${l.max}`}` });
  };
  for (const b of Object.values(c.d.bosses)) add(b.name, b.loot, c.system(b.system));
  for (const f of Object.values(c.d.factions)) add(`${f.name} (any ship)`, f.loot);
  if (!rows.length) return [];
  rows.sort((a, b) => b.chance - a.chance);
  return [{ kind: 'drop', text: 'Dropped by these when you help bring them down (chance tier, amount)', where: rows.map((r) => r.line) }];
};

const bought: SourceFn = (c, it) => {
  const out: ResourceSource[] = [];
  const stations = c.d.stations.filter((s) => s.market?.sells?.includes(it.id));
  if (stations.length) out.push({ kind: 'bought', text: 'On sale at station markets', where: stations.map((s) => `${s.name} (${c.system(s.system)})`) });
  const qms: string[] = [];
  for (const rep of Object.values(c.d.quests.reputations)) {
    const row = rep.vendor?.stock?.find((x) => x.item === it.id);
    if (row) qms.push(`${rep.name}, rank ${row.rank}`);
  }
  if (qms.length) out.push({ kind: 'bought', text: 'From a faction quartermaster once you have the standing', where: qms });
  return out;
};

const questReward: SourceFn = (c, it) => {
  const people = new Map(c.d.people.map((p) => [p.id, p.name]));
  const jobs = c.d.quests.quests.filter((q) => q.rewards?.items?.[it.id]);
  const out: ResourceSource[] = [];
  if (jobs.length) {
    out.push({
      kind: 'quest', text: `Reward for ${plural(jobs.length, 'job')}`,
      where: jobs.map((q) => `${q.name}${q.person && people.get(q.person) ? ` (${people.get(q.person)})` : ''}${q.level ? `, level ${q.level}` : ''} x${q.rewards!.items![it.id]}`),
    });
  }
  if (it.quest) {
    const q = c.d.quests.quests.find((x) => x.id === it.quest);
    if (q) out.push({ kind: 'quest', text: `A job item: found during the job "${q.name}" and taken back if you abandon it` });
  }
  return out;
};

const salvage: SourceFn = (c, it) => {
  const s = c.d.rules.events?.salvage;
  if (!s) return [];
  if (s.goods?.includes(it.id)) return [{ kind: 'salvage', text: 'In the pods of a salvage event (a drifting field of wreck pods), among the common goods' }];
  if (s.rare?.includes(it.id)) return [{ kind: 'salvage', text: 'In the pods of a salvage event (a drifting field of wreck pods), sometimes; more often in dangerous systems' }];
  return [];
};

const SOURCES: SourceFn[] = [mined, seam, trace, refine, fabricate, cut, drop, bought, questReward, salvage];

// --- What an item is used for

function usedFor(c: Ctx, it: ItemRow): string[] {
  const out: string[] = [];
  const r = c.d.recipes;
  const refines = r.refining.filter((x) => x.inputs[it.id]).map((x) => c.name(x.id));
  if (refines.length) out.push(`Refined into ${some(refines)}`);
  const crafts = r.craft.filter((x) => x.inputs[it.id]).map((x) => c.name(Object.keys(x.out)[0]));
  if (crafts.length) out.push(`Fabricated into ${some(crafts)}`);
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fam = (f: string) => (f.length <= 3 ? f.toUpperCase() : cap(f));
  const modelName = new Map(c.d.models.map((m) => [m.id, m.family && !flat(m.name).includes(flat(m.family)) ? `${fam(m.family)} ${m.name}` : m.name]));
  const models = Object.entries(r.models ?? {}).filter(([, m]) => m.inputs[it.id]).map(([id]) => modelName.get(id) ?? cap(id));
  if (models.length) out.push(`Ship parts that need it (${models.length}): ${some(models, 5)}`);
  const mats = Object.entries(r.parts.plates).filter(([, id]) => id === it.id).map(([m]) => c.d.materials.find((x) => x.id === m)?.name ?? cap(m));
  if (mats.length) out.push(`Structure plate for ${some(mats)} hulls, armour and parts`);
  const fnName = new Map(c.d.functions.map((f) => [f.id, f.name]));
  const fns = Object.entries(r.parts.extras).filter(([, b]) => b[it.id]).map(([f]) => fnName.get(f) ?? cap(f));
  if (fns.length) out.push(`Goes into ${some(fns, 8)} parts`);
  const gemTypes = Object.values(c.d.gems.types).filter((g) => g.material === it.id).map((g) => g.name);
  if (gemTypes.length) out.push(`Cutting ${some(gemTypes)} gems`);
  if (Object.values(c.d.gems.cuts).some((x) => x.inputs[it.id])) out.push('Cutting any gem');
  const tracks = Object.values(c.d.station.tracks).filter((t) => t.tiers.some((x) => x.cost?.[it.id])).map((t) => t.name);
  if (tracks.length) out.push(tracks.length > 4 ? "Most of your station's upgrade tiers" : `Your station's upgrades: ${some(tracks)}`);
  if (it.pack) {
    out.push(`Holds ${c.bag(it.pack)}`);
    out.push(`In the field, a fabricator takes one unit of any of its plates from a pack and works ${Math.round(FIELD.packSpeed * 100)}% faster; in your repair bank it gives them all`);
  }
  if (it.ammoFor) out.push(`${plural(it.ammoFor.rounds, 'round')} for ${cap(it.ammoFor.weapon)}s`);
  const consumers = c.d.items.filter((x) => x.pack?.[it.id]).map((x) => x.name);
  if (consumers.length) out.push(`Comes in ${some(consumers)}`);
  return out;
}

// --- The index

/** One entry per resource item, in the item catalogue's order within each category */
export function buildResourceIndex(d: GameData, src: SourceIndex = buildSourceIndex(d)): ResourceEntry[] {
  const c = makeCtx(d);
  const out: ResourceEntry[] = [];
  for (const it of d.items) {
    const category = categoryOf(it);
    if (!category) continue;
    const sources = SOURCES.flatMap((f) => f(c, it)).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    out.push({
      id: it.id, name: it.name, category, color: it.color, rarity: it.rarity, value: it.value, description: it.description,
      sources, usedFor: usedFor(c, it), hint: d.hints[it.id], cols: src.columns.get(it.id) ?? { mined: [], dropped: [], madeFrom: [], soldAt: [], rewards: [], usedIn: [], systems: [] }, notObtainable: sources.length === 0,
    });
  }
  return out.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
}
