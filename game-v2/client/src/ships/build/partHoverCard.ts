/**
 * @contract client.ships.build-part-hover-card
 * owns:       the one card beside a parts list (hangar palette, world build view) for the part under the pointer or focus: live preview or art,
 *             name, size and mount, one sentence, three numbers, cost and lock, and a "More…" section holding the long tooltip rows
 * needs:      build/partCard (numbers, sentence, placement), build/detailMode, gunPreview (GunPlan, GunPreview, gunArt), partTip, modelCards, ui/componentKit;
 *             DOM; the palette's styles for .hp-mat chips
 * invariants: one card and one preview per list, made on the first hover; the preview stops when the card hides — none pinned
 *             "More…" starts open in Advanced and closed in Simple; Shift or a click flips it — none pinned
 * extend:     a new part kind's numbers are in build/partCard.ts; a new card section is one function here, appended in render()
 */

import { isStructural, parsePartItemId, type Catalog, type Economy, type ShipTuning } from '@space-game/common';
import { costLines } from '../../ui/componentAvail';
import { costChipsHtml, esc } from '../../ui/componentKit';
import { itemIcon } from '../../ui/itemIcons';
import { gunPlan, type GunPlan } from '../gunPreview/gunPlan';
import { gunArt } from '../gunPreview/gunArt';
import type { GunPreview } from '../gunPreview/GunPreview';
import { modelLock, mountBadge, sizeWord } from '../modelCards';
import { partTipHtml } from '../partTip';
import { detailMode, onDetailMode } from './detailMode';
import { cardNumbers, partSummary, placeCard } from './partCard';

const CARD_W = 316;
const SHOW_DELAY = 140;
const HIDE_DELAY = 220;

const STYLE = `
.pc-card { position: fixed; z-index: 2090; width: ${CARD_W}px; max-height: calc(100vh - 16px); overflow-y: auto; box-sizing: border-box; padding: 8px; border-radius: 9px;
  background: rgba(8, 13, 24, 0.97); border: 1px solid #2b3d60; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55); font: 12px 'Segoe UI', system-ui, sans-serif; color: #cfd8e6; }
.pc-card[hidden] { display: none; }
.pc-view { position: relative; height: 150px; border-radius: 6px; overflow: hidden; background: radial-gradient(ellipse at 30% 50%, #0f1a30, #070b14); border: 1px solid #1a2744; margin-bottom: 6px; }
.pc-view canvas { display: block; }
.pc-art { display: flex; align-items: center; justify-content: center; height: 72px; border-radius: 6px; background: radial-gradient(ellipse at 30% 50%, #0f1a30, #070b14); border: 1px solid #1a2744; margin-bottom: 6px; }
.pc-art[hidden] { display: none; }
.pc-art img { width: 56px; height: 56px; }
.pc-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.pc-head b { color: #e5ecf7; font-size: 14px; font-weight: 600; }
.pc-head .sz { color: #8ea0bd; font-size: 11px; }
.pc-head .mt { margin-left: auto; display: inline-flex; gap: 3px; align-self: center; }
.pc-say { margin: 3px 0 6px; color: #cbd5e1; font-size: 12px; line-height: 1.35; }
.pc-nums { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; margin-bottom: 6px; }
.pc-nums div { background: #0f1626; border: 1px solid #1a2744; border-radius: 5px; padding: 3px 5px; min-width: 0; }
.pc-nums b { display: block; color: #e5ecf7; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-nums span { color: #8ea0bd; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
.pc-cost { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 11px; color: #8ea0bd; }
.pc-lock { color: #f87171; font-size: 11px; margin-top: 3px; }
.pc-ok { color: #4ade80; }
.pc-more { all: unset; box-sizing: border-box; cursor: pointer; display: block; margin-top: 6px; padding: 2px 0; color: #7dd3fc; font-size: 11px; }
.pc-more:hover { text-decoration: underline; }
.pc-extra { margin-top: 4px; padding-top: 4px; border-top: 1px solid #1a2744; }
.pc-extra[hidden] { display: none; }`;

let styled = false;

/** What the card reads from the list's owner */
export interface PartCardDeps {
  catalog: Catalog;
  tuning: ShipTuning;
  econ: Economy;
  have(id: string): number;
  /** More of this part that could be placed from what you hold (Infinity: everything granted) */
  remaining(id: string): number;
  canMake(id: string): boolean;
  level(): number;
  /** Every part places at no cost */
  free(): boolean;
}

export class PartHoverCard {
  private card: HTMLDivElement | null = null;
  private view: HTMLDivElement | null = null;
  private art: HTMLDivElement | null = null;
  private body: HTMLDivElement | null = null;
  private preview: GunPreview | null = null;
  private loading: Promise<GunPreview | null> | null = null;
  private showTimer = 0;
  private hideTimer = 0;
  private current = '';
  private anchor: HTMLElement | null = null;
  private disposed = false;
  private watch = 0;
  /** The pilot's own choice for "More…" (null: the mode decides) */
  private more: boolean | null = null;
  private off: (() => void) | null = null;

  /** `list`: the parts list's root (the card sits beside it) */
  constructor(private list: HTMLElement, private d: PartCardDeps) {}

  /** The pointer is over (or focus is on) the part `itemId`; `anchor`: its row, for the card's height */
  over(itemId: string, anchor: HTMLElement): void {
    window.clearTimeout(this.hideTimer);
    if (itemId === this.current) return;
    window.clearTimeout(this.showTimer);
    this.current = itemId;
    this.anchor = anchor;
    if (!this.d.econ.items.get(itemId)?.part && !parsePartItemId(itemId)) { this.hideNow(); return; }
    this.showTimer = window.setTimeout(() => void this.open(itemId), this.card && !this.card.hidden ? 0 : SHOW_DELAY);
  }

  /** The pointer left the list (or focus did) */
  out(): void {
    window.clearTimeout(this.showTimer);
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hideNow(), HIDE_DELAY);
  }

  dispose(): void {
    this.disposed = true;
    this.hideNow();
    window.clearTimeout(this.showTimer);
    window.clearTimeout(this.hideTimer);
    this.preview?.destroy();
    this.preview = null;
    this.card?.remove();
    this.card = null;
  }

  private moreOpen(): boolean {
    return this.more ?? detailMode() === 'advanced';
  }

  private make(): void {
    if (this.card) return;
    if (!styled) {
      styled = true;
      const s = document.createElement('style');
      s.textContent = STYLE;
      document.head.appendChild(s);
    }
    const c = document.createElement('div');
    c.className = 'pc-card';
    c.hidden = true;
    c.setAttribute('role', 'tooltip');
    c.id = 'pc-card';
    c.innerHTML = `<div class="pc-view"></div><div class="pc-art"></div><div class="pc-body"></div>`;
    // (the card stays while the pointer is on it, so "More…" can be clicked)
    c.addEventListener('mouseenter', () => window.clearTimeout(this.hideTimer));
    c.addEventListener('mouseleave', () => this.out());
    c.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.pc-more')) return;
      this.more = !this.moreOpen();
      this.render();
    });
    document.body.appendChild(c);
    this.card = c;
    this.view = c.querySelector('.pc-view');
    this.art = c.querySelector('.pc-art');
    this.body = c.querySelector('.pc-body');
  }

  private plan(id: string): GunPlan | null {
    const part = this.d.econ.items.get(id)?.part ?? parsePartItemId(id);
    const fn = part ? this.d.catalog.functions.get(part.fn) : undefined;
    return fn?.weapon ? gunPlan(this.d.catalog, this.d.tuning, fn) : null;
  }

  /** The card's text parts for the current item (also the tests' view of a card) */
  private bodyHtml(id: string): string {
    const { catalog, tuning, econ } = this.d;
    const part = econ.items.get(id)?.part ?? parsePartItemId(id);
    const fn = part && catalog.functions.get(part.fn);
    if (!part || !fn) return '';
    const name = econ.items.name(id);
    const size = sizeWord(catalog, part.piece);
    const nums = cardNumbers(catalog, tuning, fn, part.piece, part.material);
    const structure = isStructural(part.fn) || part.fn === 'core';
    const spareLeft = this.d.remaining(id), spare = spareLeft === Infinity ? 0 : Math.max(0, spareLeft);
    const can = this.d.canMake(id);
    const free = this.d.free();
    const lock = !free && !can ? (fn.model ? modelLock(fn, false, this.d.level()).why : "You can't make this yet") : '';
    const rec = econ.recipes.recipeFor(id);
    const bag = structure || !rec ? econ.recipes.partInputs(part) : rec.inputs;
    const cost = costLines(bag, (k) => this.d.have(k));
    let html = `<div class="pc-head"><b>${esc(name)}</b>${size ? `<span class="sz">${esc(size)}</span>` : ''}<span class="mt">${mountBadge(catalog, { fn: fn.id })}</span></div>`
      + `<div class="pc-say">${esc(partSummary(fn))}</div>`
      + (nums.length ? `<div class="pc-nums">${nums.map((n) => `<div><b>${esc(n.value)}</b><span>${esc(n.label)}</span></div>`).join('')}</div>` : '');
    const costHtml = free ? '<span>Free here</span>'
      : spare > 0 ? `<span class="pc-ok">${spare} on hand</span>`
      : cost.length ? `<span>${structure ? 'A cell' : 'Makes from'}</span>${costChipsHtml(econ, cost, 'hp-mat', true)}${!structure && rec ? `<span>${rec.time > 0 ? `${rec.time}s` : 'instant'}</span>` : ''}`
      : '';
    if (costHtml) html += `<div class="pc-cost">${costHtml}</div>`;
    if (lock) html += `<div class="pc-lock">${esc(lock)}</div>`;
    const open = this.moreOpen();
    html += `<button class="pc-more" type="button" aria-expanded="${open}" title="Click, or hold Shift">${open ? 'Fewer details' : 'More…'}</button>`
      + `<div class="pc-extra"${open ? '' : ' hidden'}>${open ? partTipHtml(part, { catalog, tuning, econ, free, have: (k) => this.d.have(k), canMake: (k) => this.d.canMake(k), state: 'palette', spare, lock }) : ''}</div>`;
    return html;
  }

  private render(): void {
    if (!this.card || !this.current) return;
    this.body!.innerHTML = this.bodyHtml(this.current);
    const plan = this.plan(this.current);
    this.view!.hidden = !plan;
    this.art!.hidden = !!plan;
    if (!plan) this.art!.innerHTML = `<img src="${itemIcon(this.d.econ, this.current)}" alt="">`;
    if (this.anchor) this.place(this.anchor);
  }

  private async open(id: string): Promise<void> {
    if (this.disposed || id !== this.current) return;
    this.make();
    const first = this.card!.hidden;
    if (first) this.more = null;
    this.render();
    this.card!.hidden = false;
    if (this.anchor) this.place(this.anchor);
    this.anchor?.setAttribute('aria-describedby', 'pc-card');
    if (first) {
      // (the list closing under a still pointer fires no leave: check it is still on screen)
      window.clearInterval(this.watch);
      this.watch = window.setInterval(() => { if (!this.list.isConnected || this.list.offsetParent === null) this.hideNow(); }, 400);
      document.addEventListener('keydown', this.onKey);
      this.off = onDetailMode(() => { this.more = null; this.render(); });
    }
    const plan = this.plan(id);
    if (!plan) { this.preview?.hide(); return; }
    const pv = await this.get();
    if (!pv || this.disposed || this.card!.hidden || this.current !== id) return;
    const fn = this.d.catalog.functions.get(plan.fnId)!;
    pv.show(plan, gunArt(this.d.catalog, fn, this.d.tuning.cellSize), this.d.catalog);
  }

  /** Shift flips "More…" while the card shows */
  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Shift' || e.repeat || !this.current) return;
    this.more = !this.moreOpen();
    this.render();
  };

  private get(): Promise<GunPreview | null> {
    if (this.preview) return Promise.resolve(this.preview);
    this.loading ??= import('../gunPreview/GunPreview').then((m) => (this.preview = new m.GunPreview(this.view!))).catch(() => null);
    return this.loading;
  }

  private place(anchor: HTMLElement): void {
    const c = this.card!;
    const l = this.list.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    const p = placeCard(l, a, CARD_W, c.offsetHeight || 300, window.innerWidth, window.innerHeight);
    c.style.left = `${Math.round(p.x)}px`;
    c.style.top = `${Math.round(p.y)}px`;
  }

  private hideNow(): void {
    window.clearInterval(this.watch);
    document.removeEventListener('keydown', this.onKey);
    this.off?.();
    this.off = null;
    this.anchor?.removeAttribute('aria-describedby');
    this.current = '';
    if (this.card) this.card.hidden = true;
    this.preview?.hide();
  }
}
