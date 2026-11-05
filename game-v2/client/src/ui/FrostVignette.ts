/**
 * The cold on screen: ice frosting in from the edges as the ship's warmth runs down (common/src/ships/warmth.ts),
 * corners first, and back out as it warms up. It is how the meter is read; a small chip beside it gives the number,
 * the stage and what it costs, and says when the ship is warming. Frost hits (a gemmed gun, the Brood Mother) land
 * on the same meter, so they frost the screen too, with a flash at the rim.
 *
 * Cheap: one fixed layer that is hidden when warm. Low quality draws a gradient tint only; medium and high draw a
 * frost texture revealed from the edges by a mask, which is only touched when the frost has moved a visible step. The
 * texture is made once per size (encoded off the main thread) and kept in the asset cache, so it's drawn once per browser.
 */

import { warmthStage, type WarmthStageName } from '@space-game/common';
import type { QualityProfile } from '../settings/quality';
import { assetKind } from '../assets/assetCache';

/** How frosted the screen is (0 clear .. 1 frozen through) at a warmth percent: none while all but full */
export function frostAmount(pct: number): number {
  if (pct >= 98) return 0;
  return Math.max(0, Math.min(1, (100 - pct) / 100));
}

/**
 * Where the frost reaches, as an elliptical mask from the centre (percent of the way to a corner: the sides'
 * middles are at about 71): clear inside `inner`, solid frost past `outer`. A little frost holds the corners;
 * frozen through, it covers a good band round the edges and the middle stays clear.
 */
export function frostMask(frost: number): { inner: number; outer: number } {
  const inner = 98 - 46 * Math.max(0, Math.min(1, frost));
  return { inner, outer: Math.min(100, inner + 16) };
}

/** The chip's words for each stage */
const STAGE: Record<WarmthStageName, { label: string; cost: string; color: string }> = {
  warm: { label: 'Cold', cost: '', color: '#bfe6ff' },
  chilled: { label: 'Chilled', cost: 'guns slower', color: '#9fd8ff' },
  numb: { label: 'Numb', cost: 'guns and drive slower', color: '#7cc4ff' },
  frozen: { label: 'Frozen', cost: 'seizing up', color: '#ff9b9b' },
};

/** What drawFrost makes, by version (assetCache.ts): bump it whenever the frost's look changes */
export const FROST_TEXTURE_VERSION = 2;
/** The frost texture as a PNG, by its size */
const frostTextures = assetKind<Blob>('frostTexture', FROST_TEXTURE_VERSION);

/**
 * Hoarfrost growing in from the edges (seeded: the same frost every time): an uneven rime, ice grain packed along the
 * rim, and fine feathered fronds (a thin stem curling inwards, short barbs angled along it) reaching further in towards
 * the corners. All of it in a few batched strokes, so it's cheap to draw at any size.
 */
function drawFrost(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const s = Math.min(w, h), px = Math.max(0.5, w / 1024);
  // How near the nearest edge (1 on it, falling away inwards), and how near a corner (0 mid-side .. 1 in it)
  const edge = (x: number, y: number) => Math.exp(-Math.min(x, y, w - x, h - y) / (s * 0.07));
  // A soft rime over everything, thicker towards the edges and uneven (the mask decides how far in it shows)
  const rime = g.createRadialGradient(w / 2, h / 2, s * 0.25, w / 2, h / 2, Math.hypot(w, h) / 2);
  rime.addColorStop(0, 'rgba(200,228,255,0.03)');
  rime.addColorStop(1, 'rgba(222,240,255,0.3)');
  g.fillStyle = rime;
  g.fillRect(0, 0, w, h);
  const along = () => {
    const side = Math.floor(rnd() * 4), t = rnd();
    // (In from the edge a little, more often near it)
    const d = s * 0.08 * rnd() * rnd();
    return side === 0 ? [t * w, d, Math.PI / 2] : side === 1 ? [w - d, t * h, Math.PI] : side === 2 ? [t * w, h - d, -Math.PI / 2] : [d, t * h, 0];
  };
  for (let i = Math.round((w + h) / 10); i > 0; i--) {
    const [x, y] = along(), r = s * (0.02 + 0.06 * rnd());
    const blot = g.createRadialGradient(x, y, 0, x, y, r);
    blot.addColorStop(0, `rgba(225,242,255,${(0.04 + 0.07 * rnd()).toFixed(3)})`);
    blot.addColorStop(1, 'rgba(225,242,255,0)');
    g.fillStyle = blot;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Ice grain: tiny crystals packed along the rim, thinning out inwards
  g.fillStyle = 'rgba(236,247,255,0.32)';
  for (let i = Math.round((w + h) * 7); i > 0; i--) {
    const x = rnd() * w, y = rnd() * h;
    if (rnd() > edge(x, y)) continue;
    const r = px * (0.4 + rnd() * 0.9);
    g.fillRect(x, y, r, r);
  }
  // Fronds: a stem curling in from the edge, barbs angled along it (longer near the root), and the longer ones
  // branching into fronds of their own
  const stems = new Path2D(), barbs = new Path2D(), soft = new Path2D();
  const frond = (x: number, y: number, a: number, len: number, depth: number) => {
    const step = 5 * px, steps = Math.max(3, Math.round(len / step)), curl = (rnd() - 0.5) * 0.1;
    // (Barbs mostly to one side: a feather, not a fishbone)
    const lean = rnd() < 0.5 ? -1 : 1;
    stems.moveTo(x, y);
    if (depth === 2) soft.moveTo(x, y);
    for (let i = 0; i < steps; i++) {
      a += curl + (rnd() - 0.5) * 0.14;
      x += Math.cos(a) * step; y += Math.sin(a) * step;
      stems.lineTo(x, y);
      if (depth === 2) soft.lineTo(x, y);
      const left = 1 - i / steps;
      for (const side of [lean, lean, -lean]) {
        if (rnd() < (side === lean ? 0.3 : 0.6)) continue;
        const ba = a + side * (0.55 + rnd() * 0.45), bl = step * (0.5 + 2.2 * left) * (0.5 + rnd() * 0.7);
        barbs.moveTo(x, y);
        barbs.lineTo(x + Math.cos(ba) * bl, y + Math.sin(ba) * bl);
      }
      if (depth > 0 && len > 30 * px && rnd() < 2.2 / steps) frond(x, y, a + (rnd() < 0.5 ? -1 : 1) * (0.45 + rnd() * 0.5), len * left * (0.4 + rnd() * 0.35), depth - 1);
    }
  };
  const root = (corner: (t: number) => number, count: number, size: (k: number) => number, depth: number) => {
    for (let i = 0; i < count; i++) {
      const side = Math.floor(rnd() * 4), t = rnd(), k = corner(t);
      const [x, y, inward] = side === 0 ? [t * w, 0, Math.PI / 2] : side === 1 ? [w, t * h, Math.PI] : side === 2 ? [t * w, h, -Math.PI / 2] : [0, t * h, 0];
      frond(x, y, inward + (rnd() - 0.5) * 1.4, size(k), depth);
    }
  };
  // A crust of short crystals all along the rim, then the fronds reaching in, more and longer towards the corners
  root(() => 0, Math.round((w + h) / 4), () => s * (0.008 + 0.02 * rnd()), 0);
  root((t) => (Math.abs(t - 0.5) * 2) ** 2, Math.round((w + h) / 14), (k) => s * (0.04 + 0.2 * k * k + 0.06 * rnd()), 2);
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(200,232,255,0.06)';
  g.lineWidth = 3 * px;
  g.stroke(soft);
  g.strokeStyle = 'rgba(232,245,255,0.15)';
  g.lineWidth = 0.55 * px;
  g.stroke(barbs);
  g.strokeStyle = 'rgba(242,250,255,0.32)';
  g.lineWidth = 0.75 * px;
  g.stroke(stems);
  return c;
}

export class FrostVignette {
  private root: HTMLDivElement;
  private tint: HTMLDivElement;
  private ice: HTMLDivElement;
  private flash: HTMLDivElement;
  private chip: HTMLDivElement;
  /** Texture width (0: tint only) */
  private texWidth = 0;
  private texSize = '';
  /** The texture shown (an object URL of its PNG) */
  private texUrl = '';
  private shown = 0;
  private drawn = -1;
  private last = 100;
  private rising = 0;
  private visible = true;
  private chipKey = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = 'position: fixed; inset: 0; pointer-events: none; z-index: 6; display: none;';
    this.tint = document.createElement('div');
    this.ice = document.createElement('div');
    this.flash = document.createElement('div');
    for (const l of [this.tint, this.ice, this.flash]) l.style.cssText = 'position: absolute; inset: 0;';
    this.ice.style.backgroundSize = '100% 100%';
    this.flash.style.cssText += 'opacity: 0; transition: opacity 0.6s ease-out;'
      + 'background: radial-gradient(ellipse at center, rgba(220,240,255,0) 55%, rgba(225,242,255,0.55) 100%);';
    this.root.append(this.tint, this.ice, this.flash);
    this.chip = document.createElement('div');
    this.chip.className = 'hazard-chip';
    // (Styled as the hazard chips, just under them: HazardOverlay)
    this.chip.style.cssText = 'position: fixed; top: 40px; left: 50%; transform: translateX(-50%); pointer-events: none; z-index: 950; display: none;';
    document.body.append(this.root, this.chip);
    window.addEventListener('resize', () => { this.texSize = ''; this.drawn = -1; });
  }

  /** The graphics tier's say: low draws the tint only */
  setQuality(q: QualityProfile): void {
    if (q.frostTexture === this.texWidth) return;
    this.texWidth = q.frostTexture;
    this.texSize = '';
    this.drawn = -1;
    if (!this.texWidth) this.ice.style.backgroundImage = 'none';
  }

  /** Settings (the full-screen effects): off, the chip still tells the cold */
  setVisible(on: boolean): void {
    this.visible = on;
    this.drawn = -1;
  }

  /** Each frame: the pilot's warmth (%, from the server) and the frame's seconds. Null: no ship */
  update(pct: number | null, dt: number): void {
    const p = pct ?? 100;
    // A sharp drop (a frost hit): the rim flashes (a transition, on the compositor)
    if (p < this.last - 4 && this.texWidth) {
      this.flash.style.transition = 'none';
      this.flash.style.opacity = '1';
      void this.flash.offsetWidth;
      this.flash.style.transition = 'opacity 0.6s ease-out';
      this.flash.style.opacity = '0';
    }
    if (p > this.last) this.rising = 2;
    else if (p < this.last) this.rising = 0;
    this.rising = Math.max(0, this.rising - dt);
    this.last = p;
    // The frost eases to where it should be (quicker coming in than going out)
    const target = frostAmount(p);
    const k = 1 - Math.exp(-dt * (target > this.shown ? 6 : 2.5));
    this.shown += (target - this.shown) * k;
    if (Math.abs(target - this.shown) < 0.002) this.shown = target;
    this.paint();
    this.tell(p);
  }

  private paint(): void {
    const on = this.visible && this.shown > 0.004;
    this.root.style.display = on ? 'block' : 'none';
    if (!on) { this.drawn = -1; return; }
    // (Only a visible step repaints)
    if (this.drawn >= 0 && Math.abs(this.shown - this.drawn) < 0.01) return;
    this.drawn = this.shown;
    const f = this.shown, { inner, outer } = frostMask(f);
    // (With no texture the tint carries the read alone: stronger)
    const a = this.texWidth ? 1 : 1.6;
    this.tint.style.background = `radial-gradient(ellipse at center, rgba(160,210,255,0) ${inner.toFixed(1)}%, rgba(175,220,255,${((0.12 + 0.22 * f) * a).toFixed(3)}) ${outer.toFixed(1)}%, rgba(205,235,255,${((0.2 + 0.3 * f) * a).toFixed(3)}) 100%)`;
    if (!this.texWidth) return;
    const size = `${this.texWidth}x${window.innerWidth}x${window.innerHeight}`;
    if (size !== this.texSize) {
      this.texSize = size;
      const w = this.texWidth, h = Math.max(1, Math.round((w * window.innerHeight) / Math.max(1, window.innerWidth)));
      // (Drawn and encoded once, ever: the tint carries the frost the moment it takes, the first time)
      const made = frostTextures.get(`${w}x${h}`, () => new Promise<Blob>((ok, fail) => drawFrost(w, h).toBlob((b) => (b ? ok(b) : fail(new Error('no frost texture'))))));
      void made.then((png) => {
        if (this.texSize !== size) return;
        if (this.texUrl) URL.revokeObjectURL(this.texUrl);
        this.texUrl = URL.createObjectURL(png);
        this.ice.style.backgroundImage = `url(${this.texUrl})`;
      }, () => {});
    }
    const mask = `radial-gradient(ellipse at center, transparent ${inner.toFixed(1)}%, #000 ${outer.toFixed(1)}%)`;
    this.ice.style.maskImage = mask;
    this.ice.style.setProperty('-webkit-mask-image', mask);
    this.ice.style.opacity = (0.55 + 0.45 * f).toFixed(3);
  }

  /** The chip: warmth %, the stage and its cost, warming or not (hidden when warm) */
  private tell(p: number): void {
    const stage = warmthStage(p).name, s = STAGE[stage];
    const warming = this.rising > 0;
    const key = p >= 100 ? '' : `${p}|${stage}|${warming}`;
    if (key === this.chipKey) return;
    this.chipKey = key;
    this.chip.style.display = key ? 'block' : 'none';
    if (!key) return;
    this.chip.style.color = s.color;
    // (Losing heat: say where to find it)
    const hint = warming ? ' · ▲ warming' : stage === 'warm' ? '' : ' · warm up near a star, station or fire';
    this.chip.textContent = `❄ ${s.label} · warmth ${p}%${s.cost ? ` · ${s.cost}` : ''}${hint}`;
  }
}
