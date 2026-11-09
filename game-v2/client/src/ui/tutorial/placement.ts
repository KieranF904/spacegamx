/**
 * @contract client.ui.tutorial.placement
 * owns:       where the instruction card sits: its usual top-centre spot, or by the window the pilot is looking at (above, under,
 *             beside, or over its bottom edge on a short screen), clear of the controls the step points at, clamped to the screen;
 *             and finding that window's rect
 * needs:      nothing (pure math; the DOM lookup takes a document-like object)
 * invariants: the card never covers a window's top edge (title, tabs, close) while there is room above, under or beside it; it never
 *             covers a glowing control while another spot fits; it always stays inside the viewport — client/src/ui/tutorial/placement.test.ts
 * extend:     a new kind of anchor is one entry in ANCHORS (selector, which element's rect, mode)
 */

export interface Rect { left: number; top: number; width: number; height: number }
export interface Size { w: number; h: number }
/** `above`: sits over the anchor's top edge; `below`: under a bar; `inside`: just inside the anchor's top */
export type AnchorMode = 'above' | 'below' | 'inside';
export interface CardAnchor { rect: Rect; mode: AnchorMode }

export const CARD_MARGIN = 8;
export const CARD_GAP = 10;
/** The usual top-centre spot's distance from the top */
export const HOME_TOP = 10;

/** Do two rects overlap (touching edges do not)? */
function hits(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * Where the card's top-left goes (px, in the viewport) for the anchor, or the usual top-centre spot with none. `avoid`: the
 * controls the step points at (the glowing ones): a spot that would cover one is passed over while another fits.
 *
 * Over a window (`above`) the card takes the first of: right above it, right under it, beside it (right, then left), and only
 * then over the window's bottom edge (the end of the screen) or, last, the top of the screen. So a window too tall or too
 * wide for room around it (a short screen) loses its bottom strip to the card, never its title bar, tabs or close button
 */
export function cardPosition(anchor: CardAnchor | null, card: Size, vp: Size, avoid: readonly Rect[] = []): { x: number; y: number } {
  const maxX = Math.max(CARD_MARGIN, vp.w - card.w - CARD_MARGIN), maxY = Math.max(CARD_MARGIN, vp.h - card.h - CARD_MARGIN);
  const clampX = (x: number) => Math.min(maxX, Math.max(CARD_MARGIN, x));
  const clampY = (y: number) => Math.min(maxY, Math.max(CARD_MARGIN, y));
  const fits = (x: number, y: number) => x >= CARD_MARGIN && y >= CARD_MARGIN && x + card.w <= vp.w - CARD_MARGIN && y + card.h <= vp.h - CARD_MARGIN;
  // Each candidate: the spot, and whether it must fit as it is (false: clamped into the screen, always usable)
  const cands: { x: number; y: number; strict: boolean }[] = [];
  const add = (x: number, y: number, strict: boolean) => cands.push(strict ? { x, y, strict } : { x: clampX(x), y: clampY(y), strict });
  if (!anchor) {
    add((vp.w - card.w) / 2, HOME_TOP, false);
    add((vp.w - card.w) / 2, vp.h - card.h - CARD_MARGIN, false);
  } else {
    const { rect, mode } = anchor;
    const cx = clampX(rect.left + rect.width / 2 - card.w / 2), bottom = rect.top + rect.height;
    if (mode === 'below') {
      add(cx, bottom + CARD_GAP, false);
      add(cx, vp.h - card.h - CARD_MARGIN, false);
    } else if (mode === 'inside') {
      add(cx, rect.top + CARD_MARGIN, false);
      add(cx, bottom - card.h - CARD_MARGIN, false);
    } else {
      const top = clampY(rect.top);
      add(cx, rect.top - card.h - CARD_GAP, true);
      add(cx, bottom + CARD_GAP, true);
      add(rect.left + rect.width + CARD_GAP, top, true);
      add(rect.left - CARD_GAP - card.w, top, true);
      add(cx, vp.h - card.h - CARD_MARGIN, false);
      add(cx, CARD_MARGIN, false);
    }
  }
  const usable = cands.filter((c) => !c.strict || fits(c.x, c.y));
  const clear = usable.find((c) => !avoid.some((r) => hits({ left: c.x, top: c.y, width: card.w, height: card.h }, r)));
  const c = clear ?? usable[0];
  return { x: c.x, y: c.y };
}

/** The DOM bits the lookup reads */
export interface AnchorEl {
  rect(): Rect;
  /** On screen (not display:none, not in a hidden window) */
  shown(): boolean;
}

interface AnchorKind { selector: string; inner?: string; mode: AnchorMode }

/** In priority order: the map's top bar (the card goes under it), the hangar's view (the card goes inside its top), then any open window's panel (the card goes above it; the last one open is on top) */
export const ANCHORS: AnchorKind[] = [
  { selector: '#galaxy-map', inner: '.gm-bar', mode: 'below' },
  { selector: '[data-tut="hangar-view"]', mode: 'inside' },
  { selector: '.sgw-veil', inner: '.sgw', mode: 'above' },
];

/** The first anchor kind with a shown element (the last such element of the kind), or null: `find(selector, inner)` lists them in document order */
export function findAnchor(find: (selector: string, inner?: string) => AnchorEl[]): CardAnchor | null {
  for (const k of ANCHORS) {
    const els = find(k.selector, k.inner).filter((e) => e.shown());
    const e = els[els.length - 1];
    if (!e) continue;
    const rect = e.rect();
    if (rect.width > 0 && rect.height > 0) return { rect, mode: k.mode };
  }
  return null;
}

/** The real document's lookup for findAnchor */
export function domFind(doc: Document = document): (selector: string, inner?: string) => AnchorEl[] {
  return (selector, inner) => Array.from(doc.querySelectorAll<HTMLElement>(selector)).flatMap((outer) => {
    const el = inner ? outer.querySelector<HTMLElement>(inner) : outer;
    if (!el) return [];
    return [{
      shown: () => outer.getClientRects().length > 0 && el.getClientRects().length > 0,
      rect: () => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; },
    }];
  });
}

export function sameRect(a: Rect | null, b: Rect | null): boolean {
  return a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
}
