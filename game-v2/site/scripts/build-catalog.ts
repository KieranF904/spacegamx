/**
 * Builds the site's catalog snapshot (site/catalog/catalog.json) from the game's data.
 *
 *   cd game-v2/site && npm run build-catalog
 *
 * It only READS game-v2/data and the game's shared ship code (common/src/ships: to get the same hit points, mass
 * and damage numbers the hangar shows). It writes nothing outside site/catalog/. Run it by hand when the game's data
 * changes, and commit the result.
 *
 * What it keeps: ids, names and numbers. What it drops on purpose: every `description`, `intro`, `title`,
 * `faction`, station and system text, codex, people and faction files, and market notes. The site writes its own
 * plain text from the numbers (src/catalog/text.ts); catalog.test.ts fails if any of the game's prose gets through.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCatalog } from '../../common/src/ships/catalog.js';
import { partMount } from '../../common/src/ships/blueprint.js';
import { partStats } from '../../common/src/ships/partStats.js';
import type {
  CatalogBoss, CatalogFile, CatalogItem, CatalogPart, CatalogShip, CatalogStation, CatalogSystem, PartCategory, PlanPart, RecipeInfo, ShipStats,
} from '../src/catalog/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(here, '..');
const dataDir = path.resolve(process.env.CATALOG_DATA_DIR || path.join(siteDir, '../data'));
const outFile = path.join(siteDir, 'catalog/catalog.json');

const rj = (...p: string[]) => JSON.parse(fs.readFileSync(path.join(dataDir, ...p), 'utf8'));
const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- reading the data

const shipsDir = path.join(dataDir, 'ships');
const bespokeDir = path.join(shipsDir, 'bespoke');
const bespoke = fs.existsSync(bespokeDir) ? fs.readdirSync(bespokeDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(bespokeDir, f), 'utf8'))) : [];
const catalog = loadCatalog({
  pieces: rj('ships/pieces.json'), functions: rj('ships/functions.json'), materials: rj('ships/materials.json'), models: rj('ships/models.json'), bespoke,
});
const tuning = rj('ships/tuning.json');
const itemsFile = rj('items.json').items as any[];
const recipes = rj('recipes.json');
const mining = rj('mining.json');
const systemsFile = rj('systems.json').systems as any[];
// (A pilot's own station is private to them: not a place on the chart)
const stationsFile = (rj('stations.json').stations as any[]).filter((st) => systemsFile.some((sy) => sy.id === st.system && !sy.private));
const bossesFile = rj('bosses.json').bosses as Record<string, any>;
const models = (rj('ships/models.json').models as any[]).filter((m) => !m.exclusive);

const itemName = new Map<string, string>(itemsFile.map((i) => [i.id, String(i.name)]));
const partName = new Map<string, string>();

// ---------------------------------------------------------------- parts

const CATEGORIES: PartCategory[] = ['weapons', 'engines', 'power', 'shields', 'utility', 'structure', 'core'];

function buildPart(fn: any, opts: { structure?: boolean } = {}): CatalogPart | null {
  const shapes: string[] = fn.pieces === '*' ? catalog.pieceIds : fn.pieces;
  const piece = shapes.includes('sq') ? 'sq' : shapes[0];
  const material = fn.material ?? 'alloy';
  const s = partStats(catalog, tuning, { fn: fn.id, material, piece });
  if (!s) return null;
  const category = (CATEGORIES.includes(fn.category) ? fn.category : null) as PartCategory | null;
  if (!category) return null;
  const part: CatalogPart = {
    id: fn.id, name: String(fn.name), category, family: fn.family ?? null, rarity: fn.rarity ?? 'common',
    mark: s.mark, grade: s.grade, material, size: s.size, cells: r1(s.area), shapes,
    unlock: typeof fn.unlock?.level === 'number' && fn.unlock.level > 0 ? fn.unlock.level : null,
    hp: r1(s.hp), mass: r2(s.mass),
  };
  if (opts.structure) part.cells = 1;
  if (s.dps !== undefined && s.range !== undefined) {
    const mount = partMount(catalog, { fn: fn.id });
    part.weapon = {
      mount: mount === 'turret' ? 'turret' : 'fixed', dps: Math.round(s.dps), range: Math.round(s.range),
      ...(s.damageType ? { damageType: s.damageType } : {}), ...(s.pen !== undefined ? { pen: r1(s.pen) } : {}), ...(fn.fireInterval ? { interval: fn.fireInterval } : {}),
    };
  }
  if (s.draw) part.draw = r1(s.draw);
  if (s.supply) part.supply = r1(s.supply);
  if (typeof fn.store === 'number' && fn.store > 0) part.store = Math.round(fn.store * s.area);
  if (s.thrust) part.thrust = r2(s.thrust);
  if (s.boost) part.boost = r2(s.boost);
  if (s.shield) part.shield = Math.round(s.shield);
  if (s.cargo) part.cargo = Math.round(s.cargo);
  if (Array.isArray(fn.ports) && fn.ports.length) part.ports = fn.ports.map((p: any) => ({ dir: p.dir, side: p.side, rate: p.rate, ...(p.cell ? { cell: p.cell } : {}) }));
  const cost = recipes.models?.[fn.id];
  if (cost?.inputs) part.craft = { inputs: cost.inputs, seconds: cost.time ?? 0 };
  return part;
}

const baseFns = (rj('ships/functions.json').functions as any[]).filter((f) => ['core', 'hull', 'armor', 'cargo'].includes(f.id) && !f.exclusive);
const parts: CatalogPart[] = [];
for (const f of baseFns) { const p = buildPart(f, { structure: true }); if (p) parts.push(p); }
for (const m of models) { const p = buildPart(m); if (p) parts.push(p); }
for (const p of parts) partName.set(p.id, p.name);
const catOrder = (c: PartCategory) => CATEGORIES.indexOf(c);
parts.sort((a, b) => catOrder(a.category) - catOrder(b.category) || (a.family ?? '').localeCompare(b.family ?? '') || (a.unlock ?? 0) - (b.unlock ?? 0) || a.name.localeCompare(b.name));

// ---------------------------------------------------------------- items

const refining: any[] = recipes.refining ?? [];
const crafting: any[] = recipes.craft ?? [];
const modelCosts: Record<string, any> = recipes.models ?? {};

const rocks = Object.entries(mining.types as Record<string, any>).filter(([, t]) => t.ores).map(([id, t]) => ({ id, name: String(t.name ?? id), ores: t.ores as Record<string, number> }));
const seamTotal = (mining.seams as any[]).reduce((n, s) => n + s.weight, 0);

function recipesFor(id: string): RecipeInfo[] {
  const out: RecipeInfo[] = [];
  for (const r of refining) if (r.id === id) out.push({ kind: 'refine', inputs: r.inputs, out: r.out ?? 1, seconds: r.time ?? 0, ...(r.level ? { level: r.level } : {}) });
  for (const r of crafting) if (r.out?.[id]) out.push({ kind: 'craft', inputs: r.inputs, out: r.out[id], seconds: r.time ?? 0, ...(r.level ? { level: r.level } : {}) });
  return out;
}

function usedIn(id: string): CatalogItem['usedIn'] {
  const out: CatalogItem['usedIn'] = [];
  const seen = new Set<string>();
  const add = (kind: 'item' | 'part', oid: string) => {
    const name = kind === 'item' ? itemName.get(oid) : partName.get(oid);
    if (!name || seen.has(`${kind}:${oid}`)) return;
    seen.add(`${kind}:${oid}`);
    out.push({ kind, id: oid, name });
  };
  for (const r of refining) if (r.inputs?.[id]) add('item', r.id);
  for (const r of crafting) if (r.inputs?.[id]) for (const o of Object.keys(r.out ?? {})) add('item', o);
  for (const [pid, c] of Object.entries(modelCosts)) if (c?.inputs?.[id]) add('part', pid);
  return out;
}

const bossLoot = (id: string) => Object.entries(bossesFile)
  .filter(([, b]) => !b._placeholder)
  .flatMap(([bid, b]) => (b.loot ?? []).filter((l: any) => l.item === id).map((l: any) => ({ boss: bid, chance: l.chance ?? 1 })));

const items: CatalogItem[] = itemsFile.map((i) => {
  const ore = rocks.map((r) => {
    const total = Object.values(r.ores).reduce((n, w) => n + w, 0);
    return r.ores[i.id] ? { rock: r.id, name: r.name, share: r1((r.ores[i.id] / total) * 100) } : null;
  }).filter((x): x is { rock: string; name: string; share: number } => !!x);
  const seam = (mining.seams as any[]).find((s) => s.gem === i.id);
  if (seam) ore.push({ rock: 'seam', name: 'Gem seams', share: r1((seam.weight / seamTotal) * 100) });
  return {
    id: i.id, name: String(i.name), category: i.category, rarity: i.rarity ?? 'common', value: i.value ?? 0,
    ...(typeof i.tier === 'number' ? { tier: i.tier } : {}), ...(typeof i.mass === 'number' ? { mass: i.mass } : {}),
    ...(typeof i.color === 'string' ? { color: i.color } : {}),
    foundIn: ore.sort((a, b) => b.share - a.share),
    madeBy: recipesFor(i.id),
    usedIn: usedIn(i.id),
    soldAt: stationsFile.filter((s) => (s.market?.sells ?? []).includes(i.id)).map((s) => s.id),
    paidMoreAt: stationsFile.filter((s) => (s.market?.demand?.[i.id] ?? 0) > 1).map((s) => ({ station: s.id, mult: s.market.demand[i.id] })),
    droppedBy: bossLoot(i.id),
  };
});

// ---------------------------------------------------------------- stations, systems, bosses

const stations: CatalogStation[] = stationsFile.map((s) => {
  const sells: string[] = s.market?.sells ?? [];
  return {
    id: s.id, name: String(s.name), system: s.system, services: s.services ?? [],
    repairCostPerHp: s.repairCostPerHp ?? 0, refuelCostPerUnit: s.refuelCostPerUnit ?? 0,
    sells: {
      items: sells.filter((x) => itemName.has(x)),
      plans: sells.filter((x) => x.startsWith('plan:')).map((x) => x.slice(5)),
      parts: sells.filter((x) => x.startsWith('part:')).map((x) => {
        const [, material, fn] = x.split(':');
        return { part: fn, material, label: `${material[0].toUpperCase()}${material.slice(1)} ${partName.get(fn) ?? fn}` };
      }),
    },
    pays: Object.entries(s.market?.demand ?? {}).filter(([k, v]) => itemName.has(k) && (v as number) !== 1).map(([item, mult]) => ({ item, mult: mult as number })),
  };
});

const systems: CatalogSystem[] = systemsFile.filter((s) => !s.private).map((s) => ({
  id: s.id, name: String(s.name), danger: s.danger ?? 1, hazards: s.hazards ?? [], stations: s.stations ?? [],
}));

const bosses: CatalogBoss[] = Object.entries(bossesFile).filter(([, b]) => !b._placeholder).map(([id, b]) => ({
  id, name: String(b.name), system: b.system, level: b.level ?? 0, phases: (b.phases ?? []).length, xp: b.xp ?? 0, credits: b.credits ?? 0,
  respawnSeconds: b.respawnSeconds ?? 0,
  loot: (b.loot ?? []).map((l: any) => ({ item: l.item, chance: l.chance ?? 1, min: l.min ?? 1, max: l.max ?? l.min ?? 1 })),
}));

// ---------------------------------------------------------------- ships (the plan library)

const libDir = path.join(shipsDir, 'blueprints');
const libFiles = fs.readdirSync(libDir).filter((f) => f.endsWith('.json')).sort();
const seenPlans = new Set<string>();
const usedShapes = new Set<string>(catalog.pieceIds);
const ships: CatalogShip[] = [];
for (const f of libFiles) {
  const bp = JSON.parse(fs.readFileSync(path.join(libDir, f), 'utf8'));
  const key = JSON.stringify(bp.parts);
  if (seenPlans.has(key)) continue; // (a plan filed twice)
  seenPlans.add(key);
  const id = f.replace(/\.json$/, '');
  const stats: ShipStats = { parts: 0, cells: 0, mass: 0, hp: 0, gen: 0, draw: 0, thrust: 0, shield: 0, cargo: 0, guns: { fixed: 0, turret: 0 } };
  const plan: PlanPart[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of bp.parts) {
    const s = partStats(catalog, tuning, p);
    const v = catalog.variants.get(p.piece)?.[(p.rot ?? 0) + (p.flip ? 4 : 0)];
    if (!s || !v) continue;
    stats.parts++; stats.cells += s.area; stats.mass += s.mass; stats.hp += s.hp;
    stats.gen += s.supply ?? 0; stats.draw += s.draw ?? 0; stats.thrust += s.thrust ?? 0; stats.shield += s.shield ?? 0; stats.cargo += s.cargo ?? 0;
    if (s.dps !== undefined) stats.guns[partMount(catalog, p) === 'turret' ? 'turret' : 'fixed']++;
    plan.push({ fn: p.fn, piece: p.piece, x: p.x, y: p.y, rot: p.rot ?? 0, ...(p.flip ? { flip: true } : {}) });
    usedShapes.add(p.piece);
    for (const [vx, vy] of v.polygon) { minX = Math.min(minX, p.x + vx); minY = Math.min(minY, p.y + vy); maxX = Math.max(maxX, p.x + vx); maxY = Math.max(maxY, p.y + vy); }
  }
  stats.mass = r1(stats.mass); stats.hp = Math.round(stats.hp); stats.gen = Math.round(stats.gen); stats.draw = Math.round(stats.draw);
  stats.thrust = r1(stats.thrust); stats.shield = Math.round(stats.shield); stats.cargo = Math.round(stats.cargo); stats.cells = r1(stats.cells);
  const ox = Math.floor(minX), oy = Math.floor(minY);
  ships.push({
    id, name: String(bp.name), stats,
    size: { w: Math.ceil(maxX) - ox, h: Math.ceil(maxY) - oy },
    power: bp.power === 'ports' ? 'ports' : 'pool',
    // (Moved so the top left corner is the origin: a drawing needs no offset)
    plan: plan.map((p) => ({ ...p, x: p.x - ox, y: p.y - oy })),
    soldAt: stationsFile.filter((s) => (s.market?.sells ?? []).includes(`plan:${id}`)).map((s) => s.id),
  });
}
ships.sort((a, b) => a.stats.cells - b.stats.cells || a.name.localeCompare(b.name));

// ---------------------------------------------------------------- how plans are drawn

const shapes: Record<string, string[]> = {};
for (const id of [...usedShapes].sort()) {
  const vs = catalog.variants.get(id);
  if (!vs) continue;
  shapes[id] = vs.map((v) => v.polygon.map(([x, y]) => `${r2(x)},${r2(y)}`).join(' '));
}
const colors: Record<string, string> = {};
for (const [id, f] of catalog.functions) if (typeof f.color === 'string') colors[id] = f.color;

// ---------------------------------------------------------------- write

function sourceInfo(): CatalogFile['source'] {
  try {
    const git = (...a: string[]) => execFileSync('git', ['-C', dataDir, ...a], { encoding: 'utf8' }).trim();
    const [commit, date] = git('log', '-1', '--format=%h|%cI', '--', '.').split('|');
    return { commit, date, dirty: git('status', '--porcelain', '--', '.').length > 0 };
  } catch { return null; }
}

const file: CatalogFile = {
  version: 1, builtAt: new Date().toISOString(), source: sourceInfo(),
  parts, items, ships, bosses, stations, systems, render: { shapes, colors },
};

/** One entry per line, so a changed part shows as one changed line in a diff */
function pretty(f: CatalogFile): string {
  const lines: string[] = ['{'];
  const keys = Object.keys(f) as (keyof CatalogFile)[];
  keys.forEach((k, i) => {
    const v = f[k] as unknown;
    const comma = i < keys.length - 1 ? ',' : '';
    if (Array.isArray(v)) lines.push(`"${k}": [\n${v.map((x) => JSON.stringify(x)).join(',\n')}\n]${comma}`);
    else if (v && typeof v === 'object' && k === 'render') lines.push(`"${k}": {\n${Object.entries(v).map(([kk, vv]) => `  "${kk}": ${JSON.stringify(vv)}`).join(',\n')}\n}${comma}`);
    else lines.push(`"${k}": ${JSON.stringify(v)}${comma}`);
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, pretty(file));
console.log(`catalog: ${parts.length} parts, ${items.length} items, ${ships.length} ships, ${bosses.length} bosses, ${stations.length} stations -> ${path.relative(process.cwd(), outFile)}`);
