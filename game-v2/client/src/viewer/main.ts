/**
 * The asset viewer (viewer.html, dev server only): browse designs, models, materials and pieces, drawn by the game's
 * own renderer; every setting in the URL; PNG export. window.__viewer is what the render daemon drives
 * (scripts/render/daemon.mjs).
 */

import { loadViewerData } from './catalog';
import { ViewerScene, LIGHT_PRESETS } from './ViewerScene';
import { searchAssets, type AssetEntry } from './assets';
import { BACKGROUNDS, DEFAULTS, FACINGS, LIGHTS, parseParams, toQuery, type ViewerParams } from './params';
import { BIOME_KINDS } from '../rendering/sky/skyBiome';

type Key = keyof ViewerParams;
interface Control { key: Key; label: string; type: 'range' | 'select' | 'check' | 'number' | 'text'; min?: number; max?: number; step?: number; options?: readonly string[]; nullable?: boolean; hint?: string }

const CONTROLS: { title: string; items: Control[] }[] = [
  { title: 'View', items: [
    { key: 'zoom', label: 'Zoom', type: 'number', min: 0.01, max: 64, step: 0.05, hint: 'empty: fit' },
    { key: 'angle', label: 'Heading', type: 'range', min: 0, max: 359, step: 1 },
    { key: 'grid', label: 'Grid', type: 'check' },
    { key: 'labels', label: 'Labels', type: 'check' },
    { key: 'cols', label: 'Columns', type: 'number', min: 1, max: 64, step: 1, nullable: true, hint: 'empty: auto' },
  ] },
  { title: 'Light', items: [
    { key: 'light', label: 'Preset', type: 'select', options: LIGHTS },
    { key: 'lightDir', label: 'Sun from', type: 'range', min: 0, max: 359, step: 1, nullable: true },
    { key: 'lightPower', label: 'Sun power', type: 'range', min: 0, max: 3, step: 0.05, nullable: true },
    { key: 'elevation', label: 'Sun height', type: 'range', min: 0.05, max: 1.55, step: 0.05, nullable: true },
    { key: 'ambient', label: 'Ambient', type: 'range', min: 0, max: 1.5, step: 0.01, nullable: true },
  ] },
  { title: 'Background', items: [
    { key: 'bg', label: 'Background', type: 'select', options: BACKGROUNDS },
    { key: 'sky', label: 'Sky', type: 'select', options: ['sol', ...BIOME_KINDS] },
    { key: 'bloom', label: 'Bloom', type: 'check' },
  ] },
  { title: 'Ship', items: [
    { key: 'flames', label: 'Throttle', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'boost', label: 'Boost', type: 'check' },
    { key: 'exhaust', label: 'Exhaust', type: 'check' },
    { key: 'aim', label: 'Turret aim', type: 'range', min: -180, max: 180, step: 1, nullable: true },
    { key: 'damage', label: 'Damage', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'seed', label: 'Damage seed', type: 'number', min: 0, step: 1 },
    { key: 'heat', label: 'Frame heat', type: 'range', min: 0, max: 1, step: 0.05 },
    { key: 'tint', label: 'Tint', type: 'text', nullable: true, hint: '#rrggbb or faction:pirates' },
  ] },
  { title: 'Models', items: [
    { key: 'facing', label: 'Facing', type: 'select', options: ['auto', ...FACINGS] },
    { key: 'stub', label: 'On a stub', type: 'check' },
  ] },
];

const data = loadViewerData();
const params = parseParams(location.search);
const ui = params.ui;
document.body.classList.toggle('bare', !ui);
const stage = document.getElementById('stage')!;
const scene = new ViewerScene(data, stage);
let p: ViewerParams = params;

const ready = (async () => {
  await scene.init();
  scene.set(p);
  // The render daemon's page (no panels) draws only while a render asks
  if (!ui) scene.live(false);
})();

// ---- URL

let urlTimer = 0;
function update(next: Partial<ViewerParams>, opts: { url?: boolean } = {}): void {
  p = { ...p, ...next };
  scene.set(p);
  if (opts.url !== false) {
    clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => history.replaceState(null, '', `?${toQuery(p)}`), 150);
  }
  syncControls();
  info();
}

// ---- the browse panel

const list = document.getElementById('list')!;
const search = document.getElementById('search') as HTMLInputElement;
const collapsed = new Set<string>();
function drawList(): void {
  const found = searchAssets(data.assets, search.value);
  const groups = new Map<string, AssetEntry[]>();
  for (const e of found) { const g = groups.get(e.group); if (g) g.push(e); else groups.set(e.group, [e]); }
  list.innerHTML = '';
  for (const [g, entries] of groups) {
    const head = document.createElement('div');
    head.className = 'group';
    const shut = collapsed.has(g) && !search.value;
    head.textContent = `${shut ? '▸' : '▾'} ${g} (${entries.length})`;
    head.onclick = () => { if (collapsed.has(g)) collapsed.delete(g); else collapsed.add(g); drawList(); };
    list.appendChild(head);
    if (shut) continue;
    for (const e of entries) {
      const row = document.createElement('div');
      row.className = 'item' + (p.asset === e.id ? ' on' : '');
      row.textContent = e.label;
      // (ships: their file too, as two can share a name)
      if (e.kind === 'ship') { const sub = document.createElement('small'); sub.textContent = ` ${e.id.slice(5)}`; row.appendChild(sub); }
      row.title = e.id;
      row.onclick = () => { update({ asset: e.id, zoom: 'fit', x: 0, y: 0 }); drawList(); };
      list.appendChild(row);
    }
  }
}
// Long groups start shut
for (const e of data.assets) if (e.group.startsWith('Models ·') || e.group === 'Pieces' || e.group === 'Materials') collapsed.add(e.group);
search.oninput = () => drawList();
const assetBox = document.getElementById('asset') as HTMLInputElement;
assetBox.onchange = () => { update({ asset: assetBox.value.trim() || DEFAULTS.asset, zoom: 'fit', x: 0, y: 0 }); drawList(); };

// ---- the controls

const inputs = new Map<Key, HTMLInputElement | HTMLSelectElement>();
const controls = document.getElementById('controls')!;
for (const sec of CONTROLS) {
  const h = document.createElement('h3');
  h.textContent = sec.title;
  controls.appendChild(h);
  for (const c of sec.items) {
    const row = document.createElement('label');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = c.label;
    row.appendChild(name);
    let el: HTMLInputElement | HTMLSelectElement;
    if (c.type === 'select') {
      el = document.createElement('select');
      for (const o of c.options!) { const opt = document.createElement('option'); opt.value = opt.textContent = o; el.appendChild(opt); }
    } else {
      el = document.createElement('input');
      el.type = c.type === 'check' ? 'checkbox' : c.type;
      if (c.min !== undefined) el.min = String(c.min);
      if (c.max !== undefined) el.max = String(c.max);
      if (c.step !== undefined) el.step = String(c.step);
      if (c.hint) el.placeholder = c.hint;
    }
    if (c.hint) row.title = c.hint;
    const val = document.createElement('em');
    const read = (): unknown => {
      if (c.type === 'check') return (el as HTMLInputElement).checked;
      const s = el.value.trim();
      if (c.key === 'zoom') return s === '' ? 'fit' : Number(s);
      if (c.type === 'range' || c.type === 'number') return s === '' && c.nullable ? null : Number(s);
      if (c.type === 'text') return s === '' ? null : s;
      return s;
    };
    el.addEventListener(c.type === 'range' ? 'input' : 'change', () => {
      // (re-read through the parser: the same bounds as a URL gets)
      const q = new URLSearchParams(toQuery({ ...p, [c.key]: read() } as ViewerParams));
      const parsed = parseParams(q);
      update({ [c.key]: parsed[c.key] } as Partial<ViewerParams>);
    });
    row.appendChild(el);
    if (c.type === 'range') row.appendChild(val);
    if (c.nullable && c.type === 'range') {
      const reset = document.createElement('button');
      reset.textContent = '×';
      reset.title = 'back to the preset / default';
      reset.onclick = (ev) => { ev.preventDefault(); update({ [c.key]: null } as Partial<ViewerParams>); };
      row.appendChild(reset);
    }
    controls.appendChild(row);
    inputs.set(c.key, el);
  }
}

function syncControls(): void {
  for (const [k, el] of inputs) {
    if (document.activeElement === el && el.type !== 'range') continue;
    let v = p[k] as unknown;
    if (v === null && k === 'lightDir') v = LIGHT_PRESETS[p.light].dir;
    if (v === null && k === 'lightPower') v = LIGHT_PRESETS[p.light].power;
    if (v === null && k === 'elevation') v = LIGHT_PRESETS[p.light].elevation;
    if (v === null && k === 'ambient') { const a = LIGHT_PRESETS[p.light].ambient; v = +((a[0] + a[1] + a[2]) / 3).toFixed(2); }
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v;
    else el.value = v === null || v === undefined ? '' : k === 'zoom' && v === 'fit' ? '' : String(v);
    const em = el.parentElement?.querySelector('em');
    if (em) em.textContent = p[k] === null ? (k === 'aim' ? 'rest' : 'preset') : String(p[k]);
  }
  assetBox.value = p.asset;
  (document.getElementById('scale') as HTMLSelectElement).value = String(p.scale);
}

function info(): void {
  const z = scene.cam.zoom;
  document.getElementById('info')!.textContent = `${scene.info} · zoom ${z.toFixed(2)}${p.zoom === 'fit' ? ' (fit)' : ''} · ${scene.view.w}×${scene.view.h}`;
}

// ---- export

const scaleSel = document.getElementById('scale') as HTMLSelectElement;
scaleSel.onchange = () => update({ scale: Number(scaleSel.value) });
const transparent = document.getElementById('transparent') as HTMLInputElement;
document.getElementById('export')!.onclick = async () => {
  const keep = p.bg;
  if (transparent.checked) { scene.set({ ...p, bg: 'transparent' }); await scene.whenSettled(3000); }
  const url = scene.snapshot(p.scale);
  if (transparent.checked) scene.set({ ...p, bg: keep });
  const a = document.createElement('a');
  a.href = url;
  a.download = `${p.asset.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60)}@${p.scale}x.png`;
  a.click();
};
document.getElementById('copy')!.onclick = () => void navigator.clipboard?.writeText(location.href);
document.getElementById('fit')!.onclick = () => update({ zoom: 'fit', x: 0, y: 0 });

// ---- mouse: drag to pan, right-drag to turn, wheel to zoom about the cursor

let drag: { x: number; y: number; button: number } | null = null;
stage.addEventListener('contextmenu', (e) => e.preventDefault());
stage.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, button: e.button }; stage.setPointerCapture(e.pointerId); });
stage.addEventListener('pointerup', () => { drag = null; });
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.button === 2 || e.shiftKey) update({ angle: Math.round(((p.angle + dx * 0.5) % 360 + 360) % 360) });
  else {
    const z = scene.cam.zoom;
    update({ zoom: p.zoom === 'fit' ? +z.toFixed(4) : p.zoom, x: +(p.x - dx / z).toFixed(2), y: +(p.y - dy / z).toFixed(2) });
  }
});
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
  const z = scene.cam.zoom, z2 = Math.max(0.02, Math.min(64, z * Math.pow(1.0015, -e.deltaY)));
  // Keep the point under the cursor still: the camera moves towards it
  const w = scene.toWorld(sx, sy), cx = scene.cam.x - p.x, cy = scene.cam.y - p.y;
  const camX = w.x - (sx - scene.view.w / 2) / z2, camY = w.y - (sy - scene.view.h / 2) / z2;
  update({ zoom: +z2.toFixed(4), x: +(camX - cx).toFixed(2), y: +(camY - cy).toFixed(2) });
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'f') update({ zoom: 'fit', x: 0, y: 0 });
  if (e.key === 'g') update({ grid: !p.grid });
  if (e.key === 'r') update({ angle: (p.angle + 45) % 360 });
  if (e.key === '/') { e.preventDefault(); search.focus(); }
});

if (ui) {
  drawList();
  syncControls();
  setInterval(info, 500);
}

// ---- the render daemon's handle

declare global { interface Window { __viewer?: unknown } }
window.__viewer = {
  ready,
  /** Show these settings (a query), wait for it to settle, and give the view as a PNG data URL */
  async render(query: string, opts: { timeoutMs?: number } = {}): Promise<{ png: string; w: number; h: number; info: string; settled: boolean }> {
    await ready;
    p = parseParams(query);
    scene.live(true);
    try {
      scene.set(p);
      const settled = await scene.whenSettled(opts.timeoutMs ?? 30000);
      const png = scene.snapshot(p.scale);
      return { png, w: Math.round(scene.view.w * p.scale), h: Math.round(scene.view.h * p.scale), info: scene.info, settled };
    } finally { if (!ui) scene.live(false); }
  },
  /** Show these settings, and the panel with them (for a shot of the whole page) */
  async show(query: string): Promise<boolean> {
    await ready;
    scene.live(true);
    update(parseParams(query));
    drawList();
    return scene.whenSettled();
  },
  assets: (q = '') => searchAssets(data.assets, q).map((e) => ({ id: e.id, label: e.label, group: e.group })),
};
