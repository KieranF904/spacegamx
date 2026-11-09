/**
 * @contract client.ui.tutorial.glow
 * owns:       making the UI controls a tutorial step names glow (a pulsing amber outline) until the pilot clicks them: finds them by
 *             selector, picks which stage is up, follows controls that render later, and cleans up on a step change or leave
 * needs:      a GlowHost (the DOM: find, mark, clicks, changes), the document for the real host
 * invariants: a stage clicked once stays done for the step; of the stages not done, the last one with a control on screen glows;
 *             nothing glows after clear() or a step change; the glow class is removed from every control it was put on — client/src/ui/tutorial/glow.test.ts
 * extend:     a step names its controls in data/tutorial.json (`highlight`); the target buttons carry data-tab / data-key / data-tut
 */

/** What Glow needs from the page (a fake in the tests) */
export interface GlowHost<E> {
  /** Controls matching the selector (list) that are on screen; a bad selector finds none */
  find(selector: string): E[];
  mark(el: E, on: boolean): void;
  /** Calls back on each click, with a test of whether the clicked control matches a selector; returns the unsubscribe */
  onClick(cb: (matches: (selector: string) => boolean) => void): () => void;
  /** Calls back when the page changes (controls rendered, tabs switched); returns the unsubscribe */
  onChange(cb: () => void): () => void;
}

export class Glow<E> {
  private key = '';
  private stages: readonly string[] = [];
  private done = new Set<number>();
  private lit = new Set<E>();
  private offClick: (() => void) | null = null;
  private offChange: (() => void) | null = null;

  constructor(private host: GlowHost<E>) {}

  /** The step now showing and its stages (empty: none). The same step and stages again changes nothing */
  set(key: string, stages: readonly string[] | undefined): void {
    const list = stages ?? [];
    if (key === this.key && list.length === this.stages.length && list.every((s, i) => s === this.stages[i])) return;
    this.key = key;
    this.stages = list;
    this.done.clear();
    if (!list.length) { this.unwatch(); this.refresh(); return; }
    this.watch();
    this.refresh();
  }

  /** Nothing glows, nothing is watched */
  clear(): void { this.set('', undefined); }

  /** Which stage is up now (the last one not done whose control is on screen), or -1 */
  active(): number {
    for (let i = this.stages.length - 1; i >= 0; i--) if (!this.done.has(i) && this.host.find(this.stages[i]).length) return i;
    return -1;
  }

  /** Put the glow on the up stage's controls and take it off all others (cheap: call it when the page changes, or now and then) */
  refresh(): void {
    const i = this.active();
    const want = new Set<E>(i >= 0 ? this.host.find(this.stages[i]) : []);
    for (const el of this.lit) if (!want.has(el)) { this.host.mark(el, false); this.lit.delete(el); }
    for (const el of want) if (!this.lit.has(el)) { this.host.mark(el, true); this.lit.add(el); }
  }

  private watch(): void {
    if (!this.offClick) this.offClick = this.host.onClick((matches) => {
      let hit = false;
      this.stages.forEach((s, i) => { if (!this.done.has(i) && matches(s)) { this.done.add(i); hit = true; } });
      if (hit) this.refresh();
    });
    if (!this.offChange) this.offChange = this.host.onChange(() => this.refresh());
  }

  private unwatch(): void {
    this.offClick?.(); this.offClick = null;
    this.offChange?.(); this.offChange = null;
  }
}

export const GLOW_CLASS = 'tut-glow';

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.${GLOW_CLASS} { outline: 2px solid #fbbf24 !important; outline-offset: 2px; border-radius: 6px; animation: tutGlow 1.3s ease-in-out infinite; }
@keyframes tutGlow { 0%, 100% { box-shadow: 0 0 4px 1px rgba(251, 191, 36, 0.45); } 50% { box-shadow: 0 0 16px 5px rgba(251, 191, 36, 0.9); } }
@media (prefers-reduced-motion: reduce) { .${GLOW_CLASS} { animation: none; box-shadow: 0 0 10px 3px rgba(251, 191, 36, 0.8); } }
`;
  document.head.appendChild(css);
}

/** The page's host: elements with the glow class, capture-phase clicks, a MutationObserver (batched to a frame) */
export function domGlowHost(doc: Document = document): GlowHost<HTMLElement> {
  injectStyles();
  return {
    find(selector) {
      try { return Array.from(doc.querySelectorAll<HTMLElement>(selector)).filter((e) => e.getClientRects().length > 0); } catch { return []; }
    },
    mark(el, on) { el.classList.toggle(GLOW_CLASS, on); },
    onClick(cb) {
      const h = (e: Event) => {
        const t = e.target instanceof Element ? e.target : null;
        cb((sel) => { try { return !!t?.closest(sel); } catch { return false; } });
      };
      doc.addEventListener('click', h, true);
      return () => doc.removeEventListener('click', h, true);
    },
    onChange(cb) {
      let queued = false;
      const mo = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; cb(); });
      });
      mo.observe(doc.body, { childList: true, subtree: true });
      return () => mo.disconnect();
    },
  };
}
