/**
 * The right-click menu (ContextActions.ts fills it): one section per thing
 * under the cursor, each headed by its name, kind and distance, then its
 * options. Nothing happens until an option is chosen:
 *   mouse     click an option (hovering it selects it)
 *   keys      ↑ ↓ to move, Enter to take it, 1–9 to take one by number,
 *             Esc to close
 * Disabled options are greyed, with why as their tooltip; the default is
 * highlighted. The menu sits at the click, flipped at the screen's edges
 * (contextClick.ts placeMenu).
 */

import { placeMenu, defaultIndex, stepIndex, outsideBy, type MenuOption } from '../input/contextClick';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** One thing's part of the menu */
export interface MenuSection {
  /** "Sol Central" (null: open space, no header line of its own) */
  title: string;
  /** "STATION" */
  kind: string;
  /** "4.2 km" */
  dist: string;
  /** Its accent */
  color: string;
  options: MenuOption[];
}

/** 16px line icons, stroked in currentColor */
const ICONS: Record<string, string> = {
  dock: '<path d="M8 2v9M4.5 8.5 8 12l3.5-3.5"/><path d="M3 14h10"/>',
  fly: '<path d="M2.5 13.5 13.5 8 2.5 2.5 5 8z"/>',
  jump: '<path d="M2.5 4l4 4-4 4M8 4l4 4-4 4"/><path d="M14 3v10"/>',
  gate: '<circle cx="8" cy="8" r="5.5"/><path d="M5 8h6M9 5.5 11.5 8 9 10.5"/>',
  enter: '<path d="M6 2.5h6.5v11H6"/><path d="M2 8h7M6.5 5.5 9 8l-2.5 2.5"/>',
  land: '<path d="M2 13.5a6 6 0 0 1 12 0"/><path d="M8 1.5v7M5.5 6 8 8.5 10.5 6"/>',
  talk: '<path d="M2.5 3.5h11v7H7l-3 2.5v-2.5H2.5z"/>',
  target: '<circle cx="8" cy="8" r="4.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>',
  inspect: '<circle cx="8" cy="8" r="6"/><path d="M8 7v4.5M8 4.6v.1"/>',
  invite: '<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5c.5-2.6 2.2-4 4.5-4s4 1.4 4.5 4M12.5 5v5M10 7.5h5"/>',
  trade: '<path d="M2 5h10.5M10 2.5 12.5 5 10 7.5M14 11H3.5M6 8.5 3.5 11 6 13.5"/>',
  mark: '<path d="M8 14.5s-4.5-4.6-4.5-8a4.5 4.5 0 0 1 9 0c0 3.4-4.5 8-4.5 8z"/><circle cx="8" cy="6.5" r="1.5"/>',
  mine: '<path d="M3 13 9.5 6.5M7 3.5c2.5-1 5-.5 6.5 1-1.5-.3-3.3.2-4.5 1.2M12.5 9c1-2.5.5-5-1-6.5.3 1.5-.2 3.3-1.2 4.5"/>',
  collect: '<path d="M8 1.5 13.5 8 8 14.5 2.5 8z"/><path d="M2.5 8h11"/>',
  stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/>',
};

const svg = (id: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[id] ?? ICONS.fly}</svg>`;

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.cxm { position: fixed; left: 0; top: 0; z-index: 4050; display: none; min-width: 236px; max-width: 320px; padding: 4px;
  background: linear-gradient(180deg, rgba(14, 21, 38, 0.98), rgba(8, 12, 24, 0.98)); border: 1px solid rgba(140, 170, 220, 0.3); border-radius: 9px;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(0, 0, 0, 0.4); font: 13px 'Segoe UI', system-ui, sans-serif; color: #d6deeb;
  user-select: none; transform-origin: top left; animation: cxmin 90ms ease-out; }
.cxm.fx { transform-origin: top right; } .cxm.fy { transform-origin: bottom left; } .cxm.fx.fy { transform-origin: bottom right; }
@keyframes cxmin { from { opacity: 0; transform: scale(0.96); } }
.cxm-h { display: flex; align-items: baseline; gap: 8px; padding: 6px 9px 5px; }
.cxm-h + .cxm-o, .cxm-o + .cxm-o { margin-top: 1px; }
.cxm-sec + .cxm-sec { margin-top: 3px; padding-top: 3px; border-top: 1px solid rgba(140, 170, 220, 0.13); }
.cxm-h b { font: 700 13px 'Segoe UI', sans-serif; color: #f1f5fb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.cxm-h i { font: 700 9px 'Segoe UI', sans-serif; font-style: normal; letter-spacing: 1.5px; color: var(--c, #7dd3fc); text-transform: uppercase; white-space: nowrap; }
.cxm-h em { margin-left: auto; font: 600 11px 'Segoe UI', sans-serif; font-style: normal; color: #8394ad; font-variant-numeric: tabular-nums; white-space: nowrap; padding-left: 10px; }
.cxm-o { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 18px 1fr auto; align-items: center; gap: 9px; width: 100%;
  padding: 6px 9px; border-radius: 6px; cursor: pointer; color: #d6deeb; border-left: 2px solid transparent; }
.cxm-o svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; color: #7dd3fc; }
.cxm-o .l { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cxm-o .l small { margin-left: 7px; font-size: 11px; color: #6f8099; }
.cxm-o kbd { font: 700 10px 'Segoe UI', sans-serif; color: #6f8099; min-width: 14px; text-align: center; padding: 0 3px; border: 1px solid rgba(140, 170, 220, 0.2); border-radius: 3px; line-height: 15px; }
.cxm-o.p { color: #fde68a; } .cxm-o.p svg { color: #f0b54a; } .cxm-o.p .l { font-weight: 600; }
.cxm-o.sel { background: rgba(125, 211, 252, 0.11); border-left-color: #4dd0e1; color: #fff; }
.cxm-o.sel kbd { color: #d6deeb; border-color: rgba(125, 211, 252, 0.45); }
.cxm-o.p.sel { background: rgba(240, 181, 74, 0.13); border-left-color: #f0b54a; color: #fff3c4; }
.cxm-o.off { cursor: default; color: #5b6880; } .cxm-o.off svg { color: #4a566b; } .cxm-o.off .l small { color: #6b5a5a; }
.cxm-o.off .why { display: block; font-size: 11px; color: #c08a7a; margin-top: 1px; white-space: normal; }
.cxm-f { padding: 5px 9px 3px; margin-top: 3px; border-top: 1px solid rgba(140, 170, 220, 0.13); font: 600 10px 'Segoe UI', sans-serif; letter-spacing: 0.5px; color: #56637a; }
@media (prefers-reduced-motion: reduce) { .cxm { animation: none; } }
`;
  document.head.appendChild(css);
}

export class ContextMenuUI {
  private el = document.createElement('div');
  private options: MenuOption[] = [];
  /** Which section each option is in */
  private sectionOf: number[] = [];
  private sel = -1;
  private html = '';
  private box = { x: 0, y: 0, w: 0, h: 0 };
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private downHandler = (e: MouseEvent) => this.onOutsideDown(e);
  /** An option was chosen: its index in the flat list, and its section */
  onPick: ((opt: MenuOption, section: number) => void) | null = null;
  /** Closed by the menu itself (Esc, a click on something else) */
  onClose: (() => void) | null = null;
  /** Clicks on this element are ContextActions' to judge (the canvas: a click there may be the guns) */
  ignoreOutside: HTMLElement | null = null;

  constructor() {
    injectStyles();
    this.el.className = 'cxm';
    this.el.setAttribute('role', 'menu');
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('mousemove', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.cxm-o');
      const i = row ? Number(row.dataset.i) : -1;
      if (i >= 0 && !this.options[i]?.disabled && i !== this.sel) { this.sel = i; this.paintSel(); }
    });
    this.el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    this.el.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.cxm-o');
      if (row) this.take(Number(row.dataset.i));
    });
    document.body.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.el.style.display === 'block';
  }

  /** The section the selected option is in (-1: none) */
  get selectedSection(): number {
    return this.sel >= 0 ? this.sectionOf[this.sel] ?? -1 : -1;
  }

  /** Open at a click (screen px) */
  open(at: { x: number; y: number }, sections: MenuSection[], footer: string): void {
    const wasOpen = this.isOpen;
    this.html = '';
    this.sel = -1;
    this.render(sections, footer);
    this.sel = defaultIndex(this.options);
    this.paintSel();
    // (Restart the open animation)
    this.el.style.animation = 'none';
    this.el.style.display = 'block';
    void this.el.offsetWidth;
    this.el.style.animation = '';
    const r = this.el.getBoundingClientRect();
    const p = placeMenu(at, { w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight });
    this.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    this.el.classList.toggle('fx', p.flipX);
    this.el.classList.toggle('fy', p.flipY);
    this.box = { x: p.x, y: p.y, w: r.width, h: r.height };
    if (!wasOpen) {
      window.addEventListener('keydown', this.keyHandler, true);
      window.addEventListener('mousedown', this.downHandler, true);
    }
  }

  /** Each frame while open: distances and what can be taken now (the options' ids and order stay) */
  refresh(sections: MenuSection[], footer: string): void {
    if (!this.isOpen) return;
    this.render(sections, footer);
    if (this.sel >= 0 && this.options[this.sel]?.disabled) this.sel = defaultIndex(this.options);
    this.paintSel();
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.style.display = 'none';
    this.options = [];
    this.html = '';
    this.sel = -1;
    window.removeEventListener('keydown', this.keyHandler, true);
    window.removeEventListener('mousedown', this.downHandler, true);
  }

  /** How far the cursor is outside the menu (px) */
  distanceFrom(p: { x: number; y: number }): number {
    return outsideBy(p, this.box);
  }

  private render(sections: MenuSection[], footer: string): void {
    const opts: MenuOption[] = [], of: number[] = [];
    let html = '';
    sections.forEach((s, si) => {
      html += `<div class="cxm-sec" style="--c:${s.color}"><div class="cxm-h"><b>${esc(s.title)}</b><i>${esc(s.kind)}</i><em>${esc(s.dist)}</em></div>`;
      for (const o of s.options) {
        const i = opts.length;
        opts.push(o);
        of.push(si);
        const n = i < 9 ? `<kbd>${i + 1}</kbd>` : '<span></span>';
        const cls = `cxm-o${o.primary ? ' p' : ''}${o.disabled ? ' off' : ''}`;
        const hint = o.hint ? `<small>${esc(o.hint)}</small>` : '';
        const why = o.disabled ? `<span class="why">${esc(o.disabled)}</span>` : '';
        html += `<button class="${cls}" data-i="${i}" role="menuitem"${o.disabled ? ` aria-disabled="true" title="${esc(o.disabled)}"` : ''}>${svg(o.icon)}<span class="l">${esc(o.label)}${hint}${why}</span>${n}</button>`;
      }
      html += '</div>';
    });
    if (footer) html += `<div class="cxm-f">${esc(footer)}</div>`;
    this.options = opts;
    this.sectionOf = of;
    if (html !== this.html) {
      this.html = html;
      this.el.innerHTML = html;
      this.box.w = this.el.offsetWidth || this.box.w;
      this.box.h = this.el.offsetHeight || this.box.h;
    }
  }

  private paintSel(): void {
    this.el.querySelectorAll<HTMLElement>('.cxm-o').forEach((b) => b.classList.toggle('sel', Number(b.dataset.i) === this.sel));
  }

  private take(i: number): void {
    const o = this.options[i];
    if (!o || o.disabled) return;
    const section = this.sectionOf[i];
    this.close();
    this.onPick?.(o, section);
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    let used = true;
    if (e.code === 'Escape') { this.close(); this.onClose?.(); }
    else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      if (this.options.some((o) => !o.disabled)) {
        this.sel = this.sel < 0 ? defaultIndex(this.options) : stepIndex(this.options, this.sel, e.code === 'ArrowDown' ? 1 : -1);
        this.paintSel();
      }
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') this.take(this.sel);
    else if (/^(Digit|Numpad)[1-9]$/.test(e.code)) this.take(Number(e.code.slice(-1)) - 1);
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); }
  }

  private onOutsideDown(e: MouseEvent): void {
    if (!this.isOpen || this.el.contains(e.target as Node) || e.target === this.ignoreOutside) return;
    this.close();
    this.onClose?.();
  }
}
