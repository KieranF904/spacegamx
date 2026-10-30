/**
 * Item icons, drawn once per item on a canvas and cached as data URLs.
 * Each category has its own look; ship parts are their real piece outline
 * in the material's colour, marked with what they do.
 */

import { isWeaponFn, lookFn, placeGeometry, type Economy, type ItemDef, type PlacedPart } from '@space-game/common';
import { ENGINE_FNS, drawDecor2d } from '../ships/partDecor';

const SIZE = 64;
const cache = new Map<string, string>();

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shade(hex: string, k: number): string {
  const v = parseInt(hex.replace('#', ''), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k))));
  return `rgb(${f((v >> 16) & 255)},${f((v >> 8) & 255)},${f(v & 255)})`;
}

export function itemIcon(econ: Economy, id: string): string {
  const hit = cache.get(id);
  if (hit) return hit;
  const def = econ.items.get(id);
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d')!;
  g.translate(SIZE / 2, SIZE / 2);
  if (def) draw(g, def, econ);
  const url = c.toDataURL();
  cache.set(id, url);
  return url;
}

function draw(g: CanvasRenderingContext2D, d: ItemDef, econ: Economy): void {
  const col = d.color || '#9aa4b2';
  const r = rng(hash(d.id));
  switch (d.category) {
    case 'mineral': {
      // A lumpy rock with lit facets
      const n = 9;
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r() * 0.3;
        const rad = 17 + r() * 8;
        pts.push([Math.cos(a) * rad, Math.sin(a) * rad * 0.85]);
      }
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      const grad = g.createLinearGradient(-20, -20, 20, 20);
      grad.addColorStop(0, shade(col, 0.35));
      grad.addColorStop(1, shade(col, -0.45));
      g.fillStyle = grad;
      g.fill();
      g.strokeStyle = shade(col, -0.6);
      g.lineWidth = 1.5;
      g.stroke();
      // Facets
      g.strokeStyle = shade(col, 0.45);
      g.globalAlpha = 0.5;
      for (let i = 0; i < 3; i++) {
        const [x, y] = pts[Math.floor(r() * n)];
        g.beginPath(); g.moveTo(x * 0.3, y * 0.3); g.lineTo(x * 0.85, y * 0.85); g.stroke();
      }
      g.globalAlpha = 1;
      if (d.rarity !== 'common') {
        // Glinting flecks in better ores
        g.fillStyle = shade(col, 0.7);
        for (let i = 0; i < 6; i++) { g.beginPath(); g.arc((r() - 0.5) * 24, (r() - 0.5) * 20, 1.2 + r(), 0, Math.PI * 2); g.fill(); }
      }
      break;
    }
    case 'gem': {
      // A brilliant cut seen from above
      const R = 20;
      const outer: [number, number][] = [], inner: [number, number][] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        outer.push([Math.cos(a) * R, Math.sin(a) * R]);
        inner.push([Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5]);
      }
      g.shadowColor = col; g.shadowBlur = 12;
      g.beginPath(); outer.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
      g.fillStyle = shade(col, -0.25); g.fill();
      g.shadowBlur = 0;
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8;
        g.beginPath(); g.moveTo(outer[i][0], outer[i][1]); g.lineTo(outer[j][0], outer[j][1]); g.lineTo(inner[j][0], inner[j][1]); g.lineTo(inner[i][0], inner[i][1]); g.closePath();
        g.fillStyle = shade(col, i % 2 ? 0.15 : -0.1); g.fill();
      }
      g.beginPath(); inner.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
      g.fillStyle = shade(col, 0.4); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath(); g.arc(-6, -7, 2.5, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'volatile': {
      g.shadowColor = col; g.shadowBlur = 16;
      const grad = g.createRadialGradient(-4, -4, 2, 0, 0, 20);
      grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.4, col); grad.addColorStop(1, shade(col, -0.6));
      g.fillStyle = grad;
      g.beginPath(); g.arc(0, 0, 18, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(0, 0, 11, 0.4, 2.6); g.stroke();
      break;
    }
    case 'refined': {
      if (d.id.includes('wire')) {
        // A coil of wire
        g.strokeStyle = shade(col, -0.2); g.lineWidth = 4;
        for (let i = 0; i < 4; i++) { g.beginPath(); g.ellipse(-9 + i * 6, 0, 6, 16, 0, 0, Math.PI * 2); g.stroke(); }
        g.strokeStyle = shade(col, 0.4); g.lineWidth = 1.5;
        for (let i = 0; i < 4; i++) { g.beginPath(); g.ellipse(-9 + i * 6, 0, 6, 16, 0, -1.2, 0.2); g.stroke(); }
        break;
      }
      if (d.id.includes('lens')) {
        g.shadowColor = col; g.shadowBlur = 10;
        g.fillStyle = shade(col, -0.1); g.beginPath(); g.ellipse(0, 0, 18, 18, 0, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
        g.strokeStyle = shade(col, -0.5); g.lineWidth = 3; g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.ellipse(-6, -6, 6, 3, -0.7, 0, Math.PI * 2); g.fill();
        break;
      }
      // Stacked plates, seen at an angle
      for (let k = 2; k >= 0; k--) {
        const y = 8 - k * 7;
        g.beginPath();
        g.moveTo(-20, y); g.lineTo(-6, y - 8); g.lineTo(20, y - 8); g.lineTo(6, y); g.closePath();
        g.fillStyle = shade(col, 0.15 - k * 0.05); g.fill();
        g.beginPath(); g.moveTo(-20, y); g.lineTo(6, y); g.lineTo(6, y + 4); g.lineTo(-20, y + 4); g.closePath();
        g.fillStyle = shade(col, -0.35); g.fill();
        g.beginPath(); g.moveTo(6, y); g.lineTo(20, y - 8); g.lineTo(20, y - 4); g.lineTo(6, y + 4); g.closePath();
        g.fillStyle = shade(col, -0.5); g.fill();
      }
      break;
    }
    case 'component': {
      // A circuit chip with pins
      g.fillStyle = '#2a3140';
      g.fillRect(-15, -15, 30, 30);
      g.fillStyle = shade(col, -0.1);
      for (let i = -2; i <= 2; i++) {
        g.fillRect(i * 6 - 1.5, -21, 3, 6); g.fillRect(i * 6 - 1.5, 15, 3, 6);
        g.fillRect(-21, i * 6 - 1.5, 6, 3); g.fillRect(15, i * 6 - 1.5, 6, 3);
      }
      g.strokeStyle = col; g.lineWidth = 2; g.strokeRect(-15, -15, 30, 30);
      g.shadowColor = col; g.shadowBlur = 8;
      g.fillStyle = col; g.fillRect(-6, -6, 12, 12);
      g.shadowBlur = 0;
      break;
    }
    case 'artefact': {
      // A glowing relic in a rune ring
      g.shadowColor = col; g.shadowBlur = 20;
      const grad = g.createRadialGradient(0, 0, 2, 0, 0, 16);
      grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.5, col); grad.addColorStop(1, shade(col, -0.7));
      g.fillStyle = grad;
      g.beginPath(); g.arc(0, 0, 14, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = shade(col, 0.3); g.lineWidth = 1.5;
      g.beginPath(); g.arc(0, 0, 22, 0, Math.PI * 2); g.stroke();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.beginPath(); g.moveTo(Math.cos(a) * 19, Math.sin(a) * 19); g.lineTo(Math.cos(a) * 25, Math.sin(a) * 25); g.stroke();
      }
      break;
    }
    case 'quest': {
      // A job's own item: a sealed case in its colour with a gold mark
      g.shadowColor = '#fbbf24'; g.shadowBlur = 14;
      g.fillStyle = shade(col, -0.45);
      roundRect(g, -18, -14, 36, 28, 5); g.fill();
      g.shadowBlur = 0;
      g.fillStyle = col;
      roundRect(g, -18, -14, 36, 9, 5); g.fill();
      g.strokeStyle = '#fbbf24'; g.lineWidth = 1.5;
      roundRect(g, -18, -14, 36, 28, 5); g.stroke();
      g.fillStyle = '#fde68a';
      g.font = 'bold 16px Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('!', 0, 5);
      break;
    }
    case 'consumable': {
      // A capsule with a symbol
      g.fillStyle = shade(col, -0.35);
      roundRect(g, -12, -20, 24, 40, 10); g.fill();
      g.fillStyle = col;
      roundRect(g, -12, -20, 24, 18, 10); g.fill();
      g.strokeStyle = shade(col, 0.5); g.lineWidth = 1.5;
      roundRect(g, -12, -20, 24, 40, 10); g.stroke();
      g.fillStyle = '#ffffff';
      g.font = 'bold 15px Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const sym = d.id.startsWith('repair') ? '+' : d.id.startsWith('boost') ? '»' : d.id.startsWith('insurance') ? '§' : d.id.startsWith('scanner') ? '◎' : '•';
      g.fillText(sym, 0, 8);
      break;
    }
    case 'jewel': {
      // A cut stone: facets, a bright table, and pips for its level
      g.shadowColor = col; g.shadowBlur = 12;
      g.beginPath(); g.moveTo(-16, -6); g.lineTo(-8, -15); g.lineTo(8, -15); g.lineTo(16, -6); g.lineTo(0, 17); g.closePath();
      g.fillStyle = shade(col, -0.25); g.fill();
      g.shadowBlur = 0;
      g.beginPath(); g.moveTo(-8, -15); g.lineTo(8, -15); g.lineTo(5, -6); g.lineTo(-5, -6); g.closePath();
      g.fillStyle = shade(col, 0.45); g.fill();
      g.beginPath(); g.moveTo(-16, -6); g.lineTo(16, -6); g.lineTo(0, 17); g.closePath();
      g.fillStyle = col; g.globalAlpha = 0.7; g.fill(); g.globalAlpha = 1;
      g.fillStyle = '#ffffff';
      for (let i = 0; i < (d.socket?.level ?? 1); i++) g.fillRect(12 + 0, 10 - i * 5, 3, 3);
      break;
    }
    case 'ammo': {
      // A crate with the round it holds stencilled on
      g.fillStyle = shade(col, -0.45);
      roundRect(g, -20, -15, 40, 30, 3); g.fill();
      g.strokeStyle = shade(col, 0.2); g.lineWidth = 1.5;
      roundRect(g, -20, -15, 40, 30, 3); g.stroke();
      g.beginPath(); g.moveTo(-20, -5); g.lineTo(20, -5); g.stroke();
      g.fillStyle = col;
      for (let i = -1; i <= 1; i++) { roundRect(g, i * 10 - 3, -1, 6, 12, 3); g.fill(); }
      break;
    }
    case 'plan': {
      // A blueprint sheet with the ship's outline
      g.fillStyle = '#1d4f91'; g.fillRect(-22, -18, 44, 36);
      g.strokeStyle = 'rgba(160,200,255,0.35)'; g.lineWidth = 1;
      for (let i = -22; i <= 22; i += 6) { g.beginPath(); g.moveTo(i, -18); g.lineTo(i, 18); g.stroke(); }
      for (let i = -18; i <= 18; i += 6) { g.beginPath(); g.moveTo(-22, i); g.lineTo(22, i); g.stroke(); }
      const bp = d.plan ? econ.plans[d.plan] : undefined;
      if (bp) drawShipOutline(g, econ, bp.parts, 30);
      g.strokeStyle = '#ffd166'; g.lineWidth = 2; g.strokeRect(-22, -18, 44, 36);
      break;
    }
    case 'part': {
      const p = d.part!;
      const v = econ.ships.variants.get(p.piece)?.[0];
      if (!v) break;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of v.polygon) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
      // Engines and weapons stick out of their facing edge: leave room for the nozzle or barrel
      const hardware = isWeaponFn(p.fn) || ENGINE_FNS.has(p.fn) || lookFn(p.fn) === 'miner';
      const k = (hardware ? 30 : 38) / Math.max(maxX - minX, maxY - minY, 1);
      const ox = -(minX + maxX) / 2, oy = -(minY + maxY) / 2 + (hardware ? (ENGINE_FNS.has(p.fn) ? -0.18 : 0.18) * Math.max(maxY - minY, 1) : 0);
      g.beginPath();
      v.polygon.forEach(([x, y], i) => (i ? g.lineTo((x + ox) * k, (y + oy) * k) : g.moveTo((x + ox) * k, (y + oy) * k)));
      g.closePath();
      const grad = g.createLinearGradient(-20, -20, 20, 20);
      grad.addColorStop(0, shade(col, 0.25)); grad.addColorStop(1, shade(col, -0.35));
      g.fillStyle = grad; g.fill();
      g.strokeStyle = shade(col, -0.6); g.lineWidth = 2; g.stroke();
      if (hardware || lookFn(p.fn).endsWith('battery')) {
        // Weapons face forward (up), engines push forward (nozzle down)
        const geom = placeGeometry(econ.ships, { uid: 0, piece: p.piece, fn: p.fn, material: p.material, x: 0, y: 0, rot: 0, flip: false, facing: ENGINE_FNS.has(p.fn) ? 'S' : 'N' } as PlacedPart);
        drawDecor2d(g, geom, (x, y) => [(x + ox) * k, (y + oy) * k], k);
      } else fnMark(g, lookFn(p.fn));
      break;
    }
  }
}

/** What a part does, drawn on top of its outline */
function fnMark(g: CanvasRenderingContext2D, fn: string): void {
  g.lineWidth = 2;
  switch (fn) {
    case 'core':
      g.shadowColor = '#7dd3fc'; g.shadowBlur = 10;
      g.fillStyle = '#e0f4ff'; g.beginPath(); g.arc(0, 0, 6, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0; break;
    case 'armor':
      g.strokeStyle = 'rgba(30,35,45,0.7)';
      for (let i = -2; i <= 2; i++) { g.beginPath(); g.moveTo(i * 6 - 6, -10); g.lineTo(i * 6 + 6, 10); g.stroke(); }
      break;
    case 'generator':
      g.fillStyle = '#ffe14d';
      g.beginPath(); g.moveTo(2, -11); g.lineTo(-6, 2); g.lineTo(0, 2); g.lineTo(-2, 11); g.lineTo(6, -2); g.lineTo(0, -2); g.closePath(); g.fill();
      break;
    case 'thruster':
      g.fillStyle = '#ff9a3c';
      g.beginPath(); g.moveTo(-7, 6); g.lineTo(7, 6); g.lineTo(0, 16); g.closePath(); g.fill();
      g.fillStyle = '#39404d'; g.fillRect(-8, 2, 16, 5);
      break;
    case 'weapon':
      g.fillStyle = '#39404d'; g.fillRect(-3, -18, 6, 18);
      g.fillStyle = '#ffd08a'; g.fillRect(-3, -19, 6, 3);
      break;
    case 'conduit':
      g.strokeStyle = '#ffb86b'; g.beginPath(); g.moveTo(-12, 0); g.lineTo(12, 0); g.moveTo(0, -12); g.lineTo(0, 12); g.stroke();
      break;
    case 'cargo':
      g.strokeStyle = 'rgba(30,35,45,0.75)'; g.strokeRect(-9, -9, 18, 18);
      g.beginPath(); g.moveTo(-9, -9); g.lineTo(9, 9); g.moveTo(9, -9); g.lineTo(-9, 9); g.stroke();
      break;
  }
}

/** A ship's outline (all its parts), fitted into a box of `size` */
export function drawShipOutline(g: CanvasRenderingContext2D, econ: Economy, parts: { piece: string; rot: number; flip: boolean; x: number; y: number }[], size: number): void {
  const polys: [number, number][][] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of parts) {
    const v = econ.ships.variants.get(p.piece)?.[p.rot + (p.flip ? 4 : 0)];
    if (!v) continue;
    const poly = v.polygon.map(([x, y]) => [x + p.x, y + p.y] as [number, number]);
    for (const [x, y] of poly) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    polys.push(poly);
  }
  if (!polys.length) return;
  const k = size / Math.max(maxX - minX, maxY - minY, 1);
  const ox = -(minX + maxX) / 2, oy = -(minY + maxY) / 2;
  g.fillStyle = 'rgba(200,230,255,0.85)';
  for (const poly of polys) {
    g.beginPath();
    poly.forEach(([x, y], i) => (i ? g.lineTo((x + ox) * k, (y + oy) * k) : g.moveTo((x + ox) * k, (y + oy) * k)));
    g.closePath();
    g.fill();
  }
}

const shipCache = new Map<string, string>();

/** A design's silhouette as a cached data URL (`size` CSS pixels, drawn at 2×) */
export function shipIcon(econ: Economy, parts: { piece: string; rot: number; flip: boolean; x: number; y: number }[], size = 40): string {
  const key = `${size}|${parts.map((p) => `${p.piece}${p.rot}${p.flip ? 1 : 0}@${p.x},${p.y}`).join(';')}`;
  const hit = shipCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size * 2;
  const g = c.getContext('2d')!;
  g.translate(size, size);
  drawShipOutline(g, econ, parts, size * 2 - 6);
  const url = c.toDataURL();
  shipCache.set(key, url);
  return url;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
