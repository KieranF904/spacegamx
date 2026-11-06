/**
 * The Database's component pictures, drawn by the game itself.
 *
 *   cd game-v2/site && npm run build-part-images      (then: npm run build-catalog)
 *
 * Bundles scripts/part-images/entry.browser.ts (the game client's component guide drawing: client/src/ui/
 * componentSprites.ts, itemIcons.ts, ships/partDecor.ts) with esbuild, runs it in one headless Chrome
 * (scripts/render/cdp.mjs; closed at the end), and writes:
 *   site/public/img/parts/<row>.webp   every component guide row's picture (models, the core, structure per material)
 *   site/public/img/items/<item>.webp  every item's icon (the cost chips)
 *   site/catalog/guide.json            the rows: tab, level, picture, cost, and the guide's short lines (no descriptions)
 * build-catalog.ts folds guide.json into the catalog. Same game data and the same Chrome give the same files.
 * CHROME=<path> picks the browser (default: the one scripts/render/cdp.mjs uses).
 */

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from '../../scripts/render/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(here, '..');
const root = path.resolve(siteDir, '..');
const imgDir = path.join(siteDir, 'public/img');
const guideFile = path.join(siteDir, 'catalog/guide.json');

// ---------------------------------------------------------------- bundle the client's drawing code

/** The client keeps pictures between visits (IndexedDB): here every one is drawn fresh */
const freshPictures = {
  name: 'fresh-pictures',
  setup(b) {
    b.onResolve({ filter: /assets[\\/]pictureSheet$/ }, () => ({ path: 'pictureSheet', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export function pictureSheet() { const m = new Map(); return { get: (k) => m.get(k), add: (k, v) => { m.set(k, v); } }; }',
      loader: 'js',
    }));
  },
};

const bundle = await build({
  entryPoints: [path.join(here, 'part-images/entry.browser.ts')],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
  alias: { '@space-game/common': path.join(root, 'common/src/index.ts') },
  plugins: [freshPictures],
});
const code = bundle.outputFiles[0].text;

const bespokeDir = path.join(root, 'data/ships/bespoke');
const bespoke = fs.existsSync(bespokeDir)
  ? fs.readdirSync(bespokeDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(bespokeDir, f), 'utf8')))
  : [];

// ---------------------------------------------------------------- draw them in Chrome

const page = await launch({ width: 800, height: 600 });
let result;
try {
  await page.evaluate(code);
  result = await page.evaluate(`window.runPartImages(${JSON.stringify(bespoke)})`, 300000);
} catch (e) {
  console.error(page.logs.slice(-20).join('\n'));
  throw e;
} finally {
  page.close();
}

// ---------------------------------------------------------------- write

// (Only the pictures this script makes: the folders are its own)
for (const sub of ['parts', 'items']) {
  const dir = path.join(imgDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.webp')) fs.unlinkSync(path.join(dir, f));
}
let bytes = 0;
for (const { file, data } of result.files) {
  const m = /^data:image\/webp;base64,(.+)$/.exec(data);
  if (!m) throw new Error(`${file}: the browser did not make a WebP`);
  const buf = Buffer.from(m[1], 'base64');
  bytes += buf.length;
  fs.writeFileSync(path.join(imgDir, file), buf);
}
fs.writeFileSync(guideFile, JSON.stringify(result.guide, null, 1) + '\n');
const rows = result.guide.rows.length, items = Object.keys(result.guide.items).length;
console.log(`part images: ${rows} components, ${items} items, ${Math.round(bytes / 1024)} KB -> ${path.relative(process.cwd(), imgDir)}; ${path.relative(process.cwd(), guideFile)}`);
