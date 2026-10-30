/**
 * What the right-click menu is pointing at, and what it's doing (ContextActions.ts):
 *   focus   a dashed ring round the thing the menu's selected option is for
 *   target  the place the menu sent the autopilot to: a ring that
 *           breathes, and what happens there ("will dock")
 *   jump    a menu jump's mark: where you clicked, where the drive will
 *           actually drop you if that's short of it, and a pill over the HUD
 *           saying how it's going and how to call it off
 */

import { setHtml, setStyle } from './domWrite';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.cx-ring { position: fixed; left: 0; top: 0; pointer-events: none; z-index: 75; display: none; border-radius: 50%; transform: translate(-50%, -50%);
  border: 1px dashed var(--c, #fde68a); box-shadow: 0 0 14px color-mix(in srgb, var(--c, #fde68a) 35%, transparent); }
.cx-ring.on { border-style: solid; border-width: 2px; animation: cxbreathe 1.6s ease-in-out infinite; }
@keyframes cxbreathe { 50% { opacity: 0.45; } }
.cx-lbl { position: fixed; left: 0; top: 0; pointer-events: none; z-index: 76; display: none; white-space: nowrap; transform: translate(-50%, 0);
  font: 600 11px 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.5px; color: var(--c, #86efac); text-shadow: 0 0 4px #000, 0 0 2px #000; }
.cx-mark { position: fixed; left: 0; top: 0; width: 34px; height: 34px; pointer-events: none; z-index: 76; display: none; transform: translate(-50%, -50%); }
.cx-mark::before, .cx-mark::after { content: ''; position: absolute; left: 50%; top: 50%; background: var(--c, #7dd3fc); transform: translate(-50%, -50%); box-shadow: 0 0 6px var(--c, #7dd3fc); }
.cx-mark::before { width: 34px; height: 2px; } .cx-mark::after { width: 2px; height: 34px; }
.cx-mark i { position: absolute; inset: 5px; border-radius: 50%; border: 2px solid var(--c, #7dd3fc); animation: cxspin 1.2s ease-in-out infinite; }
.cx-mark.land { width: 18px; height: 18px; } .cx-mark.land::before { width: 18px; } .cx-mark.land::after { height: 18px; } .cx-mark.land i { inset: 2px; }
@keyframes cxspin { 50% { transform: scale(1.35); opacity: 0.5; } }
.cx-pill { position: fixed; left: 50%; bottom: 236px; transform: translateX(-50%); display: none; z-index: 881; pointer-events: none; white-space: nowrap;
  padding: 6px 16px; border-radius: 999px; background: rgba(6, 16, 30, 0.85); border: 1px solid rgba(125, 211, 252, 0.55);
  color: #bae6fd; font: 600 12px 'Segoe UI', system-ui, sans-serif; letter-spacing: 0.6px; box-shadow: 0 0 18px rgba(125, 211, 252, 0.15); }
.cx-pill .w { color: #fca5a5; }
@media (prefers-reduced-motion: reduce) { .cx-ring.on, .cx-mark i { animation: none; } }
`;
  document.head.appendChild(css);
}

/** A thing on screen: centre (px) and radius (px) */
export interface ScreenCircle { x: number; y: number; r: number }

export class ContextActionUI {
  private hoverRing = document.createElement('div');
  private orderRing = document.createElement('div');
  private orderLbl = document.createElement('div');
  private mark = document.createElement('div');
  private land = document.createElement('div');
  private markLbl = document.createElement('div');
  private pill = document.createElement('div');

  constructor() {
    injectStyles();
    this.hoverRing.className = 'cx-ring';
    this.orderRing.className = 'cx-ring on';
    this.orderLbl.className = 'cx-lbl';
    this.mark.className = 'cx-mark';
    this.mark.innerHTML = '<i></i>';
    this.land.className = 'cx-mark land';
    this.land.innerHTML = '<i></i>';
    this.markLbl.className = 'cx-lbl';
    this.pill.className = 'cx-pill';
    document.body.append(this.hoverRing, this.orderRing, this.orderLbl, this.mark, this.land, this.markLbl, this.pill);
  }

  /** The thing the menu's selected option is for (null: none) */
  focus(at: ScreenCircle | null, color = '#fde68a'): void {
    this.ring(this.hoverRing, at, color);
  }

  /** The autopilot's target from a right-click, and what happens there */
  target(at: ScreenCircle | null, text: string): void {
    this.ring(this.orderRing, at, '#86efac');
    setStyle(this.orderLbl, 'display', at ? 'block' : 'none');
    if (!at) return;
    setHtml(this.orderLbl, esc(text));
    this.orderLbl.style.setProperty('--c', '#86efac');
    setStyle(this.orderLbl, 'transform', `translate(${Math.round(at.x)}px, ${Math.round(at.y + at.r + 6)}px) translate(-50%, 0)`);
  }

  /** A right-click jump: the mark, where it lands if short of it, the label and the pill (null: none) */
  jump(mark: { x: number; y: number } | null, land: { x: number; y: number } | null, label: string, pill: string, warn: boolean): void {
    const col = warn ? '#f87171' : '#7dd3fc';
    for (const [el, at] of [[this.mark, mark], [this.land, land]] as const) {
      setStyle(el, 'display', at ? 'block' : 'none');
      if (!at) continue;
      el.style.setProperty('--c', col);
      setStyle(el, 'transform', `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) translate(-50%, -50%)`);
    }
    setStyle(this.markLbl, 'display', mark ? 'block' : 'none');
    setStyle(this.pill, 'display', mark ? 'block' : 'none');
    if (!mark) return;
    this.markLbl.style.setProperty('--c', col);
    setHtml(this.markLbl, esc(label));
    setStyle(this.markLbl, 'transform', `translate(${Math.round(mark.x)}px, ${Math.round(mark.y + 22)}px) translate(-50%, 0)`);
    setHtml(this.pill, pill);
  }

  hideAll(): void {
    this.focus(null);
    this.target(null, '');
    this.jump(null, null, '', '', false);
  }

  private ring(el: HTMLDivElement, at: ScreenCircle | null, color: string): void {
    setStyle(el, 'display', at ? 'block' : 'none');
    if (!at) return;
    const d = Math.round(at.r * 2);
    el.style.setProperty('--c', color);
    setStyle(el, 'width', `${d}px`);
    setStyle(el, 'height', `${d}px`);
    setStyle(el, 'transform', `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) translate(-50%, -50%)`);
  }
}
