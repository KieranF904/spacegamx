/**
 * Stills of the custom enemy roster (DESIGN ONLY) through the native renderer, without ever putting a file in the
 * game's data folders: the approach of scripts/bespoke/maw_heart_render.mjs. A private copy of the native render
 * service is bundled with its `__dirname` pointing into a mirror folder outside the tree, whose data/ships holds copies
 * of the ship tables plus the designs from docs/enemies/designs/ (and, read only, the live enemy each one replaces, for
 * a before still at the same zoom). It runs on its own port (5318 by default, ENEMY_RENDER_PORT) and is stopped, its
 * processes killed by pid, at the end whatever happens.
 *
 *   node scripts/bespoke/enemies/build-all.mjs && node scripts/bespoke/enemies/render.mjs [outDir] [mirrorDir]
 *   (outDir default docs/panels/2026-11-04/enemies; mirrorDir default <os tmp>/enemy-roster-render)
 *   ONLY=id1,id2  just those designs;  REFS=1  the Pyreclast and Scrap Mother too (to judge against)
 */
import { spawn } from 'child_process';
import { readFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, copyFileSync, openSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = resolve(process.argv[2] ?? join(root, 'docs/panels/2026-11-04/enemies'));
const M = resolve(process.argv[3] ?? join(tmpdir(), 'enemy-roster-render'));
const PORT = Number(process.env.ENEMY_RENDER_PORT ?? 5318);
const BASE = `http://127.0.0.1:${PORT}`;
const DESIGNS = resolve(process.env.DESIGNS_DIR ?? join(root, 'docs/enemies/designs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
// (SURFACES=maw: the Maw designs, drawn with the Heart of the Maw redesign's proposed surfaces and materials, which take
// the Scrap Mother's tiles, so they get a pass of their own; without it, the other designs, then this script runs
// itself again for the Maw ones on the next port)
const SURF = process.env.SURFACES ?? '';

// ---- the mirror ----
rmSync(join(M, 'data'), { recursive: true, force: true });
const ships = join(M, 'data/ships');
const BP = join(ships, 'blueprints/cust');
mkdirSync(join(ships, 'bespoke'), { recursive: true });
mkdirSync(BP, { recursive: true });
for (const f of ['tuning.json', 'pieces.json', 'functions.json', 'materials.json', 'models.json']) copyFileSync(join(root, 'data/ships', f), join(ships, f));
const metas = readdirSync(DESIGNS).filter((f) => f.endsWith('.meta.json')).map((f) => JSON.parse(readFileSync(join(DESIGNS, f), 'utf8'))).filter((m) => (!only || only.includes(m.id)) && (m.surfaces ?? '') === SURF);
for (const m of metas) {
  copyFileSync(join(DESIGNS, `${m.id}.pieces.json`), join(ships, 'bespoke', `${m.id}.json`));
  for (const v of [m.id, `${m.id}_damaged`]) copyFileSync(join(DESIGNS, `${v}.json`), join(BP, `${v}.json`));
  if (m.replaces) copyFileSync(join(root, 'data/ships/blueprints/enemy', `${m.replaces}.json`), join(BP, `before_${m.replaces}.json`));
}
const REFS = process.env.REFS === '1';
if (REFS) for (const id of ['pyreclast', 'pyreclast_heart', 'scrap_mother']) {
  copyFileSync(join(root, 'data/ships/bespoke', `${id}.json`), join(ships, 'bespoke', `${id}.json`));
  copyFileSync(join(root, 'data/ships/blueprints/enemy', `${id}.json`), join(BP, `${id}.json`));
}
// (the Maw's proposed materials, in the mirror's table only, as scripts/bespoke/maw_heart_render.mjs adds them)
if (SURF === 'maw') {
  const mf = join(ships, 'materials.json'), mats = JSON.parse(readFileSync(mf, 'utf8')), list = mats.materials ?? mats;
  const boss = (id, name, color) => ({ id, name, exclusive: 'boss', grade: 5, output: 1.8, color, density: 1.4, toughness: 100, resist: {} });
  list.push(boss('maw_crust', 'Heart Crust', '#3e3f44'), boss('maw_heartstone', 'Heartstone', '#45464c'), boss('maw_seamglass', 'Seam Glass', '#3a2a22'),
    boss('maw_bone', 'Heart Bone', '#8c8476'), boss('maw_coreglass', 'Core Glass', '#4a3420'), boss('maw_shardglass', 'Shard Glass', '#5c5650'));
  writeFileSync(mf, JSON.stringify(mats));
}
const nr = join(M, 'scripts/native-render');
mkdirSync(nr, { recursive: true });
for (const f of ['gl_worker.py', 'ui.html']) cpSync(join(root, 'scripts/native-render', f), join(nr, f));
const link = (target, at) => { if (!existsSync(at)) { mkdirSync(dirname(at), { recursive: true }); symlinkSync(target, at, 'junction'); } };
link(join(root, 'client/src'), join(M, 'client/src'));
link(join(root, 'client/node_modules'), join(M, 'node_modules'));

// ---- the bundle ----
const esbuild = await import('esbuild');
const bundle = join(nr, 'service.mjs');
await esbuild.build({
  entryPoints: [join(root, 'scripts/native-render/service.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
  absWorkingDir: root, external: ['pixi.js'],
  alias: { '@space-game/common': join(root, 'common/src'), earcut: join(root, 'client/node_modules/earcut') },
  define: { __dirname: JSON.stringify(nr.replace(/\\/g, '/')) },
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  // (SURFACES=maw: scripts/bespoke/maw_heart_tiles.ts in place of the Scrap Mother's tiles 18-22 and the Maw materials'
  // looks in HULL_MAT, in this bundle only; the game's own sources are read, never written)
  plugins: SURF !== 'maw' ? [] : [{
    name: 'maw-surfaces',
    setup(b) {
      b.onLoad({ filter: /client[\\/]src[\\/]ships[\\/]hullTextures\.ts$/ }, (args) => {
        const src = readFileSync(args.path, 'utf8'), hook = '  if (kind >= 18) return scrapTile(kind, h, e, bump, groove);';
        if (!src.includes(hook)) throw new Error('hullTextures.ts changed: the tile hook is gone');
        return { contents: src.replace(hook, '  if (kind >= 18 && kind <= 22) return mawTile(kind, h, e, groove);\n' + hook) + '\n' + readFileSync(join(root, 'scripts/bespoke/maw_heart_tiles.ts'), 'utf8'), loader: 'ts' };
      });
      b.onLoad({ filter: /client[\\/]src[\\/]ships[\\/]hullLook\.ts$/ }, (args) => {
        const src = readFileSync(args.path, 'utf8').replace(/^\s*scrap_(iron|rust|paint|steel|seam):.*$/gm, ''), at = src.indexOf('  pyre_glass:');
        if (at < 0) throw new Error('hullLook.ts changed: HULL_MAT not found');
        const G = '[1.0, 0.7, 0.3]';
        return { contents: src.slice(0, at) + [
          `  maw_crust: { tile: 18, tint: 0.9, metal: 0.3, glow: 0.35, boost: 0.35, any: true, emit: ${G}, hot: 2.2 },`,
          `  maw_heartstone: { tile: 19, tint: 0.92, metal: 0.4, glow: 0, boost: 0.55, any: true, emit: ${G}, hot: 1.6 },`,
          `  maw_seamglass: { tile: 20, tint: 0.9, metal: 0.7, glow: 0.8, boost: 1.2, any: true, emit: ${G}, hot: 2.0 },`,
          `  maw_bone: { tile: 21, tint: 0.95, metal: 0.15, glow: 0, boost: 0.3, any: true, emit: ${G}, hot: 1 },`,
          `  maw_coreglass: { tile: 22, tint: 0.9, metal: 0.6, glow: 0, boost: 1.0, any: true, emit: ${G}, hot: 1 },`,
          `  maw_shardglass: { tile: 17, tint: 0.85, metal: 0.75, glow: 0.5, boost: 1.3, any: true, emit: ${G}, hot: 1.3 },`, ''].join('\n') + src.slice(at), loader: 'ts' };
      });
    },
  }],
});

// ---- the stills: each design intact and damaged at one zoom (its radius fills ~42% of the frame), the live enemy it
// replaces at the same zoom ----
const W = 1000;
const common = { w: W, h: W, scale: 1, bg: 'starfield', samples: 8, light: 'sun', lightDir: 300 };
const SHOTS = [];
for (const m of metas) {
  const zoom = Math.round((W / (2.6 * m.radius)) * 1000) / 1000;
  const sky = m.sky ?? 'sol';
  SHOTS.push([`${m.id}-after`, m.id, { zoom, sky, heat: 1, damage: 0 }]);
  SHOTS.push([`${m.id}-damaged`, `${m.id}_damaged`, { zoom, sky, heat: 1, damage: 0.4 }]);
  if (m.replaces) SHOTS.push([`${m.id}-before`, `before_${m.replaces}`, { zoom, sky, heat: 1, damage: 0 }]);
  // (at flight zoom: the game's default, 1, and zoomed out, 0.45; small frames, as big as it is on screen)
  SHOTS.push([`${m.id}-play`, m.id, { zoom: 1, w: 480, h: 480, sky, heat: 1, damage: 0 }], [`${m.id}-far`, m.id, { zoom: 0.45, w: 240, h: 240, sky, heat: 1, damage: 0 }]);
}
if (REFS) SHOTS.push(['ref-pyreclast', 'pyreclast', { zoom: 'fit', sky: 'ashfall_cavern', heat: 1, damage: 0 }], ['ref-scrap-mother', 'scrap_mother', { zoom: 'fit', sky: 'sol_scrap_nest', heat: 1, damage: 0 }]);

const log = join(M, 'service.log');
const fd = openSync(log, 'w');
const child = spawn(process.execPath, [bundle], { cwd: root, env: { ...process.env, NATIVE_RENDER_PORT: String(PORT), NATIVE_RENDER_IDLE_MIN: '5' }, stdio: ['ignore', fd, fd], windowsHide: true });
let glPid = null;
try {
  let up = null;
  for (let i = 0; i < 300 && !up; i++) { await sleep(100); try { up = await (await fetch(`${BASE}/health`)).json(); } catch { /* starting */ } }
  if (!up) throw new Error(`the mirror service didn't start: see ${log}`);
  glPid = up.glPid;
  mkdirSync(outDir, { recursive: true });
  for (const [file, id, p] of SHOTS) {
    const q = new URLSearchParams(Object.entries({ ...common, ...p, asset: `ship:cust/${id}` }).map(([k, v]) => [k, String(v)]));
    const r = await fetch(`${BASE}/render?${q}`);
    if (!r.ok) throw new Error(`${file}: ${(await r.text()).slice(0, 800)}`);
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(join(outDir, `${file}.png`), buf);
    console.log(`${file}.png  ${Math.round(buf.length / 1024)} KB`);
  }
} finally {
  try { await fetch(`${BASE}/quit`, { method: 'POST' }); } catch { /* gone */ }
  await sleep(500);
  for (const pid of [child.pid, glPid]) { try { if (pid) process.kill(pid); } catch { /* already gone */ } }
}
// (then the Maw designs, in their own pass)
const mawToo = !SURF && readdirSync(DESIGNS).filter((f) => f.endsWith('.meta.json')).some((f) => { const m = JSON.parse(readFileSync(join(DESIGNS, f), 'utf8')); return m.surfaces === 'maw' && (!only || only.includes(m.id)); });
if (mawToo) {
  const { spawnSync } = await import('child_process');
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), outDir, `${M}-maw`], { stdio: 'inherit', env: { ...process.env, SURFACES: 'maw', ENEMY_RENDER_PORT: String(PORT + 1) } });
  if (r.status) process.exit(r.status);
}
