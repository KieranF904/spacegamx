/**
 * The cold on screen: ice frosting in from the edges as the ship's warmth runs down (common/src/ships/warmth.ts),
 * corners first, and back out as it warms up. It is how the meter is read; a small chip beside it gives the number,
 * the stage and what it costs, and says when the ship is warming. Frost hits (a gemmed gun, the Brood Mother) land
 * on the same meter, so they frost the screen too, with a flash at the rim.
 *
 * Cheap: one fixed layer that is hidden when warm. Low quality draws a gradient tint only; medium and high draw a
 * frost texture (made once, again on a resize) revealed from the edges by a mask, which is only touched when the
 * frost has moved a visible step.
 */

import { warmthStage, type WarmthStageName } from '@space-game/common';
import type { QualityProfile } from '../settings/quality';

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

/** Ice crystals branching in from the edges, densest at the corners (seeded: the same frost every time) */
function drawFrost(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // A soft rime over everything (the mask decides how far in it shows)
  const rime = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.hypot(w, h) / 2);
  rime.addColorStop(0, 'rgba(200,228,255,0.05)');
  rime.addColorStop(1, 'rgba(225,242,255,0.5)');
  g.fillStyle = rime;
  g.fillRect(0, 0, w, h);
  const s = Math.min(w, h);
  const branch = (x: number, y: number, a: number, len: number, depth: number) => {
    const x1 = x + Math.cos(a) * len, y1 = y + Math.sin(a) * len;
    g.lineWidth = Math.max(0.6, depth * 0.7);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x1, y1); g.stroke();
    if (depth <= 0) return;
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1), bx = x + (x1 - x) * t, by = y + (y1 - y) * t, sub = len * (0.45 - 0.25 * t) * (0.7 + rnd() * 0.5);
      branch(bx, by, a + Math.PI / 3, sub, depth - 1);
      branch(bx, by, a - Math.PI / 3, sub, depth - 1);
    }
  };
  // Crystals rooted along each edge, pointing in (more, and longer, towards the corners)
  const seeds = Math.round((w + h) / 26);
  for (let i = 0; i < seeds; i++) {
    const side = Math.floor(rnd() * 4), t = rnd(), corner = Math.abs(t - 0.5) * 2;
    const [x, y, inward] = side === 0 ? [t * w, 0, Math.PI / 2] : side === 1 ? [w, t * h, Math.PI] : side === 2 ? [t * w, h, -Math.PI / 2] : [0, t * h, 0];
    const len = s * (0.05 + 0.13 * corner * corner + rnd() * 0.06);
    const a = inward + (rnd() - 0.5) * 1.1;
    g.strokeStyle = 'rgba(190,225,255,0.18)';
    branch(x, y, a, len * 1.05, 2);
    g.strokeStyle = 'rgba(240,250,255,0.55)';
    branch(x, y, a, len, 2);
  }
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
      this.ice.style.backgroundImage = `url(${drawFrost(w, h).toDataURL()})`;
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
    this.chip.textContent = `❄ ${s.label} · warmth ${p}%${s.cost ? ` · ${s.cost}` : ''}${warming ? ' · ▲ warming' : ''}`;
  }
}
