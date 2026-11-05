// Stills of the game's assets: through the NATIVE renderer by default (scripts/native-render: a warm Node + Python/OpenGL
// service, no browser, tens of ms a render, the game's own hull shader, lighting, flames, bloom and sky), started if it isn't
// running. The same CLI and flags as before; the old headless-Chrome path is still here behind an explicit --browser.
//   npm run render -- ship:sparrow-t --zoom 2 --flames 0.8 --out shot.png
//   npm run render -- sheet:models --w 2400 --h 1800 --out models.png
//   npm run render -- --batch ship:sparrow-t,ship:corsair,boss:scrap_mother --dir shots/ --light dark
//   npm run render -- --batch @list.txt --dir shots/      (a line: an asset, then its own flags: `model:laser_glint@E --zoom 4`)
//   npm run render -- --list laser | --status | --stop    (the native service; the viewer page is http://127.0.0.1:5311/)
//   npm run render -- --browser ship:corsair ...           (the old way: the render daemon's headless Chrome, which draws
//                                                           through the real client renderer; heavy: only to check the native one)
//   npm run render -- --browser --ui ship:corsair --out viewer.png   (the viewer page itself, panels and all: browser only)
// Flags are the viewer's URL params (client/src/viewer/params.ts): --zoom --angle --light --lightDir --bg --flames --boost
// --aim --grid --damage --tint --facing --stub --w --h --scale ...; booleans as --grid / --no-grid. (--grid is browser-only.)
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, openSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { flagsToParams, parseParams, toQuery } from '../../client/src/viewer/params.ts';

import { daemonUrl } from './daemonClient.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// (--browser is a bare switch: taken out before the flags are read, so it can't swallow the asset after it)
const argv = process.argv.slice(2);
const browser = argv.includes('--browser');
const { params, rest } = flagsToParams(argv.filter((a) => a !== '--browser'));
const native = await import('../native-render/client.mjs');

/** A viewer query from flags (through the parser: what the page will read) */
const queryOf = (p) => toQuery(parseParams(new URLSearchParams(Object.entries(p))));
const fileFor = (asset, scale) => `${asset.replace(/[^a-z0-9_@-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80)}${scale && scale !== '1' ? `@${scale}x` : ''}.png`;

async function shot(base, p, out, path = '/render') {
  if (!browser && path === '/ui') throw new Error('--ui (a shot of the viewer page itself) needs --browser; the native viewer page is ' + native.BASE + '/');
  const t0 = Date.now();
  const r = await fetch(`${base}${path}?${path === '/ui' ? new URLSearchParams(p) : queryOf(p)}`);
  if (!r.ok) throw new Error(`${p.asset}: ${(await r.text()).slice(0, 600)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, buf);
  const info = browser ? decodeURIComponent(r.headers.get('x-viewer-info') ?? '') : (() => { try { const i = JSON.parse(r.headers.get('x-render-info') ?? '{}'); return i.name ? `${i.name}, ${i.parts} parts` : i.items ? `${i.items} assets` : ''; } catch { return ''; } })();
  console.log(`${out}  (${Math.round(buf.length / 1024)} KB, ${Date.now() - t0} ms${info ? ` · ${info}` : ''}${r.headers.get('x-viewer-settled') === 'false' ? ' · NOT SETTLED' : ''}${browser ? '' : ` · service ${r.headers.get('x-render-total-ms')} ms`})`);
}

/** The service to ask: the native one (started), or the browser daemon */
const serviceUrl = async (startIt = true) => (browser ? daemonUrl(startIt) : startIt ? (await native.start(), native.BASE) : (await native.health()) ? native.BASE : null);

if (rest.stop && !browser) {
  await native.stop();
} else if (rest.status && !browser) {
  console.log(JSON.stringify((await native.health()) ?? { running: false }, null, 1));
} else if (rest.stop) {
  const base = await daemonUrl(false);
  if (base) {
    await fetch(`${base}/shutdown`, { method: 'POST' }).catch(() => {});
    // (gone once it stops answering)
    for (let i = 0; i < 40; i++) { await sleep(250); if (!(await fetch(`${base}/status`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false))) break; }
    console.log('stopped');
  } else console.log('not running');
} else if (rest.status) {
  const base = await daemonUrl(false);
  console.log(base ? JSON.stringify(await (await fetch(`${base}/status`)).json(), null, 1) : 'not running');
} else if ('list' in rest) {
  const base = await serviceUrl();
  const q = rest.list === '1' ? (params.asset ?? '') : rest.list;
  for (const a of await (await fetch(`${base}/assets?q=${encodeURIComponent(q)}`)).json()) console.log(`${a.id.padEnd(44)} ${a.label}  [${a.group}]`);
} else if (rest.batch) {
  const base = await serviceUrl();
  const dir = rest.dir ?? 'renders';
  const lines = rest.batch.startsWith('@') ? readFileSync(rest.batch.slice(1), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : rest.batch.split(',');
  for (const line of lines) {
    const own = flagsToParams(line.split(/\s+/));
    const p = { ...params, ...own.params };
    try { await shot(base, p, join(dir, own.rest.out ?? fileFor(p.asset, p.scale))); } catch (e) { console.error(String(e.message ?? e)); process.exitCode = 1; }
  }
} else {
  if (rest.sheet) params.asset = `sheet:${rest.sheet}`;
  if (!params.asset) { console.error('usage: npm run render -- <asset> [--flags] [--out file.png] | --batch a,b | --list [q] | --ui | --stop'); process.exit(2); }
  const base = await serviceUrl();
  // (--ui is the viewer's own param too: here, a shot of the whole page)
  const page = 'ui' in params && params.ui !== '0';
  delete params.ui;
  if (page && !browser) { console.error(`--ui (a shot of the viewer page itself) needs --browser; the native viewer page is ${native.BASE}/, to open in your own browser`); process.exit(2); }
  if (page) await shot(base, params, rest.out ?? `viewer-${fileFor(params.asset)}`, '/ui');
  else await shot(base, params, rest.out ?? fileFor(params.asset, params.scale));
}
