/**
 * A clean picture of a bespoke design (any boss built from data/ships/bespoke):
 * each part shaded by what it is (functions.json colour and glow), lit from the
 * upper left, molten and powered parts glowing, turrets with their barrels,
 * drives with their flames, on a dark ground. Writes an SVG.
 *
 *   node scripts/bespoke/render.mjs <design id> <out.svg>   (e.g. pyreclast)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const [id = 'pyreclast', out = 'design.svg'] = process.argv.slice(2);
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf-8'));
const design = read(`data/ships/blueprints/enemy/${id}.json`);
const bespoke = new Map(read(`data/ships/bespoke/${id}.json`).pieces.map((p) => [p.id, p]));
const fns = new Map(read('data/ships/functions.json').functions.map((f) => [f.id, f]));

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const css = ([r, g, b]) => `rgb(${r | 0},${g | 0},${b | 0})`;
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const HOT = new Set(['conduit', 'generator', 'dash_coil', 'brood_bay', 'pyre_lance', 'magma_mortar', 'heat_vent', 'core']);
const PLATE = new Set(['armor', 'molten_plate', 'hull']);

// Bounds, with room round it
let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
for (const p of bespoke.values()) for (const [x, y] of p.polygon) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
const S = 22, pad = 6;
const W = (x1 - x0 + pad * 2) * S, H = (y1 - y0 + pad * 2) * S;
const X = (x) => ((x - x0 + pad) * S).toFixed(1), Y = (y) => ((y - y0 + pad) * S).toFixed(1);
const pts = (poly) => poly.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ');
const centroid = (poly) => [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];

const under = [], body = [], glow = [], top = [];
for (const part of design.parts) {
  const piece = bespoke.get(part.piece);
  const fn = fns.get(part.fn) ?? {};
  if (!piece) continue;
  const base = hex(fn.color ?? '#555555');
  const glowCol = fn.glow ? hex(fn.glow) : [255, 120, 40];
  // Plates: dark iron with a little of their colour; hot parts: their colour, lit from within
  const plate = PLATE.has(part.fn);
  const hot = HOT.has(part.fn);
  const fill = part.fn === 'core' ? [200, 214, 236] : plate ? mix([46, 40, 40], base, 0.35) : hot ? mix(base, [255, 140, 60], part.fn === 'conduit' ? 0.25 : 0.1) : base;
  const gid = `g${part.uid}`;
  under.push(`<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${css(mix(fill, [255, 245, 230], 0.22))}"/><stop offset="0.55" stop-color="${css(fill)}"/><stop offset="1" stop-color="${css(mix(fill, [0, 0, 0], 0.45))}"/></linearGradient>`);
  body.push(`<polygon points="${pts(piece.polygon)}" fill="url(#${gid})" stroke="#0b0807" stroke-width="2.2" stroke-linejoin="round"/>`);
  // An inner bevel: a lighter line just inside, for a raised plate
  const c = centroid(piece.polygon);
  const inset = piece.polygon.map(([x, y]) => [c[0] + (x - c[0]) * 0.86, c[1] + (y - c[1]) * 0.86]);
  body.push(`<polygon points="${pts(inset)}" fill="none" stroke="${css(mix(fill, [255, 255, 255], 0.28))}" stroke-opacity="0.35" stroke-width="1.2"/>`);
  if (hot && part.fn !== 'core') glow.push(`<polygon points="${pts(inset)}" fill="${css(glowCol)}" opacity="${part.fn === 'conduit' ? 0.22 : 0.42}"/>`);
  if (part.fn === 'core') glow.push(`<circle cx="${X(c[0])}" cy="${Y(c[1])}" r="${S * 2.2}" fill="#9be8ff" opacity="0.45"/>`);
  const m = piece.mount;
  if (m && part.mount === 'turret') {
    // A turret: a ring, a dome and its barrel out along its aim
    const r = (m.width / 1.6) * S, bx = m.at[0] + m.dir[0] * (m.width * 1.1), by = m.at[1] + m.dir[1] * (m.width * 1.1);
    top.push(`<line x1="${X(m.at[0])}" y1="${Y(m.at[1])}" x2="${X(bx)}" y2="${Y(by)}" stroke="#2a2d33" stroke-width="${r * 0.9}" stroke-linecap="round"/>`);
    top.push(`<line x1="${X(m.at[0])}" y1="${Y(m.at[1])}" x2="${X(bx)}" y2="${Y(by)}" stroke="#8b93a1" stroke-width="${r * 0.42}" stroke-linecap="round"/>`);
    top.push(`<circle cx="${X(m.at[0])}" cy="${Y(m.at[1])}" r="${r * 1.05}" fill="#3a3f48" stroke="#0b0807" stroke-width="2"/><circle cx="${X(m.at[0] - 0.12)}" cy="${Y(m.at[1] - 0.12)}" r="${r * 0.55}" fill="#6b7280"/>`);
  } else if (m && (fn.thrust ?? 0) > 0) {
    // A drive: its flame out of its mouth
    const w = m.width * S, len = m.width * 1.4;
    const ax = m.at[0] + m.dir[0] * len, ay = m.at[1] + m.dir[1] * len, tx = -m.dir[1] * m.width * 0.4, ty = m.dir[0] * m.width * 0.4;
    glow.push(`<polygon points="${pts([[m.at[0] + tx, m.at[1] + ty], [ax, ay], [m.at[0] - tx, m.at[1] - ty]])}" fill="${css(glowCol)}" opacity="0.7"/>`);
    glow.push(`<ellipse cx="${X(m.at[0])}" cy="${Y(m.at[1])}" rx="${w * 0.42}" ry="${w * 0.16}" fill="#fff1d6" opacity="0.85"/>`);
  } else if (m) {
    // A mouth (bays, mortars, the lance): a glowing slot
    glow.push(`<circle cx="${X(m.at[0])}" cy="${Y(m.at[1])}" r="${S * Math.min(1.4, m.width * 0.5)}" fill="${css(glowCol)}" opacity="0.8"/>`);
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<radialGradient id="ground" cx="0.5" cy="0.48" r="0.75"><stop offset="0" stop-color="#1d1614"/><stop offset="1" stop-color="#07080b"/></radialGradient>
<filter id="bloom" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${S * 0.55}"/></filter>
<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${S * 0.9}"/></filter>
${under.join('')}
</defs>
<rect width="100%" height="100%" fill="url(#ground)"/>
<g transform="translate(${S * 1.2},${S * 1.6})" filter="url(#shadow)" opacity="0.55">${body.filter((_, i) => i % 2 === 0).map((s) => s.replace(/fill="url\(#g\d+\)"/, 'fill="#000"')).join('')}</g>
${body.join('')}
<g filter="url(#bloom)" style="mix-blend-mode:screen">${glow.join('')}</g>
<g style="mix-blend-mode:screen">${glow.join('')}</g>
${top.join('')}
</svg>`;
writeFileSync(out, svg);
console.log(`${design.parts.length} parts → ${out} (${Math.round(W)}×${Math.round(H)})`);
