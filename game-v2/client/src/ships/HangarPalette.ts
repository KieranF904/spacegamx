/**
 * The hangar's part palette (the left column), built on the component guide's model (ui/componentGuide.ts,
 * componentAvail.ts, componentShapes.ts, componentData.ts) but laid out for building:
 *
 *  - IN HAND: the part you'd place, whether you have it, can make it (and what that costs against what you have) or
 *    what it waits on; its SHAPE strip when it comes in more than one (each shape's outline, turned as R and F turn
 *    it, and its footprint; a default picked: the one you last used it in, else a square, else its first); for
 *    structure and the core its MATERIAL; and which way it points (FACING).
 *  - The category tabs (Structure, Weapons, Engines, Power, Shields, Utility), each with how many are open to you.
 *  - The tab's list: what you can place first (spares on hand, then what you can fabricate), then LOCKED (dimmed,
 *    "Reach level N", foldable). A row: its picture, name, size, mount, key numbers, and on the right your spares,
 *    its cost (red where you're short) or its lock. Its chevron opens the build facts (buildFacts.ts): footprint,
 *    toughness, what it does, power and ports, how it fits, limits, and its cost against what you have.
 *
 * Keys (when the palette has keyboard focus; HangarUI's own keys otherwise): Tab / Shift+Tab move between the tabs,
 * shapes, materials, facing and the list; arrows move within one (left/right picks a tab, shape or material; up/down
 * moves through the list; right/left opens/closes a row's facts); Enter or Space picks. Tab from the grid focuses the
 * tabs. Placement, rotation (R, F, T), overlays and saving are HangarUI's.
 */

import {
  getVariant, gunFacing, hasFixedBarrel, isStructural, isWeaponFn, mountingOf, parsePartItemId, partItemId, partNeedsFacing, SIDES,
  type Bag, type Catalog, type Economy, type FunctionDef, type Rot, type ShipTuning, type Side,
} from '@space-game/common';
import { COMP_TABS, guideRows, requirementLine, type CompRow, type CompTab, type Gate, type PilotView } from '../ui/componentGuide';
import { componentGates, PLATES } from '../ui/componentData';
import { affordable, availability, costLines, lockLevel, lockText, splitOpen, type Avail, type CostLine } from '../ui/componentAvail';
import { footprint, footprintText, turned } from '../ui/componentShapes';
import { CHEVRON, costChipsHtml, esc, LOCK } from '../ui/componentKit';
import { itemIcon } from '../ui/itemIcons';
import { subsHtml, SUBS_STYLE } from './hangar/paletteSubs';
import { buildFacts, type FactGroup } from './buildFacts';
import { keyStats, mountBadge, mountingText, MOUNT_TEXT, sizeWord, weaponMount } from './modelCards';
import { paletteRows, rowInHand, rowPart, spareRows, tabOfFn, type PaletteRow } from './paletteModel';
import { functionColor, numToCss } from './shipColors';
import { ALL, applyFilters, loadFilters, saveFilters, subCounts, subsOf, type AmmoFilter, type FilterState, type MountFilter } from './paletteFilters';
import { cardStats } from './paletteCard';
import { cardHtml } from './paletteCardView';
import { GunPreviewHover } from './gunPreview/previewHover';

export interface PaletteSel { piece: string; fn: string; material: string; rot: Rot; flip: boolean; facing: Side | 'auto' }

/** What the palette reads from the hangar, and tells it */
export interface PaletteHost {
  catalog: Catalog;
  tuning: ShipTuning;
  econ: Economy;
  /** The part in hand (the palette changes its fields, then calls `changed`) */
  sel(): PaletteSel;
  /** Something new is in hand: redraw the grid */
  changed(): void;
  /** The part under the mouse in the list (null: none), for the grid's previews */
  hoverPart?(p: { fn: string; piece: string; material: string } | null): void;
  /** How many more of a part (item id) could still be placed from what you have (Infinity: everything granted) */
  remaining(id: string): number;
  /** Licensed to fit / fabricate it (the server's check) */
  canMake(id: string): boolean;
  /** Cargo + storage count of an item */
  have(id: string): number;
  level(): number;
  /** Learned licences (profile.recipes) */
  learned(): string[];
  /** Spare parts you own (item id -> count) */
  owned(): Bag;
  /** Every part places (free build or proto), and which */
  free(): boolean;
  freeBuild(): boolean;
  grantAll(): boolean;
  /** Field build overlay: `free()` only says a plan can hold any part; each part still costs materials to build, so show its cost, not "free" */
  fieldBuild?: boolean;
  partTip(id: string, e: MouseEvent): void;
  hideTip(): void;
  sound?(id: string): void;
}

interface RowStatus {
  part: { fn: string; piece: string; material: string };
  id: string;
  gates: Gate[];
  avail: Avail;
  /** Not licensed (shown dimmed unless everything places) */
  locked: boolean;
  spare: number;
  cost: CostLine[];
  /** Fabricating time in seconds (0: instant; null: no recipe, structure) */
  time: number | null;
  lock: string;
}

const FACING_LABEL: Record<Side | 'auto', string> = { auto: 'auto', N: '↑', E: '→', S: '↓', W: '←' };
const FACING_TIP: Record<Side | 'auto', string> = { auto: 'Its usual side, if that edge is free', N: 'Fore', E: 'Starboard', S: 'Aft', W: 'Port' };
const GROUPS: FactGroup[] = ['Shape', 'Build', 'Does', 'Power', 'Fitting', 'Limits'];

const STYLE = `
.hp { display: flex; flex-direction: column; min-height: 0; height: 100%; gap: 6px; color: #cfd8e6; font: 12px 'Segoe UI', system-ui, sans-serif; }
.hp :focus { outline: none; }
.hp :focus-visible { outline: 2px solid #6cc8ff; outline-offset: 1px; }
.hp button { font: inherit; color: inherit; }
.hp-hand { flex-shrink: 0; background: #0d1524; border: 1px solid #24324d; border-left: 3px solid var(--c, #8ea0bd); border-radius: 8px; padding: 6px 8px 7px; line-height: 1.35; }
.hp-hand-top { display: flex; align-items: baseline; gap: 6px; font-size: 10px; color: #6b7a93; letter-spacing: 1px; }
.hp-hand-top .keys { margin-left: auto; letter-spacing: 0; }
.hp-hand-main { display: flex; gap: 8px; align-items: center; margin-top: 3px; }
.hp-hand-main img { width: 34px; height: 34px; flex-shrink: 0; }
.hp-hand-name { display: flex; gap: 6px; align-items: center; min-width: 0; }
.hp-hand-name b { color: #e5ecf7; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-dim { color: #6b7a93; font-size: 11px; white-space: nowrap; }
.hp-say { font-size: 11px; }
.hp-say .ok { color: #4ade80; } .hp-say .mk { color: #7dd3fc; } .hp-say .bad { color: #f87171; } .hp-say .fb { color: #fbbf24; } .hp-say .q { color: #6b7a93; }
.hp-line { font-size: 11px; margin-top: 3px; color: #8ea0bd; }
.hp-line b { color: #e5ecf7; font-weight: 600; }
.hp-line .mk { color: #7dd3fc; }
.hp-cap { display: flex; align-items: baseline; gap: 6px; margin: 7px 0 3px; font: 700 9px 'Segoe UI', sans-serif; letter-spacing: 1.2px; color: #ffb547; text-transform: uppercase; }
.hp-cap span { font: 400 10.5px 'Segoe UI', sans-serif; letter-spacing: 0; text-transform: none; color: #8ea0bd; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-shapes { display: grid; grid-template-columns: repeat(auto-fill, minmax(34px, 1fr)); gap: 3px; }
.hp-shape { all: unset; box-sizing: border-box; cursor: pointer; position: relative; display: flex; flex-direction: column; align-items: center; gap: 0; padding: 2px 0 0; border-radius: 5px;
  background: #0f1626; border: 1px solid #2a3a5a; }
.hp-shape:hover { border-color: #46608c; }
.hp-shape[aria-checked="true"] { background: #24406b; border-color: #5fd4c4; }
.hp-shape small { font: 600 8.5px/10px 'Segoe UI', sans-serif; color: #8ea0bd; }
.hp-shape[aria-checked="true"] small { color: #e5ecf7; }
.hp-shape .tag { position: absolute; right: 2px; top: 0; font: 700 9px 'Segoe UI', sans-serif; color: #4ade80; }
.hp-shape.no { opacity: 0.4; }
.hp-chips { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
.hp-chip { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; font-size: 11px;
  background: #0f1626; border: 1px solid #2a3a5a; color: #cfd8e6; }
.hp-chip:hover { border-color: #46608c; }
.hp-chip[aria-checked="true"] { background: #24406b; border-color: #5fd4c4; color: #fff; }
.hp-chip i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.hp-chip.no { opacity: 0.45; }
.hp-more-n { color: #4b5870; font-size: 11px; }
.hp-tabs { flex-shrink: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 2px; border-bottom: 1px solid rgba(140, 170, 220, 0.16); }
.hp-tab { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; padding: 4px 4px 3px; min-width: 0;
  border-bottom: 2px solid transparent; margin-bottom: -1px; border-radius: 5px 5px 0 0;
  font: 700 9.5px/14px 'Segoe UI', sans-serif; letter-spacing: 1px; text-transform: uppercase; color: #8394ad; white-space: nowrap; }
.hp-tab:hover { color: #e5ecf7; background: rgba(125, 211, 252, 0.06); }
.hp-tab[aria-selected="true"] { color: #e8f6ff; border-bottom-color: #6cc8ff; background: rgba(108, 200, 255, 0.09); }
.hp-tab .n { min-width: 14px; padding: 0 4px; border-radius: 7px; box-sizing: border-box; text-align: center; background: rgba(125, 160, 210, 0.16); color: #c9d4e5;
  font-size: 9px; letter-spacing: 0; line-height: 13px; }
.hp-tab .n.sp { background: rgba(74, 222, 128, 0.18); color: #86efac; }
.hp-sub { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 10px; font-size: 10.5px; line-height: 16px;
  background: #0f1626; border: 1px solid #2a3a5a; color: #a7b4c8; }
.hp-sub:hover { border-color: #46608c; color: #e5ecf7; }
${SUBS_STYLE}.hp-card { display: block; white-space: normal; }
.hp-bars { display: grid; grid-template-columns: repeat(var(--n, 3), minmax(0, 1fr)); gap: 8px; }
.hp-bar { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-areas: 'l n' 'b b'; column-gap: 4px; row-gap: 1px; font-size: 10px; min-width: 0; }
.hp-bar em { grid-area: l; font-style: normal; color: #6b7a93; font-size: 9px; }
.hp-bar b { grid-area: n; text-align: right; color: #d6deeb; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hp-bar i { grid-area: b; display: block; height: 4px; border-radius: 2px; background: #1b2740; position: relative; overflow: hidden; }
.hp-bar i::after { content: ''; position: absolute; inset: 0; width: var(--f, 0%); background: var(--c, #7dd3fc); border-radius: 2px; }
.hp-held { font-size: 9px; color: #7dd3fc; border: 1px solid #2f6f8f; border-radius: 3px; padding: 0 3px; }
.hp-heads { font-size: 10.5px; color: #a7b4c8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hp-chipsrow { display: flex; gap: 8px; align-items: center; margin-top: 2px; }
.hp-am, .hp-pw { display: inline-flex; align-items: center; gap: 2px; font-size: 10px; color: #d6deeb; white-space: nowrap; }
.hp-am img { width: 14px; height: 14px; }
.hp-pw svg { width: 10px; height: 10px; color: #fbbf24; }
.hp-pw.make svg { color: #4ade80; } .hp-pw.hold svg { color: #7dd3fc; }
.hp-pw small { color: #6b7a93; font-size: 9px; }
.hp-list { flex: 1; min-height: 60px; overflow-y: auto; padding-right: 2px; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: #2a3a5a transparent; }
.hp-row { display: grid; grid-template-columns: minmax(0, 1fr) 20px; margin-bottom: 3px; border-radius: 6px; background: #0f1626; border: 1px solid #22304a;
  border-left: 3px solid var(--c, #8ea0bd); overflow: hidden; }
.hp-row.on { background: #1b3157; border-color: #5fd4c4; border-left-color: var(--c, #8ea0bd); }
.hp-pick { all: unset; box-sizing: border-box; cursor: pointer; display: flex; gap: 7px; align-items: center; min-width: 0; padding: 3px 5px 3px 4px; }
.hp-pick:hover { background: rgba(125, 211, 252, 0.05); }
.hp-pick img { width: 30px; height: 30px; flex-shrink: 0; pointer-events: none; }
.hp-txt { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.hp-l1 { display: flex; gap: 5px; align-items: center; min-width: 0; }
.hp-l1 b { color: #e5ecf7; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.hp-l1 .sz { color: #6b7a93; font-size: 10px; white-space: nowrap; }
.hp-l1 .ns { color: #7dd3fc; font-size: 10px; white-space: nowrap; }
.hp-l2 { font-size: 10px; color: #a7b4c8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hp-l2.lk { color: #f0a58f; display: flex; gap: 3px; align-items: center; }
.hp-l2 svg { width: 9px; height: 9px; flex-shrink: 0; }
.hp-st { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 1px; font-size: 10px; line-height: 1.2; max-width: 46%; }
.hp-st .ok { color: #4ade80; font-weight: 700; font-size: 13px; }
.hp-st .q { color: #6b7a93; }
.hp-st .fb { color: #fbbf24; }
.hp-cost { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
.hp-mat { display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; color: #d6deeb; font-weight: 600; }
.hp-mat img { width: 12px; height: 12px; }
.hp-mat.short { color: #f87171; }
.hp-cost.lk { opacity: 0.55; }
.hp-mat small { color: #6b7a93; font-weight: 400; }
.hp-x { all: unset; cursor: pointer; display: grid; place-items: center; color: #6b7a93; border-left: 1px solid rgba(140, 170, 220, 0.08); }
.hp-x:hover { color: #fff; background: rgba(125, 211, 252, 0.07); }
.hp-x svg { width: 10px; height: 10px; transition: transform 0.15s; }
.hp-x[aria-expanded="true"] svg { transform: rotate(180deg); }
.hp-row.dim .hp-pick > img, .hp-row.dim .hp-txt { opacity: 0.55; }
.hp-facts { grid-column: 1 / 3; padding: 4px 8px 7px; border-top: 1px solid rgba(140, 170, 220, 0.1); background: rgba(3, 6, 14, 0.3); font-size: 10.5px; }
.hp-facts h6 { margin: 5px 0 1px; font: 700 8.5px 'Segoe UI', sans-serif; letter-spacing: 1.3px; color: #7dd3fc; text-transform: uppercase; }
.hp-kv { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 6px; padding: 1px 0; border-bottom: 1px solid #16203a; }
.hp-kv span { color: #8ea0bd; }
.hp-kv b { color: #e5ecf7; font-weight: 600; }
.hp-kv b.warn { color: #fbbf24; }
.hp-kv .hp-cost { justify-content: flex-start; }
.hp-fold { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: baseline; gap: 6px; width: 100%; margin: 8px 0 4px; padding: 1px 2px; border-radius: 4px; }
.hp-fold b { color: #ffb547; font-size: 10.5px; letter-spacing: 1px; }
.hp-fold span { color: #6b7a93; font-size: 10.5px; }
.hp-fold:hover b { color: #ffd08a; }
.hp-none { color: #6b7a93; font-size: 11px; padding: 4px 2px; line-height: 1.4; }
.hp-foot { flex-shrink: 0; }
@media (prefers-reduced-motion: reduce) { .hp-x svg { transition: none; } }`;

let styled = false;

export class HangarPalette {
  readonly root: HTMLDivElement;
  /** HangarUI's own bit under the list (help, overlays, debug) */
  readonly foot: HTMLDivElement;
  private hand: HTMLDivElement;
  private tabsEl: HTMLDivElement;
  private list: HTMLDivElement;
  private tab: CompTab = 'structure';
  private guide: CompRow[];
  private rows: PaletteRow[];
  /** Rows with their facts open */
  private openRows = new Set<string>();
  private lockedOpen = false;
  /** The shape each function was last used in (a component's default next time) */
  private shapeMemory = new Map<string, string>();
  /** Each part's key numbers, worked out once */
  private stats = new Map<string, string>();
  /** This render's statuses, by row id */
  private st = new Map<string, RowStatus>();
  /** The subcategory chips under the tabs, and what they and the weapon toggles have chosen (remembered) */
  private subsEl: HTMLDivElement;
  private filters: FilterState = loadFilters();
  /** The live gun preview beside the list (made on the first hover over a gun) */
  private hover: GunPreviewHover;

  constructor(private h: PaletteHost) {
    if (!styled) {
      styled = true;
      const s = document.createElement('style');
      s.textContent = STYLE;
      document.head.appendChild(s);
    }
    this.guide = guideRows(h.catalog, PLATES);
    this.rows = paletteRows(h.catalog, this.guide);
    this.root = document.createElement('div');
    this.root.className = 'hp';
    this.hand = document.createElement('div');
    this.hand.className = 'hp-hand';
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'hp-tabs';
    this.tabsEl.setAttribute('role', 'tablist');
    this.tabsEl.setAttribute('aria-label', 'Part categories');
    this.subsEl = document.createElement('div');
    this.subsEl.className = 'hp-subs';
    this.subsEl.setAttribute('role', 'group');
    this.subsEl.setAttribute('aria-label', 'Filter this category');
    this.list = document.createElement('div');
    this.list.className = 'hp-list';
    this.list.setAttribute('role', 'tabpanel');
    this.foot = document.createElement('div');
    this.foot.className = 'hp-foot';
    this.root.append(this.hand, this.tabsEl, this.subsEl, this.list, this.foot);
    this.hover = new GunPreviewHover(this.root, { catalog: h.catalog, tuning: h.tuning, econ: h.econ });
    this.tab = tabOfFn(this.rows, h.sel().fn) ?? 'structure';

    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    // Hover a part (a row, the part in hand): what it is and does
    this.root.addEventListener('mousemove', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-part]');
      if (el) { this.h.hoverPart?.(parsePartItemId(el.dataset.part!)); this.h.partTip(el.dataset.part!, this.hover.clearOfPanel(el.dataset.part!, e)); this.hover.over(el.dataset.part!, el.closest<HTMLElement>('.hp-row') ?? el); } else { this.h.hoverPart?.(null); this.h.hideTip(); this.hover.out(); }
    });
    this.root.addEventListener('mouseleave', () => { this.h.hoverPart?.(null); this.h.hideTip(); this.hover.out(); });
  }

  // -------------------------------------------------------------------------
  // What's what
  // -------------------------------------------------------------------------

  /** Every part places at no cost (the field overlay's plan places any part, but building it is paid for) */
  private free(): boolean {
    return this.h.free() && !this.h.fieldBuild;
  }

  private pilot(): PilotView {
    return { level: this.h.level(), learned: this.h.learned(), have: (id) => this.h.have(id) };
  }

  /** A row's gates: a model's or the core's own; structure's are its material's (the guide's structure row) */
  private gatesOf(r: PaletteRow, material: string): Gate[] {
    if (r.kind === 'spare') return [];
    const g = this.guide.find((x) => x.id === (r.kind === 'structure' ? `structure:${material}` : r.id));
    return g ? componentGates(this.h.catalog, this.h.econ, g, this.pilot()) : [];
  }

  private status(r: PaletteRow): RowStatus {
    const { econ } = this.h;
    const part = rowPart(r, this.h.sel(), this.shapeMemory.get(r.fn));
    const id = partItemId(part);
    const gates = this.gatesOf(r, part.material);
    const left = this.h.remaining(id);
    const spare = left === Infinity ? 0 : Math.max(0, left);
    const can = this.h.canMake(id);
    const avail = availability({ free: this.free(), spare, canMake: can });
    const rec = econ.recipes.recipeFor(id);
    const bag = isStructural(part.fn) || part.fn === 'core' || !rec ? econ.recipes.partInputs(part) : rec.inputs;
    return {
      // (proto's grant-everything has no locks; free build keeps them, undimmed: they place too)
      part, id, gates, avail, locked: !can && !this.h.grantAll(), spare,
      cost: costLines(bag, (k) => this.h.have(k)),
      time: rec && !isStructural(part.fn) ? rec.time : null,
      lock: lockText(gates) || (can ? '' : 'Not licensed to fit yet'),
    };
  }

  private statusOf(r: PaletteRow): RowStatus {
    let s = this.st.get(r.id);
    if (!s) this.st.set(r.id, s = this.status(r));
    return s;
  }

  /** Rows of a tab: the tab's components, then spares no row covers */
  private rowsOf(tab: CompTab): PaletteRow[] {
    const owned = this.h.grantAll() ? [] : Object.keys(this.h.owned()).filter((id) => this.h.remaining(id) > 0);
    const spares = spareRows(this.h.catalog, owned, this.rows, (id) => this.h.econ.items.get(id)?.part ?? null, (id) => this.h.econ.items.name(id));
    return [...this.rows, ...spares].filter((r) => r.tab === tab);
  }

  /** The tab's rows after the subcategory and weapon filters; `base`: before the subcategory (its chips' counts) */
  private visibleRows(tab: CompTab): { rows: PaletteRow[]; base: PaletteRow[] } {
    const { catalog, tuning } = this.h;
    const base = applyFilters(this.rowsOf(tab), tab, { ...this.filters, sub: {} }, catalog, tuning);
    return { base, rows: applyFilters(base, tab, this.filters, catalog, tuning) };
  }

  /** Keeps the row of the part in hand on screen: a filter that hides it is let go */
  private ensureVisible(): void {
    const tab = tabOfFn(this.rows, this.h.sel().fn);
    if (!tab) return;
    const row = this.rows.find((r) => r.kind !== 'spare' && r.fn === this.h.sel().fn);
    if (row && !this.visibleRows(tab).rows.includes(row)) {
      delete this.filters.sub[tab];
      this.filters.ammo = 'any';
      this.filters.mount = 'any';
      saveFilters(this.filters);
    }
  }

  private keyStatsOf(f: FunctionDef, piece: string, material: string): string {
    const k = `${f.id}:${piece}:${material}`;
    let s = this.stats.get(k);
    if (s === undefined) this.stats.set(k, s = keyStats(this.h.catalog, this.h.tuning, f, piece, material));
    return s;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /** Everything (keeps the keyboard's place) */
  render(): void {
    const focus = this.focusKey();
    this.st.clear();
    this.renderHand();
    this.renderTabs();
    this.renderSubs();
    this.renderList();
    this.refocus(focus);
  }

  /** Has what the hold has moved since the rows were worked out (a list left open while you fly): draw again if so */
  stale(): boolean {
    for (const s of this.st.values()) {
      if (s.cost.some((c) => this.h.have(c.id) !== c.have)) return true;
      const left = this.h.remaining(s.id);
      if ((left === Infinity ? 0 : Math.max(0, left)) !== s.spare) return true;
    }
    return false;
  }

  /** Only the part in hand (a turn, a mirror, a facing) */
  renderHand(): void {
    const focus = this.focusKey();
    this.hand.innerHTML = this.handHtml();
    this.refocus(focus);
  }

  /** Show the part in hand's tab (a part picked up off the grid), its row in view */
  showInHand(): void {
    const t = tabOfFn(this.rows, this.h.sel().fn);
    if (t) this.tab = t;
    this.shapeMemory.set(this.h.sel().fn, this.h.sel().piece);
    this.ensureVisible();
    this.render();
    this.list.querySelector<HTMLElement>('.hp-row.on')?.scrollIntoView({ block: 'nearest' });
  }

  /** Put keyboard focus on the tabs (Tab from the grid) */
  focusTabs(): void {
    this.tabsEl.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }

  private renderTabs(): void {
    const counts = new Map(COMP_TABS.map((t) => {
      const rows = this.rowsOf(t.id).map((r) => this.statusOf(r));
      return [t.id, { open: rows.filter((s) => !s.locked).length, total: rows.length, spare: rows.reduce((a, s) => a + s.spare, 0) }];
    }));
    this.tabsEl.innerHTML = COMP_TABS.map((t) => {
      const c = counts.get(t.id)!, on = t.id === this.tab;
      const title = `${t.label}: ${c.open} of ${c.total} open to you${c.spare ? `, ${c.spare} spare on hand` : ''}`;
      return `<button class="hp-tab" role="tab" data-tab="${t.id}" data-key="tab:${t.id}" aria-selected="${on}" tabindex="${on ? 0 : -1}" title="${esc(title)}">`
        + `<span>${esc(t.short)}</span><span class="n${c.spare ? ' sp' : ''}">${c.spare ? `${c.spare}` : c.open}</span></button>`;
    }).join('');
  }

  /** The filter area: type tiles (with counts) and, for weapons, the ammo and mount toggles (hangar/paletteSubs.ts) */
  private renderSubs(): void {
    const tab = this.tab, { catalog, tuning } = this.h;
    const { base } = this.visibleRows(tab);
    const counts = subCounts(base, tab, catalog, tuning);
    const cur = this.filters.sub[tab] ?? ALL;
    const subs = subsOf(tab).filter((s) => (counts.get(s.id) ?? 0) > 0 || s.id === cur);
    const html = subsHtml(tab, subs, counts, cur, this.filters);
    this.subsEl.hidden = !html;
    this.subsEl.innerHTML = html;
  }

  private renderList(): void {
    const scroll = this.list.scrollTop;
    const rows = this.visibleRows(this.tab).rows;
    const sel = this.h.sel();
    const inHand = rowInHand(rows, sel);
    const { open, locked } = splitOpen(rows, (r) => !this.statusOf(r).locked);
    let html = open.map((r) => this.rowHtml(r, r === inHand)).join('');
    if (!open.length && !locked.length && this.rowsOf(this.tab).length) html += `<div class="hp-none">Nothing matches these filters. <button class="hp-sub" data-clear data-key="clear">Show all</button></div>`;
    else if (!open.length) html += `<div class="hp-none">Nothing here is open to you yet.</div>`;
    if (locked.length) {
      const next = locked.map((r) => lockLevel(this.statusOf(r).gates)).find((n) => n !== null);
      const note = this.free() ? ' · free build places these too' : next ? ` · next at level ${next}` : '';
      html += `<button class="hp-fold" data-fold data-key="fold" aria-expanded="${this.lockedOpen}"><b>${this.lockedOpen ? '▾' : '▸'} LOCKED</b><span>${locked.length}${note}</span></button>`;
      if (this.lockedOpen) html += locked.map((r) => this.rowHtml(r, r === inHand)).join('');
    }
    this.list.innerHTML = html;
    this.list.setAttribute('aria-label', COMP_TABS.find((t) => t.id === this.tab)!.label);
    this.list.scrollTop = scroll;
  }

  private rowHtml(r: PaletteRow, on: boolean): string {
    const { catalog, econ } = this.h;
    const s = this.statusOf(r);
    const f = catalog.functions.get(r.fn)!;
    const dim = s.locked && !this.free();
    const open = this.openRows.has(r.id);
    const size = f.model ? sizeWord(catalog, s.part.piece) : r.shapes.length > 1 ? '' : sizeWord(catalog, s.part.piece);
    const color = f.color ?? numToCss(functionColor(f.id));
    const shapes = r.shapes.length > 1 ? `<span class="ns">${r.shapes.length} shapes</span>` : '';
    const line2 = dim
      ? `<span class="hp-l2 lk">${LOCK}<span>${esc(s.lock)}</span></span>`
      : `<span class="hp-l2 hp-card" title="${esc(this.keyStatsOf(f, s.part.piece, s.part.material))}" style="--c:${color}">${cardHtml(econ, cardStats(catalog, this.h.tuning, f, s.part.piece, s.part.material))}</span>`;
    // (the long text is the tooltip's; the row shows bars, ammo and power)
    return `<div class="hp-row${on ? ' on' : ''}${dim ? ' dim' : ''}" data-row="${esc(r.id)}" style="--c:${color}">`
      + `<button class="hp-pick" data-pick="${esc(r.id)}" data-part="${esc(s.id)}" data-key="pick:${esc(r.id)}" aria-pressed="${on}" aria-label="${esc(`${r.name}${dim ? `, locked: ${s.lock}` : ''}`)}">`
      + `<img src="${itemIcon(econ, s.id)}" alt="">`
      + `<span class="hp-txt"><span class="hp-l1"><b>${esc(r.name)}</b>${size ? `<span class="sz">${size}</span>` : ''}${shapes}${mountBadge(catalog, { fn: f.id })}</span>${line2}</span>`
      + `<span class="hp-st">${this.statusHtml(s, r)}</span></button>`
      + `<button class="hp-x" data-more="${esc(r.id)}" data-key="more:${esc(r.id)}" aria-expanded="${open}" aria-label="${esc(`Build facts: ${r.name}`)}" title="${open ? 'Fewer facts' : 'Build facts'}">${CHEVRON}</button>`
      + (open ? `<div class="hp-facts">${this.factsHtml(r, s)}</div>` : '')
      + `</div>`;
  }

  /** The row's right side: spares, its cost (red where short), its lock, or free */
  private statusHtml(s: RowStatus, r: PaletteRow): string {
    const spare = s.spare > 0 ? `<b class="ok" title="${s.spare} on hand">×${s.spare}</b>` : '';
    if (s.avail === 'free') return `<span class="fb">${this.h.freeBuild() ? 'free build' : 'free'}</span>`;
    if (s.avail === 'have') return spare;
    const chips = costChipsHtml(this.h.econ, s.cost, 'hp-mat');
    // (locked: its lock is on the line under its name; here what it will cost, faded)
    if (s.avail === 'locked') return spare + (chips ? `<span class="hp-cost lk" title="${esc(requirementLine(s.gates).text || s.lock)}">${chips}</span>` : '');
    const when = r.kind === 'structure' || r.kind === 'core' ? '<span class="q">a cell</span>' : s.time ? `<span class="q">${s.time}s</span>` : '<span class="q">instant</span>';
    return `<span class="hp-cost">${chips || '<span class="q">no cost</span>'}</span>${when}`;
  }

  /** The opened row: build facts by group, then what it costs against what you have, and its lock */
  private factsHtml(r: PaletteRow, s: RowStatus): string {
    const { catalog, tuning, econ } = this.h;
    const f = catalog.functions.get(r.fn)!;
    const facts = buildFacts(catalog, tuning, f, s.part.piece, s.part.material);
    const kv = (k: string, v: string, warn = false) => `<div class="hp-kv"><span>${esc(k)}</span><b${warn ? ' class="warn"' : ''}>${v}</b></div>`;
    let html = '';
    for (const g of GROUPS) {
      const list = facts.filter((x) => x.group === g);
      if (!list.length) continue;
      html += `<h6>${g}</h6>` + list.map((x) => kv(x.label, esc(x.value), x.warn)).join('');
    }
    html += `<h6>Cost</h6>`;
    if (this.free()) html += kv('Making it', 'free here');
    else {
      const chips = costChipsHtml(econ, s.cost, 'hp-mat', true);
      html += kv(r.kind === 'structure' || r.kind === 'core' ? 'A cell takes' : 'Fabricating', chips ? `<span class="hp-cost">${chips}</span>` : 'nothing');
      if (s.cost.length) html += kv('You have', affordable(s.cost) ? 'all of it' : 'not enough (red)', !affordable(s.cost));
      if (s.spare) html += kv('On hand', `${s.spare}`);
      if (s.time !== null) html += kv('Takes', s.time > 0 ? `${s.time} s at the fabricator` : 'instant');
    }
    if (s.locked) html += kv('Locked', esc(requirementLine(s.gates).text || s.lock), true);
    return html;
  }

  /** The part in hand */
  private handHtml(): string {
    const { catalog, econ } = this.h;
    const sel = this.h.sel();
    const f = catalog.functions.get(sel.fn);
    if (!f) return '';
    const row = rowInHand(this.rows, sel) ?? { id: `spare:${sel.fn}`, tab: 'structure' as CompTab, name: f.name ?? f.id, level: null, order: 0, fn: f.id, material: sel.material, kind: 'spare' as const, shapes: [sel.piece] };
    const material = f.model && f.material ? f.material : sel.material;
    const id = partItemId({ piece: sel.piece, fn: sel.fn, material });
    const def = econ.items.get(id);
    const can = this.h.canMake(id);
    const left = this.h.remaining(id);
    const structure = isStructural(sel.fn) || sel.fn === 'core';
    const gates = this.gatesOf(row, material);
    const why = lockText(gates);
    const say = this.h.freeBuild() ? '<span class="fb">Free build: it places, and saving takes nothing</span>'
      : this.h.grantAll() ? '<span class="q">Free here</span>'
      : !can ? `<span class="bad">${esc(why || (structure ? `You can't build in ${catalog.materials.get(material)?.name ?? material} yet` : "You can't make this yet"))}</span>`
      : structure ? '<span class="mk">Built from materials as it goes in</span>'
      : left > 0 ? `<span class="ok">${left} on hand</span>`
      : '<span class="mk">None on hand: places as a ghost to fabricate</span>';
    const rec = econ.recipes.recipeFor(id);
    const bag = structure || !rec ? econ.recipes.partInputs({ piece: sel.piece, fn: sel.fn, material }) : rec.inputs;
    const cost = costLines(bag, (k) => this.h.have(k));
    const showCost = !this.free() && can && (structure || left <= 0) && cost.length;
    const fp = footprint(catalog, sel.piece);
    let html = `<div class="hp-hand-top"><span>IN HAND</span><span class="keys">R ${sel.rot * 90}° · F ${sel.flip ? 'mirrored' : 'mirror'}${partNeedsFacing(sel.fn) && !hasFixedBarrel(catalog, sel.fn) ? ' · T facing' : ''}</span></div>`
      + `<div class="hp-hand-main" data-part="${esc(id)}"><img src="${itemIcon(econ, id)}" alt="">`
      + `<div style="min-width:0; flex:1"><div class="hp-hand-name"><b>${esc(f.model ? f.name ?? f.id : def?.name ?? f.name ?? f.id)}</b><span class="hp-dim">${esc(fp.size)}</span>${mountBadge(catalog, { fn: f.id })}</div>`
      + `<div class="hp-say">${say}</div></div></div>`;
    if (isWeaponFn(f.id)) {
      // (its rules in words; a side mount: which side it's on, and how to swap it)
      const words = mountingText(catalog, { fn: f.id }, this.h.tuning);
      const side = mountingOf(catalog, f.id)?.angle === 'right' ? ` <span class="mk">(${sel.flip ? 'mirrored' : 'as drawn'} · F flips)</span>` : '';
      html += `<div class="hp-line">Mount: <b>${esc(words.join(' · ') || MOUNT_TEXT[weaponMount(catalog, { fn: f.id })])}</b>${side}</div>`;
    }
    if (showCost) html += `<div class="hp-line" style="display:flex; gap:6px; align-items:center">${structure ? 'A cell:' : 'Makes from:'} <span class="hp-cost" style="justify-content:flex-start">${costChipsHtml(econ, cost, 'hp-mat', true)}</span>${!structure && rec ? `<span class="hp-dim">${rec.time > 0 ? `${rec.time}s` : 'instant'}</span>` : ''}</div>`;
    const color = f.color ?? numToCss(functionColor(f.id));
    this.hand.style.setProperty('--c', color);
    if (row.shapes.length > 1) html += this.shapesHtml(row, material);
    if (structure) html += this.materialsHtml();
    if (hasFixedBarrel(catalog, sel.fn)) {
      // (A gun's barrel is on one side of its piece: R turns it, so there is no facing to pick)
      html += `<div class="hp-line">Barrel: <b>${FACING_LABEL[gunFacing(catalog, sel) ?? 'N']}</b> <span class="mk">(R turns it)</span></div>`;
    } else if (partNeedsFacing(sel.fn)) {
      html += `<div class="hp-cap">Facing <span>T cycles it</span></div><div class="hp-chips" role="radiogroup" aria-label="Facing" data-group="face">`
        + (['auto', ...SIDES] as (Side | 'auto')[]).map((s) => `<button class="hp-chip" role="radio" data-face="${s}" data-key="face:${s}" aria-checked="${sel.facing === s}" tabindex="${sel.facing === s ? 0 : -1}" title="${FACING_TIP[s]} (T)">${FACING_LABEL[s]}</button>`).join('')
        + `</div>`;
    }
    return html;
  }

  /** The shape strip: each shape's outline (turned as in hand) and footprint; the one in hand ticked */
  private shapesHtml(row: PaletteRow, material: string): string {
    const { catalog } = this.h;
    const sel = this.h.sel();
    const fp = turned(footprint(catalog, sel.piece), sel.rot);
    let html = `<div class="hp-cap">Shape <span>${esc(fp.name)} · ${esc(fp.size)} · ${footprintText(fp)}</span></div><div class="hp-shapes" role="radiogroup" aria-label="Shape" data-group="shape">`;
    const structure = isStructural(sel.fn) || sel.fn === 'core';
    for (const pc of row.shapes) {
      const id = partItemId({ piece: pc, fn: sel.fn, material });
      const n = this.h.remaining(id);
      const ok = this.free() || this.h.canMake(id) || n > 0;
      const on = sel.piece === pc, p = turned(footprint(catalog, pc), sel.rot);
      const tag = this.free() || structure || n === Infinity || n <= 0 ? '' : `<span class="tag">${n}</span>`;
      html += `<button class="hp-shape${ok ? '' : ' no'}" role="radio" data-shape="${pc}" data-part="${esc(id)}" data-key="shape:${pc}" aria-checked="${on}" tabindex="${on ? 0 : -1}" aria-label="${esc(`${p.name}, ${footprintText(p)}`)}">`
        + `${pieceIcon(catalog, pc, sel.rot, sel.flip, 18)}<small>${p.w}×${p.h}</small>${tag}</button>`;
    }
    return html + `</div>`;
  }

  /** Structure's materials: those you can build in (and the one in hand), the rest counted with the next level */
  private materialsHtml(): string {
    const { catalog } = this.h;
    const sel = this.h.sel();
    let html = '', hidden = 0, next: { name: string; lv: number } | null = null;
    for (const g of this.guide) {
      if (g.kind !== 'structure') continue;
      const m = catalog.materials.get(g.material)!;
      const sample = partItemId({ material: m.id, fn: sel.fn, piece: sel.piece });
      const ok = this.free() || this.h.remaining(sample) > 0 || this.h.canMake(sample);
      const on = sel.material === m.id;
      if (!ok && !on) {
        hidden++;
        const lv = lockLevel(componentGates(catalog, this.h.econ, g, this.pilot()));
        if (lv !== null && (!next || lv < next.lv)) next = { name: m.name ?? m.id, lv };
        continue;
      }
      html += `<button class="hp-chip${ok ? '' : ' no'}" role="radio" data-mat="${m.id}" data-part="${esc(sample)}" data-key="mat:${m.id}" aria-checked="${on}" tabindex="${on ? 0 : -1}"><i style="background:${m.color}"></i>${esc(m.name ?? m.id)}</button>`;
    }
    if (hidden) html += `<span class="hp-more-n" title="Better materials open as you level">+${hidden} locked${next ? ` · ${esc(next.name)} at level ${next.lv}` : ''}</span>`;
    return `<div class="hp-cap">Material</div><div class="hp-chips" role="radiogroup" aria-label="Material" data-group="mat">${html}</div>`;
  }

  // -------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------

  /** Put a row's component in hand: the shape you last used it in, else its default */
  private pickRow(id: string): void {
    const r = [...this.rows, ...this.rowsOf(this.tab)].find((x) => x.id === id);
    if (!r) return;
    const sel = this.h.sel();
    const part = rowPart(r, sel, this.shapeMemory.get(r.fn));
    sel.fn = part.fn;
    sel.piece = part.piece;
    // (A model is made of its own material, so the one picked for structure stays; a spare is what it is; structure
    // goes back to alloy if what's picked isn't a structure material, a model's picked up off the grid)
    if (r.kind === 'spare') sel.material = part.material;
    else if (r.kind !== 'model' && !this.guide.some((g) => g.id === `structure:${sel.material}`)) sel.material = 'alloy';
    this.h.sound?.('ui_click');
    this.changed();
  }

  private pickShape(pc: string): void {
    const sel = this.h.sel();
    sel.piece = pc;
    this.shapeMemory.set(sel.fn, pc);
    this.changed();
  }

  private changed(): void {
    this.render();
    this.h.changed();
  }

  /** A filter chip changed: remember it, and redraw the chips and the list from the top */
  private setFilter(apply: () => void): void {
    apply();
    saveFilters(this.filters);
    this.list.scrollTop = 0;
    this.h.sound?.('ui_click');
    this.render();
  }

  private setTab(t: CompTab, focus = false): void {
    if (t !== this.tab) {
      this.tab = t;
      this.list.scrollTop = 0;
      this.h.sound?.('ui_click');
      this.render();
    }
    if (focus) this.tabsEl.querySelector<HTMLElement>(`[data-tab="${t}"]`)?.focus();
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>('[data-tab],[data-pick],[data-more],[data-fold],[data-shape],[data-mat],[data-face],[data-sub],[data-needs],[data-clear]');
    if (!b) return;
    const d = b.dataset;
    if (d.tab) this.setTab(d.tab as CompTab);
    else if (d.sub !== undefined) this.setFilter(() => { if (d.sub === ALL) delete this.filters.sub[this.tab]; else this.filters.sub[this.tab] = d.sub!; });
    else if (d.needs) {
      const k = d.needs;
      this.setFilter(() => {
        if (k === 'ammo' || k === 'none') this.filters.ammo = this.filters.ammo === k ? 'any' : (k as AmmoFilter);
        else this.filters.mount = this.filters.mount === k ? 'any' : (k as MountFilter);
      });
    } else if (d.clear !== undefined) this.setFilter(() => { this.filters = { sub: {}, ammo: 'any', mount: 'any' }; });
    else if (d.pick) this.pickRow(d.pick);
    else if (d.more) { if (this.openRows.has(d.more)) this.openRows.delete(d.more); else this.openRows.add(d.more); this.render(); }
    else if (d.fold !== undefined) { this.lockedOpen = !this.lockedOpen; this.render(); }
    else if (d.shape) this.pickShape(d.shape);
    else if (d.mat) { this.h.sel().material = d.mat; this.changed(); }
    else if (d.face) { this.h.sel().facing = d.face as Side | 'auto'; this.renderHand(); this.h.changed(); }
    // (A mouse pick leaves no focus behind: the arrow keys go back to panning)
    if (e.detail > 0) (document.activeElement as HTMLElement | null)?.blur?.();
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  private focusKey(): string | null {
    const a = document.activeElement as HTMLElement | null;
    return a && this.root.contains(a) ? a.dataset.key ?? null : null;
  }

  private refocus(key: string | null): void {
    if (!key) return;
    const el = this.root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (el && document.activeElement !== el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
  }

  /** The keyboard's stops, in order (Tab moves between them): the tabs, the shape, material and facing groups, the list; each with where focus lands in it */
  private zones(): { box: HTMLElement; to: HTMLElement }[] {
    const out: { box: HTMLElement; to: HTMLElement }[] = [];
    const tab = this.tabsEl.querySelector<HTMLElement>('[aria-selected="true"]');
    if (tab) out.push({ box: this.tabsEl, to: tab });
    for (const g of this.hand.querySelectorAll<HTMLElement>('[data-group]')) {
      const el = g.querySelector<HTMLElement>('[aria-checked="true"]') ?? g.querySelector<HTMLElement>('button');
      if (el) out.push({ box: g, to: el });
    }
    // (the filter chips: one stop for the groups, one for the weapon toggles)
    for (const g of this.subsEl.querySelectorAll<HTMLElement>('[data-group]')) {
      const el = g.querySelector<HTMLElement>('[aria-checked="true"]') ?? g.querySelector<HTMLElement>('button');
      if (el) out.push({ box: g, to: el });
    }
    const row = this.list.querySelector<HTMLElement>('.hp-row.on .hp-pick') ?? this.list.querySelector<HTMLElement>('.hp-pick,.hp-fold');
    if (row) out.push({ box: this.list, to: row });
    return out;
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || e.ctrlKey || e.altKey || e.metaKey) return;
    // (After a mouse click nothing here has keyboard focus: arrows stay the grid's)
    if (e.code !== 'Tab' && !t.matches(':focus-visible')) return;
    if (this.key(e.code, e.shiftKey, t)) { e.preventDefault(); e.stopPropagation(); }
  }

  /** Handle a key on `t`; true when it was the palette's */
  private key(code: string, shift: boolean, t: HTMLElement): boolean {
    const step = (els: HTMLElement[], d: number) => {
      const i = els.indexOf(t);
      return els[Math.max(0, Math.min(els.length - 1, (i < 0 ? 0 : i) + d))];
    };
    if (code === 'Tab') {
      const z = this.zones();
      if (!z.length) return true;
      const i = z.findIndex((x) => x.box.contains(t));
      const to = z[i < 0 ? 0 : (i + (shift ? -1 : 1) + z.length) % z.length].to;
      to.focus();
      to.scrollIntoView({ block: 'nearest' });
      return true;
    }
    const d = t.dataset;
    if (d.tab) {
      const tabs = [...this.tabsEl.querySelectorAll<HTMLElement>('[data-tab]')];
      if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Home' || code === 'End') {
        const to = code === 'Home' ? tabs[0] : code === 'End' ? tabs[tabs.length - 1] : step(tabs, code === 'ArrowLeft' ? -1 : 1);
        this.setTab(to.dataset.tab as CompTab, true);
        return true;
      }
      if (code === 'ArrowDown' || code === 'Enter' || code === 'Space') { this.list.querySelector<HTMLElement>('.hp-pick,.hp-fold')?.focus(); return true; }
      return false;
    }
    const group = t.closest<HTMLElement>('[data-group]');
    if (group) {
      const els = [...group.querySelectorAll<HTMLElement>('button')];
      if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'ArrowUp' || code === 'ArrowDown') {
        const to = step(els, code === 'ArrowLeft' || code === 'ArrowUp' ? -1 : 1);
        to.click();
        this.root.querySelector<HTMLElement>(`[data-key="${CSS.escape(to.dataset.key ?? '')}"]`)?.focus();
        return true;
      }
      if (code === 'Enter' || code === 'Space') { t.click(); t.focus(); return true; }
      return false;
    }
    if (this.list.contains(t)) {
      const stops = [...this.list.querySelectorAll<HTMLElement>('.hp-pick,.hp-fold')];
      const at = t.classList.contains('hp-x') ? t.parentElement!.querySelector<HTMLElement>('.hp-pick')! : t;
      if (code === 'ArrowDown' || code === 'ArrowUp') {
        const i = stops.indexOf(at);
        if (code === 'ArrowUp' && i <= 0) { this.focusTabs(); return true; }
        stops[Math.min(stops.length - 1, i + (code === 'ArrowUp' ? -1 : 1))]?.focus();
        stops[Math.min(stops.length - 1, i + (code === 'ArrowUp' ? -1 : 1))]?.scrollIntoView({ block: 'nearest' });
        return true;
      }
      if (code === 'Home' || code === 'End') { stops[code === 'Home' ? 0 : stops.length - 1]?.focus(); return true; }
      const row = at.closest<HTMLElement>('[data-row]')?.dataset.row;
      if (code === 'ArrowRight' || code === 'ArrowLeft') {
        // (the Locked heading: right opens it, left folds it)
        if (!row) {
          if (t.dataset.fold !== undefined && this.lockedOpen !== (code === 'ArrowRight')) { this.lockedOpen = !this.lockedOpen; this.render(); }
          return true;
        }
        const open = this.openRows.has(row);
        if (code === 'ArrowRight' && !open) this.openRows.add(row);
        else if (code === 'ArrowLeft' && open) this.openRows.delete(row);
        else return true;
        this.render();
        return true;
      }
      if (code === 'Enter' || code === 'Space') {
        if (t.dataset.fold !== undefined) { this.lockedOpen = !this.lockedOpen; this.render(); }
        else if (t.dataset.more) { if (this.openRows.has(t.dataset.more)) this.openRows.delete(t.dataset.more); else this.openRows.add(t.dataset.more); this.render(); }
        else if (t.dataset.pick) this.pickRow(t.dataset.pick);
        return true;
      }
    }
    return false;
  }
}

/** A shape's outline as a small inline SVG, turned and mirrored as the part in hand is */
export function pieceIcon(catalog: Catalog, id: string, rot: Rot, flip: boolean, px = 24): string {
  const v = getVariant(catalog, id, rot, flip);
  const xs = v.polygon.map((p) => p[0]), ys = v.polygon.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const size = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
  const pts = v.polygon.map(([x, y]) => `${(((x - minX) / size) * 26 + 2).toFixed(1)},${(((y - minY) / size) * 26 + 2).toFixed(1)}`).join(' ');
  return `<svg width="${px}" height="${px}" viewBox="0 0 30 30" aria-hidden="true"><polygon points="${pts}" fill="#24406b" stroke="#9fb3d1" stroke-width="1"/></svg>`;
}
