/**
 * The asteroid harness: the game's own rocks (AsteroidLook.drawAsteroid, chunked as AsteroidBatch merges them) and
 * their shaders (rocks/RockMaterials.ts, read out of the source), drawn on the real GPU by harness.py through
 * moderngl, no browser. Each scene is drawn twice, before (scripts/rock-proto/baseline: the look as it was) and
 * after (the game's code as it is now), at the same camera and light, and the GPU time of the rock draws measured.
 * Run through run.mjs (it bundles this first):
 *
 *   node scripts/rock-proto/run.mjs <set> <out dir>      sets: stills | bench | panels
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { Container } from 'pixi.js';
import { asteroidComposition, hashString, mulberry32, type MiningTable } from '@space-game/common';
import { MAX_LIGHTS, fades } from '../../client/src/rendering/lighting/litShader';
import { buildRockAtlas, ROCK_MATERIALS, ROCK_TILE } from '../../client/src/rendering/rocks/rockTextures';
import { drawAsteroid as drawAfter } from '../../client/src/rendering/AsteroidLook';
import { rockUniforms as uniformsAfter, ROCK_LOD } from '../../client/src/rendering/rocks/RockMaterials';
import { drawAsteroid as drawBefore } from './baseline/AsteroidLook';
import { rockUniforms as uniformsBefore } from './baseline/RockMaterials';
import miningData from '../../data/mining.json';

const root = resolve(process.env.ROCK_PROTO_ROOT ?? '.');
const here = join(root, 'scripts/rock-proto');
const set = process.argv[2] ?? 'stills';
const out = resolve(process.argv[3] ?? join(root, '.rock-proto'));
mkdirSync(out, { recursive: true });
const SLOTS = 32;

// ---- the shaders, out of the source (as scripts/native-render/scene.ts reads the hull's)

function templates(file: string): { mat: { vert: string; frag: string }; lit: { vert: string; frag: string } } {
  const src = readFileSync(file, 'utf8');
  const body = (marker: string) => {
    const at = src.indexOf(marker);
    if (at < 0) throw new Error(`${file}: "${marker}" not found`);
    const s = src.indexOf('`', at) + 1;
    // (the closing backtick: the first one not escaped and not inside a ${...})
    let i = s, depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '$' && src[i + 1] === '{') { depth++; i++; continue; }
      if (depth && src[i] === '}') { depth--; continue; }
      if (!depth && src[i] === '`') break;
    }
    return src.slice(s, i);
  };
  const ev = (text: string, vars: Record<string, unknown>) => new Function(...Object.keys(vars), `return \`${text}\`;`)(...Object.values(vars)) as string;
  const base = { MAX_LIGHTS, fades, ROCK_MATERIALS, slots: SLOTS };
  const PICK = ev(body('const PICK ='), base), LIGHTS = ev(body('const LIGHTS ='), base);
  const FILL = src.includes('const FILL =') ? ev(body('const FILL ='), base) : '';
  const vars = { ...base, PICK, LIGHTS, FILL };
  const desk = (s: string) => s.replace(/^#version 300 es/, '#version 330 core');
  return {
    mat: { vert: desk(ev(body('const vertex = (slots: number) =>'), vars)), frag: desk(ev(body('const fragment = `'), vars)) },
    lit: { vert: desk(ev(body('const litVertex = (slots: number) =>'), vars)), frag: desk(ev(body('const litFragment = `'), vars)) },
  };
}
const SRC = {
  before: templates(join(here, 'baseline/RockMaterials.ts')),
  after: templates(join(root, 'client/src/rendering/rocks/RockMaterials.ts')),
};
const DRAW = { before: drawBefore, after: drawAfter };
const UNI = { before: uniformsBefore, after: uniformsAfter };
type Variant = 'before' | 'after';

// ---- the relief atlas

const atlasFile = join(out, 'rockAtlas.rgba');
writeFileSync(atlasFile, buildRockAtlas());

// ---- rocks

const table = miningData as unknown as MiningTable;
interface Rock { id: number; size: number; type: string; x: number; y: number; rot: number; tier: number }

/** A field's rock types by weight (mining.json fields), as the belt picks them */
function pickType(field: string, r: () => number): string {
  const w = (table as unknown as { fields: Record<string, Record<string, number>> }).fields[field];
  const tot = Object.values(w).reduce((a, b) => a + b, 0);
  let roll = r() * tot;
  for (const [id, k] of Object.entries(w)) { roll -= k; if (roll <= 0) return id; }
  return Object.keys(w)[0];
}
const SIZES: Record<string, [number, number]> = { asteroid_ice: [30, 100], asteroid_metal: [25, 80], asteroid_crystal: [20, 60], asteroid_fuel: [30, 90], asteroid_mega: [150, 300], comet: [40, 80] };
const sizeOf = (type: string, r: () => number) => { const [a, b] = SIZES[type] ?? [25, 80]; return (a + r() * (b - a)) * 2.5; };

/** `n` rocks of a field scattered over a w × h patch about (cx, cy), none overlapping */
function belt(field: string, n: number, cx: number, cy: number, w: number, h: number, seed: number, tier: number): Rock[] {
  const r = mulberry32(seed), rocks: Rock[] = [];
  for (let tries = 0; rocks.length < n && tries < n * 60; tries++) {
    const type = pickType(field, r);
    if (type === 'gas_pocket') continue;
    const size = sizeOf(type, r) * (r() < 0.12 ? 0.45 : 1);
    const x = cx + (r() - 0.5) * w, y = cy + (r() - 0.5) * h;
    if (rocks.some((o) => Math.hypot(o.x - x, o.y - y) < (o.size + size) * 0.95)) continue;
    rocks.push({ id: 1000 + Math.floor(r() * 900000), size, type, x, y, rot: r() * Math.PI * 2, tier });
  }
  return rocks;
}

// ---- jobs

interface View { w: number; h: number; zoom: number; cam: [number, number]; ambient: number[]; sunColor: number[]; elevation: number; sunR: number }
const hsl = (h: number, s: number, l: number) => {
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
};
/** A star system's light, as Renderer.setSystemLight works it out for an ordinary star (sun at the origin) */
const SOL = { ambient: [0.24, 0.245, 0.26], sunColor: hsl(42, 0.55, 0.84), elevation: 0.55, sunR: 39000 + 3000 };
const GLASSWATER = { ambient: [0.2, 0.245, 0.275], sunColor: hsl(196, 0.55, 0.84), elevation: 0.55, sunR: 39000 + 2400 };

let fileNo = 0;
/** CPU time building the rocks (drawAsteroid), per variant */
const buildMs: Record<Variant, number> = { before: 0, after: 0 };
function chunksOf(rocks: Rock[], v: Variant, view: View, greyseam = 0.35) {
  const chunks: unknown[] = [];
  for (let c = 0; c < rocks.length; c += SLOTS) {
    const part = rocks.slice(c, c + SLOTS);
    const geoms = part.map((rk) => {
      const comp = asteroidComposition(table, rk.type, `proto:${rk.id}`, rk.size, rk.tier);
      // (ROCK_GEOM=before|after: both variants with one variant's geometry, to tell the shaders' cost from the mesh's)
      const t0 = performance.now();
      const g = DRAW[(process.env.ROCK_GEOM as Variant | undefined) ?? v](new Container(), rk.id, rk.size, comp, greyseam).rock.geometry;
      buildMs[v] += performance.now() - t0;
      return g;
    });
    let verts = 0, idxs = 0;
    for (const g of geoms) { verts += g.vertexCount; idxs += g.idx.length; }
    // (attributes interleaved per vertex in the harness's order: aPosition 2, aNormal 3, aColor 4, aSlot 1, aSurf 4, aSmooth 3, aMat 4)
    const V = new Float32Array(verts * 21), I = new Uint32Array(idxs);
    let v0 = 0, i0 = 0;
    geoms.forEach((g, s) => {
      for (let k = 0; k < g.vertexCount; k++) {
        const o = (v0 + k) * 21;
        V.set(g.pos.slice(k * 2, k * 2 + 2), o); V.set(g.nrm.slice(k * 3, k * 3 + 3), o + 2); V.set(g.col.slice(k * 4, k * 4 + 4), o + 5);
        V[o + 9] = s; V.set(g.surf.slice(k * 4, k * 4 + 4), o + 10); V.set(g.smo.slice(k * 3, k * 3 + 3), o + 14); V.set(g.mat.slice(k * 4, k * 4 + 4), o + 17);
      }
      for (let k = 0; k < g.idx.length; k++) I[i0 + k] = g.idx[k] + v0;
      v0 += g.vertexCount; i0 += g.idx.length;
    });
    const file = join(out, `geom${fileNo++}.bin`);
    writeFileSync(file, Buffer.concat([Buffer.from(V.buffer), Buffer.from(I.buffer)]));
    const xform = new Array(SLOTS * 4).fill(0), fade = new Array(fades(SLOTS) * 4).fill(0);
    let biggest = 0;
    part.forEach((rk, s) => { xform.splice(s * 4, 4, rk.x, rk.y, Math.cos(rk.rot), Math.sin(rk.rot)); fade[s] = 1; biggest = Math.max(biggest, rk.size * view.zoom); });
    chunks.push({ file, verts, idxs, program: biggest >= ROCK_LOD.detailFrom ? `mat_${v}` : `lit_${v}`, xform, fade });
  }
  return chunks;
}

function job(id: string, rocks: Rock[], view: View, v: Variant, extra: Record<string, unknown> = {}) {
  const { w, h, zoom, cam } = view;
  const u = UNI[v].uniforms as Record<string, Float32Array | number>;
  // world to clip (Pixi's projection × the stage's transform, in one)
  const proj = [2 * zoom / w, 0, 0, 0, -2 * zoom / h, 0, -2 * zoom * cam[0] / w, 2 * zoom * cam[1] / h, 1];
  return {
    id: `${id}-${v}`, w, h, bg: [0.02, 0.025, 0.04], ...extra,
    uniforms: {
      uProjectionMatrix: proj, uAmbient: view.ambient, uSun: [0, 0, view.sunR, 1.0], uSunColor: view.sunColor, uSunElev: [Math.cos(view.elevation), Math.sin(view.elevation)],
      uCount: 0, uZoom: zoom, uLod: [ROCK_LOD.light, ROCK_LOD.detailFrom, ROCK_LOD.detailFull, 0],
      uMatA: Array.from(u.uMatA as Float32Array), uMatB: Array.from(u.uMatB as Float32Array), uMatC: Array.from(u.uMatC as Float32Array), uMatD: Array.from(u.uMatD as Float32Array),
      ...(extra.uniforms as object ?? {}),
    },
    chunks: chunksOf(rocks, v, view, (extra.greyseam as number) ?? 0.35),
  };
}

// The scenes: rocks in Sol's belt (x ≈ 50 000 from the sun, lit from the left), a close rock, a rich-ore rock, Glasswater
const BX = 50000;
type Scene = { id: string; rocks: Rock[]; view: View; label: string };
const scenes: Scene[] = [];
{
  // a close rock: a big chondrite, filling the view
  scenes.push({ id: 'close', label: 'A close rock (Sol)', rocks: [{ id: 7331, size: 230, type: 'asteroid_metal', x: BX, y: 0, rot: 0.6, tier: 1 }], view: { w: 1280, h: 800, zoom: 1.5, cam: [BX, 0], ...SOL } });
  // a second close rock: ice
  scenes.push({ id: 'close-ice', label: 'A close ice rock (Sol)', rocks: [{ id: 90210, size: 240, type: 'asteroid_ice', x: BX, y: 0, rot: 2.1, tier: 1 }], view: { w: 1280, h: 800, zoom: 1.4, cam: [BX, 0], ...SOL } });
  // a dense belt: ~250 rocks of Sol's belt over the view, zoomed out
  scenes.push({ id: 'belt', label: 'Sol belt, dense', rocks: belt('sol_belt', 260, BX, 0, 6600, 4100, 4242, 1), view: { w: 1280, h: 800, zoom: 0.19, cam: [BX, 0], ...SOL } });
  // a rich-ore rock: platinoid (metal, tier 6) with a gem seam roll
  const rich: Rock[] = [];
  for (let id = 500; rich.length < 1; id++) {
    const comp = asteroidComposition(table, 'rock_platinoid', `proto:${id}`, 200, 6);
    if (comp.seam) rich.push({ id, size: 200, type: 'rock_platinoid', x: BX, y: 0, rot: 1.1, tier: 6 });
  }
  scenes.push({ id: 'rich', label: 'Rich ore: platinoid (Void)', rocks: rich, view: { w: 1280, h: 800, zoom: 1.7, cam: [BX, 0], ...SOL } });
  // another system's palette: Glasswater's crystal and ice field, under its blue-white star
  scenes.push({ id: 'glasswater', label: 'Glasswater field', rocks: belt('glasswater_field', 50, BX, 0, 3000, 1900, 777, 3), view: { w: 1280, h: 800, zoom: 0.42, cam: [BX, 0], ...GLASSWATER } });
}

// Stress (bench only, to make small differences measurable): a close rock filling a 2560 × 1600 view, drawn 30 times
// a frame (the pixels' cost), and the dense belt with four ships' lights on it, drawn 10 times (the vertices' cost)
const stress: (Scene & { repeat: number; uniforms?: Record<string, number[] | number> })[] = [];
if (set === 'bench') {
  const lp = new Array(64).fill(0), lc = new Array(64).fill(0), lk = new Array(64).fill(-2);
  [[BX - 900, 300], [BX + 1200, -600], [BX + 200, 900], [BX - 2000, -1200]].forEach(([x, y], i) => { lp.splice(i * 4, 4, x, y, 2500, 120); lc.splice(i * 4, 4, 1, 0.92, 0.8, 1.2); });
  stress.push({ ...scenes[0], id: 'stress-pixels', repeat: 30, view: { ...scenes[0].view, w: 2560, h: 1600, zoom: 5 } });
  stress.push({ ...scenes[3], id: 'stress-pixels-ore', repeat: 30, view: { ...scenes[3].view, w: 2560, h: 1600, zoom: 6 } });
  stress.push({ ...scenes[1], id: 'stress-pixels-ice', repeat: 30, view: { ...scenes[1].view, w: 2560, h: 1600, zoom: 5 } });
  stress.push({ ...scenes[2], id: 'stress-vertices', repeat: 10, uniforms: { uCount: 4, uLightPos: lp, uLightCol: lc, uLightCone: lk } });
}
// `cpu`: the rocks' build time alone (drawAsteroid over the belt and Glasswater's rocks), warm, alternating, best of 8
if (set === 'cpu') {
  const rocks = [...scenes[2].rocks, ...scenes[4].rocks];
  const best: Record<Variant, number> = { before: Infinity, after: Infinity };
  for (let i = 0; i < 16; i++) {
    const v: Variant = i % 2 ? 'after' : 'before', t0 = performance.now();
    for (const rk of rocks) DRAW[v](new Container(), rk.id, rk.size, asteroidComposition(table, rk.type, `proto:${rk.id}`, rk.size, rk.tier));
    best[v] = Math.min(best[v], performance.now() - t0);
  }
  console.log(`${rocks.length} rocks built (CPU, best of 8): before ${best.before.toFixed(1)} ms, after ${best.after.toFixed(1)} ms`);
  process.exit(0);
}
const variants: Variant[] =(process.env.ROCK_VARIANTS ?? 'before,after').split(',') as Variant[];
// (alternating before and after, so drift in the GPU's clocks falls on both)
const only = process.env.ROCK_ONLY?.split(',');
const jobs = [...scenes, ...stress].filter((s) => !only || only.includes(s.id)).flatMap((s) => variants.map((v) => job(s.id, s.rocks, s.view, v, {
  out: set === 'bench' ? undefined : join(out, `${s.id}-${v}.png`), bench: set !== 'stills', label: s.label,
  repeat: (s as { repeat?: number }).repeat ?? 1, uniforms: (s as { uniforms?: object }).uniforms,
})));
const programs: Record<string, { vert: string; frag: string }> = {};
// (ROCK_VERT / ROCK_FRAG=before|after: one variant's vertex or fragment shader in both, to tell which costs)
const vs = (v: Variant) => SRC[(process.env.ROCK_VERT as Variant | undefined) ?? v].mat.vert, fs = (v: Variant) => SRC[(process.env.ROCK_FRAG as Variant | undefined) ?? v].mat.frag;
for (const v of variants) { programs[`mat_${v}`] = { vert: vs(v), frag: fs(v) }; programs[`lit_${v}`] = SRC[v].lit; }
const spec = { programs, atlas: { file: atlasFile, w: ROCK_TILE * 3, h: ROCK_TILE * 2 }, jobs, reps: Number(process.env.ROCK_REPS ?? 40) };
const specFile = join(out, 'jobs.json');
writeFileSync(specFile, JSON.stringify(spec));
console.log(`rock build (drawAsteroid, CPU): before ${buildMs.before.toFixed(1)} ms, after ${buildMs.after.toFixed(1)} ms`);
for (const s of scenes) console.log(`${s.id}: ${s.rocks.length} rocks, ${Math.ceil(s.rocks.length / SLOTS)} chunks (draws)`);
const r = spawnSync('python', [join(here, 'harness.py'), specFile, out], { stdio: 'inherit' });
process.exit(r.status ?? 1);
