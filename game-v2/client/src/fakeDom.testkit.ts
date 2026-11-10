/**
 * A very small stand-in for the DOM, for client tests of view code that only makes elements, sets their fields and
 * listens (the client tests run in node: no jsdom). Not a browser: only what those views touch.
 */
import { vi } from 'vitest';

type Handler = (e: unknown) => void;

export class FakeEl {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  listeners: Record<string, Handler[]> = {};
  innerHTML = '';
  textContent = '';
  className = '';
  title = '';
  id = '';
  type = '';
  hidden = false;
  width = 0;
  height = 0;
  offsetWidth = 100;
  offsetHeight = 50;
  isConnected = true;
  offsetParent: unknown = {};
  onclick: (() => void) | null = null;
  removed = false;
  private found = new Map<string, FakeEl>();
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  appendChild(c: FakeEl): FakeEl { this.children.push(c); return c; }
  append(...c: FakeEl[]): void { this.children.push(...c); }
  remove(): void { this.removed = true; }
  insertAdjacentHTML(): void {}
  addEventListener(t: string, f: Handler): void { (this.listeners[t] ??= []).push(f); }
  removeEventListener(t: string, f: Handler): void { this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f); }
  /** The same element for the same selector (what a card made from innerHTML would hold) */
  querySelector(sel: string): FakeEl {
    let e = this.found.get(sel);
    if (!e) this.found.set(sel, (e = new FakeEl('div')));
    return e;
  }
  getContext(): unknown { return sink(); }
  toDataURL(): string { return 'data:image/png;base64,'; }
}

/** Anything called on it does nothing and gives back itself; properties set on it are kept */
export function sink(): never {
  const target = function () {} as unknown as Record<string | symbol, unknown>;
  return new Proxy(target, { get: (t, k) => (k in t ? t[k] : sink()), set: () => true, apply: () => sink() } as ProxyHandler<typeof target>) as never;
}

/** document, window and animation frames as stand-ins; undo with vi.unstubAllGlobals() */
export function installFakeDom(): { body: FakeEl; frames: Map<number, () => void>; docListeners: Record<string, Handler[]> } {
  const body = new FakeEl('body');
  const docListeners: Record<string, Handler[]> = {};
  const frames = new Map<number, () => void>();
  let next = 1;
  vi.stubGlobal('document', {
    createElement: (tag: string) => new FakeEl(tag),
    body,
    head: new FakeEl('head'),
    addEventListener: (t: string, f: Handler) => { (docListeners[t] ??= []).push(f); },
    removeEventListener: (t: string, f: Handler) => { docListeners[t] = (docListeners[t] ?? []).filter((x) => x !== f); },
  });
  vi.stubGlobal('window', {
    innerWidth: 1200, innerHeight: 800,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  });
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => { frames.set(next, f); return next++; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  return { body, frames, docListeners };
}
