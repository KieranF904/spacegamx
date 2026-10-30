/**
 * DOM writes that skip when nothing changed. Writing the same text or style
 * every frame still makes the browser restyle (and often lay out) the page.
 */

export function setText(el: Element | null | undefined, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

export function setHtml(el: Element | null | undefined, html: string): void {
  if (el && (el as HTMLElement & { __html?: string }).__html !== html) {
    (el as HTMLElement & { __html?: string }).__html = html;
    el.innerHTML = html;
  }
}

type Prop = 'width' | 'height' | 'background' | 'opacity' | 'display' | 'transform' | 'color' | 'flexDirection';
/** The last value written per element and property (reading styles back gives them normalised, so they'd never match) */
const written = new WeakMap<HTMLElement, Partial<Record<Prop, string>>>();

export function setStyle(el: HTMLElement | null | undefined, prop: Prop, value: string): void {
  if (!el) return;
  let w = written.get(el);
  if (!w) { w = {}; written.set(el, w); }
  if (w[prop] === value) return;
  w[prop] = value;
  el.style[prop] = value;
}
