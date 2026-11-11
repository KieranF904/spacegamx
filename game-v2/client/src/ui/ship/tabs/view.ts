/**
 * Small pieces the Ship window's tabs share: a tab's own root kept between draws (so a live redraw keeps the elements
 * it can), section heads, rows and meters as HTML, number formats, and clicks on `data-act` buttons handled once.
 */
import { esc } from '../../escape';

/** A tab's root element: made once, put back into the body when the tab is shown */
export function tabRoot(body: HTMLElement, root: HTMLElement | null, make: () => HTMLElement): HTMLElement {
  const r = root ?? make();
  if (r.parentElement !== body) body.appendChild(r);
  return r;
}

/**
 * Presses on `[data-act]` inside `root` go to `run(act, value, event)` (one listener; the HTML can be redrawn freely).
 * Taken on the press, not the click: a live redraw between press and release would swallow a click
 */
export function onAct(root: HTMLElement, run: (act: string, value: string, e: MouseEvent) => void): void {
  root.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b || !root.contains(b) || (b as HTMLButtonElement).disabled) return;
    e.preventDefault();
    run(b.dataset.act!, b.dataset.v ?? '', e);
  });
}

export const sec = (title: string, right = ''): string => `<div class="sgsw-sec">${esc(title)}${right ? `<span>${right}</span>` : ''}</div>`;

export const meter = (f: number, color = '#7dd3fc'): string =>
  `<span class="sgsw-meter"><i style="width:${(Math.max(0, Math.min(1, f)) * 100).toFixed(0)}%; background:${color}"></i></span>`;

export const row = (name: string, value: string, extra = ''): string =>
  `<div class="sgsw-row"><span class="nm">${name}</span>${extra}<span class="v">${value}</span></div>`;

export const note = (html: string, cls = ''): string => `<div class="sgsw-note ${cls}">${html}</div>`;

/** "42" / "1.5" for small numbers, thousands grouped */
export function num(v: number): string {
  if (!Number.isFinite(v)) return '∞';
  const a = Math.abs(v);
  return a < 10 && a !== Math.round(a) ? v.toFixed(1) : Math.round(v).toLocaleString('en-GB');
}

/** "+42/s" / "−30/s" */
export const rate = (v: number): string => `${v >= 0 ? '+' : '−'}${num(Math.abs(v))}/s`;

export const pct = (f: number): string => `${Math.round(f * 100)}%`;

export { esc };
