/**
 * Stills of the redesigned Heart of the Maw (DESIGN ONLY) through the native renderer, without ever putting its files in
 * the game's data folders: a private copy of the native render service is bundled (esbuild, as
 * scripts/native-render/build.mjs does) with its `__dirname` pointing into a mirror folder outside the tree, whose
 * data/ships holds copies of the ship tables plus the design's pieces and blueprints from docs/bosses/maw-heart/. It
 * runs on its own port (5317 by default, MAW_RENDER_PORT), is asked for each still, and is stopped (and its process
 * killed by pid) at the end, whatever happens.
 *
 *   node scripts/bespoke/maw_heart.mjs && node scripts/bespoke/maw_heart_render.mjs [outDir] [mirrorDir]
 *   (outDir default docs/panels/2026-11-04/bosses/maw-heart; mirrorDir default <os tmp>/maw-heart-render)
 */
import { spawn } from 'child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(process.argv[2] ?? join(root, 'docs/panels/2026-11-04/bosses/maw-heart'));
const M = resolve(process.argv[3] ?? join(tmpdir(), 'maw-heart-render'));
const PORT = Number(process.env.MAW_RENDER_PORT ?? 5317);
const BASE = `http://127.0.0.1:${PORT}`;
const DESIGN = join(root, 'docs/bosses/maw-heart');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the mirror: its own data/ships, the game's client source and node_modules by junction (read only) ----
rmSync(join(M, 'data'), { recursive: true, force: true });
const ships = join(M, 'data/ships');
mkdirSync(join(ships, 'bespoke'), { recursive: true });
mkdirSync(join(ships, 'blueprints/maw'), { recursive: true });
for (const f of ['tuning.json', 'pieces.json', 'functions.json', 'materials.json', 'models.json']) copyFileSync(join(root, 'data/ships', f), join(ships, f));
copyFileSync(join(DESIGN, 'maw_heart.pieces.json'), join(ships, 'bespoke/maw_heart.json'));
for (const f of readdirSync(DESIGN).filter((f) => /^maw_heart.*\.json$/.test(f) && !f.includes('pieces'))) copyFileSync(join(DESIGN, f), join(ships, 'blueprints/maw', f));
// (the live Heart's design too, for a before still at the same scale)
copyFileSync(join(root, 'data/ships/blueprints/enemy/maw_heart_titan.json'), join(ships, 'blueprints/maw/maw_heart_titan.json'));
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
});

// ---- the stills: [file, design, params] ----
const common = { zoom: 'fit', w: 1400, h: 1400, scale: 1, bg: 'starfield', sky: 'the_maw', samples: 8 };
const SHOTS = [
  ['maw-heart-before', 'maw_heart_titan', { light: 'sun', heat: 1, damage: 0, lightDir: 300, zoom: 0.25 }],
  ['maw-heart-after', 'maw_heart', { light: 'sun', heat: 1, damage: 0, lightDir: 300, zoom: 0.25 }],
  ['maw-heart-dormant', 'maw_heart_dormant', { light: 'dark', heat: 0, damage: 0.15, lightDir: 300 }],
  ['maw-heart-active', 'maw_heart', { light: 'sun', heat: 1, damage: 0, lightDir: 300 }],
  ['maw-heart-stage1-calving', 'maw_heart_cracked', { light: 'sun', heat: 1, damage: 0.35, lightDir: 300 }],
  ['maw-heart-stage2-chambers', 'maw_heart_chambers', { light: 'sun', heat: 1, damage: 0.1, lightDir: 300 }],
  ['maw-heart-stage3-node', 'maw_heart_node', { light: 'sun', heat: 1, damage: 0.1, lightDir: 300, zoom: 0.7 }],
  ['maw-heart-dead', 'maw_heart_spent', { light: 'dark', heat: 0, damage: 0.85, lightDir: 300, zoom: 0.7 }],
];

const log = join(M, 'service.log');
const { openSync } = await import('fs');
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
    const q = new URLSearchParams(Object.entries({ ...common, ...p, asset: `ship:maw/${id}` }).map(([k, v]) => [k, String(v)]));
    const r = await fetch(`${BASE}/render?${q}`);
    if (!r.ok) throw new Error(`${file}: ${(await r.text()).slice(0, 800)}`);
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(join(outDir, `${file}.png`), buf);
    console.log(`${file}.png  ${Math.round(buf.length / 1024)} KB  ${r.headers.get('x-render-info')}`);
  }
} finally {
  try { await fetch(`${BASE}/quit`, { method: 'POST' }); } catch { /* gone */ }
  await sleep(500);
  for (const pid of [child.pid, glPid]) { try { if (pid) process.kill(pid); } catch { /* already gone */ } }
}
