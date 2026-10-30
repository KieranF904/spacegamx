#!/usr/bin/env node
// The native asset renderer's CLI (no browser): asks the warm service (service.ts) for a PNG, starting it if it isn't up.
//
//   node scripts/native-render/render.mjs ship:sparrow-t --out sparrow.png
//   node scripts/native-render/render.mjs boss:scrap_mother --zoom 0.5 --light hangar --bg transparent --scale 2 --out sm.png
//   node scripts/native-render/render.mjs sheet:materials --out mats.png      (sheets and comma lists: a labelled grid)
//   node scripts/native-render/render.mjs --start | --stop | --status         (the service; it stays warm until stopped)
//   ... --rebuild                                                           (bundle the service afresh: it does so itself when a source is newer)
//   ... --once                                                               (stop the service again afterwards)
//
// Flags are the viewer's params (client/src/viewer/params.ts): zoom, angle, light (sun hangar nebula dark flat), lightDir,
// lightPower, ambient, elevation, bg (transparent dark starfield*), damage, seed, aim, tint, facing, stub, labels, cols,
// w, h, scale; plus samples (MSAA, default 8) and compress (PNG level 0-9, default 1). *starfield: a flat deep-space fill.
// The page for browsing: http://127.0.0.1:5311/ while the service runs.
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { BASE, health, start as startService, stop } from './client.mjs';

const argv = process.argv.slice(2);
const params = new URLSearchParams(), rest = {};
const words = [];
const LOCAL = new Set(['out', 'start', 'stop', 'status', 'once', 'rebuild']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { words.push(a); continue; }
  let [k, v] = a.slice(2).split(/=(.*)/s, 2);
  if (v === undefined) {
    if (k.startsWith('no-')) { k = k.slice(3); v = '0'; }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && !['start', 'stop', 'status', 'once', 'rebuild'].includes(k)) v = argv[++i];
    else v = '1';
  }
  if (LOCAL.has(k)) rest[k] = v; else params.set(k, v);
}
if (!params.has('asset') && words.length) params.set('asset', words.shift());

if (rest.stop) { await stop(); process.exit(0); }
if (rest.status) { console.log(JSON.stringify(await health() ?? { running: false }, null, 2)); process.exit(0); }
const up = await startService({ rebuild: !!rest.rebuild });
if (rest.start && !params.has('asset')) { console.log(`${BASE}/  (pid ${up.pid}, GL worker pid ${up.glPid})`); process.exit(0); }
if (!params.has('asset')) { console.error('usage: render.mjs <asset id> [--flags] [--out file.png]   (or --start / --stop / --status)'); process.exit(2); }

const t0 = Date.now();
const res = await fetch(`${BASE}/render?${params}`);
if (!res.ok) { console.error(`[native-render] ${res.status}: ${await res.text()}`); process.exit(1); }
const png = Buffer.from(await res.arrayBuffer());
const out = resolve(rest.out ?? `${params.get('asset').replace(/[^A-Za-z0-9_-]+/g, '_')}.png`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`${out}  ${Date.now() - t0} ms round trip (service: ${res.headers.get('x-render-total-ms')} ms; build ${res.headers.get('x-render-build-ms')}, gpu ${res.headers.get('x-render-gpu-ms')}, png ${res.headers.get('x-render-png-ms')}) ${res.headers.get('x-render-info')}`);
if (rest.once) await stop();
