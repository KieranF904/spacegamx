#!/usr/bin/env node
/**
 * Cross-engine determinism check: npm run det:engines [-- --ticks 1200] [--no-firefox] [--no-chrome] [--keep] [--native]
 *
 * Bundles scripts/det/entry.ts (the seeded fight in scenario.ts, run with the game's real common code, the ship data
 * inlined) with esbuild into one ES module, then runs that same file in Node, in headless Chrome (scripts/render/cdp.mjs,
 * Playwright's Chromium or CHROME) and in headless Firefox (Playwright's build if it's installed, or FIREFOX; nothing is
 * downloaded), one browser at a time, each killed by PID when it's done. Each run hashes the whole state after every tick; this
 * prints, per engine, whether the hashes match Node's tick for tick (and the first tick and count that don't), and
 * whether detTrig's primitive outputs (and, for interest, native Math's) agree. Exit code 1 on any mismatch. --keep
 * leaves the bundle (its folder is printed) to open by hand. --native is the control: detTrig swapped for native Math
 * (Math.sin, Math.pow, ...) in the bundle, to see the divergence it prevents.
 *
 * What it covers and why: docs/design/deterministic-maths.md.
 */
import { build } from 'esbuild';
import { createServer } from 'http';
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { launch } from '../render/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const shipsDir = join(root, 'data/ships');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const TICKS = Number(arg('--ticks', 1200));
const NATIVE = process.argv.includes('--native');
const NATIVE_TRIG = `export const dsin = Math.sin, dcos = Math.cos, datan = Math.atan, datan2 = Math.atan2, dhypot = Math.hypot,
  dexp = Math.exp, dlog = Math.log, dlog2 = Math.log2, dpow = Math.pow, dsinh = Math.sinh, dcosh = Math.cosh, dtanh = Math.tanh,
  dasinh = Math.asinh, dlog1p = Math.log1p;
export function dsincos(x, out = [0, 0]) { out[0] = Math.sin(x); out[1] = Math.cos(x); return out; }`;
const PW = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData/Local'), 'ms-playwright');
const findIn = (prefix, rel) => {
  if (!existsSync(PW)) return null;
  const dirs = readdirSync(PW).filter((d) => d.startsWith(prefix) && !d.includes('headless')).sort().reverse();
  for (const d of dirs) { const p = join(PW, d, rel); if (existsSync(p)) return p; }
  return null;
};
const FIREFOX = process.env.FIREFOX ?? findIn('firefox-', 'firefox/firefox.exe') ?? findIn('firefox-', 'firefox/firefox');

// ---- the data the scenario needs, inlined as the virtual module det:data
const readJson = (p) => JSON.parse(readFileSync(join(shipsDir, p), 'utf-8'));
const { SHIPS } = { SHIPS: ['bulwark.json', 'hauler.json', 'sunspear.json', 'arrow.json', 'hauler.json', 'sparrow-t.json'] };
const data = {
  files: {
    pieces: readJson('pieces.json'), functions: readJson('functions.json'), materials: readJson('materials.json'), models: readJson('models.json'),
    bespoke: readdirSync(join(shipsDir, 'bespoke')).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(`bespoke/${f}`)),
  },
  tuning: readJson('tuning.json'),
  blueprints: Object.fromEntries(SHIPS.map((f) => [f, readFileSync(join(shipsDir, 'blueprints', f), 'utf-8')])),
};

const out = mkdtempSync(join(tmpdir(), 'det-engines-'));
const bundle = join(out, 'det.mjs');
await build({
  entryPoints: [join(here, 'entry.ts')], bundle: true, format: 'esm', target: 'es2022', outfile: bundle, logLevel: 'error',
  plugins: [{
    name: 'det-data',
    setup(b) {
      b.onResolve({ filter: /^det:data$/ }, () => ({ path: 'det:data', namespace: 'det' }));
      b.onLoad({ filter: /.*/, namespace: 'det' }, () => ({ contents: JSON.stringify(data), loader: 'json' }));
      // (the control: every import of math/detTrig gets native Math instead)
      if (NATIVE) {
        b.onResolve({ filter: /math\/detTrig(\.js)?$/ }, () => ({ path: 'native-trig', namespace: 'det-native' }));
        b.onLoad({ filter: /.*/, namespace: 'det-native' }, () => ({ loader: 'js', contents: NATIVE_TRIG }));
      }
    },
  }],
});
const code = readFileSync(bundle, 'utf-8');
const prelude = `globalThis.DET_TICKS = ${TICKS};\n`;
writeFileSync(bundle, prelude + code);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (pid) => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } };

// ---- Node: the same file
globalThis.DET_TICKS = TICKS;
await import(pathToFileURL(bundle).href);
const nodeRes = globalThis.__DET;
if (nodeRes.error) { console.error('node run failed:', nodeRes.error); process.exit(2); }
const results = [{ engine: `node ${process.version}`, res: nodeRes }];

// ---- browsers: a page that loads the bundle and POSTs its result back
let waiting = null;
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/result') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.end('ok'); waiting?.(JSON.parse(body)); });
    return;
  }
  if (req.url === '/det.mjs') { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(bundle)); return; }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><meta charset="utf-8"><title>det</title><script type="module" src="/det.mjs"></script>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

/** One browser run: start it (returns its close), wait for the page's POST, close it whatever happens */
async function runBrowser(name, start) {
  const got = new Promise((r) => { waiting = r; });
  let close = null;
  try {
    close = await start();
    if (!close) return;
    const r = await Promise.race([got, sleep(180000).then(() => null)]);
    if (!r) { console.log(`${name}: no result in 180 s`); return; }
    if (r.result?.error) { console.log(`${name}: run failed: ${r.result.error}`); return; }
    results.push({ engine: `${name} (${r.ua})`, res: r.result });
  } catch (e) {
    console.log(`${name}: ${e.message}`);
  } finally {
    waiting = null;
    close?.();
    await sleep(1000);
  }
}

try {
  if (!process.argv.includes('--no-chrome')) {
    await runBrowser('chrome', async () => {
      const page = await launch({ width: 400, height: 300 });
      await page.send('Page.navigate', { url });
      return () => page.close();
    });
  }
  if (!process.argv.includes('--no-firefox')) {
    await runBrowser('firefox', async () => {
      if (!FIREFOX || !existsSync(FIREFOX)) { console.log('firefox: not installed (skipped; nothing downloaded)'); return null; }
      // (a fresh profile; -no-remote so it never hands the URL to a running Firefox)
      const profile = mkdtempSync(join(tmpdir(), 'det-firefox-'));
      const proc = spawn(FIREFOX, ['-headless', '-no-remote', '-profile', profile, url], { stdio: 'ignore' });
      return () => { kill(proc.pid); setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 1500); };
    });
  }
} finally {
  server.close();
  if (process.argv.includes('--keep')) console.log(`bundle kept: ${bundle}`);
  else setTimeout(() => { try { rmSync(out, { recursive: true, force: true }); } catch {} }, 500);
}

// ---- compare with Node
const base = results[0].res;
let bad = false;
console.log(`\n${TICKS} ticks${NATIVE ? ' (CONTROL: native Math in place of detTrig)' : ''}; node stats ${JSON.stringify(base.stats)}; final hash ${base.hashes.at(-1)}\n`);
for (const { engine, res } of results) {
  let first = -1, diff = 0;
  for (let i = 0; i < base.hashes.length; i++) if (res.hashes[i] !== base.hashes[i]) { diff++; if (first < 0) first = i + 1; }
  const prim = Object.keys(base.prims).filter((k) => res.prims[k] !== base.prims[k]);
  const nat = Object.keys(base.natives).filter((k) => res.natives[k] !== base.natives[k]);
  if (diff || prim.length) bad = true;
  console.log(`${engine}`);
  console.log(`  ticks: ${diff ? `${diff} of ${TICKS} differ, first at tick ${first}` : `all ${TICKS} match`} (${res.ms} ms)`);
  console.log(`  detTrig primitives: ${prim.length ? `differ: ${prim.join(', ')}` : 'match'}; native Math (for interest): ${nat.length ? `differs: ${nat.join(', ')}` : 'matches'}`);
}
process.exit(bad ? 1 : 0);
