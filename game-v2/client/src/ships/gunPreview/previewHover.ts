/**
 * Hover a gun in a parts list (the hangar's palette, the field build overlay's) and a small panel beside the list shows
 * it firing at a wall of ship blocks (GunPreview) with its real beat and round. One panel and one preview per list, made on
 * the first hover; the preview stops when the pointer leaves (after a short grace so moving between rows doesn't
 * flicker) and when the list is hidden or disposed. It opens no connection: everything is read from the catalogue.
 */

import { averageInterval, partStats, type Catalog, type Economy, type ShipTuning } from '@space-game/common';
import { esc } from '../../ui/componentKit';
import { fireChip } from '../modelCards';
import { gunPlan, type GunPlan } from './gunPlan';
import { gunArt } from './gunArt';
import type { GunPreview } from './GunPreview';

const PANEL_W = 316;
const SHOW_DELAY = 140;
const HIDE_DELAY = 120;

const STYLE = `
.gp-panel { position: fixed; z-index: 2090; width: ${PANEL_W}px; box-sizing: border-box; padding: 8px 8px 7px; border-radius: 9px; pointer-events: none;
  background: rgba(8, 13, 24, 0.97); border: 1px solid #2b3d60; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55); font: 12px 'Segoe UI', system-ui, sans-serif; color: #cfd8e6; }
.gp-panel[hidden] { display: none; }
.gp-title { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 5px; }
.gp-title b { color: #e5ecf7; font-weight: 600; }
.gp-title span { color: #7dd3fc; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
.gp-view { height: 150px; border-radius: 6px; overflow: hidden; background: radial-gradient(ellipse at 30% 50%, #0f1a30, #070b14); border: 1px solid #1a2744; }
.gp-view canvas { display: block; }
.gp-cap { margin-top: 5px; font-size: 11px; color: #8ea0bd; display: flex; flex-wrap: wrap; gap: 3px 10px; }
.gp-cap b { color: #e5ecf7; font-weight: 600; }`;

let styled = false;

export interface PreviewDeps {
  catalog: Catalog;
  tuning: ShipTuning;
  econ: Economy;
}

/** The facts under the view: beat, round, reach, in the gun's own terms */
export function previewCaption(catalog: Catalog, tuning: ShipTuning, plan: GunPlan): { label: string; value: string }[] {
  const fn = catalog.functions.get(plan.fnId)!;
  const out: { label: string; value: string }[] = [];
  const chip = fireChip(fn);
  if (chip) out.push({ label: 'Fires', value: chip });
  if (!plan.beam || plan.pulse) {
    const every = averageInterval(plan.fire, plan.fire.interval);
    const rate = 60 / Math.max(1, every);
    out.push({ label: 'Rate', value: `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}/s` });
  }
  if (plan.support === 'repair') out.push({ label: 'Mends', value: 'a friendly plate' });
  else if (plan.support === 'pd') out.push({ label: 'Shoots', value: 'missiles and seekers' });
  else if (!plan.beam) out.push({ label: 'Round', value: `${Math.round(plan.maxSpeed || plan.speed)} u/tick${plan.tracked ? ', seeks' : ''}${plan.splash ? `, blast ${Math.round(plan.splash)}` : ''}` });
  const st = partStats(catalog, tuning, { fn: fn.id, piece: fn.pieces === '*' ? 'sq' : fn.pieces[0], material: fn.material ?? 'alloy' });
  if (st?.range) out.push({ label: 'Reach', value: Math.round(st.range).toLocaleString('en-US') });
  return out;
}

export class GunPreviewHover {
  private panel: HTMLDivElement | null = null;
  private view: HTMLDivElement | null = null;
  private title: HTMLElement | null = null;
  private cap: HTMLElement | null = null;
  private preview: GunPreview | null = null;
  private loading: Promise<GunPreview | null> | null = null;
  private showTimer = 0;
  private hideTimer = 0;
  private current = '';
  private disposed = false;
  private watch = 0;

  /** `list`: the parts list's root (the panel sits beside it) */
  constructor(private list: HTMLElement, private d: PreviewDeps) {}

  /** The pointer is over the part `itemId` (a row, the part in hand); `anchor`: its row, for the panel's height */
  over(itemId: string, anchor: HTMLElement): void {
    window.clearTimeout(this.hideTimer);
    if (itemId === this.current) return;
    window.clearTimeout(this.showTimer);
    const plan = this.planOf(itemId);
    this.current = itemId;
    if (!plan) { this.hideNow(); return; }
    this.showTimer = window.setTimeout(() => void this.open(plan, anchor), this.panel && !this.panel.hidden ? 0 : SHOW_DELAY);
  }

  /** The pointer left the list (or a row for something that is not a gun) */
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
    this.panel?.remove();
    this.panel = null;
  }

  /**
   * The mouse as the part tooltip should see it: for a gun, moved right of the preview panel so the tooltip's long text
   * stands beside the live view and never over it (a list on the right edge puts the panel on its left: no change)
   */
  clearOfPanel(itemId: string, e: MouseEvent): MouseEvent {
    if (!this.planOf(itemId)) return e;
    const l = this.list.getBoundingClientRect();
    if (l.right + 10 + PANEL_W > window.innerWidth - 8) return e;
    // (the tooltip sits 18px right of the mouse)
    const x = l.right + 10 + PANEL_W + 8 - 18;
    return x > e.clientX ? new MouseEvent('mousemove', { clientX: x, clientY: e.clientY }) : e;
  }

  private planOf(itemId: string): GunPlan | null {
    const part = this.d.econ.items.get(itemId)?.part;
    const fn = part ? this.d.catalog.functions.get(part.fn) : undefined;
    return fn?.weapon ? gunPlan(this.d.catalog, this.d.tuning, fn) : null;
  }

  private make(): void {
    if (this.panel) return;
    if (!styled) {
      styled = true;
      const s = document.createElement('style');
      s.textContent = STYLE;
      document.head.appendChild(s);
    }
    const p = document.createElement('div');
    p.className = 'gp-panel';
    p.hidden = true;
    p.setAttribute('aria-hidden', 'true');
    p.innerHTML = `<div class="gp-title"><b></b><span>Live preview</span></div><div class="gp-view"></div><div class="gp-cap"></div>`;
    document.body.appendChild(p);
    this.panel = p;
    this.view = p.querySelector('.gp-view');
    this.title = p.querySelector('.gp-title b');
    this.cap = p.querySelector('.gp-cap');
  }

  private async open(plan: GunPlan, anchor: HTMLElement): Promise<void> {
    if (this.disposed) return;
    this.make();
    const fn = this.d.catalog.functions.get(plan.fnId)!;
    this.title!.textContent = fn.name ?? fn.id;
    this.cap!.innerHTML = previewCaption(this.d.catalog, this.d.tuning, plan).map((c) => `<span>${esc(c.label)} <b>${esc(c.value)}</b></span>`).join('');
    this.place(anchor);
    this.panel!.hidden = false;
    // (the list closing under a still pointer fires no leave: check it is still on screen)
    window.clearInterval(this.watch);
    this.watch = window.setInterval(() => { if (!this.list.isConnected || this.list.offsetParent === null) this.hideNow(); }, 400);
    const pv = await this.get();
    if (!pv || this.disposed || this.panel!.hidden || this.current === '') return;
    pv.show(plan, gunArt(this.d.catalog, fn, this.d.tuning.cellSize), this.d.catalog);
  }

  private get(): Promise<GunPreview | null> {
    if (this.preview) return Promise.resolve(this.preview);
    this.loading ??= import('./GunPreview').then((m) => (this.preview = new m.GunPreview(this.view!))).catch(() => null);
    return this.loading;
  }

  /** Beside the list (right of it, else left), level with the row, kept on screen */
  private place(anchor: HTMLElement): void {
    const p = this.panel!, l = this.list.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    const h = 230;
    const right = l.right + 10;
    const x = right + PANEL_W <= window.innerWidth - 8 ? right : Math.max(8, l.left - PANEL_W - 10);
    const y = Math.max(8, Math.min(window.innerHeight - h - 8, a.top + a.height / 2 - h / 2));
    p.style.left = `${Math.round(x)}px`;
    p.style.top = `${Math.round(y)}px`;
  }

  private hideNow(): void {
    window.clearInterval(this.watch);
    this.current = '';
    if (this.panel) this.panel.hidden = true;
    this.preview?.hide();
  }
}
