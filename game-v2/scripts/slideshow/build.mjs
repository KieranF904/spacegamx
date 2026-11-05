// Builds a click-through slideshow (slideshow.html) in a folder of images, for recording dev videos.
//   node scripts/slideshow/build.mjs <folder>            build only (open slideshow.html; flags stay in that browser)
//   node scripts/slideshow/build.mjs <folder> --serve    build and serve it on http://localhost:5390 (flags save to <folder>/flags.json)
// Order: the folder's order.txt if it has one (one file name per line, # comments allowed); otherwise images are grouped
// by topic (the name without -before / -after / a variant), each topic's before first, then its after(s), topics A-Z.
// In the page: Space / → next, ← back, wheel zoom, drag to pan, 0 or double-click to reset, F full screen, C caption,
// M switches between Present (hidden slides skipped) and Review (every slide; X hide from Present, R flag for Claude to
// review, N a note on the flag). flags.json: { "<file>": { "hide": true, "review": true, "note": "..." } }.
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = process.argv[2];
const serve = process.argv.includes('--serve');
const port = Number(process.env.SLIDESHOW_PORT ?? 5390);
if (!dir || !fs.existsSync(dir)) { console.error('Usage: node scripts/slideshow/build.mjs <folder of images> [--serve]'); process.exit(1); }
const images = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));

let order;
const orderFile = path.join(dir, 'order.txt');
if (fs.existsSync(orderFile)) {
  order = fs.readFileSync(orderFile, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  const missing = order.filter((f) => !images.includes(f));
  if (missing.length) { console.error(`order.txt names files that aren't there: ${missing.join(', ')}`); process.exit(1); }
  const left = images.filter((f) => !order.includes(f));
  if (left.length) console.log(`Not in order.txt, added at the end: ${left.join(', ')}`);
  order = [...order, ...left.sort()];
} else {
  const topic = (f) => f.replace(/\.[^.]+$/, '').replace(/-(before|after)$/, '').replace(/-[^-]+-after$/, '');
  const rank = (f) => (/-before\.[^.]+$/.test(f) ? 0 : /-after\.[^.]+$/.test(f) && !/-[^-]+-after\./.test(f) ? 1 : 2);
  order = [...images].sort((a, b) => topic(a).localeCompare(topic(b)) || rank(a) - rank(b) || a.localeCompare(b));
}

const flagsFile = path.join(dir, 'flags.json');
const flags = fs.existsSync(flagsFile) ? JSON.parse(fs.readFileSync(flagsFile, 'utf8')) : {};

const template = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'template.html'), 'utf8');
const list = order.map((f) => `  ${JSON.stringify(f)},`).join('\n');
const html = template
  .replace(/const SLIDES = \[[\s\S]*?\n\];/, `const SLIDES = [\n${list}\n];`)
  .replace(/const SAVED_FLAGS = .*;/, `const SAVED_FLAGS = ${JSON.stringify(flags)};`)
  .replace(/const DECK = .*;/, `const DECK = ${JSON.stringify(path.resolve(dir))};`);
fs.writeFileSync(path.join(dir, 'slideshow.html'), html);
console.log(`${order.length} slides -> ${path.join(dir, 'slideshow.html')}`);

if (serve) {
  const types = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json' };
  http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1)) || 'slideshow.html';
    if (req.method === 'PUT' && name === 'flags.json') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { fs.writeFileSync(flagsFile, JSON.stringify(JSON.parse(body), null, 2) + '\n'); res.writeHead(204).end(); }
        catch { res.writeHead(400).end(); }
      });
      return;
    }
    const file = path.join(dir, path.basename(name)); // the folder only, no subpaths
    if (req.method !== 'GET' || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, '127.0.0.1', () => console.log(`Serving on http://localhost:${port}/ (flags save to ${flagsFile}; Ctrl+C to stop)`));
}
