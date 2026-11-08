/**
 * The build overlay (docs/design/field-fabrication.md, rule 5): building in world space on the live game. Opening it
 * swaps to the helm view and zooms in on the ship, which keeps flying; the parts palette (HangarPalette, by import: the
 * hangar's own list) opens at the side, and the mouse builds on the ship itself:
 *
 *   left click   place the part in hand         right click   take a part out (a standing part: mark it for recycling)
 *   middle click pick a part up                 R turn · F mirror · T facing · Esc or the build key closes
 *
 * Clicks build only on and just around the ship; anywhere else they still fire and mine, and no flight key is touched,
 * so the ship is never held back. A save sends `fieldPlan` (free; only building costs), Clear sends `fieldPlanClear`.
 * Closing puts the zoom and the controls back as they were. The plan's editing is plan.ts, drawn by drawShip (index.ts).
 */
import { placeGeometry, partItemId, hasFixedBarrel } from '@space-game/common';
import type { Graphics } from 'pixi.js';
import type { PlacedGeom, PlacedPart, ShipState, Side, Vec2 } from '@space-game/common';
import type { HangarPalette, PaletteSel } from '../HangarPalette';
import type { ShipDrawCtx } from '../features/types';
import { fieldClient } from './fieldState';
import { drawFieldGroups, fieldGroupEdit } from '../weaponGroups/fieldEditor';
import { groupOfKey } from '../weaponGroups/editor';
import type { FieldDeps } from './bridge';
import {
  addPart, candidate, openDraft, partAtPoint, placementProblem, planChanged, planDiff, planTarget, removePart, targetErrors,
  targetGeoms, type PlanDraft,
} from './plan';

const SIDE_CYCLE: readonly (Side | 'auto')[] = ['auto', 'N', 'E', 'S', 'W'];
/** How far round the ship (cells) a click still builds */
const REACH = 3;

const STYLE = `
.fo { position: fixed; right: 0; top: 0; bottom: 0; width: 308px; z-index: 880; display: none; flex-direction: column; padding: 8px 8px 8px 10px;
  background: rgba(8, 14, 26, 0.93); border-left: 1px solid #1f2a40; color: #cfe0f5; font: 12px 'Segoe UI', system-ui, sans-serif; color-scheme: dark; }
.fo-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.fo-head b { flex: 1; letter-spacing: 0.4px; color: #e5ecf7; }
.fo-pal { flex: 1; min-height: 0; overflow: hidden; }
.fo-foot { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
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
  /** The plan being edited (null while closed) */
  draft: PlanDraft | null = null;
  readonly hand: PaletteSel = { piece: 'sq', fn: 'hull', material: 'alloy', rot: 0, flip: false, facing: 'auto' };

  private root?: HTMLDivElement;
  private palWrap?: HTMLDivElement;
  private pal: HangarPalette | null = null;
  private noteEl?: HTMLElement;
  private saveBtn?: HTMLButtonElement;
  private clearBtn?: HTMLButtonElement;
  private mouse: { x: number; y: number } | null = null;
  /** What opening changed (so closing can put it back) */
  private was: { zoom: number; helm: boolean } | null = null;
  /** The live ship's structure when the draft was taken (so a change under it is noticed) */
  private liveKey = '';
  private ghostKey = '';
  private awaiting = false;
  private cs = 0;
  private geoms: PlacedGeom[] = [];
  private geomsFor: PlanDraft | null = null;
  private geomsAt = -1;
  /** Bumps on each edit (the cache above and the footer follow it) */
  private rev = 0;
  private note = '';
  private noteBad = false;

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
    this.takeDraft(ship);
    this.ensurePanel();
    this.root!.style.display = 'flex';
    window.addEventListener('mousedown', this.onDown, true);
    window.addEventListener('mousemove', this.onMove, true);
    this.say('Click on the ship to place. Saving a plan is free: building costs materials.');
    void this.loadPalette();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    window.removeEventListener('mousedown', this.onDown, true);
    window.removeEventListener('mousemove', this.onMove, true);
    if (this.root) this.root.style.display = 'none';
    const was = this.was;
    this.was = null;
    this.draft = null;
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

  private takeDraft(ship: ShipState): void {
    this.draft = openDraft(ship.blueprint, ship.ghost, fieldClient.recycleUids());
    this.liveKey = structureKey(ship);
    this.ghostKey = ghostKey(ship);
    this.awaiting = false;
    this.rev++;
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
    root.innerHTML = `<div class="fo-head"><b>Build plan</b><button class="fo-btn" data-a="close" style="flex:none">Close</button></div>
      <div class="fo-pal"></div>
      <div class="fo-foot"><div class="fo-note"></div>
        <div class="fo-btns"><button class="fo-btn go" data-a="save">Save plan</button><button class="fo-btn" data-a="reset">Undo edits</button><button class="fo-btn" data-a="clear">Clear plan</button></div></div>`;
    root.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
      if (a === 'close') this.close();
      else if (a === 'save') this.save();
      else if (a === 'reset') this.undo();
      else if (a === 'clear') this.clear();
    });
    this.palWrap = root.querySelector<HTMLDivElement>('.fo-pal')!;
    this.noteEl = root.querySelector<HTMLElement>('.fo-note')!;
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
      // (A plan is free: any part can be planned. Building it is what takes materials, and the fabricator's tier decides what it can make)
      remaining: () => Infinity,
      canMake: (id) => deps.canMake(id),
      have: (id) => deps.have(id),
      level: () => deps.level(),
      learned: () => deps.learned(),
      owned: () => ({}),
      free: () => true,
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
  };

  /** Capture phase, before the game's own mouse handler: a click on or round the ship builds, any other still fires */
  private onDown = (e: MouseEvent): void => {
    if (!this.isOpen || !this.draft) return;
    const t = e.target as HTMLElement | null;
    if (!t || t.tagName !== 'CANVAS') return;
    const at = this.gridAt(e.clientX, e.clientY);
    if (!at || !this.near(at)) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.button === 0) this.place(at);
    else if (e.button === 2) this.take(at);
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
    const d = this.draft;
    if (!d) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of this.draftGeoms()) {
      minX = Math.min(minX, q.bbox.minX); minY = Math.min(minY, q.bbox.minY);
      maxX = Math.max(maxX, q.bbox.maxX); maxY = Math.max(maxY, q.bbox.maxY);
    }
    return g[0] >= minX - REACH && g[0] <= maxX + REACH && g[1] >= minY - REACH && g[1] <= maxY + REACH;
  }

  /** Every draft part's geometry (marked ones too), cached until an edit */
  draftGeoms(): PlacedGeom[] {
    const d = this.draft;
    if (!d) return [];
    if (this.geomsFor !== d || this.geomsAt !== this.rev) {
      this.geomsFor = d; this.geomsAt = this.rev;
      this.geoms = d.bp.parts.map((p) => placeGeometry(this.deps.catalog, p));
    }
    return this.geoms;
  }

  /** Why the part in hand can't be placed (the plan's rules, and the licence), or null */
  problemFor(p: PlacedPart): string | null {
    const d = this.draft;
    if (!d) return 'not open';
    const why = placementProblem(this.deps.catalog, d, p, this.deps.tuning);
    if (why) return why;
    const id = partItemId(p);
    if (!this.deps.canMake(id)) return `you can't make ${this.deps.econ.items.name(id)} yet`;
    return null;
  }

  /** The part in hand at a grid point, and whether it can go there (the hover preview) */
  preview(g: Vec2): { part: PlacedPart; problem: string | null } | null {
    const d = this.draft;
    if (!d) return null;
    const part = candidate(this.deps.catalog, d, this.hand, g);
    if (!part) return null;
    // (Checked against the whole design, so only when the cell, the hand or the plan changes)
    const h = this.hand;
    const key = `${this.rev}:${part.x},${part.y}:${h.piece}|${h.fn}|${h.material}|${h.rot}|${h.flip}|${part.facing ?? ''}`;
    if (this.previewKey !== key) { this.previewKey = key; this.previewProblem = this.problemFor(part); }
    return { part, problem: this.previewProblem };
  }
  private previewKey = '';
  private previewProblem: string | null = null;

  private place(g: Vec2): void {
    const d = this.draft!;
    const part = candidate(this.deps.catalog, d, this.hand, g);
    if (!part) return this.say('The design is full (255 parts).', true);
    const why = this.problemFor(part);
    if (why) return this.say(why[0].toUpperCase() + why.slice(1) + '.', true);
    addPart(d, part);
    this.edited();
  }

  private take(g: Vec2): void {
    const d = this.draft!;
    const i = partAtPoint(this.deps.catalog, d, g);
    if (i < 0) return;
    const res = removePart(this.deps.catalog, d, i);
    if (res.kind === 'none') return this.say("The core can't be taken out.", true);
    const more = res.uids.length > 1 ? ` and ${res.uids.length - 1} cut off with it` : '';
    this.say(res.kind === 'marked' ? `Marked for recycling${more}. Right-click again to keep it.` : res.kind === 'unmarked' ? 'Kept.' : `Taken out of the plan${more}.`);
    this.edited();
  }

  private pickUp(g: Vec2): void {
    const d = this.draft!;
    const i = partAtPoint(this.deps.catalog, d, g);
    if (i < 0) return;
    const p = d.bp.parts[i];
    Object.assign(this.hand, { piece: p.piece, fn: p.fn, material: p.material, rot: p.rot, flip: p.flip, facing: p.facing ? (p.facing as Side) : 'auto' });
    this.pal?.showInHand();
    this.say(`In hand: ${this.deps.econ.items.name(partItemId(p))}.`);
  }

  private edited(): void {
    this.rev++;
  }

  /** A key the overlay uses while open (the feature's onKey): true if it took it */
  onKey(code: string): boolean {
    if (!this.isOpen) return false;
    if (code === 'Escape') { this.close(); return true; }
    if (groupOfKey(code)) return this.groupKey(code);
    if (code === 'KeyR') { this.hand.rot = ((this.hand.rot + 1) & 3) as PaletteSel['rot']; this.pal?.renderHand(); return true; }
    if (code === 'KeyF') { this.hand.flip = !this.hand.flip; this.pal?.renderHand(); return true; }
    // (A gun's barrel is fixed to its piece: R turns it, T has nothing to cycle)
    if (code === 'KeyT' && hasFixedBarrel(this.deps.catalog, this.hand.fn)) return true;
    if (code === 'KeyT') { this.hand.facing = SIDE_CYCLE[(SIDE_CYCLE.indexOf(this.hand.facing) + 1) % SIDE_CYCLE.length]; this.pal?.renderHand(); return true; }
    return false;
  }

  /** 1-4 over a standing weapon: its weapon groups on the live ship (ships/weaponGroups/fieldEditor.ts) */
  private groupKey(code: string): boolean {
    const d = this.draft, ship = this.deps.ship();
    if (!d || !ship || !this.mouse) return false;
    const at = this.gridAt(this.mouse.x, this.mouse.y);
    const i = at ? partAtPoint(this.deps.catalog, d, at) : -1;
    if (i < 0) return false;
    const r = fieldGroupEdit(code, ship, d.bp.parts[i].uid, planChanged(d, fieldClient.recycleUids()));
    if (!r) return false;
    if ('problem' in r) this.say(r.problem, true);
    else { this.deps.send(r.send); this.say(r.said); }
    return true;
  }

  // ---------------------------------------------------------------- save, undo, clear

  save(): void {
    const d = this.draft;
    if (!d) return;
    const errors = targetErrors(this.deps.catalog, this.deps.tuning, d);
    if (errors.length) return this.say(errors[0].message.replace(/^[^:]*?\d+: /, '') + '.', true);
    this.deps.send({ type: 'fieldPlan', blueprint: planTarget(d) });
    this.awaiting = true;
    const diff = planDiff(d);
    this.say(`Plan saved: ${diff.added.length} to build, ${diff.recycle.length} to recycle.`);
  }

  undo(): void {
    const ship = this.deps.ship();
    if (ship && this.draft) { this.takeDraft(ship); this.say('Edits undone.'); }
  }

  clear(): void {
    this.deps.send({ type: 'fieldPlanClear' });
    this.awaiting = true;
    this.say('Plan cleared: the ship as it stands.');
  }

  // ---------------------------------------------------------------- each frame

  /** Once a frame: follow the live ship, keep the panel's footer honest, close when the flight ends */
  update(): void {
    if (!this.isOpen) return;
    const ship = this.deps.ship();
    if (!ship || !this.deps.entity() || !this.deps.flying()) { this.close(); return; }
    const d = this.draft!;
    const key = structureKey(ship);
    if (key !== this.liveKey) {
      // The ship changed under the draft (a plan saved, a part built or recycled, a part lost): start again from it
      const lost = !this.awaiting && planChanged(d, fieldClient.recycleUids());
      this.takeDraft(ship);
      if (lost) this.say('The ship changed: your edits were undone.', true);
    } else {
      const gk = ghostKey(ship);
      if (gk !== this.ghostKey) {
        // A planned part was built: it is a standing part now
        this.ghostKey = gk;
        d.planned = new Set(ship.blueprint.parts.filter((_, i) => ship.ghost?.[i]).map((p) => p.uid));
        this.rev++;
      }
    }
    this.footer();
  }

  private footer(): void {
    const d = this.draft;
    if (!d || !this.noteEl || !this.saveBtn || !this.clearBtn) return;
    const diff = planDiff(d);
    const dirty = planChanged(d, fieldClient.recycleUids());
    this.saveBtn.disabled = !dirty;
    this.clearBtn.disabled = !(d.planned.size || fieldClient.recycleUids().size);
    const sum = dirty ? `${diff.added.length} new, ${diff.recycle.length} to recycle${diff.dropped.length ? `, ${diff.dropped.length} dropped` : ''}` : '';
    const text = [this.note, sum && `Unsaved: ${sum}.`].filter(Boolean).join(' ');
    if (this.noteEl.textContent !== text) this.noteEl.textContent = text;
    this.noteEl.classList.toggle('bad', this.noteBad);
  }

  // ---------------------------------------------------------------- drawing

  /** The overlay's marks on the pilot's own ship (the feature's drawShip): grid, new parts, marked parts, the hover */
  draw(g: Graphics, ctx: ShipDrawCtx): void {
    const d = this.draft;
    if (!this.isOpen || !d) return;
    this.cs = ctx.cs;
    const X = frameOf(ctx);
    const geoms = this.draftGeoms();
    // The grid round the design, faint
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of geoms) { minX = Math.min(minX, q.bbox.minX); minY = Math.min(minY, q.bbox.minY); maxX = Math.max(maxX, q.bbox.maxX); maxY = Math.max(maxY, q.bbox.maxY); }
    if (Number.isFinite(minX)) {
      const x0 = Math.floor(minX) - REACH, x1 = Math.ceil(maxX) + REACH, y0 = Math.floor(minY) - REACH, y1 = Math.ceil(maxY) + REACH;
      for (let x = x0; x <= x1; x++) { const a = X.at(x, y0), b = X.at(x, y1); g.moveTo(a[0], a[1]).lineTo(b[0], b[1]); }
      for (let y = y0; y <= y1; y++) { const a = X.at(x0, y), b = X.at(x1, y); g.moveTo(a[0], a[1]).lineTo(b[0], b[1]); }
      g.stroke({ width: ctx.cs * 0.02, color: 0x7dd3fc, alpha: 0.16 });
    }
    d.bp.parts.forEach((p, i) => {
      if (d.marked.has(p.uid)) fillPoly(g, X, geoms[i], 0xef4444, 0.18, 0xef4444, 0.95);
      else if (!d.live.has(p.uid)) fillPoly(g, X, geoms[i], 0x38bdf8, 0.28, 0x7dd3fc, 0.95);
    });
    const live = this.deps.ship();
    if (live) drawFieldGroups(g, live, (uid) => geoms[d.bp.parts.findIndex((q) => q.uid === uid)], (gx, gy) => X.at(gx, gy), ctx.cs);
    if (this.mouse && this.near(this.gridAt(this.mouse.x, this.mouse.y) ?? [1e9, 1e9])) {
      const at = this.gridAt(this.mouse.x, this.mouse.y)!;
      const pv = this.preview(at);
      if (pv) {
        const pg = placeGeometry(this.deps.catalog, pv.part);
        const ok = !pv.problem;
        fillPoly(g, X, pg, ok ? 0x4ade80 : 0xf87171, 0.3, ok ? 0x86efac : 0xfca5a5, 0.95);
      }
    }
  }

  dispose(): void {
    this.close();
    this.root?.remove();
    this.root = undefined;
    this.pal = null;
  }

  /** Test seam: the targets the overlay would send */
  get targetKey(): string { return this.draft ? JSON.stringify(planTarget(this.draft)) : ''; }
  /** Test seam: the geometry of the kept parts */
  keptGeoms(): PlacedGeom[] { return this.draft ? targetGeoms(this.deps.catalog, this.draft) : []; }
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

/** A part's outline filled and stroked, in the world */
export function fillPoly(g: Graphics, X: ShipFrame, geom: PlacedGeom, fill: number, fillAlpha: number, line: number, lineAlpha: number, lineWidth = 1.6): void {
  const pts: number[] = [];
  for (const [x, y] of geom.polygon) { const w = X.at(x, y); pts.push(w[0], w[1]); }
  if (pts.length < 6) return;
  g.poly(pts).fill({ color: fill, alpha: fillAlpha });
  g.poly(pts).stroke({ width: lineWidth, color: line, alpha: lineAlpha });
}

/** What changes a ship's structure: its part list and rebuild count (not the planned flags, which flip as parts are built) */
function structureKey(ship: ShipState): string {
  let h = ship.blueprint.parts.length;
  for (const p of ship.blueprint.parts) h = (h * 31 + p.uid) | 0;
  return `${ship.rebuilds}:${h}`;
}

const ghostKey = (ship: ShipState): string => (ship.ghost ?? []).map((b) => (b ? 1 : 0)).join('');
