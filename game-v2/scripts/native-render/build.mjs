// Bundles the native renderer's Node side (service.ts and the game code it reuses) into one ES module, so the service runs as
// plain `node` (no esbuild service process beside it, no per-start transpiling). The bundle lives in client/node_modules (where
// `pixi.js`, which the game's modules import and which stays external, resolves); it's rebuilt when any source it was made from
// is newer. Shaders are not in it: they're read from the game's TypeScript each time the service starts.
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
export const OUT_DIR = join(root, 'client/node_modules/.native-render');
export const BUNDLE = join(OUT_DIR, 'service.mjs');
const INPUTS = join(OUT_DIR, 'inputs.json');

/** Is the bundle there and newer than everything it was made from? */
export function fresh() {
  try {
    const at = statSync(BUNDLE).mtimeMs;
    return JSON.parse(readFileSync(INPUTS, 'utf8')).every((f) => { try { return statSync(f).mtimeMs <= at; } catch { return false; } });
  } catch { return false; }
}

/** Build (if stale or `force`); returns the bundle's path, or null if esbuild isn't there (the caller falls back to vite-node) */
export async function ensure(force = false) {
  if (!force && fresh()) return BUNDLE;
  let esbuild;
  try { esbuild = await import('esbuild'); } catch { return null; }
  mkdirSync(OUT_DIR, { recursive: true });
  const r = await esbuild.build({
    entryPoints: [join(here, 'service.ts')], outfile: BUNDLE, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error', metafile: true,
    absWorkingDir: root, external: ['pixi.js'],
    alias: { '@space-game/common': join(root, 'common/src'), earcut: join(root, 'client/node_modules/earcut') },
    // (the service reads ui.html, gl_worker.py and the game's sources beside where it was written)
    define: { __dirname: JSON.stringify(here.replace(/\\/g, '/')) },
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  });
  writeFileSync(INPUTS, JSON.stringify(Object.keys(r.metafile.inputs).map((f) => resolve(root, f))));
  return BUNDLE;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const out = await ensure(true);
  console.log(out ? `built ${out} in ${Date.now() - t0} ms` : 'esbuild not found');
}
