/**
 * Hangar grid editor (at a station). Each hangar slot holds a design: the
 * ship you fly, or one you're building. Place any part you know how to make,
 * whether you have it or not: parts you don't have yet are ghosts, and the
 * build panel makes them (instant ones on the spot, the rest queued). Parts
 * fit themselves as they arrive.
 *
 * Hover a part (on the grid or in the palette) for what it is and does.
 *
 * Each ship's ammunition loadout is set here too (the AMMUNITION panel): how
 * many of each crate its guns carry, and which they open first. Docking,
 * launching and flying it top the hold up to that from storage.
 *
 * Power runs along wires (common/src/ships/wires.ts): the Wires tool (W)
 * lays them by dragging across cells, erases them with a right-drag (or its
 * Erase mode), and lays the lot afresh (Auto-wire). A design nobody's wired
 * by hand is auto-wired, free, until it's edited; one wired by hand pays its
 * new segments in wire spools as it's saved. The power overlay shows each
 * network in its own colour, and what's left without power.
 *
 * The palette leads with the parts you have (storage and hold, and what this
 * slot already carries), by category; then what you can fabricate here; then
 * what's locked and why (its level), folded away. A weapon's mount
 * is its model's (a badge, not a choice), and so are its mounting rules
 * (common ships/mounting.ts): the part in hand shows the edge it bolts on at,
 * the cells its barrel needs clear and its turret arc, and won't place where it
 * breaks one; guns on a saved ship that break one are marked red. On a dev
 * server an admin can switch on free build (the admin panel): any part places
 * (rules still apply), and saving takes nothing.
 *
 * Click: place · middle-click: pick a placed part up · middle-drag: pan · R: rotate · F: mirror (flips a side mount) · T: cycle facing · right-click: remove
 * W: wires tool · E: draw / erase wires · Wheel: zoom · arrow keys: pan · Esc / H: close
 */

import {
  Blueprint, Catalog, Economy, Bag, partItemId, isWeaponFn, PlacedPart, PlacedGeom, Rot, Side, ShipTuning, ShipDerived, Vec2,
  SIDES, SIDE_NORMAL, placeGeometry, overlapsAny, computeJoins, facingEdges, isEdgeFree, geomContainsPoint,
  validateBlueprint, nextFreeUid, floodFill, partNeedsFacing, createShipState, connectorEndpoints, getVariant,
  BlueprintError, TurretWindow, computeTurretWindow, ClientMessage, ServerHangarMessage, partDemand, parsePartItemId,
  isStructural, ghostBill, SALVAGE, ShipState, buildPoints, DAMAGE_NAMES, type DamageType,
  loadoutKinds, cratesFor, crateOrder, MAX_LOADOUT_CRATES, autoWire, wireCells, cellKey, cellOf, WIRE_ITEM, SEGMENTS_PER_SPOOL,
  type FunctionDef, type WireSeg, mountingOf, weaponSides, clearCells, partMountingProblems, type MountingProblem } from '@space-game/common';
import { cargoEffect, CATEGORY_MASS, strafeForce, bestDodge, burstEnergy, DODGE_FORWARD, DODGE_BACK, DODGE_LEFT, DODGE_RIGHT } from '@space-game/common';
import { loadTest, BROWNOUT, type LoadTestResult } from '@space-game/common';
import { settings } from '../settings/Settings';
import { boundKeyName } from '../input/keybindings';
import { costHtml } from '../ui/windowKit';
import { CONNECTOR_COLOR, functionColor, numToCss } from './shipColors';
import { cellAt, circuitColor, SURGE_COLOR, eraseRun, layRun, powerReport, pruneWires, stepCells, wireBill, DEAD_NET, type Cell, type PowerReport } from './wireEdit';

/** The hangar's load test: this many seconds of the ship's power, from full (energy.ts loadTest) */
const LOAD_TEST_SECONDS = 4;
import { familyLabel, familyRank, keyStats, modelLock, mountBadge, mountingText, MOUNT_TEXT, sizeText, sizeWord, weaponMount, type ModelLock } from './modelCards';
import { gradeGlow, partColors } from './hullPreview2d';
import { HangarLitView } from './HangarLitView';
import { listBlueprints, loadBlueprint, saveBlueprint } from './blueprintApi';
import { itemIcon, shipIcon } from '../ui/itemIcons';
import { shipSummary, designFields, ShipSummary, BIGGER_IS_BETTER, jumpRatioNote } from './shipSummary';
import { drawDecor2d } from './partDecor';
import { partTipHtml, PART_TIP_CSS, type PartTipCtx } from './partTip';


export interface HangarDeps {
  catalog: Catalog;
  tuning: ShipTuning;
  econ: Economy;
  /** Parts the pilot has for a slot: storage and the hold's modules, plus that slot's built parts (part item id → count) */
  owned(slot: number): Bag;
  /** Hangar slots and jobs, as the server last sent them */
  hangarState(): ServerHangarMessage | null;
  /** Can the pilot fabricate this item (licences) */
  canMake(id: string): boolean;
  /** The pilot's level (what a locked model waits on) */
  level?(): number;
  /** Cargo + storage count of an item */
  have(id: string): number;
  /** Mass of what's in the hold now (common/src/ships/load.ts) */
  cargoMass?(): number;
  /** Station storage's count of an item (what a save pays from: wire spools) */
  stored?(id: string): number;
  /** Parts on their way from the fabricator */
  coming(): Bag;
  send(m: ClientMessage): void;
  /** Ship plans the pilot knows (blueprint file names) */
  knownPlans(): string[];
  /** Designs party members sent you (newest first) */
  sharedDesigns?(): { from: string; blueprint: Blueprint }[];
  /** Proto/admin: every part is free */
  grantAll: boolean;
  /** The blueprint the player is flying now */
  getBlueprint(): Blueprint;
  /** The ship you're flying (its parts' HP now) */
  liveShip?(): ShipState | undefined;
  onOpen(): void;
  /** `launch` is the saved blueprint to respawn with, or null when closed without saving */
  onClose(launch: Blueprint | null): void;
}

type Overlay = 'connectors' | 'joins' | 'power' | 'com' | 'thrust' | 'arcs';
const DEFAULT_FACING: Record<string, Side> = { thruster: 'S', weapon: 'N', miner: 'N' };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** What a save would change: the parts, the paint, the wiring (absent: auto-wired) */
const designSig = (bp: Blueprint) => JSON.stringify(bp.parts) + (bp.paint ?? '') + (bp.wires ? JSON.stringify(bp.wires) : '~');

export class HangarUI {
  isOpen = false;

  private bp!: Blueprint;
  private geoms: PlacedGeom[] = [];
  private derived: ShipDerived | null = null;
  /** The grid layer (under the ship), and the ship lit and drawn as in flight (between it and the marks) */
  private grid!: HTMLCanvasElement;
  private lit: HangarLitView;
  private errors: BlueprintError[] = [];
  private sel = { piece: 'sq', fn: 'hull', material: 'alloy', rot: 0 as Rot, flip: false, facing: 'auto' as Side | 'auto' };
  /** Placed guns breaking their mounting rules, by part index (refresh) */
  private mountingBroken = new Map<number, MountingProblem[]>();
  /** The palette's category filter ('all', or a functions.json `category`; the core counts as structure) */
  private cat = 'all';
  /** Folded palette sections (locked parts, and with free build on; overlays) */
  private folded = { locked: true, lockedFree: false, overlays: true };
  /** Each model's palette line (its size and key numbers), worked out once */
  private lines = new Map<string, { size: string; stats: string }>();
  private view = { cx: 1, cy: 1, px: 40 };
  /** A middle-button drag in progress: where it started (screen, view, grid), and whether it's moved enough to be a pan */
  private pan: { x: number; y: number; cx: number; cy: number; at: Vec2; moved: boolean } | null = null;
  private mouse: Vec2 | null = null;
  private overlays: Record<Overlay, boolean> = { connectors: false, joins: false, power: true, com: true, thrust: true, arcs: true };
  /** Placing parts, or laying wires (and whether a left-drag erases them) */
  private tool: 'parts' | 'wires' = 'parts';
  private wireErase = false;
  /** A wire drag in progress: erasing or laying, and the cell it last reached */
  private wireDrag: { erase: boolean; last: Cell } | null = null;
  /** The power overlay's networks and warnings (from the design's derived state) */
  private power: PowerReport | null = null;
  /** The last load test (local circuits): which, on which design (it's dropped once the design changes), and what it found */
  private loadRun: { kind: string; sig: string; result: LoadTestResult } | null = null;
  private grantAll = false;
  private owned: Bag = {};
  /** The slot being edited, the plan it was loaded from, and what was last saved (to spot unsaved edits) */
  private slot = 0;
  private plan: string | undefined;
  private savedSig = '';
  private slotBar!: HTMLDivElement;
  /** Saved designs: the panel, whether it's open, a save or delete waiting on its confirm, and what the list was built from */
  private designBtn: HTMLButtonElement;
  private designPanel: HTMLDivElement;
  private designsOpen = false;
  private designAsk: { slot: number; kind: 'save' | 'delete' } | null = null;
  private designSig = '';
  /** The dev server's blueprint file API answered (Vite dev only) */
  private devApi = false;

  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private palette: HTMLDivElement;
  private stats: HTMLDivElement;
  private nameInput: HTMLInputElement;
  private paintInput: HTMLInputElement;
  private loadSelect: HTMLSelectElement;
  private statusEl: HTMLSpanElement;
  private freeTag: HTMLSpanElement;
  /** Part tooltip, and what it shows (rebuilt only when that changes) */
  private tip: HTMLDivElement;
  private tipKey = '';
  /** Bumped whenever the design or hangar state changes (stale tooltips rebuild) */
  private tipGen = 0;

  constructor(private deps: HangarDeps) {
    this.root = document.createElement('div');
    this.root.style.cssText = `
      position: fixed; inset: 0; z-index: 2000; display: none; grid-template-columns: clamp(320px, 25vw, 420px) minmax(0, 1fr) clamp(290px, 20vw, 360px);
      grid-template-rows: 44px 1fr; background: rgba(6, 9, 18, 0.97); color: #cfd8e6;
      font: 12px 'Segoe UI', system-ui, sans-serif; user-select: none;`;

    const bar = document.createElement('div');
    bar.style.cssText = 'grid-column: 1 / 4; display: flex; gap: 6px; align-items: center; padding: 0 10px; border-bottom: 1px solid #1f2a40; overflow: hidden; min-width: 0;';
    bar.innerHTML = `<b style="color:#ffb547; letter-spacing: 1px; margin-right:4px">HANGAR</b>`;
    // Free build (a dev server's admin panel): says so while it's on
    this.freeTag = document.createElement('span');
    this.freeTag.textContent = 'FREE BUILD';
    this.freeTag.title = 'Dev server: any part places, owned or not, licensed or not, and saving takes nothing (switch it off in the admin panel, F2)';
    this.freeTag.style.cssText = 'display:none; flex-shrink:0; font:700 10px "Segoe UI",sans-serif; letter-spacing:1px; color:#1a1206; background:#fbbf24; border-radius:4px; padding:3px 6px; margin-right:4px;';
    bar.append(this.freeTag);
    this.nameInput = document.createElement('input');
    this.nameInput.placeholder = 'Ship name';
    this.nameInput.title = 'The design\'s name';
    this.nameInput.style.cssText = 'background:#0f1626; color:#e5ecf7; border:1px solid #2a3a5a; border-radius:4px; padding:4px 8px; width:130px; min-width:70px;';
    this.nameInput.addEventListener('input', () => { this.bp.name = this.nameInput.value; });
    this.nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    // Hull paint: tints hull and armour (blank: the material's own colour)
    this.paintInput = document.createElement('input');
    this.paintInput.type = 'color';
    this.paintInput.title = 'Hull paint (saved with the design; everyone sees it)';
    this.paintInput.style.cssText = 'width:30px; height:26px; padding:0; border:1px solid #2a3a5a; border-radius:4px; background:#0f1626; cursor:pointer;';
    this.paintInput.addEventListener('input', () => { this.bp.paint = this.paintInput.value; this.draw(); this.renderStats(); });
    this.loadSelect = document.createElement('select');
    this.loadSelect.title = 'Load a plan or design into this slot (Save to keep it)';
    this.loadSelect.style.cssText = 'background:#0f1626; color:#e5ecf7; border:1px solid #2a3a5a; border-radius:4px; padding:3px; width:130px;';
    this.loadSelect.addEventListener('change', () => this.loadSelected());
    this.statusEl = document.createElement('span');
    this.statusEl.style.cssText = 'margin-left:auto; color:#8ea0bd; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;';
    this.slotBar = document.createElement('div');
    // (the slots give way first when the bar's tight: their names shorten)
    this.slotBar.style.cssText = 'display:flex; gap:3px; margin-right:4px; flex-shrink:1; min-width:0; overflow:hidden;';
    const unpaint = button('×', () => { delete this.bp.paint; this.paintInput.value = '#24324d'; this.draw(); this.renderStats(); });
    unpaint.title = 'No paint: the material\'s own colour';
    unpaint.style.padding = '5px 7px';
    this.designBtn = button('Designs ▾', () => this.toggleDesigns());
    this.designBtn.title = 'Your saved designs: keep this one for later, or load one';
    const save = button('Save', () => this.saveAndLaunch(), '#2f6f4f');
    save.title = 'Save to this hangar slot: what you have goes in, the rest become ghosts to build';
    bar.append(
      this.slotBar,
      this.nameInput, this.paintInput, unpaint,
      this.loadSelect,
      button('New', () => this.newBlueprint()),
      this.designBtn,
      save,
      button('Share', () => { this.deps.send({ type: 'shareDesign', blueprint: clone(this.bp) }); this.status('sent to your party'); }),
      button('Close', () => this.close(null)),
      this.statusEl,
    );
    // (buttons keep their one line; the slots and the status give way)
    for (const b of bar.querySelectorAll<HTMLElement>(':scope > button')) { b.style.whiteSpace = 'nowrap'; b.style.flexShrink = '0'; }
    // Saved designs: a panel under the bar
    this.designPanel = document.createElement('div');
    this.designPanel.style.cssText = `position:absolute; top:44px; z-index:5; width:400px; max-height:calc(100vh - 70px); overflow-y:auto; display:none;
      background:#0b1220; border:1px solid #2a3a5a; border-radius:0 0 10px 10px; box-shadow:0 14px 40px rgba(0,0,0,0.6); padding:10px; font:12px 'Segoe UI', sans-serif;`;
    this.designPanel.addEventListener('mousedown', (e) => e.stopPropagation());

    this.palette = document.createElement('div');
    // (a dark thin scrollbar, its gutter kept so the rows don't jump as it comes and goes)
    this.palette.style.cssText = 'overflow-y: auto; min-width: 0; padding: 10px; border-right: 1px solid #1f2a40; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: #2a3a5a transparent; color-scheme: dark;';
    // Parts in the lists (rows, plates, materials, shapes) carry their item id: a click picks it up, hovering shows what it is
    this.palette.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-part]')?.dataset.part;
      if (id) this.pickPart(id);
    });
    this.palette.addEventListener('mousemove', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-part]');
      if (el) this.partTip(el.dataset.part!, e); else if (this.tipKey.startsWith('p:')) this.hideTip();
    });
    this.palette.addEventListener('mouseleave', () => this.hideTip());
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width: 100%; height: 100%; display: block; cursor: crosshair;';
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'position: relative; overflow: hidden;';
    // Layers: the grid (and turret arcs) under, the ship lit as in flight (WebGL), the editor's marks over (and the mouse)
    this.grid = document.createElement('canvas');
    this.grid.style.cssText = 'position:absolute; left:0; top:0; width:100%; height:100%; display:block; pointer-events:none;';
    this.canvas.style.cssText += 'position:relative;';
    canvasWrap.append(this.grid, this.canvas);
    this.lit = new HangarLitView(this.canvas, this.deps.catalog, this.deps.tuning.cellSize);
    this.stats = document.createElement('div');
    this.stats.style.cssText = 'overflow-y: auto; min-width: 0; padding: 10px; border-left: 1px solid #1f2a40; font-family: "Segoe UI", system-ui, sans-serif; font-size: 12px; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: #2a3a5a transparent; color-scheme: dark; overflow-wrap: break-word;';
    this.root.append(bar, this.palette, canvasWrap, this.stats, this.designPanel);
    this.root.addEventListener('mousedown', (e) => { if (this.designsOpen && e.target !== this.designBtn) this.toggleDesigns(false); });
    document.body.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    this.tip = document.createElement('div');
    this.tip.style.cssText = PART_TIP_CSS;
    document.body.appendChild(this.tip);

    this.canvas.addEventListener('mousemove', (e) => {
      // Middle-dragging pans the view (a middle click with no drag still picks a part up)
      const pan = this.pan;
      if (pan) {
        const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
        if (!pan.moved && Math.hypot(dx, dy) > 4) { pan.moved = true; this.canvas.style.cursor = 'grabbing'; this.hideTip(); }
        if (pan.moved) { this.view.cx = pan.cx - dx / this.view.px; this.view.cy = pan.cy - dy / this.view.px; this.draw(); return; }
      }
      this.mouse = this.toGrid(e);
      if (this.wireDrag) { this.wireTo(cellAt(this.mouse[0], this.mouse[1])); return; }
      // (no part tooltips over the wires: they'd hide what's being wired)
      this.draw();
      if (this.tool === 'parts') this.gridTip(e);
    });
    window.addEventListener('mouseup', (e) => {
      if (this.wireDrag && e.button !== 1) { this.wireDrag = null; this.refresh(); return; }
      if (e.button !== 1 || !this.pan) return;
      const pan = this.pan;
      this.pan = null;
      this.canvas.style.cursor = 'crosshair';
      if (!pan.moved) this.pickUp(pan.at);
    });
    this.canvas.addEventListener('mouseleave', () => { this.mouse = null; this.draw(); this.hideTip(); });
    this.canvas.addEventListener('mousedown', (e) => {
      const g = this.toGrid(e);
      // The wires tool: a left-drag lays (or, in Erase mode, erases), a right-drag erases
      if (this.tool === 'wires' && (e.button === 0 || e.button === 2)) { this.wireStart(cellAt(g[0], g[1]), e.button === 2 || this.wireErase); return; }
      if (e.button === 0) this.place(g);
      if (e.button === 1) { e.preventDefault(); this.pan = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy, at: g, moved: false }; }
      if (e.button === 2) this.remove(g);
    });
    // (Middle-click picks a part up, middle-drag pans: no autoscroll, no paste)
    this.canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.view.px = Math.max(12, Math.min(96, this.view.px * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      this.draw();
    }, { passive: false });
    window.addEventListener('resize', () => this.isOpen && this.draw());
  }

  // -------------------------------------------------------------------------
  // Open / close
  // -------------------------------------------------------------------------

  toggle(): void {
    if (this.isOpen) this.close(null); else this.open();
  }

  open(slot?: number): void {
    const hs = this.deps.hangarState();
    this.slot = slot ?? hs?.active ?? 0;
    this.loadSlot();
    this.status('');
    this.grantAll = this.deps.grantAll;
    this.isOpen = true;
    this.root.style.display = 'grid';
    this.lit.setOpen(true);
    this.recenter();
    this.refresh();
    this.refreshLoadList();
    this.deps.onOpen();
  }

  /** Edit what's saved in the current slot (an empty slot starts with a core) */
  private loadSlot(): void {
    const hs = this.deps.hangarState();
    const rec = hs?.slots[this.slot];
    if (rec) {
      this.bp = clone(rec.blueprint);
      this.plan = rec.plan;
    } else if (hs && this.slot === hs.active) {
      this.bp = clone(this.deps.getBlueprint());
      this.plan = undefined;
    } else {
      this.bp = { name: 'New ship', catalogVersion: this.deps.catalog.version, parts: [
        { uid: 0, piece: 'sq', fn: 'core', material: 'alloy', x: 0, y: 0, rot: 0, flip: false },
      ] };
      this.plan = undefined;
    }
    this.savedSig = rec ? designSig(rec.blueprint) : '';
  }

  private get unsaved(): boolean {
    return designSig(this.bp) !== this.savedSig;
  }

  /** The server sent new hangar state (a save, parts fitted, a job finished) */
  onHangarUpdate(): void {
    if (!this.isOpen) return;
    const rec = this.deps.hangarState()?.slots[this.slot];
    // Saved just now (or untouched): follow the server's copy
    if (rec && (designSig(rec.blueprint) === designSig(this.bp) || !this.unsaved)) {
      this.bp = clone(rec.blueprint);
      this.savedSig = designSig(rec.blueprint);
    }
    this.refresh();
    // Designs saved or deleted
    if (this.designKey() !== this.designSig) {
      void this.refreshLoadList();
      if (this.designsOpen && !this.designAsk) this.renderDesigns();
    }
  }

  private switchSlot(slot: number): void {
    if (slot === this.slot) return;
    if (this.unsaved && !confirm('Discard your unsaved changes to this design?')) return;
    this.slot = slot;
    this.loadSlot();
    this.recenter();
    this.refresh();
  }

  close(launch: Blueprint | null): void {
    this.isOpen = false;
    this.hideTip();
    this.toggleDesigns(false);
    this.root.style.display = 'none';
    this.lit.setOpen(false);
    this.deps.onClose(launch);
  }

  /** Keys while open. Returns true when consumed (always, so flight controls don't react). */
  handleKey(code: string): boolean {
    if (!this.isOpen) return false;
    if (code === 'KeyR') this.sel.rot = ((this.sel.rot + 1) % 4) as Rot;
    else if (code === 'KeyF') this.sel.flip = !this.sel.flip;
    else if (code === 'KeyT') {
      const order: (Side | 'auto')[] = ['auto', ...SIDES];
      this.sel.facing = order[(order.indexOf(this.sel.facing) + 1) % order.length];
    } else if (code === 'KeyW') this.setTool(this.tool === 'wires' ? 'parts' : 'wires');
    else if (code === 'KeyE' && this.tool === 'wires') this.wireErase = !this.wireErase;
    else if(code === 'Escape' || code === 'KeyH') { this.close(null); return true; }
    else if (code === 'ArrowLeft') this.view.cx -= 1;
    else if (code === 'ArrowRight') this.view.cx += 1;
    else if (code === 'ArrowUp') this.view.cy -= 1;
    else if (code === 'ArrowDown') this.view.cy += 1;
    this.renderPalette();
    this.draw();
    return true;
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  private candidate(g: Vec2): PlacedPart | null {
    const uid = nextFreeUid(this.bp);
    if (uid < 0) return null;
    // (A model is always made of its own material)
    const fd = this.deps.catalog.functions.get(this.sel.fn);
    const p: PlacedPart = {
      uid, piece: this.sel.piece, fn: this.sel.fn, material: fd?.model && fd.material ? fd.material : this.sel.material,
      x: Math.floor(g[0]), y: Math.floor(g[1]), rot: this.sel.rot, flip: this.sel.flip,
    };
    if (partNeedsFacing(p.fn)) p.facing = this.pickFacing(p);
    return p;
  }

  /** Explicit facing, or the first side with a free straight edge (preferring the function's usual side). */
  private pickFacing(p: PlacedPart): Side {
    if (this.sel.facing !== 'auto') return this.sel.facing;
    const g = placeGeometry(this.deps.catalog, p);
    const all = [...this.geoms, g];
    const pref = DEFAULT_FACING[p.fn] ?? 'N';
    const order = [pref, ...SIDES.filter((s) => s !== pref)];
    const free = (side: Side) => {
      const edges = facingEdges(g, side);
      return edges.length > 0 && edges.every((e) => isEdgeFree(all, all.length - 1, e, side));
    };
    // A weapon with mounting rules: the first side it fires out of that keeps them all (bolted on where it must be,
    // its barrel clear), else the first free one, so the preview shows what's wrong
    if (mountingOf(this.deps.catalog, p.fn)?.rules) {
      for (const side of order) {
        if (!free(side)) continue;
        const q = { ...p, facing: side };
        if (!partMountingProblems(this.deps.catalog, [...this.geoms, placeGeometry(this.deps.catalog, q)], all.length - 1).length) return side;
      }
    }
    for (const side of order) if (free(side)) return side;
    return pref;
  }

  /** Why a candidate can't go here, or null if it can. */
  private placementProblem(p: PlacedPart): string | null {
    const fn = this.deps.catalog.functions.get(p.fn)!;
    if (fn.pieces !== '*' && !fn.pieces.includes(p.piece)) return `${p.fn} can't go on ${p.piece}`;
    const id = partItemId(p);
    // (One you have still needs its licence to fit, as the server checks; free build needs neither)
    if (!this.free && !this.deps.canMake(id)) {
      const lock = fn.model ? modelLock(fn, false, this.deps.level?.() ?? 1, this.deps.econ.items.all()).why : '';
      return `${this.remaining(id) > 0 ? "you aren't licensed to fit" : "you can't make"} ${this.deps.econ.items.name(id)} yet${lock ? `: ${lock.charAt(0).toLowerCase()}${lock.slice(1)}` : ''}`;
    }
    const g = placeGeometry(this.deps.catalog, p);
    if (overlapsAny(g, this.geoms)) return 'overlaps another part';
    // It must point out of a free straight edge (T or the Facing buttons pick another side)
    if (p.facing) {
      const all = [...this.geoms, g], edges = facingEdges(g, p.facing as Side);
      if (!edges.length) return `no straight edge facing ${p.facing} on this piece: press T for another side`;
      if (!edges.every((e) => isEdgeFree(all, all.length - 1, e, p.facing as Side))) return `its ${p.facing} edge is blocked: press T for another side`;
    }
    if (this.geoms.length && computeJoins([...this.geoms, g]).every(([a, b]) => b !== this.geoms.length && a !== this.geoms.length)) {
      return "doesn't join anything";
    }
    // Its mounting rules (always: free build skips ownership, never these)
    const broken = this.candidateMounting(p, g);
    if (broken.length) return broken.map((m) => ruleText(m)).join('; ');
    return null;
  }

  /** The mounting rules a part in hand would break where it is (common partMountingProblems) */
  private candidateMounting(p: PlacedPart, g = placeGeometry(this.deps.catalog, p)): MountingProblem[] {
    return this.geoms.length ? partMountingProblems(this.deps.catalog, [...this.geoms, g], this.geoms.length) : [];
  }

  /** The hand card's mount line: its rules in words, and for a side mount which side it's on and how to swap it */
  private mountLine(f: FunctionDef): string {
    const words = mountingText(this.deps.catalog, { fn: f.id }, this.deps.tuning);
    const m = mountingOf(this.deps.catalog, f.id);
    const side = m?.angle === 'right' ? ` <span style="color:#7dd3fc">(${this.sel.flip ? 'mirrored' : 'as drawn'} · F flips)</span>` : '';
    return `<div style="font-size:11px; margin-top:4px; color:#8ea0bd">Mount: <b style="color:#e5ecf7; font-weight:600">${esc(words.join(' · ') || MOUNT_TEXT[weaponMount(this.deps.catalog, { fn: f.id })])}</b>${side}</div>`;
  }

  private place(g: Vec2): void {
    const p = this.candidate(g);
    if (!p) return this.status('blueprint is full (255 parts)');
    const problem = this.placementProblem(p);
    if (problem) return this.status(problem);
    this.bp.parts.push(p);
    this.refresh();
  }

  private partAt(g: Vec2): number {
    for (let i = this.geoms.length - 1; i >= 0; i--) if (geomContainsPoint(this.geoms[i], g[0], g[1])) return i;
    return -1;
  }

  /** Middle-click: put the part under the cursor in hand, exactly as it's placed (piece, function, material, turn, mirror, facing) */
  private pickUp(g: Vec2): void {
    const i = this.partAt(g);
    if (i < 0) return;
    const p = this.bp.parts[i];
    this.sel = { piece: p.piece, fn: p.fn, material: p.material, rot: p.rot, flip: p.flip, facing: p.facing ? (p.facing as Side) : 'auto' };
    if (this.cat !== 'all') this.cat = filterCat(this.deps.catalog, p.fn);
    this.status(`picked up: ${this.deps.econ.items.name(partItemId(p))}`);
    this.renderPalette();
    this.draw();
  }

  private remove(g: Vec2): void {
    const i = this.partAt(g);
    if (i < 0) return;
    const removed = new Set([i]);
    const core = this.bp.parts.findIndex((p) => p.fn === 'core');
    if (core >= 0 && core !== i) {
      const joins = computeJoins(this.geoms);
      const reached = floodFill(this.geoms.length, joins, core, (k) => k !== i);
      const cut = this.bp.parts.map((_, k) => k).filter((k) => k !== i && !reached[k]);
      if (cut.length) {
        if (!confirm(`Removing this part also cuts ${cut.length} part(s) off from the core. Remove them too?`)) return;
        cut.forEach((k) => removed.add(k));
      }
    }
    this.bp.parts = this.bp.parts.filter((_, k) => !removed.has(k));
    // (wire laid over what's gone goes with it)
    if (this.bp.wires) this.bp.wires = pruneWires(this.bp.wires, this.onHull());
    this.refresh();
  }

  // -------------------------------------------------------------------------
  // Wires
  // -------------------------------------------------------------------------

  private setTool(tool: 'parts' | 'wires'): void {
    this.tool = tool;
    this.wireDrag = null;
    this.canvas.style.cursor = tool === 'wires' ? 'cell' : 'crosshair';
    this.hideTip();
    this.renderPalette();
    this.draw();
  }

  /** Is a cell under one of the design's parts (where a wire can run) */
  private onHull(): (x: number, y: number) => boolean {
    const cells = wireCells(this.deps.catalog, this.bp, this.bp.parts.map((p) => placeGeometry(this.deps.catalog, p)));
    return (x, y) => cells.has(cellKey(x, y));
  }

  /** The design's wires to edit by hand: an auto-wired one starts from what Auto-wire lays */
  private handWires(): WireSeg[] {
    if (!this.bp.wires) this.bp.wires = autoWire(this.bp, this.deps.catalog).map((w) => [...w] as WireSeg);
    return this.bp.wires;
  }

  private wireStart(cell: Cell, erase: boolean): void {
    const wires = this.handWires();
    if (erase) this.bp.wires = eraseRun(wires, [cell]);
    this.wireDrag = { erase, last: cell };
    this.wiresChanged();
  }

  /** The drag reached another cell: lay (or erase) the run there from the last */
  private wireTo(cell: Cell): void {
    const drag = this.wireDrag!;
    if (cell[0] === drag.last[0] && cell[1] === drag.last[1]) return;
    const run = stepCells(drag.last, cell), wires = this.handWires();
    this.bp.wires = drag.erase ? eraseRun(wires, run) : layRun(wires, run, this.onHull());
    drag.last = cell;
    this.wiresChanged();
  }

  /** Mid-drag: the power overlay follows (the panels catch up on release) */
  private wiresChanged(): void {
    this.rederive();
    this.draw();
  }

  private autoWireAll(): void {
    this.bp.wires = autoWire(this.bp, this.deps.catalog).map((w) => [...w] as WireSeg);
    this.status(`auto-wired: ${this.bp.wires.length} segments from the generators to everything that uses power`);
    this.refresh();
  }

  private clearWires(): void {
    this.bp.wires = [];
    this.status('wires cleared: only what touches a generator has power');
    this.refresh();
  }

  /** Back to auto-wiring (free: the wires follow the parts) */
  private unwire(): void {
    delete this.bp.wires;
    this.status('auto-wired again: the wires follow your parts, free');
    this.refresh();
  }

  private newBlueprint(): void {
    this.bp = { name: 'New ship', catalogVersion: this.deps.catalog.version, parts: [
      { uid: 0, piece: 'sq', fn: 'core', material: 'alloy', x: 0, y: 0, rot: 0, flip: false },
    ] };
    this.plan = undefined;
    this.recenter();
    this.refresh();
  }

  /** Plans the pilot can load (all of them when everything is free), smallest first */
  private plans(): { file: string; bp: Blueprint }[] {
    const known = new Set(this.deps.knownPlans());
    return Object.entries(this.deps.econ.plans)
      .filter(([file]) => this.free || known.has(file))
      .map(([file, bp]) => ({ file, bp }))
      .sort((a, b) => a.bp.parts.length - b.bp.parts.length);
  }

  /** Design slots, as the server last sent them (null: empty) */
  private designs(): (Blueprint | null)[] {
    return this.deps.hangarState()?.designs ?? [];
  }

  private async refreshLoadList(): Promise<void> {
    const presets = this.plans().map((p) => `<option value="preset:${p.file}">${esc(p.bp.name)} · ${p.bp.parts.length} parts</option>`).join('');
    let html = `<option value="">Load a plan…</option><option value="current">Current ship</option><optgroup label="Your ship plans">${presets}</optgroup>`;
    const designs = this.designs().map((bp, i) => (bp ? `<option value="design:${i}">D${i + 1} · ${esc(bp.name)} · ${bp.parts.length} parts</option>` : '')).join('');
    if (designs) html += `<optgroup label="Your designs">${designs}</optgroup>`;
    this.designSig = this.designKey();
    const shared = this.deps.sharedDesigns?.() ?? [];
    if (shared.length) html += `<optgroup label="Shared with you">${shared.map((d, i) => `<option value="shared:${i}">${esc(d.blueprint.name)} · from ${esc(d.from)} · ${d.blueprint.parts.length} parts</option>`).join('')}</optgroup>`;
    this.loadSelect.innerHTML = html;
    try {
      const names = await listBlueprints();
      this.devApi = true;
      html += `<optgroup label="Saved designs (dev)">${names.map((n) => `<option value="file:${n}">${n}</option>`).join('')}</optgroup>`;
      this.loadSelect.innerHTML = html;
    } catch {
      // No dev file API (production build): the pre-made ships are still there
    }
  }

  private async loadSelected(): Promise<void> {
    const value = this.loadSelect.value;
    if (!value) return;
    const [kind, file] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
    try {
      if (value === 'current') {
        this.bp = clone(this.deps.getBlueprint());
      } else if (kind === 'shared') {
        // A party member's design: parts you can't make yet show as problems, the rest become ghosts when you save
        const d = (this.deps.sharedDesigns?.() ?? [])[Number(file)];
        if (!d) return;
        this.bp = clone(d.blueprint);
        this.plan = undefined;
      } else if (kind === 'design') {
        const d = this.designs()[Number(file)];
        if (!d) return;
        this.bp = clone(d);
        this.plan = undefined;
      } else {
        const preset = kind === 'preset' ? this.plans().find((p) => p.file === file) : undefined;
        this.bp = preset ? clone(preset.bp) : await loadBlueprint(file);
        this.plan = preset?.file;
      }
      this.recenter();
      this.refresh();
      this.status(`loaded ${this.bp.name}`);
    } catch (e) {
      this.status(String(e));
    }
    this.loadSelect.value = '';
  }

  // -------------------------------------------------------------------------
  // Saved designs (blueprints kept for later, not ships)
  // -------------------------------------------------------------------------

  private designKey(): string {
    return this.designs().map((d) => (d ? `${d.name}:${d.parts.length}:${JSON.stringify(d.parts).length}` : '-')).join('|');
  }

  private toggleDesigns(open = !this.designsOpen): void {
    this.designsOpen = open;
    this.designAsk = null;
    this.designPanel.style.display = open ? 'block' : 'none';
    this.designBtn.style.borderColor = open ? '#5fd4c4' : '#2a3a5a';
    if (open) {
      this.designPanel.style.left = `${Math.max(8, Math.min(this.designBtn.offsetLeft, innerWidth - 410))}px`;
      this.renderDesigns();
    }
  }

  /** The design slots: save the ship on the grid into one, load one, or empty one (each asks first when it would lose a design) */
  private renderDesigns(): void {
    const el = this.designPanel;
    const designs = this.designs();
    const used = designs.filter(Boolean).length;
    el.innerHTML = `<div style="display:flex; align-items:baseline; gap:8px; margin-bottom:8px"><b style="color:#ffb547; letter-spacing:1px">SAVED DESIGNS</b>`
      + `<span style="color:#6b7a93">${used} / ${designs.length}</span><span style="margin-left:auto; color:#6b7a93; font-size:11px">gems aren't saved with them</span></div>`;
    if (!designs.length) {
      el.insertAdjacentHTML('beforeend', '<div style="color:#6b7a93; padding:6px 0">Saved designs aren\'t available here.</div>');
      return;
    }
    el.insertAdjacentHTML('beforeend', `<div style="color:#8ea0bd; font-size:11px; line-height:1.45; margin-bottom:8px">Keep a design to build later: <b style="color:#cfd8e6">Save here</b> puts the ship on the grid (${esc(this.bp.name)}, ${this.bp.parts.length} parts) in that slot.</div>`);
    designs.forEach((bp, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:6px; border:1px solid #1c2840; margin-bottom:4px; background:#0d1524; min-height:32px;';
      const ask = this.designAsk?.slot === i ? this.designAsk.kind : null;
      const tag = `<span style="color:#6b7a93; width:24px; flex-shrink:0">D${i + 1}</span>`;
      const act = (text: string, fn: () => void, bg = '#1a2540', title = '') => {
        const b = button(text, fn, bg);
        b.style.padding = '3px 8px';
        b.style.fontSize = '11px';
        b.title = title;
        row.appendChild(b);
        return b;
      };
      if (ask) {
        row.style.borderColor = ask === 'delete' ? '#7f1d1d' : '#7c5a12';
        row.innerHTML = `${tag}<span style="flex:1; min-width:0; color:${ask === 'delete' ? '#fca5a5' : '#fcd34d'}">${ask === 'delete' ? `Delete ${esc(bp?.name ?? 'it')}?` : `Replace ${esc(bp?.name ?? 'it')} with ${esc(this.bp.name)}?`}</span>`;
        act(ask === 'delete' ? 'Delete' : 'Replace', () => (ask === 'delete' ? this.deleteDesign(i) : this.saveDesign(i)), ask === 'delete' ? '#6b1f2a' : '#6b4f12');
        act('Cancel', () => { this.designAsk = null; this.renderDesigns(); });
      } else if (bp) {
        row.innerHTML = `${tag}<img src="${shipIcon(this.deps.econ, bp.parts, 28)}" style="width:28px; height:28px; flex-shrink:0">`
          + `<div style="flex:1; min-width:0"><div style="color:#e5ecf7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(bp.name)}</div><div style="color:#6b7a93; font-size:11px">${bp.parts.length} parts</div></div>`;
        act('Load', () => this.loadDesign(i), '#1d3d5c', 'Put it on the grid (Save to build it in this slot)');
        act('Save here', () => { this.designAsk = { slot: i, kind: 'save' }; this.renderDesigns(); }, '#1a2540', 'Replace it with the ship on the grid');
        act('✕', () => { this.designAsk = { slot: i, kind: 'delete' }; this.renderDesigns(); }, '#2a1a22', 'Delete this design');
      } else {
        row.innerHTML = `${tag}<span style="flex:1; color:#4b5870">empty</span>`;
        act('Save here', () => this.saveDesign(i), '#1f4a37', 'Keep the ship on the grid here');
      }
      el.appendChild(row);
    });
  }

  private saveDesign(slot: number): void {
    this.deps.send({ type: 'designSave', slot, blueprint: clone(this.bp) });
    this.designAsk = null;
    this.status(`saved ${this.bp.name} as design D${slot + 1}`);
    this.renderDesigns();
  }

  private deleteDesign(slot: number): void {
    this.deps.send({ type: 'designDelete', slot });
    this.designAsk = null;
    this.status(`design D${slot + 1} deleted`);
    this.renderDesigns();
  }

  private loadDesign(slot: number): void {
    const d = this.designs()[slot];
    if (!d) return;
    this.bp = clone(d);
    this.plan = undefined;
    this.toggleDesigns(false);
    this.recenter();
    this.refresh();
    this.status(`loaded ${this.bp.name}: Save to build it in slot ${this.slot + 1}`);
  }

  private async saveAndLaunch(): Promise<void> {
    if (this.errors.length) {
      this.status('fix the problems listed on the right first');
      return;
    }
    // Hangar slots: the server builds in what you have and ghosts the rest
    if (this.deps.hangarState() && !this.grantAll) {
      this.deps.send({ type: 'slotSave', slot: this.slot, blueprint: clone(this.bp), plan: this.plan });
      this.status('saved');
      return;
    }
    // Blueprint files are a dev convenience; the server keeps your ship either way
    if (this.devApi) {
      try {
        const file = await saveBlueprint(this.bp);
        this.status(`saved ${file}.json`);
      } catch (e) {
        console.warn('blueprint file save failed', e);
      }
    }
    this.close(clone(this.bp));
  }

  /** How many more of a part (item id) the pilot could still place from what they have */
  private remaining(id: string): number {
    if (this.grantAll) return Infinity;
    return (this.owned[id] ?? 0) - this.bp.parts.filter((q) => partItemId(q) === id).length;
  }

  /** Free build is on (a dev server's admin, from the admin panel): any part places, and the server takes nothing */
  private get freeBuild(): boolean {
    return !this.grantAll && !!this.deps.hangarState()?.freeBuild;
  }

  /** Every part is free: proto mode, or free build */
  private get free(): boolean {
    return this.grantAll || this.freeBuild;
  }

  /** Parts of the saved design not built yet (uids), and parts added since the last save */
  private ghostInfo(): { ghosts: Set<number>; fresh: Set<number> } {
    const rec = this.deps.hangarState()?.slots[this.slot];
    const saved = new Map((rec?.blueprint.parts ?? []).map((q) => [q.uid, partItemId(q)]));
    const ghosts = new Set(rec?.ghosts ?? []);
    const fresh = new Set<number>();
    for (const q of this.bp.parts) if (saved.get(q.uid) !== partItemId(q)) fresh.add(q.uid);
    return { ghosts, fresh };
  }

  private status(text: string): void {
    this.statusEl.textContent = text;
  }

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  private refresh(): void {
    const { catalog, tuning } = this.deps;
    this.tipGen++;
    this.nameInput.value = this.bp.name;
    this.paintInput.value = this.bp.paint ?? '#24324d';
    this.geoms = this.bp.parts.map((p) => placeGeometry(catalog, p));
    this.owned = this.deps.owned(this.slot);
    this.errors = validateBlueprint(catalog, this.bp, tuning, null).errors;
    // (Each gun's broken mounting rules, by index: drawn on the grid and listed in its tooltip)
    this.mountingBroken = new Map();
    this.geoms.forEach((_, i) => { const b = partMountingProblems(catalog, this.geoms, i); if (b.length) this.mountingBroken.set(i, b); });
    this.freeTag.style.display = this.freeBuild ? '' : 'none';
    for (const q of this.bp.parts) {
      const id = partItemId(q);
      if (!this.free && !this.deps.canMake(id) && this.remaining(id) < 0) {
        this.errors.push({ code: 'notOwned', message: `you can't make ${this.deps.econ.items.name(id)} yet`, uids: [q.uid] });
      }
    }
    this.renderSlots();
    this.rederive();
    this.showLit();
    this.renderPalette();
    this.renderStats();
    this.draw();
  }

  /** The design's derived state (as built whole), and its power report */
  private rederive(): void {
    const { catalog, tuning, econ } = this.deps;
    try {
      this.derived = createShipState(catalog, tuning, 0, this.bp, 0).derived;
    } catch {
      this.derived = null;
    }
    const name = (i: number) => {
      const p = this.bp.parts[i], fn = catalog.functions.get(p.fn);
      return fn?.model && fn.name ? fn.name : econ.items.name(partItemId(p)).split(' · ')[0];
    };
    this.power = this.derived ? powerReport(catalog, this.bp, this.derived, this.geoms, name) : null;
  }

  /** The lit layer shows the built parts (not ghosts), wrecked ones damaged */
  private showLit(): void {
    const { ghosts, fresh } = this.grantAll ? { ghosts: new Set<number>(), fresh: new Set<number>() } : this.ghostInfo();
    const wrecked = new Set(this.deps.hangarState()?.slots[this.slot]?.wrecked ?? []);
    const keep = this.bp.parts.map((p, i) => [p, i] as const).filter(([p]) => !(ghosts.has(p.uid) && !fresh.has(p.uid)));
    if (!keep.length) { this.lit.show(null, []); return; }
    try {
      const ship = createShipState(this.deps.catalog, this.deps.tuning, 0, { ...this.bp, parts: keep.map(([p]) => p) }, 0);
      this.lit.show(ship, keep.map(([, i]) => this.geoms[i]), keep.map(([p]) => (wrecked.has(p.uid) ? 0.2 : 1)));
    } catch {
      this.lit.show(null, []);
    }
  }

  private recenter(): void {
    if (!this.bp.parts.length) { this.view.cx = 0; this.view.cy = 0; return; }
    const geoms = this.bp.parts.map((p) => placeGeometry(this.deps.catalog, p));
    const xs = geoms.flatMap((g) => g.polygon.map((p) => p[0]));
    const ys = geoms.flatMap((g) => g.polygon.map((p) => p[1]));
    this.view.cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    this.view.cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    // Zoom so the whole ship fits (big pre-made ships are 40+ cells long)
    const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 600;
    const fit = Math.min(w / (Math.max(...xs) - Math.min(...xs) + 6), h / (Math.max(...ys) - Math.min(...ys) + 6));
    this.view.px = Math.max(12, Math.min(40, fit));
  }

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------

  /** The material a part in hand is made of: a model's own, else the picked one */
  private handMaterial(fn = this.sel.fn): string {
    const f = this.deps.catalog.functions.get(fn);
    return f?.model && f.material ? f.material : this.sel.material;
  }

  /**
   * The palette: the tool (parts or wires), the part in hand, a category
   * filter, then the parts themselves, what you have first: your parts (with
   * how many), structure (built from materials), what you can fabricate here,
   * and what's locked and why, folded away. Built as one string (it's redrawn
   * on every key); the rows carry their item id (data-part) for the palette's
   * click and tooltip handlers.
   */
  private renderPalette(): void {
    const el = this.palette, scroll = el.scrollTop;
    el.innerHTML = '';
    if (this.tipKey.startsWith('p:')) this.hideTip();

    // The tool: parts, or wires
    const tools = document.createElement('div');
    tools.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr; gap:3px; margin-bottom:8px;';
    for (const [t, text, tip] of [['parts', 'Parts', 'Place and remove parts'], ['wires', '⚡ Wires', 'Lay power wires across the hull (W)']] as const) {
      const on = this.tool === t;
      const b = document.createElement('button');
      b.textContent = text;
      b.title = tip;
      b.style.cssText = `background:${on ? '#24406b' : '#0f1626'}; color:${on ? '#fff' : '#9fb0cc'}; border:1px solid ${on ? '#5fd4c4' : '#2a3a5a'}; border-radius:4px; padding:5px 2px; cursor:pointer; font-size:12px; font-weight:${on ? 600 : 400};`;
      b.onclick = () => this.setTool(t);
      tools.append(b);
    }
    el.append(tools);
    if (this.tool === 'wires') {
      this.renderWirePanel(el);
      el.scrollTop = scroll;
      return;
    }

    el.append(this.handCard());
    el.append(this.filterRow());
    const lists = document.createElement('div');
    lists.innerHTML = this.partListsHtml();
    lists.querySelectorAll<HTMLElement>('[data-fold]').forEach((h) => h.onclick = () => {
      const k = h.dataset.fold as 'locked' | 'lockedFree';
      this.folded[k] = !this.folded[k];
      this.renderPalette();
    });
    el.append(lists);

    const info = document.createElement('div');
    info.style.cssText = 'line-height:1.6; color:#6b7a93; margin:10px 0 8px; font-size:11px;';
    info.innerHTML = `Click places · right-click removes · <b style="color:#9fb0cc">middle-click picks a part up</b><br>R turn · F mirror · T facing · W wires · wheel zooms · middle-drag or arrows pan`;
    el.append(info);

    el.append(foldHeading('Overlays', this.folded.overlays, () => { this.folded.overlays = !this.folded.overlays; this.renderPalette(); }));
    if (!this.folded.overlays) {
      const ov = document.createElement('div');
      ov.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px; margin-bottom:10px;';
      for (const key of Object.keys(this.overlays) as Overlay[]) {
        ov.append(chip(key, this.overlays[key], this.overlays[key] ? '#5fd4c4' : '#2a3a5a', () => { this.overlays[key] = !this.overlays[key]; this.renderPalette(); this.draw(); }));
      }
      el.append(ov);
    }
    if (this.deps.grantAll) {
      el.append(heading('Debug'));
      el.append(checkbox('grant everything', this.grantAll, (v) => { this.grantAll = v; this.refresh(); this.refreshLoadList(); }));
    }
    el.scrollTop = scroll;
  }

  /** Put a part (by item id) in hand: its function and piece, and for structure its material */
  private pickPart(id: string): void {
    const q = this.deps.econ.items.get(id)?.part ?? parsePartItemId(id);
    const f = q && this.deps.catalog.functions.get(q.fn);
    if (!q || !f) return;
    this.sel.fn = q.fn;
    this.sel.piece = q.piece;
    if (!f.model) this.sel.material = q.material;
    this.renderPalette();
    this.draw();
  }

  /** What a locked model waits on (its level) */
  private lockOf(f: FunctionDef): ModelLock {
    return modelLock(f, false, this.deps.level?.() ?? 1, this.deps.econ.items.all());
  }

  /** A part's palette line, worked out once: its size, and its key numbers */
  private line(f: FunctionDef, piece: string, material: string): { size: string; stats: string } {
    const key = `${f.id}:${piece}:${material}`;
    let l = this.lines.get(key);
    if (!l) {
      // (a model's name is its own; structure's names its piece already)
      const size = f.model ? sizeText(this.deps.catalog, { ...f, pieces: [piece] }).split(' · ')[0] : sizeWord(this.deps.catalog, piece);
      l = { size, stats: keyStats(this.deps.catalog, this.deps.tuning, f, piece, material) };
      this.lines.set(key, l);
    }
    return l;
  }

  /**
   * The part in hand: what it is and its mount, whether you have it (or can
   * make it, or what it waits on), what making it takes; structure's material
   * and shape (and a model that comes in more than one size); which way it
   * points
   */
  private handCard(): HTMLElement {
    const { catalog, econ } = this.deps;
    const f = catalog.functions.get(this.sel.fn)!;
    const material = this.handMaterial();
    const id = partItemId({ piece: this.sel.piece, fn: this.sel.fn, material });
    const def = econ.items.get(id);
    const left = this.remaining(id);
    const structure = isStructural(this.sel.fn);
    const can = this.deps.canMake(id);
    const lock = f.model && !can ? this.lockOf(f) : null;
    const red = (t: string) => `<span style="color:#f87171">${esc(t)}</span>`;
    const status = this.freeBuild ? '<span style="color:#fbbf24">Free build: it places, and saving takes nothing</span>'
      : this.grantAll ? '<span style="color:#6b7a93">Free here</span>'
      : structure ? (can ? '<span style="color:#7dd3fc">Structure: built from materials as it goes in</span>' : red(`You can't build in ${catalog.materials.get(material)?.name ?? material} yet`))
      : left > 0 ? `<span style="color:#4ade80">${left} on hand</span>${can ? '' : ` · ${red(lock?.why ? `fits once ${lock.why.charAt(0).toLowerCase()}${lock.why.slice(1)}` : 'not licensed to fit yet')}`}`
      : can ? '<span style="color:#7dd3fc">None on hand: places as a ghost to fabricate</span>'
      : red(lock?.why || "You can't make this yet");
    const r = econ.recipes.recipeFor(id);
    const { size } = this.line(f, this.sel.piece, material);
    const card = document.createElement('div');
    card.style.cssText = 'background:#0d1524; border:1px solid #24324d; border-left:3px solid ' + (f.color ?? numToCss(functionColor(f.id))) + '; border-radius:8px; padding:7px 8px; margin-bottom:8px; line-height:1.4;';
    card.innerHTML = `<div style="display:flex; align-items:baseline; margin-bottom:4px"><span style="color:#6b7a93; font-size:10px; letter-spacing:1px">IN HAND</span>`
      + `<span style="margin-left:auto; color:#6b7a93; font-size:10px">R ${this.sel.rot * 90}° · F ${this.sel.flip ? 'mirrored' : 'mirror'}</span></div>`
      + `<div data-part="${id}" style="display:flex; gap:8px; align-items:center"><img src="${itemIcon(econ, id)}" style="width:36px; height:36px; flex-shrink:0">`
      + `<div style="min-width:0; flex:1"><div style="display:flex; gap:6px; align-items:center; min-width:0"><b style="color:#e5ecf7; font-weight:600; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(f.model ? f.name ?? f.id : def?.name ?? f.name ?? f.id)}</b>`
      + `<span style="color:#6b7a93; font-size:11px; white-space:nowrap">${esc(size)}</span>${mountBadge(catalog, { fn: f.id })}</div>`
      + `<div style="font-size:11px">${status}</div></div></div>`
      + (isWeaponFn(f.id) ? this.mountLine(f) : '')
      + (!f.model && def ? `<div style="color:#8ea0bd; font-size:11px; margin-top:3px">${esc(def.description)}</div>` : '')
      + (r && !this.free && (structure || left <= 0) ? `<div style="font-size:11px; margin-top:4px">${costHtml(econ, r.inputs, (k) => this.deps.have(k))}${structure ? '' : r.time > 0 ? ` <span style="color:#fbbf24">⏳ ${r.time}s</span>` : ' <span style="color:#a5f3a1">instant</span>'}</div>` : '');

    // Structure (and the core): built in a material; the grades you can use, and the one in hand
    if (!f.model) {
      const mats = document.createElement('div');
      mats.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px; margin-top:7px;';
      let hidden = 0;
      for (const m of catalog.materials.values()) {
        if (m.exclusive) continue;
        const sample = partItemId({ material: m.id, fn: this.sel.fn, piece: this.sel.piece });
        const have = this.free || this.remaining(sample) > 0 || this.deps.canMake(sample);
        if (!have && this.sel.material !== m.id) { hidden++; continue; }
        const c = chip(m.name ?? m.id, this.sel.material === m.id, m.color, () => {});
        c.dataset.part = sample;
        c.style.opacity = have ? '1' : '0.45';
        mats.append(c);
      }
      if (hidden) mats.insertAdjacentHTML('beforeend', `<span style="color:#4b5870; font-size:11px; align-self:center; margin-left:2px" title="Better materials unlock as you level">+${hidden} locked</span>`);
      card.append(mats);
    }
    // Shapes it comes in (a model with one size has none to pick)
    const shapes = catalog.pieceIds.filter((pc) => f.pieces === '*' || f.pieces.includes(pc));
    if (!f.model || shapes.length > 1) {
      const grid = document.createElement('div');
      grid.style.cssText = `display:grid; grid-template-columns: repeat(${Math.min(8, Math.max(shapes.length, 4))}, minmax(0, 1fr)); gap:3px; margin-top:7px;`;
      let html = '';
      for (const pc of shapes) {
        const itemId = partItemId({ piece: pc, fn: this.sel.fn, material });
        const n = this.remaining(itemId);
        const make = this.free || this.deps.canMake(itemId);
        const on = this.sel.piece === pc;
        const tag = n === Infinity || this.free ? '' : structure ? (make ? '' : '🔒') : n > 0 ? `${n}` : make ? '<span style="color:#7dd3fc">+</span>' : '🔒';
        html += `<button data-part="${itemId}" style="position:relative; background:${on ? '#24406b' : '#0f1626'}; border:1px solid ${on ? '#5fd4c4' : '#2a3a5a'}; border-radius:6px; padding:2px 0 0; cursor:pointer; opacity:${n > 0 || make ? 1 : 0.35}; min-width:0; aspect-ratio:1; display:grid; place-items:center">`
          + `${pieceIcon(catalog, pc, this.sel.rot, this.sel.flip)}${tag ? `<span style="position:absolute; right:2px; bottom:0; font:700 9px sans-serif; color:#fff; text-shadow:0 0 3px #000">${tag}</span>` : ''}</button>`;
      }
      grid.innerHTML = html;
      card.append(grid);
    }
    // Which way it points (guns, engines, mining lasers)
    if (partNeedsFacing(this.sel.fn)) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:3px; margin-top:7px; flex-wrap:wrap; align-items:center;';
      row.insertAdjacentHTML('beforeend', '<span style="color:#ffb547; font-size:10px; font-weight:bold; letter-spacing:1px; margin-right:2px" title="T cycles it">FACING</span>');
      const label: Record<Side | 'auto', string> = { auto: 'auto', N: '↑', E: '→', S: '↓', W: '←' };
      const tip: Record<Side | 'auto', string> = { auto: 'Its usual side, if that edge is free', N: 'Fore', E: 'Starboard', S: 'Aft', W: 'Port' };
      for (const s of ['auto', ...SIDES] as (Side | 'auto')[]) {
        const c = chip(label[s], this.sel.facing === s, '#7dd3fc', () => { this.sel.facing = s; this.renderPalette(); this.draw(); });
        c.title = `${tip[s]} (T)`;
        row.append(c);
      }
      card.append(row);
    }
    return card;
  }

  /** The category filter: All, or one category, each with how many spare parts you have in it */
  private filterRow(): HTMLElement {
    const { catalog, econ } = this.deps;
    const spare = new Map<string, number>();
    if (!this.grantAll) {
      for (const id of Object.keys(this.owned)) {
        const q = econ.items.get(id)?.part, n = this.remaining(id);
        if (q && n > 0 && catalog.functions.has(q.fn)) spare.set(filterCat(catalog, q.fn), (spare.get(filterCat(catalog, q.fn)) ?? 0) + n);
      }
    }
    const row = document.createElement('div');
    row.style.cssText = 'display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:3px; margin-bottom:6px;';
    for (const c of [{ id: 'all', label: 'All', color: '#cfd8e6' }, ...CATEGORIES.filter((k) => k.id !== 'core')]) {
      const on = this.cat === c.id;
      const n = c.id === 'all' ? [...spare.values()].reduce((a, k) => a + k, 0) : spare.get(c.id) ?? 0;
      const b = document.createElement('button');
      b.innerHTML = `${c.label}${n ? ` <span style="color:#4ade80; font-weight:600">${n}</span>` : ''}`;
      b.title = c.id === 'all' ? 'Every kind of part' : `${c.label}${n ? `: ${n} spare part${n === 1 ? '' : 's'} of yours` : ''}`;
      b.style.cssText = `background:${on ? '#24406b' : '#0f1626'}; color:${on ? '#fff' : '#9fb0cc'}; border:1px solid ${on ? '#5fd4c4' : '#2a3a5a'}; border-bottom:2px solid ${c.color};
        border-radius:4px; padding:3px 4px; cursor:pointer; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;`;
      b.onclick = () => { this.cat = c.id; this.renderPalette(); };
      row.append(b);
    }
    return row;
  }

  /**
   * The parts, as HTML: yours first (by category, with how many), then
   * structure, then what you can fabricate here, then what's locked (folded
   * away, each with what it waits on). Free build: the locked ones place too.
   */
  private partListsHtml(): string {
    const { catalog, econ } = this.deps;
    const show = (fn: string) => this.cat === 'all' || filterCat(catalog, fn) === this.cat;
    const catRank = (fn: string) => CATEGORIES.findIndex((c) => c.id === filterCat(catalog, fn));
    const order = (a: FunctionDef, b: FunctionDef) => catRank(a.id) - catRank(b.id) || familyRank(familyLabel(a)) - familyRank(familyLabel(b)) || (a.fabOrder ?? 0) - (b.fabOrder ?? 0);
    const sel = this.sel;
    const isOn = (f: FunctionDef, piece: string, material: string) => sel.fn === f.id && sel.piece === piece && (!!f.model || sel.material === material);
    type Row = { id: string; f: FunctionDef; piece: string; material: string; right: string; dim?: boolean };
    const rowHtml = ({ id, f, piece, material, right, dim }: Row) => {
      const on = isOn(f, piece, material);
      const { size, stats } = this.line(f, piece, material);
      const name = f.model ? f.name ?? f.id : econ.items.name(id);
      return `<button data-part="${id}" style="display:flex; gap:8px; align-items:center; width:100%; box-sizing:border-box; min-width:0; text-align:left; background:${on ? '#24406b' : '#0f1626'};
        border:1px solid ${on ? '#5fd4c4' : '#22304a'}; border-left:3px solid ${f.color ?? numToCss(functionColor(f.id))}; border-radius:6px; color:#cfd8e6; padding:3px 7px 3px 5px; cursor:pointer; margin-bottom:3px; font:12px 'Segoe UI', sans-serif">`
        + `<img src="${itemIcon(econ, id)}" style="width:32px; height:32px; flex-shrink:0; pointer-events:none; opacity:${dim ? 0.45 : 1}">`
        + `<div style="min-width:0; flex:1; opacity:${dim ? 0.6 : 1}"><div style="display:flex; gap:5px; align-items:center; min-width:0">`
        + `<b style="color:#e5ecf7; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0">${esc(name)}</b>`
        + `<span style="color:#6b7a93; font-size:10px; white-space:nowrap">${esc(size)}</span>${mountBadge(catalog, { fn: f.id })}</div>`
        + `<div style="font-size:10px; color:#a7b4c8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${esc(stats)}</div></div>`
        + `<div style="flex-shrink:0; text-align:right; line-height:1.25; font-size:10px">${right}</div></button>`;
    };
    const section = (title: string, n: string, hint = '', fold?: { key: string; open: boolean }) =>
      `<div ${fold ? `data-fold="${fold.key}" ` : ''}style="display:flex; align-items:baseline; gap:6px; margin:10px 0 4px;${fold ? ' cursor:pointer;' : ''}">`
      + `<span style="color:#ffb547; font-weight:bold; letter-spacing:1px; font-size:11px; white-space:nowrap">${fold ? (fold.open ? '▾ ' : '▸ ') : ''}${title}</span><span style="color:#6b7a93; font-size:11px">${n}</span>`
      + (hint ? `<span style="margin-left:auto; color:#6b7a93; font-size:10px; text-align:right; min-width:0">${hint}</span>` : '') + `</div>`;
    // Rows under category headings (when showing all)
    const grouped = (rows: Row[], count: (r: Row) => number = () => 1) => {
      if (this.cat !== 'all') return rows.map(rowHtml).join('');
      let html = '', last = '';
      for (let i = 0; i < rows.length; i++) {
        const c = filterCat(catalog, rows[i].f.id);
        if (c !== last) {
          last = c;
          const k = CATEGORIES.find((x) => x.id === c)!;
          const n = rows.filter((r) => filterCat(catalog, r.f.id) === c).reduce((a, r) => a + count(r), 0);
          html += `<div style="display:flex; align-items:center; gap:6px; color:#8ea0bd; font-size:10px; letter-spacing:1px; margin:6px 0 3px">`
            + `<span style="width:8px; height:8px; border-radius:2px; background:${k.color}"></span>${k.label.toUpperCase()} <span style="color:#4b5870">${n}</span></div>`;
        }
        html += rowHtml(rows[i]);
      }
      return html;
    };
    let html = '';

    // Yours: storage, the hold, and what this slot already carries that the design doesn't use
    const mine: (Row & { n: number })[] = [];
    if (!this.grantAll) {
      for (const id of Object.keys(this.owned)) {
        const q = econ.items.get(id)?.part, n = this.remaining(id), f = q && catalog.functions.get(q.fn);
        if (!q || !f || n <= 0 || !show(q.fn)) continue;
        const fits = this.free || this.deps.canMake(id);
        const why = fits ? '' : f.model ? this.lockOf(f).badge : '';
        mine.push({ id, f, piece: q.piece, material: q.material, n, right: `<b style="color:#4ade80; font-size:14px">×${n}</b>${fits ? '' : `<br><span style="color:#fca5a5" title="You have it, but fitting it needs its licence">🔒 ${esc(why || 'licence')} to fit</span>`}` });
      }
      mine.sort((a, b) => order(a.f, b.f) || (catalog.pieceIds.indexOf(a.piece) - catalog.pieceIds.indexOf(b.piece)));
      const units = mine.reduce((a, r) => a + r.n, 0);
      html += section('YOUR PARTS', units ? `${units}` : '', 'storage, hold, and spares off this ship');
      html += mine.length ? grouped(mine, (r) => (r as Row & { n: number }).n)
        : `<div style="color:#6b7a93; font-size:11px; line-height:1.45; margin-bottom:4px">${this.cat === 'all' ? 'No spare parts.' : 'None of these spare.'} Anything you can fabricate still places: it goes in as a ghost and fills in once it's made.</div>`;
    }

    // Structure and the core: plates built from materials as they go in
    const plates = [...catalog.functions.values()].filter((f) => !f.model && !f.exclusive && (!f.legacy || f.id === sel.fn) && show(f.id)).sort(order);
    if (plates.length) {
      html += section('STRUCTURE', '', 'built from materials as it goes in');
      html += `<div style="display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:3px; margin-bottom:4px">`;
      for (const f of plates) {
        const piece = f.pieces === '*' || f.pieces.includes(sel.piece) ? sel.piece : f.pieces[0];
        const id = partItemId({ fn: f.id, material: sel.material, piece });
        const can = this.free || this.deps.canMake(id) || this.remaining(id) > 0;
        const on = sel.fn === f.id;
        html += `<button data-part="${id}" style="display:flex; flex-direction:column; align-items:center; gap:1px; background:${on ? '#24406b' : '#0f1626'}; border:1px solid ${on ? '#5fd4c4' : '#2a3a5a'};
          border-radius:6px; color:#cfd8e6; padding:3px 2px; cursor:pointer; min-width:0; opacity:${can ? 1 : 0.45}">`
          + `<img src="${itemIcon(econ, id)}" style="width:28px; height:28px; pointer-events:none"><span style="font-size:10px; line-height:1.15; text-align:center; width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border-top:2px solid ${numToCss(functionColor(f.id))}; padding-top:1px">${esc(f.name ?? f.id)}</span></button>`;
      }
      html += `</div>`;
    }

    // Models you don't have spare: what you can fabricate here, and what's locked
    const have = new Set(mine.map((r) => r.id));
    const make: Row[] = [], locked: (Row & { lv: number })[] = [];
    for (const f of catalog.functions.values()) {
      if (!f.model || f.exclusive || f.legacy || !show(f.id)) continue;
      const piece = f.pieces === '*' ? 'sq' : sel.fn === f.id && f.pieces.includes(sel.piece) ? sel.piece : f.pieces[0];
      const material = f.material ?? 'alloy';
      const id = partItemId({ fn: f.id, material, piece });
      if (have.has(id)) continue;
      if (this.grantAll || this.deps.canMake(id)) {
        const r = econ.recipes.recipeFor(id);
        make.push({ id, f, piece, material, right: this.grantAll ? '' : `<span style="color:#7dd3fc">fabricate</span><br><span style="color:${r && r.time > 0 ? '#6b7a93' : '#a5f3a1'}">${r && r.time > 0 ? `⏳ ${r.time}s` : 'instant'}</span>` });
      } else {
        const lock = this.lockOf(f);
        locked.push({ id, f, piece, material, lv: f.unlock?.level ?? 999, dim: !this.freeBuild,
          right: `<span style="color:${this.freeBuild ? '#fbbf24' : '#fca5a5'}" title="${esc(lock.why)}">🔒 ${esc(lock.badge)}</span>${this.freeBuild ? '<br><span style="color:#fbbf24">free build</span>' : ''}` });
      }
    }
    make.sort((a, b) => order(a.f, b.f));
    if (make.length) {
      html += section(this.grantAll ? 'EVERY PART' : 'FABRICATE HERE', `${make.length}`, this.grantAll ? 'free here' : 'places as a ghost, then gets made');
      html += grouped(make);
    }
    if (locked.length) {
      locked.sort((a, b) => catRank(a.f.id) - catRank(b.f.id) || a.lv - b.lv || order(a.f, b.f));
      const key = this.freeBuild ? 'lockedFree' : 'locked', open = !this.folded[key];
      html += section('LOCKED', `${locked.length}`, this.freeBuild ? 'free build places these too' : 'each opens at a level (a legendary is made with a rare part from its boss)', { key, open });
      if (open) html += grouped(locked);
    }
    return html;
  }

  /**
   * The wires tool: draw or erase, Auto-wire, Clear, back to auto-wiring;
   * whether the design is auto-wired (free, following its parts) or wired by
   * hand, and what saving the wiring costs in spools
   */
  private renderWirePanel(el: HTMLElement): void {
    const wires = this.bp.wires;
    el.append(heading('Power wires'));
    const intro = document.createElement('div');
    intro.style.cssText = 'color:#8ea0bd; font-size:11px; line-height:1.5; margin-bottom:8px;';
    intro.innerHTML = 'Power runs from the generators along wires to what uses it. A part touching a generator is plugged straight in; modules touching modules share nothing. Shoot away the block under a wire and it\'s cut there.';
    el.append(intro);
    const state = document.createElement('div');
    state.style.cssText = 'background:#0d1524; border:1px solid #24324d; border-radius:8px; padding:7px 8px; margin-bottom:8px; font-size:11px; line-height:1.5;';
    const n = this.derived?.wires.length ?? 0;
    if (!wires) {
      state.innerHTML = `<div style="color:#7dd3fc; font-weight:600">Auto-wired</div><div style="color:#a7b4c8">${n} segment${n === 1 ? '' : 's'} laid for you, free: they follow your parts as you change them, until you edit a wire.</div>`;
    } else {
      const saved = this.deps.hangarState()?.slots[this.slot]?.blueprint.wires;
      const bill = wireBill(saved, wires), have = this.deps.stored?.(WIRE_ITEM) ?? this.deps.have(WIRE_ITEM);
      const cost = this.free ? '<span style="color:#6b7a93">free here</span>'
        : bill.spools > 0 ? `<span style="color:${have >= bill.spools ? '#fbbf24' : '#f87171'}">saving takes ${bill.spools} wire spool${bill.spools > 1 ? 's' : ''}</span> <span style="color:#6b7a93">(${have} in storage)</span>`
        : bill.spools < 0 ? `<span style="color:#4ade80">saving returns ${-bill.spools} spool${bill.spools < -1 ? 's' : ''}</span>`
        : '<span style="color:#6b7a93">no new spools to save</span>';
      state.innerHTML = `<div style="color:#fbbf24; font-weight:600">Wired by hand</div>`
        + `<div style="color:#a7b4c8">${wires.length} segment${wires.length === 1 ? '' : 's'} · ${Math.ceil(wires.length / SEGMENTS_PER_SPOOL)} spool${Math.ceil(wires.length / SEGMENTS_PER_SPOOL) === 1 ? '' : 's'}`
        + `${saved ? ` <span style="color:#6b7a93">(saved: ${saved.length})</span>` : ' <span style="color:#6b7a93">(saved: auto-wired)</span>'}</div><div>${cost}</div>`
        + `<div style="color:#6b7a93">A spool lays ${SEGMENTS_PER_SPOOL} segments; ones you take out come back.</div>`;
    }
    el.append(state);
    // Draw / erase
    const modes = document.createElement('div');
    modes.style.cssText = 'display:flex; gap:3px; margin-bottom:6px;';
    const draw = chip('Draw', !this.wireErase, '#fbbf24', () => { this.wireErase = false; this.renderPalette(); });
    draw.title = 'Drag across cells to lay wire between them (E switches)';
    const erase = chip('Erase', this.wireErase, '#f87171', () => { this.wireErase = true; this.renderPalette(); });
    erase.title = 'Drag across cells to take their wire out (a right-drag always erases)';
    modes.append(draw, erase);
    el.append(modes);
    const acts = document.createElement('div');
    acts.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px; margin-bottom:10px;';
    const auto = button('Auto-wire', () => this.autoWireAll(), '#1d3d5c');
    auto.title = 'Lay the shortest runs from the generators to everything that makes, stores or draws power (replaces your wiring)';
    const clear = button('Clear wires', () => this.clearWires(), '#3a1f2a');
    clear.title = 'Take every wire out: only what touches a generator keeps its power';
    acts.append(auto, clear);
    if (wires) {
      const back = button('Back to auto', () => this.unwire());
      back.title = 'Forget the hand wiring: auto-wired again, free, following the parts';
      acts.append(back);
    }
    el.append(acts);
    const info = document.createElement('div');
    info.style.cssText = 'line-height:1.6; color:#6b7a93; margin-bottom: 8px; font-size:11px;';
    info.innerHTML = 'Drag lays wire cell to cell (diagonals too) · <b style="color:#9fb0cc">right-drag erases</b><br>E draw / erase · W back to parts · wheel zooms · middle-drag pans';
    el.append(info);
  }

  /** Slot tabs: which ship you're designing */
  private renderSlots(): void {
    const hs = this.deps.hangarState();
    this.slotBar.innerHTML = '';
    if (!hs || this.grantAll) return;
    hs.slots.forEach((rec, i) => {
      const built = rec ? rec.blueprint.parts.length - rec.ghosts.length : 0;
      const b = document.createElement('button');
      const on = i === this.slot;
      b.style.cssText = `background:${on ? '#24406b' : '#0f1626'}; color:#e5ecf7; border:1px solid ${on ? '#5fd4c4' : '#2a3a5a'}; border-radius:6px; padding:3px ${rec ? 8 : 7}px; cursor:pointer; font:12px 'Segoe UI', sans-serif;
        display:flex; align-items:center; gap:4px; max-width:150px; white-space:nowrap; min-width:0; flex-shrink:${rec ? 1 : 0};`;
      b.innerHTML = rec
        ? `<span style="color:#8ea0bd">${i + 1}</span><span style="overflow:hidden; text-overflow:ellipsis">${esc(rec.blueprint.name)}</span>${i === hs.active ? '<span style="color:#4ade80">✈</span>' : rec.ghosts.length ? `<span style="color:#7dd3fc; font-size:11px">${built}/${rec.blueprint.parts.length}</span>` : '<span style="color:#4ade80">✓</span>'}`
        : `<span style="color:#6b7a93">${i + 1}${on ? ' · empty' : ' +'}</span>`;
      b.title = rec ? `Slot ${i + 1}: ${rec.blueprint.name}. ${i === hs.active ? 'The ship you fly' : rec.ghosts.length ? `${rec.ghosts.length} parts still to build` : 'Ready to fly'}` : `Slot ${i + 1}: empty. Start a new design, or load a plan or design`;
      b.onclick = () => this.switchSlot(i);
      this.slotBar.appendChild(b);
    });
  }

  /** The build panel: what this slot still needs, and buttons to make it */
  private buildHtml(): string {
    const hs = this.deps.hangarState();
    const rec = hs?.slots[this.slot];
    if (!hs || this.grantAll) return '';
    const econ = this.deps.econ;
    let html = `<div style="color:#ffb547; font-weight:bold; margin-bottom:6px; font-family:'Segoe UI',sans-serif">BUILD</div>`;
    if (this.unsaved) {
      html += `<div style="font-family:'Segoe UI',sans-serif; color:#fbbf24; line-height:1.5; margin-bottom:10px">Unsaved changes: <b>Save</b> to build in what you have.<br><span style="color:#8ea0bd">Parts you don't have yet become ghosts that fill in as they're made.</span></div>`;
      return html;
    }
    if (!rec) return html + `<div style="font-family:'Segoe UI',sans-serif; color:#8ea0bd; margin-bottom:10px">Empty slot. Design a ship or load one of your plans, then Save.</div>`;
    const ghosts = new Set(rec.ghosts);
    // What the unbuilt parts take: modules as items, structure as its materials
    const need = ghostBill(econ, rec.blueprint, rec.ghosts);
    const coming = this.deps.coming();
    const ids = Object.keys(need).sort((a, b) => econ.items.rank(a) - econ.items.rank(b));
    const total = rec.blueprint.parts.length, built = total - rec.ghosts.length;
    const font = `font-family:'Segoe UI',sans-serif;`;
    if (rec.loaner) html += `<div style="${font} color:#7dd3fc; line-height:1.5; margin-bottom:8px">A loaner: a free starter ship while yours is rebuilt. It goes back when you fly your own.</div>`;
    if (rec.lost) html += `<div style="${font} color:#fbbf24; line-height:1.5; margin-bottom:8px">Lost in battle. ${Math.round(SALVAGE * 100)}% of its materials and all its components were salvaged: it's being rebuilt, and can't be flown until it's whole.</div>`;
    html += `<div style="${font} margin-bottom:6px">${built} / ${total} parts built${rec.auto && ids.length ? ' <span style="color:#7dd3fc">· on order</span>' : ''}</div>
      <div style="height:5px; border-radius:3px; background:#1a2438; overflow:hidden; margin-bottom:8px"><i style="display:block; height:100%; width:${(built / total) * 100}%; background:linear-gradient(90deg,#2c87ad,#7dd3fc)"></i></div>`;
    if (!ids.length) {
      html += `<div style="${font} color:#4ade80; margin-bottom:10px">Every part is built.${this.slot === hs.active ? '' : ' Ready to fly.'}</div>`;
    } else {
      // Modules still to fabricate, and the materials still to refine (for structure and for those modules)
      const materials: Bag = {};
      let blocked = false;
      html += `<div style="${font} font-size:11px; line-height:1.55; margin-bottom:8px">`;
      for (const id of ids) {
        const n = need[id];
        const stored = Math.min(n, this.deps.have(id));
        const on = Math.min(n - stored, coming[id] ?? 0);
        const left = n - stored - on;
        const refined = econ.recipes.refining.has(id);
        const r = refined ? null : econ.recipes.recipeFor(id);
        const can = refined || this.deps.canMake(id);
        if (left > 0 && r && can) for (const [k, m] of Object.entries(r.inputs)) materials[k] = (materials[k] ?? 0) + m * left;
        if (left > 0 && !can) blocked = true;
        const status = !can && left > 0 ? `<span style="color:#f87171">can't make yet</span>`
          : left <= 0 ? (on ? `<span style="color:#7dd3fc">⏳ on its way</span>` : `<span style="color:#4ade80">in storage</span>`)
          : refined ? `<span style="color:#fbbf24">refine ${left}</span>`
          : r && r.time > 0 ? `<span style="color:#fbbf24">⏳ ${r.time}s each</span>` : `<span style="color:#a5f3a1">instant</span>`;
        const label = econ.items.name(id).replace(/^(Alloy|Composite|Steel|Titanium|Cobalt|Neutronium) /, '');
        html += `<div style="display:flex; justify-content:space-between; gap:6px"><span>${n} × ${label}</span>${status}</div>`;
      }
      html += `</div>`;
      if (Object.keys(materials).length) {
        html += `<div style="${font} font-size:11px; color:#8ea0bd; margin-bottom:4px">Fabricating the rest takes:</div>
          <div style="${font} font-size:11px; white-space:normal; margin-bottom:6px">${costHtml(econ, materials, (id) => this.deps.have(id))}</div>`;
      }
      html += rec.auto
        ? `<div style="${font} font-size:11px; color:#7dd3fc; line-height:1.5; margin-bottom:10px">On order: the refinery and fabricator work through it, and parts go in as they're ready.${blocked ? ' <span style="color:#f87171">Some parts need a licence first.</span>' : ''}</div>`
        : `<div style="display:flex; flex-direction:column; gap:5px; margin-bottom:10px">
            <button data-act="all" style="${btnCss('#2f6f4f')}" title="Refine your ore, fabricate the modules and fit everything, as far as your materials go">Put it on order</button></div>`;
    }
    if (this.slot !== hs.active) {
      const core = rec.blueprint.parts.find((q) => q.fn === 'core');
      const flyable = !!core && !ghosts.has(core.uid) && !rec.lost;
      html += `<div style="display:flex; gap:5px; margin-bottom:12px">
        <button data-act="fly" style="${btnCss(flyable ? '#2f6f4f' : '#2a3346')}" ${flyable ? '' : `disabled title="${rec.lost ? 'Being rebuilt: fly it once it\'s whole' : 'Build its core first'}"`}>Fly this ship</button>
        <button data-act="clear" style="${btnCss('#4a2430')}" title="${rec.loaner ? 'Hand the loaner back' : `Break its built parts down: ${Math.round(SALVAGE * 100)}% of their minerals back as ore, every component in full`}">${rec.loaner ? 'Return loaner' : 'Scrap ship'}</button></div>`;
    }
    return html;
  }

  /**
   * The slot's ammunition loadout (as saved: a design's guns count once it's
   * saved): per gun kind that fires crates, how many of each to carry and
   * which opens first, with what you have and what's short.
   */
  private ammoHtml(): string {
    const hs = this.deps.hangarState();
    const rec = hs?.slots[this.slot];
    if (!hs || !rec || this.grantAll || rec.loaner) return '';
    const { catalog, tuning, econ } = this.deps;
    const kinds = loadoutKinds(catalog, tuning, rec.blueprint);
    if (!kinds.length) return '';
    const load = rec.loadout ?? {};
    const font = `font-family:'Segoe UI',sans-serif;`;
    const step = (item: string, d: number, off: boolean) => `<button data-ammo="${item}" data-d="${d}" ${off ? 'disabled' : ''} style="width:20px; height:20px; padding:0; border-radius:4px; border:1px solid #2a3a5a; background:#14203a; color:${off ? '#3b4a66' : '#e5ecf7'}; cursor:${off ? 'default' : 'pointer'}; font:13px/1 'Segoe UI',sans-serif">${d > 0 ? '+' : '−'}</button>`;
    let html = `<div style="color:#ffb547; font-weight:bold; margin-bottom:4px; ${font} letter-spacing:1px">AMMUNITION</div>
      <div style="${font} color:#8ea0bd; font-size:11px; line-height:1.45; margin-bottom:6px">Crates this ship carries: docking, launching and flying it load them from storage. They stay aboard when you store, and ★ opens first.</div>`;
    let vol = 0;
    for (const kind of kinds) {
      const crates = cratesFor(tuning, kind);
      const free = !tuning.weapons?.[kind]?.ammo;
      const order = crateOrder(crates, load);
      const first = rec.first?.[kind] && crates.includes(rec.first[kind]) ? rec.first[kind] : order[0];
      html += `<div style="${font} margin:6px 0 2px; color:#e5ecf7; text-transform:capitalize">${esc(kind)}${free ? ' <span style="color:#6b7a93; font-size:11px; text-transform:none">· fires plain shells free; crates are a choice</span>' : ''}</div>`;
      for (const item of crates) {
        const n = load[item] ?? 0, have = this.deps.have(item), d = econ.items.get(item);
        vol += n * econ.items.volume(item);
        const star = item === first;
        const tip = esc(`${d?.name ?? item}: ${d?.ammoFor?.rounds ?? '?'} rounds a crate${d?.description ? `. ${d.description}` : ''}`);
        html += `<div style="display:flex; align-items:center; gap:5px; padding:2px 0; ${font} font-size:11px" title="${tip}">
          <button data-first="${esc(kind)}:${item}" title="${star ? 'Opens first' : 'Open these first'}" style="all:unset; cursor:pointer; width:12px; color:${star ? '#fbbf24' : '#3b4a66'}">★</button>
          <img src="${itemIcon(econ, item)}" style="width:16px; height:16px">
          <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${n ? '#e5ecf7' : '#8ea0bd'}">${esc((d?.name ?? item).replace(/ Crate$/, ''))}</span>
          <span style="color:${have >= n ? '#6b7a93' : '#fbbf24'}" title="In your hold and storage">${have}</span>
          ${step(item, -1, n <= 0)}<b style="width:16px; text-align:center; color:${n ? '#e5ecf7' : '#56657c'}">${n}</b>${step(item, 1, n >= MAX_LOADOUT_CRATES)}</div>`;
      }
    }
    // What's short of the loadout (across hold and storage), and where it comes from
    const short = Object.entries(load).map(([id, n]) => [id, n - this.deps.have(id)] as const).filter(([, k]) => k > 0);
    const cap = shipSummary(catalog, tuning, econ, rec.blueprint)?.cargo ?? 0;
    html += `<div style="${font} font-size:11px; color:${cap && vol > cap ? '#f87171' : '#6b7a93'}; margin-top:4px">Takes ${Math.round(vol)} of ${Math.round(cap)} hold${cap && vol > cap ? ': more than fits' : ''}</div>`;
    for (const [id, k] of short) {
      const can = this.deps.canMake(id);
      html += `<div style="display:flex; align-items:center; gap:6px; ${font} font-size:11px; margin-top:4px"><span style="flex:1; color:#fbbf24">Short ${k} × ${esc(econ.items.name(id))}</span>`
        + (can ? `<button data-make="${id}:${k}" style="${btnCss('#1d5e7a')} flex:0; padding:3px 8px; font-size:11px; white-space:nowrap" title="Put it on order: made as its materials come in, into storage">Order ${k}</button>`
          : `<span style="color:#8ea0bd" title="You don't know how to make it yet">buy at a market</span>`) + `</div>`;
    }
    return html + '<div style="margin-bottom:12px"></div>';
  }

  private bindBuildButtons(): void {
    const act = (a: string, fn: () => void) => { const b = this.stats.querySelector<HTMLButtonElement>(`[data-act="${a}"]`); if (b) b.onclick = fn; };
    // Ammunition: a crate more or fewer, the one that opens first, an order for what's short
    const load = this.deps.hangarState()?.slots[this.slot]?.loadout ?? {};
    this.stats.querySelectorAll<HTMLButtonElement>('[data-ammo]').forEach((b) => b.onclick = () => {
      const item = b.dataset.ammo!, n = Math.max(0, Math.min(MAX_LOADOUT_CRATES, (load[item] ?? 0) + Number(b.dataset.d)));
      this.deps.send({ type: 'slotLoadout', slot: this.slot, load: { [item]: n } });
    });
    this.stats.querySelectorAll<HTMLButtonElement>('[data-first]').forEach((b) => b.onclick = () => {
      const [kind, item] = b.dataset.first!.split(':');
      this.deps.send({ type: 'slotLoadout', slot: this.slot, load: {}, first: { [kind]: item } });
    });
    this.stats.querySelectorAll<HTMLButtonElement>('[data-make]').forEach((b) => b.onclick = () => {
      const [item, n] = b.dataset.make!.split(':');
      this.deps.send({ type: 'fabOrder', item, n: Number(n) });
    });
    // The load test (energy.ts loadTest): a few seconds of full fire, boost or both, run here on the design
    this.stats.querySelectorAll<HTMLButtonElement>('[data-load]').forEach((b) => b.onclick = () => {
      const kind = b.dataset.load!;
      this.loadRun = kind === 'off' || !this.derived ? null : {
        kind, sig: designSig(this.bp),
        result: loadTest(this.derived, this.deps.tuning, { fire: kind !== 'boost', thrust: kind !== 'fire', boost: kind !== 'fire', seconds: LOAD_TEST_SECONDS }),
      };
      this.renderStats();
      this.draw();
    });
    act('all', () => this.deps.send({ type: 'slotBuild', slot: this.slot }));
    act('fly', () => { this.deps.send({ type: 'slotFly', slot: this.slot }); this.close(null); });
    act('clear', () => {
      const rec = this.deps.hangarState()?.slots[this.slot];
      if (rec?.loaner || confirm(`Scrap the ${rec?.blueprint.name ?? 'ship'}? Its built parts break down: ${Math.round(SALVAGE * 100)}% of their minerals come back as ore, and every component.`)) this.deps.send({ type: 'slotClear', slot: this.slot });
    });
  }

  /**
   * Power: each circuit (local circuits: its letter, in its overlay colour)
   * with its generators and stores, what it spares and what it can give a
   * second, the load test's verdict on it, whether the design is auto-wired
   * or wired by hand, and what's wrong (no generator for its stores, a
   * capacitor touching nothing, a weak link)
   */
  private powerHtml(): string {
    const rep = this.power, d = this.derived;
    if (!rep || !d) return '';
    const hand = !!this.bp.wires;
    const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');
    let html = `<div style="display:flex; align-items:baseline; margin-bottom:4px"><b style="color:#ffb547; letter-spacing:1px">POWER</b>`
      + `<span style="margin-left:auto; font-size:11px; color:${hand ? '#fbbf24' : '#7dd3fc'}" title="${hand ? 'Wired by hand: new segments cost wire spools as you save' : 'Auto-wired: the wires follow your parts, free, until you edit them (the Wires tool, W)'}">${hand ? 'wired by hand' : 'auto-wired'}</span></div>`;
    const nets = rep.nets.map((n, k) => ({ n, k })).filter(({ n }) => n.letter).sort((a, b) => a.n.letter.localeCompare(b.n.letter));
    if (!nets.length) html += '<div style="color:#6b7a93; font-size:11px; margin-bottom:4px">No generator on this ship.</div>';
    const lt = this.loadRun && this.loadRun.sig === designSig(this.bp) ? this.loadRun : null;
    for (const { n, k } of nets) {
      const gens = n.generators.length, stores = n.batteries.length;
      const what = [gens ? `${gens} gen` : 'no generator', stores ? `${stores} store${stores > 1 ? 's' : ''}` : '', n.main ? 'core' : ''].filter(Boolean).join(' · ');
      const ok = n.supply >= n.demand - 1e-6;
      html += `<div style="display:flex; align-items:center; gap:6px; padding:2px 0; border-bottom:1px solid #18223a; font-size:11px" title="Circuit ${n.letter}: ${n.parts.length} parts. Its generators make +${n0(n.supply)}/s (steady loads take ${n0(n.demand)}), so ${n0(n.spare)}/s spare for its engines, guns and stores; its stores hold ${n0(n.store)} and give up to ${n0(n.rate)}/s; flat out its engines and guns ask ${n0(n.burst)}/s (boosting asks far more)">`
        + `<span style="width:15px; height:15px; border-radius:3px; flex-shrink:0; background:${n.color}; color:#0b1220; font-weight:800; text-align:center; line-height:15px">${n.letter}</span>`
        + `<span style="color:#8ea0bd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${what}</span>`
        + `<span style="margin-left:auto; white-space:nowrap"><b style="color:${!n.powered ? '#8ea0bd' : ok ? '#4ade80' : '#fbbf24'}">+${n0(n.spare)}</b><span style="color:#6b7a93">/s · ${n0(n.store)} held · gives ${n0(n.rate)}/s</span></span></div>`;
      const r = lt?.result.circuits[k];
      if (r && (r.engines < 1.01 || r.guns < 1.01)) {
        const pc = (v: number) => `${Math.round(v * 100)}%`;
        const what2 = r.brownAt < 0 ? '<span style="color:#4ade80">holds up: full power throughout</span>'
          : `<span style="color:${Math.min(r.engines, r.guns) < 0.5 ? '#f87171' : '#fbbf24'}">browns out ${r.brownAt < 0.05 ? 'at once' : `after ${r.brownAt.toFixed(1)} s`}: engines ${pc(r.engines)}, guns ${pc(r.guns)}</span>`;
        const refill = !Number.isFinite(r.refill) ? (n.powered ? ' · refills slowly' : ' · <span style="color:#f87171">never refills</span>') : r.refill > 0.05 ? ` · refills in ${r.refill.toFixed(0)} s` : '';
        html += `<div style="font-size:11px; padding:1px 0 3px 21px; color:#8ea0bd">${what2}${refill}</div>`;
      }
    }
    // Surge banks (energy Phase 2: surge.ts): capacitors and Pulse Dynamos touching, giving only by touch
    const partName = (i: number) => { const p = this.bp.parts[i], fn = this.deps.catalog.functions.get(p.fn); return fn?.name ?? p.fn; };
    const names = (list: number[]) => {
      const c = new Map<string, number>();
      for (const i of list) c.set(partName(i), (c.get(partName(i)) ?? 0) + 1);
      return [...c].map(([nm, k]) => (k > 1 ? `${k} ${nm}s` : nm)).join(', ');
    };
    for (const b of rep.banks) {
      const what = [b.capacitors ? `${b.capacitors} capacitor${b.capacitors > 1 ? 's' : ''}` : '', b.dynamos ? `${b.dynamos} dynamo${b.dynamos > 1 ? 's' : ''}` : ''].filter(Boolean).join(' + ');
      const feeds = [b.feeds.length ? names(b.feeds) : '', b.shields.length ? names(b.shields) : ''].filter(Boolean).join(', ');
      html += `<div style="display:flex; align-items:center; gap:6px; padding:2px 0; border-bottom:1px solid #18223a; font-size:11px" title="Surge bank ${b.label}: ${what}. Charged by ${b.circuit ? `circuit ${b.circuit}` : 'no circuit'}${b.surge ? ` and its dynamos (+${n0(b.surge)}/s)` : ''}; gives only by touch, to ${feeds || 'nothing'}">`
        + `<span style="min-width:15px; height:15px; padding:0 2px; border-radius:3px; flex-shrink:0; background:${SURGE_COLOR}; color:#0b1220; font-weight:800; text-align:center; line-height:15px; font-size:10px">${b.label}</span>`
        + `<span style="color:#c4b5fd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">Surge · ${feeds ? `feeds ${esc(feeds)}` : '<span style="color:#fbbf24">touches nothing</span>'}</span>`
        + `<span style="margin-left:auto; white-space:nowrap; color:#6b7a93">${b.surge ? `<b style="color:#c4b5fd">+${n0(b.surge)}</b>/s · ` : ''}${n0(b.cap)} held</span></div>`;
    }
    // The core's store, and the load test
    const core = d.power?.core;
    if (core) {
      const main = d.power!.circuits[core.circuit];
      html += `<div style="font-size:11px; color:#6b7a93; padding:2px 0" title="The core's built-in store: a battery on the main circuit (the one making most power), and a slow trickle into every other circuit and into parts on none, so a cut-off part limps instead of dying">Core store ${n0(core.cap)}: gives ${main ? main.letter : 'the main circuit'} up to ${n0(core.rate)}/s, the others ${n0(core.trickle)}/s</div>`;
    }
    if (nets.length) {
      const chip = (kind: string, label: string, tip: string) => `<button data-load="${kind}" title="${tip}" style="background:${lt?.kind === kind ? '#24406b' : '#0f1626'}; color:#e5ecf7; border:1px solid ${lt?.kind === kind ? '#5fd4c4' : '#2a3a5a'}; border-radius:5px; padding:1px 7px; cursor:pointer; font:11px 'Segoe UI', sans-serif">${label}</button>`;
      html += `<div style="display:flex; align-items:center; gap:4px; margin:4px 0 2px; font-size:11px"><span style="color:#8ea0bd" title="Plays ${LOAD_TEST_SECONDS} seconds of the ship's own power from full: which circuits brown out, and how long they take to refill">Load test</span>`
        + chip('fire', 'Fire', 'Every gun firing flat out') + chip('boost', 'Boost', 'Boosting forward') + chip('both', 'Both', 'Every gun firing while boosting forward')
        + (lt ? `<button data-load="off" title="Clear the load test" style="margin-left:auto; background:none; border:none; color:#6b7a93; cursor:pointer; font-size:11px">clear</button>` : '') + '</div>';
    }
    // Weak links: cells a wire runs through whose loss cuts consumers off from every generator (✂ on the overlay)
    if (rep.weak.length) {
      const w = rep.weak[0];
      html += `<div style="font-size:11px; color:#fca5a5; margin-top:3px" title="${esc(rep.weak.slice(0, 8).map((x) => x.text).join('\n'))}">✂ ${rep.weak.length} weak link${rep.weak.length > 1 ? 's' : ''}: ${esc(w.text.charAt(0).toLowerCase() + w.text.slice(1))}${rep.weak.length > 1 ? ' (the Wires tool marks them; a loop of wire has none)' : ''}</div>`;
    }
    if (rep.warnings.length) {
      html += `<div style="margin:5px 0 2px; font-size:11px; line-height:1.45">${rep.warnings.slice(0, 7).map((w) => `<div style="color:${/no power|never/.test(w) ? '#f87171' : '#fbbf24'}">• ${esc(w.charAt(0).toUpperCase() + w.slice(1))}</div>`).join('')}`
        + `${rep.warnings.length > 7 ? `<div style="color:#6b7a93">and ${rep.warnings.length - 7} more</div>` : ''}</div>`;
      if (this.tool !== 'wires') html += '<div style="color:#6b7a93; font-size:11px">The Wires tool (W) lays what\'s missing.</div>';
    } else if (nets.length) html += '<div style="color:#4ade80; font-size:11px; margin-top:4px">Everything that uses power has it.</div>';
    return html + '<div style="margin-bottom:12px"></div>';
  }

  /** The ship at a glance, against the saved design when you've changed it */
  private summaryHtml(): string {
    const { catalog, tuning, econ } = this.deps;
    const now = shipSummary(catalog, tuning, econ, this.bp);
    if (!now) return '<div style="color:#8ea0bd; margin-bottom:10px">Place a core to see what this ship can do.</div>';
    const savedBp = this.deps.hangarState()?.slots[this.slot]?.blueprint;
    const was = this.unsaved && savedBp ? shipSummary(catalog, tuning, econ, savedBp) : null;
    const delta = (k: keyof Omit<ShipSummary, 'power' | 'energy'>) => {
      if (!was) return '';
      const a = was[k], b = now[k];
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b - a) < 1e-6) return '';
      const pct = a ? ((b - a) / Math.abs(a)) * 100 : 100;
      if (Math.abs(pct) < 0.5) return '';
      const good = (b > a) === BIGGER_IS_BETTER[k];
      return `<span style="color:${good ? '#4ade80' : '#f87171'}; font-size:11px; margin-left:6px">${b > a ? '▲' : '▼'}${Math.abs(pct) >= 1000 ? '' : ` ${Math.round(Math.abs(pct))}%`}</span>`;
    };
    const row = (label: string, value: string, k?: keyof Omit<ShipSummary, 'power' | 'energy'>, tip = '') =>
      `<div style="display:flex; justify-content:space-between; gap:8px; padding:3px 0; border-bottom:1px solid #18223a" title="${tip}"><span style="color:#8ea0bd">${label}</span><span><b style="color:#e5ecf7">${value}</b>${k ? delta(k) : ''}</span></div>`;
    const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');
    let html = `<div style="color:#ffb547; font-weight:bold; margin-bottom:6px; letter-spacing:1px">SHIP${was ? ' <span style="color:#8ea0bd; font-weight:400; letter-spacing:0">vs saved</span>' : ''}</div>`;
    html += `<div style="display:flex; justify-content:space-between; align-items:baseline; padding:2px 0 6px; border-bottom:1px solid #18223a" title="Firepower and toughness together: how strong the ship is. Systems and siege moons show what their hostiles rate">`
      + `<span style="color:#8ea0bd">Rating</span><span><b style="color:#7dd3fc; font-size:18px">◆ ${n0(now.rating)}</b>${delta('rating')}</span></div>`;
    // Build points against the pilot's budget (a plan builds as designed)
    const cost = buildPoints(catalog, this.bp), budget = this.deps.hangarState()?.budget;
    if (budget !== undefined) {
      const over = cost > budget && !this.free;
      html += `<div style="display:flex; justify-content:space-between; gap:8px; padding:3px 0; border-bottom:1px solid #18223a" title="What the ship costs against your budget: every cell 1 point at Mk I, 1.6 at Mk II, 2.5 at Mk III, 3.8 at Mk IV, 5.5 at Mk V. More budget as you level; a ship built from a plan builds as designed">`
        + `<span style="color:#8ea0bd">Build points</span><span><b style="color:${over ? '#f87171' : '#e5ecf7'}">${cost} / ${budget}</b>${over ? ' <span style="color:#f87171; font-size:11px">over budget</span>' : ''}</span></div>`;
    }
    html += row('Top speed', `${n0(now.topSpeed)} m/s`, 'topSpeed', 'Flat out, without boost');
    html += row('Acceleration', `${n0(now.accel)} m/s²`, 'accel', 'Main engines; more thrusters or less mass is faster');
    html += row('Turn 180°', Number.isFinite(now.turn180) ? `${now.turn180.toFixed(1)} s` : 'can\'t turn', 'turn180', 'Thrusters and gyros against the ship\'s inertia');
    html += row('Firepower', `${n0(now.dps)} dmg/s`, 'dps', `${now.guns} gun${now.guns === 1 ? '' : 's'}${now.turrets ? `, ${now.turrets} on turrets` : ''}`);
    html += row('Hull', `${n0(now.hull)} hp`, 'hull', 'Every part\'s hit points together');
    if (now.shield > 0 || (was && was.shield > 0)) html += row('Shield', `${n0(now.shield)}`, 'shield');
    html += row('Cargo', `${n0(now.cargo)}`, 'cargo');
    // Cargo has mass (common/src/ships/load.ts): what the hold costs in thrust and turning, now and full of ore
    {
      const pct = (v: number) => `−${Math.round(v * 100)}%`;
      const load = this.deps.cargoMass?.() ?? 0;
      const full = cargoEffect(now, now.cargo * CATEGORY_MASS.mineral);
      const tip = 'Cargo has mass: a laden ship accelerates, turns and stops slower. It is weighed against the ship, so a bigger hull (or a hauler) minds the same load less; station storage weighs nothing';
      if (load > 0) {
        const e = cargoEffect(now, load);
        html += row('Hold now', `${load.toFixed(1)} mass · <span style="color:#fbbf24">${pct(e.thrustLoss)} thrust, ${pct(e.turnLoss)} turn</span>`, undefined, tip);
      }
      if (now.cargo > 0) html += row('Full of ore', `<span style="color:#fbbf24">${pct(full.thrustLoss)} thrust, ${pct(full.turnLoss)} turn</span>`, undefined, tip);
    }
    html += row('Jump drive', `${now.jump.toFixed(1)} km · ${Math.round(now.jumpCooldown)} s`, 'jump', 'Reach, and recharge time: from the jump coils (the core has one) against the size of the hull');
    {
      const note = jumpRatioNote(now.jumpRatio);
      html += row('Jump coils', `${now.jumpRatio.toFixed(2)}× the hull's need · <span style="color:${note.color}">${note.word}</span>`, 'jumpRatio', note.hint);
    }
    if (now.miners || (was && was.miners)) html += row('Mining lasers', `${now.miners}`, 'miners');
    // Burst Strafer and Tow Beam (common/src/ships/strafer.ts, tow.ts)
    if (now.dodge > 0 || (was && was.dodge > 0)) {
      const s = this.derived?.strafe;
      const ways = s ? ([[DODGE_FORWARD, 'forward'], [DODGE_BACK, 'back'], [DODGE_LEFT, 'left'], [DODGE_RIGHT, 'right']] as const).filter(([w]) => strafeForce(s, w) > 1e-6).map(([, n]) => n) : [];
      const best = s ? bestDodge(s).dir : 0;
      const cost = this.derived && best ? burstEnergy(this.derived, best) : 0;
      html += row('Dodge', now.dodge > 0 ? `+${n0(now.dodge)} m/s a burst · ${ways.length === 4 ? 'any way' : ways.join(', ') || 'no way'} · ${n0(cost)} energy` : '<span style="color:#f87171">none</span>', 'dodge',
        `Burst Strafers: press ${boundKeyName('dodge', settings.data.bindings)} for one hard burst (${((s?.ticks ?? 12) / 60).toFixed(2)} s) the way you're steering, diagonals too, with whichever strafers push that way; `
        + `with nothing held, back the other way from your last dodge. Ready again ${((s ? Math.max(s.ticks, s.cooldown) : 24) / 60).toFixed(2)} s after the last one started. `
        + 'There are no charges: every burst draws a lot of energy, from a capacitor bank the strafers touch first, then their circuit, so dodging often browns the circuit out unless banks, batteries and generation back it. '
        + 'A strafer pushes away from its nozzle: fit them facing different ways to dodge any way. The heavier the ship, the less a burst moves it');
    }
    if (now.tow > 0) html += row('Tow Beam', now.tow >= 0.5 ? 'ready' : '<span style="color:#f87171">no power</span>', 'tow',
      `Press ${boundKeyName('tow', settings.data.bindings)} to take hold of the wreck, debris or pod nearest your cursor; again to let go. What you tow slows you by its mass. `
      + "Tow it into a station's reach to salvage it into your storage. It draws power only while towing");
    for (const f of designFields(catalog, tuning, this.bp)) html += row(f.label, f.text);
    html += row('Mass', `${n0(now.mass)}`, 'mass');
    html += row('Loss cost', `${n0(now.rebuild)} cr`, 'rebuild', `If it's destroyed: the ${Math.round((1 - SALVAGE) * 100)}% of its minerals salvage doesn't bring back, at station prices (an insurance bond covers it)`);
    html += energyHtml(now.energy);
    return html + '<div style="margin-bottom:12px"></div>';
  }

  private renderStats(): void {
    const d = this.derived;
    const t = this.deps.tuning;
    const fmt = (v: number, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—');
    let html = this.buildHtml();
    html += this.ammoHtml();
    html += this.powerHtml();
    html += this.summaryHtml();
    html += `<details style="margin-bottom:10px"><summary style="cursor:pointer; color:#8ea0bd">Engineering details</summary><div style="font-family:'Courier New', monospace; font-size:11px; margin-top:6px">`;
    html += `<div>parts   ${this.bp.parts.length} / ${t.maxParts}</div>`;
    const bill = this.deps.econ.rebuildBill(this.bp.parts.filter((q) => q.fn !== 'core'));
    const billText = Object.entries(bill).map(([id, n]) => `${n} ${this.deps.econ.items.name(id).replace(/ Ore$/, '')}`).join(', ');
    if (billText) html += `<div style="color:#8ea0bd; margin-top:4px">rebuild if destroyed:</div><div style="white-space:normal">  ${billText}</div>`;
    if (d && d.mass > 0) {
      const a = (f: number) => fmt(f / d.mass, 3);
      html += `<div>mass    ${fmt(d.mass)}</div>`;
      html += `<div>inertia ${fmt(d.inertia, 0)}</div>`;
      html += `<div style="margin-top:6px; color:#8ea0bd">accel (u/tick²)</div>`;
      html += `<div>  fwd ${a(Math.max(d.maxThrust.forward, d.maneuverForce))}  back ${a(Math.max(d.maxThrust.back, d.maneuverForce))}</div>`;
      html += `<div>  left ${a(Math.max(d.maxThrust.left, d.maneuverForce))}  right ${a(Math.max(d.maxThrust.right, d.maneuverForce))}</div>`;
      html += `<div style="margin-top:6px; color:#8ea0bd">turn accel (rad/tick²)</div>`;
      html += `<div>  ⟳ ${fmt(d.maxTorque.cw / d.inertia, 4)}  ⟲ ${fmt(d.maxTorque.ccw / d.inertia, 4)}</div>`;
      html += `<div style="margin-top:6px; color:#8ea0bd">power</div>`;
      d.networks.forEach((n, k) => {
        if (n.demand === 0 && n.supply === 0) return;
        const ok = n.supply >= n.demand;
        html += `<div>  net ${k + 1}: <span style="color:${ok ? '#4ade80' : '#f2d24b'}">${fmt(n.supply, 1)}</span> / ${fmt(n.demand, 1)}</div>`;
      });
      html += `<div style="margin-top:6px; color:#8ea0bd">weapons (fire interval)</div>`;
      for (const w of d.weapons) {
        const arc = w.window ? ` turret ${Math.round(w.window.open.reduce((s, [lo, hi]) => s + hi - lo, 0) * 180 / Math.PI)}°` : '';
        html += `<div>  #${w.uid}: ${fmt(w.interval, 1)} ticks (${Math.round(w.satisfaction * 100)}%)${arc}</div>`;
      }
      const consumers = this.bp.parts.map((p, i) => ({ p, i })).filter(({ p }) => p.fn === 'thruster');
      if (consumers.length) {
        html += `<div style="margin-top:6px; color:#8ea0bd">thrusters</div>`;
        for (const { p, i } of consumers) html += `<div>  #${p.uid}: ${Math.round(d.satisfaction[i] * 100)}% power</div>`;
      }
    } else {
      html += `<div style="color:#8ea0bd">(no core: nothing attached)</div>`;
    }
    html += `</div></details>`;
    html += `<div style="color:#ffb547; font-weight:bold; margin:12px 0 6px;">PROBLEMS</div>`;
    html += this.errors.length
      ? this.errors.map((e) => `<div style="color:#f87171; margin-bottom:3px;">• ${e.message}</div>`).join('')
      : `<div style="color:#4ade80">none</div>`;
    this.stats.innerHTML = html;
    this.bindBuildButtons();
  }

  // -------------------------------------------------------------------------
  // Part tooltip
  // -------------------------------------------------------------------------

  private tipCtx(): PartTipCtx {
    return { catalog: this.deps.catalog, tuning: this.deps.tuning, econ: this.deps.econ, free: this.free, have: (id) => this.deps.have(id), canMake: (id) => this.deps.canMake(id) };
  }

  /** Show the tooltip at the mouse; its contents are only built when `key` changes */
  private showTip(key: string, html: () => string, x: number, y: number): void {
    if (key !== this.tipKey) {
      this.tipKey = key;
      this.tip.innerHTML = html();
      this.tip.style.display = 'block';
    }
    const w = this.tip.offsetWidth, h = this.tip.offsetHeight;
    const left = x + 18 + w > innerWidth - 8 ? x - 14 - w : x + 18;
    const top = Math.min(y + 16, innerHeight - h - 8);
    this.tip.style.left = `${Math.max(8, left)}px`;
    this.tip.style.top = `${Math.max(8, top)}px`;
  }

  private hideTip(): void {
    if (!this.tipKey) return;
    this.tipKey = '';
    this.tip.style.display = 'none';
  }

  /** The part under the mouse on the grid */
  private gridTip(e: MouseEvent): void {
    const i = this.mouse ? this.partAt(this.mouse) : -1;
    if (i < 0) return this.hideTip();
    const p = this.bp.parts[i];
    const { ghosts, fresh } = this.grantAll ? { ghosts: new Set<number>(), fresh: new Set<number>() } : this.ghostInfo();
    const hs = this.deps.hangarState();
    const rec = hs?.slots[this.slot];
    const isNew = fresh.has(p.uid) && hs !== null;
    const state = ghosts.has(p.uid) && !fresh.has(p.uid) ? 'ghost' : isNew ? 'new' : rec?.wrecked.includes(p.uid) ? 'wrecked' : 'built';
    // On the ship you're flying: how it's holding up
    let live: PartTipCtx['live'] = null;
    if (state === 'built' && hs && this.slot === hs.active) {
      const ship = this.deps.liveShip?.();
      const k = ship ? ship.blueprint.parts.findIndex((q) => q.uid === p.uid && partItemId(q) === partItemId(p)) : -1;
      if (ship && k >= 0 && !ship.ghost[k]) live = { hp: ship.hp[k], max: ship.maxHp[k], detached: ship.detached[k] };
    }
    const key = `g:${this.tipGen}:${p.uid}:${live ? `${Math.round((live.hp / live.max) * 100)}${live.detached ? 'x' : ''}` : ''}`;
    const mounting = this.mountingBroken.get(i)?.map(ruleText);
    this.showTip(key, () => partTipHtml(p, { ...this.tipCtx(), derived: this.derived, index: i, state, live, mounting }), e.clientX, e.clientY);
  }

  /** A palette part's tooltip (by item id): what it is, how many you have, what making it takes or what it waits on */
  private partTip(id: string, e: MouseEvent): void {
    const q = this.deps.econ.items.get(id)?.part ?? parsePartItemId(id);
    const f = q && this.deps.catalog.functions.get(q.fn);
    if (!q || !f) return;
    const left = this.remaining(id);
    const lock = f.model && !this.free && !this.deps.canMake(id) ? this.lockOf(f).why : '';
    this.showTip(`p:${this.tipGen}:${id}`, () => partTipHtml(q, { ...this.tipCtx(), state: 'palette', spare: left === Infinity ? 0 : Math.max(0, left), lock }), e.clientX, e.clientY);
  }

  // -------------------------------------------------------------------------
  // Canvas
  // -------------------------------------------------------------------------

  private toGrid(e: MouseEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left - r.width / 2) / this.view.px + this.view.cx, (e.clientY - r.top - r.height / 2) / this.view.px + this.view.cy];
  }

  private draw(): void {
    if (!this.isOpen) return;
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const { px, cx, cy } = this.view;
    this.lit.setView(px, cx, cy, w, h);
    // The grid layer: background, grid lines, turret arcs (under the ship)
    const gc = this.grid;
    if (gc.width !== w * dpr || gc.height !== h * dpr) { gc.width = w * dpr; gc.height = h * dpr; }
    let ctx = gc.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, w, h);
    const sx = (x: number) => (x - cx) * px + w / 2;
    const sy = (y: number) => (y - cy) * px + h / 2;

    // Grid
    ctx.lineWidth = 1;
    for (let gx = Math.floor(cx - w / 2 / px); gx <= cx + w / 2 / px; gx++) {
      ctx.strokeStyle = gx === 0 ? '#22314f' : '#121b2e';
      ctx.beginPath(); ctx.moveTo(sx(gx), 0); ctx.lineTo(sx(gx), h); ctx.stroke();
    }
    for (let gy = Math.floor(cy - h / 2 / px); gy <= cy + h / 2 / px; gy++) {
      ctx.strokeStyle = gy === 0 ? '#22314f' : '#121b2e';
      ctx.beginPath(); ctx.moveTo(0, sy(gy)); ctx.lineTo(w, sy(gy)); ctx.stroke();
    }
    ctx.fillStyle = '#3b4c6e';
    ctx.font = '11px sans-serif';
    ctx.fillText('▲ forward', sx(cx) - 26, 16);

    const path = (poly: Vec2[]) => {
      ctx.beginPath();
      poly.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
      ctx.closePath();
    };
    const bad = new Set(this.errors.flatMap((e) => e.uids));

    // Turret windows sit under the parts so the hull stays readable
    if (this.derived && this.overlays.arcs) {
      for (const w of this.derived.weapons) if (w.window) this.drawWindow(w.window, sx, sy, 1, ctx);
    }
    // The marks layer (over the ship)
    ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Parts (ghosts: not built yet, drawn faint and dashed; new since the last save: dashed amber)
    const { ghosts, fresh } = this.grantAll ? { ghosts: new Set<number>(), fresh: new Set<number>() } : this.ghostInfo();
    const wrecked = new Set(this.deps.hangarState()?.slots[this.slot]?.wrecked ?? []);
    this.geoms.forEach((g) => {
      const p = g.part;
      const ghost = ghosts.has(p.uid) && !fresh.has(p.uid);
      const isNew = fresh.has(p.uid) && this.deps.hangarState() !== null;
      path(g.polygon);
      const look = partColors(this.deps.catalog, p.fn, p.material, this.bp.paint ? parseInt(this.bp.paint.slice(1), 16) : undefined);
      // Built parts are drawn lit, as in flight (HangarLitView); a ghost (not built yet) is a faint flat shape
      if (ghost) {
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = numToCss(look.fill);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // Its outline only when it says something: a problem, new since the last save, or a ghost
      if (ghost || isNew || bad.has(p.uid)) {
        ctx.setLineDash(ghost || isNew ? [5, 4] : []);
        ctx.strokeStyle = bad.has(p.uid) ? '#ef4444' : isNew ? '#fbbf24' : '#7dd3fc';
        ctx.lineWidth = bad.has(p.uid) || isNew ? 2 : 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Guns' barrels (the hull draws the rest of its hardware); a ghost's all of it, faint
      drawDecor2d(ctx, g, (x, y) => [sx(x), sy(y)], px, ghost ? 0.35 : 1, gradeGlow(look.grade), !ghost);
      if (p.facing) this.drawFacing(g, p.facing as Side, sx, sy);
    });
    // Guns that break their mounting rules (a ship fitted before a rule changed): what's wrong, in red
    this.geoms.forEach((g, i) => {
      const broken = this.mountingBroken.get(i);
      if (broken) this.drawMounting(g, broken, sx, sy, false);
    });

    const d = this.derived;
    if (this.overlays.connectors) {
      ctx.strokeStyle = numToCss(CONNECTOR_COLOR);
      ctx.lineWidth = 2;
      for (const g of this.geoms) {
        for (const con of g.connectors) {
          const [a, b] = connectorEndpoints(con);
          ctx.setLineDash('diag' in con ? [4, 3] : []);
          // Pull edges slightly inside the part so both sides of a join stay visible
          const k = 0.08;
          const mx = g.centroid[0], my = g.centroid[1];
          ctx.beginPath();
          ctx.moveTo(sx(a[0] + (mx - a[0]) * k), sy(a[1] + (my - a[1]) * k));
          ctx.lineTo(sx(b[0] + (mx - b[0]) * k), sy(b[1] + (my - b[1]) * k));
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }
    if (this.overlays.joins) {
      ctx.strokeStyle = '#e5ecf7';
      ctx.lineWidth = 1;
      for (const [a, b] of computeJoins(this.geoms)) {
        const A = this.geoms[a].centroid, B = this.geoms[b].centroid;
        ctx.beginPath(); ctx.moveTo(sx(A[0]), sy(A[1])); ctx.lineTo(sx(B[0]), sy(B[1])); ctx.stroke();
        ctx.fillStyle = '#e5ecf7';
        ctx.beginPath(); ctx.arc(sx((A[0] + B[0]) / 2), sy((A[1] + B[1]) / 2), 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    // Power: the wires over the hull, each network its own colour (always, with the wires tool)
    if (d && (this.overlays.power || this.tool === 'wires')) this.drawPower(d, sx, sy);
    if (d && this.overlays.thrust) {
      ctx.strokeStyle = '#7dd3fc';
      ctx.fillStyle = '#7dd3fc';
      ctx.lineWidth = 1.25;
      ctx.globalAlpha = 0.4;
      for (const t of d.thrusters) {
        const [x0, y0] = t.pos;
        const x1 = x0 + t.force[0] * 0.6, y1 = y0 + t.force[1] * 0.6;
        arrow(ctx, sx(x0), sy(y0), sx(x1), sy(y1));
      }
      ctx.globalAlpha = 1;
    }
if (d && this.overlays.com && d.mass > 0) {
      const X = sx(d.com[0]), Y = sy(d.com[1]);
      ctx.strokeStyle = '#f472b6';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X, Y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X - 11, Y); ctx.lineTo(X + 11, Y); ctx.moveTo(X, Y - 11); ctx.lineTo(X, Y + 11); ctx.stroke();
    }

    // Ghost (the wires tool: the cell under the mouse)
    if (this.mouse && this.tool === 'wires') this.drawWireCursor(sx, sy);
    else if (this.mouse) {
      const cand = this.candidate(this.mouse);
      if (cand) {
        const g = placeGeometry(this.deps.catalog, cand);
        const problem = this.placementProblem(cand);
        path(g.polygon);
        ctx.fillStyle = problem ? 'rgba(239, 68, 68, 0.35)' : 'rgba(95, 212, 196, 0.35)';
        ctx.fill();
        ctx.strokeStyle = problem ? '#ef4444' : '#5fd4c4';
        ctx.lineWidth = 2;
        ctx.stroke();
        if (cand.facing) this.drawFacing(g, cand.facing, sx, sy);
        // Its mounting rules: the edge it bolts on at, the cells its barrel needs clear
        if (cand.facing) this.drawMounting(g, this.candidateMounting(cand, g), sx, sy, true);
        if (cand.facing && this.overlays.arcs && weaponMount(this.deps.catalog, cand) === 'turret') {
          // Preview where the new turret could fire (its own arc), given everything already placed
          const all = [...this.geoms, g];
          const arc = mountingOf(this.deps.catalog, cand.fn, this.deps.tuning)?.arc;
          this.drawWindow(computeTurretWindow(all, all.map(() => true), all.length - 1, cand.facing, this.deps.tuning, arc), sx, sy, problem ? 0.4 : 0.8);
        }
        if (problem) {
          ctx.fillStyle = '#fca5a5';
          ctx.font = '12px sans-serif';
          ctx.fillText(problem, sx(g.bbox.maxX) + 6, sy(g.bbox.minY) + 12);
        }
      }
    }
  }

  /** Turret window as wedges: open sectors green, sectors its own hull blocks red. */
  private drawWindow(w: TurretWindow, sx: (x: number) => number, sy: (y: number) => number, alpha: number, ctx = this.ctx): void {
    const r = 2.0 * this.view.px;
    const X = sx(w.pivot[0]), Y = sy(w.pivot[1]);
    const wedge = (lo: number, hi: number, fill: string) => {
      ctx.beginPath();
      ctx.moveTo(X, Y);
      ctx.arc(X, Y, r, w.center + lo, w.center + hi);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    ctx.globalAlpha = alpha;
    wedge(-w.half, w.half, 'rgba(239, 68, 68, 0.16)');
    for (const [lo, hi] of w.open) wedge(lo, hi, 'rgba(74, 222, 128, 0.28)');
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.8)';
    ctx.lineWidth = 1;
    for (const [lo, hi] of w.open) {
      for (const a of [lo, hi]) {
        ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X + Math.cos(w.center + a) * r, Y + Math.sin(w.center + a) * r); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The power overlay: each wire segment, cell centre to cell centre, in its
   * network's colour (a cut one dashed dark red); generators ringed and
   * batteries barred in their network's colour; what's left without power
   * outlined red (short of it, amber). With the wires tool, a dot on every
   * cell a wire can run through.
   */
  private drawPower(d: ShipDerived, sx: (x: number) => number, sy: (y: number) => number): void {
    const ctx = this.ctx, px = this.view.px, rep = this.power;
    if (!rep) return;
    const wiring = this.tool === 'wires';
    const X = (v: number) => sx(v + 0.5), Y = (v: number) => sy(v + 0.5);
    if (wiring) {
      const r = Math.max(1, px * 0.045);
      ctx.fillStyle = 'rgba(159, 179, 209, 0.45)';
      for (const k of wireCells(this.deps.catalog, this.bp, this.geoms).keys()) {
        const [x, y] = cellOf(k);
        ctx.fillRect(X(x) - r, Y(y) - r, r * 2, r * 2);
      }
    }
    const w = Math.max(2, px * (wiring ? 0.15 : 0.1));
    ctx.lineCap = 'round';
    // (a dark line under it, so a wire reads over any hull)
    ctx.strokeStyle = 'rgba(3, 5, 10, 0.8)';
    ctx.lineWidth = w + 3;
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of d.wires) { ctx.moveTo(X(x0), Y(y0)); ctx.lineTo(X(x1), Y(y1)); }
    ctx.stroke();
    ctx.lineWidth = w;
    d.wires.forEach(([x0, y0, x1, y1], s) => {
      const col = rep.seg[s];
      ctx.setLineDash(col ? [] : [w * 1.2, w * 1.4]);
      ctx.strokeStyle = col ?? '#9f2a2a';
      ctx.beginPath(); ctx.moveTo(X(x0), Y(y0)); ctx.lineTo(X(x1), Y(y1)); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';
    // Parts: what makes and stores power, in its network's colour; what lacks it
    const ring = Math.max(4, px * 0.26);
    this.geoms.forEach((g, i) => {
      const fn = this.deps.catalog.functions.get(g.part.fn);
      if (!fn) return;
      const net = rep.nets[d.network[i]], col = net?.color ?? DEAD_NET;
      const cx = sx(g.centroid[0]), cy = sy(g.centroid[1]);
      const st = rep.part[i];
      if (st === 'unpowered' || st === 'stranded' || st === 'short' || st === 'trickle' || st === 'idle') {
        // (amber: short of power, or on the core's trickle alone; grey: a capacitor touching nothing; red: none)
        const soft = st === 'short' || st === 'trickle';
        ctx.beginPath();
        g.polygon.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
        ctx.closePath();
        ctx.fillStyle = st === 'idle' ? 'rgba(148, 163, 184, 0.14)' : soft ? 'rgba(251, 191, 36, 0.12)' : 'rgba(239, 68, 68, 0.18)';
        ctx.fill();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = st === 'idle' ? '#94a3b8' : soft ? '#fbbf24' : '#ef4444';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        // (a struck-through bolt: no power)
        if (st === 'unpowered' || st === 'stranded') {
          ctx.fillStyle = '#fca5a5';
          ctx.font = `700 ${Math.max(10, Math.round(px * 0.42))}px 'Segoe UI', sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('⚡', cx, cy);
          ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(cx - ring * 0.7, cy + ring * 0.7); ctx.lineTo(cx + ring * 0.7, cy - ring * 0.7); ctx.stroke();
          ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        }
      }
      if ((fn.produce ?? 0) > 0) {
        ctx.strokeStyle = 'rgba(3, 5, 10, 0.8)'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(cx, cy, ring, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = col; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, ring, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = col;
        ctx.fillRect(cx - ring * 0.5, cy - 1.5, ring, 3); ctx.fillRect(cx - 1.5, cy - ring * 0.5, 3, ring);
      } else if ((fn.store ?? 0) > 0) {
        const bw = ring * 1.5, bh = ring * 0.9;
        ctx.fillStyle = 'rgba(3, 5, 10, 0.75)';
        ctx.fillRect(cx - bw / 2 - 2, cy - bh / 2 - 2, bw + 4, bh + 4);
        ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.strokeRect(cx - bw / 2, cy - bh / 2, bw, bh);
        ctx.fillStyle = col;
        ctx.fillRect(cx + bw / 2, cy - bh * 0.2, 3, bh * 0.4);
        ctx.fillRect(cx - bw / 2 + 3, cy - bh / 2 + 3, (bw - 6) * (net?.powered ? 0.7 : 0.15), bh - 6);
      }
    });
    this.drawCircuits(d, sx, sy, ring);
  }

  /**
   * Local circuits on the overlay: each circuit's letter on a badge by its
   * first generator (else store, else part), weak links outlined red with a
   * cut mark, and after a load test each part that browned out with its share
   */
  private drawCircuits(d: ShipDerived, sx: (x: number) => number, sy: (y: number) => number, ring: number): void {
    const ctx = this.ctx, rep = this.power, L = d.power;
    if (!rep || !L) return;
    const outline = (i: number, color: string, dash: number[]) => {
      const g = this.geoms[i];
      if (!g) return;
      ctx.beginPath();
      g.polygon.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
      ctx.closePath();
      ctx.setLineDash(dash);
      ctx.strokeStyle = color; ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const font = Math.max(10, Math.round(ring * 1.2));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // Weak links: the wire's single path (shoot it and what's beyond goes dark)
    for (const w of this.tool === 'wires' ? rep.weak.slice(0, 12) : []) {
      outline(w.part, '#f87171', [2, 3]);
      const g = this.geoms[w.part];
      if (g) { ctx.font = `700 ${font}px 'Segoe UI', sans-serif`; ctx.fillStyle = '#fca5a5'; ctx.fillText('✂', sx(g.centroid[0]), sy(g.centroid[1])); }
    }
    // The load test: what browned out, by how much
    const lt = this.loadRun && this.loadRun.sig === designSig(this.bp) ? this.loadRun.result : null;
    if (lt) {
      lt.part.forEach((v, i) => {
        if (v >= BROWNOUT || !this.geoms[i]) return;
        outline(i, v < 0.5 ? '#ef4444' : '#fb923c', []);
        const g = this.geoms[i];
        ctx.font = `700 ${Math.max(9, Math.round(font * 0.75))}px 'Segoe UI', sans-serif`;
        ctx.fillStyle = 'rgba(3, 5, 10, 0.75)';
        const tx = sx(g.centroid[0]), ty = sy(g.centroid[1]) + ring * 1.1;
        ctx.fillRect(tx - font * 1.1, ty - font * 0.45, font * 2.2, font * 0.9);
        ctx.fillStyle = v < 0.5 ? '#fca5a5' : '#fdba74';
        ctx.fillText(`${Math.round(v * 100)}%`, tx, ty);
      });
    }
    // Surge banks: their parts ringed violet, a short arc to each part they feed by touch, and their label
    for (const g of L.stores) {
      if (g.kind !== 'k') continue;
      ctx.strokeStyle = SURGE_COLOR; ctx.lineWidth = 2;
      for (const i of g.parts) {
        const q = this.geoms[i];
        if (!q) continue;
        ctx.beginPath();
        q.polygon.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
        ctx.closePath(); ctx.stroke();
      }
      const touchAll = [...(g.feeds ?? []), ...(g.shields ?? [])];
      ctx.lineWidth = 2.5;
      for (const j of touchAll) {
        const q = this.geoms[j];
        const from = g.parts.map((i) => this.geoms[i]).filter(Boolean).sort((a, b) => Math.hypot(a.centroid[0] - (q?.centroid[0] ?? 0), a.centroid[1] - (q?.centroid[1] ?? 0)) - Math.hypot(b.centroid[0] - (q?.centroid[0] ?? 0), b.centroid[1] - (q?.centroid[1] ?? 0)))[0];
        if (!q || !from) continue;
        // (a zigzag: Surge jumps by touch)
        const x0 = sx(from.centroid[0]), y0 = sy(from.centroid[1]), x1 = sx(q.centroid[0]), y1 = sy(q.centroid[1]);
        const nx = -(y1 - y0), ny = x1 - x0, len = Math.hypot(nx, ny) || 1, amp = ring * 0.35;
        ctx.beginPath(); ctx.moveTo(x0, y0);
        for (let s = 1; s <= 4; s++) { const t = s / 5, sgn = s % 2 ? 1 : -1; ctx.lineTo(x0 + (x1 - x0) * t + (nx / len) * amp * sgn, y0 + (y1 - y0) * t + (ny / len) * amp * sgn); }
        ctx.lineTo(x1, y1); ctx.stroke();
        ctx.fillStyle = SURGE_COLOR;
        ctx.beginPath(); ctx.arc(x1, y1, Math.max(2.5, ring * 0.22), 0, Math.PI * 2); ctx.fill();
      }
      const at = this.geoms[g.parts[0]];
      if (at) {
        const bx = sx(at.centroid[0]) + ring * 1.15, by = sy(at.centroid[1]) - ring * 1.15, r = Math.max(8, font * 0.7);
        ctx.fillStyle = 'rgba(3, 5, 10, 0.85)'; ctx.beginPath(); ctx.arc(bx, by, r + 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = SURGE_COLOR; ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0b1220'; ctx.font = `800 ${Math.round(r * 1.05)}px 'Segoe UI', sans-serif`;
        ctx.fillText(g.label ?? 'S', bx, by + 0.5);
      }
    }
    // Letters
    for (const ci of L.circuits) {
      if (!ci.letter) continue;
      const at = ci.generators[0] ?? ci.storeParts[0] ?? ci.consumers[0] ?? ci.parts[0];
      const g = at !== undefined ? this.geoms[at] : undefined;
      if (!g) continue;
      const net = rep.nets[ci.net], col = net?.color ?? circuitColor(ci.letter);
      const bx = sx(g.centroid[0]) + ring * 1.15, by = sy(g.centroid[1]) - ring * 1.15, r = Math.max(7, font * 0.62);
      ctx.fillStyle = 'rgba(3, 5, 10, 0.85)';
      ctx.beginPath(); ctx.arc(bx, by, r + 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0b1220';
      ctx.font = `800 ${Math.round(r * 1.35)}px 'Segoe UI', sans-serif`;
      ctx.fillText(ci.letter, bx, by + 0.5);
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }

  /** The wires tool's cursor: the cell under the mouse (amber to lay, red to erase, grey off the hull) */
  private drawWireCursor(sx: (x: number) => number, sy: (y: number) => number): void {
    const ctx = this.ctx, [x, y] = cellAt(this.mouse![0], this.mouse![1]);
    const on = this.onHull()(x, y), erase = this.wireDrag?.erase ?? this.wireErase;
    ctx.strokeStyle = !on ? '#4b5870' : erase ? '#f87171' : '#fbbf24';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx(x) + 1, sy(y) + 1, this.view.px - 2, this.view.px - 2);
    if (on) {
      ctx.fillStyle = erase ? 'rgba(248, 113, 113, 0.18)' : 'rgba(251, 191, 36, 0.16)';
      ctx.fillRect(sx(x) + 1, sy(y) + 1, this.view.px - 2, this.view.px - 2);
    }
  }

  /**
   * A gun's mounting rules on the grid: the edge it bolts on at (green when it does, red when it must and doesn't) and
   * the cells its barrel needs clear (shaded; red where something's in the way). `all`: everything (the part in hand);
   * else only what's broken.
   */
  private drawMounting(g: PlacedGeom, broken: MountingProblem[], sx: (x: number) => number, sy: (y: number) => number, all: boolean): void {
    const { catalog } = this.deps, ctx = this.ctx, px = this.view.px;
    const m = mountingOf(catalog, g.part.fn, undefined, g.part.mount);
    const sides = weaponSides(catalog, g.part);
    if (!m || !sides) return;
    const attachBad = broken.some((b) => b.rule === 'attach' || b.rule === 'angle');
    if ((all && m.rules) || attachBad) {
      const n = SIDE_NORMAL[sides.attach];
      ctx.strokeStyle = attachBad ? '#f87171' : m.attach === 'back' ? '#4ade80' : 'rgba(74, 222, 128, 0.45)';
      ctx.lineWidth = Math.max(3, px * 0.12);
      ctx.lineCap = 'round';
      const edges = facingEdges(g, sides.attach);
      for (const [a, b] of edges) {
        // (Just inside the part, so the hull it bolts to stays visible)
        const ix = -n[0] * 0.08, iy = -n[1] * 0.08;
        ctx.beginPath(); ctx.moveTo(sx(a[0] + ix), sy(a[1] + iy)); ctx.lineTo(sx(b[0] + ix), sy(b[1] + iy)); ctx.stroke();
      }
      // No straight edge there at all: a red ring where it would be
      if (!edges.length && attachBad) {
        const c = g.centroid;
        ctx.beginPath(); ctx.arc(sx(c[0] + n[0] * 0.45), sy(c[1] + n[1] * 0.45), 4, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.lineCap = 'butt';
    }
    const blocked = new Set((broken.find((b) => b.rule === 'clear')?.cells ?? []).map((c) => `${c[0]},${c[1]}`));
    if (all || blocked.size) {
      for (const [x, y] of clearCells(catalog, g)) {
        const bad = blocked.has(`${x},${y}`);
        if (!all && !bad) continue;
        ctx.fillStyle = bad ? 'rgba(248, 113, 113, 0.35)' : 'rgba(253, 224, 71, 0.13)';
        ctx.fillRect(sx(x) + 2, sy(y) + 2, px - 4, px - 4);
        ctx.strokeStyle = bad ? '#f87171' : 'rgba(253, 224, 71, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(sx(x) + 2, sy(y) + 2, px - 4, px - 4);
        ctx.setLineDash([]);
      }
    }
  }

  private drawFacing(g: PlacedGeom, side: Side, sx: (x: number) => number, sy: (y: number) => number): void {
    const ctx = this.ctx;
    const n = SIDE_NORMAL[side];
    ctx.fillStyle = isWeaponFn(g.part.fn) ? '#ffb4a8' : '#9fd0ff';
    for (const [a, b] of facingEdges(g, side)) {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const tx = -n[1] * 0.25, ty = n[0] * 0.25;
      ctx.beginPath();
      ctx.moveTo(sx(mx + tx), sy(my + ty));
      ctx.lineTo(sx(mx - tx), sy(my - ty));
      ctx.lineTo(sx(mx + n[0] * 0.35), sy(my + n[1] * 0.35));
      ctx.closePath();
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------------------
// Little DOM helpers
// ---------------------------------------------------------------------------

const PIECE_LABEL: Record<string, string> = {
  sq: 'square', rect2: 'panel', tri: 'wedge', slope2: 'slope', cap: 'nose', round: 'round',
  fillet: 'fillet', block2: 'block', block3: 'long', round2: 'dome', fillet2: 'wide fillet', nose2: 'wedge nose',
};

/** A broken mounting rule without its "Pip 3: " (the part is the one in hand or under the mouse) */
function ruleText(m: MountingProblem): string {
  return m.message.replace(/^[^:]*?\d+: /, '');
}

function esc(t: string): string {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function btnCss(bg: string): string {
  return `background:${bg}; color:#fff; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px 10px; cursor:pointer; font:12px 'Segoe UI', sans-serif; flex:1;`;
}

function label(text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = text;
  s.style.color = '#8ea0bd';
  return s;
}

/** The palette's category tabs, in order (functions.json `category`) */
const CATEGORIES: { id: string; label: string; color: string }[] = [
  { id: 'structure', label: 'Structure', color: '#8ea0bd' },
  { id: 'weapons', label: 'Weapons', color: '#e05a4a' },
  { id: 'power', label: 'Power', color: '#fbbf24' },
  { id: 'engines', label: 'Engines', color: '#60a5fa' },
  { id: 'shields', label: 'Shields', color: '#5fd4c4' },
  { id: 'utility', label: 'Utility', color: '#a3e635' },
  { id: 'core', label: 'Core', color: '#f0abfc' },
];

function categoryOf(catalog: Catalog, fn: string): string {
  const c = catalog.functions.get(fn)?.category ?? 'structure';
  return CATEGORIES.some((k) => k.id === c) ? c : 'structure';
}

/** A function's palette filter: its category (the core goes with structure) */
function filterCat(catalog: Catalog, fn: string): string {
  const c = categoryOf(catalog, fn);
  return c === 'core' ? 'structure' : c;
}

/** Weapons in families by what they fire (legendaries on their own) */
const WEAPON_FAMILY: Record<string, string> = {
  cannon: 'Guns', autocannon: 'Guns', railgun: 'Guns', flak: 'Guns', mortar: 'Guns',
  laser: 'Beams', pulse: 'Beams', lance: 'Beams', arc: 'Beams',
  missile: 'Launchers', torpedo: 'Launchers',
  emp: 'Disruptors',
};
const FAMILIES = ['Guns', 'Beams', 'Launchers', 'Disruptors', 'Legendary', 'Other'];

function weaponGroups(catalog: Catalog, ids: string[]): { label: string; ids: string[] }[] {
  const out = FAMILIES.map((label) => ({ label, ids: [] as string[] }));
  for (const id of ids) {
    const f = catalog.functions.get(id);
    const fam = f?.rarity === 'legendary' ? 'Legendary' : WEAPON_FAMILY[f?.weapon ?? ''] ?? 'Other';
    out.find((g) => g.label === fam)!.ids.push(id);
  }
  return out;
}

/** A section heading that folds its section away (▸ folded, ▾ open) */
function foldHeading(text: string, folded: boolean, onToggle: () => void): HTMLDivElement {
  const d = heading(`${folded ? '▸' : '▾'} ${text}`);
  d.style.cursor = 'pointer';
  d.onclick = onToggle;
  return d;
}

function heading(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.textContent = text.toUpperCase();
  d.style.cssText = 'color:#ffb547; font-weight:bold; letter-spacing:1px; margin: 2px 0 5px; font-size: 11px;';
  return d;
}

function button(text: string, onClick: () => void, bg = '#1a2540'): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.style.cssText = `background:${bg}; color:#e5ecf7; border:1px solid #2a3a5a; border-radius:4px; padding:5px 10px; cursor:pointer;`;
  b.onclick = onClick;
  return b;
}

function chip(text: string, active: boolean, color: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.innerHTML = `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${color};margin-right:5px;vertical-align:-1px"></span>${text}`;
  b.style.cssText = `background:${active ? '#24406b' : '#0f1626'}; color:#cfd8e6; border:1px solid ${active ? '#5fd4c4' : '#2a3a5a'};
    border-radius:4px; padding:3px 7px; cursor:pointer; font-size: 11px;`;
  b.onclick = onClick;
  return b;
}

function checkbox(text: string, value: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const l = document.createElement('label');
  l.style.cssText = 'display:block; margin-bottom:4px; cursor:pointer;';
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = value;
  i.style.marginRight = '6px';
  i.onchange = () => onChange(i.checked);
  l.append(i, text);
  return l;
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - 5 * Math.cos(a - 0.4), y1 - 5 * Math.sin(a - 0.4));
  ctx.lineTo(x1 - 5 * Math.cos(a + 0.4), y1 - 5 * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
}

/** Small inline SVG of a piece variant for the palette. */
function pieceIcon(catalog: Catalog, id: string, rot: Rot, flip: boolean): string {
  const v = getVariant(catalog, id, rot, flip);
  const xs = v.polygon.map((p) => p[0]), ys = v.polygon.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const size = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
  const pts = v.polygon.map(([x, y]) => `${((x - minX) / size) * 26 + 2},${((y - minY) / size) * 26 + 2}`).join(' ');
  return `<svg width="26" height="26" viewBox="0 0 30 30"><polygon points="${pts}" fill="#24406b" stroke="#9fb3d1" stroke-width="1"/></svg>`;
}

/**
 * The hangar's energy readout (energy.ts): the batteries, what the generators
 * spare, and how long they last cruising, boosting and firing. Engines draw on
 * the general and drive batteries; guns on the general and weapon batteries,
 * and only from what the engines leave.
 */
function energyHtml(e: ShipSummary['energy']): string {
  const lasts = (store: number, draw: number, spare: number) => {
    const net = spare - draw;
    if (net >= -1e-6) return `<span style="color:#4ade80">${draw > 0 ? `charges +${net.toFixed(0)}/s` : '—'}</span>`;
    if (store <= 0) return '<span style="color:#f87171">no battery</span>';
    const t = store / -net;
    return `<span style="color:${t >= 20 ? '#fbbf24' : '#f87171'}">${Math.max(0.1, t).toFixed(t < 10 ? 1 : 0)} s</span>`;
  };
  const row = (label: string, value: string, tip: string) =>
    `<div style="display:flex; justify-content:space-between; padding:2px 0" title="${tip}"><span style="color:#8ea0bd">${label}</span>${value}</div>`;
  const leftover = Math.max(0, e.spare - e.engineDraw);
  const gunsTime = e.max + e.weaponMax > 0 && e.weaponDraw > leftover ? (e.max + e.weaponMax) / (e.weaponDraw - leftover) : Infinity;
  return `<div style="color:#ffb547; font-weight:bold; margin:10px 0 4px; letter-spacing:1px">ENERGY</div>`
    + row('Battery', `<b style="color:#e5ecf7">${Math.round(e.max)}</b>`, 'The core battery plus standard batteries: engines and guns both draw on it')
    + (e.driveMax ? row('Drive batteries', `<b style="color:#93c5fd">${Math.round(e.driveMax)}</b>`, 'Engines only') : '')
    + (e.weaponMax ? row('Weapon batteries', `<b style="color:#fca5a5">${Math.round(e.weaponMax)}</b>`, 'Guns and mining lasers only') : '')
    + row('Spare power', `<b style="color:#e5ecf7">${e.spare.toFixed(0)}/s</b>`, 'Generator power left after shields, scanners and jump coils: engines take it first, the rest charges the batteries')
    + row('Cruising', lasts(e.max + e.driveMax, e.engineDraw, e.spare), 'Engines thrusting: how long the batteries last (or how fast they charge)')
    + row('Boosting', lasts(e.max + e.driveMax, e.boostDraw, e.spare), 'Engines boosting')
    + row('Firing, cruising', gunsTime === Infinity ? '<span style="color:#4ade80">sustained</span>' : `<span style="color:${gunsTime >= 20 ? '#fbbf24' : '#f87171'}">${gunsTime.toFixed(gunsTime < 10 ? 1 : 0)} s</span>`,
      'Every gun firing flat out while the engines thrust: guns only get what the engines leave, and stored charge')
    + (gunsTime < 12 ? `<div style="color:#fbbf24; font-size:11px; margin-top:4px">The guns run dry fast in a fight, then wait for charge. Add a generator, or a battery (a weapon battery holds most for guns).</div>` : '');
}
