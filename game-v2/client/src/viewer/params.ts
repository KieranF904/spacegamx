/**
 * The asset viewer's settings, as URL params (viewer.html?asset=ship:sparrow-t&zoom=2&light=sun&bg=transparent&flames=0.8).
 * Pure: parsed and written here, shared by the page, the render daemon's callers and the tests.
 */

export const LIGHTS = ['sun', 'hangar', 'nebula', 'dark', 'flat'] as const;
export type LightPreset = typeof LIGHTS[number];
export const BACKGROUNDS = ['starfield', 'dark', 'transparent'] as const;
export type Background = typeof BACKGROUNDS[number];
export const FACINGS = ['N', 'E', 'S', 'W'] as const;
export type Facing = typeof FACINGS[number];

export interface ViewerParams {
  /** One asset id, a sheet (sheet:models), or several, comma separated (assets.ts) */
  asset: string;
  /** Screen px per world unit (1 = the game's default zoom), or fit to the view */
  zoom: number | 'fit';
  /** Camera offset from the content's centre (world units) */
  x: number;
  y: number;
  /** Ship heading, degrees clockwise from nose-up */
  angle: number;
  light: LightPreset;
  /** Overrides on the preset: where the sun is (degrees clockwise from the top of the screen), its power, the ambient level, its height */
  lightDir: number | null;
  lightPower: number | null;
  ambient: number | null;
  elevation: number | null;
  /** The sun's colour and the ambient light's tint, #rrggbb over the preset's (the ambient keeps its level: `ambient`, else the preset's) */
  lightColor: string | null;
  ambientColor: string | null;
  bg: Background;
  /** The starfield's sky: a system id or a biome kind (band, cluster, emission, ember, void, abyss, remnant) */
  sky: string;
  /** 0 whole .. 1 nearly wrecked (each part a seeded share of it) */
  damage: number;
  seed: number;
  /** Engine throttle 0..1 (0: idle glow only) */
  flames: number;
  boost: boolean;
  /** Exhaust particles behind the flames */
  exhaust: boolean;
  /** Draw the engines as a Frostbite-slowed ship's: short, pale plumes (native render) */
  frost: boolean;
  bloom: boolean;
  /** Turret aim, degrees clockwise from nose-up in the ship's frame (null: each at rest, along its facing) */
  aim: number | null;
  grid: boolean;
  /** A bespoke hull's frame glow (a boss's later stage) 0..1 */
  heat: number;
  /** Hull tint: #rrggbb, or faction:<id> (factions.json) */
  tint: string | null;
  /** Models: which way they fire (auto: weapons N, engines S), on a stub of hull or alone */
  facing: Facing | 'auto';
  stub: boolean;
  /** Sheets: labels under each, and columns (null: about square) */
  labels: boolean;
  cols: number | null;
  /** Canvas size, CSS px (null: fill the window) */
  w: number | null;
  h: number | null;
  /** Export scale (1, 2, 4: PNG pixels per CSS px) */
  scale: number;
  /** The browse/controls panel (0: the canvas alone, as the render daemon uses it) */
  ui: boolean;
}

export const DEFAULTS: Readonly<ViewerParams> = Object.freeze({
  asset: 'ship:sparrow-t', zoom: 'fit', x: 0, y: 0, angle: 0,
  light: 'sun', lightDir: null, lightPower: null, ambient: null, elevation: null, lightColor: null, ambientColor: null,
  bg: 'starfield', sky: 'sol', damage: 0, seed: 1, flames: 0, boost: false, exhaust: true, frost: false, bloom: true,
  aim: null, grid: false, heat: 0, tint: null, facing: 'auto', stub: true, labels: true, cols: null,
  w: null, h: null, scale: 1, ui: true,
});

/** Param order in a written URL (asset first, then roughly by how often they're set) */
const ORDER = Object.keys(DEFAULTS) as (keyof ViewerParams)[];

const num = (s: string): number | null => {
  const v = Number(s);
  return s.trim() !== '' && Number.isFinite(v) ? v : null;
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const bool = (s: string): boolean => !/^(0|false|no|off)$/i.test(s.trim());
const oneOf = <T extends string>(list: readonly T[], s: string): T | null => (list as readonly string[]).includes(s) ? (s as T) : null;

/** Read params (bad or missing values: the defaults); `string` is a query (with or without its ?) */
export function parseParams(q: string | URLSearchParams): ViewerParams {
  const sp = typeof q === 'string' ? new URLSearchParams(q.replace(/^\?/, '')) : q;
  const p: ViewerParams = { ...DEFAULTS };
  const get = (k: string) => sp.get(k);
  const n = (k: keyof ViewerParams, a: number, b: number, nullable = false) => {
    const s = get(k);
    if (s === null) return;
    if (nullable && /^(|auto|rest|default)$/i.test(s.trim())) { (p as any)[k] = null; return; }
    const v = num(s);
    if (v !== null) (p as any)[k] = clamp(v, a, b);
  };
  const b = (k: keyof ViewerParams) => { const s = get(k); if (s !== null) (p as any)[k] = bool(s); };

  const asset = get('asset');
  if (asset && asset.trim()) p.asset = asset.trim();
  const z = get('zoom');
  if (z !== null) p.zoom = z === 'fit' ? 'fit' : num(z) !== null ? clamp(num(z)!, 0.01, 64) : 'fit';
  n('x', -1e6, 1e6); n('y', -1e6, 1e6);
  const a = get('angle');
  if (a !== null && num(a) !== null) p.angle = ((num(a)! % 360) + 360) % 360;
  p.light = oneOf(LIGHTS, get('light') ?? '') ?? p.light;
  n('lightDir', -360, 720, true);
  if (p.lightDir !== null) p.lightDir = ((p.lightDir % 360) + 360) % 360;
  n('lightPower', 0, 4, true); n('ambient', 0, 2, true); n('elevation', 0.02, 1.57, true);
  for (const k of ['lightColor', 'ambientColor'] as const) {
    const c = get(k);
    if (c !== null) p[k] = /^#?[0-9a-f]{6}$/i.test(c) ? `#${c.replace('#', '').toLowerCase()}` : null;
  }
  p.bg = oneOf(BACKGROUNDS, get('bg') ?? '') ?? p.bg;
  const sky = get('sky');
  if (sky && /^[a-z0-9_-]{1,64}$/i.test(sky)) p.sky = sky;
  n('damage', 0, 1); n('seed', 0, 1e9); n('flames', 0, 1); n('heat', 0, 1);
  b('boost'); b('exhaust'); b('frost'); b('bloom'); b('grid'); b('stub'); b('labels'); b('ui');
  n('aim', -720, 720, true);
  const tint = get('tint');
  if (tint !== null) p.tint = /^#?[0-9a-f]{6}$/i.test(tint) ? `#${tint.replace('#', '').toLowerCase()}` : /^faction:[a-z_]+$/.test(tint) ? tint : null;
  const f = (get('facing') ?? '').toUpperCase();
  p.facing = oneOf(FACINGS, f) ?? (f === 'AUTO' ? 'auto' : p.facing);
  n('cols', 1, 64, true);
  if (p.cols !== null) p.cols = Math.round(p.cols);
  n('w', 16, 8192, true); n('h', 16, 8192, true);
  if (p.w !== null) p.w = Math.round(p.w);
  if (p.h !== null) p.h = Math.round(p.h);
  n('scale', 0.25, 8);
  return p;
}

/** Write params as a query (no ?), leaving out what's at its default */
export function toQuery(p: Partial<ViewerParams>): string {
  const full = { ...DEFAULTS, ...p };
  const out: string[] = [];
  for (const k of ORDER) {
    const v = full[k], d = DEFAULTS[k];
    if (v === d || (v === null && d === null)) continue;
    const s = typeof v === 'boolean' ? (v ? '1' : '0') : v === null ? 'auto' : typeof v === 'number' ? String(+v.toFixed(4)) : String(v);
    // (asset ids keep their : / , @ readable)
    out.push(`${k}=${encodeURIComponent(s).replace(/%3A/g, ':').replace(/%2F/g, '/').replace(/%2C/g, ',').replace(/%40/g, '@')}`);
  }
  return out.join('&');
}

/**
 * CLI flags to params: `--zoom 2 --light dark --flames=0.8 --no-grid --grid`, plus a bare first word as the asset.
 * Unknown flags are returned for the caller (out, dir, ...).
 */
export function flagsToParams(argv: string[]): { params: Record<string, string>; rest: Record<string, string>; words: string[] } {
  const params: Record<string, string> = {}, rest: Record<string, string> = {}, words: string[] = [];
  const known = new Set<string>(ORDER);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { words.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (v === undefined) {
      if (k.startsWith('no-')) { k = k.slice(3); v = '0'; }
      // (a boolean takes the next word only if it's a boolean: `--grid ship:x` is grid on, asset ship:x)
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && (typeof (DEFAULTS as any)[k] !== 'boolean' || /^(0|1|true|false|on|off|yes|no)$/i.test(argv[i + 1]))) v = argv[++i];
      else v = '1';
    }
    (known.has(k) ? params : rest)[k] = v;
  }
  if (!params.asset && words.length) params.asset = words.shift()!;
  return { params, rest, words };
}

/** #rrggbb as 0..1 channels */
export const hexRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/**
 * A preset's light with the overrides applied: the sun's colour, and the ambient light (the preset's hue, or `ambientColor`'s,
 * at `ambient`'s level, else the preset's own). Shared by the browser viewer and the native renderer, so they agree.
 */
export function lightWith(L: { ambient: number[]; color: number[] }, p: Pick<ViewerParams, 'ambient' | 'ambientColor' | 'lightColor'>): { ambient: number[]; color: number[] } {
  const mean = (a: number[]) => (a[0] + a[1] + a[2]) / 3 || 1;
  const level = p.ambient !== null ? p.ambient : mean(L.ambient);
  const hue = p.ambientColor ? hexRgb(p.ambientColor) : L.ambient;
  const k = level / mean(hue);
  return { ambient: hue.map((v) => v * k), color: p.lightColor ? hexRgb(p.lightColor) : L.color };
}
