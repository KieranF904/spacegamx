// The native renderer's service, from the outside: find it, start it (detached: it outlives the caller) if it isn't up, stop it.
// Shared by native-render/render.mjs and scripts/render/render.mjs (`npm run render`).
import { spawn } from 'child_process';
import { openSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { ensure } from './build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
export const PORT = Number(process.env.NATIVE_RENDER_PORT ?? 5311);
export const BASE = `http://127.0.0.1:${PORT}`;
export const LOG = join(tmpdir(), 'native-render.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function health() {
  try { return await (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })).json(); } catch { return null; }
}

/** The service's health (pids, port), starting it if it isn't up */
export async function start({ rebuild = false } = {}) {
  const h = await health();
  if (h) return h;
  const t0 = Date.now();
  const log = openSync(LOG, 'a');
  // (bundled once into plain JS, so the service is just node and python; if esbuild isn't there, vite-node runs the TypeScript)
  const bundle = await ensure(rebuild);
  const args = bundle ? [bundle] : [join(root, 'node_modules/vite-node/vite-node.mjs'), '-c', join(here, 'vite.config.ts'), join(here, 'service.ts')];
  const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  for (let i = 0; i < 300; i++) {
    await sleep(100);
    const up = await health();
    if (up) { console.error(`[native-render] started in ${Date.now() - t0} ms: ${BASE}/ (pid ${up.pid}, GL worker pid ${up.glPid}; log ${LOG})`); return up; }
  }
  throw new Error(`the service didn't start: see ${LOG}`);
}

/** Stop it, and wait until it has (so a start straight after finds it gone) */
export async function stop() {
  if (!(await health())) { console.error('[native-render] not running'); return; }
  try { await fetch(`${BASE}/quit`, { method: 'POST' }); } catch { /* */ }
  for (let i = 0; i < 40 && (await health()); i++) await sleep(100);
  console.error('[native-render] stopped');
}
