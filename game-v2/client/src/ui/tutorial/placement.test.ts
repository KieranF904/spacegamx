import { describe, expect, it } from 'vitest';
import { ANCHORS, CARD_GAP, CARD_MARGIN, HOME_TOP, cardPosition, findAnchor, type AnchorEl, type Rect } from './placement';

const vp = { w: 1280, h: 800 };
const card = { w: 440, h: 120 };
const panel: Rect = { left: 300, top: 200, width: 680, height: 500 };

describe('card placement', () => {
  it('sits top-centre with no anchor', () => {
    expect(cardPosition(null, card, vp)).toEqual({ x: 420, y: HOME_TOP });
  });
  it('sits right above the panel, centred on it, with the gap between', () => {
    const p = cardPosition({ rect: panel, mode: 'above' }, card, vp);
    expect(p.x).toBe(panel.left + panel.width / 2 - card.w / 2);
    expect(p.y + card.h + CARD_GAP).toBe(panel.top);
  });
  it('takes the top of the screen when there is no room above', () => {
    const p = cardPosition({ rect: { ...panel, top: 60 }, mode: 'above' }, card, vp);
    expect(p.y).toBe(CARD_MARGIN);
  });
  it('stays inside the viewport sideways', () => {
    expect(cardPosition({ rect: { left: 0, top: 300, width: 100, height: 100 }, mode: 'above' }, card, vp).x).toBe(CARD_MARGIN);
    expect(cardPosition({ rect: { left: 1200, top: 300, width: 80, height: 100 }, mode: 'above' }, card, vp).x).toBe(vp.w - card.w - CARD_MARGIN);
  });
  it('goes under a bar, and inside the top of a view', () => {
    const bar: Rect = { left: 0, top: 0, width: 1280, height: 52 };
    expect(cardPosition({ rect: bar, mode: 'below' }, card, vp).y).toBe(52 + CARD_GAP);
    expect(cardPosition({ rect: { left: 400, top: 44, width: 500, height: 700 }, mode: 'inside' }, card, vp).y).toBe(44 + CARD_MARGIN);
  });
  it('never leaves the bottom of a short screen', () => {
    const p = cardPosition({ rect: { left: 0, top: 0, width: 1280, height: 700 }, mode: 'below' }, card, { w: 1280, h: 300 });
    expect(p.y + card.h).toBeLessThanOrEqual(300 - CARD_MARGIN);
  });
});

describe('finding the anchor', () => {
  const el = (rect: Rect, shown = true): AnchorEl => ({ rect: () => rect, shown: () => shown });
  it('takes the last shown window, skips hidden ones', () => {
    const veil = ANCHORS.find((a) => a.selector === '.sgw-veil')!;
    const a = findAnchor((s) => (s === veil.selector ? [el(panel), el({ ...panel, left: 10 }), el({ ...panel, left: 99 }, false)] : []));
    expect(a).toEqual({ rect: { ...panel, left: 10 }, mode: 'above' });
  });
  it('finds nothing when no window is up, or its rect is empty', () => {
    expect(findAnchor(() => [])).toBeNull();
    expect(findAnchor(() => [el({ left: 0, top: 0, width: 0, height: 0 })])).toBeNull();
  });
  it('prefers the map over a window', () => {
    const find = (s: string) => (s === '#galaxy-map' ? [el({ left: 0, top: 0, width: 1280, height: 52 })] : [el(panel)]);
    expect(findAnchor(find)?.mode).toBe('below');
  });
});
