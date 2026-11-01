// Builds a click-through slideshow (slideshow.html) in a folder of images, for recording dev videos.
//   node scripts/slideshow/build.mjs <folder>
// Order: the folder's order.txt if it has one (one file name per line, # comments allowed); otherwise images are grouped
// by topic (the name without -before / -after / a variant), each topic's before first, then its after(s), topics A-Z.
// In the page: Space / → next, ← back, wheel zoom, drag to pan, 0 or double-click to reset, F full screen, C caption.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error('Usage: node scripts/slideshow/build.mjs <folder of images>'); process.exit(1); }
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

const template = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'template.html'), 'utf8');
const list = order.map((f) => `  ${JSON.stringify(f)},`).join('\n');
const html = template.replace(/const SLIDES = \[[\s\S]*?\n\];/, `const SLIDES = [\n${list}\n];`);
fs.writeFileSync(path.join(dir, 'slideshow.html'), html);
console.log(`${order.length} slides -> ${path.join(dir, 'slideshow.html')}`);
