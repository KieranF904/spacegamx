// Bundles scenes.ts (and the game code it reads) and runs it: node scripts/sun-sky-proto/run.mjs <set> [out dir]
// The bundle lives in client/node_modules (where `pixi.js`, which the sky's noise module imports, resolves), as the
// native renderer's does.
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outDir = join(root, 'client/node_modules/.sun-sky-proto');
const bundle = join(outDir, 'scenes.mjs');
mkdirSync(outDir, { recursive: true });
const esbuild = await import(join(root, 'client/node_modules/esbuild/lib/main.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
await esbuild.build({
  entryPoints: [join(here, 'scenes.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
  absWorkingDir: root, external: ['pixi.js'], alias: { '@space-game/common': join(root, 'common/src') },
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});
const r = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, SUN_SKY_ROOT: root } });
process.exit(r.status ?? 1);
