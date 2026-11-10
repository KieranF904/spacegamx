/**
 * @contract validate.context
 * owns:       what every per-file validator shares: the id indexes of the data files, the reference helpers (ref, item,
 *             cond, lines...), the shape pass and the closest-id hint
 * needs:      @space-game/common (default asteroid tables, part ids), validateShapes (Ctx, shapes); browser-safe: no Node imports
 * invariants: the real data has no errors, with and without the ship files — server/src/data/validateGameData.test.ts
 *             a dangling id is reported once, with a "did you mean" — server/src/data/validateGameData.test.ts
 * extend:     a new index or reference helper is built in createContext and added to its return
 */

import { DEFAULT_ASTEROID_FIELDS, DEFAULT_ASTEROIDS, parsePartItemId, type Blueprint, type CatalogFiles, type ShipTuning, type InventoryStub } from '@space-game/common';
import { Ctx, SHAPES, SHIP_SHAPES, blueprintSpec, check, isObj, join, list } from '../validateShapes.js';

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

/** Safe accessors for the cross-reference pass (shape errors are already reported) */
export const entries = (v: unknown): [string, any][] => (isObj(v) ? Object.entries(v).filter(([k]) => !k.startsWith('_')) : []);
export const keysOf = (v: unknown): string[] => entries(v).map(([k]) => k);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Closest id (edit distance ≤ 2), for "did you mean" */
export function closest(id: string, ids: Iterable<string>): string | undefined {
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

/** Pass 1: each file against its shape (errors and warnings go to `c`) */
export function checkShapes(c: Ctx, f: Record<string, any>, ships: ShipDataFiles | undefined): void {
  const FILE_KEYS: Record<string, string> = {
    items: 'items.json', recipes: 'recipes.json', mining: 'mining.json', factions: 'factions.json', bosses: 'bosses.json',
    systems: 'systems.json', stations: 'stations.json', quests: 'quests.json',
    people: 'people.json', codex: 'codex.json', achievements: 'achievements.json', unlocks: 'unlocks.json', strings: 'strings.json', mobs: 'mobs.json', hazards: 'hazards.json', gems: 'gems.json', station: 'station.json',
  };
  const OPTIONAL = new Set(['bosses', 'people', 'codex', 'achievements', 'unlocks', 'strings', 'mobs', 'hazards', 'gems', 'station']);
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
}

/** The indexes and reference helpers pass 2 reads (built after the shape pass: duplicate ids are reported there) */
export function createContext(c: Ctx, f: Record<string, any>, ships: ShipDataFiles | undefined) {
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

  /** Items: listed, or a generated part (part:<material>:<fn>:<piece>) */
  const item = (file: string, path: string, id: unknown): void => {
    if (typeof id !== 'string' || itemRows.has(id)) return;
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

  return {
    c, f, ships, systems, stations, quests, people, records, itemRows, craftRecipes, bosses, factions, reputations, restricted, licences, stationDefence,
    fnRows, functions, materials, pieces, weaponKinds, library, designs, asteroidFields, asteroidTypes,
    ref, sys, station, quest, person, faction, record, design, plan, weaponKind, fn, material, piece, item, bag, licence, cond, lines, place,
  };
}

export type V = ReturnType<typeof createContext>;
