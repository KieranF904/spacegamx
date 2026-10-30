/**
 * Render tuning (dev server only: Game makes it only in a Vite dev build; F8
 * opens it): sliders for the asteroids' size-on-screen thresholds
 * (RockMaterials.ts ROCK_LOD), live, with how many rocks on screen each way
 * draws, the zoom, and a button copying the values to paste into the code;
 * and warps to the dev-only Rockery (data/dev/rockery.json: every rock type) and back.
 * The values are kept in this browser between sessions.
 */

import { ROCK_LOD } from '../rendering/rocks/RockMaterials';
import { rockStats } from '../rendering/lighting/AsteroidBatch';

const STORE = 'sg.dev.rockLod';

const SLIDERS: { key: keyof typeof ROCK_LOD; label: string; max: number }[] = [
  { key: 'light', label: 'Light mesh below (px radius)', max: 40 },
  { key: 'detailFrom', label: 'Detail starts at (px radius)', max: 200 },
  { key: 'detailFull', label: 'Detail full at (px radius)', max: 300 },
];

export class RenderTuningPanel {
  private el = document.createElement('div');
  private stats = document.createElement('div');
  private timer = 0;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code !== 'F8') return;
    e.preventDefault();
    this.toggle();
  };

  constructor(private deps: { zoom: () => number; warp: (systemId: string, x: number, y: number) => void }) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<typeof ROCK_LOD> | null;
      if (saved) for (const s of SLIDERS) if (typeof saved[s.key] === 'number') ROCK_LOD[s.key] = saved[s.key]!;
    } catch { /* nothing kept */ }
    Object.assign(this.el.style, {
      position: 'fixed', right: '16px', top: '220px', width: '300px', padding: '12px 14px', zIndex: '9000', display: 'none',
      background: 'rgba(8, 14, 24, 0.92)', border: '1px solid #2c4a66', borderRadius: '6px', color: '#cfe3f5',
      font: '12px Segoe UI, sans-serif', userSelect: 'none',
    });
    const title = document.createElement('div');
    title.textContent = 'RENDER TUNING · F8 (dev only)';
    Object.assign(title.style, { letterSpacing: '2px', fontSize: '11px', color: '#7fb3d9', marginBottom: '10px' });
    this.el.appendChild(title);
    const sub = document.createElement('div');
    sub.textContent = 'Asteroids, by their radius on screen';
    Object.assign(sub.style, { marginBottom: '8px', color: '#9bb6cc' });
    this.el.appendChild(sub);
    for (const s of SLIDERS) {
      const row = document.createElement('label');
      Object.assign(row.style, { display: 'block', marginBottom: '8px' });
      const name = document.createElement('div');
      const input = document.createElement('input');
      input.type = 'range'; input.min = '0'; input.max = String(s.max); input.step = '1'; input.value = String(ROCK_LOD[s.key]);
      Object.assign(input.style, { width: '100%' });
      const show = () => { name.textContent = `${s.label}: ${ROCK_LOD[s.key]}`; };
      input.addEventListener('input', () => {
        ROCK_LOD[s.key] = Number(input.value);
        // keep them in order: light ≤ detail start ≤ detail full
        ROCK_LOD.detailFull = Math.max(ROCK_LOD.detailFull, ROCK_LOD.detailFrom + 1);
        show();
        try { localStorage.setItem(STORE, JSON.stringify(ROCK_LOD)); } catch { /* not kept */ }
      });
      show();
      row.append(name, input);
      this.el.appendChild(row);
    }
    this.el.appendChild(this.stats);
    Object.assign(this.stats.style, { margin: '8px 0', lineHeight: '1.5', color: '#9bb6cc' });
    const copy = document.createElement('button');
    copy.textContent = 'Copy values';
    Object.assign(copy.style, { marginRight: '6px', background: '#16304a', color: '#cfe3f5', border: '1px solid #2c4a66', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer' });
    copy.addEventListener('click', () => {
      const text = `export const ROCK_LOD = { light: ${ROCK_LOD.light}, detailFrom: ${ROCK_LOD.detailFrom}, detailFull: ${ROCK_LOD.detailFull} };`;
      void navigator.clipboard?.writeText(text).then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy values'; }, 1200); }, () => { copy.textContent = text; });
    });
    this.el.appendChild(copy);
    const warp = (label: string, systemId: string, x: number, y: number) => {
      const b = document.createElement('button');
      b.textContent = label;
      Object.assign(b.style, { marginRight: '6px', marginTop: '6px', background: '#16304a', color: '#cfe3f5', border: '1px solid #2c4a66', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer' });
      b.addEventListener('click', () => this.deps.warp(systemId, x, y));
      this.el.appendChild(b);
    };
    warp('Warp to Rockery', 'dev_rockery', 6500, 0);
    warp('Back to Sol', 'sol', 50000, 0);
    document.body.appendChild(this.el);
    window.addEventListener('keydown', this.onKey, true);
  }

  private toggle(): void {
    const open = this.el.style.display === 'none';
    this.el.style.display = open ? 'block' : 'none';
    clearInterval(this.timer);
    if (open) { this.refresh(); this.timer = window.setInterval(() => this.refresh(), 250); }
  }

  private refresh(): void {
    const s = rockStats;
    this.stats.innerHTML = `Zoom ${this.deps.zoom().toFixed(3)}<br>Rocks on screen: ${s.light + s.plain + s.detail} · light mesh ${s.light} · plain ${s.plain} · detail ${s.detail}<br>Chunks drawn ${s.chunks} · with materials ${s.materialChunks}`;
  }

  destroy(): void {
    clearInterval(this.timer);
    window.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
  }
}
