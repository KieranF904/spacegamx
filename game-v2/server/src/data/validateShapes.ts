/**
 * @contract server.data.validate-shapes
 * owns:       the shape pass of load-time data validation: a tiny schema language (Spec) and one spec per data file
 * needs:      @space-game/common (tables, dictionary), game/brains ids; browser-safe: no Node imports
 * invariants: the real data has no shape errors — server/src/data/validateGameData.test.ts
 * extend:     a new data file is a spec in SHAPES (or SHIP_SHAPES), its id wired in validateGameData's FILE_KEYS
 */

import { BRAIN_IDS } from '../game/brains/ids.js';
import {
  WEAPON_MOD_NUMBERS, DAMAGE_TYPES, MINERAL_FAMILIES, MATERIAL_TRAITS, HAZARDS, UNLOCK_KEYS,
  CODEX_TABS, PLANET_LOOK_FIELDS, STAR_PLASMA_FIELDS, } from '@space-game/common';

export interface DataProblem {
  /** The data file, relative to data/ (quests.json, ships/tuning.json, ships/blueprints/enemy/x.json) */
  file: string;
  /** Where in it (quests[3].steps[1].station) */
  path: string;
  message: string;
  level: 'error' | 'warning';
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

export class Ctx {
  readonly problems: DataProblem[] = [];
  file = '';
  err(path: string, message: string, file = this.file): void { this.problems.push({ file, path, message, level: 'error' }); }
  warn(path: string, message: string, file = this.file): void { this.problems.push({ file, path, message, level: 'warning' }); }
}

export const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
export const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v);
export const join = (path: string, k: string | number) => (typeof k === 'number' ? `${path}[${k}]` : path ? `${path}.${k}` : k);

export function check(c: Ctx, spec: Spec, v: unknown, path: string): void {
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

const ITEM_CATEGORIES = ['mineral', 'gem', 'volatile', 'refined', 'component', 'artefact', 'consumable', 'ammo', 'jewel', 'part', 'quest'];
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const STATION_SERVICES = ['repair', 'storage', 'refinery', 'fabricator', 'market', 'shipyard', 'refuel', 'shop', 'bank', 'quests'];
/** Profile stats that something bumps (Pilots.bumpStat callers), plus the two computed ones */
export const KNOWN_STATS = ['kills', 'assists', 'bosses', 'mined', 'quests', 'fleetOps', 'escorts', 'defences', 'crafted', 'refined', 'earned', 'trades', 'salvaged', 'raidsDefended', 'events', 'level', 'systems'];

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

/** Who rolls which loot tables (data/loot.json; common econ/loot.ts DropSpec) */
const dropsSpec = arr(strict({ table: 'string', rolls: 'number' }));
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

export const SHAPES: Record<string, Spec> = {
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
      'volume?': 'number', 'mass?': 'number', 'part?': obj({ material: 'string', fn: 'string', piece: 'string' }), 'quest?': 'string',
      'repair?': obj({ budget: 'number', hpPerSec: 'number', restoreSec: 'number' }),
      // (Material packs: what one is made of, docs/design/field-fabrication.md)
      'pack?': 'bag',
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
  // (Player-facing text: flat dotted keys to text, server/src/data/rules.ts texts())
  'strings.json': rec('string'),
  'mobs.json': strict({
    mobs: rec(strict({
      name: 'string', behaviour: oneOf('kamikaze', 'mine'), hp: 'number', radius: 'number', speed: 'number', accel: 'number', turn: 'number', life: 'number', arm: 'number',
      blast: obj({ fuse: 'number', radius: 'number', damage: 'number' }), shape: arr('number[]'), color: 'string', glow: 'string',
    })),
  }),
  'loot.json': strict({
    tables: rec(strict({
      'kind?': oneOf('always'), 'nothing?': 'number',
      entries: arr(strict({ item: 'string', 'weight?': 'number', 'min?': 'number', 'max?': 'number' })),
    })),
  }),
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
    types: rec(obj({ hardness: 'number', ores: rec('number'), 'traceMul?': 'number', 'traceBoost?': rec('number'), 'name?': 'string', 'size?': 'number[]', 'like?': 'string', 'gas?': 'boolean', 'density?': 'number' })),
    'fields?': rec(rec('number')),
    'comet?': obj({ days: 'number', hours: 'number', systems: 'string[]', traceTier: 'number' }),
    oreHardness: rec('number'),
    danger: rec(obj({ seamChance: 'number', boost: rec('number') })),
    seams: arr(obj({ gem: 'string', hardness: 'number', minTier: 'number', weight: 'number' })),
    seamGemChance: 'number',
    'laserGap?': rec(strict({ work: 'number', keep: 'number' })),
    'guns?': strict({ refDps: 'number', keep: 'number', common: 'string[]', keepOther: 'number', keepByTier: rec('number') }),
    'outliers?': strict({ chance: 'number', scale: 'number[]', stages: 'number[]', 'exclude?': 'string[]', 'systems?': rec('number'), common: 'number', boost: rec('number'), rare: 'number' }),
    'traces?': rec(obj({ from: 'string[]', per100: 'number[]', 'seamMul?': 'number', 'megaOnly?': 'boolean' })),
    tools: (v, path, c) => {
      check(c, obj({ fixed: 'any', turret: 'any', miner: 'any', minerByMaterial: rec('number') }), v, path);
      if (!isObj(v)) return;
      for (const [k, t] of Object.entries(v)) if (!k.startsWith('_') && k !== 'minerByMaterial') check(c, strict({ yield: 'number', hardness: 'number', 'mining?': 'boolean' }), t, join(path, k));
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
      drops: dropsSpec, 'design?': 'string', 'arena?': 'boolean', 'fixed?': 'boolean', 'grade?': 'number', 'plating?': 'number', 'asDesigned?': 'boolean', 'speed?': 'number', 'turn?': 'number', 'stageCover?': 'number',
      'stageHp?': 'number[]', 'limbs?': rec('number'), 'codex?': 'string[]', 'hints?': rec('string'), 'exposed?': arr('string[]'),
      'roam?': obj({ radius: 'number', everySeconds: 'number' }), 'brain?': oneOf(...BRAIN_IDS),
    })),
  }),
  'factions.json': (() => {
    const group = obj({ faction: 'string', ships: 'string[]', weight: 'number', 'passive?': 'boolean', 'plating?': 'number', 'limit?': 'number', 'respawnSeconds?': 'number', 'style?': oneOf('anchored', 'loose', 'nomad') });
    return strict({
      factions: rec(obj({
        name: 'string', color: 'string', behaviour: behaviourSpec, ships: rec(strict({ xp: 'number', credits: 'number', 'drops?': dropsSpec, 'eliteDrop?': 'string' })),
        'drops?': dropsSpec, 'eliteDrop?': 'string', partSalvage: 'number', 'hpScale?': 'number', 'damageScale?': 'number', 'angrySeconds?': 'number',
      })),
      spawns: rec(strict({
        'grade?': 'number', packs: 'number', groups: arr(group), 'loot?': rec(strict({ 'drops?': dropsSpec, 'eliteDrop?': 'string' })),
        'zones?': arr(obj({ id: 'string', inner: 'number', outer: 'number', 'x?': 'number', 'y?': 'number', packs: 'number', 'respawnSeconds?': 'number', groups: arr(group) })),
        'nests?': arr(obj({ id: 'string', packs: 'number', 'respawnSeconds?': 'number', 'leash?': 'number', 'aggro?': 'number', 'roam?': 'number', 'style?': oneOf('anchored', 'loose', 'nomad'), 'bias?': 'number', 'post?': 'xy', groups: arr(group) })),
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
      // (Custom enemy designs: docs/enemies/custom-roster.md, checked by game/custom)
      'custom?': 'any',
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
      repairCostPerHp: 'number', refuelCostPerUnit: 'number', 'dockingFee?': 'number', 'tutorial?': 'boolean',
    })),
  }),
  'systems.json': strict({
    systems: arr(strict({
      id: 'string', name: 'string', 'danger?': 'number', 'pvp?': obj({ mode: oneOf('all', 'outer'), 'safeRadius?': 'number' }),
      description: 'string', starColor: 'string', starRadius: 'number', position: 'xy', 'sector?': 'string', 'tutorial?': 'boolean',
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
      'arena?': strict({ boss: 'string', centre: 'xy', radius: 'number', 'barrier?': arr(arr('number')), outside: 'xy' }),
      'gunRange?': strict({
        centre: 'xy', width: 'number', height: 'number', wall: 'number',
        door: strict({ wall: oneOf('N', 'E', 'S', 'W'), 'along?': 'number', width: 'number', reach: 'number' }),
        spawn: strict({ x: 'number', y: 'number', angle: 'number' }),
        targets: arr(strict({ label: 'string', ship: 'string', faction: 'string', 'grade?': 'number', 'hp?': 'number', ring: 'number', x: 'number', y: 'number', angle: 'number', respawnSeconds: 'number', keepRadius: 'number' })),
      }),
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
      asteroidDensity: 'number', asteroidBelt: obj({ innerRadius: 'number', outerRadius: 'number', count: 'number', 'stationary?': 'boolean', 'lane?': obj({ angle: 'number', width: 'number' }), 'extra?': arr(obj({ innerRadius: 'number', outerRadius: 'number', count: 'number', 'field?': 'string', 'stationary?': 'boolean', 'lane?': obj({ angle: 'number', width: 'number' }), 'at?': arr(arr('number')) })) }),
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
        'hidden?': 'boolean',
      })),
      // (A boss den's features, by kind: server game/dens, common DenFeatureData)
      'den?': arr((v, path, c) => {
        if (isObj(v) && v.kind === 'vents') check(c, strict({ kind: 'string', id: 'string', at: arr(arr('number')), order: 'number[]', every: 'number', tell: 'number', burn: 'number', radius: 'number', dps: 'number', pen: 'number' }), v, path);
        else if (isObj(v) && v.kind === 'cache') check(c, strict({ kind: 'string', id: 'string', name: 'string', x: 'number', y: 'number', cells: 'number', material: 'string', 'paint?': 'string', hp: 'number', everyMinutes: 'number', regrowSeconds: 'number', loot: arr(strict({ item: 'string', chance: 'number', min: 'number', max: 'number' })) }), v, path);
        else c.err(join(path, 'kind'), 'a den feature is `vents` or `cache`');
      }),
      'traffic?': arr(obj({ id: 'string', name: 'string', blueprint: 'string', route: 'string[]' })),
    })),
  }),
};

export const SHIP_SHAPES: Record<string, Spec> = {
  // (functions.json is growing presentation fields, review §3.4: entries aren't strict)
  'ships/functions.json': strict({
    functions: arr(obj({
      id: 'string', pieces: { or: ['string[]', oneOf('*')] }, hpScale: 'number',
      'produce?': 'number', 'demand?': 'number', 'priority?': oneOf(1, 2, 3), 'thrust?': 'number', 'boost?': 'number',
      'boostDrain?': 'number', 'fireInterval?': 'number', 'capacity?': 'number', 'jumpCapacity?': 'number',
      'range?': 'number', 'weapon?': 'string', 'shield?': 'number', 'shieldRegen?': 'number', 'shieldDelay?': 'number', 'flash?': 'boolean', 'splashTaken?': 'number', 'jumpCooldown?': 'number', 'store?': 'number', 'discharge?': 'number', 'legacy?': 'boolean',
      // (Energy routing, types.ts FunctionDef: a store's Takes, an engine's refill and buffer)
      'intake?': 'number', 'buffer?': 'number',
      // (The ports energy core, types.ts FunctionDef: ports, the weapons' power profiles and the feed layer)
      'ports?': arr(strict({ dir: oneOf('in', 'out'), side: oneOf('N', 'E', 'S', 'W'), 'cell?': 'number', rate: 'number' })),
      'profile?': strict({ 'passive?': 'number', 'discharge?': 'number', 'rest?': 'number', 'burst?': 'boolean', 'steady?': 'number', 'pieces?': 'number', 'spike?': 'number', 'spikeWidth?': 'number' }),
      'tank?': strict({ feed: 'string', holds: 'number' }), 'feedPoints?': arr(strict({ side: oneOf('N', 'E', 'S', 'W'), 'cell?': 'number' })),
      'selector?': 'boolean', 'pipe?': 'boolean', 'combiner?': 'boolean', 'pipeThrough?': 'boolean',
      'infra?': strict({ tier: oneOf('simple', 'dual', 'heavy', 'super'), damage: 'number', 'draw?': 'number' }),
      'augment?': strict({ name: 'string', say: 'string', side: oneOf('N', 'E', 'S', 'W'), 'cell?': 'number', rate: 'number', 'floor?': 'number', cost: 'number', 'buffer?': 'number', mods: 'any' }),
      'takes?': 'string[]', 'feedUse?': 'number', 'feedBuf?': 'number', 'feedMods?': rec(rec('number')), 'feedPort?': strict({ side: oneOf('N', 'E', 'S', 'W'), 'cell?': 'number', 'required?': 'boolean' }),
    })),
  }),
  // Player models (written by scripts/econ/models.mjs): functions with their own pieces, material, tier and unlock level
  'ships/models.json': strict({
    '_comment?': 'string', 'legacy?': rec('string'),
    models: arr(obj({
      id: 'string', pieces: 'string[]', hpScale: 'number', model: 'boolean', family: 'string', material: 'string', grade: oneOf(1, 2, 3, 4, 5), points: 'number',
      'unlock?': strict({ level: 'number' }), 'weaponMods?': 'any', 'rated?': 'number', 'blast?': obj({ radius: 'number', damage: 'number', delayTicks: 'number[]' }),
      'produce?': 'number', 'demand?': 'number', 'priority?': oneOf(1, 2, 3), 'thrust?': 'number', 'boost?': 'number', 'boostDrain?': 'number',
      'fireInterval?': 'number', 'capacity?': 'number', 'jumpCapacity?': 'number', 'range?': 'number', 'weapon?': 'string', 'shield?': 'number', 'shieldRegen?': 'number', 'shieldDelay?': 'number', 'flash?': 'boolean', 'splashTaken?': 'number', 'jumpCooldown?': 'number',
      'store?': 'number', 'pool?': oneOf('drive', 'weapon'), 'discharge?': 'number', 'bank?': 'boolean', 'dynamo?': 'number', 'armour?': 'number', 'massScale?': 'number', 'mount?': oneOf('fixed', 'turret'),
      'intake?': 'number', 'buffer?': 'number', 'oneWay?': 'boolean', 'relayOnly?': 'boolean',
      // (Field machines: docs/design/field-fabrication.md)
      'machine?': strict({ kind: oneOf('fabricator', 'refiner'), tier: oneOf(1, 2, 3) }),
      // (Mine Bay and Docking Clamp: docs/design/groups-mines-docking.md)
      'mineBay?': strict({ batch: 'number', capacity: 'number', cooldown: 'number' }),
      'clamp?': strict({ size: 'number' }),
      // (The ports energy core, types.ts FunctionDef: ports, the weapons' power profiles and the feed layer)
      'ports?': arr(strict({ dir: oneOf('in', 'out'), side: oneOf('N', 'E', 'S', 'W'), 'cell?': 'number', rate: 'number' })),
      'profile?': strict({ 'passive?': 'number', 'discharge?': 'number', 'rest?': 'number', 'burst?': 'boolean', 'steady?': 'number', 'pieces?': 'number', 'spike?': 'number', 'spikeWidth?': 'number' }),
      'tank?': strict({ feed: 'string', holds: 'number' }), 'feedPoints?': arr(strict({ side: oneOf('N', 'E', 'S', 'W'), 'cell?': 'number' })),
      'selector?': 'boolean', 'pipe?': 'boolean', 'combiner?': 'boolean', 'pipeThrough?': 'boolean',
      'infra?': strict({ tier: oneOf('simple', 'dual', 'heavy', 'super'), damage: 'number', 'draw?': 'number' }),
      'augment?': strict({ name: 'string', say: 'string', side: oneOf('N', 'E', 'S', 'W'), 'cell?': 'number', rate: 'number', 'floor?': 'number', cost: 'number', 'buffer?': 'number', mods: 'any' }),
      'takes?': 'string[]', 'feedUse?': 'number', 'feedBuf?': 'number', 'feedMods?': rec(rec('number')), 'feedPort?': strict({ side: oneOf('N', 'E', 'S', 'W'), 'cell?': 'number', 'required?': 'boolean' }),
      'mounting?': strict({ 'attach?': oneOf('back', 'any'), 'angle?': oneOf('straight', 'right'), 'arc?': 'number', 'clear?': 'any' }),
      // (A weapon's firing model: common/src/ships/types.ts FireSpec, guns.ts)
      'fire?': strict({ model: oneOf('cycle', 'clip', 'charge', 'ammo', 'beam', 'auto'), interval: 'number', 'clip?': 'number', 'reload?': 'number', 'reloadE?': 'number', 'regrow?': 'number',
        'charge?': 'number', 'cooldown?': 'number', 'chargeE?': 'number', 'burst?': strict({ n: 'number', gap: 'number' }), 'salvo?': 'number',
        'spin?': strict({ from: 'number', to: 'number', up: 'number', down: 'number' }), 'windup?': 'number', 'rounds?': 'number', 'semi?': 'boolean',
        // (Energy routing: a shot gun's shot, intake and buffer; a beam's burn, intake, bufferE and relight)
        'shot?': 'number', 'intake?': 'number', 'buffer?': 'number', 'burn?': 'number', 'bufferE?': 'number', 'relight?': 'number' }),
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
    flight: obj({ coreManeuverForce: 'number', gyroTorque: 'number', thrusterTorqueGain: 'number', '_comment?': 'string', turnGain: 'number', turnBrakeMargin: 'number', maxAngularSpeed: 'number', bossMaxAngularSpeed: 'number', bossTurnGain: 'number', helmTurnGain: 'number' }),
    'jump?': strict({
      'chargeTicks?': 'number', 'burnTicks?': 'number', 'cooldownTicks?': 'number', 'speed?': 'number', 'exitSpeed?': 'number', 'rampTicks?': 'number',
      'slowTicks?': 'number', 'chargeDamping?': 'number', 'baseRange?': 'number', 'solarRing?': 'number', 'solarRangeBoost?': 'number',
      'solarCharge?': 'number', 'lodestoneName?': 'string', 'lodestoneShort?': 'string', 'lodestoneField?': 'number', 'lodestoneCharge?': 'number',
      'lodestoneRangeBoost?': 'number', 'lodestonePrimeTicks?': 'number', 'lodestoneSize?': 'number', 'lodestoneScarredCharge?': 'number',
      'lodestoneScarredBoost?': 'number', '_comment?': 'string', '_short?': 'string',
      'coreCapacity?': 'number', 'gradeCapacity?': 'number', 'gradeRange?': 'number', 'gradeCooldown?': 'number', 'overRange?': 'number', 'overRangeExp?': 'number',
      'overCooldown?': 'number', 'cooldownFloor?': 'number', 'minCooldownTicks?': 'number', 'underRange?': 'number', 'underRangeFloor?': 'number',
      'underCooldown?': 'number', 'underCooldownCap?': 'number',
    }), 'fixedGun?': obj({ gimbalDeg: 'number', 'beamGimbalDeg?': 'number', fireToleranceDeg: 'number' }),
    'weapons?': rec((v, path, c) => {
      if (!isObj(v)) { c.err(path, `expected a weapon, got ${typeName(v)}`); return; }
      // (A pulse laser: damage a pulse, and its pulse's length and peak: common/src/ships/pulse.ts)
      if (v.type === 'beam' && v.pulse !== undefined) check(c, obj({ type: 'string', range: 'number', damage: 'number', pulse: strict({ ticks: 'number', peakAt: 'number' }), 'falloff?': strict({ start: 'number', floor: 'number' }) }), v, path);
      else if (v.type === 'beam') check(c, obj({ type: 'string', range: 'number', dps: 'number', 'gimbalDeg?': 'number' }), v, path);
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
    // (The core's store: power/portsBuild.ts)
    'energy?': obj({ 'coreCapacity?': 'number' }),
    // (The feed layer's materials, common/src/ships/power/ports.ts FeedDef: what each multiplies on a part that takes it)
    'feeds?': rec(strict({ name: 'string', 'short?': 'string', on: oneOf('weapon', 'engine'), mod: rec('number'), 'color?': 'string', 'say?': 'string' })),
    'miner?': obj({ range: 'number', dps: 'number', shipDps: 'number', gimbalDeg: 'number' }),
    turret: obj({ halfArcDeg: 'number', sampleDeg: 'number', slewRate: 'number', fireToleranceDeg: 'number', barrelMargin: 'number' }),
    debris: obj({ lifetimeTicks: 'number', pushSpeed: 'number', pushSpin: 'number' }),
    'partBlast?': rec(obj({ radius: 'number', damage: 'number', delayTicks: 'number[]' })),
    'repair?': obj({ range: 'number', healPerSecond: 'number', restoreTicks: 'number', restoreHp: 'number', intervalTicks: 'number', combatPauseTicks: 'number' }),
    collision: obj({ restitution: 'number', minDamageSpeed: 'number', damagePerSpeed: 'number' }),
    'damage?': obj({ penetration: rec('number') }),
    debug: 'any',
  }),
};

export const blueprintSpec = obj({ name: 'string', catalogVersion: 'number', parts: arr(obj({ uid: 'number', piece: 'string', fn: 'string', material: 'string', x: 'number', y: 'number' })) });
