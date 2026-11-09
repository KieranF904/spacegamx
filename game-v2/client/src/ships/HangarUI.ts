/**
 * @contract client.hangar
 * owns:       the hangar editor shell: slot and design state, grid editing (place, pick up, remove), input and open/close flow
 * needs:      hangar/* modules (draw, overlays, stats, designs, tips) through the HangarHost interface, HangarPalette, HangarLitView; npm: @space-game/common
 * invariants: the hangar edits a copy of the blueprint until Save — none pinned
 * extend:     a new panel or overlay is a module under hangar/ taking HangarHost; add the members it needs to hangar/host.ts
 */
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
 * The palette (HangarPalette.ts) is the component guide's model laid out for
 * building: the part in hand with its shapes, category tabs, and each tab's
 * list, what you can place first (your spares, then what you can fabricate),
 * then what's locked and why ("Reach level N"). A weapon's mount
 * is its model's (a badge, not a choice), and so are its mounting rules
 * (common ships/mounting.ts): the part in hand shows the edge it bolts on at,
 * the cells its barrel needs clear and its turret arc, and won't place where it
 * breaks one; guns on a saved ship that break one are marked red. On a dev
 * server an admin can switch on free build (the admin panel): any part places
 * (rules still apply), and saving takes nothing.
 *
 * E / U: power flow overlay (pulses, ticks, crosses, legend; remembered) · M: symmetry (every place, remove and turn is mirrored across the core's centre line) · Ctrl+Z: undo · Ctrl+Y / Ctrl+Shift+Z: redo
 * Click: place (empty hand: pick up) · Esc: empty the hand, then close · R/F/T over a placed part turn that part · middle-click: pick a placed part up · middle-drag: pan · R: rotate · F: mirror (flips a side mount) · T: cycle facing · right-click: remove
 * Hover: a part in hand over a cell it fits, or a placed part, shows a card at the cursor and +/- beside the stats: what placing / removing it changes
 * Wheel: zoom · arrow keys: pan · Tab: keyboard into the palette · Esc / H: close
 */

import { DragPaint } from './build/dragPaint';
import { bindBuildKeys } from './build/buildKeys';
import { HangarAids } from './hangar/hangarAids';
import { Blueprint, Bag, partItemId, PlacedPart, PlacedGeom, Rot, Side, ShipDerived, Vec2, SIDES, placeGeometry, overlapsAny, facingProblem, geomContainsPoint, validateBlueprint, nextFreeUid, partNeedsFacing, gunFacing, hasFixedBarrel, createShipState, BlueprintError, TurretWindow, wireCells, cellKey, mountingOf, partMountingProblems, type MountingProblem, cellMap, exhaustProblem } from '@space-game/common';
import { loadTest, type LoadTestResult } from '@space-game/common';
import { cloneJson as clone } from '@space-game/common';
import { powerReport, pruneWires, type PowerReport } from './wireEdit';
import { PortsGrid } from './portsGrid';
import { HangarPalette, type PaletteSel } from './HangarPalette';
import { groupOfKey, groupsSaid, hangarGroupKey } from './weaponGroups/editor';
import { esc } from '../ui/escape';
import { modelLock } from './modelCards';
import { HangarLitView } from './HangarLitView';
import { saveBlueprint } from './blueprintApi';
import { PART_TIP_CSS, type PartTipCtx } from './partTip';
import { loadPowerFlow, savePowerFlow } from './build/powerFlowPref';
import { onDetailMode } from './build/detailMode';
import { detailToggle } from './build/detailToggleView';
import { FlowCanvasLayer, FLOW_KEY } from './build/powerFlowView';
import type { HangarDeps, HangarHost, Overlay } from './hangar/host';
import { foldHeading, button, chip, checkbox } from './hangar/hangarWidgets';
import { feedPreview, drawFeedPreview, drawWindow, drawPower, drawBanks, boltGlyph, drawMounting, drawFacing } from './hangar/hangarOverlays';
import { draw } from './hangar/hangarDraw';
import { buildHtml, ammoHtml, bindBuildButtons, powerHtml, portsHtml, summaryHtml, renderStats } from './hangar/hangarStats';
import { refreshLoadList, loadSelected, designKey, toggleDesigns, renderDesigns, saveDesign, deleteDesign, loadDesign } from './hangar/hangarDesigns';
import { TURN_KEYS, escapeStep, partUnder, tryTurn } from './build/editPlaced';
import { tipCtx, showTip, hideTip, gridTip } from './hangar/hangarTips';
import { ruleText } from './hangar/hangarTips';
import { makeDeltaHover, syncDelta } from './hangar/hangarDelta';
import type { StatDelta } from './build/statDelta';
export type { HangarDeps };

/** The hangar's load test: this many seconds of the ship's power, from full (energy.ts loadTest) */
const LOAD_TEST_SECONDS = 4;


const DEFAULT_FACING: Record<string, Side> = { thruster: 'S', weapon: 'N', miner: 'N' };
/** What a save would change: the parts, the paint, the wiring (absent: auto-wired) */
const designSig = (bp: Blueprint) => JSON.stringify(bp.parts) + (bp.paint ?? '') + (bp.wires ? JSON.stringify(bp.wires) : '~');

export class HangarUI implements HangarHost {
  isOpen = false;

  bp!: Blueprint;
  /** Undo / redo and symmetry (hangar/hangarAids.ts) */
  readonly aids: HangarAids = new HangarAids(this);
  geoms: PlacedGeom[] = [];
  derived: ShipDerived | null = null;
  /** The grid layer (under the ship), and the ship lit and drawn as in flight (between it and the marks) */
  grid!: HTMLCanvasElement;
  lit: HangarLitView;
  errors: BlueprintError[] = [];
  /** Parts (uids) the core doesn't hold on to: planned only, never built until something joins them */
  unreachable: ReadonlySet<number> = new Set();
  private sel: PaletteSel = { piece: 'sq', fn: 'hull', material: 'alloy', rot: 0, flip: false, facing: 'auto' };
  /** Placed guns breaking their mounting rules, by part index (refresh) */
  mountingBroken = new Map<number, MountingProblem[]>();
  /** The part palette (HangarPalette.ts) */
  private pal: HangarPalette;
  /** Folded sections under the palette (overlays) */
  private folded = { overlays: true };
  view = { cx: 1, cy: 1, px: 40 };
  /** A middle-button drag in progress: where it started (screen, view, grid), and whether it's moved enough to be a pan */
  private pan: { x: number; y: number; cx: number; cy: number; at: Vec2; moved: boolean } | null = null;
  mouse: Vec2 | null = null;
  mouseClient: { x: number; y: number } | null = null;
  deltaNow: StatDelta | null = null;
  deltaHover = makeDeltaHover(this);
  /** The part the mouse is over in the parts list (for the shield cover preview, hangarMarks.ts) */
  paletteHover: { fn: string; piece: string; material: string } | null = null;
  overlays: Record<Overlay, boolean> = { energy: loadPowerFlow(), connectors: false, joins: false, power: true, com: true, thrust: true, arcs: true };
  /** The energy overlay of a ports design (portsOverlay.ts): its layer, the load test it shows, and the port under the mouse */
  ports = new PortsGrid();
  /** The power flow overlay's animated layer over the grid (pulses, ticks, crosses) */
  flow!: FlowCanvasLayer;
  /** The power overlay's networks and warnings (from the design's derived state) */
  power: PowerReport | null = null;
  /** The last load test (local circuits): which, on which design (it's dropped once the design changes), and what it found */
  /** The boost-and-fire load test of the derived design (the POWER panel's warning, the overlay's browned-out parts) */
  private loadRun: { for: ShipDerived; result: LoadTestResult } | null = null;
  bothTest(): LoadTestResult | null {
    const d = this.derived;
    if (!d) return null;
    if (this.loadRun?.for !== d) this.loadRun = { for: d, result: loadTest(d, this.deps.tuning, { fire: true, thrust: true, boost: true, seconds: LOAD_TEST_SECONDS }) };
    return this.loadRun.result;
  }
  grantAll = false;
  private owned: Bag = {};
  /** The slot being edited, the plan it was loaded from, and what was last saved (to spot unsaved edits) */
  slot = 0;
  plan: string | undefined;
  private savedSig = '';
  private slotBar!: HTMLDivElement;
  /** Saved designs: the panel, whether it's open, a save or delete waiting on its confirm, and what the list was built from */
  designBtn: HTMLButtonElement;
  designPanel: HTMLDivElement;
  designsOpen = false;
  designAsk: { slot: number; kind: 'save' | 'delete' } | null = null;
  designSig = '';
  /** The dev server's blueprint file API answered (Vite dev only) */
  devApi = false;

  private root: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  private palette: HTMLDivElement;
  stats: HTMLDivElement;
  private nameInput: HTMLInputElement;
  private paintInput: HTMLInputElement;
  loadSelect: HTMLSelectElement;
  private statusEl: HTMLSpanElement;
  private freeTag: HTMLSpanElement;
  /** Part tooltip, and what it shows (rebuilt only when that changes) */
  tip: HTMLDivElement;
  tipKey = '';
  /** Bumped whenever the design or hangar state changes (stale tooltips rebuild) */
  tipGen = 0;

  constructor(public deps: HangarDeps) {
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
      this.aids.undoBtn, this.aids.redoBtn, this.aids.symBtn,
      this.loadSelect,
      button('New', () => this.newBlueprint()),
      this.designBtn,
      save,
      button('Share', () => { this.deps.send({ type: 'shareDesign', blueprint: clone(this.bp) }); this.status('sent to your party'); }),
      detailToggle().el,
      button('Close', () => this.close(null)),
      this.statusEl,
    );
    // (Simple / Advanced: the stats panel and the hover card follow the switch)
    onDetailMode(() => { if (this.isOpen) this.renderStats(); });
    // (buttons keep their one line; the slots and the status give way)
    for (const b of bar.querySelectorAll<HTMLElement>(':scope > button')) { b.style.whiteSpace = 'nowrap'; b.style.flexShrink = '0'; }
    // Saved designs: a panel under the bar
    this.designPanel = document.createElement('div');
    this.designPanel.style.cssText = `position:absolute; top:44px; z-index:5; width:400px; max-height:calc(100vh - 70px); overflow-y:auto; display:none;
      background:#0b1220; border:1px solid #2a3a5a; border-radius:0 0 10px 10px; box-shadow:0 14px 40px rgba(0,0,0,0.6); padding:10px; font:12px 'Segoe UI', sans-serif;`;
    this.designPanel.addEventListener('mousedown', (e) => e.stopPropagation());

    // The part palette (HangarPalette.ts: the part in hand, its shapes, the category tabs and lists); its list scrolls, the rest stays
    this.palette = document.createElement('div');
    this.palette.style.cssText = 'overflow: hidden; min-width: 0; min-height: 0; padding: 8px 6px 6px 10px; border-right: 1px solid #1f2a40; color-scheme: dark;';
    this.pal = new HangarPalette({
      catalog: deps.catalog, tuning: deps.tuning, econ: deps.econ,
      sel: () => this.sel,
      changed: () => this.draw(),
      hoverPart: (p) => { if (p?.fn === this.paletteHover?.fn && p?.piece === this.paletteHover?.piece) return; this.paletteHover = p; this.draw(); },
      remaining: (id) => this.remaining(id),
      canMake: (id) => this.deps.canMake(id),
      have: (id) => this.deps.have(id),
      level: () => this.deps.level?.() ?? 1,
      learned: () => this.deps.learned?.() ?? [],
      owned: () => this.owned,
      free: () => this.free,
      freeBuild: () => this.freeBuild,
      grantAll: () => this.grantAll,
      hideTip: () => { if (this.tipKey.startsWith('p:')) this.hideTip(); },
    });
    this.palette.append(this.pal.root);
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width: 100%; height: 100%; display: block; cursor: crosshair;';
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'position: relative; overflow: hidden;';
    canvasWrap.dataset.tut = 'hangar-view';
    // Layers: the grid (and turret arcs) under, the ship lit as in flight (WebGL), the editor's marks over (and the mouse)
    this.grid = document.createElement('canvas');
    this.grid.style.cssText = 'position:absolute; left:0; top:0; width:100%; height:100%; display:block; pointer-events:none;';
    this.canvas.style.cssText += 'position:relative;';
    canvasWrap.append(this.grid, this.canvas);
    this.flow = new FlowCanvasLayer(canvasWrap);
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
      this.mouseClient = { x: e.clientX, y: e.clientY };
      this.dragTo(e, this.mouse);
      this.ports.hover(this.overlays.energy ? this.derived : null, this.mouse);
      this.draw();
      this.gridTip(e);
    });
    window.addEventListener('mouseup', (e) => {
      if (this.drag && e.button === this.drag.button) this.stopDrag();
      if (e.button !== 1 || !this.pan) return;
      const pan = this.pan;
      this.pan = null;
      this.canvas.style.cursor = 'crosshair';
      if (!pan.moved) this.pickUp(pan.at);
    });
    this.canvas.addEventListener('mouseleave', () => { this.mouse = null; this.mouseClient = null; this.draw(); this.hideTip(); });
    this.canvas.addEventListener('mousedown', (e) => {
      const g = this.toGrid(e);
      // (an empty hand's click picks a part up: no paint drag follows it)
      if (e.button === 0) {
        const painting = !this.sel.empty;
        if (painting) this.aids.beginDrag();
        this.place(g);
        if (painting) this.startDrag(0, g);
      }
      if (e.button === 1) { e.preventDefault(); this.pan = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy, at: g, moved: false }; }
      if (e.button === 2) { this.aids.beginDrag(); this.remove(g); this.startDrag(2, g); }
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
    // Ctrl+Z / Ctrl+Y / M, ahead of the game's own keys (build/buildKeys.ts)
    bindBuildKeys({ active: () => this.isOpen, undo: () => this.aids.undo(), redo: () => this.aids.redo(), symmetry: () => this.aids.toggleSymmetry() });
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
    this.aids.reset();
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

  get unsaved(): boolean {
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
    this.aids.reset();
    this.recenter();
    this.refresh();
  }

  close(launch: Blueprint | null): void {
    this.isOpen = false;
    this.stopDrag();
    this.flow.hide();
    this.hideTip();
    this.deltaHover.clear();
    this.toggleDesigns(false);
    this.root.style.display = 'none';
    this.lit.setOpen(false);
    this.deps.onClose(launch);
  }

  /** The power flow overlay on or off (remembered: build/powerFlowPref.ts) */
  setEnergy(on: boolean): void { this.overlays.energy = on; savePowerFlow(on); }

  /** Keys while open. Returns true when consumed (always, so flight controls don't react). */
  handleKey(code: string): boolean {
    if (!this.isOpen) return false;
    // (R / F / T over a part already placed turn that part; elsewhere they act on the hand, below)
    if (TURN_KEYS[code] && this.turnPlaced(code)) { this.draw(); return true; }
    if (code === 'KeyR') this.sel.rot = ((this.sel.rot + 1) % 4) as Rot;
    else if (code === 'KeyF') this.sel.flip = !this.sel.flip;
    else if (code === 'KeyE' || code === FLOW_KEY) { this.setEnergy(!this.overlays.energy); this.renderStats(); }
    // (1-4 on the weapon under the mouse: its weapon groups, ships/weaponGroups/editor.ts)
    else if (groupOfKey(code)) { const p = hangarGroupKey(code, this.bp, this.derived, this.mouse ? this.partAt(this.mouse) : -1); if (p) this.status(groupsSaid(p)); }
    else if (code === 'KeyT') {
      // (A gun's barrel is fixed to its piece: R turns it, there is no facing to cycle)
      if (hasFixedBarrel(this.deps.catalog, this.sel.fn)) { this.status('A gun fires out of one side of its piece: turn it with R'); return true; }
      const order: (Side | 'auto')[] = ['auto', ...SIDES];
      this.sel.facing = order[(order.indexOf(this.sel.facing) + 1) % order.length];
    } else if (code === 'Escape' && escapeStep(!!this.sel.empty) === 'empty-hand') { this.sel.empty = true; this.pal.render(); this.status('Hand emptied: Esc again closes'); }
    else if (code === 'Escape' || code === 'KeyH') { this.close(null); return true; }
    // (Tab: keyboard into the palette's tabs; there the palette takes the keys it needs, HangarPalette.ts)
    else if (code === 'Tab') { this.pal.focusTabs(); return true; }
    else if (code === 'ArrowLeft') this.view.cx -= 1;
    else if (code === 'ArrowRight') this.view.cx += 1;
    else if (code === 'ArrowUp') this.view.cy -= 1;
    else if (code === 'ArrowDown') this.view.cy += 1;
    this.pal.renderHand();
    this.renderFooter();
    this.draw();
    return true;
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  candidate(g: Vec2): PlacedPart | null {
    if (this.sel.empty) return null;
    const uid = nextFreeUid(this.bp);
    if (uid < 0) return null;
    // (A model is always made of its own material)
    const fd = this.deps.catalog.functions.get(this.sel.fn);
    const p: PlacedPart = {
      uid, piece: this.sel.piece, fn: this.sel.fn, material: fd?.model && fd.material ? fd.material : this.sel.material,
      x: Math.floor(g[0]), y: Math.floor(g[1]), rot: this.sel.rot, flip: this.sel.flip,
    };
    if (partNeedsFacing(p.fn)) p.facing = gunFacing(this.deps.catalog, p) ?? this.pickFacing(p);
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
  placementProblem(p: PlacedPart): string | null {
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
      const fix = hasFixedBarrel(this.deps.catalog, p.fn) ? 'turn it (R)' : 'press T for another side';
      if (why === 'noEdge') return `no straight edge facing ${p.facing} on this piece: ${fix}`;
      if (why === 'blocked') return `its ${p.facing} edge is blocked: ${fix}`;
      if (why === 'notJoined') return `its ${p.facing} edge (where power leaves) must touch a part: ${fix}`;
    }
    // (A part that joins nothing may be planned: it shows "not connected" and builds once something joins it)
    // Its mounting rules (always: free build skips ownership, never these)
    const broken = this.candidateMounting(p, g);
    if (broken.length) return broken.map((m) => ruleText(m)).join('; ');
    return null;
  }

  /** The mounting rules a part in hand would break where it is (common partMountingProblems) */
  candidateMounting(p: PlacedPart, g = placeGeometry(this.deps.catalog, p)): MountingProblem[] {
    return this.geoms.length ? partMountingProblems(this.deps.catalog, [...this.geoms, g], this.geoms.length) : [];
  }

  private place(g: Vec2): void {
    // (An empty hand: a click on a placed part picks it up, as middle-click does; on an empty cell it does nothing)
    if (this.sel.empty) return this.pickUp(g);
    const p = this.candidate(g);
    if (!p) return this.status('blueprint is full (255 parts)');
    const problem = this.placementProblem(p);
    if (problem) return this.status(problem);
    this.aids.edit(() => {
      this.bp.parts.push(p);
      this.refresh();
      this.aids.placeMirror(p);
    });
  }

  partAt(g: Vec2): number {
    for (let i = this.geoms.length - 1; i >= 0; i--) if (geomContainsPoint(this.geoms[i], g[0], g[1])) return i;
    return -1;
  }

  /** R / F / T with the mouse over a placed part: turn, mirror or re-face that part in place (build/editPlaced.ts). False: no part there */
  private turnPlaced(code: string): boolean {
    const i = this.mouse ? partUnder(this.deps.catalog, this.bp.parts, this.mouse) : -1;
    if (i < 0 || !this.mouse) return false;
    const r = tryTurn(this.deps.catalog, this.bp.parts, i, TURN_KEYS[code], this.mouse);
    if ('problem' in r) { this.status(r.problem); return true; }
    this.aids.edit(() => {
      this.bp.parts[i] = r.part;
      const note = this.aids.followTurn(i, this.mouse!);
      if (this.bp.wires) this.bp.wires = pruneWires(this.bp.wires, this.onHull());
      this.status(r.said + note);
      this.refresh();
    });
    return true;
  }

  /** Middle-click: put the part under the cursor in hand, exactly as it's placed (piece, function, material, turn, mirror, facing) */
  private pickUp(g: Vec2): void {
    const i = this.partAt(g);
    if (i < 0) return;
    const p = this.bp.parts[i];
    this.sel = { piece: p.piece, fn: p.fn, material: p.material, rot: p.rot, flip: p.flip, facing: p.facing ? (p.facing as Side) : 'auto' };
    this.status(`picked up: ${this.deps.econ.items.name(partItemId(p))}`);
    this.pal.showInHand();
    this.draw();
  }

  /** A held left/right button: the cells the cursor has passed since the press are placed on / taken out, each once */
  private drag: { button: 0 | 2; paint: DragPaint } | null = null;

  /** (the mirror of the cell pressed counts as visited too) */
  private startDrag(button: 0 | 2, g: Vec2): void {
    const paint = new DragPaint(g), m = this.aids.mirrorOf(g);
    if (m) paint.mark(m);
    this.drag = { button, paint };
  }

  /** The held button is up: the drag's edits close as one undo step */
  private stopDrag(): void {
    this.drag = null;
    this.aids.endDrag();
  }

  private dragTo(e: MouseEvent, g: Vec2): void {
    const d = this.drag;
    if (!d) return;
    if (!(e.buttons & (d.button === 0 ? 1 : 2))) { this.stopDrag(); return; }
    for (const at of d.paint.visit(g)) {
      const m = this.aids.mirrorOf(at);
      if (m) d.paint.mark(m);
      if (d.button === 0) this.place(at); else this.remove(at);
    }
  }

  private remove(g: Vec2, mirrored = false): void {
    const i = this.partAt(g);
    if (i < 0) return;
    this.aids.edit(() => {
      // (What it held on to stays, planned and not connected, until something joins it again)
      this.bp.parts = this.bp.parts.filter((_, k) => k !== i);
      // (wire laid over what's gone goes with it)
      if (this.bp.wires) this.bp.wires = pruneWires(this.bp.wires, this.onHull());
      this.refresh();
      // (symmetry: the part across the centre line goes too)
      const m = mirrored ? null : this.aids.mirrorOf(g);
      if (m) this.remove(m, true);
    });
  }

  /** Is a cell under one of the design's parts (where saved wire stays) */
  private onHull(): (x: number, y: number) => boolean {
    const cells = wireCells(this.deps.catalog, this.bp, this.bp.parts.map((p) => placeGeometry(this.deps.catalog, p)));
    return (x, y) => cells.has(cellKey(x, y));
  }

  private newBlueprint(): void {
    this.aids.edit(() => {
      this.bp = { name: 'New ship', catalogVersion: this.deps.catalog.version, power: 'ports', parts: [
        { uid: 0, piece: 'sq', fn: 'core', material: 'alloy', x: 0, y: 0, rot: 0, flip: false },
      ] };
    });
    this.plan = undefined;
    this.recenter();
    this.refresh();
  }

  /** Plans the pilot can load (all of them when everything is free), smallest first */
  plans(): { file: string; bp: Blueprint }[] {
    const known = new Set(this.deps.knownPlans());
    return Object.entries(this.deps.econ.plans)
      .filter(([file]) => this.free || known.has(file))
      .map(([file, bp]) => ({ file, bp }))
      .sort((a, b) => a.bp.parts.length - b.bp.parts.length);
  }

  /** Design slots, as the server last sent them (null: empty) */
  designs(): (Blueprint | null)[] {
    return this.deps.hangarState()?.designs ?? [];
  }

  async refreshLoadList(): Promise<void> { return refreshLoadList(this); }

  async loadSelected(): Promise<void> { return loadSelected(this); }

  // -------------------------------------------------------------------------
  // Saved designs (blueprints kept for later, not ships)
  // -------------------------------------------------------------------------

  designKey(): string { return designKey(this); }

  toggleDesigns(open = !this.designsOpen): void { return toggleDesigns(this, open); }

  renderDesigns(): void { return renderDesigns(this); }

  saveDesign(slot: number): void { return saveDesign(this, slot); }

  deleteDesign(slot: number): void { return deleteDesign(this, slot); }

  loadDesign(slot: number): void { return loadDesign(this, slot); }

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
  remaining(id: string): number {
    if (this.grantAll) return Infinity;
    return (this.owned[id] ?? 0) - this.bp.parts.filter((q) => partItemId(q) === id).length;
  }

  /** Free build is on (a dev server's admin, from the admin panel): any part places, and the server takes nothing */
  private get freeBuild(): boolean {
    return !this.grantAll && !!this.deps.hangarState()?.freeBuild;
  }

  /** Every part is free: proto mode, or free build */
  get free(): boolean {
    return this.grantAll || this.freeBuild;
  }

  /** Parts of the saved design not built yet (uids), and parts added since the last save */
  ghostInfo(): { ghosts: Set<number>; fresh: Set<number> } {
    const rec = this.deps.hangarState()?.slots[this.slot];
    const saved = new Map((rec?.blueprint.parts ?? []).map((q) => [q.uid, partItemId(q)]));
    const ghosts = new Set(rec?.ghosts ?? []);
    const fresh = new Set<number>();
    for (const q of this.bp.parts) if (saved.get(q.uid) !== partItemId(q)) fresh.add(q.uid);
    return { ghosts, fresh };
  }

  status(text: string): void {
    this.statusEl.textContent = text;
  }

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  refresh(): void {
    const { catalog, tuning } = this.deps;
    this.tipGen++;
    this.nameInput.value = this.bp.name;
    this.paintInput.value = this.bp.paint ?? '#24324d';
    this.geoms = this.bp.parts.map((p) => placeGeometry(catalog, p));
    this.owned = this.deps.owned(this.slot);
    const checked = validateBlueprint(catalog, this.bp, tuning, null);
    this.errors = checked.errors;
    this.unreachable = new Set(checked.unreachable);
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
    const keep = this.bp.parts.map((p, i) => [p, i] as const).filter(([p]) => !(ghosts.has(p.uid) && !fresh.has(p.uid)) && !this.unreachable.has(p.uid));
    if (!keep.length) { this.lit.show(null, []); return; }
    try {
      const ship = createShipState(this.deps.catalog, this.deps.tuning, 0, { ...this.bp, parts: keep.map(([p]) => p) }, 0);
      this.lit.show(ship, keep.map(([, i]) => this.geoms[i]), keep.map(([p]) => (wrecked.has(p.uid) ? 0.2 : 1)));
    } catch {
      this.lit.show(null, []);
    }
  }

  recenter(): void {
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

  /** The palette (HangarPalette.ts: the part in hand, its shapes, the category tabs and lists) and what's under it */
  renderPalette(): void {
    if (this.tipKey.startsWith('p:')) this.hideTip();
    this.pal.render();
    this.renderFooter();
  }

  /** Under the palette: the mouse and keys in a line, the overlays (folded), and proto's debug switch */
  private renderFooter(): void {
    const el = this.pal.foot;
    el.innerHTML = '';
    const keys = 'Click places · right-click removes · hold and drag to paint or sweep · middle-click picks up · middle-drag or arrows pan · wheel zooms · R turn · F mirror · T facing · E or U power flow overlay · M symmetry (mirror every edit across the centre line) · Ctrl+Z undo · Ctrl+Y redo · 1-4 on a weapon: its groups · Tab: keyboard into the parts list';
    const info = document.createElement('div');
    info.title = keys;
    info.style.cssText = 'color:#6b7a93; margin:3px 0 2px; font-size:10.5px; line-height:1.45;';
    info.innerHTML = `Click places · right-click removes · hold and drag to paint or sweep · <b style="color:#9fb0cc">middle-click picks up</b><br>R turn · F mirror · T facing · E/U power flow · Tab list · wheel zoom<br>M symmetry · Ctrl+Z undo · Ctrl+Y redo`;
    el.append(info);
    // Overlays (folded) and proto's debug switch, on one line
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:baseline; gap:10px;';
    const fold = foldHeading('Overlays', this.folded.overlays, () => { this.folded.overlays = !this.folded.overlays; this.renderFooter(); });
    fold.style.margin = '2px 0';
    row.append(fold);
    if (this.deps.grantAll) {
      const c = checkbox('grant everything', this.grantAll, (v) => { this.grantAll = v; this.refresh(); this.refreshLoadList(); });
      c.style.cssText += 'margin:0 0 0 auto; font-size:11px; color:#8ea0bd;';
      row.append(c);
    }
    el.append(row);
    if (!this.folded.overlays) {
      const ov = document.createElement('div');
      ov.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px; margin:2px 0 4px;';
      for (const key of Object.keys(this.overlays) as Overlay[]) {
        ov.append(chip(key, this.overlays[key], this.overlays[key] ? '#5fd4c4' : '#2a3a5a', () => { this.overlays[key] = !this.overlays[key]; if (key === 'energy') savePowerFlow(this.overlays.energy); this.renderFooter(); this.draw(); }));
      }
      el.append(ov);
    }
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

  buildHtml(): string { return buildHtml(this); }

  ammoHtml(): string { return ammoHtml(this); }

  bindBuildButtons(): void { return bindBuildButtons(this); }

  powerHtml(): string { return powerHtml(this); }

  /** A part's display name (its model's) by index */
  partName(i: number): string {
    const p = this.bp.parts[i], fn = p && this.deps.catalog.functions.get(p.fn);
    return fn?.name ?? p?.fn ?? '?';
  }

  portsHtml(L: NonNullable<ShipDerived['ports']>): string { return portsHtml(this, L); }

  summaryHtml(): string { return summaryHtml(this); }

  renderStats(): void { return renderStats(this); }

  // -------------------------------------------------------------------------
  // Part tooltip
  // -------------------------------------------------------------------------

  tipCtx(): PartTipCtx { return tipCtx(this); }

  showTip(key: string, html: () => string, x: number, y: number): void { return showTip(this, key, html, x, y); }

  hideTip(): void { return hideTip(this); }

  gridTip(e: MouseEvent): void { return gridTip(this, e); }


  // -------------------------------------------------------------------------
  // Canvas
  // -------------------------------------------------------------------------

  private toGrid(e: MouseEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left - r.width / 2) / this.view.px + this.view.cx, (e.clientY - r.top - r.height / 2) / this.view.px + this.view.cy];
  }

  draw(): void { syncDelta(this); return draw(this); }

  feedPreviewKey = '';
  feedPreviewFor: ShipDerived | null = null;
  feedPreviewVal: { feeds: number[]; hint: string } | null = null;

  feedPreview(cand: PlacedPart): { feeds: number[]; hint: string } | null { return feedPreview(this, cand); }

  drawFeedPreview(cand: PlacedPart, g: PlacedGeom, sx: (x: number) => number, sy: (y: number) => number): void { return drawFeedPreview(this, cand, g, sx, sy); }

  drawWindow(w: TurretWindow, sx: (x: number) => number, sy: (y: number) => number, alpha: number, ctx = this.ctx): void { return drawWindow(this, w, sx, sy, alpha, ctx); }

  drawPower(d: ShipDerived, sx: (x: number) => number, sy: (y: number) => number): void { return drawPower(this, d, sx, sy); }

  drawBanks(d: ShipDerived, sx: (x: number) => number, sy: (y: number) => number, ring: number): void { return drawBanks(this, d, sx, sy, ring); }

  boltGlyph(cx: number, cy: number, r: number, color: string): void { return boltGlyph(this, cx, cy, r, color); }

  drawMounting(g: PlacedGeom, broken: MountingProblem[], sx: (x: number) => number, sy: (y: number) => number, all: boolean): void { return drawMounting(this, g, broken, sx, sy, all); }

  handTurn(): { rot: Rot; flip: boolean } { return { rot: this.sel.rot, flip: this.sel.flip }; }
  drawFacing(g: PlacedGeom, side: Side, sx: (x: number) => number, sy: (y: number) => number): void { return drawFacing(this, g, side, sx, sy); }
}
