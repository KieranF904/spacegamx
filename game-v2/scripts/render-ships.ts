// Draw ship designs (hull, parts and their hardware) to a PNG, to check how they look:
//   npx vite-node scripts/render-ships.ts out.png sparrow-t corsair enemy/pirate_gunship ...
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { deflateSync } from 'zlib';
import { loadCatalog, parseBlueprint, partMount, placeGeometry } from '../common/src/index';
import { loadShipConfigFromDisk } from '../server/src/ships/loadShipConfig';
import { partDecor, barrelPoints, turretBarrel } from '../client/src/ships/partDecor';
import { functionColor } from '../client/src/ships/shipColors';

const data = join(__dirname, '../data');
const raw = loadShipConfigFromDisk(data);
const catalog = loadCatalog(raw.catalog, { overlapShrink: raw.tuning.overlapShrink });
const [out, ...names] = process.argv.slice(2);
const PX = Number(process.env.PX ?? 26), PAD = 24, COLS = Math.min(4, names.length);

const ships = names.map((n) => parseBlueprint(readFileSync(n.endsWith('.json') ? n : join(data, 'ships/blueprints', `${n}.json`), 'utf8')));
const boxes = ships.map((bp) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of bp.parts) for (const [x, y] of placeGeometry(catalog, p).polygon) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0: x0 - 1, y0: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 };
});
const cellW = Math.max(...boxes.map((b) => b.w)) * PX + PAD, cellH = Math.max(...boxes.map((b) => b.h)) * PX + PAD;
const W = Math.ceil(cellW * COLS), H = Math.ceil(cellH * Math.ceil(ships.length / COLS));
const img = new Uint8Array(W * H * 3).fill(10);

function fillPoly(pts: number[], color: number): void {
  const n = pts.length / 2;
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < n; i++) { ymin = Math.min(ymin, pts[i * 2 + 1]); ymax = Math.max(ymax, pts[i * 2 + 1]); }
  for (let y = Math.max(0, Math.floor(ymin)); y <= Math.min(H - 1, Math.ceil(ymax)); y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[((i + 1) % n) * 2], by = pts[((i + 1) % n) * 2 + 1];
      if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) xs.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(W - 1, Math.floor(xs[k + 1] - 0.5)); x++) {
        const o = (y * W + x) * 3;
        img[o] = (color >> 16) & 255; img[o + 1] = (color >> 8) & 255; img[o + 2] = color & 255;
      }
    }
  }
}
const disc = (x: number, y: number, r: number, color: number) => {
  const pts: number[] = [];
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; pts.push(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  fillPoly(pts, color);
};
const darken = (c: number, k: number) => (((c >> 16 & 255) * k) << 16) | (((c >> 8 & 255) * k) << 8) | ((c & 255) * k);

ships.forEach((bp, s) => {
  const b = boxes[s];
  const ox = (s % COLS) * cellW + PAD / 2, oy = Math.floor(s / COLS) * cellH + PAD / 2;
  const map = (x: number, y: number) => [ox + (x - b.x0) * PX, oy + (y - b.y0) * PX];
  const mp = (pts: number[]) => pts.flatMap((v, i) => (i % 2 ? [] : map(v, pts[i + 1])));
  for (const p of bp.parts) {
    const g = placeGeometry(catalog, p);
    fillPoly(mp(g.polygon.flat()), darken(functionColor(p.fn), 0.55));
    // A slightly inset panel so parts read apart
    const c = g.centroid;
    fillPoly(mp(g.polygon.flatMap(([x, y]) => [c[0] + (x - c[0]) * 0.88, c[1] + (y - c[1]) * 0.88])), functionColor(p.fn));
  }
  for (const p of bp.parts) {
    const g = placeGeometry(catalog, p);
    const d = partDecor(g);
    for (const br of d.barrels) fillPoly(mp(barrelPoints(br)), 0x8b93a1);
    if (partMount(catalog, p) === 'turret' && p.facing) {
      const n = ({ N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] } as Record<string, number[]>)[p.facing], t = [-n[1], n[0]], c = g.centroid;
      for (const sh of turretBarrel(p.fn, 0.8 * Math.sqrt(Math.max(1, g.area)), g.area)) {
        const pts: number[] = [];
        for (let i = 0; i < sh.length; i += 2) pts.push(c[0] + n[0] * sh[i] + t[0] * sh[i + 1], c[1] + n[1] * sh[i] + t[1] * sh[i + 1]);
        fillPoly(mp(pts), 0xa0a8b6);
      }
    }
    for (const q of d.polys) fillPoly(mp(q.pts), q.color);
    for (const q of d.discs) { const [x, y] = map(q.x, q.y); disc(x, y, q.r * PX, q.color); }
  }
});

// PNG
const rows = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { rows[y * (W * 3 + 1)] = 0; Buffer.from(img.buffer, y * W * 3, W * 3).copy(rows, y * (W * 3 + 1) + 1); }
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, body: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb)); return Buffer.concat([len, tb, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]));
console.log(`${out}: ${W}×${H}`);
