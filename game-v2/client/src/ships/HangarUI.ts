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
 * Wiring is retired (docs/design/energy-routing-impl.md D1): there is no
 * wire tool and no wire is drawn. A saved design's wires stay in it (pruned
 * as parts go) for the old energy system, which still auto-wires inside until
 * the switch-over. The power overlay marks generators and batteries and what's
 * left without power; P5 replaces it with the energy overlay.
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
 * Wheel: zoom · arrow keys: pan · Esc / H: close
 */

import {
  Blueprint, Catalog, Economy, Bag, partItemId, isWeaponFn, PlacedPart, PlacedGeom, Rot, Side, ShipTuning, ShipDerived, Vec2,
  SIDES, SIDE_NORMAL, placeGeometry, overlapsAny, computeJoins, facingEdges, facingProblem, geomContainsPoint,
  validateBlueprint, nextFreeUid, floodFill, partNeedsFacing, createShipState, connectorEndpoints, getVariant,
  BlueprintError, TurretWindow, computeTurretWindow, ClientMessage, ServerHangarMessage, partDemand, parsePartItemId,
  isStructural, ghostBill, SALVAGE, ShipState, buildPoints, DAMAGE_NAMES, type DamageType,
  loadoutKinds, cratesFor, crateOrder, MAX_LOADOUT_CRATES, wireCells, cellKey,
  type FunctionDef, mountingOf, weaponSides, clearCells, partMountingProblems, type MountingProblem,
  cellMap, exhaustProblem } from '@space-game/common';
import { cargoEffect, CATEGORY_MASS, strafeForce, bestDodge, burstEnergy, DODGE_FORWARD, DODGE_BACK, DODGE_LEFT, DODGE_RIGHT } from '@space-game/common';
import { bankKind, gunDrawFlatOut, energyTuning, loadTest, BROWNOUT, type LoadTestResult } from '@space-game/common';
import { settings } from '../settings/Settings';
import { boundKeyName } from '../input/keybindings';
import { costHtml } from '../ui/windowKit';
import { CONNECTOR_COLOR, functionColor, numToCss } from './shipColors';
import { powerReport, pruneWires, DEAD_NET, type PowerReport } from './wireEdit';
import { portsReport, portsWarnings } from './portsReport';
import { PortsGrid, portsPanelHtml } from './portsGrid';

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
  /** Station storage's count of an item (unused since wire spools stopped being billed) */
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

type Overlay = 'energy' | 'connectors' | 'joins' | 'power' | 'com' | 'thrust' | 'arcs';
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
  private overlays: Record<Overlay, boolean> = { energy: true, connectors: false, joins: false, power: true, com: true, thrust: true, arcs: true };
  /** The energy overlay of a ports design (portsOverlay.ts): its layer, the load test it shows, and the port under the mouse */
  private ports = new PortsGrid();
  /** The power overlay's networks and warnings (from the design's derived state) */
  private power: PowerReport | null = null;
  /** The last load test (local circuits): which, on which design (it's dropped once the design changes), and what it found */
  /** The boost-and-fire load test of the derived design (the POWER panel's warning, the overlay's browned-out parts) */
  private loadRun: { for: ShipDerived; result: LoadTestResult } | null = null;
  private bothTest(): LoadTestResult | null {
    const d = this.derived;
    if (!d) return null;
    if (this.loadRun?.for !== d) this.loadRun = { for: d, result: loadTest(d, this.deps.tuning, { fire: true, thrust: true, boost: true, seconds: LOAD_TEST_SECONDS }) };
    return this.loadRun.result;
  }
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
      this.ports.hover(this.overlays.energy ? this.derived : null, this.mouse);
      this.draw();
      this.gridTip(e);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 1 || !this.pan) return;
      const pan = this.pan;
      this.pan = null;
      this.canvas.style.cursor = 'crosshair';
      if (!pan.moved) this.pickUp(pan.at);
    });
    this.canvas.addEventListener('mouseleave', () => { this.mouse = null; this.draw(); this.hideTip(); });
    this.canvas.addEventListener('mousedown', (e) => {
      const g = this.toGrid(e);
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
      this.bp = { name: 'New ship', catalogVersion: this.deps.catalog.version, power: 'ports', parts: [
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
    else if (code === 'KeyE') { this.overlays.energy = !this.overlays.energy; this.renderStats(); }
    else if (code === 'KeyT') {
      const order: (Side | 'auto')[] = ['auto', ...SIDES];
      this.sel.facing = order[(order.indexOf(this.sel.facing) + 1) % order.length];
    } else if (code === 'Escape' || code === 'KeyH') { this.close(null); return true; }
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
    // (Free, or for a Diode joined: partFacingRule)
    const free = (side: Side) => !facingProblem(p.fn, all, all.length - 1, side);
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
    // (A Diode's instead must touch a part: power leaves by it)
    if (p.facing) {
      const why = facingProblem(p.fn, [...this.geoms, g], this.geoms.length, p.facing as Side);
      if (why === 'noEdge') return `no straight edge facing ${p.facing} on this piece: press T for another side`;
      if (why === 'blocked') return `its ${p.facing} edge is blocked: press T for another side`;
      if (why === 'notJoined') return `its ${p.facing} edge (where power leaves) must touch a part: press T for another side`;
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

  /** Is a cell under one of the design's parts (where saved wire stays) */
  private onHull(): (x: number, y: number) => boolean {
    const cells = wireCells(this.deps.catalog, this.bp, this.bp.parts.map((p) => placeGeometry(this.deps.catalog, p)));
    return (x, y) => cells.has(cellKey(x, y));
  }

  private newBlueprint(): void {
    this.bp = { name: 'New ship', catalogVersion: this.deps.catalog.version, power: 'ports', parts: [
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
    // (and each engine whose exhaust the ship blocks: a warning, its lost thrust, never a refusal: common mounting.ts engineExhaust)
    const standing = cellMap(this.geoms);
    this.geoms.forEach((_, i) => {
      const b = partMountingProblems(catalog, this.geoms, i), ex = exhaustProblem(catalog, this.geoms, i, standing);
      if (ex) b.push(ex);
      if (b.length) this.mountingBroken.set(i, b);
    });
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
    // (Every design runs on the ports core: an older pool design opened here is shown and saved as one; the server decides too)
    this.bp.power = 'ports';
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
   * The palette: the part in hand, a category
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
    info.innerHTML = `Click places · right-click removes · <b style="color:#9fb0cc">middle-click picks a part up</b><br>R turn · F mirror · T facing · E energy overlay · wheel zooms · middle-drag or arrows pan`;
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
    // The ports load test's rows pick what the energy overlay shows; its toggle shows or hides it
    this.stats.querySelectorAll<HTMLElement>('[data-scn]').forEach((b) => b.onclick = () => { this.ports.scenario = b.dataset.scn as typeof this.ports.scenario; this.overlays.energy = true; this.renderStats(); this.renderPalette(); this.draw(); });
    act('energy', () => { this.overlays.energy = !this.overlays.energy; this.renderStats(); this.renderPalette(); this.draw(); });
    act('all', () => this.deps.send({ type: 'slotBuild', slot: this.slot }));
    act('fly', () => { this.deps.send({ type: 'slotFly', slot: this.slot }); this.close(null); });
    act('clear', () => {
      const rec = this.deps.hangarState()?.slots[this.slot];
      if (rec?.loaner || confirm(`Scrap the ${rec?.blueprint.name ?? 'ship'}? Its built parts break down: ${Math.round(SALVAGE * 100)}% of their minerals come back as ore, and every component.`)) this.deps.send({ type: 'slotClear', slot: this.slot });
    });
  }

  /**
   * Power: each network (in its overlay colour) with its generators and
   * batteries and what it makes against what's drawn on it, and what's left
   * without power; then the ship's pool and Output, its banks, and the load
   * test. (The networks are the old energy system's: P5 replaces this with the
   * energy overlay's report.)
   */
  private powerHtml(): string {
    const rep = this.power, d = this.derived;
    if (d?.ports) return this.portsHtml(d.ports);
    if (!rep || !d) return '';
    let html = `<div style="display:flex; align-items:baseline; margin-bottom:4px"><b style="color:#ffb547; letter-spacing:1px">POWER</b></div>`;
    const nets = rep.nets.map((n, k) => ({ n, k })).filter(({ n }) => n.generators.length || n.batteries.length || n.demand > 0);
    if (!nets.length) html += '<div style="color:#6b7a93; font-size:11px; margin-bottom:4px">No generator on this ship.</div>';
    for (const { n, k } of nets) {
      const gens = n.generators.length, bats = n.batteries.length;
      const what = [gens ? `${gens} generator${gens > 1 ? 's' : ''}` : 'no generator', bats ? `${bats} batter${bats > 1 ? 'ies' : 'y'}` : ''].filter(Boolean).join(' · ');
      const ok = n.supply >= n.demand - 1e-6;
      html += `<div style="display:flex; align-items:center; gap:6px; padding:2px 0; border-bottom:1px solid #18223a; font-size:11px" title="${n.parts.length} parts on it">`
        + `<span style="width:10px; height:10px; border-radius:2px; flex-shrink:0; background:${n.color}"></span><span style="color:#cfd8e6; white-space:nowrap">Network ${k + 1}</span><span style="color:#8ea0bd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${what}</span>`
        + `<span style="margin-left:auto; white-space:nowrap" title="Made / drawn steadily (engines and guns draw on the batteries)"><b style="color:${!n.powered ? '#8ea0bd' : ok ? '#4ade80' : '#fbbf24'}">+${Math.round(n.supply)}</b><span style="color:#6b7a93"> / ${Math.round(n.demand)}</span></span></div>`;
    }
    // The ship's numbers in four lines, its banks, and the one load-test warning (rework 2026-11 section 2.4)
    const L = d.power, n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');
    if (L) {
      const line = (t: string, tip = '') => `<div style="font-size:11px; color:#8ea0bd; padding:2px 0" ${tip ? `title="${tip}"` : ''}>${t}</div>`;
      const gen = rep.nets.reduce((s, n) => s + (n.powered ? n.supply : 0), 0), steady = Math.max(0, gen - L.spare);
      html += line(`Generation ${n0(gen)}/s · steady loads ${n0(steady)}/s · spare ${n0(L.spare)}/s`, 'What the generators make, what shields, scanners and coils take first, and what is left for the stores and the guns');
      const nb = L.pool.parts.length;
      html += line(`Store ${n0(L.pool.cap)} (core ${n0(L.pool.coreCap)}${nb ? ` + ${nb} ${nb === 1 ? 'battery' : 'batteries'}` : ''}) · Output ${n0(L.spare + L.pool.rate)}/s`, 'Your ship can give out at most its Output each second. Short of it, engines, guns and banks refilling share it by what each asks: thrust drops and guns reload slower. A bank asks for its intake, so it raises the share of what it feeds');
      const boost = energyTuning(this.deps.tuning).boostDraw;
      let eng = 0, engBoost = 0, guns = 0;
      for (const t of new Set(d.thrusters.filter((x) => x.force[0] || x.force[1]).map((x) => x.part))) { eng += L.draw[t]; engBoost += L.draw[t] * (1 + boost * L.boostDrain[t]); }
      for (const w of d.weapons) if (L.feedOf[w.part] >= 0) guns += gunDrawFlatOut(w, L.draw[w.part]);
      html += line(`Flat out: engines ${n0(eng)}/s (boosting ${n0(engBoost)}/s) · guns ${n0(guns)}/s`);
      const partName = (i: number) => { const p = this.bp.parts[i], fn = this.deps.catalog.functions.get(p.fn); return fn?.name ?? p.fn; };
      const r = this.bothTest();
      if (r && (guns > 0 || eng > 0)) {
        const unbanked = d.weapons.filter((w) => L.feedOf[w.part] >= 0 && !L.feeds[L.feedOf[w.part]].banks.length && gunDrawFlatOut(w, L.draw[w.part]) > 0);
        const share = unbanked.length ? Math.min(...unbanked.map((w) => r.part[w.part])) : 1;
        const act = guns > 0 ? 'Boosting while firing' : 'Boosting';
        // (Short of Output, the engines and the unbanked guns get the same share of what each asks: energy.ts powerTick)
        const both = Math.min(share, r.engines);
        if (r.brownAt >= 0 && share < BROWNOUT) html += `<div style="font-size:11px; padding:1px 0 3px; color:${both < 0.5 ? '#f87171' : '#fbbf24'}" title="Short of Output, everything drawing on it gets the same share of what it asks. A Capacitor bank touching the guns pays them first">⚠ Boosting while firing: engines and unbanked guns share the Output, down to ${Math.round(both * 100)}% each</div>`;
        else if (r.brownAt >= 0) html += `<div style="font-size:11px; padding:1px 0 3px; color:#fbbf24">⚠ ${act}: engines get ${Math.round(r.engines * 100)}%</div>`;
        else html += `<div style="font-size:11px; padding:1px 0 3px; color:#4ade80">Holds up: full power while ${guns > 0 ? 'boosting and firing' : 'boosting'}</div>`;
      }
      L.banks.forEach((B, k) => {
        const fed = [...new Set([...B.feeds, ...B.shields].map(partName))].join(', ');
        const never = !B.refills && B.dynamo <= 0;
        html += `<div style="font-size:11px; padding:1px 0; color:${never ? '#94a3b8' : B.kind === 'drive' ? '#7dd3fc' : '#fbbf24'}">Bank ${k + 1} (${B.parts.length} ${B.kind === 'drive' ? 'Drive Cell' : 'Capacitor'}${B.parts.length > 1 ? 's' : ''}) ${n0(B.cap)} · ${n0(B.rate)}/s → ${fed ? esc(fed) : 'feeds nothing'}${never ? ' · never refills' : ''}</div>`;
      });
    }
    if (rep.warnings.length) {
      html += `<div style="margin:5px 0 2px; font-size:11px; line-height:1.45">${rep.warnings.slice(0, 6).map((w) => `<div style="color:${/no power/.test(w) ? '#f87171' : '#fbbf24'}">• ${esc(w.charAt(0).toUpperCase() + w.slice(1))}</div>`).join('')}`
        + `${rep.warnings.length > 6 ? `<div style="color:#6b7a93">and ${rep.warnings.length - 6} more</div>` : ''}</div>`;
    } else if (nets.length) html += '<div style="color:#4ade80; font-size:11px; margin-top:4px">Everything that uses power has it.</div>';
    return html + '<div style="margin-bottom:12px"></div>';
  }

  /** A part's display name (its model's) by index */
  private partName(i: number): string {
    const p = this.bp.parts[i], fn = p && this.deps.catalog.functions.get(p.fn);
    return fn?.name ?? p?.fn ?? '?';
  }

  /** Power on a ports design: what the generators make and the stores hold, what the routing leaves out (portsReport.ts), then the load test (portsGrid.ts) */
  private portsHtml(L: NonNullable<ShipDerived['ports']>): string {
    const r = portsReport(L), n0 = (v: number) => Math.round(v).toLocaleString();
    const name = (i: number) => this.partName(i);
    const warn = portsWarnings(r, name);
    let html = '<div style="display:flex; align-items:baseline; margin-bottom:4px"><b style="color:#ffb547; letter-spacing:1px">POWER</b></div>';
    html += `<div style="font-size:11px; color:#8ea0bd; padding:2px 0" title="Power moves only out of an out port into an in port across a shared edge: generators give at their front, stores take at the back and give at the front, guns and engines take at their back, the core takes at its sides">Generation ${n0(r.supply)}/s · stores hold ${n0(r.store)} · ${r.links} link${r.links === 1 ? '' : 's'}</div>`;
    if (warn.length) html += `<div style="margin:5px 0 2px; font-size:11px; line-height:1.45">${warn.slice(0, 6).map((w) => `<div style="color:${/no power/.test(w) ? '#f87171' : '#fbbf24'}">• ${esc(w)}</div>`).join('')}${warn.length > 6 ? `<div style="color:#6b7a93">and ${warn.length - 6} more</div>` : ''}</div>`;
    else html += '<div style="color:#4ade80; font-size:11px; margin-top:4px">Every gun, engine and tool is fed.</div>';
    if (this.derived) html += portsPanelHtml(this.derived, this.ports.scenario, this.overlays.energy, name);
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
      const s = this.derived?.fx?.strafe;
      const ways = s ? ([[DODGE_FORWARD, 'forward'], [DODGE_BACK, 'back'], [DODGE_LEFT, 'left'], [DODGE_RIGHT, 'right']] as const).filter(([w]) => strafeForce(s, w) > 1e-6).map(([, n]) => n) : [];
      const best = s ? bestDodge(s).dir : 0;
      const cost = this.derived && best ? burstEnergy(this.derived, best) : 0;
      html += row('Dodge', now.dodge > 0 ? `+${n0(now.dodge)} m/s a burst · ${ways.length === 4 ? 'any way' : ways.join(', ') || 'no way'} · ${n0(cost)} energy` : '<span style="color:#f87171">none</span>', 'dodge',
        `Burst Strafers: press ${boundKeyName('dodge', settings.data.bindings)} for one hard burst (${((s?.ticks ?? 12) / 60).toFixed(2)} s) the way you're steering, diagonals too, with whichever strafers push that way; `
        + `with nothing held, back the other way from your last dodge. Ready again ${((s ? Math.max(s.ticks, s.cooldown) : 24) / 60).toFixed(2)} s after the last one started. `
        + 'There are no charges: every burst draws a lot of energy, from a Drive Cell bank the strafer touches first, then the ship, so dodging often browns the ship out unless Drive Cells, batteries and generation back it. '
        + 'A strafer pushes away from its nozzle: fit them facing different ways to dodge any way. The heavier the ship, the less a burst moves it');
    }
    if (now.tow > 0) html += row('Tow Beam', now.tow >= 0.5 ? 'ready' : '<span style="color:#f87171">no power</span>', 'tow',
      `Press ${boundKeyName('tow', settings.data.bindings)} to take hold of the wreck, debris or pod nearest your cursor; again to let go. What you tow slows you by its mass. `
      + "Tow it into a station's reach to salvage it into your storage. It draws power only while towing");
    for (const f of designFields(catalog, tuning, this.bp)) html += row(f.label, f.text);
    html += row('Mass', `${n0(now.mass)}`, 'mass');
    html += row('Loss cost', `${n0(now.rebuild)} cr`, 'rebuild', `If it's destroyed: the ${Math.round((1 - SALVAGE) * 100)}% of its minerals salvage doesn't bring back, at station prices (an insurance bond covers it)`);
    html += energyHtml(now.energy, this.derived, this.deps.tuning);
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
    // (A port under the mouse, on the energy overlay: its rating, what it links to, the flow on it)
    const port = this.ports.tip(this.derived, (i) => this.partName(i));
    if (port) return this.showTip(`port:${this.tipGen}:${port.key}`, port.html, e.clientX, e.clientY);
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
    // Guns that break their mounting rules (a ship fitted before a rule changed), engines with a blocked exhaust: what's wrong, in red
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
    // Power: generators, batteries and what lacks power, each network its own colour
    if (d && !d.ports && this.overlays.power) this.drawPower(d, sx, sy);
    // Energy (a ports design): ports, links with their flow, stores' fill, what the load test left short (portsGrid.ts)
    if (d?.ports && this.overlays.energy) this.ports.draw(ctx, d, this.geoms, { px, cx, cy, w, h, dpr });
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

    // Ghost
    if (this.mouse && !this.ports.hovering) {
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
        // Its ports, turned and flipped as it would go, and the parts they would link to (portsGrid.ts)
        if (!d || d.ports) this.ports.drawGhost(ctx, d, this.geoms, cand, g, this.deps.catalog, { px, cx, cy, w, h, dpr }, !problem, (i) => this.partName(i));
        if (problem) {
          ctx.fillStyle = '#fca5a5';
          ctx.font = '12px sans-serif';
          ctx.fillText(problem, sx(g.bbox.maxX) + 6, sy(g.bbox.minY) + 12);
        } else this.drawFeedPreview(cand, g, sx, sy);
      }
    }
  }

  private feedPreviewKey = '';
  private feedPreviewFor: ShipDerived | null = null;
  private feedPreviewVal: { feeds: number[]; hint: string } | null = null;

  /**
   * What a bank part in hand would feed (rework 2026-11 §2.4): the design with it added, run through the same power
   * layout. A Capacitor's bank (with the ones it joins) feeds guns, a Drive Cell's engines and strafers, a Pulse Dynamo
   * charges the banks it touches. Cached per candidate
   */
  private feedPreview(cand: PlacedPart): { feeds: number[]; hint: string } | null {
    const { catalog, tuning } = this.deps, fn = catalog.functions.get(cand.fn);
    if (!fn) return null;
    const kind = bankKind(fn), dynamo = (fn.dynamo ?? 0) > 0;
    if (!kind && !dynamo) return null;
    const key = JSON.stringify(cand);
    if (key === this.feedPreviewKey && this.derived === this.feedPreviewFor) return this.feedPreviewVal;
    this.feedPreviewKey = key;
    this.feedPreviewFor = this.derived;
    this.feedPreviewVal = null;
    try {
      const L = createShipState(catalog, tuning, 0, { ...this.bp, parts: [...this.bp.parts, cand] }, 0).derived.power;
      const at = this.bp.parts.length;
      if (!L) return null;
      const feeds = new Set<number>();
      if (kind) { const B = L.banks[L.bankOf[at]]; if (B) { for (const j of B.feeds) feeds.add(j); for (const j of B.shields) feeds.add(j); } }
      else for (const B of L.banks) if (B.dynamos.includes(at)) for (const i of B.parts) feeds.add(i);
      this.feedPreviewVal = {
        feeds: [...feeds].filter((j) => j < at),
        hint: kind === 'drive' ? 'feeds nothing: it must touch an engine or strafer' : kind === 'cap' ? 'feeds nothing: it must touch a gun, beam, miner or Flash Screen' : 'feeds nothing: it must touch a Capacitor or Drive Cell',
      };
    } catch { /* (a candidate the rebuild refuses: no preview) */ }
    return this.feedPreviewVal;
  }

  /** Cyan glow on the parts the part in hand would feed, or a grey "feeds nothing" tag */
  private drawFeedPreview(cand: PlacedPart, g: PlacedGeom, sx: (x: number) => number, sy: (y: number) => number): void {
    const pv = this.feedPreview(cand), ctx = this.ctx;
    if (!pv) return;
    if (!pv.feeds.length) {
      const fs = 11;
      ctx.font = `600 ${fs}px 'Segoe UI', sans-serif`;
      const tw = ctx.measureText(pv.hint).width + 10, bx = sx(g.bbox.minX), by = sy(g.bbox.maxY) + 18;
      ctx.fillStyle = 'rgba(30, 36, 48, 0.9)'; ctx.fillRect(bx, by - 12, tw, 17);
      ctx.fillStyle = '#9aa7bb'; ctx.fillText(pv.hint, bx + 5, by);
      return;
    }
    for (const j of pv.feeds) {
      const q = this.geoms[j];
      if (!q) continue;
      ctx.beginPath();
      q.polygon.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
      ctx.closePath();
      ctx.fillStyle = 'rgba(34, 211, 238, 0.28)'; ctx.fill();
      ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2.5; ctx.stroke();
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
   * The power overlay: generators ringed and batteries barred in their
   * network's colour; what's left without power outlined red (short of it,
   * amber). No wires: they're retired, and not drawn.
   */
  private drawPower(d: ShipDerived, sx: (x: number) => number, sy: (y: number) => number): void {
    const ctx = this.ctx, px = this.view.px, rep = this.power;
    if (!rep) return;
    // Parts: what makes and stores power, in its network's colour; what lacks it
    const ring = Math.max(4, px * 0.26);
    this.geoms.forEach((g, i) => {
      const fn = this.deps.catalog.functions.get(g.part.fn);
      if (!fn) return;
      const net = rep.nets[d.network[i]], col = net?.color ?? DEAD_NET;
      const cx = sx(g.centroid[0]), cy = sy(g.centroid[1]);
      const st = rep.part[i];
      if (st === 'unpowered' || st === 'stranded' || st === 'short') {
        ctx.beginPath();
        g.polygon.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
        ctx.closePath();
        ctx.fillStyle = st === 'short' ? 'rgba(251, 191, 36, 0.12)' : 'rgba(239, 68, 68, 0.18)';
        ctx.fill();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = st === 'short' ? '#fbbf24' : '#ef4444';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        // (a struck-through bolt: no power)
        if (st !== 'short') {
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
    this.drawBanks(d, sx, sy, ring);
  }

  /**
   * The banks on the overlay (circuits.ts): each bank's members outlined (amber Capacitors, blue Drive Cells; grey one that
   * never refills), a short strap to each part it feeds, and its number; after a load test, each part that browned out with
   * its share
   */
  private drawBanks(d: ShipDerived, sx: (x: number) => number, sy: (y: number) => number, ring: number): void {
    const ctx = this.ctx, L = d.power;
    if (!L) return;
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
    L.banks.forEach((B, k) => {
      const col = !B.refills && B.dynamo <= 0 ? '#94a3b8' : B.kind === 'drive' ? '#60a5fa' : '#fbbf24';
      for (const i of B.parts) outline(i, col, []);
      // (A glowing strap to every part it feeds, and a bolt on that part)
      for (let n = 0, nn = B.feeds.length + B.shields.length; n < nn; n++) {
        const j = n < B.feeds.length ? B.feeds[n] : B.shields[n - B.feeds.length];
        const q = this.geoms[j];
        if (!q) continue;
        let from = this.geoms[B.parts[0]], best = Infinity;
        for (const i of B.parts) { const g = this.geoms[i]; if (!g) continue; const dd = Math.hypot(g.centroid[0] - q.centroid[0], g.centroid[1] - q.centroid[1]); if (dd < best) { best = dd; from = g; } }
        if (!from) continue;
        ctx.lineCap = 'round';
        ctx.strokeStyle = col; ctx.globalAlpha = 0.28; ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(sx(from.centroid[0]), sy(from.centroid[1])); ctx.lineTo(sx(q.centroid[0]), sy(q.centroid[1])); ctx.stroke();
        ctx.globalAlpha = 1; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(sx(from.centroid[0]), sy(from.centroid[1])); ctx.lineTo(sx(q.centroid[0]), sy(q.centroid[1])); ctx.stroke();
        ctx.lineCap = 'butt';
        this.boltGlyph(sx(q.centroid[0]) + ring * 0.85, sy(q.centroid[1]) - ring * 0.85, ring * 0.55, col);
      }
      // (Its label: "Bank 1 · holds 320 · gives 4,000/s", at its first member)
      const at = this.geoms[B.parts[0]];
      if (at) {
        const n0 = (v: number) => Math.round(v).toLocaleString();
        const text = `Bank ${k + 1} · holds ${n0(B.cap)} · gives ${n0(B.rate)}/s${!B.refills && B.dynamo <= 0 ? ' · never refills' : ''}`;
        const fs = Math.max(10, Math.round(font * 0.8));
        ctx.font = `700 ${fs}px 'Segoe UI', sans-serif`;
        const tw = ctx.measureText(text).width + 10, bx = sx(at.centroid[0]), by = sy(at.centroid[1]) - ring * 1.7 - k * 0;
        ctx.fillStyle = 'rgba(3, 5, 10, 0.85)'; ctx.fillRect(bx - tw / 2, by - fs * 0.7, tw, fs * 1.4);
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(bx - tw / 2, by - fs * 0.7, tw, fs * 1.4);
        ctx.fillStyle = col; ctx.fillText(text, bx, by + 0.5);
      }
    });
    // The load test: what browned out, by how much
    const lt = this.overlays.power ? this.bothTest() : null;
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
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }

  /** A small lightning bolt (fed parts, the power view) */
  private boltGlyph(cx: number, cy: number, r: number, color: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.25, cy - r); ctx.lineTo(cx - r * 0.55, cy + r * 0.1); ctx.lineTo(cx - r * 0.05, cy + r * 0.1);
    ctx.lineTo(cx - r * 0.25, cy + r); ctx.lineTo(cx + r * 0.55, cy - r * 0.2); ctx.lineTo(cx + r * 0.05, cy - r * 0.2);
    ctx.closePath();
    ctx.fillStyle = color; ctx.strokeStyle = 'rgba(3, 5, 10, 0.9)'; ctx.lineWidth = 1;
    ctx.fill(); ctx.stroke();
  }

  /**
   * A gun's mounting rules on the grid: the edge it bolts on at (green when it does, red when it must and doesn't) and
   * the cells its barrel needs clear (shaded; red where something's in the way). `all`: everything (the part in hand);
   * else only what's broken.
   */
  private drawMounting(g: PlacedGeom, broken: MountingProblem[], sx: (x: number) => number, sy: (y: number) => number, all: boolean): void {
    const { catalog } = this.deps, ctx = this.ctx, px = this.view.px;
    // An engine's blocked exhaust: the first cell in the way on each blocked lane, in red
    for (const [x, y] of broken.find((b) => b.rule === 'exhaust')?.cells ?? []) {
      ctx.fillStyle = 'rgba(248, 113, 113, 0.35)';
      ctx.fillRect(sx(x) + 2, sy(y) + 2, px - 4, px - 4);
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(sx(x) + 2, sy(y) + 2, px - 4, px - 4);
      ctx.setLineDash([]);
    }
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
 * The hangar's energy readout, from the same power layout as the Power section
 * (circuits.ts, energy.ts; the store and the Output are in that section): how
 * long the engines and guns get full power, how low they drop after, and how
 * long the stores take to fill from empty. A consumer draws on the banks it
 * touches first (their cap, at their Gives rate), then on the Output; a bank
 * that feeds nothing counts for nothing, and one that never refills is a single
 * draught.
 */
/** The load tests behind the hangar's Energy rows, per derived ship */
const energyRuns = new WeakMap<ShipDerived, { cruise: LoadTestResult; boost: LoadTestResult; fire: LoadTestResult; refill: number }>();
const ENERGY_ROW_SECONDS = 20;

function energyHtml(e: ShipSummary['energy'], d: ShipDerived | null, tuning: ShipTuning): string {
  const L = d?.power;
  const row = (label: string, value: string, tip: string) =>
    `<div style="display:flex; justify-content:space-between; padding:2px 0" title="${tip}"><span style="color:#8ea0bd">${label}</span>${value}</div>`;
  const head = `<div style="color:#ffb547; font-weight:bold; margin:10px 0 4px; letter-spacing:1px">ENERGY</div>`;
  if (!L || !d) return head + row('Store', `<b style="color:#e5ecf7">${Math.round(e.max)}</b>`, 'The core store plus batteries') + row('Spare power', `<b style="color:#e5ecf7">${e.spare.toFixed(0)}/s</b>`, 'Generation left after the steady loads');
  const output = L.spare + L.pool.rate;
  let hasEng = false, hasGun = false, engDraw = 0;
  for (const t of d.thrusters) if (t.force[0] || t.force[1]) { hasEng = true; engDraw += L.draw[t.part]; }
  for (const w of d.weapons) if (L.feedOf[w.part] >= 0) hasGun = true;
  // Each row is the ship's own power code run tick by tick (loadTest): a bank pays only for the parts it touches
  let runs = energyRuns.get(d);
  if (!runs) energyRuns.set(d, runs = {
    cruise: loadTest(d, tuning, { fire: false, thrust: true, boost: false, seconds: ENERGY_ROW_SECONDS }),
    boost: loadTest(d, tuning, { fire: false, thrust: true, boost: true, seconds: ENERGY_ROW_SECONDS }),
    fire: loadTest(d, tuning, { fire: true, thrust: true, boost: false, seconds: ENERGY_ROW_SECONDS }),
    // (From every store empty, idle: how long until they're full)
    refill: loadTest(d, tuning, { fire: false, thrust: false, boost: false, seconds: 0, from: { g: 0, b: L.banks.map(() => 0) } }).refill,
  });
  const dash = '<span style="color:#8ea0bd">—</span>';
  const show = (r: LoadTestResult, share: number, any: boolean): { html: string; ok: boolean } => {
    if (!any) return { html: dash, ok: true };
    if (r.brownAt < 0) return r.end >= 99
      ? { html: '<span style="color:#4ade80">sustained</span>', ok: true }
      : { html: `<span style="color:#fbbf24">holds ${ENERGY_ROW_SECONDS} s+ · store ${Math.round(r.end)}%</span>`, ok: true };
    const t = r.brownAt;
    return { html: `<span style="color:#f87171">full power ${t.toFixed(t < 10 ? 1 : 0)} s, then ${Math.round(share * 100)}%</span>`, ok: false };
  };
  const cruise = show(runs.cruise, runs.cruise.engines, hasEng && engDraw > 0);
  const boosting = show(runs.boost, runs.boost.engines, hasEng && engDraw > 0);
  const firing = show(runs.fire, Math.min(runs.fire.engines, runs.fire.guns), hasGun);
  const dry = hasGun && !firing.ok;

  const rf = runs.refill;
  // (loadTest gives up after two minutes)
  const refill = !Number.isFinite(rf) ? `<span style="color:#f87171">${L.spare > 0 || L.banks.some((B) => B.dynamo > 0) ? 'over 2 min' : 'never: no spare power'}</span>`
    : rf <= 0 ? dash : `<span style="color:${rf > 30 ? '#fbbf24' : '#e5ecf7'}">${rf.toFixed(rf < 10 ? 1 : 0)} s from empty</span>`;
  return head
    + row('Cruising', cruise.html, `Engines thrusting for ${ENERGY_ROW_SECONDS} s, run through the ship's real power code: each bank pays only for the parts it touches. Sustained: the generators keep up`)
    + row('Boosting', boosting.html, `Engines boosting, same test: how long they get full power before the stores run dry, then the lowest share they get. Store ${Math.round(L.pool.cap)}, Output ${Math.round(output)}/s`)
    + row('Firing, cruising', firing.html, 'Every gun firing flat out while the engines thrust, same test. Short of power, engines and guns share it by what each asks: thrust drops, guns reload slower, beams flicker')
    + row('Refills', refill, 'Idle, from every store empty: how long the spare generation takes to fill the pool and every bank that refills (a bank takes in at most its intake a second)')
    + (dry ? `<div style="color:#fbbf24; font-size:11px; margin-top:4px">The ship runs short in a fight: engines and guns share what there is, so both slow. Add generation, a battery, or a Capacitor bank touching the guns (it pays them first, and its intake raises their share).</div>` : '');
}
