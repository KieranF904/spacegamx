/**
 * Shared pieces for the game's windows (inventory, station services):
 * a styled window shell, an item grid with icons, counts, rarity borders and
 * drag-and-drop, and rich item tooltips.
 */

import { resistText } from '../ships/partTip';
import { Economy, Stack, Bag, RARITY_COLOR, CATEGORY_LABEL, ItemDef, RARITIES, describePart, partBuildPoints, DAMAGE_NAMES } from '@space-game/common';
import { tipRows } from '../ships/describe';
import { itemIcon } from './itemIcons';

let styled = false;
export function injectWindowStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.sgw-veil { position: fixed; inset: 0; z-index: 2500; display: none; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 50% 40%, rgba(10, 20, 40, 0.55), rgba(2, 5, 12, 0.72)); }
.sgw { width: min(1080px, calc(100vw - 32px)); max-height: calc(100vh - 48px); display: flex; flex-direction: column;
  background: linear-gradient(180deg, rgba(14, 22, 40, 0.97), rgba(7, 12, 24, 0.97)); border: 1px solid rgba(120, 150, 200, 0.25);
  border-radius: 14px; box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255,255,255,0.04);
  color: #d6deeb; font: 13px 'Segoe UI', system-ui, sans-serif; overflow: hidden; }
/* Tabbed windows hang from a fixed line (where a full-height one would sit), so switching tabs never moves the header */
.sgw-veil.tabbed { align-items: flex-start; padding-top: max(24px, calc(50vh - 360px)); box-sizing: border-box; }
.sgw-veil.tabbed > .sgw { max-height: min(720px, calc(100vh - 48px)); }
/* Dark, thin scrollbars inside windows (not the bright default) */
.sgw { color-scheme: dark; }
.sgw, .sgw * { scrollbar-width: thin; scrollbar-color: rgba(125, 160, 210, 0.3) transparent; }
/* Opening: the veil fades in and the window rises into place (replays each time it's shown) */
.sgw-veil { animation: sgwFade 0.16s ease-out; }
.sgw-veil > .sgw { animation: sgwRise 0.2s cubic-bezier(0.2, 0.8, 0.3, 1); }
@keyframes sgwFade { from { opacity: 0; } }
@keyframes sgwRise { from { opacity: 0; transform: translateY(10px) scale(0.985); } }
@media (prefers-reduced-motion: reduce) { .sgw-veil, .sgw-veil > .sgw { animation: none; } }
.sgw-head { display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-bottom: 1px solid rgba(140, 170, 220, 0.14);
  background: linear-gradient(90deg, rgba(125, 211, 252, 0.06), transparent); }
.sgw-title { font: 700 12px 'Segoe UI', sans-serif; letter-spacing: 4px; color: #7dd3fc; text-transform: uppercase; }
.sgw-sub { color: #8394ad; font-size: 12px; }
.sgw-head .sp { flex: 1; }
.sgw-x { all: unset; cursor: pointer; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: #8fa0b8; font-size: 18px; }
.sgw-x:hover { background: rgba(255,255,255,0.06); color: #fff; }
.sgw-body { padding: 16px 18px 18px; overflow: auto; flex: 1; min-height: 0; }
.sgw-tabs { display: flex; gap: 4px; padding: 0 18px; border-bottom: 1px solid rgba(140, 170, 220, 0.12); }
.sgw-tab { all: unset; cursor: pointer; padding: 10px 14px; color: #8fa0b8; border-bottom: 2px solid transparent; margin-bottom: -1px; letter-spacing: 0.5px; }
.sgw-tab:hover { color: #fff; }
.sgw-tab.on { color: #fff; border-bottom-color: #7dd3fc; }
.sgw-tab.hint { color: #fde68a; animation: sgwhint 1.4s ease-in-out infinite; }
@keyframes sgwhint { 0%, 100% { text-shadow: none; } 50% { text-shadow: 0 0 10px rgba(251, 191, 36, 0.9); } }
.sgw-btn.hint { animation: sgwbtnhint 1.4s ease-in-out infinite; }
@keyframes sgwbtnhint { 0%, 100% { box-shadow: none; } 50% { box-shadow: 0 0 0 3px rgba(251, 191, 36, 0.55); } }
.sgw-tab .badge { margin-left: 6px; background: #1d5e7a; color: #e8f6ff; border-radius: 8px; padding: 0 6px; font-size: 11px; }
.sgw-btn { all: unset; cursor: pointer; padding: 7px 14px; border-radius: 8px; border: 1px solid rgba(140, 170, 220, 0.3); color: #d6deeb; font-size: 12px; text-align: center; }
.sgw-btn:hover { background: rgba(125, 211, 252, 0.1); border-color: rgba(125, 211, 252, 0.5); }
.sgw-btn.primary { background: #1d5e7a; border-color: #2c87ad; color: #fff; }
.sgw-btn.primary:hover { background: #24739a; }
.sgw-btn.good { background: #1f5f3f; border-color: #2e8a5a; color: #fff; }
.sgw-btn:disabled, .sgw-btn.off { opacity: 0.4; pointer-events: none; }
.sgw-chip { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(140, 170, 220, 0.22); color: #9fb3cc; font-size: 12px; }
.sgw-chip.on { background: rgba(125, 211, 252, 0.16); border-color: rgba(125, 211, 252, 0.5); color: #fff; }
/* Category tiles, two to a row */
.sgw-cats { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; flex-shrink: 0; padding-bottom: 8px; margin-bottom: 4px; border-bottom: 1px solid rgba(140, 170, 220, 0.1); }
.sgw-cats > button { all: unset; cursor: pointer; display: flex; align-items: center; gap: 5px; padding: 4px 4px; border-radius: 7px; color: #a9b8cc; font-size: 12px; border: 1px solid transparent; min-width: 0; }
.sgw-cats > button:hover { background: rgba(125, 211, 252, 0.07); color: #fff; }
.sgw-cats > button.on { background: rgba(125, 211, 252, 0.15); border-color: rgba(125, 211, 252, 0.45); color: #fff; }
.sgw-cats > button img { width: 18px; height: 18px; flex-shrink: 0; }
.sgw-cats > button span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* A list to pick from */
.sgw-nav { display: flex; flex-direction: column; gap: 1px; overflow-y: auto; flex: 1; min-height: 0; }
.sgw-nav > button { all: unset; cursor: pointer; display: flex; align-items: center; gap: 7px; padding: 3px 8px; border-radius: 7px; color: #a9b8cc; font-size: 12px; flex-shrink: 0; }
.sgw-nav > button:hover { background: rgba(125, 211, 252, 0.07); color: #fff; }
.sgw-nav > button > span:nth-child(2) { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sgw-nav > button img { width: 18px; height: 18px; flex-shrink: 0; }
.sgw-nav > button .n { margin-left: auto; color: #56657c; font-size: 11px; white-space: nowrap; }
.sgw-nav > button.on { background: rgba(125, 211, 252, 0.15); color: #fff; box-shadow: inset 2px 0 0 #7dd3fc; }
.sgw-nav > button.locked { opacity: 0.5; }
.sgw-nav .hd { color: #7dd3fc; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; text-transform: uppercase; padding: 4px 8px 4px; flex-shrink: 0; display: flex; }
.sgw-nav .hd span { margin-left: auto; color: #56657c; font-weight: 400; letter-spacing: 0; text-transform: none; font-size: 11px; }
.sgw-nav .grp { color: #56657c; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; padding: 6px 8px 1px; flex-shrink: 0; }
/* A choice tile (a grade, a size) */
.sgw-pick { all: unset; cursor: pointer; box-sizing: border-box; min-width: 0; border: 1px solid rgba(140, 170, 220, 0.16); border-radius: 8px; padding: 5px 8px; background: rgba(4, 8, 16, 0.35); font-size: 12px; color: #d6deeb; }
.sgw-pick:hover { border-color: rgba(125, 211, 252, 0.45); }
.sgw-pick.on { border-color: #7dd3fc; background: rgba(125, 211, 252, 0.13); }
.sgw-pick.locked { opacity: 0.5; }
.sgw-pick.locked.on { opacity: 0.8; }
.sgw-label { color: #7dd3fc; font: 700 10px 'Segoe UI', sans-serif; letter-spacing: 2px; text-transform: uppercase; margin: 14px 0 6px; }
.sgw-label span { color: #56657c; font-weight: 400; letter-spacing: 0; text-transform: none; font-size: 11px; margin-left: 6px; }
.sgw-input { background: rgba(4, 8, 16, 0.6); border: 1px solid rgba(140, 170, 220, 0.25); border-radius: 8px; color: #e5ecf7; padding: 6px 10px; font: inherit; outline: none; }
.sgw-input:focus { border-color: rgba(125, 211, 252, 0.6); }
.sgw-col { background: rgba(4, 8, 16, 0.35); border: 1px solid rgba(140, 170, 220, 0.12); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; min-height: 0; }
.sgw-col h4 { margin: 0 0 8px; font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 2.5px; color: #7dd3fc; text-transform: uppercase; display: flex; align-items: center; gap: 8px; }
.sgw-col h4 .r { margin-left: auto; color: #8394ad; letter-spacing: 0; font-weight: 400; text-transform: none; font-size: 12px; }
.sgw-bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.07); overflow: hidden; margin: 2px 0 10px; }
.sgw-bar > i { display: block; height: 100%; background: linear-gradient(90deg, #2c87ad, #7dd3fc); border-radius: 3px; transition: width 0.25s; }
.sgw-bar.full > i { background: linear-gradient(90deg, #b45309, #fbbf24); }
.sgw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(62px, 1fr)); gap: 6px; align-content: start; overflow-y: auto; min-height: 140px; padding: 2px; }
.sgw-grid.drop { outline: 2px dashed rgba(125, 211, 252, 0.5); outline-offset: 2px; border-radius: 8px; }
.sgw-cell { position: relative; aspect-ratio: 1; border-radius: 9px; background: radial-gradient(circle at 50% 35%, rgba(255,255,255,0.06), rgba(0,0,0,0.25));
  border: 1px solid var(--rc, rgba(140,170,220,0.2)); cursor: pointer; display: grid; place-items: center; transition: transform 0.08s, background 0.12s; }
.sgw-cell:hover { transform: translateY(-1px); background: radial-gradient(circle at 50% 35%, rgba(255,255,255,0.12), rgba(0,0,0,0.2)); }
.sgw-cell img { width: 78%; height: 78%; image-rendering: auto; pointer-events: none; }
.sgw-cell .n { position: absolute; right: 4px; bottom: 2px; font: 700 11px 'Segoe UI', sans-serif; color: #fff; text-shadow: 0 1px 2px #000, 0 0 4px #000; }
.sgw-cell .tag { position: absolute; left: 3px; top: 2px; font-size: 10px; color: #ffd166; }
.sgw-cell .tag.load { color: #5eead4; font-weight: 700; font-size: 9px; letter-spacing: 0.5px; }
.sgw-cell .tag.util { color: #c4b5fd; font-weight: 700; font-size: 9px; letter-spacing: 0.5px; }
.sgw-cell.dim { opacity: 0.35; }
.sgw-empty { color: #56657c; font-size: 12px; padding: 18px 4px; text-align: center; grid-column: 1 / -1; }
.sgw-tip { position: fixed; z-index: 4000; pointer-events: none; max-width: 300px; background: rgba(6, 10, 20, 0.97); border: 1px solid rgba(140, 170, 220, 0.3);
  border-radius: 10px; padding: 10px 12px; color: #c9d4e5; font: 12px 'Segoe UI', sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,0.5); display: none; }
.sgw-tip .t-n { font: 600 14px 'Segoe UI', sans-serif; }
.sgw-tip .t-c { color: #8394ad; font-size: 11px; margin: 1px 0 6px; letter-spacing: 0.5px; }
.sgw-tip .t-d { color: #a9b6c9; line-height: 1.45; }
.sgw-tip .t-r { display: flex; justify-content: space-between; margin-top: 6px; color: #8394ad; }
.sgw-tip .t-r b { color: #e5ecf7; font-weight: 600; }
.sgw-tip .t-h { margin-top: 7px; color: #7dd3fc; font-size: 11px; }
.sgw-menu { position: fixed; z-index: 4100; background: rgba(8, 13, 26, 0.98); border: 1px solid rgba(140, 170, 220, 0.3); border-radius: 10px; padding: 5px; min-width: 150px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.55); font: 13px 'Segoe UI', sans-serif; }
.sgw-menu button { all: unset; display: block; width: calc(100% - 20px); padding: 7px 10px; border-radius: 6px; color: #d6deeb; cursor: pointer; }
.sgw-menu button:hover { background: rgba(125, 211, 252, 0.12); color: #fff; }
.sgw-menu button.bad { color: #fca5a5; }
.sgw-cost { display: inline-flex; align-items: center; gap: 3px; margin-right: 8px; white-space: nowrap; }
.sgw-cost img { width: 18px; height: 18px; vertical-align: middle; }
.sgw-cost.short { color: #fca5a5; }
.sgw-credits { color: #ffd166; font-weight: 600; }
`;
  document.head.appendChild(css);
}

/** A modal window: veil, header (title, subtitle, extra controls, close), optional tabs, body */
export class GameWindow {
  readonly veil: HTMLDivElement;
  readonly root: HTMLDivElement;
  readonly head: HTMLDivElement;
  readonly sub: HTMLSpanElement;
  readonly headExtra: HTMLDivElement;
  readonly tabs: HTMLDivElement;
  readonly body: HTMLDivElement;
  isOpen = false;
  onClose: (() => void) | null = null;

  constructor(title: string) {
    injectWindowStyles();
    this.veil = document.createElement('div');
    this.veil.className = 'sgw-veil';
    this.root = document.createElement('div');
    this.root.className = 'sgw';
    this.head = document.createElement('div');
    this.head.className = 'sgw-head';
    const t = document.createElement('span');
    t.className = 'sgw-title';
    t.textContent = title;
    this.sub = document.createElement('span');
    this.sub.className = 'sgw-sub';
    const sp = document.createElement('span');
    sp.className = 'sp';
    this.headExtra = document.createElement('div');
    this.headExtra.style.cssText = 'display:flex; align-items:center; gap:12px;';
    const x = document.createElement('button');
    x.className = 'sgw-x';
    x.textContent = '×';
    x.title = 'Close (Esc)';
    x.onclick = () => this.close();
    this.head.append(t, this.sub, sp, this.headExtra, x);
    this.tabs = document.createElement('div');
    this.tabs.className = 'sgw-tabs';
    this.tabs.style.display = 'none';
    this.body = document.createElement('div');
    this.body.className = 'sgw-body';
    this.root.append(this.head, this.tabs, this.body);
    this.veil.appendChild(this.root);
    this.veil.addEventListener('mousedown', (e) => { if (e.target === this.veil) this.close(); });
    // Keys typed in a window never reach the game
    this.root.addEventListener('keydown', (e) => { if (e.code !== 'Escape') e.stopPropagation(); });
    document.body.appendChild(this.veil);
  }

  open(): void {
    this.isOpen = true;
    this.veil.classList.toggle('tabbed', this.tabs.style.display !== 'none');
    this.veil.style.display = 'flex';
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.veil.style.display = 'none';
    hideTip();
    closeMenu();
    this.onClose?.();
  }
}

// ---------------------------------------------------------------------------
// Tooltip and context menu
// ---------------------------------------------------------------------------

let tipEl: HTMLDivElement | null = null;
function tip(): HTMLDivElement {
  if (!tipEl) {
    injectWindowStyles();
    tipEl = document.createElement('div');
    tipEl.className = 'sgw-tip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

export function showTip(html: string, x: number, y: number): void {
  const t = tip();
  t.innerHTML = html;
  t.style.display = 'block';
  const r = t.getBoundingClientRect();
  t.style.left = `${Math.min(x + 16, innerWidth - r.width - 8)}px`;
  t.style.top = `${Math.min(y + 12, innerHeight - r.height - 8)}px`;
}

export function hideTip(): void {
  if (tipEl) tipEl.style.display = 'none';
}

let menuEl: HTMLDivElement | null = null;
export function openMenu(x: number, y: number, items: { label: string; run: () => void; bad?: boolean }[]): void {
  closeMenu();
  if (!items.length) return;
  const m = document.createElement('div');
  m.className = 'sgw-menu';
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.bad) b.className = 'bad';
    b.onclick = () => { closeMenu(); it.run(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  menuEl = m;
  setTimeout(() => window.addEventListener('mousedown', closeOnOutside, { once: true }), 0);
}

function closeOnOutside(e: MouseEvent): void {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
  else if (menuEl) window.addEventListener('mousedown', closeOnOutside, { once: true });
}

export function closeMenu(): void {
  menuEl?.remove();
  menuEl = null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Rich tooltip for an item */
export function itemTipHtml(econ: Economy, id: string, opts: { count?: number; hint?: string; extra?: string } = {}): string {
  const d = econ.items.get(id);
  if (!d) return esc(id);
  const rc = RARITY_COLOR[d.rarity];
  let html = `<div class="t-n" style="color:${rc}">${esc(d.name)}</div>`;
  html += `<div class="t-c">${d.rarity.toUpperCase()} · ${CATEGORY_LABEL[d.category]}</div>`;
  html += `<div class="t-d">${esc(d.description)}</div>`;
  if (d.category === 'part' && d.part) {
    html += partStatsHtml(econ, d.part);
    const cost = econ.recipes.partInputs(d.part);
    html += `<div class="t-r"><span>Made from</span><b>${bagText(econ, cost)}</b></div>`;
    html += `<div class="t-r"><span>Rebuild cost</span><b>${bagText(econ, econ.recipes.rebuildCost(d.part, econ.items)) || '—'}</b></div>`;
  }
  if (opts.count !== undefined) html += `<div class="t-r"><span>Have</span><b>${opts.count}</b></div>`;
  html += `<div class="t-r"><span>Value</span><b class="sgw-credits">${d.value.toLocaleString()} cr</b></div>`;
  html += `<div class="t-r"><span>Cargo space</span><b>${econ.items.volume(id)}</b></div>`;
  // (Carried in the hold it weighs the ship down: ships/load.ts)
  const mass = econ.items.mass(id);
  if (mass > 0) html += `<div class="t-r"><span>Mass in the hold</span><b>${mass < 0.1 ? mass.toFixed(2) : mass.toFixed(1)}${opts.count && opts.count > 1 ? ` · ${(mass * opts.count).toFixed(1)} all` : ''}</b></div>`;
  if (opts.extra) html += opts.extra;
  if (opts.hint) html += `<div class="t-h">${esc(opts.hint)}</div>`;
  return html;
}

const n0 = (v: number) => Math.round(v).toLocaleString();

/** A part's numbers (ships/partStats.ts) as tooltip rows: what it does, what it takes, and its score */
export function partStatsHtml(econ: Economy, part: { material: string; fn: string; piece: string }): string {
  const dp = describePart(econ.ships, econ.tuning, part);
  const st = dp?.base;
  if (!dp || !st) return '';
  const row = (k: string, v: string) => `<div class="t-r"><span>${k}</span><b>${v}</b></div>`;
  let html = row('Grade', `${st.mark}${st.size ? ` · ${st.size}` : ''}`);
  if (st.dps !== undefined) html += row('Damage', `${n0(st.dps)}/s${st.range ? ` · reach ${st.effectiveRange ? `${n0(st.effectiveRange)}, fading out to ${n0(st.range)}` : n0(st.range)}` : ''}`);
  if (st.pulse) html += row('Pulse', `${n0(st.pulse.damage)} a pulse · charges in ${st.pulse.seconds.toFixed(1)}s`);
  if (st.damageType) html += row('Hits with', `${DAMAGE_NAMES[st.damageType]} · penetration ${Math.round((st.pen ?? 1) * 10) / 10}`);
  if (st.supply) html += row('Power out', `+${n0(st.supply)}`);
  if (st.draw) html += row('Power draw', `${n0(st.draw)}`);
  if (st.thrust) html += row('Thrust', `${st.thrust.toFixed(1)}${st.boost ? ` · boost ×${st.boost}, drain ×${st.boostDrain}` : ''}`);
  if (st.shield) html += row('Shield', `${n0(st.shield)}`);
  if (st.cargo) html += row('Cargo', `${n0(st.cargo)}`);
  if (st.dodge) html += row("Dodge", `${st.dodge.force.toFixed(1)} push · every ${st.dodge.cooldown.toFixed(1)} s · ${Math.round(st.dodge.energy)} energy a burst`);
  for (const r of tipRows(dp.facts, true)) html += row(esc(r.label), esc(r.text));
  html += row('Hull · mass', `${n0(st.hp)} hp · ${st.mass.toFixed(1)}`);
  html += row('Armour · build', `${st.armour} · ${Math.round(partBuildPoints(econ.ships, part) * 10) / 10} pts`);
  const res = resistText(st.resist);
  if (res) html += row('Takes', res);
  html += row('Rating score', st.firepower > 0 ? `firepower ${n0(st.firepower)} · toughness ${n0(st.toughness)}` : `toughness ${n0(st.toughness)}`);
  return html;
}

/** "2× Alloy Plate, 1× Copper Wiring" */
export function bagText(econ: Economy, bag: Bag): string {
  return Object.entries(bag).map(([id, n]) => `${n}× ${esc(econ.items.name(id))}`).join(', ');
}

/** Costs as small icon chips; red where the pilot is short */
export function costHtml(econ: Economy, bag: Bag, have?: (id: string) => number): string {
  return Object.entries(bag).map(([id, n]) => {
    const short = have ? have(id) < n : false;
    return `<span class="sgw-cost${short ? ' short' : ''}" title="${esc(econ.items.name(id))}"><img src="${itemIcon(econ, id)}">${n}${have ? `<small style="opacity:.6">/${have(id)}</small>` : ''}</span>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Item grid
// ---------------------------------------------------------------------------

export type ItemFilter = 'all' | 'raw' | 'materials' | 'components' | 'parts' | 'other';
export const FILTERS: { id: ItemFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'raw', label: 'Ores & gems' }, { id: 'materials', label: 'Materials' },
  { id: 'components', label: 'Components' }, { id: 'parts', label: 'Ship parts' }, { id: 'other', label: 'Other' },
];

export function matchesFilter(d: ItemDef | undefined, f: ItemFilter): boolean {
  if (!d || f === 'all') return true;
  switch (f) {
    case 'raw': return d.category === 'mineral' || d.category === 'gem' || d.category === 'volatile';
    case 'materials': return d.category === 'refined';
    case 'components': return d.category === 'component' || d.category === 'artefact' || d.category === 'jewel';
    case 'parts': return d.category === 'part';
    case 'other': return d.category === 'consumable' || d.category === 'ammo' || d.category === 'plan' || d.category === 'quest';
  }
}

const CATEGORY_ORDER = ['quest', 'mineral', 'gem', 'volatile', 'refined', 'jewel', 'component', 'artefact', 'consumable', 'ammo', 'plan', 'part'];

export function sortStacks(econ: Economy, list: Stack[]): Stack[] {
  return [...list].sort((a, b) => {
    const da = econ.items.get(a.id), db = econ.items.get(b.id);
    const ca = CATEGORY_ORDER.indexOf(da?.category ?? ''), cb = CATEGORY_ORDER.indexOf(db?.category ?? '');
    if (ca !== cb) return ca - cb;
    const ra = RARITIES.indexOf(da?.rarity ?? 'common'), rb = RARITIES.indexOf(db?.rarity ?? 'common');
    if (ra !== rb) return rb - ra;
    return econ.items.rank(a.id) - econ.items.rank(b.id);
  });
}

export interface ItemGridOptions {
  econ: Economy;
  /** Drag-and-drop zone name: items dragged from another grid land here */
  zone: string;
  onClick?(id: string, e: MouseEvent): void;
  onContext?(id: string, e: MouseEvent): void;
  /** An item dragged here from another zone */
  onDrop?(id: string, fromZone: string, e: DragEvent): void;
  hint?(id: string): string | undefined;
  /** A corner tag for a stack (LOAD: the loadout's crates, UTIL: utility), with its class */
  tag?(id: string): { text: string; cls: string; tip?: string } | undefined;
  empty?: string;
}

export class ItemGrid {
  readonly el: HTMLDivElement;
  private dimmed = false;

  constructor(private o: ItemGridOptions) {
    this.el = document.createElement('div');
    this.el.className = 'sgw-grid';
    this.el.addEventListener('dragover', (e) => {
      const from = e.dataTransfer?.types.includes('application/x-sg-zone') ? true : false;
      if (from && this.o.onDrop) { e.preventDefault(); this.el.classList.add('drop'); }
    });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop'));
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('drop');
      const id = e.dataTransfer?.getData('application/x-sg-item');
      const zone = e.dataTransfer?.getData('application/x-sg-zone');
      if (id && zone && zone !== this.o.zone) { e.preventDefault(); this.o.onDrop?.(id, zone, e); }
    });
  }

  setDimmed(on: boolean): void {
    this.dimmed = on;
  }

  render(stacks: Stack[], filter: ItemFilter = 'all', search = ''): void {
    const { econ } = this.o;
    const q = search.trim().toLowerCase();
    const shown = sortStacks(econ, stacks).filter((s) => matchesFilter(econ.items.get(s.id), filter) && (!q || econ.items.name(s.id).toLowerCase().includes(q)));
    this.el.replaceChildren();
    if (!shown.length) {
      const e = document.createElement('div');
      e.className = 'sgw-empty';
      e.textContent = stacks.length ? 'Nothing matches' : this.o.empty ?? 'Empty';
      this.el.appendChild(e);
      return;
    }
    for (const s of shown) {
      const d = econ.items.get(s.id);
      const cell = document.createElement('div');
      cell.className = 'sgw-cell' + (this.dimmed ? ' dim' : '');
      cell.style.setProperty('--rc', d ? RARITY_COLOR[d.rarity] + '88' : '');
      cell.draggable = !this.dimmed;
      const img = document.createElement('img');
      img.src = itemIcon(econ, s.id);
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = s.n > 9999 ? `${Math.floor(s.n / 1000)}k` : String(s.n);
      cell.append(img, n);
      const tag = this.o.tag?.(s.id) ?? (d?.category === 'plan' ? { text: 'PLAN', cls: '' } : undefined);
      if (tag) { const t = document.createElement('span'); t.className = `tag ${tag.cls}`; t.textContent = tag.text; cell.appendChild(t); }
      cell.addEventListener('mousemove', (e) => showTip(itemTipHtml(econ, s.id, { count: s.n, hint: this.o.hint?.(s.id) }), e.clientX, e.clientY));
      cell.addEventListener('mouseleave', hideTip);
      cell.addEventListener('click', (e) => { if (!this.dimmed) this.o.onClick?.(s.id, e); });
      cell.addEventListener('contextmenu', (e) => { e.preventDefault(); hideTip(); if (!this.dimmed) this.o.onContext?.(s.id, e); });
      cell.addEventListener('dragstart', (e) => {
        hideTip();
        e.dataTransfer?.setData('application/x-sg-item', s.id);
        e.dataTransfer?.setData('application/x-sg-zone', this.o.zone);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      this.el.appendChild(cell);
    }
  }
}
