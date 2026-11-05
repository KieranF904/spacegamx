/**
 * The objective guide's chevrons: three marks fanning out from your ship
 * towards the next waypoint of the job you follow (its site here, or the
 * gate, rift or planet on the way there), fading as you close in. The line
 * under the tracker says what and how far (QuestClient.setGuide).
 */

import { setStyle } from './domWrite';

const STEPS = [70, 105, 140];

export class GuideUI {
  private root: HTMLDivElement;
  private marks: HTMLDivElement[] = [];
  private hidden = true;

  constructor() {
    const css = document.createElement('style');
    css.textContent = `
.gd-mk { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform; }
.gd-mk::before { content: ''; position: absolute; left: -7px; top: -9px; border-left: 12px solid #fbbf24; border-top: 9px solid transparent; border-bottom: 9px solid transparent;
  filter: drop-shadow(0 0 4px rgba(251,191,36,0.8)); animation: gdpulse 1.6s ease-in-out infinite; }
.gd-mk:nth-child(2)::before { animation-delay: .2s; }
.gd-mk:nth-child(3)::before { animation-delay: .4s; }
@keyframes gdpulse { 0%, 100% { opacity: 0.25; } 40% { opacity: 0.9; } }`;
    document.head.appendChild(css);
    this.root = document.createElement('div');
    this.root.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:815; display:none;';
    for (let i = 0; i < STEPS.length; i++) {
      const m = document.createElement('div');
      m.className = 'gd-mk';
      this.root.appendChild(m);
      this.marks.push(m);
    }
    document.body.appendChild(this.root);
  }

  /** Point from the ship (screen) towards the waypoint (screen), `dist` world units away; null hides */
  update(ship: { x: number; y: number } | null, to: { x: number; y: number } | null, dist: number): void {
    const show = !!ship && !!to && dist > 700;
    if (show !== !this.hidden) {
      this.hidden = !show;
      setStyle(this.root, 'display', show ? 'block' : 'none');
    }
    if (!show) return;
    const a = Math.atan2(to!.y - ship!.y, to!.x - ship!.x);
    const fade = Math.min(1, (dist - 700) / 1500);
    setStyle(this.root, 'opacity', fade.toFixed(2));
    STEPS.forEach((r, i) => {
      const x = ship!.x + Math.cos(a) * r, y = ship!.y + Math.sin(a) * r;
      setStyle(this.marks[i], 'transform', `translate(${Math.round(x)}px, ${Math.round(y)}px) rotate(${a.toFixed(3)}rad)`);
    });
  }
}
