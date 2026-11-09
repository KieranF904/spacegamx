/**
 * The world build view (docs/design/field-fabrication.md, rule 5): editing the ship's blueprint on the live game, as the
 * hangar does. Opening it swaps to the helm view and zooms in on the ship, which keeps flying; the parts palette
 * (HangarPalette, by import: the hangar's own list) opens at the side, and the mouse builds on the ship itself:
 *
 *   left click   place the part in hand (hold: along the path)   right click   take a part out (a standing part: mark it for recycling)
 *   middle click pick a part up                 R turn · F mirror · T facing · Esc or the build key closes
 *
 * There is no plan apart from the blueprint: a part the blueprint has and the ship hasn't is missing (planned or shot
 * off), drawn as the real part, faded, and built by the fabricator. Built parts are the ship itself (the game draws
 * them); parts marked for recycling are outlined red; the part in hand is the real part tinted green or red. Facing
 * arrows and shield cover (build/buildMarks.ts) show on every part while the view is open.
 *
 * Clicks build only on and just around the ship; anywhere else they still fire and mine, and no flight key is touched,
 * so the ship is never held back. A save sends `fieldPlan` with the new blueprint (free; only building costs), "As it
 * stands" sends `fieldPlanClear`. The edits are plan.ts, laid over the live ship each frame.
 */
import { DragPaint } from '../build/dragPaint';
import { bindResourceLinks } from '../build/planCostView';
import { fieldCostHtml } from './fieldCost';
import { placeGeometry, partItemId, hasFixedBarrel } from '@space-game/common';
import type { Graphics } from 'pixi.js';
import type { PlacedGeom, PlacedPart, ShipState, Side, Vec2 } from '@space-game/common';
import type { HangarPalette, PaletteSel } from '../HangarPalette';
import type { ShipDrawCtx } from '../features/types';
import { fieldClient, machineProgress } from './fieldState';
import { drawFieldGroups, fieldGroupEdit } from '../weaponGroups/fieldEditor';
import { groupOfKey } from '../weaponGroups/editor';
import { drawPartArt } from '../build/partArt';
import { drawFacingMark, drawShieldCover } from '../build/buildMarks';
import type { FieldDeps } from './bridge';
import {
  addPart, candidate, hasEdits, noEdits, partAtPoint, placementProblem, planChanged, planTarget, removePart, replacePart, settle, summary,
  targetErrors, unjoinedText, unjoinedUids, working, type BuildEdits, type LiveDesign, type WorkingDesign,
} from './plan';
import { TURN_KEYS, escapeStep, partUnder, tryTurn } from '../build/editPlaced';

const SIDE_CYCLE: readonly (Side | 'auto')[] = ['auto', 'N', 'E', 'S', 'W'];
/** How far round the ship (cells) a click still builds */
const REACH = 3;
/** How a missing part shows (more as its build goes on) */
const MISSING_ALPHA = 0.34, BUILDING_ALPHA = 0.5;
/** A planned part nothing joins to the core yet: fainter than a missing one, outlined dashed in violet */
const LOOSE_ALPHA = 0.2, LOOSE_LINE = 0xc4b5fd;

const STYLE = `
.fo { position: fixed; right: 0; top: 0; bottom: 0; width: 308px; z-index: 880; display: none; flex-direction: column; padding: 8px 8px 8px 10px;
  background: rgba(8, 14, 26, 0.93); border-left: 1px solid #1f2a40; color: #cfe0f5; font: 12px 'Segoe UI', system-ui, sans-serif; color-scheme: dark; }
.fo-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.fo-head b { flex: 1; letter-spacing: 0.4px; color: #e5ecf7; }
.fo-pal { flex: 1; min-height: 0; overflow: hidden; }
.fo-foot { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.fo-cost { color: #c4cfde; font-size: 11px; line-height: 1.45; margin-bottom: 4px; }
.fo-cost:empty { display: none; }
.fo-note { color: #8ea0bd; font-size: 11px; line-height: 1.4; min-height: 15px; }
.fo-note.bad { color: #fca5a5; }
.fo-btns { display: flex; gap: 6px; }
.fo-btn { flex: 1; cursor: pointer; border: 1px solid #2a3a5a; background: #14203a; color: #cfe0f5; border-radius: 5px; padding: 4px 6px; font: inherit; }
.fo-btn:hover:not(:disabled) { background: #1c2d52; }
.fo-btn:disabled { opacity: 0.45; cursor: default; }
.fo-btn.go { background: #14532d; border-color: #22c55e; color: #bbf7d0; }
`;

const ZOOM_MIN = 0.6, ZOOM_MAX = 2;

export class FieldOverlay {
  isOpen = false;
  /** The pilot's unsaved edits (laid over the live ship) */
  edits: BuildEdits = noEdits();
  readonly hand: PaletteSel = { piece: 'sq', fn: 'hull', material: 'alloy', rot: 0, flip: false, facing: 'auto' };

  private root?: HTMLDivElement;
  private palWrap?: HTMLDivElement;
  private pal: HangarPalette | null = null;
  private noteEl?: HTMLElement;
  private costEl?: HTMLElement;
  private saveBtn?: HTMLButtonElement;
  private clearBtn?: HTMLButtonElement;
  private mouse: { x: number; y: number } | null = null;
  /** What opening changed (so closing can put it back) */
  private was: { zoom: number; helm: boolean } | null = null;
  private cs = 0;
  /** Bumps on each edit (the caches below and the footer follow it) */
  private rev = 0;
  private note = '';
  private noteBad = false;
  private cache: { key: unknown[]; w: WorkingDesign; geoms: PlacedGeom[]; unjoined: Set<number> } | null = null;

  constructor(private deps: FieldDeps) {}

  // ---------------------------------------------------------------- open and close

  toggle(): void {
    if (this.isOpen) this.close(); else this.open();
  }

  open(): void {
    if (this.isOpen) return;
    const { deps } = this;
    const ship = deps.ship();
    if (!ship || !deps.entity() || !deps.flying()) { deps.toast('Build plans need you in flight', 'warn'); return; }
    this.isOpen = true;
    this.was = { zoom: deps.view.zoom(), helm: deps.view.helm() };
    deps.view.setHelm(true);
    deps.view.setZoom(this.zoomFor(ship));
    this.edits = noEdits();
    this.rev++;
    this.ensurePanel();
    this.root!.style.display = 'flex';
    window.addEventListener('mousedown', this.onDown, true);
    window.addEventListener('mousemove', this.onMove, true);
    window.addEventListener('mouseup', this.onUp, true);
    this.say('Click on the ship to place. Saving is free: the fabricator builds missing parts from your hold.');
    void this.loadPalette();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    window.removeEventListener('mousedown', this.onDown, true);
    window.removeEventListener('mousemove', this.onMove, true);
    window.removeEventListener('mouseup', this.onUp, true);
    this.drag = null;
    if (this.root) this.root.style.display = 'none';
    const was = this.was;
    this.was = null;
    this.edits = noEdits();
    this.cache = null;
    if (was) {
      this.deps.view.setZoom(was.zoom);
      if (this.deps.view.helm() !== was.helm) this.deps.view.setHelm(was.helm);
    }
  }

  /** A zoom that puts the ship at a good size on screen */
  private zoomFor(ship: ShipState): number {
    const cs = this.deps.tuning.cellSize;
    let min = Infinity, max = -Infinity, mx = Infinity, mxx = -Infinity;
    for (const p of ship.blueprint.parts) {
      const g = placeGeometry(this.deps.catalog, p);
      min = Math.min(min, g.bbox.minY); max = Math.max(max, g.bbox.maxY);
      mx = Math.min(mx, g.bbox.minX); mxx = Math.max(mxx, g.bbox.maxX);
    }
    const cells = Math.max(6, max - min, mxx - mx) + 2 * REACH;
    const z = (0.8 * Math.min(window.innerHeight, window.innerWidth - 308)) / (cells * cs);
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  }

  // ---------------------------------------------------------------- the design as shown

  /** The live ship as the edits see it (null: no ship) */
  live(): LiveDesign | null {
    const ship = this.deps.ship();
    if (!ship) return null;
    return { bp: ship.blueprint, alive: ship.derived.alive, queued: fieldClient.recycleUids() };
  }

  /** The working design and its geometry, cached until the live ship, its recycling queue or the edits change */
  private view(): { live: LiveDesign; w: WorkingDesign; geoms: PlacedGeom[]; unjoined: Set<number> } | null {
    const ship = this.deps.ship(), live = this.live();
    if (!ship || !live) return null;
    const key = [ship, ship.blueprint, ship.rebuilds, live.queued, this.rev];
    if (!this.cache || key.some((k, i) => k !== this.cache!.key[i])) {
      const w = working(live, this.edits);
      this.cache = { key, w, geoms: w.bp.parts.map((p) => placeGeometry(this.deps.catalog, p)), unjoined: new Set() };
      this.cache.unjoined = unjoinedUids(this.deps.catalog, w, this.cache.geoms);
    }
    return { live, w: this.cache.w, geoms: this.cache.geoms, unjoined: this.cache.unjoined };
  }

  /** The working design (null: closed or no ship) */
  get design(): WorkingDesign | null {
    return this.isOpen ? this.view()?.w ?? null : null;
  }

  // ---------------------------------------------------------------- panel

  private ensurePanel(): void {
    if (this.root) return;
    if (!document.getElementById('fo-style')) {
      const s = document.createElement('style');
      s.id = 'fo-style';
      s.textContent = STYLE;
      document.head.appendChild(s);
    }
    const root = document.createElement('div');
    root.className = 'fo';
    root.dataset.hudAvoid = '1';
    root.innerHTML = `<div class="fo-head"><b>Build</b><button class="fo-btn" data-a="close" style="flex:none">Close</button></div>
      <div class="fo-pal"></div>
      <div class="fo-foot"><div class="fo-cost"></div><div class="fo-note"></div>
        <div class="fo-btns"><button class="fo-btn go" data-a="save">Save</button><button class="fo-btn" data-a="reset">Undo edits</button><button class="fo-btn" data-a="clear" title="Drop every missing part (planned or lost) from the design and stop recycling: the ship as it stands">As it stands</button></div></div>`;
    root.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
      if (a === 'close') this.close();
      else if (a === 'save') this.save();
      else if (a === 'reset') this.undo();
      else if (a === 'clear') this.clear();
    });
    this.palWrap = root.querySelector<HTMLDivElement>('.fo-pal')!;
    this.noteEl = root.querySelector<HTMLElement>('.fo-note')!;
    this.costEl = root.querySelector<HTMLElement>('.fo-cost')!;
    bindResourceLinks(this.costEl);
    this.saveBtn = root.querySelector<HTMLButtonElement>('[data-a="save"]')!;
    this.clearBtn = root.querySelector<HTMLButtonElement>('[data-a="clear"]')!;
    document.body.appendChild(root);
    this.root = root;
  }

  /** The hangar's own parts list, split out of the main chunk (made on first open) */
  private async loadPalette(): Promise<void> {
    if (this.pal || !this.palWrap) return;
    const { HangarPalette } = await import('../HangarPalette');
    if (this.pal) return;
    const { deps } = this;
    this.pal = new HangarPalette({
      catalog: deps.catalog, tuning: deps.tuning, econ: deps.econ,
      sel: () => this.hand,
      changed: () => { /* the hand is drawn each frame */ },
      // (A plan is free: any part can be planned. Building it is what takes materials, and the fabricator's tier decides what it can make.
      // A finished part in the hold is built from there: only attaching it. The list shows each part's cost, not "free")
      remaining: (id) => deps.have(id),
      canMake: (id) => deps.canMake(id),
      have: (id) => deps.have(id),
      level: () => deps.level(),
      learned: () => deps.learned(),
      owned: () => ({}),
      free: () => true,
      fieldBuild: true,
      freeBuild: () => false,
      grantAll: () => false,
      partTip: () => {},
      hideTip: () => {},
    });
    this.palWrap.appendChild(this.pal.root);
    this.pal.render();
  }

  private say(text: string, bad = false): void {
    this.note = text;
    this.noteBad = bad;
  }

  // ---------------------------------------------------------------- editing

  private onMove = (e: MouseEvent): void => {
    this.mouse = { x: e.clientX, y: e.clientY };
    this.dragTo(e);
  };

  private onUp = (e: MouseEvent): void => {
    if (this.drag && e.button === this.drag.button) this.drag = null;
  };

  /** A held left/right button that started on the ship: the cells the cursor passes are built on / taken out, each once */
  private drag: { button: 0 | 2; paint: DragPaint; touched: Set<number> } | null = null;

  private dragTo(e: MouseEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!(e.buttons & (d.button === 0 ? 1 : 2))) { this.drag = null; return; }
    if ((e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
    const to = this.gridAt(e.clientX, e.clientY);
    if (!to) return;
    for (const at of d.paint.visit(to)) {
      if (!this.near(at)) continue;
      if (d.button === 0) this.place(at); else this.take(at, d.touched, true);
    }
  }

  /** Capture phase, before the game's own mouse handler: a click on or round the ship builds, any other still fires */
  private onDown = (e: MouseEvent): void => {
    if (!this.isOpen) return;
    const t = e.target as HTMLElement | null;
    if (!t || t.tagName !== 'CANVAS') return;
    const at = this.gridAt(e.clientX, e.clientY);
    if (!at || !this.near(at)) return;
    e.stopPropagation();
    e.preventDefault();
    // (an empty hand's click picks a part up: no paint drag follows it)
    if (e.button === 0) { const painting = !this.hand.empty; this.place(at); if (painting) this.drag = { button: 0, paint: new DragPaint(at), touched: new Set() }; }
    else if (e.button === 2) {
      const touched = new Set<number>();
      this.take(at, touched);
      this.drag = { button: 2, paint: new DragPaint(at), touched };
    }
    else if (e.button === 1) this.pickUp(at);
  };

  /** The ship-grid point under a screen point */
  gridAt(sx: number, sy: number): Vec2 | null {
    const e = this.deps.entity(), ship = this.deps.ship();
    if (!e || !ship) return null;
    const w = this.deps.view.screenToWorld(sx, sy);
    const cs = this.cs || this.deps.tuning.cellSize;
    const a = e.renderAngle + Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
    const dx = w.x - e.renderX, dy = w.y - e.renderY;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    return [lx / cs + ship.derived.com[0], ly / cs + ship.derived.com[1]];
  }

  /** Is a grid point on the design or within REACH cells of it */
  private near(g: Vec2): boolean {
    const v = this.view();
    if (!v) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of v.geoms) {
      minX = Math.min(minX, q.bbox.minX); minY = Math.min(minY, q.bbox.minY);
      maxX = Math.max(maxX, q.bbox.maxX); maxY = Math.max(maxY, q.bbox.maxY);
    }
    return g[0] >= minX - REACH && g[0] <= maxX + REACH && g[1] >= minY - REACH && g[1] <= maxY + REACH;
  }

  /** Why the part in hand can't be placed (the hangar's rules, and the licence), or null */
  problemFor(p: PlacedPart): string | null {
    const v = this.view();
    if (!v) return 'not open';
    const why = placementProblem(this.deps.catalog, v.w, p, this.deps.tuning);
    if (why) return why;
    const id = partItemId(p);
    if (!this.deps.canMake(id)) return `you can't make ${this.deps.econ.items.name(id)} yet`;
    return null;
  }

  /** The part in hand at a grid point, and whether it can go there (the hover preview) */
  preview(g: Vec2): { part: PlacedPart; problem: string | null } | null {
    const v = this.view();
    if (!v || this.hand.empty) return null;
    const part = candidate(this.deps.catalog, v.live, v.w, this.hand, g);
    if (!part) return null;
    // (Checked against the whole design, so only when the cell, the hand or the design changes)
    const h = this.hand;
    const key = `${this.rev}:${v.w.bp.parts.length}:${part.x},${part.y}:${h.piece}|${h.fn}|${h.material}|${h.rot}|${h.flip}|${part.facing ?? ''}`;
    if (this.previewKey !== key || this.previewFor !== v.w) { this.previewKey = key; this.previewFor = v.w; this.previewProblem = this.problemFor(part); }
    return { part, problem: this.previewProblem };
  }
  private previewKey = '';
  private previewFor: WorkingDesign | null = null;
  private previewProblem: string | null = null;

  private place(g: Vec2): void {
    // (An empty hand: a click on a part of the design picks it up, as middle-click does; on an empty cell it does nothing)
    if (this.hand.empty) return this.pickUp(g);
    const v = this.view();
    if (!v) return;
    const part = candidate(this.deps.catalog, v.live, v.w, this.hand, g);
    if (!part) return this.say('The design is full (255 parts).', true);
    const why = this.problemFor(part);
    if (why) return this.say(why[0].toUpperCase() + why.slice(1) + '.', true);
    addPart(this.edits, part);
    this.edited();
  }

  /** `touched`: the parts this drag has already dealt with (a drag marks a part once, and `sweeping` over one already marked leaves it marked) */
  private take(g: Vec2, touched?: Set<number>, sweeping = false): void {
    const v = this.view();
    if (!v) return;
    const i = partAtPoint(this.deps.catalog, v.w, g);
    if (i < 0) return;
    if (touched) {
      const uid = v.w.bp.parts[i].uid;
      if (touched.has(uid)) return;
      touched.add(uid);
      if (sweeping && v.w.marked.has(uid)) return;
    }
    const res = removePart(this.deps.catalog, v.live, this.edits, i);
    if (res.kind === 'none') return this.say("The core can't be taken out.", true);
    if (touched) res.uids.forEach((u) => touched.add(u));
    const more = res.uids.length > 1 ? ` and ${res.uids.length - 1} cut off with it` : '';
    this.say(res.kind === 'marked' ? `Marked for recycling${more}. Right-click again to keep it.` : res.kind === 'unmarked' ? 'Kept.' : `Taken out of the design${more}.`);
    this.edited();
  }

  /** R / F / T with the mouse over a part of the design: turn it in place if it isn't built yet (build/editPlaced.ts). False: no part there */
  private turnPlaced(code: string): boolean {
    const v = this.view();
    const at = v && this.mouse ? this.gridAt(this.mouse.x, this.mouse.y) : null;
    const i = v && at ? partUnder(this.deps.catalog, v.w.bp.parts, at) : -1;
    if (!v || !at || i < 0) return false;
    if (v.w.standing[i]) { this.say('A built part stays as it is: turn it by recycling it and placing it again.', true); return true; }
    const r = tryTurn(this.deps.catalog, v.w.bp.parts, i, TURN_KEYS[code], at);
    if ('problem' in r) { this.say(r.problem[0].toUpperCase() + r.problem.slice(1) + '.', true); return true; }
    if (!replacePart(v.live, this.edits, v.w, i, r.part)) { this.say('The design is full (255 parts).', true); return true; }
    this.say(r.said + '.');
    this.edited();
    return true;
  }

  private pickUp(g: Vec2): void {
    const v = this.view();
    if (!v) return;
    const i = partAtPoint(this.deps.catalog, v.w, g);
    if (i < 0) return;
    const p = v.w.bp.parts[i];
    Object.assign(this.hand, { empty: false, piece: p.piece, fn: p.fn, material: p.material, rot: p.rot, flip: p.flip, facing: p.facing ? (p.facing as Side) : 'auto' });
    this.pal?.showInHand();
    this.say(`In hand: ${this.deps.econ.items.name(partItemId(p))}.`);
  }

  private edited(): void {
    this.rev++;
    this.costTick = 0;
  }

  /** A key the view uses while open (the feature's onKey): true if it took it */
  onKey(code: string): boolean {
    if (!this.isOpen) return false;
    if (code === 'Escape') {
      // (The first Escape puts the part in hand away, the second closes the view)
      if (escapeStep(!!this.hand.empty) === 'close') this.close();
      else { this.hand.empty = true; this.pal?.render(); this.say('Hand emptied: Esc again closes.'); }
      return true;
    }
    if (groupOfKey(code)) return this.groupKey(code);
    // (R / F / T over a part already in the design turn that part; elsewhere they act on the hand, below)
    if (TURN_KEYS[code] && this.turnPlaced(code)) return true;
    if (code === 'KeyR') { this.hand.rot = ((this.hand.rot + 1) & 3) as PaletteSel['rot']; this.pal?.renderHand(); return true; }
    if (code === 'KeyF') { this.hand.flip = !this.hand.flip; this.pal?.renderHand(); return true; }
    // (A gun's barrel is fixed to its piece: R turns it, T has nothing to cycle)
    if (code === 'KeyT' && hasFixedBarrel(this.deps.catalog, this.hand.fn)) return true;
    if (code === 'KeyT') { this.hand.facing = SIDE_CYCLE[(SIDE_CYCLE.indexOf(this.hand.facing) + 1) % SIDE_CYCLE.length]; this.pal?.renderHand(); return true; }
    return false;
  }

  /** 1-4 over a standing weapon: its weapon groups on the live ship (ships/weaponGroups/fieldEditor.ts) */
  private groupKey(code: string): boolean {
    const v = this.view(), ship = this.deps.ship();
    if (!v || !ship || !this.mouse) return false;
    const at = this.gridAt(this.mouse.x, this.mouse.y);
    const i = at ? partAtPoint(this.deps.catalog, v.w, at) : -1;
    if (i < 0) return false;
    // (The edits are laid over the live ship, so a refit for the groups keeps them: no need to save first)
    const r = fieldGroupEdit(code, ship, v.w.bp.parts[i].uid, false);
    if (!r) return false;
    if ('problem' in r) this.say(r.problem, true);
    else { this.deps.send(r.send); this.say(r.said); }
    return true;
  }

  // ---------------------------------------------------------------- save, undo, clear

  save(): void {
    const v = this.view();
    if (!v) return;
    const errors = targetErrors(this.deps.catalog, this.deps.tuning, v.w);
    if (errors.length) return this.say(errors[0].message.replace(/^[^:]*?\d+: /, '') + '.', true);
    this.deps.send({ type: 'fieldPlan', blueprint: planTarget(v.w) });
    const s = summary(v.live, this.edits);
    this.say(`Saved: ${s.added} to build, ${s.recycle} to recycle.`);
  }

  undo(): void {
    this.edits = noEdits();
    this.edited();
    this.say('Edits undone.');
  }

  clear(): void {
    this.deps.send({ type: 'fieldPlanClear' });
    this.edits = noEdits();
    this.edited();
    this.say('The ship as it stands: missing parts dropped, recycling stopped.');
  }

  // ---------------------------------------------------------------- each frame

  /** Once a frame: the edits the live ship now shows fall away, the footer stays honest, the view closes when the flight ends */
  update(): void {
    if (!this.isOpen) return;
    const ship = this.deps.ship();
    if (!ship || !this.deps.entity() || !this.deps.flying()) { this.close(); return; }
    const live = this.live();
    if (live && hasEdits(this.edits) && settle(live, this.edits)) this.edited();
    this.footer();
    // (the parts list shows costs against the hold, which moves as you fly: look every few frames)
    if (this.pal && ++this.frames % 15 === 0 && this.pal.stale()) this.pal.render();
  }
  private frames = 0;
  private costHtml = '';
  private costTick = 0;

  private footer(): void {
    const live = this.live();
    if (!live || !this.noteEl || !this.saveBtn || !this.clearBtn) return;
    const dirty = planChanged(live, this.edits);
    this.saveBtn.disabled = !dirty;
    this.clearBtn.disabled = !(live.alive.some((a, i) => !a && live.bp.parts[i]?.fn !== 'core') || live.queued.size);
    const s = summary(live, this.edits);
    const sum = dirty ? `${s.added} new, ${s.recycle} to recycle${s.dropped ? `, ${s.dropped} dropped` : ''}` : '';
    const v = this.view();
    const loose = v ? v.unjoined : new Set<number>();
    const hovered = v && this.mouse ? this.hoveredLoose(v, loose) : '';
    const text = [this.note, sum && `Unsaved: ${sum}.`, unjoinedText(loose.size), hovered].filter(Boolean).join(' ');
    if (this.noteEl.textContent !== text) this.noteEl.textContent = text;
    this.noteEl.classList.toggle('bad', this.noteBad);
    if (this.costEl) {
      // (Looked at every few frames: the hold and the machine move as you fly. Only a changed text touches the DOM, so a click on a link lands)
      const html = v && this.costTick++ % 10 === 0 ? fieldCostHtml(this.deps, v.w, loose) : this.costHtml;
      if (html !== this.costHtml || this.costEl.innerHTML === '') { this.costHtml = html; this.costEl.innerHTML = html; }
    }
  }

  /** The tooltip for a not-connected part under the mouse ('' if none) */
  private hoveredLoose(v: { w: WorkingDesign; unjoined: Set<number> }, loose: Set<number>): string {
    if (!loose.size || !this.mouse) return '';
    const at = this.gridAt(this.mouse.x, this.mouse.y);
    const i = at ? partAtPoint(this.deps.catalog, v.w, at) : -1;
    return i >= 0 && loose.has(v.w.bp.parts[i].uid) ? 'That part is not connected: nothing builds it until a part joins it to the core.' : '';
  }

  // ---------------------------------------------------------------- drawing

  /** The view on the pilot's own ship (the feature's drawShip): grid, missing parts, marked parts, marks, the hand */
  draw(g: Graphics, ctx: ShipDrawCtx): void {
    const v = this.isOpen ? this.view() : null;
    if (!v) return;
    this.cs = ctx.cs;
    const { w, geoms } = v;
    const X = frameOf(ctx);
    const at = (gx: number, gy: number) => X.at(gx, gy);
    const toScreen = (gx: number, gy: number) => { const p = X.at(gx, gy); return { x: p[0], y: p[1] }; };
    const paint = ctx.ship.blueprint.paint ? parseInt(ctx.ship.blueprint.paint.slice(1), 16) : undefined;
    // The grid round the design, faint
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of geoms) { minX = Math.min(minX, q.bbox.minX); minY = Math.min(minY, q.bbox.minY); maxX = Math.max(maxX, q.bbox.maxX); maxY = Math.max(maxY, q.bbox.maxY); }
    if (Number.isFinite(minX)) {
      const x0 = Math.floor(minX) - REACH, x1 = Math.ceil(maxX) + REACH, y0 = Math.floor(minY) - REACH, y1 = Math.ceil(maxY) + REACH;
      for (let x = x0; x <= x1; x++) { const a = X.at(x, y0), b = X.at(x, y1); g.moveTo(a[0], a[1]).lineTo(b[0], b[1]); }
      for (let y = y0; y <= y1; y++) { const a = X.at(x0, y), b = X.at(x1, y); g.moveTo(a[0], a[1]).lineTo(b[0], b[1]); }
      g.stroke({ width: ctx.cs * 0.02, color: 0x7dd3fc, alpha: 0.16 });
    }
    // The part a machine is building now: it fills in as the job goes
    const clocks = this.deps.clocks();
    w.bp.parts.forEach((p, i) => {
      const geom = geoms[i];
      if (w.marked.has(p.uid)) { fillPoly(g, X, geom, 0xef4444, 0.16, 0xef4444, 0.95); return; }
      if (w.standing[i]) return; // (built: the ship itself)
      const job = w.liveIndex[i] >= 0 ? fieldClient.jobFor(p.uid) : undefined;
      const k = job && job.job.kind === 'build' ? machineProgress(job.m, clocks) : 0;
      if (v.unjoined.has(p.uid)) {
        // (planned only: faint, dashed, never shown as being built)
        drawPartArt(g, this.deps.catalog, geom, at, ctx.cs, { alpha: LOOSE_ALPHA, paint });
        dashPoly(g, X, geom, LOOSE_LINE, 0.9, ctx.cs * 0.03);
        return;
      }
      drawPartArt(g, this.deps.catalog, geom, at, ctx.cs, { alpha: job ? BUILDING_ALPHA + 0.4 * k : MISSING_ALPHA, paint });
      // (placed now and not saved yet: outlined amber, as the hangar marks a part new since the last save)
      if (w.liveIndex[i] < 0) fillPoly(g, X, geom, 0xfbbf24, 0, 0xfbbf24, 0.8, 1.2);
    });
    // Which way each part faces, and what each shield covers
    w.bp.parts.forEach((p, i) => {
      drawFacingMark(g, p, geoms[i], toScreen, ctx.cs); // (the hangar's colours: guns warm, the rest cool)
      drawShieldCover(g, p, geoms[i], toScreen, ctx.cs, 0.35);
    });
    const live = this.deps.ship();
    if (live) drawFieldGroups(g, live, (uid) => geoms[w.bp.parts.findIndex((q) => q.uid === uid)], at, ctx.cs);
    if (this.mouse && this.near(this.gridAt(this.mouse.x, this.mouse.y) ?? [1e9, 1e9])) {
      const pv = this.preview(this.gridAt(this.mouse.x, this.mouse.y)!);
      if (pv) {
        const pg = placeGeometry(this.deps.catalog, pv.part);
        const ok = !pv.problem, tint = ok ? 0x4ade80 : 0xf87171;
        drawPartArt(g, this.deps.catalog, pg, at, ctx.cs, { alpha: 0.85, tint, tintK: 0.45, paint });
        fillPoly(g, X, pg, tint, 0, ok ? 0x86efac : 0xfca5a5, 0.95);
        drawFacingMark(g, pv.part, pg, toScreen, ctx.cs, ok ? 0xbbf7d0 : 0xfecaca);
        drawShieldCover(g, pv.part, pg, toScreen, ctx.cs, 0.8);
      }
    }
  }

  dispose(): void {
    this.close();
    this.root?.remove();
    this.root = undefined;
    this.pal = null;
  }

  /** Test seam: the target the view would send */
  get targetKey(): string { const w = this.design; return w ? JSON.stringify(planTarget(w)) : ''; }
}

// ---------------------------------------------------------------- shared drawing helpers

/** The ship's grid as drawn in the world now: a grid point to a world point */
export interface ShipFrame { at(gx: number, gy: number): [number, number] }

export function frameOf(ctx: Pick<ShipDrawCtx, 'entity' | 'ship' | 'cs'>): ShipFrame {
  const { entity, ship, cs } = ctx;
  const a = entity.renderAngle + Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
  const [cx, cy] = ship.derived.com;
  return {
    at(gx, gy) {
      const lx = (gx - cx) * cs, ly = (gy - cy) * cs;
      return [entity.renderX + lx * c - ly * s, entity.renderY + lx * s + ly * c];
    },
  };
}

/** A part's outline as dashes, in the world (a part planned but not connected) */
export function dashPoly(g: Graphics, X: ShipFrame, geom: PlacedGeom, line: number, alpha: number, width: number): void {
  const pts = geom.polygon.map(([x, y]) => X.at(x, y));
  const n = pts.length;
  for (let k = 0; k < n; k++) {
    const a = pts[k], b = pts[(k + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dash = Math.max(width * 3, 1), step = dash * 2, count = Math.max(1, Math.floor(len / step));
    for (let d = 0; d < count; d++) {
      const t0 = (d * step) / len, t1 = Math.min(1, (d * step + dash) / len);
      g.moveTo(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0).lineTo(a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1);
    }
  }
  g.stroke({ width, color: line, alpha });
}

/** A part's outline filled and stroked, in the world */
export function fillPoly(g: Graphics, X: ShipFrame, geom: PlacedGeom, fill: number, fillAlpha: number, line: number, lineAlpha: number, lineWidth = 1.6): void {
  const pts: number[] = [];
  for (const [x, y] of geom.polygon) { const w = X.at(x, y); pts.push(w[0], w[1]); }
  if (pts.length < 6) return;
  if (fillAlpha > 0) g.poly(pts).fill({ color: fill, alpha: fillAlpha });
  g.poly(pts).stroke({ width: lineWidth, color: line, alpha: lineAlpha });
}
