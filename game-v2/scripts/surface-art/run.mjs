// Bundles stills.ts (and the game code it reads) and runs it: node scripts/surface-art/run.mjs stills|bench <out dir> [new|classic|both] [view filter]
// (as scripts/sun-sky-proto/run.mjs: the bundle lives in client/node_modules, where pixi.js resolves)
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdirSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outDir = join(root, 'client/node_modules/.surface-art');
const bundle = join(outDir, 'stills.mjs');
mkdirSync(outDir, { recursive: true });
const esbuild = await import(pathToFileURL(join(root, 'client/node_modules/esbuild/lib/main.js')).href);
await esbuild.build({
  entryPoints: [join(here, 'stills.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
  absWorkingDir: root, external: ['pixi.js'], alias: { '@space-game/common': join(root, 'common/src') },
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});
const r = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, SURFACE_ART_ROOT: root } });
process.exit(r.status ?? 1);
