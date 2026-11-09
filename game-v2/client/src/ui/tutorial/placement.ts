/**
 * @contract client.ui.tutorial.placement
 * owns:       where the instruction card sits: its usual top-centre spot, or right above (or just under, or just inside) the
 *             window the pilot is looking at, clamped to the screen; and finding that window's rect
 * needs:      nothing (pure math; the DOM lookup takes a document-like object)
 * invariants: the card never covers the anchor's top edge when there is room above it; it always stays inside the viewport — client/src/ui/tutorial/placement.test.ts
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

/** Where the card's top-left goes (px, in the viewport) for the anchor, or the usual top-centre spot with none */
export function cardPosition(anchor: CardAnchor | null, card: Size, vp: Size): { x: number; y: number } {
  const maxX = Math.max(CARD_MARGIN, vp.w - card.w - CARD_MARGIN), maxY = Math.max(CARD_MARGIN, vp.h - card.h - CARD_MARGIN);
  const clampX = (x: number) => Math.min(maxX, Math.max(CARD_MARGIN, x));
  if (!anchor) return { x: clampX((vp.w - card.w) / 2), y: HOME_TOP };
  const { rect, mode } = anchor;
  const x = clampX(rect.left + rect.width / 2 - card.w / 2);
  let y: number;
  if (mode === 'below') y = rect.top + rect.height + CARD_GAP;
  else if (mode === 'inside') y = rect.top + CARD_MARGIN;
  else {
    y = rect.top - card.h - CARD_GAP;
    // No room above the panel: just inside the top of the screen (the veil), still above the panel as far as it goes
    if (y < CARD_MARGIN) y = CARD_MARGIN;
  }
  return { x, y: Math.min(maxY, Math.max(CARD_MARGIN, y)) };
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
