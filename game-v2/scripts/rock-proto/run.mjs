// Bundles scenes.ts (and the game code it reads) and runs it: node scripts/rock-proto/run.mjs <set> [out dir]
// (the same arrangement as scripts/planet-proto/run.mjs; the bundle lives in client/node_modules)
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outDir = join(root, 'client/node_modules/.rock-proto');
const bundle = join(outDir, 'scenes.mjs');
mkdirSync(outDir, { recursive: true });
const esbuild = await import(join(root, 'client/node_modules/esbuild/lib/main.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
await esbuild.build({
  entryPoints: [join(here, 'scenes.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
  absWorkingDir: root, external: ['pixi.js'], alias: { '@space-game/common': join(root, 'common/src') },
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});
const r = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit', cwd: join(root, 'client'), env: { ...process.env, ROCK_PROTO_ROOT: root } });
process.exit(r.status ?? 1);
