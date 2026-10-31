/**
 * Load-time validation of the game data files (docs/review-2026-10-22.md §3.3).
 *
 * Two passes:
 *   1. Shape: each file against the TypeScript interfaces the code reads it
 *      through (QuestDef, PersonDef, BossDef, FactionsFile, ItemDef, ...):
 *      required fields present and of the right type. Unknown keys on the
 *      objects that have a fixed schema are warnings (keys starting with `_`
 *      are comments and always allowed).
 *   2. Cross-reference: every id used anywhere resolves: stations, systems,
 *      people, bosses, factions, quests, items, recipes, licences, ship plans
 *      and enemy designs, arenas, surfaces, weapon kinds, part functions.
 *
 * Checks that need the ship data (plans, enemy designs, functions, weapon
 * kinds, generated part ids) run only when `opts.ships` is given; GameData
 * alone validates the rest.
 *
 * Browser-safe (no Node imports): proto mode builds GameData in the client.
 */

import { BRAIN_IDS } from '../game/brains/ids.js';
import {
  FN_NAMES, WEAPON_KIND_TYPE, WEAPON_MOD_NUMBERS, DICTIONARY, DAMAGE_TYPES, DEFAULT_ASTEROID_FIELDS, DEFAULT_ASTEROIDS, parsePartItemId, MINERAL_FAMILIES, MATERIAL_TRAITS, HAZARDS, UNLOCK_KEYS,
  nestReach, safeRadius, CODEX_TABS, MAX_DRIVE, PLANET_LOOK_FIELDS, STAR_PLASMA_FIELDS, type Blueprint, type CatalogFiles, type ShipTuning, type InventoryStub,
} from '@space-game/common';
import type { GameDataFiles } from './GameData.js';

export interface DataProblem {
  /** The data file, relative to data/ (quests.json, ships/tuning.json, ships/blueprints/enemy/x.json) */
  file: string;
  /** Where in it (quests[3].steps[1].station) */
  path: string;
  message: string;
  level: 'error' | 'warning';
}

/** The ship data (loadShipConfigFromDisk / ShipConfig): enables the ship cross-checks */
export interface ShipDataFiles {
  catalog: CatalogFiles;
  tuning: ShipTuning;
  inventory?: InventoryStub;
  /** Plan library (data/ships/blueprints), by file name */
  library?: Record<string, Blueprint>;
  /** Enemy designs (data/ships/blueprints/enemy), by file name */
  enemies?: Record<string, Blueprint>;
}

export interface ValidateOptions {
  ships?: ShipDataFiles;
}

// ---------------------------------------------------------------------------
// Shape specs: a tiny hand-written schema language
// ---------------------------------------------------------------------------

/** Keys ending in `?` are optional */
type Fields = Record<string, Spec>;
type Spec =
  | 'string' | 'number' | 'boolean' | 'any' | 'bag' | 'string[]' | 'number[]' | 'xy'
  | { arr: Spec }
  | { rec: Spec }
  | { obj: Fields; strict?: boolean }
  | { enum: readonly (string | number)[] }
  | { or: Spec[] }
  | ((v: unknown, path: string, c: Ctx) => void);

const arr = (s: Spec): Spec => ({ arr: s });
const rec = (s: Spec): Spec => ({ rec: s });
const obj = (f: Fields): Spec => ({ obj: f });
/** Unknown keys warn */
const strict = (f: Fields): Spec => ({ obj: f, strict: true });
const oneOf = (...v: (string | number)[]): Spec => ({ enum: v });

class Ctx {
  readonly problems: DataProblem[] = [];
  file = '';
  err(path: string, message: string, file = this.file): void { this.problems.push({ file, path, message, level: 'error' }); }
  warn(path: string, message: string, file = this.file): void { this.problems.push({ file, path, message, level: 'warning' }); }
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v);
const join = (path: string, k: string | number) => (typeof k === 'number' ? `${path}[${k}]` : path ? `${path}.${k}` : k);

function check(c: Ctx, spec: Spec, v: unknown, path: string): void {
  if (typeof spec === 'function') { spec(v, path, c); return; }
  if (typeof spec === 'string') {
    switch (spec) {
      case 'any': return;
      case 'string': if (typeof v !== 'string') c.err(path, `expected a string, got ${typeName(v)}`); return;
      case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) c.err(path, `expected a number, got ${typeName(v)}`); return;
      case 'boolean': if (typeof v !== 'boolean') c.err(path, `expected true/false, got ${typeName(v)}`); return;
      case 'string[]': check(c, arr('string'), v, path); return;
      case 'number[]': check(c, arr('number'), v, path); return;
      case 'xy': check(c, obj({ x: 'number', y: 'number' }), v, path); return;
      case 'bag':
        if (!isObj(v)) { c.err(path, `expected an item bag { id: count }, got ${typeName(v)}`); return; }
        for (const [k, n] of Object.entries(v)) if (typeof n !== 'number' || !(n > 0)) c.err(join(path, k), `expected a positive count, got ${JSON.stringify(n)}`);
        return;
    }
  }
  if ('arr' in spec) {
    if (!Array.isArray(v)) { c.err(path, `expected an array, got ${typeName(v)}`); return; }
    v.forEach((x, i) => check(c, spec.arr, x, join(path, i)));
    return;
  }
  if ('rec' in spec) {
    if (!isObj(v)) { c.err(path, `expected an object, got ${typeName(v)}`); return; }
    for (const [k, x] of Object.entries(v)) if (!k.startsWith('_')) check(c, spec.rec, x, join(path, k));
    return;
  }
  if ('enum' in spec) {
    if (!spec.enum.includes(v as string)) c.err(path, `expected one of ${spec.enum.map((e) => JSON.stringify(e)).join(', ')}, got ${JSON.stringify(v)}`);
    return;
  }
  if ('or' in spec) {
    // The first alternative that fits without errors; else report the first's errors
    for (const s of spec.or) {
      const trial = new Ctx();
      check(trial, s, v, path);
      if (!trial.problems.some((p) => p.level === 'error')) { check(c, s, v, path); return; }
    }
    check(c, spec.or[0], v, path);
    return;
  }
  // obj
  if (!isObj(v)) { c.err(path, `expected an object, got ${typeName(v)}`); return; }
  const known = new Set<string>();
  for (const [rawKey, s] of Object.entries(spec.obj)) {
    const optional = rawKey.endsWith('?');
    const k = optional ? rawKey.slice(0, -1) : rawKey;
    known.add(k);
    if (v[k] === undefined) { if (!optional) c.err(join(path, k), 'missing required field'); continue; }
    check(c, s, v[k], join(path, k));
  }
  if (spec.strict) for (const k of Object.keys(v)) if (!known.has(k) && !k.startsWith('_')) c.warn(join(path, k), `unknown field "${k}" (ignored by the code)`);
}

// ---------------------------------------------------------------------------
// Shapes of each file
// ---------------------------------------------------------------------------

const ITEM_CATEGORIES = ['mineral', 'gem', 'volatile', 'refined', 'component', 'artefact', 'consumable', 'ammo', 'jewel', 'part', 'plan', 'quest'];
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const STATION_SERVICES = ['repair', 'storage', 'refinery', 'fabricator', 'market', 'shipyard', 'refuel', 'shop', 'bank', 'quests'];
/** Profile stats that something bumps (Pilots.bumpStat callers), plus the two computed ones */
const KNOWN_STATS = ['kills', 'assists', 'bosses', 'mined', 'quests', 'fleetOps', 'escorts', 'defences', 'crafted', 'refined', 'earned', 'trades', 'salvaged', 'raidsDefended', 'events', 'level', 'systems'];

/** A planet's `look` (PLANET_LOOK_FIELDS): known fields only, each the right shape */
const lookSpec: Spec = (v, path, c) => {
  if (!isObj(v)) { c.err(path, `expected an object, got ${typeName(v)}`); return; }
  const nums = (x: unknown, n: number) => Array.isArray(x) && x.length === n && x.every((e) => typeof e === 'number' && Number.isFinite(e));
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith('_')) continue;
    const shape = (PLANET_LOOK_FIELDS as Record<string, string>)[k], p = join(path, k);
    if (!shape) c.err(p, `not a look field (${Object.keys(PLANET_LOOK_FIELDS).join(', ')})`);
    else if (shape === 'number') { if (typeof x !== 'number' || !Number.isFinite(x)) c.err(p, `expected a number, got ${typeName(x)}`); }
    else if (shape === 'pal') { if (!(Array.isArray(x) && x.length === 3 && x.every((col) => nums(col, 3)))) c.err(p, 'expected three colours, each [r, g, b]'); }
    else if (!nums(x, 3)) c.err(p, `expected three numbers${shape === 'rgb' ? ' (a colour: r, g, b)' : ''}`);
    else if (shape === 'rgb' && (x as number[]).some((e) => e < 0 || e > 2)) c.err(p, 'colour channels are 0..1 (up to 2 for a glow)');
  }
};

/** A star's `plasma` (STAR_PLASMA_FIELDS): known fields only, numbers in range, colours '#rrggbb' */
const plasmaSpec: Spec = (v, path, c) => {
  if (!isObj(v)) { c.err(path, `expected an object, got ${typeName(v)}`); return; }
  const colour = (x: unknown) => typeof x === 'string' && /^#[0-9a-fA-F]{6}$/.test(x);
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith('_')) continue;
    const field = (STAR_PLASMA_FIELDS as Record<string, unknown>)[k], p = join(path, k);
    if (!field) c.err(p, `not a plasma field (${Object.keys(STAR_PLASMA_FIELDS).join(', ')})`);
    else if (field === 'colour') { if (!colour(x)) c.err(p, `expected a colour '#rrggbb', got ${JSON.stringify(x)}`); }
    else if (field === 'iridescence') {
      if (!isObj(x)) { c.err(p, `expected an object, got ${typeName(x)}`); continue; }
      if (x.mode !== 'rainbow' && x.mode !== 'tints') c.err(join(p, 'mode'), `expected 'rainbow' or 'tints'`);
      if (x.colors !== undefined && !(Array.isArray(x.colors) && x.colors.length >= 1 && x.colors.length <= 3 && x.colors.every(colour))) c.err(join(p, 'colors'), `expected one to three colours '#rrggbb'`);
      for (const n of ['strength', 'drift', 'spread']) if (x[n] !== undefined && (typeof x[n] !== 'number' || !Number.isFinite(x[n]))) c.err(join(p, n), `expected a number, got ${typeName(x[n])}`);
    } else {
      const [lo, hi] = field as readonly [number, number];
      if (typeof x !== 'number' || !Number.isFinite(x)) c.err(p, `expected a number, got ${typeName(x)}`);
      else if (x < lo || x > hi) c.err(p, `${x} is out of range (${lo}..${hi})`);
    }
  }
};

const lootSpec = arr(obj({ item: 'string', chance: 'number', min: 'number', max: 'number' }));
const behaviourSpec = obj({ aggro: 'number', range: 'number', flee: 'number', leash: 'number', 'accuracy?': 'number', 'strafe?': 'number' });

const condSpec: Spec = (v, path, c) => {
  if (!isObj(v)) { c.err(path, `expected a condition, got ${typeName(v)}`); return; }
  const keys = Object.keys(v);
  if (keys.length !== 1) { c.err(path, `a condition has exactly one key (done/active/known/step/has/level/flag/visit/mined/kills/boss/rep/event/chance/not/all/any), got ${keys.join(', ') || 'none'}`); return; }
  const k = keys[0];
  const x = v[k];
  switch (k) {
    case 'done': case 'active': case 'known': case 'flag': case 'visit': case 'mined': case 'boss': case 'event': check(c, 'string', x, join(path, k)); return;
    case 'kills': check(c, obj({ n: 'number', 'of?': 'string' }), x, join(path, k)); return;
    case 'rep': check(c, rec('number'), x, join(path, k)); return;
    case 'chance': check(c, obj({ p: 'number', per: 'string' }), x, join(path, k)); return;
    case 'level': check(c, 'number', x, join(path, k)); return;
    case 'has': check(c, 'bag', x, join(path, k)); return;
    case 'step':
      if (!Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'string' || typeof x[1] !== 'number') c.err(join(path, k), 'expected ["quest_id", stepIndex]');
      return;
    case 'not': check(c, condSpec, x, join(path, k)); return;
    case 'all': case 'any': check(c, arr(condSpec), x, join(path, k)); return;
    default: c.err(path, `unknown condition "${k}"`);
  }
};

const LINE_KINDS: Record<string, Fields> = {
  say: { say: 'string', 'who?': oneOf('you') },
  choices: { 'ask?': 'string', choices: arr(strict({ text: 'string', 'if?': condSpec, 'then?': (v, p, c) => check(c, linesSpec, v, p) })) },
  if: { if: condSpec, then: (v, p, c) => check(c, linesSpec, v, p), 'else?': (v, p, c) => check(c, linesSpec, v, p) },
  offer: { offer: 'string' },
  reveal: { reveal: 'string' },
  give: { give: 'bag' },
  flag: { flag: 'string' },
  codex: { codex: 'string' },
  advance: { advance: oneOf(true as unknown as string) },
  fight: { fight: oneOf(true as unknown as string) },
  end: { end: oneOf(true as unknown as string) },
};
const lineSpec: Spec = (v, path, c) => {
  if (!isObj(v)) { c.err(path, `expected a line, got ${typeName(v)}`); return; }
  const kind = Object.keys(LINE_KINDS).find((k) => k in v);
  if (!kind) { c.err(path, `not a line: needs one of ${Object.keys(LINE_KINDS).join('/')} (got ${Object.keys(v).join(', ') || 'nothing'})`); return; }
  check(c, strict(LINE_KINDS[kind]), v, path);
};
const linesSpec: Spec = arr(lineSpec);

const STEP_FIELDS: Record<string, Fields> = {
  travel: { system: 'string' },
  dock: { station: 'string' },
  mine: { 'item?': 'string', count: 'number' },
  loot: { 'item?': 'string', count: 'number' },
  refine: { 'item?': 'string', count: 'number' },
  craft: { 'item?': 'string', 'category?': oneOf(...ITEM_CATEGORIES), count: 'number', 'teach?': 'string' },
  refit: { 'fn?': 'string', 'material?': 'string', 'count?': 'number', 'minParts?': 'number' },
  kill: { 'faction?': 'string', 'enemy?': 'string', 'system?': 'string', count: 'number' },
  deliver: { items: 'bag' },
  sell: { credits: 'number' },
  level: { level: 'number' },
  boss: { boss: 'string', 'arena?': 'string', 'person?': 'string', 'lines?': linesSpec },
  talk: { person: 'string', 'lines?': linesSpec, 'take?': 'bag', 'give?': 'bag' },
  visit: { system: 'string', x: 'number', y: 'number', 'radius?': 'number', label: 'string', 'give?': 'bag' },
  slot: { plan: 'string' },
  build: { plan: 'string' },
  fly: { plan: 'string' },
  courier: { station: 'string', seconds: 'number' },
  scan: { count: 'number', system: 'string' },
  escort: { from: 'string', to: 'string', ambushes: 'number', 'ward?': 'string' },
  defend: { near: 'string', waves: 'number' },
  uplink: { near: 'string', beacons: 'number', seconds: 'number' },
  hold: { system: 'string', x: 'number', y: 'number', 'radius?': 'number', seconds: 'number', label: 'string', 'raid?': 'number' },
  course: { system: 'string', x: 'number', y: 'number', rings: 'number', seconds: 'number', label: 'string', 'spacing?': 'number' },
  recover: { system: 'string', x: 'number', y: 'number', item: 'string', label: 'string', 'guard?': 'number' },
  construct: { system: 'string', x: 'number', y: 'number', label: 'string', structure: 'string', pieces: arr(strict({ id: 'string', item: 'string', name: 'string' })), 'seconds?': 'number' },
};
const stepSpec: Spec = (v, path, c) => {
  if (!isObj(v)) { c.err(path, `expected a step, got ${typeName(v)}`); return; }
  const f = STEP_FIELDS[v.type as string];
  if (!f) { c.err(join(path, 'type'), `unknown step type ${JSON.stringify(v.type)} (one of ${Object.keys(STEP_FIELDS).join(', ')})`); return; }
  check(c, strict({ type: 'string', 'text?': 'string', 'after?': linesSpec, ...f }), v, path);
};

const rewardsSpec = strict({
  'xp?': 'number', 'credits?': 'number', 'items?': 'bag', 'plans?': 'string[]', 'recipes?': 'string[]', 'licences?': 'string[]',
  'reputation?': rec('number'), 'skillPoints?': 'number', 'codex?': 'string[]',
});

const questSpec = strict({
  id: 'string', name: 'string', chain: 'string', 'party?': 'number', 'giver?': 'string', 'person?': 'string', 'starter?': 'boolean',
  'offer?': linesSpec, 'npc?': 'string', level: 'number', 'requires?': 'string[]', 'minRep?': rec('number'), 'reveal?': condSpec, 'rumour?': 'string',
  'repeatable?': 'boolean', 'rev?': 'number', 'onStart?': strict({ 'recipes?': 'string[]', 'items?': 'bag' }), intro: 'string', outro: 'string', steps: arr(stepSpec), rewards: rewardsSpec,
});

const placeSpec: Spec = { or: [strict({ station: 'string' }), strict({ system: 'string', x: 'number', y: 'number', 'label?': 'string' })] };

const SHAPES: Record<string, Spec> = {
  'quests.json': strict({
    quests: arr(questSpec),
    reputations: rec(strict({ name: 'string', description: 'string', 'vendor?': strict({ stations: 'string[]', stock: arr(obj({ item: 'string', rank: 'number' })) }) })),
    restricted: rec(strict({ name: 'string', hint: 'string', 'licence?': 'string' })),
  }),
  'people.json': strict({
    people: arr(strict({
      id: 'string', name: 'string', title: 'string', 'color?': 'string', at: placeSpec,
      'craft?': strict({ ship: 'string', 'angle?': 'number', 'name?': 'string' }),
      'moves?': arr(strict({ if: condSpec, at: placeSpec })),
      greeting: 'string[]',
      'topics?': arr(strict({ 'id?': 'string', label: 'string', 'if?': condSpec, 'once?': 'boolean', lines: linesSpec })),
    })),
  }),
  'items.json': strict({
    items: arr(strict({
      id: 'string', name: 'string', category: oneOf(...ITEM_CATEGORIES), rarity: oneOf(...RARITIES), value: 'number', color: 'string', description: 'string',
      'volume?': 'number', 'part?': obj({ material: 'string', fn: 'string', piece: 'string' }), 'plan?': 'string', 'quest?': 'string',
      'repair?': obj({ budget: 'number', hpPerSec: 'number', restoreSec: 'number' }),
      'family?': oneOf(...MINERAL_FAMILIES), 'tier?': 'number', 'trace?': 'boolean', 'short?': 'string', 'socket?': obj({ type: 'string', level: 'number' }),
      'ammoFor?': obj({ weapon: 'string', rounds: 'number', 'mods?': 'any' }), 'codex?': 'string',
    })),
  }),
  'codex.json': strict({
    entries: arr(strict({ id: 'string', tab: oneOf(...CODEX_TABS), title: 'string', source: 'string', body: 'string', 'unlock?': condSpec })),
  }),
  'recipes.json': strict({
    refining: arr(strict({ id: 'string', inputs: 'bag', out: 'number', 'time?': 'number', 'level?': 'number' })),
    parts: strict({
      plates: rec('string'), platesPerArea: 'number', 'platesPerAreaByGrade?': 'number[]', 'timeByGrade?': 'number[]',
      extras: rec(rec('number')), instantMaxArea: 'number', secondsPerArea: 'number', rebuildFraction: 'number',
    }),
    craft: arr(strict({ id: 'string', out: 'bag', inputs: 'bag', time: 'number', 'starter?': 'boolean', 'level?': 'number', 'quest?': 'string' })),
    'models?': rec(strict({ inputs: 'bag', time: 'number', 'perCell?': 'boolean' })),
  }),
  'unlocks.json': (v, path, c) => {
    check(c, obj({}), v, path);
    for (const [k, d] of Object.entries(isObj(v) ? v : {})) {
      if (k.startsWith('_')) continue;
      if (!(UNLOCK_KEYS as readonly string[]).includes(k)) { c.err(k, `not something that unlocks (${UNLOCK_KEYS.join(', ')})`); continue; }
      check(c, strict({ base: 'number', label: 'string', 'levels?': rec('number') }), d, k);
    }
  },
  'hazards.json': (v, path, c) => {
    check(c, obj({ 'nearStar?': obj({ 'radii?': 'number', 'margin?': 'number', ratings: rec('number') }), 'nearBlackHole?': obj({ 'radii?': 'number', 'margin?': 'number', ratings: rec('number') }), 'tolerance?': 'any', 'effects?': rec(obj({ summary: 'string' })),
      'warmth?': obj({ coldPerPoint: 'number', ambient: 'number', seizeTicks: 'number', sources: obj({
        'star?': obj({ margin: 'number', rate: 'number' }), 'station?': obj({ margin: 'number', rate: 'number', docked: 'number' }),
        'burning?': obj({ radius: 'number', rate: 'number' }), 'planet?': obj({ kinds: 'string[]', margin: 'number', rate: 'number' }) }) }) }), v, path);
    for (const k of ['nearStar', 'nearBlackHole', 'effects', 'tolerance']) {
      const r = isObj(v) ? (k === 'nearStar' || k === 'nearBlackHole' ? v[k]?.ratings : v[k]) : undefined;
      for (const h of Object.keys(isObj(r) ? r : {})) if (!h.startsWith('_') && !(HAZARDS as readonly string[]).includes(h)) c.err(join(k, h), `not a hazard (${HAZARDS.join(', ')})`);
    }
  },
  'station.json': obj({
    charter: obj({ level: 'number', credits: 'number', items: 'bag' }),
    sites: arr(obj({ id: 'string', name: 'string', station: 'string' })),
    tracks: rec(obj({ name: 'string', group: 'string', about: 'string', tiers: arr(obj({ name: 'string', cost: 'bag', minutes: 'number' })) })),
  }),
  'gems.json': obj({
    sockets: obj({ byGrade: 'any', levelByGrade: 'number[]', largeArea: 'number', legendary: 'number[]' }),
    cuts: rec(obj({ inputs: 'bag', seconds: 'number', fail: 'number' })),
    types: rec(obj({ name: 'string', color: 'string', material: 'string', levels: rec(obj({ summary: 'string', mods: 'any' })) })),
  }),
  'mining.json': strict({
    respawnSeconds: 'number', unitsPerSize: 'number', damagePerUnit: 'number', chunkUnits: 'number[]', breakFraction: 'number', xpPerUnit: 'number',
    types: rec(obj({ hardness: 'number', ores: rec('number'), 'traceMul?': 'number', 'traceBoost?': rec('number'), 'name?': 'string', 'size?': 'number[]', 'like?': 'string', 'gas?': 'boolean' })),
    'fields?': rec(rec('number')),
    'comet?': obj({ days: 'number', hours: 'number', systems: 'string[]', traceTier: 'number' }),
    oreHardness: rec('number'),
    danger: rec(obj({ seamChance: 'number', boost: rec('number') })),
    seams: arr(obj({ gem: 'string', hardness: 'number', minTier: 'number', weight: 'number' })),
    seamGemChance: 'number',
    'tierEfficiency?': rec('number'),
    'outliers?': strict({ chance: 'number', scale: 'number[]', stages: 'number[]', 'exclude?': 'string[]', 'systems?': rec('number'), common: 'number', boost: rec('number'), rare: 'number' }),
    'traces?': rec(obj({ from: 'string[]', per100: 'number[]', 'seamMul?': 'number', 'megaOnly?': 'boolean' })),
    tools: (v, path, c) => {
      check(c, obj({ fixed: 'any', turret: 'any', miner: 'any', minerByMaterial: rec('number') }), v, path);
      if (!isObj(v)) return;
      for (const [k, t] of Object.entries(v)) if (!k.startsWith('_') && k !== 'minerByMaterial') check(c, obj({ yield: 'number', hardness: 'number' }), t, join(path, k));
    },
  }),
  'bosses.json': strict({
    rules: obj({ creditRange: 'number', creditWindowTicks: 'number', barRange: 'number', 'stageCover?': 'number' }),
    bosses: rec(strict({
      name: 'string', title: 'string', faction: 'string', system: 'string', lair: 'xy', level: 'number', hp: 'number', damage: 'number',
      xp: 'number', credits: 'number', respawnSeconds: 'number', behaviour: behaviourSpec, intro: 'string',
      phases: arr(strict({
        at: 'number', 'say?': 'string', 'escorts?': 'string[]', 'enrage?': 'number', 'heal?': 'number', 'blink?': 'number',
        'nova?': obj({ every: 'number', kind: 'string', count: 'number', warnTicks: 'number', 'intercept?': 'boolean' }),
      })),
      loot: lootSpec, 'design?': 'string', 'arena?': 'boolean', 'fixed?': 'boolean', 'grade?': 'number', 'plating?': 'number', 'asDesigned?': 'boolean', 'speed?': 'number', 'turn?': 'number', 'stageCover?': 'number',
      'roam?': obj({ radius: 'number', everySeconds: 'number' }), 'brain?': oneOf(...BRAIN_IDS),
    })),
  }),
  'factions.json': (() => {
    const group = obj({ faction: 'string', ships: 'string[]', weight: 'number', 'passive?': 'boolean', 'plating?': 'number', 'limit?': 'number', 'respawnSeconds?': 'number', 'style?': oneOf('anchored', 'loose', 'nomad') });
    return strict({
      factions: rec(obj({
        name: 'string', color: 'string', behaviour: behaviourSpec, ships: rec(obj({ xp: 'number', credits: 'number' })),
        loot: lootSpec, partSalvage: 'number', 'hpScale?': 'number', 'damageScale?': 'number', 'angrySeconds?': 'number',
      })),
      spawns: rec(strict({
        'grade?': 'number', packs: 'number', groups: arr(group),
        'zones?': arr(obj({ id: 'string', inner: 'number', outer: 'number', 'x?': 'number', 'y?': 'number', packs: 'number', 'respawnSeconds?': 'number', groups: arr(group) })),
        'nests?': arr(obj({ id: 'string', packs: 'number', 'respawnSeconds?': 'number', 'leash?': 'number', 'roam?': 'number', 'style?': oneOf('anchored', 'loose', 'nomad'), 'bias?': 'number', groups: arr(group) })),
        'events?': strict({
          'raidStations?': 'string[]', 'raidZone?': 'string', 'salvageZone?': 'string', 'salvageBelt?': 'number',
          'warband?': obj({ zone: 'string', share: 'number', groups: arr(group) }),
          'peak?': strict({ share: 'number', x: 'number', y: 'number', pods: 'number', goods: 'string[]', flock: group }),
        }),
      })),
      rules: obj({
        minStationDistance: 'number', minPlayerDistance: 'number', eliteChance: 'number', eliteHp: 'number', eliteLoot: 'number',
        respawnSeconds: 'number', idleDespawnSeconds: 'number', assistXpShare: 'number', 'gradeCredits?': 'number[]', 'nestWake?': 'number',
        stationDefence: rec(obj({ range: 'number', damage: 'number', interval: 'number', 'splash?': 'number' })),
      }),
    });
  })(),
  'achievements.json': strict({
    ribbons: arr(strict({
      id: 'string', name: 'string', icon: 'string', stat: 'string', at: 'number', description: 'string',
      reward: obj({ 'credits?': 'number', 'xp?': 'number' }), 'rare?': 'boolean',
    })),
  }),
  'stations.json': strict({
    stations: arr(strict({
      id: 'string', name: 'string', description: 'string', system: 'string', position: 'xy', radius: 'number', sprite: 'string',
      'design?': oneOf('ring', 'outpost', 'observatory', 'bastion', 'shipyard', 'refinery', 'citadel'),
      'defence?': obj({ weapon: 'string', turrets: 'number' }),
      dockingRadius: 'number', 'orbit?': obj({ orbitType: 'number', semiMajorAxis: 'number', eccentricity: 'number', argPeriapsis: 'number', meanAnomaly0: 'number', 'epochTick?': 'number' }),
      services: arr(oneOf(...STATION_SERVICES)), 'shop?': 'any',
      'market?': obj({ sells: 'string[]', demand: rec('number'), 'note?': 'string' }),
      repairCostPerHp: 'number', refuelCostPerUnit: 'number', 'dockingFee?': 'number',
    })),
  }),
  'systems.json': strict({
    systems: arr(strict({
      id: 'string', name: 'string', 'danger?': 'number', 'pvp?': obj({ mode: oneOf('all', 'outer'), 'safeRadius?': 'number' }),
      description: 'string', starColor: 'string', starRadius: 'number', position: 'xy', 'sector?': 'string',
      'centralBody?': obj({ type: oneOf('sun', 'binary', 'black_hole', 'pulsar', 'brown_dwarf', 'none'), 'look?': lookSpec, 'plasma?': plasmaSpec }),
      'zones?': arr(obj({ id: 'string', name: 'string', inner: 'number', outer: 'number', 'x?': 'number', 'y?': 'number' })),
      'regions?': arr(obj({ id: 'string', name: 'string', outer: 'number', danger: oneOf('safe', 'contested', 'hostile'), 'description?': 'string' })),
      'surface?': obj({
        of: 'string', planet: 'string', 'moon?': 'number', kind: oneOf('terran', 'rocky', 'desert', 'ice', 'lava', 'toxic', 'cavern'), radius: 'number',
        'under?': obj({ surface: 'string', x: 'number', y: 'number', radius: 'number', 'name?': 'string' }),
        'dread?': obj({ x: 'number', y: 'number', from: 'number', full: 'number' }),
        'bastion?': obj({ x: 'number', y: 'number', slots: arr('xy') }),
        'city?': obj({ name: 'string', x: 'number', y: 'number', radius: 'number', pylons: arr('xy') }),
        'siege?': obj({ everySeconds: 'number', waves: 'number', 'faction?': 'string' }),
        'arena?': obj({ boss: 'xy', entry: 'xy' }), 'landing?': 'xy', 'fixedWalls?': 'boolean',
      }),
      'instance?': obj({ slots: 'number' }), 'private?': 'boolean', 'visuals?': 'any',
      'pocket?': strict({
        entrance: strict({ system: 'string', x: 'number', y: 'number', radius: 'number', name: 'string', 'look?': strict({ kind: oneOf('dig', 'scrap', 'den', 'roost', 'sift', 'shrine', 'knot', 'dock'), faction: 'string', 'scale?': 'number' }) }),
        landing: 'xy', radius: 'number', 'dread?': obj({ x: 'number', y: 'number', from: 'number', full: 'number' }),
      }),
      hazards: 'string[]', 'hazardRatings?': (v, path, c) => {
        check(c, rec('number'), v, path);
        for (const [k, r] of Object.entries(isObj(v) ? v : {})) {
          if (!(HAZARDS as readonly string[]).includes(k)) c.err(join(path, k), `not a hazard (${HAZARDS.join(', ')})`);
          else if (!(typeof r === 'number' && r >= 0 && r <= 5)) c.err(join(path, k), 'must be 0-5');
        }
      },
      asteroidDensity: 'number', asteroidBelt: obj({ innerRadius: 'number', outerRadius: 'number', count: 'number', 'stationary?': 'boolean', 'lane?': obj({ angle: 'number', width: 'number' }), 'extra?': arr(obj({ innerRadius: 'number', outerRadius: 'number', count: 'number', 'field?': 'string', 'stationary?': 'boolean', 'lane?': obj({ angle: 'number', width: 'number' }) })) }),
      'asteroidField?': 'string', stations: 'string[]',
      portals: arr(obj({ id: 'string', targetSystem: 'string', position: 'xy' })),
      'rifts?': arr(obj({ id: 'string', position: 'xy', destination: obj({ system: 'string', x: 'number', y: 'number' }) })),
      'planets?': arr(obj({
        id: 'string', name: 'string', kind: 'string', radius: 'number', orbit: obj({ radius: 'number', phase: 'number', period: 'number' }),
        'moons?': arr(obj({ radius: 'number', distance: 'number', period: 'number', phase: 'number', 'name?': 'string', 'surface?': 'string' })),
        'surface?': 'string', 'look?': lookSpec,
      })),
      'derelicts?': arr(obj({ id: 'string', name: 'string', blueprint: 'string', position: 'xy', 'log?': strict({ codex: 'string' }) })),
      'comets?': arr(obj({ id: 'string', name: 'string', nucleus: 'number' })),
      'structures?': arr(obj({ id: 'string', name: 'string', kind: 'string', radius: 'number', segments: 'number' })),
      'lodestones?': arr(strict({
        id: 'string', 'name?': 'string', 'orbit?': strict({ radius: 'number', phase: 'number', period: 'number' }), 'position?': 'xy',
        'size?': 'number', 'state?': oneOf('active', 'scarred', 'dead', 'shattered'), 'scar?': strict({ from: 'number', to: 'number' }), 'rough?': 'boolean',
        'zone?': 'string', 'description?': 'string',
      })),
      'nests?': arr(strict({
        id: 'string', name: 'string', faction: 'string', kind: oneOf('dig', 'scrap', 'den', 'roost', 'sift', 'shrine', 'knot', 'dock'),
        'around?': 'string', 'moon?': 'number', orbit: strict({ radius: 'number', phase: 'number', period: 'number' }), 'description?': 'string',
      })),
      'traffic?': arr(obj({ id: 'string', name: 'string', blueprint: 'string', route: 'string[]' })),
    })),
  }),
};

const SHIP_SHAPES: Record<string, Spec> = {
  // (functions.json is growing presentation fields, review §3.4: entries aren't strict)
  'ships/functions.json': strict({
    functions: arr(obj({
      id: 'string', pieces: { or: ['string[]', oneOf('*')] }, hpScale: 'number', 'carriesFlow?': 'boolean',
      'produce?': 'number', 'demand?': 'number', 'priority?': oneOf(1, 2, 3), 'loss?': 'number', 'thrust?': 'number', 'boost?': 'number',
      'boostDrain?': 'number', 'fireInterval?': 'number', 'capacity?': 'number', 'jumpCapacity?': 'number',
      'range?': 'number', 'weapon?': 'string', 'shield?': 'number', 'store?': 'number', 'pool?': oneOf('drive', 'weapon'), 'discharge?': 'number', 'bank?': 'boolean', 'legacy?': 'boolean',
    })),
  }),
  // Player models (written by scripts/econ/models.mjs): functions with their own pieces, material, tier and unlock level
  'ships/models.json': strict({
    '_comment?': 'string', 'legacy?': rec('string'),
    models: arr(obj({
      id: 'string', pieces: 'string[]', hpScale: 'number', model: 'boolean', family: 'string', material: 'string', grade: oneOf(1, 2, 3, 4, 5), points: 'number',
      'unlock?': strict({ level: 'number' }), 'weaponMods?': 'any', 'rated?': 'number', 'blast?': obj({ radius: 'number', damage: 'number', delayTicks: 'number[]' }),
      'produce?': 'number', 'demand?': 'number', 'priority?': oneOf(1, 2, 3), 'thrust?': 'number', 'boost?': 'number', 'boostDrain?': 'number',
      'fireInterval?': 'number', 'capacity?': 'number', 'jumpCapacity?': 'number', 'range?': 'number', 'weapon?': 'string', 'shield?': 'number',
      'store?': 'number', 'pool?': oneOf('drive', 'weapon'), 'discharge?': 'number', 'bank?': 'boolean', 'dynamo?': 'number', 'armour?': 'number', 'massScale?': 'number', 'mount?': oneOf('fixed', 'turret'),
      'mounting?': strict({ 'attach?': oneOf('back', 'any'), 'angle?': oneOf('straight', 'right'), 'arc?': 'number', 'clear?': 'any' }),
    })),
  }),
  'ships/materials.json': strict({
    materials: arr(strict({ id: 'string', 'name?': 'string', 'exclusive?': 'string', 'grade?': 'number', 'output?': 'number', color: 'string', density: 'number', toughness: 'number',
      'traits?': (v, path, c) => { check(c, 'string[]', v, path); for (const t of list(v)) if (typeof t === 'string' && !(t in MATERIAL_TRAITS)) c.warn(path, `"${t}" is not a known trait (${Object.keys(MATERIAL_TRAITS).join(', ')})`); },
      'hazards?': (v, path, c) => { check(c, rec('number'), v, path); for (const k of Object.keys(isObj(v) ? v : {})) if (!(HAZARDS as readonly string[]).includes(k)) c.err(join(path, k), `not a hazard (${HAZARDS.join(', ')})`); },
      'insulation?': (v, path, c) => { check(c, 'number', v, path); if (typeof v === 'number' && (v < 0 || v >= 1)) c.err(path, 'a share of cold kept out: 0 to under 1'); },
      'resist?': (v, path, c) => { check(c, rec('number'), v, path); for (const k of Object.keys(isObj(v) ? v : {})) if (!(DAMAGE_TYPES as readonly string[]).includes(k)) c.err(join(path, k), `not a damage type (${DAMAGE_TYPES.join(', ')})`); } })),
  }),
  'ships/pieces.json': strict({
    catalogVersion: 'number',
    pieces: arr(strict({ id: 'string', tier: 'number', cells: 'any', outline: 'any', connectors: 'any', 'contact?': 'number' })),
  }),
  'ships/inventory.json': strict({ pieces: rec('number'), materials: 'string[]' }),
  'ships/tuning.json': strict({
    cellSize: 'number', overlapShrink: 'number', arcSegmentsPerQuarter: 'number', maxParts: 'number', hpBandSize: 'number',
    health: obj({ floor: 'number', slope: 'number' }), flow: obj({ minWeaponSatisfaction: 'number' }),
    flight: obj({ coreManeuverForce: 'number', gyroTorque: 'number', thrusterTorqueGain: 'number', turnKp: 'number', turnKd: 'number', maxAngularSpeed: 'number', helmTurnGain: 'number' }),
    'jump?': strict({
      'chargeTicks?': 'number', 'burnTicks?': 'number', 'cooldownTicks?': 'number', 'speed?': 'number', 'exitSpeed?': 'number', 'rampTicks?': 'number',
      'slowTicks?': 'number', 'chargeDamping?': 'number', 'baseRange?': 'number', 'minRange?': 'number', 'solarRing?': 'number', 'solarRangeBoost?': 'number',
      'solarCharge?': 'number', 'lodestoneName?': 'string', 'lodestoneShort?': 'string', 'lodestoneField?': 'number', 'lodestoneCharge?': 'number',
      'lodestoneRangeBoost?': 'number', 'lodestonePrimeTicks?': 'number', 'lodestoneSize?': 'number', 'lodestoneScarredCharge?': 'number',
      'lodestoneScarredBoost?': 'number', '_comment?': 'string',
      'coreCapacity?': 'number', 'gradeCapacity?': 'number', 'gradeRange?': 'number', 'gradeCooldown?': 'number', 'overRange?': 'number', 'overRangeMax?': 'number',
      'overCooldown?': 'number', 'cooldownFloor?': 'number', 'minCooldownTicks?': 'number', 'underRange?': 'number', 'underRangeFloor?': 'number',
      'underCooldown?': 'number', 'underCooldownCap?': 'number',
    }), 'fixedGun?': obj({ gimbalDeg: 'number', 'beamGimbalDeg?': 'number', fireToleranceDeg: 'number' }),
    'weapons?': rec((v, path, c) => {
      if (!isObj(v)) { c.err(path, `expected a weapon, got ${typeName(v)}`); return; }
      // (A pulse laser: damage a pulse, and its pulse's length and peak: common/src/ships/pulse.ts)
      if (v.type === 'beam' && v.pulse !== undefined) check(c, obj({ type: 'string', range: 'number', damage: 'number', pulse: strict({ ticks: 'number', peakAt: 'number' }), 'falloff?': strict({ start: 'number', floor: 'number' }) }), v, path);
      else if (v.type === 'beam') check(c, obj({ type: 'string', range: 'number', dps: 'number' }), v, path);
      else if (v.type === 'projectile') check(c, obj({ type: 'string', speed: 'number', damage: 'number', life: 'number', 'split?': obj({ count: 'number', arc: 'number', kind: 'string' }) }), v, path);
      else c.err(join(path, 'type'), `expected "projectile" or "beam", got ${JSON.stringify(v.type)}`);
    }),
    // One gun's changes (a gem's: launch.ts moddedDef) for each grade, Mk I to V (null: none)
    'weaponGrades?': rec((v, path, c) => {
      if (!Array.isArray(v) || v.length !== 5) { c.err(path, `expected 5 entries (Mk I-V), got ${typeName(v)}`); return; }
      v.forEach((m, i) => {
        if (m === null) return;
        check(c, strict({ 'mul?': rec('number'), 'add?': rec('number'), 'set?': 'any' }), m, join(path, i));
        for (const k of Object.keys(isObj(m) && isObj(m.mul) ? m.mul : {})) if (!(WEAPON_MOD_NUMBERS as string[]).includes(k)) c.err(join(join(path, i), `mul.${k}`), `not a weapon number (${WEAPON_MOD_NUMBERS.join(', ')})`);
      });
    }),
    'shield?': obj({ regenDelayTicks: 'number', regenPerSecond: 'number', maxPerArea: 'number' }),
    'energy?': 'any',
    'miner?': obj({ range: 'number', dps: 'number', shipDps: 'number', gimbalDeg: 'number' }),
    turret: obj({ halfArcDeg: 'number', sampleDeg: 'number', slewRate: 'number', fireToleranceDeg: 'number', barrelMargin: 'number' }),
    debris: obj({ lifetimeTicks: 'number', pushSpeed: 'number', pushSpin: 'number' }),
    'partBlast?': rec(obj({ radius: 'number', damage: 'number', delayTicks: 'number[]' })),
    'repair?': obj({ range: 'number', healPerSecond: 'number', restoreTicks: 'number', restoreHp: 'number', intervalTicks: 'number', combatPauseTicks: 'number' }),
    collision: obj({ restitution: 'number', minDamageSpeed: 'number', damagePerSpeed: 'number' }),
    'damage?': obj({ penetration: rec('number') }),
    debug: 'any', fixtures: 'any',
  }),
};

const blueprintSpec = obj({ name: 'string', catalogVersion: 'number', parts: arr(obj({ uid: 'number', piece: 'string', fn: 'string', material: 'string', x: 'number', y: 'number' })) });

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Safe accessors for the cross-reference pass (shape errors are already reported) */
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const entries = (v: unknown): [string, any][] => (isObj(v) ? Object.entries(v).filter(([k]) => !k.startsWith('_')) : []);
const keysOf = (v: unknown): string[] => entries(v).map(([k]) => k);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Closest id (edit distance ≤ 2), for "did you mean" */
function closest(id: string, ids: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const cand of ids) {
    if (Math.abs(cand.length - id.length) >= bestD) continue;
    const d = editDistance(id, cand, bestD);
    if (d < bestD) { bestD = d; best = cand; }
  }
  return best;
}

function editDistance(a: string, b: string, cap: number): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin >= cap) return cap;
    prev = cur;
  }
  return prev[b.length];
}

export function validateGameData(files: GameDataFiles, opts: ValidateOptions = {}): DataProblem[] {
  const c = new Ctx();
  const f = files as unknown as Record<string, any>;
  const ships = opts.ships;

  // ---- Pass 1: shapes ----
  const FILE_KEYS: Record<string, string> = {
    items: 'items.json', recipes: 'recipes.json', mining: 'mining.json', factions: 'factions.json', bosses: 'bosses.json',
    systems: 'systems.json', stations: 'stations.json', quests: 'quests.json',
    people: 'people.json', codex: 'codex.json', achievements: 'achievements.json', unlocks: 'unlocks.json', hazards: 'hazards.json', gems: 'gems.json', station: 'station.json',
  };
  const OPTIONAL = new Set(['bosses', 'people', 'codex', 'achievements', 'unlocks', 'hazards', 'gems', 'station']);
  for (const [key, file] of Object.entries(FILE_KEYS)) {
    c.file = file;
    if (f[key] === undefined) { if (!OPTIONAL.has(key)) c.err('', 'file missing'); continue; }
    check(c, SHAPES[file], f[key], '');
  }
  if (ships) {
    const shipFiles: Record<string, unknown> = {
      'ships/functions.json': ships.catalog.functions, 'ships/models.json': ships.catalog.models, 'ships/materials.json': ships.catalog.materials, 'ships/pieces.json': ships.catalog.pieces,
      'ships/tuning.json': ships.tuning, 'ships/inventory.json': ships.inventory,
    };
    for (const [file, v] of Object.entries(shipFiles)) {
      c.file = file;
      if (v !== undefined) check(c, SHIP_SHAPES[file], v, '');
    }
    for (const [name, bp] of Object.entries(ships.library ?? {})) { c.file = `ships/blueprints/${name}.json`; check(c, blueprintSpec, bp, ''); }
    for (const [name, bp] of Object.entries(ships.enemies ?? {})) { c.file = `ships/blueprints/enemy/${name}.json`; check(c, blueprintSpec, bp, ''); }
  }

  // ---- Indexes ----
  const index = (file: string, rows: any[], path: string): Map<string, any> => {
    const m = new Map<string, any>();
    rows.forEach((r, i) => {
      const id = str(r?.id);
      if (!id) return;
      if (m.has(id)) c.err(`${path}[${i}].id`, `duplicate id "${id}"`, file);
      m.set(id, r);
    });
    return m;
  };
  const systems = index('systems.json', list(f.systems?.systems), 'systems');
  const stations = index('stations.json', list(f.stations?.stations), 'stations');
  const quests = index('quests.json', list(f.quests?.quests), 'quests');
  const people = index('people.json', list(f.people?.people), 'people');
  const records = index('codex.json', list(f.codex?.entries), 'entries');
  const itemRows = index('items.json', list(f.items?.items), 'items');
  const craftRecipes = index('recipes.json', list(f.recipes?.craft), 'craft');
  index('recipes.json', list(f.recipes?.refining), 'refining');
  index('achievements.json', list(f.achievements?.ribbons), 'ribbons');
  const bosses = new Map(entries(f.bosses?.bosses));
  const factions = new Map(entries(f.factions?.factions));
  const reputations = new Set(keysOf(f.quests?.reputations));
  const restricted = entries(f.quests?.restricted);
  const licences = new Set(restricted.map(([sys, r]) => str(r?.licence) ?? sys));
  const stationDefence = new Set(keysOf(f.factions?.rules?.stationDefence));

  // (The models are functions too)
  const fnRows = ships ? [...list(ships.catalog.functions?.functions), ...list(ships.catalog.models?.models)] : [];
  const functions = index('ships/functions.json', fnRows, 'functions');
  const materials = index('ships/materials.json', ships ? list(ships.catalog.materials?.materials) : [], 'materials');
  // (Designs' own bespoke pieces too: enemy designs use them)
  const pieces = index('ships/pieces.json', ships ? [...list(ships.catalog.pieces?.pieces), ...(ships.catalog.bespoke ?? []).flatMap((b) => list(b?.pieces))] : [], 'pieces');
  const weaponKinds = new Set(keysOf(ships?.tuning?.weapons));
  const library = new Set(Object.keys(ships?.library ?? {}));
  const designs = new Set(Object.keys(ships?.enemies ?? {}));
  // Built in, or made from a mix in mining.json (econ/rocks.ts)
  const asteroidFields = new Set([...DEFAULT_ASTEROID_FIELDS.map((a) => a.id), ...entries(f.mining?.fields).map(([id]) => id)]);
  const asteroidTypes = new Set([...DEFAULT_ASTEROIDS.map((a) => a.id), ...entries(f.mining?.types).filter(([, t]) => t?.name && t?.size).map(([id]) => id)]);

  // ---- Reference helpers ----
  const ref = (file: string, path: string, what: string, ids: { has(id: string): boolean; keys?(): Iterable<string> } & Iterable<any>, id: unknown, level: 'error' | 'warning' = 'error'): boolean => {
    if (typeof id !== 'string') return false;
    if (ids.has(id)) return true;
    const pool = ids instanceof Map ? ids.keys() : (ids as Iterable<string>);
    const near = closest(id, pool);
    const msg = `unknown ${what} "${id}"${near ? ` (did you mean "${near}"?)` : ''}`;
    if (level === 'error') c.err(path, msg, file); else c.warn(path, msg, file);
    return false;
  };
  const sys = (file: string, path: string, id: unknown) => ref(file, path, 'system', systems, id);
  const station = (file: string, path: string, id: unknown) => ref(file, path, 'station', stations, id);
  const quest = (file: string, path: string, id: unknown) => ref(file, path, 'quest', quests, id);
  const person = (file: string, path: string, id: unknown) => ref(file, path, 'person', people, id);
  const faction = (file: string, path: string, id: unknown) => ref(file, path, 'faction', factions, id);
  const record = (file: string, path: string, id: unknown) => ref(file, path, 'record (codex.json)', records, id);
  const design = (file: string, path: string, id: unknown) => ships && ref(file, path, 'enemy design (ships/blueprints/enemy)', designs, id);
  const plan = (file: string, path: string, id: unknown) => ships && ref(file, path, 'ship plan (ships/blueprints)', library, id);
  const weaponKind = (file: string, path: string, id: unknown) => ships && ref(file, path, 'weapon kind (ships/tuning.json weapons)', weaponKinds, id);
  const fn = (file: string, path: string, id: unknown) => ships && ref(file, path, 'part function (ships/functions.json)', functions, id);
  const material = (file: string, path: string, id: unknown) => ships && ref(file, path, 'material (ships/materials.json)', materials, id);
  const piece = (file: string, path: string, id: unknown) => ships && ref(file, path, 'piece (ships/pieces.json)', pieces, id);

  /** Items: listed, or a generated part (part:<material>:<fn>:<piece>) or plan (plan:<file>) */
  const item = (file: string, path: string, id: unknown): void => {
    if (typeof id !== 'string' || itemRows.has(id)) return;
    if (id.startsWith('plan:')) { if (ships) ref(file, path, 'ship plan (ships/blueprints) in item', library, id.slice(5)); return; }
    if (id.startsWith('part:')) {
      const p = parsePartItemId(id);
      if (!p) { c.err(path, `malformed part id "${id}" (part:<material>:<fn>:<piece>)`, file); return; }
      if (!ships) return;
      const okM = material(file, path, p.material), okF = fn(file, path, p.fn), okP = piece(file, path, p.piece);
      const fd = functions.get(p.fn);
      if (okM && okF && okP && Array.isArray(fd?.pieces) && !fd.pieces.includes(p.piece)) c.err(path, `part "${id}": ${p.fn} can't be made as a ${p.piece}`, file);
      return;
    }
    ref(file, path, 'item', itemRows, id);
  };
  const bag = (file: string, path: string, b: unknown) => { for (const [k] of entries(b)) item(file, join(path, k), k); };
  /** Fabrication licences: material:<id>, fn:<id>, or a fabricator recipe id */
  const licence = (file: string, path: string, id: unknown): void => {
    if (typeof id !== 'string') return;
    if (id.startsWith('material:')) { material(file, path, id.slice(9)); return; }
    if (id.startsWith('fn:')) { fn(file, path, id.slice(3)); return; }
    ref(file, path, 'fabricator recipe / licence (material:<id>, fn:<id> or a recipes.json craft id)', craftRecipes, id);
  };

  // Conditions and lines (people, quest offers, step `after` lines)
  const cond = (file: string, path: string, x: any): void => {
    if (!isObj(x)) return;
    if ('done' in x) quest(file, join(path, 'done'), x.done);
    else if ('active' in x) quest(file, join(path, 'active'), x.active);
    else if ('known' in x) quest(file, join(path, 'known'), x.known);
    else if ('step' in x && Array.isArray(x.step)) {
      if (quest(file, join(path, 'step'), x.step[0])) {
        const n = list(quests.get(x.step[0]).steps).length;
        if (typeof x.step[1] === 'number' && (x.step[1] < 0 || x.step[1] >= n)) c.err(join(path, 'step'), `quest "${x.step[0]}" has no step ${x.step[1]} (it has ${n}, numbered from 0)`, file);
      }
    } else if ('has' in x) bag(file, join(path, 'has'), x.has);
    else if ('boss' in x) ref(file, join(path, 'boss'), 'boss', bosses, x.boss);
    else if ('mined' in x) item(file, join(path, 'mined'), x.mined);
    else if ('visit' in x) { if (typeof x.visit === 'string' && !systems.has(x.visit) && !stations.has(x.visit)) ref(file, join(path, 'visit'), 'system or station', new Map([...systems, ...stations]), x.visit); }
    else if ('kills' in x && isObj(x.kills) && x.kills.of !== undefined) faction(file, join(path, 'kills.of'), x.kills.of);
    else if ('rep' in x) for (const [k] of entries(x.rep)) ref(file, join(path, `rep.${k}`), 'reputation (quests.json reputations)', reputations, k);
    else if ('not' in x) cond(file, join(path, 'not'), x.not);
    else if ('all' in x) list(x.all).forEach((y, i) => cond(file, join(join(path, 'all'), i), y));
    else if ('any' in x) list(x.any).forEach((y, i) => cond(file, join(join(path, 'any'), i), y));
  };
  const lines = (file: string, path: string, ls: unknown): void => {
    list(ls).forEach((l, i) => {
      const p = join(path, i);
      if (!isObj(l)) return;
      if ('choices' in l) list(l.choices).forEach((ch, j) => { cond(file, join(join(join(p, 'choices'), j), 'if'), ch?.if); lines(file, join(join(join(p, 'choices'), j), 'then'), ch?.then); });
      else if ('if' in l) { cond(file, join(p, 'if'), l.if); lines(file, join(p, 'then'), l.then); lines(file, join(p, 'else'), l.else); }
      else if ('offer' in l) quest(file, join(p, 'offer'), l.offer);
      else if ('reveal' in l) quest(file, join(p, 'reveal'), l.reveal);
      else if ('give' in l) bag(file, join(p, 'give'), l.give);
      else if ('codex' in l) record(file, join(p, 'codex'), l.codex);
    });
  };
  const place = (file: string, path: string, at: any): void => {
    if (!isObj(at)) return;
    if ('station' in at) station(file, join(path, 'station'), at.station);
    else sys(file, join(path, 'system'), at.system);
  };

  // ---- Pass 2: cross-references ----

  // systems.json
  {
    const F = 'systems.json';
    const listedStations = new Map<string, string>();
    const lodestoneIds = new Set<string>();
    const nestIds = new Set<string>();
    list(f.systems?.systems).forEach((s, i) => {
      const P = `systems[${i}]`;
      list(s?.portals).forEach((g, j) => sys(F, `${P}.portals[${j}].targetSystem`, g?.targetSystem));
      list(s?.rifts).forEach((r, j) => sys(F, `${P}.rifts[${j}].destination.system`, r?.destination?.system));
      list(s?.stations).forEach((id, j) => {
        const p = `${P}.stations[${j}]`;
        if (!station(F, p, id)) return;
        if (listedStations.has(id)) c.err(p, `station "${id}" is also listed by system "${listedStations.get(id)}"`, F);
        listedStations.set(id, s.id);
        const st = stations.get(id);
        if (st.system !== s.id) c.err(p, `station "${id}" says it is in "${st.system}" but is listed (and spawned) here in "${s.id}"`, F);
      });
      if (s?.asteroidField !== undefined) ref(F, `${P}.asteroidField`, 'asteroid field (DEFAULT_ASTEROID_FIELDS)', asteroidFields, s.asteroidField);
      list(s?.asteroidBelt?.extra).forEach((b, k) => { if (b?.field !== undefined) ref(F, `${P}.asteroidBelt.extra[${k}].field`, 'asteroid field (DEFAULT_ASTEROID_FIELDS)', asteroidFields, b.field); });
      const sf = s?.surface;
      if (isObj(sf)) {
        if (sys(F, `${P}.surface.of`, sf.of)) {
          const planet = list(systems.get(sf.of).planets).find((p) => p?.id === sf.planet);
          if (!planet) c.err(`${P}.surface.planet`, `system "${sf.of}" has no planet "${sf.planet}"`, F);
          else if (typeof sf.moon === 'number' && !list(planet.moons)[sf.moon]) c.err(`${P}.surface.moon`, `planet "${sf.planet}" has no moon ${sf.moon}`, F);
        }
        if (isObj(sf.siege) && sf.siege.faction !== undefined) faction(F, `${P}.surface.siege.faction`, sf.siege.faction);
        if (sf.arena && !s.instance) c.warn(`${P}.surface.arena`, 'an arena with no `instance` slots: every party shares one copy', F);
        // (a cave: its mouth is on another surface)
        if (isObj(sf.under) && sys(F, `${P}.surface.under.surface`, sf.under.surface) && !isObj(systems.get(sf.under.surface).surface)) c.err(`${P}.surface.under.surface`, `"${sf.under.surface}" is not a surface`, F);
      }
      // A pocket: its way in is out in another system (not a surface, not another pocket), and where you arrive is inside its edge
      const pk = s?.pocket;
      if (isObj(pk) && isObj(pk.entrance)) {
        if (sys(F, `${P}.pocket.entrance.system`, pk.entrance.system) && (systems.get(pk.entrance.system).surface || systems.get(pk.entrance.system).pocket)) c.err(`${P}.pocket.entrance.system`, `"${pk.entrance.system}" is a surface or a pocket: a pocket's way in is out in space`, F);
        if (isObj(pk.entrance.look)) faction(F, `${P}.pocket.entrance.look.faction`, pk.entrance.look.faction);
        if (s.surface) c.err(`${P}.pocket`, 'a system is a surface or a pocket, not both', F);
        if (isObj(pk.landing) && typeof pk.radius === 'number' && Math.hypot(pk.landing.x, pk.landing.y) >= pk.radius) c.err(`${P}.pocket.landing`, `outside its edge (radius ${pk.radius}): you'd be sent straight back out`, F);
      }
      list(s?.planets).forEach((pl, j) => {
        const pp = `${P}.planets[${j}]`;
        const target = (id: unknown, path: string, moon?: number) => {
          if (!sys(F, path, id)) return;
          const t = systems.get(id as string).surface;
          if (!isObj(t)) c.err(path, `system "${id}" is not a surface`, F);
          else if (t.of !== s.id || t.planet !== pl.id || (moon !== undefined && t.moon !== moon)) c.warn(path, `surface "${id}" says it belongs to ${t.of}/${t.planet}${t.moon !== undefined ? ` moon ${t.moon}` : ''}`, F);
        };
        if (pl?.surface !== undefined) target(pl.surface, `${pp}.surface`);
        list(pl?.moons).forEach((m, k) => { if (m?.surface !== undefined) target(m.surface, `${pp}.moons[${k}].surface`, k); });
      });
      list(s?.derelicts).forEach((d, j) => {
        plan(F, `${P}.derelicts[${j}].blueprint`, d?.blueprint);
        if (isObj(d?.log)) record(F, `${P}.derelicts[${j}].log.codex`, d.log.codex);
      });
      // Stillstones (`lodestones`): orbiting or fixed (not both); a camp's spot zone has to sit on a fixed one (packs don't follow an orbit)
      list(s?.lodestones).forEach((l, j) => {
        const lp = `${P}.lodestones[${j}]`;
        if (!isObj(l)) return;
        if (typeof l.id === 'string') { if (lodestoneIds.has(l.id)) c.err(`${lp}.id`, `duplicate lodestone id "${l.id}"`, F); lodestoneIds.add(l.id); }
        if ((l.orbit === undefined) === (l.position === undefined)) c.err(lp, 'a lodestone needs exactly one of `orbit` or `position`', F);
        if (l.scar !== undefined && l.state !== 'scarred') c.err(`${lp}.scar`, 'only a scarred stillstone has a `scar`', F);
        if (l.size !== undefined && !(typeof l.size === 'number' && l.size > 0)) c.err(`${lp}.size`, 'a stillstone needs a size over 0', F);
        if (l.zone === undefined) return;
        const z = list(s.zones).find((q) => q?.id === l.zone);
        if (!z) c.err(`${lp}.zone`, `"${l.zone}" isn't one of this system's zones`, F);
        else if (l.orbit !== undefined) c.err(`${lp}.zone`, 'an orbiting lodestone leaves its spot zone behind: give it a fixed `position`', F);
        else if (z.x !== l.position?.x || z.y !== l.position?.y) c.err(`${lp}.zone`, `zone "${l.zone}" isn't centred on it (it's at ${z.x}, ${z.y})`, F);
      });
      // Nests: whose, and what they circle (a planet of this system, or one of its moons)
      list(s?.nests).forEach((n, j) => {
        const np = `${P}.nests[${j}]`;
        if (!isObj(n)) return;
        if (typeof n.id === 'string') { if (nestIds.has(n.id)) c.err(`${np}.id`, `duplicate nest id "${n.id}"`, F); nestIds.add(n.id); }
        faction(F, `${np}.faction`, n.faction);
        const pl = n.around !== undefined ? list(s.planets).find((q) => q?.id === n.around) : undefined;
        if (n.around !== undefined && !pl) c.err(`${np}.around`, `"${n.around}" isn't one of this system's planets`, F);
        if (n.moon !== undefined && (n.around === undefined || (pl && !list(pl.moons)[n.moon]))) c.err(`${np}.moon`, n.around === undefined ? 'a moon needs `around` (its planet)' : `${n.around} has no moon ${n.moon}`, F);
      });
      list(s?.traffic).forEach((t, j) => {
        plan(F, `${P}.traffic[${j}].blueprint`, t?.blueprint);
        list(t?.route).forEach((id, k) => {
          const p = `${P}.traffic[${j}].route[${k}]`;
          if (station(F, p, id) && !list(s.stations).includes(id)) c.err(p, `station "${id}" isn't in "${s.id}" (traffic only flies between this system's stations)`, F);
        });
      });
    });
    list(f.stations?.stations).forEach((st, i) => {
      if (!sys('stations.json', `stations[${i}].system`, st?.system)) return;
      // (A private system's dock is spawned with each copy, not listed)
      if (typeof st.id === 'string' && !listedStations.has(st.id) && !list(f.systems?.systems).some((s) => s?.id === st.system && s?.private)) c.warn(`stations[${i}]`, `station "${st.id}" is not listed in any system's stations, so it is never spawned`, 'stations.json');
    });
  }

  // stations.json
  list(f.stations?.stations).forEach((st, i) => {
    const F = 'stations.json', P = `stations[${i}]`;
    list(st?.market?.sells).forEach((id, j) => item(F, `${P}.market.sells[${j}]`, id));
    bag(F, `${P}.market.demand`, st?.market?.demand);
    if (isObj(st?.defence)) ref(F, `${P}.defence.weapon`, 'station turret weapon (factions.json rules.stationDefence)', stationDefence, st.defence.weapon);
  });

  // items.json
  list(f.items?.items).forEach((it, i) => {
    const F = 'items.json', P = `items[${i}]`;
    if (it?.plan !== undefined) plan(F, `${P}.plan`, it.plan);
    if (it?.quest !== undefined) quest(F, `${P}.quest`, it.quest);
    if (it?.codex !== undefined) record(F, `${P}.codex`, it.codex);
    if (isObj(it?.part)) { material(F, `${P}.part.material`, it.part.material); fn(F, `${P}.part.fn`, it.part.fn); piece(F, `${P}.part.piece`, it.part.piece); }
  });

  // recipes.json
  {
    const F = 'recipes.json';
    const r = f.recipes;
    list(r?.refining).forEach((x, i) => { item(F, `refining[${i}].id`, x?.id); bag(F, `refining[${i}].inputs`, x?.inputs); });
    list(r?.craft).forEach((x, i) => {
      bag(F, `craft[${i}].out`, x?.out);
      bag(F, `craft[${i}].inputs`, x?.inputs);
      if (x?.quest !== undefined) quest(F, `craft[${i}].quest`, x.quest);
      // Nothing opens early: a recipe that isn't a starter opens at a level (a job's kit too)
      if (!x?.starter && typeof x?.level !== 'number') c.err(`craft[${i}].level`, `"${x?.id}" isn't a starter, so it needs the level it opens at`, F);
    });
    for (const [m, plate] of entries(r?.parts?.plates)) { material(F, `parts.plates.${m}`, m); item(F, `parts.plates.${m}`, plate); }
    for (const [fid, extra] of entries(r?.parts?.extras)) {
      fn(F, `parts.extras.${fid}`, fid);
      for (const [id] of entries(extra)) if (id !== 'plate') item(F, `parts.extras.${fid}.${id}`, id);
    }
    for (const [mid, mr] of entries(r?.models)) {
      if (fn(F, `models.${mid}`, mid) && !functions.get(mid)?.model) c.err(`models.${mid}`, `"${mid}" isn't a model (ships/models.json)`, F);
      bag(F, `models.${mid}.inputs`, mr?.inputs);
    }
    if (ships) for (const m of list(ships.catalog.models?.models)) if (typeof m?.id === 'string' && !isObj(r?.models?.[m.id])) c.err(`models`, `model "${m.id}" has no recipe (scripts/econ/models.mjs)`, F);
  }

  // mining.json
  {
    const F = 'mining.json';
    const m = f.mining;
    for (const [t, def] of entries(m?.types)) {
      ref(F, `types.${t}`, 'asteroid type (DEFAULT_ASTEROIDS)', asteroidTypes, t, 'warning');
      bag(F, `types.${t}.ores`, def?.ores);
    }
    bag(F, 'oreHardness', m?.oreHardness);
    for (const [t, def] of entries(m?.types)) if (def?.like !== undefined) ref(F, `types.${t}.like`, 'asteroid type', asteroidTypes, def.like);
    for (const [fid, mix] of entries(m?.fields)) {
      for (const [t] of entries(mix)) ref(F, `fields.${fid}.${t}`, 'asteroid type', asteroidTypes, t);
    }
    for (const [d, def] of entries(m?.danger)) bag(F, `danger.${d}.boost`, def?.boost);
    list(m?.seams).forEach((s, i) => item(F, `seams[${i}].gem`, s?.gem));
    for (const [t, g] of entries(f.gems?.types)) {
      item('gems.json', `types.${t}.material`, g?.material);
      for (const lv of keysOf(g?.levels)) item('gems.json', `types.${t}.levels.${lv}`, `gem_${t}_${lv}`);
    }
    for (const [lv, cut] of entries(f.gems?.cuts)) bag('gems.json', `cuts.${lv}.inputs`, cut?.inputs);
    bag('station.json', 'charter.items', f.station?.charter?.items);
    list(f.station?.sites).forEach((s, i) => station('station.json', `sites[${i}].station`, s?.station));
    for (const [t, def] of entries(f.station?.tracks)) list(def?.tiers).forEach((r, i) => bag('station.json', `tracks.${t}.tiers[${i}].cost`, r?.cost));
    for (const [k, w] of entries(ships?.tuning?.weapons)) if ((w as any)?.ammo) item('ships/tuning.json', `weapons.${k}.ammo.item`, (w as any).ammo.item);
    for (const [t, def] of entries(m?.traces)) {
      item(F, `traces.${t}`, t);
      list(def?.from).forEach((o, i) => item(F, `traces.${t}.from[${i}]`, o));
    }
    for (const [k] of entries(m?.tools)) {
      if (['fixed', 'turret', 'miner', 'siphon', 'minerByMaterial'].includes(k)) continue;
      if (ships && !weaponKinds.has(k)) c.warn(`tools.${k}`, `"${k}" is not a weapon kind, so nothing uses this tool`, F);
    }
    for (const [k] of entries(m?.tools?.minerByMaterial)) material(F, `tools.minerByMaterial.${k}`, k);
  }

  // factions.json
  {
    const F = 'factions.json';
    const fx = f.factions;
    for (const [id, def] of entries(fx?.factions)) {
      for (const [ship] of entries(def?.ships)) design(F, `factions.${id}.ships.${ship}`, ship);
      list(def?.loot).forEach((l, i) => item(F, `factions.${id}.loot[${i}].item`, l?.item));
    }
    const groups = (path: string, gs: unknown) => list(gs).forEach((g, i) => {
      const p = `${path}[${i}]`;
      const okF = faction(F, `${p}.faction`, g?.faction);
      list(g?.ships).forEach((ship, j) => {
        if (!design(F, `${p}.ships[${j}]`, ship) && ships) return;
        if (okF && typeof ship === 'string' && !isObj(factions.get(g.faction)?.ships?.[ship])) c.warn(`${p}.ships[${j}]`, `"${ship}" isn't in faction "${g.faction}"'s ships table: its kills pay nothing`, F);
      });
    });
    for (const [sid, sp] of entries(fx?.spawns)) {
      sys(F, `spawns.${sid}`, sid);
      if (sp?.grade !== undefined && (typeof sp.grade !== 'number' || sp.grade < 1 || sp.grade > 5)) c.err(`spawns.${sid}.grade`, 'grade is Mk I-V (1..5)', F);
      groups(`spawns.${sid}.groups`, sp?.groups);
      list(sp?.zones).forEach((z, i) => groups(`spawns.${sid}.zones[${i}].groups`, z?.groups));
      groups(`spawns.${sid}.events.warband.groups`, sp?.events?.warband?.groups);
      if (isObj(sp?.events?.peak)) {
        groups(`spawns.${sid}.events.peak.flock`, [sp.events.peak.flock]);
        list(sp.events.peak.goods).forEach((g, k) => item(F, `spawns.${sid}.events.peak.goods[${k}]`, g));
      }
      const zoneIds = new Set(list(sp?.zones).map((z) => z?.id));
      for (const k of ['raidZone', 'salvageZone'] as const) if (sp?.events?.[k] !== undefined && !zoneIds.has(sp.events[k])) c.err(`spawns.${sid}.events.${k}`, `"${sp.events[k]}" isn't one of this system's zones`, F);
      if (sp?.events?.warband && !zoneIds.has(sp.events.warband.zone)) c.err(`spawns.${sid}.events.warband.zone`, `"${sp.events.warband.zone}" isn't one of this system's zones`, F);
      list(sp?.events?.raidStations).forEach((st, k) => station(F, `spawns.${sid}.events.raidStations[${k}]`, st));
      // Nests: each one of the system's (systems.json nests), and hostile ones never reaching into its safe space
      const here = systems.get(sid);
      list(sp?.nests).forEach((n, i) => {
        const np = `spawns.${sid}.nests[${i}]`;
        groups(`${np}.groups`, n?.groups);
        const place = list(here?.nests).find((q) => q?.id === n?.id);
        if (!place) { if (here) c.err(`${np}.id`, `"${n?.id}" isn't one of ${sid}'s nests (systems.json)`, F); return; }
        list(n?.groups).forEach((g, k) => { if (g?.faction !== place.faction) c.warn(`${np}.groups[${k}].faction`, `"${g?.faction}" in ${place.faction}'s nest`, F); });
        if (n?.bias !== undefined && !(typeof n.bias === 'number' && n.bias >= 0 && n.bias <= 1)) c.err(`${np}.bias`, 'bias is 0..1 (how hard loose packs are drawn home)', F);
        if (n?.roam !== undefined && !(typeof n.roam === 'number' && n.roam > 600)) c.err(`${np}.roam`, 'roam must be over 600', F);
        const safe = safeRadius(here);
        const hostile = list(n?.groups).some((g) => !g?.passive);
        const leash = n?.leash ?? factions.get(list(n?.groups)[0]?.faction)?.behaviour?.leash ?? 0;
        if (safe > 0 && hostile && isObj(place.orbit) && nestReach(place, list(here?.planets)).min - leash < safe) c.err(np, `its hostiles reach into ${sid}'s safe space (it comes within ${Math.round(nestReach(place, list(here?.planets)).min)}, leash ${leash}, safe to ${safe})`, F);
      });
      for (const place of list(here?.nests)) if (!list(sp?.nests).some((n) => n?.id === place?.id)) c.warn(`spawns.${sid}.nests`, `nest "${place?.id}" has no packs here, so nothing ever launches from it`, F);
    }
    for (const [k] of entries(fx?.rules?.stationDefence)) weaponKind(F, `rules.stationDefence.${k}`, k);
    // A tougher grade never pays less a kill
    const gc = list(fx?.rules?.gradeCredits);
    gc.forEach((k, i) => { if (i > 0 && !(k >= gc[i - 1])) c.err(`rules.gradeCredits[${i}]`, `pays less than the grade below (${k} < ${gc[i - 1]}): kill credits never fall with grade`, F); });
  }

  // bosses.json
  {
    const F = 'bosses.json';
    const arenaBosses = new Set<string>();
    for (const q of quests.values()) for (const s of list(q?.steps)) if (s?.type === 'boss' && s.arena) arenaBosses.add(s.boss);
    for (const [id, b] of entries(f.bosses?.bosses)) {
      const P = `bosses.${id}`;
      faction(F, `${P}.faction`, b?.faction);
      sys(F, `${P}.system`, b?.system);
      design(F, b?.design !== undefined ? `${P}.design` : P, b?.design ?? id);
      list(b?.loot).forEach((l, i) => item(F, `${P}.loot[${i}].item`, l?.item));
      list(b?.phases).forEach((ph, i) => {
        list(ph?.escorts).forEach((e, j) => design(F, `${P}.phases[${i}].escorts[${j}]`, e));
        if (isObj(ph?.nova)) weaponKind(F, `${P}.phases[${i}].nova.kind`, ph.nova.kind);
      });
      if (typeof b?.speed === 'number' && !(b.speed > 0 && b.speed <= MAX_DRIVE)) c.err(`${P}.speed`, `speed is engine output, above 0 and at most ${MAX_DRIVE}`, F);
      if (b?.arena && !arenaBosses.has(id)) c.warn(P, `arena boss "${id}" is fought only in a job's arena, but no quest step fights it there`, F);
      if (b?.arena && systems.has(b.system) && !isObj(systems.get(b.system).surface?.arena)) c.warn(`${P}.system`, `arena boss lives in "${b.system}", which is not an arena`, F);
    }
  }

  // quests.json
  {
    const F = 'quests.json';
    const qf = f.quests;
    list(qf?.quests).forEach((q, i) => {
      const P = `quests[${i}]`;
      if (q?.giver !== undefined) station(F, `${P}.giver`, q.giver);
      if (q?.person !== undefined) person(F, `${P}.person`, q.person);
      list(q?.requires).forEach((r, j) => { if (quest(F, `${P}.requires[${j}]`, r) && r === q.id) c.err(`${P}.requires[${j}]`, 'a quest requires itself', F); });
      for (const [k] of entries(q?.minRep)) ref(F, `${P}.minRep.${k}`, 'reputation (quests.json reputations)', reputations, k);
      lines(F, `${P}.offer`, q?.offer);
      list(q?.onStart?.recipes).forEach((x, j) => licence(F, `${P}.onStart.recipes[${j}]`, x));
      bag(F, `${P}.onStart.items`, q?.onStart?.items);
      list(q?.steps).forEach((s, j) => {
        const S = `${P}.steps[${j}]`;
        if (!isObj(s)) return;
        lines(F, `${S}.after`, s.after);
        switch (s.type) {
          case 'travel': case 'scan': case 'visit': case 'hold': case 'course': sys(F, `${S}.system`, s.system); break;
          case 'recover': sys(F, `${S}.system`, s.system); item(F, `${S}.item`, s.item); break;
          case 'construct': sys(F, `${S}.system`, s.system); list(s.pieces).forEach((pc, k) => item(F, `${S}.pieces[${k}].item`, pc?.item)); break;
          case 'dock': case 'courier': station(F, `${S}.station`, s.station); break;
          case 'mine': case 'loot': case 'refine': if (s.item !== undefined) item(F, `${S}.item`, s.item); break;
          case 'craft':
            if (s.item !== undefined) item(F, `${S}.item`, s.item);
            if (s.teach !== undefined && ref(F, `${S}.teach`, 'fabricator recipe (recipes.json craft)', craftRecipes, s.teach)) {
              const rq = craftRecipes.get(s.teach).quest;
              if (rq !== undefined && rq !== q.id) c.warn(`${S}.teach`, `recipe "${s.teach}" belongs to quest "${rq}"`, F);
            }
            break;
          case 'refit': if (s.fn !== undefined) fn(F, `${S}.fn`, s.fn); if (s.material !== undefined) material(F, `${S}.material`, s.material); break;
          case 'kill':
            if (s.faction !== undefined) faction(F, `${S}.faction`, s.faction);
            if (s.enemy !== undefined) design(F, `${S}.enemy`, s.enemy);
            if (s.system !== undefined) sys(F, `${S}.system`, s.system);
            break;
          case 'deliver': bag(F, `${S}.items`, s.items); break;
          case 'boss':
            if (ref(F, `${S}.boss`, 'boss', bosses, s.boss)) {
              const b = bosses.get(s.boss);
              if (s.arena !== undefined && !b.arena) c.warn(`${S}.boss`, `boss "${s.boss}" is fought in an arena here but isn't marked arena: it also lairs out in the world`, F);
              if (s.arena === undefined && b.arena) c.err(`${S}.boss`, `boss "${s.boss}" is arena-only, so this step needs an arena (it never appears at a lair)`, F);
            }
            if (s.arena !== undefined && sys(F, `${S}.arena`, s.arena) && !isObj(systems.get(s.arena).surface?.arena)) c.err(`${S}.arena`, `system "${s.arena}" is not an arena (needs surface.arena)`, F);
            if (s.arena !== undefined && s.person === undefined) c.err(`${S}.person`, 'an arena boss step needs a person to talk to before the fight', F);
            if (s.person !== undefined) person(F, `${S}.person`, s.person);
            lines(F, `${S}.lines`, s.lines);
            break;
          case 'talk':
            person(F, `${S}.person`, s.person);
            lines(F, `${S}.lines`, s.lines);
            bag(F, `${S}.take`, s.take);
            bag(F, `${S}.give`, s.give);
            break;
          case 'slot': case 'build': case 'fly': plan(F, `${S}.plan`, s.plan); break;
          case 'escort': station(F, `${S}.from`, s.from); station(F, `${S}.to`, s.to); break;
          case 'defend': case 'uplink': station(F, `${S}.near`, s.near); break;
        }
        if (s.type === 'visit') bag(F, `${S}.give`, s.give);
      });
      const r = q?.rewards;
      bag(F, `${P}.rewards.items`, r?.items);
      list(r?.plans).forEach((x, j) => plan(F, `${P}.rewards.plans[${j}]`, x));
      list(r?.recipes).forEach((x, j) => licence(F, `${P}.rewards.recipes[${j}]`, x));
      list(r?.licences).forEach((x, j) => ref(F, `${P}.rewards.licences[${j}]`, 'sector licence (quests.json restricted)', licences, x));
      for (const [k] of entries(r?.reputation)) ref(F, `${P}.rewards.reputation.${k}`, 'reputation (quests.json reputations)', reputations, k);
      list(r?.codex).forEach((x, j) => record(F, `${P}.rewards.codex[${j}]`, x));
    });
    // Requirement cycles: those quests can never be offered
    const state = new Map<string, number>();
    const visit = (id: string, trail: string[]): void => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) { c.err(`quests (${id})`, `requirement cycle: ${[...trail.slice(trail.indexOf(id)), id].join(' -> ')}`, F); return; }
      state.set(id, 1);
      for (const r of list(quests.get(id)?.requires)) if (quests.has(r)) visit(r, [...trail, id]);
      state.set(id, 2);
    };
    for (const id of quests.keys()) visit(id, []);
    for (const [rid, rep] of entries(qf?.reputations)) {
      list(rep?.vendor?.stations).forEach((s, i) => station(F, `reputations.${rid}.vendor.stations[${i}]`, s));
      list(rep?.vendor?.stock).forEach((s, i) => item(F, `reputations.${rid}.vendor.stock[${i}].item`, s?.item));
    }
    for (const [sid] of restricted) sys(F, `restricted.${sid}`, sid);
  }

  // people.json
  list(f.people?.people).forEach((p, i) => {
    const F = 'people.json', P = `people[${i}]`;
    place(F, `${P}.at`, p?.at);
    list(p?.moves).forEach((m, j) => { cond(F, `${P}.moves[${j}].if`, m?.if); place(F, `${P}.moves[${j}].at`, m?.at); });
    if (isObj(p?.craft)) {
      plan(F, `${P}.craft.ship`, p.craft.ship);
      if (isObj(p.at) && 'station' in p.at) c.warn(`${P}.craft`, 'a craft is only parked for people out in space (not at a station)', F);
    }
    if (Array.isArray(p?.greeting) && !p.greeting.length) c.err(`${P}.greeting`, 'needs at least one greeting', F);
    list(p?.topics).forEach((t, j) => {
      cond(F, `${P}.topics[${j}].if`, t?.if);
      if (t?.once && t.id === undefined) c.warn(`${P}.topics[${j}]`, 'a `once` topic needs an `id` to be remembered by', F);
      lines(F, `${P}.topics[${j}].lines`, t?.lines);
    });
  });
  // Every quest someone is offered by talking to them needs that person reachable
  for (const [id, q] of quests) if (q?.person !== undefined && q.giver === undefined && !people.has(q.person)) c.err(`quests (${id})`, `quest "${id}" can only be offered by "${q.person}", who doesn't exist`, 'quests.json');

  // codex.json: what each record waits for
  list(f.codex?.entries).forEach((e, i) => cond('codex.json', `entries[${i}].unlock`, e?.unlock));

  // achievements.json
  list(f.achievements?.ribbons).forEach((r, i) => {
    if (typeof r?.stat === 'string' && !KNOWN_STATS.includes(r.stat) && !r.stat.startsWith('boss:')) c.warn(`ribbons[${i}].stat`, `nothing counts the stat "${r.stat}"`, 'achievements.json');
    if (typeof r?.stat === 'string' && r.stat.startsWith('boss:')) ref('achievements.json', `ribbons[${i}].stat`, 'boss', bosses, r.stat.slice(5));
  });


  // ships
  if (ships) {
    const dict = new Set(DICTIONARY);
    fnRows.forEach((d, i) => {
      const F = 'ships/functions.json', P = `functions[${i}]`;
      if (typeof d?.id !== 'string') return;
      if (!(d.id in FN_NAMES) && typeof d.name !== 'string') c.err(`${P}.id`, `function "${d.id}" has no display name in FN_NAMES (common/src/econ/items.ts)`, F);
      if (!dict.has(d.id)) c.warn(`${P}.id`, `function "${d.id}" is not in the wire DICTIONARY (common/src/network/binaryCodec.ts): sent as a plain string`, F);
      if (Array.isArray(d.pieces)) d.pieces.forEach((pc: unknown, j: number) => piece(F, `${P}.pieces[${j}]`, pc));
      if (d.weapon !== undefined) weaponKind(F, `${P}.weapon`, d.weapon);
    });
    for (const id of materials.keys()) if (!dict.has(id)) c.warn(`materials (${id})`, `material "${id}" is not in the wire DICTIONARY (common/src/network/binaryCodec.ts)`, 'ships/materials.json');
    // (Bespoke pieces go as plain strings: once, with their design)
    for (const [id, p] of pieces) if (!dict.has(id) && !(p as { polygon?: unknown })?.polygon) c.warn(`pieces (${id})`, `piece "${id}" is not in the wire DICTIONARY (common/src/network/binaryCodec.ts)`, 'ships/pieces.json');
    for (const [kind, w] of entries(ships.tuning?.weapons)) {
      const F = 'ships/tuning.json';
      if (w?.type === 'projectile' && !w?.pointDefence && !(kind in WEAPON_KIND_TYPE)) c.err(`weapons.${kind}`, `projectile kind "${kind}" is missing from WEAPON_KIND_TYPE (common/src/ecs/components.ts): clients draw it as a cannon shell`, F);
      if (isObj(w?.split)) weaponKind(F, `weapons.${kind}.split.kind`, w.split.kind);
    }
    for (const [k] of entries(ships.tuning?.weaponGrades)) weaponKind('ships/tuning.json', `weaponGrades.${k}`, k);
    for (const [k] of entries(ships.tuning?.partBlast)) fn('ships/tuning.json', `partBlast.${k}`, k);
    for (const [k] of entries(ships.inventory?.pieces)) piece('ships/inventory.json', `pieces.${k}`, k);
    list(ships.inventory?.materials).forEach((m, i) => material('ships/inventory.json', `materials[${i}]`, m));
    const parts = (file: string, bp: Blueprint) => list(bp?.parts).forEach((p, i) => {
      piece(file, `parts[${i}].piece`, p?.piece);
      fn(file, `parts[${i}].fn`, p?.fn);
      material(file, `parts[${i}].material`, p?.material);
    });
    for (const [name, bp] of Object.entries(ships.library ?? {})) parts(`ships/blueprints/${name}.json`, bp);
    for (const [name, bp] of Object.entries(ships.enemies ?? {})) parts(`ships/blueprints/enemy/${name}.json`, bp);
  }

  return c.problems;
}

/** One problem per line, errors first */
export function formatProblems(problems: DataProblem[]): string {
  return [...problems]
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
    .map((p) => `  ${p.level === 'error' ? 'ERROR' : 'warn '} ${p.file}${p.path ? ` ${p.path}` : ''}: ${p.message}`)
    .join('\n');
}

/**
 * Validate and act on it: in development and tests (NODE_ENV !== 'production')
 * any error throws with the full list; in production (and in a browser, where
 * there's no NODE_ENV) problems are logged and loading carries on.
 */
export function checkGameData(files: GameDataFiles, opts: ValidateOptions = {}): DataProblem[] {
  const problems = validateGameData(files, opts);
  if (!problems.length) return problems;
  const errors = problems.filter((p) => p.level === 'error');
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const strictMode = env !== undefined && env.NODE_ENV !== 'production';
  if (errors.length && strictMode) {
    throw new Error(`Game data has ${errors.length} error(s)${problems.length > errors.length ? ` and ${problems.length - errors.length} warning(s)` : ''}:\n${formatProblems(problems)}`);
  }
  const warnings = problems.length - errors.length;
  if (errors.length || (warnings && !(env?.VITEST))) {
    console.warn(`[GameData] ${errors.length} data error(s), ${warnings} warning(s):\n${formatProblems(problems)}`);
  }
  return problems;
}
