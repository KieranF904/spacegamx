/**
 * The native renderer's Node side: an asset id in, what to draw out (typed arrays, in draw order), built by the game's
 * own pure code: the catalog, viewer builders (model stubs, material blocks), buildHull (hull geometry, exposure and
 * volume baked, a boss's built whole), skeletons and frames, turret heads (gunDecor) and fixed barrels, power wires.
 *
 * The hull and lit shaders are read out of the game's TypeScript (ShipBatch.ts, litShader.ts) at load, so they stay
 * the single source; so are the light presets (viewer/ViewerScene.ts) and the hull attribute table (ShipBatch ATTRS).
 * The GL work happens in the Python worker (gl_worker.py).
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import earcut from 'earcut';
import { blueprintGeometry, cellKey, isOpen, loadCatalog, parseBlueprint, wireCells, type Blueprint, type Catalog, type ShipState, type ShipTuning } from '@space-game/common';
import { buildHull, skeletonCovered } from '../../client/src/ships/hullBuild';
import { buildSkeleton } from '../../client/src/ships/skeletonBuild';
import { decorOf } from '../../client/src/ships/partDecor';
import { flames, beam, type Engine } from './fx';
import { engineLookOf } from '../../client/src/ships/engineLooks';
import { skyUniforms, type SkyUniforms } from './sky';
import { buildFrame } from '../../client/src/ships/frameBuild';
import { turretHead } from '../../client/src/ships/gunDecor';
import { buildHullAtlas, HULL_ROWS, HULL_TILE } from '../../client/src/ships/hullTextures';
import { GLOW_COOL, GLOW_WARM, HULL_WEAR, KIND_GLOW, KIND_LOOK } from '../../client/src/ships/hullLook';
import { MAX_LIGHTS, fades } from '../../client/src/rendering/lighting/litShader';
import { SHIP_MAX_PARTS } from '../../client/src/rendering/lighting/ShipBatch';
import { LitGeometry } from '../../client/src/rendering/lighting/LitGeometry';
import { expandAsset, listAssets, refLabel, searchAssets, type AssetEntry, type AssetRef, type AssetSources } from '../../client/src/viewer/assets';
import { refBlueprint, usesBespoke, viewerShip } from '../../client/src/viewer/builders';
import { parseParams, lightWith, type ViewerParams } from '../../client/src/viewer/params';
import factionsData from '../../data/factions.json';

const ROOT = resolve(__dirname, '../..');
const DATA = join(ROOT, 'data/ships');
const SRC = join(ROOT, 'client/src');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

// ---- shaders and tables, out of the game's own source

/** A template literal's body after `marker` (up to the closing backtick), evaluated with `vars` in scope */
function template(file: string, marker: string, vars: Record<string, unknown>): string {
  const src = readFileSync(join(SRC, file), 'utf8');
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`${file}: "${marker}" not found (the shader moved?)`);
  const start = src.indexOf('`', at) + 1, end = src.indexOf('`', start);
  const body = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(vars), `return \`${body}\`;`)(...Object.values(vars));
}

/** GLSL ES 3.00 to desktop 3.30 core: the version line (precision qualifiers are accepted and ignored there) */
const toDesktop = (s: string) => s.replace(/^#version 300 es/, '#version 330 core');

/** Slots compiled in: the renderer draws one object at a time (two: as LitMesh, never a one-slot array) */
const SLOTS = 2;
export const SHADERS = (() => {
  const vars = { slots: SLOTS, MAX_LIGHTS, fades, HULL_ROWS };
  return {
    hullVertex: toDesktop(template('rendering/lighting/ShipBatch.ts', 'const vertex = (slots: number) =>', vars)),
    hullFragment: toDesktop(template('rendering/lighting/ShipBatch.ts', 'const fragment = `', vars)),
    litVertex: toDesktop(template('rendering/lighting/litShader.ts', 'const vertex = (slots: number) =>', vars)),
    litFragment: toDesktop(template('rendering/lighting/litShader.ts', 'const fragment = `', vars)),
  };
})();

/** ShipBatch's hull attribute table: [shader name, ShipGeometry field, per vertex, default] */
const HULL_ATTRS: [string, string, number, number[]][] = (() => {
  const src = readFileSync(join(SRC, 'rendering/lighting/ShipBatch.ts'), 'utf8');
  const m = /const ATTRS[^=]*=\s*(\[[\s\S]*?\n\]);/.exec(src);
  if (!m) throw new Error('ShipBatch ATTRS not found');
  return [...(new Function(`return ${m[1]};`)() as [string, string, number, number[]][]), ['aSlot', 'slot', 1, [0]]];
})();

interface LightPreset { ambient: number[]; power: number; color: number[]; elevation: number; dir: number; off?: boolean }
/** The viewer's light presets (ViewerScene LIGHT_PRESETS), read from its source (it imports Pixi's display side) */
export const LIGHT_PRESETS: Record<string, LightPreset> = (() => {
  const src = readFileSync(join(SRC, 'viewer/ViewerScene.ts'), 'utf8');
  const m = /export const LIGHT_PRESETS[^=]*=\s*(\{[\s\S]*?\n\});/.exec(src);
  if (!m) throw new Error('LIGHT_PRESETS not found');
  return new Function(`return ${m[1]};`)();
})();

/** The hull atlas (hullTextures.ts: pure), RGBA, 4 tiles across, HULL_ROWS down */
export function atlas(): { data: Uint8Array; w: number; h: number } {
  return { data: buildHullAtlas(), w: HULL_TILE * 4, h: HULL_TILE * HULL_ROWS };
}

/** The hull shader's constant tables (hullLook.ts) and the damage texture's size */
export const TABLES = {
  uKindLook: Array.from(KIND_LOOK), uKindGlow: Array.from(KIND_GLOW), uGlowCool: Array.from(GLOW_COOL), uGlowWarm: Array.from(GLOW_WARM),
  uWear: Array.from(HULL_WEAR), damageW: SHIP_MAX_PARTS, damageH: SLOTS, maxLights: MAX_LIGHTS, slots: SLOTS, fades: fades(SLOTS),
};

// ---- the game's data, from disk (as viewer/catalog.ts loads it through Vite)

export interface Data { catalog: Catalog; tuning: ShipTuning; ships: Map<string, Blueprint>; assets: AssetEntry[] }

export function loadData(): Data {
  const tuning = readJson(join(DATA, 'tuning.json')) as ShipTuning;
  const bespoke = readdirSync(join(DATA, 'bespoke')).filter((f) => f.endsWith('.json')).map((f) => readJson(join(DATA, 'bespoke', f)));
  const catalog = loadCatalog({
    pieces: readJson(join(DATA, 'pieces.json')), functions: readJson(join(DATA, 'functions.json')),
    materials: readJson(join(DATA, 'materials.json')), models: readJson(join(DATA, 'models.json')), bespoke,
  } as never, { overlapShrink: tuning.overlapShrink });
  const ships = new Map<string, Blueprint>();
  const blueprints: AssetSources['blueprints'] = [];
  const walk = (dir: string, rel: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { walk(p, rel ? `${rel}/${f}` : f); continue; }
      if (!f.endsWith('.json')) continue;
      const path = (rel ? `${rel}/` : '') + f.replace(/\.json$/, '');
      try {
        const bp = parseBlueprint(readFileSync(p, 'utf8'));
        ships.set(path, bp);
        blueprints.push({ path, name: bp.name, bespoke: usesBespoke(catalog, bp), rigid: !!bp.rigid, parts: bp.parts.length });
      } catch { /* (not a blueprint) */ }
    }
  };
  walk(join(DATA, 'blueprints'), '');
  const models = [...catalog.functions.values()].filter((f) => f.model).map((f) => ({ id: f.id, name: f.name, family: f.family, mount: f.mount, category: f.category, rarity: f.rarity }));
  const materials = [...catalog.materials.values()].map((m) => ({ id: m.id, name: m.name, grade: m.grade }));
  const pieces = [...catalog.pieces.values()].filter((p) => !p.bespoke).map((p) => ({ id: p.id, tier: p.tier }));
  return { catalog, tuning, ships, assets: listAssets({ blueprints, models, materials, pieces }) };
}

export { searchAssets, parseParams };

// ---- one asset, as draws

/** A draw: `hull` (the hull shader), `lit` (the lit shader: skeletons, frames), `flat` (turrets, barrels, wires: plain
 * fills, `metal` vertices tinted by the light level as the game tints them). All in the ship's own frame, pixels */
export interface Draw {
  kind: 'hull' | 'lit' | 'flat' | 'sprite';
  /** Sprites: the texture's name (the GL worker paints it), and that it's one of the glowing things the bloom takes */
  tex?: string;
  glow?: boolean;
  /** A frame's glowing half: drawn added, at the view's heat */
  heat?: boolean;
  attrs: Record<string, { data: Float32Array; size: number }>;
  idx: Uint32Array;
  blend?: 'normal' | 'add';
  /** Each pixel drawn once however its shapes overlap (a stroked path, as Pixi strokes one) */
  once?: boolean;
  /** Drawn only while a cell is at least this big on screen (px), as the game hides guns and wires when small */
  minPx?: number;
}

export interface Built {
  key: string;
  draws: Draw[];
  /** Its extent about its centre of mass, unturned (px), and room round it */
  box: { x0: number; y0: number; x1: number; y1: number };
  cs: number;
  /** Which way its engines are driven (grid frame), whether it has any, and its part count (the damage row) */
  thrust: [number, number];
  engines: boolean;
  /** Each engine's thrust and nozzles (flames), and its colouring */
  jets: Engine[];
  tint: number | undefined;
  parts: number;
  /** How far it reaches (px), and whether it's a ship (its headlights come on in the dark) */
  radius: number;
  ship: boolean;
  info: { name: string; parts: number; vertices: number; rigid: boolean; buildMs: number };
}

const FACTIONS = Object.values((factionsData as { factions: Record<string, { color: string }> }).factions);
const FACTION_IDS = Object.keys((factionsData as { factions: Record<string, unknown> }).factions);
const rgb = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
/** A colour × a tint (as Pixi tints a fill) */
const times = (a: number, b: number) => {
  const [ar, ag, ab] = rgb(a), [br, bg, bb] = rgb(b);
  return (Math.round(ar * br * 255) << 16) | (Math.round(ag * bg * 255) << 8) | Math.round(ab * bb * 255);
};

/** Fills built up into one flat draw */
class Flat {
  pos: number[] = []; col: number[] = []; metal: number[] = []; part: number[] = []; idx: number[] = [];
  /** A polygon (earcut), turned by `r` and moved to (x, y), in `color` × alpha (premultiplied) */
  poly(pts: number[], color: number, o: { x?: number; y?: number; r?: number; k?: number; alpha?: number; metal?: boolean; part?: number } = {}): void {
    const n = pts.length / 2;
    if (n < 3) return;
    const c = Math.cos(o.r ?? 0), s = Math.sin(o.r ?? 0), k = o.k ?? 1, a = o.alpha ?? 1, [r, g, b] = rgb(color), base = this.pos.length / 2;
    for (let i = 0; i < n; i++) {
      const u = pts[i * 2] * k, v = pts[i * 2 + 1] * k;
      this.pos.push((o.x ?? 0) + c * u - s * v, (o.y ?? 0) + s * u + c * v);
      this.col.push(r * a, g * a, b * a, a);
      this.metal.push(o.metal ? 1 : 0);
      this.part.push(o.part ?? -1);
    }
    for (const t of earcut(pts)) this.idx.push(base + t);
  }
  /** A stroke along a segment with round ends (an octagon at each) */
  seg(x0: number, y0: number, x1: number, y1: number, w: number, color: number, alpha: number, metal: boolean): void {
    const len = Math.hypot(x1 - x0, y1 - y0) || 1, nx = (-(y1 - y0) / len) * w / 2, ny = ((x1 - x0) / len) * w / 2;
    this.poly([x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny], color, { alpha, metal });
    for (const [x, y] of [[x0, y0], [x1, y1]]) {
      const ring: number[] = [];
      for (let i = 0; i < 8; i++) ring.push(x + Math.cos((i / 8) * Math.PI * 2) * w / 2, y + Math.sin((i / 8) * Math.PI * 2) * w / 2);
      this.poly(ring, color, { alpha, metal });
    }
  }
  draw(o: Partial<Draw> = {}): Draw | null {
    if (!this.idx.length) return null;
    return {
      kind: 'flat', idx: new Uint32Array(this.idx),
      attrs: { aPosition: { data: new Float32Array(this.pos), size: 2 }, aColor: { data: new Float32Array(this.col), size: 4 }, aMetal: { data: new Float32Array(this.metal), size: 1 }, aPart: { data: new Float32Array(this.part), size: 1 } },
      ...o,
    };
  }
}

const litDraw = (g: LitGeometry): Draw => ({
  kind: 'lit', idx: new Uint32Array(g.idx),
  attrs: {
    aPosition: { data: new Float32Array(g.pos), size: 2 }, aNormal: { data: new Float32Array(g.nrm), size: 3 },
    aColor: { data: new Float32Array(g.col), size: 4 }, aSlot: { data: new Float32Array(g.slot), size: 1 },
  },
});

/** Power wires as ShipRenderer.layWires draws them: a dark channel, dim unpowered cores, lit runs (a halo and a core, added) */
const LAMPS_BELOW = 0.5;
const WIRE_LIT = 0x8fe3ff, WIRE_DIM = 0x3c5566, WIRE_DARK = 0x10141c, WIRE_MIN_PX = 5, GUN_MIN_PX = 3;
function wires(data: Data, ship: ShipState, cs: number): Draw[] {
  const d = ship.derived, [cx, cy] = d.com;
  if (ship.kind !== 'ship' || !d.wires.length) return [];
  const cells = wireCells(data.catalog, ship.blueprint);
  const live = (x: number, y: number) => cells.get(cellKey(x, y))?.some((i) => d.alive[i]) ?? false;
  const X = (v: number) => (v + 0.5 - cx) * cs, Y = (v: number) => (v + 0.5 - cy) * cs;
  const dark = new Flat(), dim = new Flat(), halo = new Flat(), core = new Flat();
  d.wires.forEach(([x0, y0, x1, y1], s) => {
    const a = live(x0, y0), b = live(x1, y1);
    if (a || b) {
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const [p, q] = a && b ? [[x0, y0], [x1, y1]] : a ? [[x0, y0], [mx, my]] : [[x1, y1], [mx, my]];
      dark.seg(X(p[0]), Y(p[1]), X(q[0]), Y(q[1]), cs * 0.15, WIRE_DARK, 0.9, true);
    }
    if (!d.wireLive[s]) return;
    if (!d.networks[d.wireNet[s]]?.powered) dim.seg(X(x0), Y(y0), X(x1), Y(y1), cs * 0.05, WIRE_DIM, 1, true);
    else {
      halo.seg(X(x0), Y(y0), X(x1), Y(y1), cs * 0.2, WIRE_LIT, 0.16, false);
      core.seg(X(x0), Y(y0), X(x1), Y(y1), cs * 0.055, WIRE_LIT, 0.95, false);
    }
  });
  // (the lit runs breathe: 0.8..1; taken at its middle)
  const glow = 0.9;
  for (const f of [halo, core]) for (let k = 0; k < f.col.length; k++) f.col[k] *= glow;
  return [dark.draw({ once: true, minPx: WIRE_MIN_PX }), dim.draw({ once: true, minPx: WIRE_MIN_PX }),
    halo.draw({ once: true, blend: 'add', minPx: WIRE_MIN_PX }), core.draw({ once: true, blend: 'add', minPx: WIRE_MIN_PX })].filter((x): x is Draw => !!x);
}

/** What one asset builds as (a change here builds again; the rest is uniforms) */
const refId = (r: AssetRef) => `${r.kind}:${r.key}${r.facing ? `@${r.facing}` : ''}`;
export const buildKey = (r: AssetRef, p: ViewerParams) => [refId(r), p.facing, p.stub, p.tint, p.aim].join('|');

const cache = new Map<string, Built>();
const CACHE_KEPT = 400;

export function build(data: Data, ref: AssetRef, p: ViewerParams): Built {
  const key = buildKey(ref, p);
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const t0 = performance.now();
  let bp = refBlueprint(data.catalog, ref, data.ships, { facing: p.facing, stub: p.stub });
  if (!bp) throw new Error(`not found: ${refId(ref)}`);
  const cs = data.tuning.cellSize;
  // Colouring as the viewer gives it: paint, or a faction's colours
  let tint: number | undefined;
  if (p.tint?.startsWith('#')) { bp = { ...bp, paint: p.tint } as Blueprint; tint = parseInt(p.tint.slice(1), 16); }
  else if (p.tint?.startsWith('faction:')) { const f = FACTIONS[FACTION_IDS.indexOf(p.tint.slice(8))]; if (f) tint = parseInt(f.color.slice(1), 16); }
  else if (bp.paint) tint = parseInt(bp.paint.slice(1), 16);
  const ship = viewerShip(data.catalog, data.tuning, 1, bp);
  const rigid = !!ship.blueprint.rigid && ship.kind === 'ship';
  const geoms = blueprintGeometry(data.catalog, ship.blueprint);
  const { hull, barrels } = buildHull(data.catalog, geoms, ship, cs, tint, rigid);
  const [cx, cy] = ship.derived.com;
  const draws: Draw[] = [];

  // Under the hull: its skeleton (built whole: only what's bared from the start) and frame (cold: no heat)
  const bones = ship.blueprint.parts.map((q, i) => ({ sk: data.catalog.pieces.get(q.piece)?.skeleton, i })).filter((a) => a.sk && (rigid || ship.derived.alive[a.i]));
  if (bones.length) {
    const over = (i: number) => { const pc = data.catalog.pieces.get(ship.blueprint.parts[i].piece); return !pc?.skeleton && !pc?.under; };
    for (const { sk } of bones) {
      const g = new LitGeometry();
      buildSkeleton(g, sk!, ship.derived.com, cs);
      if (!rigid) { draws.push(litDraw(g)); continue; }
      for (const [cover, piece] of skeletonCovered(g, geoms, ship.derived.com, cs, over)) if (cover < 0) draws.push(litDraw(piece));
    }
  }
  const fp = ship.blueprint.parts.map((q) => data.catalog.pieces.get(q.piece)?.frame).find((f) => f);
  if (fp) {
    const fr = buildFrame(fp, ship.derived.com, cs);
    draws.push(litDraw(fr.cold), { ...litDraw(fr.hot), blend: 'add', heat: true });
  }

  // Fixed guns' barrels (under the hull): their shapes, metal tinted by the light, lit bits as they are
  const fixed = new Flat();
  for (const b of barrels) for (const s of b.parts ?? [{ pts: b.pts, color: 0x8e98a7 }]) fixed.poly(s.pts, s.color, { x: b.x0, y: b.y0, metal: !s.glow, part: b.part });
  const fd = fixed.draw({ minPx: GUN_MIN_PX });
  if (fd) draws.push(fd);

  // The hull: every attribute as the hull shader takes it
  const g = hull.full as unknown as Record<string, ArrayLike<number>>, n = hull.full.vertexCount;
  const attrs: Draw['attrs'] = {};
  for (const [name, field, w, dflt] of HULL_ATTRS) {
    const from = g[field], out = new Float32Array(n * w);
    for (let k = 0; k < n * w; k++) out[k] = from?.[k] ?? dflt[k % w];
    attrs[name] = { data: out, size: w };
  }
  draws.push({ kind: 'hull', attrs, idx: new Uint32Array(hull.full.idx) });

  // Over it: wires, then turrets at rest (or aimed: as far round as each can turn)
  draws.push(...wires(data, ship, cs));
  const guns = new Flat();
  for (const w of ship.derived.weapons) {
    if (!w.window) continue;
    let aim = 0;
    if (p.aim !== null) {
      const off = (p.aim * Math.PI) / 180 - Math.PI / 2 - w.window.center;
      aim = Math.max(-w.window.half, Math.min(w.window.half, Math.atan2(Math.sin(off), Math.cos(off))));
    }
    const fn = ship.blueprint.parts[w.part].fn, big = data.catalog.pieces.get(ship.blueprint.parts[w.part].piece)?.turret;
    const area = big ? big * big : geoms[w.part]?.area ?? 1;
    const head = turretHead(fn, big ? Math.max(w.window.barrel, big * 1.1) : w.window.barrel, area);
    const open = isOpen(w.window, aim), r = w.window.center + aim;
    const x0 = (w.window.pivot[0] - cx) * cs, y0 = (w.window.pivot[1] - cy) * cs;
    // (metal: tinted by the light, darker when its shot's blocked; lit bits white, or grey when blocked)
    for (const s of head.shapes) guns.poly(s.pts, open ? s.color : times(s.color, s.glow ? 0x9a9a9a : 0x8f8582), { x: x0, y: y0, r, k: cs, metal: !s.glow, part: w.part });
  }
  const gd = guns.draw({ minPx: GUN_MIN_PX });
  if (gd) draws.push(gd);

  // Its extent: alive parts' outlines about the centre of mass
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  geoms.forEach((gm, i) => {
    if (!ship.derived.alive[i]) return;
    for (const [x, y] of gm.polygon) {
      box.x0 = Math.min(box.x0, (x - cx) * cs); box.x1 = Math.max(box.x1, (x - cx) * cs);
      box.y0 = Math.min(box.y0, (y - cy) * cs); box.y1 = Math.max(box.y1, (y - cy) * cs);
    }
  });
  if (!Number.isFinite(box.x0)) Object.assign(box, { x0: -cs, y0: -cs, x1: cs, y1: cs });
  const vertices = draws.reduce((a, d) => a + d.attrs.aPosition.data.length / 2, 0);
  // Which way its engines push (for the flames' room, as the viewer works it out)
  let fx = 0, fy = 0;
  for (const t of ship.derived.thrusters) { const f = Math.hypot(t.force[0], t.force[1]) || 1; fx += t.force[0] / f; fy += t.force[1] / f; }
  const fwd = ship.derived.thrusters.some((t) => t.force[1] < -1e-6), fl = Math.hypot(fx, fy) || 1;
  const thrust: [number, number] = fwd || !ship.derived.thrusters.length ? [0, -1] : [fx / fl, fy / fl];
  // Each engine's nozzles (where its flames start), as ThrusterFx.draw finds them
  const jets: Engine[] = [];
  ship.derived.thrusters.forEach((t, index) => {
    if (Math.hypot(t.force[0], t.force[1]) <= 0 || !ship.derived.alive[t.part]) return;
    jets.push({ index, fn: bp.parts[t.part]?.fn, f: [t.force[0], t.force[1]], nozzles: decorOf(geoms[t.part]).nozzles.map((nz) => ({ mx: (nz.at[0] - cx) * cs, my: (nz.at[1] - cy) * cs, n: nz.n as [number, number], t: nz.t as [number, number], edge: nz.width * cs * 1.05 })) });
  });
  const built: Built = {
    key, draws, box, cs, thrust, jets, tint, engines: ship.derived.thrusters.length > 0, parts: bp.parts.length, radius: ship.derived.radius, ship: ship.kind === 'ship',
    info: { name: bp.name ?? refId(ref), parts: bp.parts.length, vertices, rigid, buildMs: Math.round(performance.now() - t0) },
  };
  cache.set(key, built);
  for (const k of cache.keys()) { if (cache.size <= CACHE_KEPT) break; cache.delete(k); }
  return built;
}

// ---- the view: the items laid out, camera and light, as the viewer works them out (ViewerScene layout, bounds, applyLight)

export interface Item { key: string; built: Built; x: number; y: number; label?: string; damage: number[]; /** Flames, exhaust and beams (they follow the view's params: not cached) */ fx: Draw[] }
export interface View {
  w: number; h: number; zoom: number; cam: [number, number]; angle: number; transparent: boolean; bg: [number, number, number];
  ambient: number[]; sun: number[]; sunColor: number[]; sunElev: number[]; level: number[];
  /** Lights as the shader takes them (uLightPos: x, y, radius, height; uLightCol: rgb, power; uLightCone: dir, cos outer, inner) */
  lights: { pos: number[]; col: number[]; cone: number[] }[];
  labels: { text: string; x: number; y: number }[];
  /** A frame's glow 0..1, whether glowing things bloom, and the sky (null: none) with the view in CSS px */
  heat: number; bloom: boolean; sky: SkyUniforms | null; css: { w: number; h: number; zoom: number };
}

/** Every asset a param set names (sheets expanded), built, laid out in a grid as the viewer lays them */
export function scene(data: Data, p: ViewerParams): { items: Item[]; view: View; missing: string[] } {
  const refs = expandAsset(p.asset, data.assets), missing: string[] = [];
  if (!refs.length) throw new Error(`nothing to show for "${p.asset}" (ids: ship:, boss:, model:, material:, piece:, sheet:)`);
  const items: Item[] = [];
  for (const ref of refs.slice(0, 400)) {
    try {
      const built = build(data, ref, p);
      items.push({ key: built.key, built, x: 0, y: 0, label: refLabel(ref, data.assets), damage: [], fx: [] });
    } catch (e) {
      missing.push(`${refId(ref)} (${e instanceof Error ? e.message : e})`);
    }
  }
  if (!items.length) throw new Error(`not found: ${missing.join(', ')}`);
  const cs = data.tuning.cellSize, n = items.length;
  const W = p.w ?? 1280, H = p.h ?? 800;
  const labelled = p.labels && n > 1;
  // Grid: cells as big as the biggest hull's box, columns to suit the view's shape
  const label = labelled ? cs * 1.6 : 0;
  const cw = Math.max(...items.map((i) => i.built.box.x1 - i.built.box.x0)) + cs * 1.6;
  const ch = Math.max(...items.map((i) => i.built.box.y1 - i.built.box.y0)) + cs * 1.6 + label;
  const cols = p.cols ?? Math.max(1, Math.min(n, Math.round(Math.sqrt((n * (W / H) * ch) / cw))));
  const rows = Math.ceil(n / cols);
  items.forEach((it, k) => {
    const b = it.built.box, bx = (b.x0 + b.x1) / 2, by = (b.y0 + b.y1) / 2;
    it.x = n === 1 ? 0 : ((k % cols) - (cols - 1) / 2) * cw - bx;
    it.y = n === 1 ? 0 : (Math.floor(k / cols) - (rows - 1) / 2) * ch - by - label / 2;
    // Damage: each part a seeded share of it, as the viewer seeds it (never quite gone)
    let seed = (p.seed * 2654435761 + (k + 1) * 97) >>> 0;
    const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296);
    it.damage = Array.from({ length: it.built.parts }, () => Math.round(Math.max(0.02, 1 - p.damage * (0.35 + 0.65 * rnd())) * 255));
  });
  // Bounds at this heading (room for barrels and bells, and the flames' plume behind)
  const a = (p.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  const labelY = (it: Item) => {
    const { x0, y0, x1, y1 } = it.built.box;
    return it.y + Math.max(...[[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => x * s + y * c)) + cs;
  };
  for (const it of items) {
    let { x0, y0, x1, y1 } = it.built.box;
    x0 -= cs * 0.6; y0 -= cs * 0.6; x1 += cs * 0.6; y1 += cs * 0.6;
    if (p.flames > 0 && it.built.engines) {
      const plume = cs * (1.5 + 3.5 * p.flames) * (p.boost ? 1.7 : 1) * Math.max(1, ...it.built.jets.map((j) => engineLookOf(j.fn ?? "").len * (p.boost ? 1.4 : 1))), [tx, ty] = it.built.thrust;
      if (tx > 0.5) x0 -= plume; if (tx < -0.5) x1 += plume; if (ty > 0.5) y0 -= plume; if (ty < -0.5) y1 += plume;
    }
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
      const wx = it.x + x * c - y * s, wy = it.y + x * s + y * c;
      bx0 = Math.min(bx0, wx); bx1 = Math.max(bx1, wx); by0 = Math.min(by0, wy); by1 = Math.max(by1, wy);
    }
    if (labelled) by1 = Math.max(by1, labelY(it) + cs * 0.9);
  }
  const fit = Math.max(0.01, Math.min(W / ((bx1 - bx0) * 1.18 || 1), H / ((by1 - by0) * 1.18 || 1)));
  const zoom = (p.zoom === 'fit' ? fit : p.zoom) * p.scale;
  const cam: [number, number] = [(bx0 + bx1) / 2 + p.x, (by0 + by1) / 2 + p.y];
  const w = Math.round(W * p.scale), h = Math.round(H * p.scale);
  // Light
  const L = LIGHT_PRESETS[p.light] ?? LIGHT_PRESETS.sun, on = !L.off;
  const lw = lightWith(L, p);
  const ambient = on ? lw.ambient : [1, 1, 1];
  const dir = ((p.lightDir ?? L.dir) * Math.PI) / 180, power = on ? p.lightPower ?? L.power : 0, elev = p.elevation ?? L.elevation;
  // (far off, so it lights the whole view from one way: as the viewer places it)
  const sun = [cam[0] + Math.sin(dir) * 1e8, cam[1] - Math.cos(dir) * 1e8, 1e9, power];
  // The light on an up-facing point (Lighting.levelAt: the sun alone, no lamps), for the guns' tint
  const k = power * Math.sin(elev);
  const level = on ? ambient.map((v, i) => Math.min(1.6, v + lw.color[i] * k)) : [1, 1, 1];
  // Where it's dark, ships' headlights come on (ShipRenderer collectLights / updateLamps, settled: fully on): a beam ahead
  // and a faint light over the hull so a ship can always see itself
  const env = (ambient[0] + ambient[1] + ambient[2]) / 3 + k * (lw.color[0] + lw.color[1] + lw.color[2]) / 3;
  const lights: View['lights'] = [];
  const dark = on && env < LAMPS_BELOW;
  const rot = (it: Item, x: number, y: number) => [it.x + x * c - y * s, it.y + x * s + y * c];
  const rgbOf = (n: number) => [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const power0: number[] = [];
  items.forEach((it, i) => {
    const b = it.built;
    // Flames, exhaust, and the engines' light (where lighting is on)
    const fx = flames(b.jets, b.thrust, cs, b.tint, { flames: p.flames, boost: p.boost, exhaust: p.exhaust, frost: p.frost }, i + 1);
    it.fx = fx.draws;
    if (on && fx.light) {
      const [lx, ly] = rot(it, fx.light.x, fx.light.y);
      lights.push({ pos: [lx, ly, fx.light.radius, fx.light.height], col: [...rgbOf(fx.light.color), fx.light.power], cone: [0, 0, -2, -2] });
      power0.push(fx.light.power * fx.light.radius);
    }
    if (dark && b.ship) {
      const fx2 = Math.sin(a), fy2 = -Math.cos(a), r = b.radius;
      it.fx.push(beam(r, env));
      const [bx, by] = rot(it, 0, -r * 0.9);
      lights.push({ pos: [bx, by, 1500 + r * 4, 45], col: [1, 0xf0 / 255, 0xd6 / 255, 1.5], cone: [fx2, fy2, Math.cos(0.4), Math.cos(0.4 * 0.55)] });
      lights.push({ pos: [it.x, it.y, r * 2.4 + 60, r], col: [0xd6 / 255, 0xe2 / 255, 1, 0.5], cone: [0, 0, -2, -2] });
      power0.push(1.5 * (1500 + r * 4), 0.5 * (r * 2.4 + 60));
    }
  });
  // (the strongest few that reach it: the shader takes sixteen)
  if (lights.length > 16) {
    const order = lights.map((l, i) => i).sort((x, y) => power0[y] - power0[x]).slice(0, 16);
    const keep = order.map((i) => lights[i]);
    lights.length = 0; lights.push(...keep);
  }
  // (the guns' tint: the light over the hull, at its middle)
  if (dark && items[0]?.built.ship) for (let i = 0; i < 3; i++) level[i] = Math.min(1.6, level[i] + 0.5 * [0xd6 / 255, 0xe2 / 255, 1][i]);
  const bg: [number, number, number] = p.bg === 'transparent' ? [0, 0, 0] : p.bg === 'dark' ? [0x05 / 255, 0x07 / 255, 0x0b / 255] : [0, 0, 0];
  const skyU = p.bg === 'starfield' ? skyUniforms(p.sky, W, H, zoom / p.scale, cam, 1.5) : null;
  const toPx = (x: number, y: number) => ({ x: w / 2 + (x - cam[0]) * zoom, y: h / 2 + (y - cam[1]) * zoom });
  const labels = labelled ? items.map((it) => ({ text: it.label ?? '', ...toPx(it.x, labelY(it)) })) : [];
  const view: View = { w, h, zoom, cam, angle: a, transparent: p.bg === 'transparent', bg, ambient, sun, sunColor: lw.color, sunElev: [Math.cos(elev), Math.sin(elev)], level, lights, labels, heat: p.heat, bloom: p.bloom, sky: skyU, css: { w: W, h: H, zoom: zoom / p.scale } };
  return { items, view, missing };
}
