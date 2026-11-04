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
import { readFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'fs';
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
// (its proposed materials, in the mirror's table only: the game's own is untouched)
{
  const mf = join(ships, 'materials.json'), mats = JSON.parse(readFileSync(mf, 'utf8')), list = mats.materials ?? mats;
  const boss = (id, name, color, density, toughness, resist) => ({ id, name, exclusive: 'boss', grade: 5, output: 1.8, color, density, toughness, resist });
  list.push(
    boss('maw_crust', 'Heart Crust', '#3e3f44', 1.6, 110, { thermal: 0.95, energy: 1.05 }),
    boss('maw_heartstone', 'Heartstone', '#45464c', 1.9, 120, { kinetic: 0.9, exotic: 1.1 }),
    boss('maw_seamglass', 'Seam Glass', '#3a2a22', 1.3, 96, { energy: 0.85, thermal: 1.1 }),
    boss('maw_bone', 'Heart Bone', '#8c8476', 1.1, 90, { kinetic: 1.05 }),
    boss('maw_coreglass', 'Core Glass', '#4a3420', 1.3, 96, { energy: 0.85 }),
    boss('maw_shardglass', 'Shard Glass', '#5c5650', 1.4, 92, { kinetic: 1.1, thermal: 0.9 }),
  );
  writeFileSync(mf, JSON.stringify(mats));
}
for (const f of readdirSync(DESIGN).filter((f) => /^maw_heart.*\.json$/.test(f) && !f.includes('pieces'))) copyFileSync(join(DESIGN, f), join(ships, 'blueprints/maw', f));
// (the live Heart's design too, for a before still at the same scale)
copyFileSync(join(root, 'data/ships/blueprints/enemy/maw_heart_titan.json'), join(ships, 'blueprints/maw/maw_heart_titan.json'));
// (EXTRA=<dir>: test designs too, its *.pieces.json as bespoke pieces, its other *.json as designs; SHOTS_JSON=<file>: the shots to take instead)
if (process.env.EXTRA) for (const f of readdirSync(process.env.EXTRA).filter((f) => f.endsWith('.json'))) copyFileSync(join(process.env.EXTRA, f), f.endsWith('.pieces.json') ? join(ships, 'bespoke', f.replace('.pieces', '')) : join(ships, 'blueprints/maw', f));
// (REFS=1: the Pyreclast and the Scrap Mother as well, to judge it against)
const REFS = process.env.REFS === '1';
if (REFS) for (const id of ['pyreclast', 'pyreclast_heart', 'scrap_mother']) {
  copyFileSync(join(root, 'data/ships/bespoke', `${id}.json`), join(ships, 'bespoke', `${id}.json`));
  copyFileSync(join(root, 'data/ships/blueprints/enemy', `${id}.json`), join(ships, 'blueprints/maw', `${id}.json`));
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
  // (its proposed surfaces, in this bundle only: scripts/bespoke/maw_heart_tiles.ts in place of the Scrap Mother's tiles
  // 18-21, and the proposed materials' looks in HULL_MAT. The game's own sources are read, never written)
  plugins: [{
    name: 'maw-heart-surfaces',
    setup(b) {
      b.onLoad({ filter: /client[\\/]src[\\/]ships[\\/]hullTextures\.ts$/ }, (args) => {
        let src = readFileSync(args.path, 'utf8');
        const hook = '  if (kind >= 18) return scrapTile(kind, h, e, bump, groove);';
        if (!src.includes(hook)) throw new Error('hullTextures.ts changed: the tile hook is gone');
        src = src.replace(hook, '  if (kind >= 18 && kind <= 22) return mawTile(kind, h, e, groove);\n' + hook);
        return { contents: src + '\n' + readFileSync(join(root, 'scripts/bespoke/maw_heart_tiles.ts'), 'utf8'), loader: 'ts' };
      });
      // (smooth glows and veins: scripts/bespoke/maw_heart_relief.ts in place of the stacked discs and the stepped bars)
      b.onLoad({ filter: /client[\\/]src[\\/]ships[\\/]bespokeRelief\.ts$/ }, (args) => {
        let src = readFileSync(args.path, 'utf8');
        const a = src.indexOf("    case 'vein':"), z = src.indexOf("    case 'cable':");
        if (a < 0 || z < a || !src.includes('function glowDisc(')) throw new Error('bespokeRelief.ts changed: the vein or glow code is gone');
        src = src.slice(0, a) + "    case 'vein':\n      if (poly && poly.length >= 4) mawVein(g, poly, w, own ?? col.glow, col.body);\n      break;\n" + src.slice(z);
        src = src.replace('function glowDisc(', 'function glowDiscStacked(');
        src += '\nfunction glowDisc(g: ShipGeometry, x: number, y: number, r: number, sides: number, rim: number, rot = 0): void { mawGlow(g, x, y, r, sides, rim, rot); }\n';
        return { contents: src + readFileSync(join(root, 'scripts/bespoke/maw_heart_relief.ts'), 'utf8'), loader: 'ts' };
      });
      b.onLoad({ filter: /client[\\/]src[\\/]ships[\\/]hullLook\.ts$/ }, (args) => {
        let src = readFileSync(args.path, 'utf8').replace(/^\s*scrap_(iron|rust|paint|steel|seam):.*$/gm, '');
        const at = src.indexOf('  pyre_glass:');
        if (at < 0) throw new Error('hullLook.ts changed: HULL_MAT not found');
        const GOLD = '[1.0, 0.7, 0.3]';
        src = src.slice(0, at) + [
          `  maw_crust: { tile: 18, tint: 0.9, metal: 0.3, glow: 0.35, boost: 0.35, any: true, emit: ${GOLD}, hot: 2.2 },`,
          `  maw_heartstone: { tile: 19, tint: 0.92, metal: 0.4, glow: 0, boost: 0.55, any: true, emit: ${GOLD}, hot: 1.6 },`,
          `  maw_seamglass: { tile: 20, tint: 0.9, metal: 0.7, glow: 0.8, boost: 1.2, any: true, emit: ${GOLD}, hot: 2.0 },`,
          `  maw_bone: { tile: 21, tint: 0.95, metal: 0.15, glow: 0, boost: 0.3, any: true, emit: ${GOLD}, hot: 1 },`,
          `  maw_coreglass: { tile: 22, tint: 0.9, metal: 0.6, glow: 0, boost: 1.0, any: true, emit: ${GOLD}, hot: 1 },`,
          `  maw_shardglass: { tile: 17, tint: 0.85, metal: 0.75, glow: 0.5, boost: 1.3, any: true, emit: ${GOLD}, hot: 1.3 },`,
          '',
        ].join('\n') + src.slice(at);
        return { contents: src, loader: 'ts' };
      });
    },
  }],
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
  ['maw-heart-dead', 'maw_heart_spent', { light: 'dark', heat: 0, damage: 0.5, lightDir: 300, zoom: 0.7 }],
  // (close-ups at play distance: a patch of the crust round a cap and a knot, a chamber, the core)
  ['maw-heart-closeup-crust', 'maw_heart', { light: 'sun', heat: 1, damage: 0, lightDir: 300, zoom: 1.5, x: -420, y: -760, w: 1400, h: 1000 }],
  ['maw-heart-closeup-chamber', 'maw_heart_chambers', { light: 'sun', heat: 1, damage: 0, lightDir: 300, zoom: 1.4, x: -820, y: 0, w: 1400, h: 1000 }],
  ['maw-heart-closeup-core', 'maw_heart_node', { light: 'sun', heat: 1, damage: 0, lightDir: 300, zoom: 1.35, w: 1400, h: 1100 }],
  ...(REFS ? [['ref-pyreclast', 'pyreclast', { light: 'sun', heat: 1, damage: 0, lightDir: 300 }], ['ref-scrap-mother', 'scrap_mother', { light: 'sun', heat: 1, damage: 0, lightDir: 300 }]] : []),
].concat(process.env.SHOTS_JSON ? JSON.parse(readFileSync(process.env.SHOTS_JSON, 'utf8')) : []).filter(([f]) => !process.env.ONLY || process.env.ONLY.split(',').some((o) => f.includes(o)));

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
