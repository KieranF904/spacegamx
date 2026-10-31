/**
 * Hit confirmation: four short ticks flash round the cursor when your shot lands, longer and brighter for a harder
 * hit (damage over HIT_REF). A pool of one element, restarted by each hit; nothing is made per frame. It does not touch
 * the crosshair itself (the weapon ring is drawn by the HUD), only sits over the cursor.
 */

import { shotScale } from '../rendering/weapons/weaponStyles';

let box: HTMLDivElement | null = null;
let x = -100, y = -100;
let listening = false;

function build(): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2000;opacity:0;will-change:transform,opacity';
  for (let i = 0; i < 4; i++) {
    const t = document.createElement('div');
    t.style.cssText = 'position:absolute;left:-1px;top:-1px;width:2px;height:8px;background:currentColor;box-shadow:0 0 4px currentColor;border-radius:1px';
    t.style.transform = `rotate(${45 + i * 90}deg) translateY(-14px)`;
    el.appendChild(t);
  }
  document.body.appendChild(el);
  return el;
}

/** How big the tick is for a hit of `damage`: 1 for a cannon's, up to ~1.7 for a torpedo's */
export function hitTickSize(damage: number): number {
  return shotScale(damage);
}

/** Flash the tick at the cursor for a hit of `damage` (a glancing or tiny hit still shows, small) */
export function showHitTick(damage: number, crit = false): void {
  if (typeof document === 'undefined') return;
  try {
    if (!listening) {
      listening = true;
      window.addEventListener('pointermove', (e) => { x = e.clientX; y = e.clientY; }, { passive: true });
    }
    box ??= build();
    const s = hitTickSize(damage);
    box.style.transform = `translate(${x}px,${y}px)`;
    box.style.color = crit ? '#ffd24a' : '#fff';
    box.animate?.(
      [
        { opacity: 1, transform: `translate(${x}px,${y}px) scale(${0.7 * s})` },
        { opacity: 0, transform: `translate(${x}px,${y}px) scale(${1.25 * s})` },
      ],
      { duration: 180 + 60 * s, easing: 'ease-out' },
    );
  } catch {
    // (no DOM, or animations blocked: the tick is only a nicety)
  }
}
