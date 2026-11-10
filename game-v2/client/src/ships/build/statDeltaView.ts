/**
 * @contract client.ships.build.stat-delta-view
 * owns:       showing a StatDelta: the small card that follows the cursor, the +/- chips beside each stat in a stats panel, and
 *             the controller that keeps both current as the hovered cell, the hand or the design changes (debounced when a derive is slow)
 * needs:      npm: @space-game/common; statDelta (the numbers), build/detailMode and simpleStats (Simple shows five stats), ui/escape; DOM
 * invariants: a stats panel opts in by putting <span data-sd="KEY"> beside a stat; chips fill and clear without rebuilding the panel — client/src/ships/build/buildViews.test.ts
 *             the card is hidden whenever there is no change under the cursor — client/src/ships/build/buildViews.test.ts
 * extend:     a stat gets a chip by emitting a data-sd span with its STATS key in the panel's html
 */

import type { Blueprint } from '@space-game/common';
import { esc } from '../../ui/escape';
import { isSimple } from './detailMode';
import { SIMPLE_STAT_KEYS } from './simpleStats';
import { DeltaCache, changeKey, type Change, type DeltaLine, type StatCtx, type StatDelta, type Tone } from './statDelta';

const COLOR: Record<Tone, string> = { good: '#4ade80', bad: '#f87171', flat: '#9fb0cc' };
/** Worse by a little reads amber, not alarm red: the card and chips use red only for going over budget or losing a function */
const AMBER = '#fbbf24';

const lineColor = (l: DeltaLine) => (l.tone === 'bad' && l.key !== 'points' && l.text !== "can't turn" ? AMBER : COLOR[l.tone]);

/** The +/- chips in a stats panel: fills every `[data-sd]` from the delta (null clears them) */
export function applyChips(root: ParentNode, d: StatDelta | null): void {
  const by = new Map(d?.lines.map((l) => [l.key, l]));
  root.querySelectorAll<HTMLElement>('[data-sd]').forEach((el) => {
    const key = el.dataset.sd ?? '';
    const l = by.get(key);
    // (Power: "N generators short" rides on the net, or stands alone when the net didn't move)
    const short = key === 'power' ? d?.powerNote : null;
    if (!l && !short) { if (el.textContent) el.textContent = ''; return; }
    const text = ` ${[l?.text, short].filter(Boolean).join(' · ')}`;
    if (el.textContent !== text) el.textContent = text;
    el.style.cssText = `color:${short ? '#f87171' : lineColor(l!)}; font-size:11px; margin-left:6px; font-weight:600`;
  });
}

/** The card's inner html */
export function cardHtml(d: StatDelta): string {
  const verb = d.kind === 'add' ? 'Place' : 'Remove';
  let h = `<div style="font-weight:700; color:#e5ecf7; margin-bottom:3px">${verb} ${esc(d.label)}</div>`;
  if (d.loose) h += `<div style="color:${AMBER}; margin-bottom:3px">not connected: no effect until joined</div>`;
  if (d.cutOff > 0) h += `<div style="color:${AMBER}; margin-bottom:3px">cuts off ${d.cutOff} part${d.cutOff === 1 ? '' : 's'} from the core</div>`;
  if (d.note) h += `<div style="color:${AMBER}; margin-bottom:3px">${esc(d.note)}</div>`;
  const lines = isSimple() ? d.lines.filter((l) => SIMPLE_STAT_KEYS.has(l.key)) : d.lines;
  for (const l of lines) {
    h += `<div style="display:flex; justify-content:space-between; gap:14px"><span style="color:#8ea0bd">${esc(l.label)}</span><b style="color:${lineColor(l)}">${esc(l.text)}</b></div>`;
  }
  if (d.powerNote) h += `<div style="color:#f87171; margin-top:3px; font-weight:600">${esc(d.powerNote)}</div>`;
  if (!lines.length && !d.loose && !d.note) h += '<div style="color:#8ea0bd">no change to the stats</div>';
  return h;
}

const CARD_CSS = `position:fixed; z-index:2600; pointer-events:none; display:none; min-width:150px; max-width:260px; padding:6px 9px; border:1px solid #2d4470;
  border-radius:5px; background:rgba(8,13,26,0.94); color:#cfd8e6; font:11px/1.45 'Segoe UI',system-ui,sans-serif; box-shadow:0 4px 14px rgba(0,0,0,0.5)`;

/** The floating card: follows the cursor, kept on screen */
export class DeltaCard {
  readonly el = document.createElement('div');
  private html = '';
  constructor() { this.el.style.cssText = CARD_CSS; this.el.setAttribute('data-stat-delta', ''); document.body.appendChild(this.el); }
  show(d: StatDelta, x: number, y: number): void {
    const h = cardHtml(d);
    if (h !== this.html) { this.html = h; this.el.innerHTML = h; }
    this.el.style.display = 'block';
    const w = this.el.offsetWidth, ht = this.el.offsetHeight;
    const left = x + 18 + w > window.innerWidth ? x - 18 - w : x + 18;
    const top = y + 18 + ht > window.innerHeight ? y - 18 - ht : y + 18;
    this.el.style.left = `${Math.max(4, left)}px`;
    this.el.style.top = `${Math.max(4, top)}px`;
  }
  hide(): void { if (this.el.style.display !== 'none') this.el.style.display = 'none'; }
  dispose(): void { this.el.remove(); }
}

/** A derive slower than this (ms) makes the next ones wait for the cursor to settle */
const SLOW_MS = 20;
const SETTLE_MS = 80;

export interface HoverIn {
  /** Names the design as it stands (any string that changes when the design does) */
  rev: string;
  /** The design as it stands (read only when the change has to be derived) */
  bp: () => Blueprint;
  change: Change | null;
  budget?: number;
  /** Cursor on screen (client px) */
  x: number;
  y: number;
}

/** Keeps the card and the panel's chips on what the cursor means. Call `update` freely: it derives only when the cell, hand or design changed */
export class DeltaHover {
  private cache: DeltaCache;
  private card: DeltaCard | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastKey = '';
  /** What is showing now */
  current: StatDelta | null = null;

  constructor(ctx: () => StatCtx, private onChange: (d: StatDelta | null) => void = () => {}) {
    this.cache = new DeltaCache(ctx);
  }

  update(i: HoverIn): void {
    if (!i.change) return this.clear();
    const key = `${i.rev}#${changeKey(i.change)}`;
    const hit = this.cache.peek(i.rev, i.change);
    if (hit) return this.set(hit, key, i.x, i.y);
    if (key === this.lastKey && this.timer) return;
    // (Slow derives wait for the cursor to settle; the card stays where it was meanwhile)
    if (this.cache.lastMs > SLOW_MS) {
      if (this.timer) clearTimeout(this.timer);
      this.lastKey = key;
      this.card?.hide();
      this.timer = setTimeout(() => { this.timer = null; this.set(this.cache.get(i.rev, i.bp(), i.change!, i.budget), key, i.x, i.y); }, SETTLE_MS);
      return;
    }
    this.set(this.cache.get(i.rev, i.bp(), i.change, i.budget), key, i.x, i.y);
  }

  private set(d: StatDelta, key: string, x: number, y: number): void {
    if (this.timer && key !== this.lastKey) { clearTimeout(this.timer); this.timer = null; }
    this.card ??= new DeltaCard();
    this.card.show(d, x, y);
    this.lastKey = key;
    if (this.current !== d) { this.current = d; this.onChange(d); }
  }

  clear(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.lastKey = '';
    this.card?.hide();
    if (this.current) { this.current = null; this.onChange(null); }
  }

  dispose(): void { this.clear(); this.card?.dispose(); this.card = null; }
}
