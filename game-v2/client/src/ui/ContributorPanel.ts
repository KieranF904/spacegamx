/**
 * The contributor tools (contributors and admins only; F6): notes pinned to
 * the map for whoever builds the game next (common/src/world/contributorNotes.ts).
 *
 *   F6         the panel (opening it turns the overlay on)
 *   Shift+F6   the overlay alone: notes drawn in flight and on the system map
 *
 * New note: pick a shape, then click in space or on the system map (M) to
 * place it; drag to size it (circle and ring radius, rectangle corners, line
 * end). A polygon is clicked out corner by corner, right-click (or Enter)
 * closes it. Then choose how it moves: fixed, orbiting the centre or the
 * nearest planet (suggested from where you clicked), or attached to the
 * nearest body; a title, the note, a colour, and save.
 *
 * While the panel is open the mouse is the tools' (the ship neither turns
 * nor fires; keys still fly it): click a note (its pin, outline or inside) to
 * select it, and open it for editing if it's yours (admins: anyone's); drag
 * it to move it (then save); Delete deletes it (press twice); right-click lets
 * go. A placed note you don't want: Discard. The list's Delete all shown
 * clears what the filters show, as one change.
 *
 * The list shows everyone's notes, here or in every system, filtered by
 * author (Mine, Everyone's, one person's) and status, newest or most liked
 * first: fly there (autopilot), look (the camera goes to it; Esc back), edit
 * or delete your own (admins: anyone's) and set its status. Click a row, or
 * someone else's note in space, for its detail view: the note in full, a
 * thumbs up or down (not on your own), and its comments (contributorModel.ts
 * has the list's rules and the detail view's markup). The server checks all
 * of it (server/src/game/ContributorNotes.ts); notes come only while the
 * overlay is on. scripts/contributor-notes.mjs fetches them for the terminal.
 */

import {
  nearestNoteBody, noteAnchorPosition, orbitThrough, NOTE_LIMITS, NOTE_FEEDBACK_LIMITS,
  type ClientMessage, type ContributorNote, type NoteAnchor, type NoteBodies, type NoteDraft, type NoteShape, type NoteShapeKind,
  type NoteSort, type NoteStatus, type PlanetData, type StarSystemData, type StationData,
} from '@space-game/common';
import { MINE, STATUS_WORD, detailHtml, listNotes, nextVote, noteAuthors, noteControls, noteCounts, rowMeta, type NoteScope } from './contributorModel';
import type { GameState } from '../state/GameState';
import type { SystemMap } from './systemMapLazy';
import type { AutoDest } from '../ships/Autopilot';
import { drawDraft, drawNotes, noteAt } from '../rendering/contributorDraw';
import systemsData from '../../../data/systems.json';
import stationsData from '../../../data/stations.json';
import { esc } from './escape';
import { boundKeyName } from '../input/keybindings';
import { settings } from '../settings/Settings';

export interface ContributorDeps {
  send(msg: ClientMessage): void;
  state: GameState;
  /** Your username */
  me(): string;
  isAdmin(): boolean;
  screenToWorld(x: number, y: number): { x: number; y: number };
  worldToScreen(x: number, y: number): { x: number; y: number };
  zoom(): number;
  map: SystemMap;
  flyTo(dest: AutoDest): void;
  /** The camera follows this instead of your ship (null: your ship again) */
  setCamera(target: (() => { x: number; y: number } | null) | null): void;
  /** Whether the dev warp is on offer (the owner, or a dev server); absent: admins */
  canWarp?(): boolean;
  /** Admins: warp there */
  warp(system: string, x: number, y: number): void;
}

type Movement = 'keep' | 'fixed' | 'orbit-centre' | 'orbit-body' | 'attached';

const SYSTEMS = (systemsData as unknown as { systems: StarSystemData[] }).systems;
const STATIONS = (stationsData as unknown as { stations: StationData[] }).stations;
const SHAPES: { kind: NoteShapeKind; label: string; tip: string }[] = [
  { kind: 'point', label: '📍', tip: 'Pin' }, { kind: 'circle', label: '◯', tip: 'Circle (drag the radius)' }, { kind: 'ring', label: '◎', tip: 'Ring (drag the outer radius)' },
  { kind: 'rect', label: '▭', tip: 'Rectangle (drag corner to corner)' }, { kind: 'line', label: '╱', tip: 'Line (drag to the end)' },
  { kind: 'arrow', label: '➚', tip: 'Arrow (drag to the head)' }, { kind: 'polygon', label: '⬠', tip: 'Polygon (click the corners, right-click or Enter closes it)' },
];
const COLORS = ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#f87171', '#e2e8f0'];

const fmt = (n: number) => (Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(Math.abs(n) >= 100000 ? 0 : 1)}k` : `${Math.round(n)}`);

/** A system's bodies for placing notes about */
export function systemBodies(id: string): NoteBodies {
  const s = SYSTEMS.find((x) => x.id === id);
  return { planets: s?.planets, nests: s?.nests, lodestones: s?.lodestones, stations: STATIONS.filter((st) => st.system === id) };
}

let styled = false;
function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.ctb { position: fixed; top: 70px; left: 12px; width: 344px; max-height: calc(100vh - 140px); z-index: 2600; display: none; flex-direction: column;
  background: linear-gradient(180deg, rgba(10, 22, 26, 0.96), rgba(6, 12, 16, 0.96)); border: 1px solid rgba(45, 212, 191, 0.35); border-radius: 12px;
  box-shadow: 0 16px 50px rgba(0,0,0,0.5); color: #dbe7e6; font: 12px 'Segoe UI', system-ui, sans-serif; color-scheme: dark; }
.ctb.on { display: flex; }
.ctb * { scrollbar-width: thin; scrollbar-color: rgba(45, 212, 191, 0.3) transparent; box-sizing: border-box; }
.ctb-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid rgba(45, 212, 191, 0.18); cursor: move; user-select: none; }
.ctb-title { font: 700 11px 'Segoe UI', sans-serif; letter-spacing: 3px; color: #2dd4bf; }
.ctb-head .sp { flex: 1; }
.ctb-head .k { color: #7c8f8d; font-size: 11px; }
.ctb-x { all: unset; cursor: pointer; padding: 0 6px; color: #9ab; font-size: 16px; }
.ctb-x:hover { color: #fff; }
.ctb-body { padding: 8px 12px 10px; overflow: auto; flex: 1; min-height: 0; }
.ctb-sec { margin: 10px 0 5px; color: #2dd4bf; font-weight: 600; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; display: flex; gap: 6px; align-items: center; }
.ctb-sec:first-child { margin-top: 0; }
.ctb-row { display: flex; gap: 6px; align-items: center; margin: 4px 0; flex-wrap: wrap; }
.ctb-btn { all: unset; cursor: pointer; padding: 4px 8px; border-radius: 7px; border: 1px solid rgba(45, 212, 191, 0.28); color: #e2eeec; text-align: center; white-space: nowrap; }
.ctb-btn:hover { background: rgba(45, 212, 191, 0.12); border-color: rgba(45, 212, 191, 0.6); }
.ctb-btn.on { background: rgba(45, 212, 191, 0.22); border-color: #2dd4bf; color: #fff; }
.ctb-btn.bad { color: #fca5a5; }
.ctb-btn.sm { padding: 1px 6px; font-size: 11px; }
.ctb-btn.shape { width: 26px; padding: 3px 0; font-size: 14px; }
.ctb-in { background: rgba(0,0,0,0.35); border: 1px solid rgba(45, 212, 191, 0.25); border-radius: 7px; color: #eef6f5; padding: 4px 7px; font: inherit; outline: none; min-width: 0; }
.ctb-in:focus { border-color: rgba(45, 212, 191, 0.7); }
textarea.ctb-in { width: 100%; min-height: 64px; resize: vertical; }
select.ctb-in { padding: 3px 4px; }
.ctb-in.n { width: 70px; }
.ctb-grow { flex: 1; }
.ctb-sw { width: 16px; height: 16px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; }
.ctb-sw.on { border-color: #fff; }
.ctb-hint { color: #7c8f8d; font-size: 11px; }
.ctb-msg { font-size: 11px; min-height: 14px; }
.ctb-msg.bad { color: #fca5a5; } .ctb-msg.ok { color: #86efac; }
.ctb-list { display: flex; flex-direction: column; gap: 3px; }
.ctb-note { padding: 5px 6px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.05); cursor: pointer; }
.ctb-note:hover, .ctb-note.focus { background: rgba(45, 212, 191, 0.08); border-color: rgba(45, 212, 191, 0.3); }
.ctb-note.dim { opacity: 0.55; }
.ctb-note .t { font-weight: 600; display: flex; gap: 6px; align-items: center; }
.ctb-note .t i { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.ctb-note .sub { color: #7c8f8d; font: 10px 'Consolas', monospace; margin: 1px 0 3px 15px; }
.ctb-note .acts { display: flex; gap: 4px; margin-left: 15px; flex-wrap: wrap; }
.ctb-tag { font-size: 9px; padding: 0 5px; border-radius: 4px; background: rgba(45, 212, 191, 0.18); color: #99f6e4; font-weight: 400; }
.ctb-tag.done { background: rgba(134, 239, 172, 0.18); color: #bbf7d0; } .ctb-tag.wontdo { background: rgba(248, 113, 113, 0.18); color: #fecaca; }
.ctb-tag.you { background: rgba(255, 255, 255, 0.14); color: #e2e8f0; }
.ctb-note .t .cnt { margin-left: auto; font-weight: 400; font-size: 10px; color: #9fb3b1; white-space: nowrap; }
.ctb-list { max-height: 46vh; overflow: auto; }
.ctb-dt { font-weight: 600; font-size: 13px; display: flex; gap: 6px; align-items: center; margin: 8px 0 2px; overflow-wrap: anywhere; }
.ctb-dt i { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.ctb-dsub { color: #7c8f8d; font-size: 11px; margin-bottom: 6px; }
.ctb-dtext { white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(0,0,0,0.25); border-radius: 7px; padding: 6px 8px; margin: 4px 0; max-height: 30vh; overflow: auto; }
.ctb-count { padding: 1px 6px; color: #9fb3b1; font-size: 11px; }
.ctb-comments { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
.ctb-cmt { padding: 4px 6px; border-radius: 7px; background: rgba(255,255,255,0.04); }
.ctb-cmt .who { display: flex; gap: 4px; align-items: center; color: #7c8f8d; font-size: 11px; }
.ctb-cmt .who b { color: #99f6e4; font-weight: 600; }
.ctb-cmt .txt { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
.ctb-veil { position: fixed; inset: 0; z-index: 2300; cursor: crosshair; display: none; }
.ctb-veil.on { display: block; }
/* Selecting notes (the panel open): just over the world, under the HUD and windows */
.ctb-veil.edit { z-index: 55; cursor: default; }
.ctb-veil.edit.over { cursor: pointer; }
.ctb-banner { position: fixed; left: 50%; top: 64px; transform: translateX(-50%); z-index: 2601; padding: 6px 14px; border-radius: 999px; display: none;
  background: rgba(6, 26, 26, 0.92); border: 1px solid rgba(45, 212, 191, 0.6); color: #ccfbf1; font: 12px 'Segoe UI', sans-serif; pointer-events: none; }
.ctb-banner.on { display: block; }
.ctb-fab { position: fixed; left: 346px; bottom: 210px; z-index: 900; display: none; padding: 5px 10px; border-radius: 999px; cursor: pointer;
  background: rgba(6, 26, 26, 0.85); border: 1px solid rgba(45, 212, 191, 0.5); color: #99f6e4; font: 600 11px 'Segoe UI', sans-serif; letter-spacing: 1px; user-select: none; }
.ctb-fab.on { display: block; }
.ctb-fab.lit { background: rgba(45, 212, 191, 0.25); color: #fff; }
.ctb-canvas { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 60; }
`;
  document.head.appendChild(css);
}

export class ContributorPanel {
  private root = document.createElement('div');
  private body: HTMLElement;
  private veil = document.createElement('div');
  private banner = document.createElement('div');
  private fab = document.createElement('div');
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  /** Every note we've been sent, by id */
  private notes = new Map<string, ContributorNote>();
  private overlay = false;
  private system = '';
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private canvasClear = true;

  // The note being made or edited
  private shape: NoteShapeKind = 'circle';
  /** Clicking it out: where the press went down, where the cursor is, a polygon's corners so far (relative to the first) */
  private placing: { down: { x: number; y: number } | null; cur: { x: number; y: number } | null; poly: [number, number][] } | null = null;
  /** Placed (not saved yet): its anchor point now and its shape */
  private draft: { at: { x: number; y: number }; shape: NoteShape } | null = null;
  private editing: ContributorNote | null = null;
  private movement: Movement = 'orbit-centre';
  private period = 0;
  private direction: 1 | -1 = 1;
  private color = COLORS[0];
  private form = { title: '', text: '', sizeHint: '' };
  private saving = false;
  private message: { ok: boolean; text: string } | null = null;
  /** Dragging a selected note: where the press went down (world) and where the note was then; `moved` once it has */
  private drag: { from: { x: number; y: number }; at0: { x: number; y: number }; moved: boolean } | null = null;
  /** A delete waiting on its second press: a note's id, or '*' for everything the list shows */
  private armed: string | null = null;

  // The list
  private filterAuthor = '';
  private filterStatus: NoteStatus | 'all' = 'open';
  private scope: NoteScope = 'here';
  private sort: NoteSort = 'newest';
  /** The note whose detail view is up (its votes and comments), in place of the form and list */
  private detail: string | null = null;
  private commentText = '';
  /** A comment sent, not yet answered (the box clears when it's taken) */
  private posting = false;
  private focus: string | null = null;
  private looking: string | null = null;
  private listKey = '';

  constructor(private deps: ContributorDeps) {
    injectStyles();
    this.root.className = 'ctb';
    this.root.innerHTML = `
      <div class="ctb-head"><span class="ctb-title">CONTRIBUTOR NOTES</span><span class="sp"></span><span class="k">F6 · Shift+F6 overlay</span><button class="ctb-x" title="Close (F6)">×</button></div>
      <div class="ctb-body"></div>`;
    this.body = this.root.querySelector('.ctb-body')!;
    this.root.querySelector('.ctb-x')!.addEventListener('click', () => this.toggle(false));
    // Typing in the panel never flies the ship, opens chat or the map
    this.root.addEventListener('keydown', (e) => { if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName) && e.code !== 'Escape') e.stopPropagation(); });
    this.dragging();
    document.body.appendChild(this.root);

    // Placing in flight: the veil takes the mouse (so the guns don't fire)
    this.veil.className = 'ctb-veil';
    const world = (e: MouseEvent) => this.deps.screenToWorld(e.clientX, e.clientY);
    this.veil.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const p = world(e);
      if (this.placing) this.placeDown(p.x, p.y, e.button); else this.selectDown(e.clientX, e.clientY, p, e.button);
    });
    this.veil.addEventListener('mousemove', (e) => {
      const p = world(e);
      if (this.placing) this.placeMove(p.x, p.y); else this.selectMove(e.clientX, e.clientY, p);
    });
    this.veil.addEventListener('mouseup', (e) => {
      e.preventDefault(); e.stopPropagation();
      const p = world(e);
      if (this.placing) this.placeUp(p.x, p.y, e.button); else this.selectUp();
    });
    this.veil.addEventListener('contextmenu', (e) => e.preventDefault());
    // Selecting: the wheel still zooms (passed on to whatever's under the veil); placing: it's held still
    this.veil.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.placing) return;
      const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el !== this.veil && el !== this.canvas);
      under?.dispatchEvent(new WheelEvent('wheel', e));
    }, { passive: false });
    document.body.appendChild(this.veil);
    this.banner.className = 'ctb-banner';
    document.body.appendChild(this.banner);

    this.fab.className = 'ctb-fab on';
    this.fab.textContent = '✎ NOTES';
    this.fab.title = 'Contributor notes (F6) · Shift+F6: overlay only';
    this.fab.addEventListener('click', (e) => { if (e.shiftKey) this.setOverlay(!this.overlay); else this.toggle(); });
    document.body.appendChild(this.fab);

    this.canvas.className = 'ctb-canvas';
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.deps.map.notesOverlay = (ctx, sx, sy, S, w, h) => this.drawOnMap(ctx, sx, sy, S, w, h);
    window.addEventListener('keydown', this.keyHandler, true);
  }

  get isOpen(): boolean {
    return this.root.classList.contains('on');
  }

  toggle(on = !this.isOpen): void {
    this.root.classList.toggle('on', on);
    if (on) { this.setOverlay(true); this.render(); }
  }

  setOverlay(on: boolean): void {
    if (this.overlay === on) return;
    this.overlay = on;
    this.fab.classList.toggle('lit', on);
    this.system = this.deps.state.systemId;
    this.deps.send({ type: 'contrib', op: 'overlay', on, system: this.system });
    if (on && this.scope === 'all') this.deps.send({ type: 'contrib', op: 'list', system: '*' });
    if (!on) this.stopLooking();
  }

  // ---------------------------------------------------------------------------
  // From the server

  onNotes(system: string, list: ContributorNote[]): void {
    for (const [id, n] of this.notes) if (system === '*' || n.system === system) this.notes.delete(id);
    for (const n of list) this.notes.set(n.id, n);
    this.renderList();
  }

  onNote(n: ContributorNote): void {
    this.notes.set(n.id, n);
    if (this.editing?.id === n.id && !this.saving) this.editing = n;
    this.renderList();
  }

  onGone(id: string): void {
    this.notes.delete(id);
    if (this.editing?.id === id) this.clearForm();
    if (this.looking === id) this.stopLooking();
    if (this.detail === id) { this.detail = null; this.render(); return; }
    this.renderList();
  }

  onResult(ok: boolean, text: string): void {
    this.message = { ok, text };
    if (ok && this.saving) this.clearForm();
    this.saving = false;
    if (ok && this.posting) this.commentText = '';
    this.posting = false;
    this.render();
  }

  /** Signed out, or the rank went: away with it */
  destroy(): void {
    this.endPlacing();
    this.stopLooking();
    this.deps.map.notesOverlay = null;
    this.deps.map.placeHook = null;
    window.removeEventListener('keydown', this.keyHandler, true);
    for (const el of [this.root, this.veil, this.banner, this.fab, this.canvas]) el.remove();
  }

  /** Each frame: follow system changes, draw the overlay in flight */
  update(): void {
    const sys = this.deps.state.systemId;
    if (sys !== this.system) {
      this.system = sys;
      if (this.overlay) this.deps.send({ type: 'contrib', op: 'list', system: sys });
      if (this.placing || this.draft) { this.endPlacing(); this.draft = null; }
      this.render();
    }
    // The veil: for placing, and while the panel is open, for selecting (not over the system map: it has its own clicks)
    const selecting = !this.placing && this.isOpen && this.overlay && !this.deps.map.covers();
    this.veil.classList.toggle('on', !!this.placing || selecting);
    this.veil.classList.toggle('edit', selecting);
    if (!selecting && this.drag) this.drag = null;
    this.drawWorld();
  }

  // ---------------------------------------------------------------------------
  // Selecting (the panel open: the mouse is the tools')

  private view() {
    return { toScreen: (x: number, y: number) => this.deps.worldToScreen(x, y), scale: this.deps.zoom(), tick: this.deps.state.getRawServerTick(), bodies: systemBodies(this.system) };
  }

  private selectDown(sx: number, sy: number, p: { x: number; y: number }, button: number): void {
    if (button === 2) {
      // Let go: stop editing (unsaved moves are dropped), clear the selection
      if (this.editing || this.focus || this.detail) { this.clearForm(); this.focus = null; this.detail = null; this.armed = null; this.message = null; this.render(); }
      return;
    }
    if (button !== 0) return;
    const n = noteAt(this.here(), sx, sy, this.view());
    if (!n) return;
    this.focus = n.id;
    this.armed = null;
    if (this.mayEdit(n)) {
      if (this.editing?.id !== n.id || this.detail) this.edit(n);
      if (this.draft) this.drag = { from: p, at0: { ...this.draft.at }, moved: false };
    } else {
      // Someone else's: read it, vote, comment
      this.openDetail(n.id);
    }
  }

  private selectMove(sx: number, sy: number, p: { x: number; y: number }): void {
    const d = this.drag;
    if (d && this.draft) {
      const dx = p.x - d.from.x, dy = p.y - d.from.y;
      if (!d.moved && Math.hypot(dx, dy) * this.deps.zoom() < 4) return;
      d.moved = true;
      this.draft.at = { x: d.at0.x + dx, y: d.at0.y + dy };
      return;
    }
    // A pointer over something clickable
    this.veil.classList.toggle('over', !!noteAt(this.here(), sx, sy, this.view()));
  }

  private selectUp(): void {
    const d = this.drag;
    this.drag = null;
    if (!d?.moved || !this.draft) return;
    // Moved: how it moves now is worked out afresh from where it was dropped
    this.suggest(false);
    this.message = { ok: true, text: 'Moved: Save changes to keep it there (right-click: put it back)' };
    this.render();
  }

  private deleteNote(n: ContributorNote): void {
    if (this.armed !== n.id) { this.armed = n.id; this.message = { ok: false, text: `Delete “${n.title}”? Press Delete again` }; this.render(); return; }
    this.armed = null;
    this.deps.send({ type: 'contrib', op: 'delete', id: n.id });
  }

  // ---------------------------------------------------------------------------
  // Drawing

  private here(): ContributorNote[] {
    return [...this.notes.values()].filter((n) => n.system === this.system);
  }

  private drawWorld(): void {
    const show = this.overlay && !this.deps.map.covers();
    if (!show) {
      if (!this.canvasClear) { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.canvasClear = true; }
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.canvasClear = false;
    const scale = this.deps.zoom();
    const toScreen = (x: number, y: number) => this.deps.worldToScreen(x, y);
    drawNotes(ctx, this.here(), { toScreen, scale, w, h, tick: this.deps.state.getRawServerTick(), bodies: systemBodies(this.system), focus: this.focus ?? this.editing?.id, mine: this.isMine });
    this.drawPlacing(ctx, toScreen, scale);
  }

  private viewer() {
    return { name: this.deps.me(), isAdmin: this.deps.isAdmin() };
  }

  private isMine = (n: ContributorNote): boolean => n.author.toLowerCase() === this.deps.me().toLowerCase();

  private drawOnMap(ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number, S: number, w: number, h: number): void {
    this.mapScale = S;
    if (!this.overlay && !this.placing && !this.draft) return;
    const toScreen = (x: number, y: number) => ({ x: sx(x), y: sy(y) });
    if (this.overlay) drawNotes(ctx, this.here(), { toScreen, scale: S, w, h, tick: this.deps.state.getRawServerTick(), bodies: systemBodies(this.system), focus: this.focus ?? this.editing?.id, mine: this.isMine });
    this.drawPlacing(ctx, toScreen, S);
  }

  /** The shape being placed, or placed and waiting to be saved */
  private drawPlacing(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }, scale: number): void {
    const p = this.placing;
    if (p?.down) {
      const s = p.cur ? this.sizedShape(p.down, p.cur, scale) : { at: p.down, shape: { kind: 'point' } as NoteShape };
      drawDraft(ctx, s.shape, toScreen(s.at.x, s.at.y), this.color, scale, this.shape === 'polygon' && p.cur ? [...p.poly, [p.cur.x - p.down.x, p.cur.y - p.down.y]] : undefined);
    } else if (this.draft) {
      drawDraft(ctx, this.draft.shape, toScreen(this.draft.at.x, this.draft.at.y), this.color, scale);
    }
  }

  // ---------------------------------------------------------------------------
  // Placing

  private startPlacing(): void {
    this.placing = { down: null, cur: null, poly: [] };
    this.draft = null;
    this.veil.classList.add('on');
    this.deps.map.placeHook = { down: (x, y, b) => this.placeDown(x, y, b), move: (x, y) => this.placeMove(x, y), up: (x, y, b) => this.placeUp(x, y, b) };
    const what = SHAPES.find((s) => s.kind === this.shape)!.tip;
    this.banner.textContent = `${what}: click in space or on the map (${boundKeyName('map', settings.data.bindings)}) · Esc cancels`;
    this.banner.classList.add('on');
    this.render();
  }

  private endPlacing(): void {
    this.placing = null;
    this.veil.classList.remove('on');
    this.banner.classList.remove('on');
    this.deps.map.placeHook = null;
  }

  private placeDown(x: number, y: number, button: number): void {
    const p = this.placing;
    if (!p) return;
    if (button === 2) {
      // Right-click closes a polygon (else cancels)
      if (this.shape === 'polygon' && p.down && p.poly.length >= 3) this.finishPolygon();
      else { this.endPlacing(); this.render(); }
      return;
    }
    if (button !== 0) return;
    if (this.shape === 'polygon') {
      if (!p.down) { p.down = { x, y }; p.poly = [[0, 0]]; }
      else if (p.poly.length < NOTE_LIMITS.polygonPoints) p.poly.push([Math.round(x - p.down.x), Math.round(y - p.down.y)]);
      p.cur = { x, y };
      return;
    }
    p.down = { x, y };
    p.cur = null;
  }

  private placeMove(x: number, y: number): void {
    if (this.placing?.down) this.placing.cur = { x, y };
  }

  private placeUp(x: number, y: number, button: number): void {
    const p = this.placing;
    if (!p?.down || button !== 0 || this.shape === 'polygon') return;
    const scale = this.deps.map.isOpen ? this.mapScale : this.deps.zoom();
    const moved = Math.hypot(x - p.down.x, y - p.down.y) * scale > 6;
    // A click without a drag: a size that looks right at this zoom
    const end = moved ? { x, y } : { x: p.down.x + 70 / scale, y: p.down.y + (this.shape === 'line' || this.shape === 'arrow' ? 0 : 45 / scale) };
    this.draft = this.sizedShape(p.down, end, scale);
    this.endPlacing();
    this.suggest();
    this.render();
  }

  /** The system map's world → screen scale, as last drawn */
  private mapScale = 0.01;

  private finishPolygon(): void {
    const p = this.placing!;
    this.draft = { at: p.down!, shape: { kind: 'polygon', points: p.poly.slice(0, NOTE_LIMITS.polygonPoints) } };
    this.endPlacing();
    this.suggest();
    this.render();
  }

  /** The shape for a press at `a` dragged to `b` (and where its anchor goes) */
  private sizedShape(a: { x: number; y: number }, b: { x: number; y: number }, scale: number): { at: { x: number; y: number }; shape: NoteShape } {
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.hypot(dx, dy));
    const r = (n: number) => Math.max(1, Math.round(n));
    switch (this.shape) {
      case 'point': return { at: a, shape: { kind: 'point' } };
      case 'circle': return { at: a, shape: { kind: 'circle', radius: r(d) } };
      case 'ring': return { at: a, shape: { kind: 'ring', inner: r(d * 0.7), outer: r(d) } };
      case 'rect': return { at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, shape: { kind: 'rect', w: r(Math.abs(dx) || 10 / scale), h: r(Math.abs(dy) || 10 / scale), rotationDeg: 0 } };
      case 'line': case 'arrow': return { at: a, shape: { kind: this.shape, dx: Math.round(dx) || 1, dy: Math.round(dy) } };
      case 'polygon': return { at: a, shape: { kind: 'polygon', points: this.placing?.poly ?? [] } };
    }
  }

  /** Where it was put: suggest how it moves, and a period that matches what's there */
  private suggest(keepIfEditing = true): void {
    if (!this.draft) return;
    const { x, y } = this.draft.at;
    const tick = this.deps.state.getRawServerTick();
    const b = systemBodies(this.system);
    const planet = nearestNoteBody({ planets: b.planets }, x, y, tick);
    const any = nearestNoteBody(b, x, y, tick);
    const near = planet && planet.dist < Math.max(planet.radius * 8, 6000);
    const orbits = (b.planets ?? []).map((p) => p.orbit.radius);
    const fromCentre = Math.hypot(x, y);
    if (this.editing && keepIfEditing) this.movement = 'keep';
    else if (near) this.movement = 'orbit-body';
    else if (any && any.ref.kind !== 'planet' && any.ref.kind !== 'moon' && any.dist < 3000) this.movement = 'attached';
    else if (orbits.length && fromCentre > Math.min(...orbits) * 0.5 && fromCentre < Math.max(...orbits) * 1.3) this.movement = 'orbit-centre';
    else this.movement = 'fixed';
    this.period = this.matchPeriod(this.movement === 'keep' ? 'orbit-centre' : this.movement);
  }

  /** The period that matches where it is: a planet's at that distance from the centre, or the moons' of the planet it circles */
  private matchPeriod(m: Movement): number {
    if (!this.draft) return 0;
    const b = systemBodies(this.system);
    const tick = this.deps.state.getRawServerTick();
    const { x, y } = this.draft.at;
    if (m === 'orbit-body') {
      const near = nearestNoteBody({ planets: b.planets }, x, y, tick);
      const pl = near ? b.planets?.find((p) => p.id === near.ref.id) : undefined;
      const moon = pl?.moons?.find((mm) => mm.period);
      this.direction = (Math.sign(moon?.period ?? 1) || 1) as 1 | -1;
      return Math.abs(moon?.period ?? 10);
    }
    if (m === 'orbit-centre') {
      const d = Math.hypot(x, y);
      const best = [...(b.planets ?? [])].filter((p) => p.orbit.period).sort((p, q) => Math.abs(p.orbit.radius - d) - Math.abs(q.orbit.radius - d))[0] as PlanetData | undefined;
      this.direction = (Math.sign(best?.orbit.period ?? 1) || 1) as 1 | -1;
      return Math.abs(best?.orbit.period ?? 60);
    }
    return this.period;
  }

  /** The anchor for the chosen movement (null: keep the note's own) */
  private anchorFor(): NoteAnchor | null {
    if (!this.draft || this.movement === 'keep') return null;
    const { x, y } = this.draft.at;
    const tick = this.deps.state.getRawServerTick();
    const b = systemBodies(this.system);
    const r = Math.round;
    switch (this.movement) {
      case 'fixed': return { kind: 'fixed', x: r(x), y: r(y) };
      case 'orbit-centre': return orbitThrough({ kind: 'center' }, x, y, b, tick, this.period, this.direction);
      case 'orbit-body': {
        const near = nearestNoteBody({ planets: b.planets }, x, y, tick);
        if (!near) return orbitThrough({ kind: 'center' }, x, y, b, tick, this.period, this.direction);
        const around = near.ref.kind === 'moon' ? { kind: 'moon' as const, id: near.ref.id, moon: near.ref.moon } : { kind: 'planet' as const, id: near.ref.id };
        return orbitThrough(around, x, y, b, tick, this.period, this.direction);
      }
      case 'attached': {
        const near = nearestNoteBody(b, x, y, tick);
        if (!near) return { kind: 'fixed', x: r(x), y: r(y) };
        return { kind: 'attached', to: near.ref, dx: r(x - near.x), dy: r(y - near.y) };
      }
    }
    return null;
  }

  private movementLabels(): Record<Movement, string> {
    const tick = this.deps.state.getRawServerTick();
    const b = systemBodies(this.system);
    const at = this.draft?.at;
    const planet = at ? nearestNoteBody({ planets: b.planets }, at.x, at.y, tick) : null;
    const any = at ? nearestNoteBody(b, at.x, at.y, tick) : null;
    return {
      keep: 'Keep how it moves now',
      fixed: 'Fixed in place',
      'orbit-centre': 'Orbit the system centre',
      'orbit-body': planet ? `Orbit ${planet.name} (${fmt(planet.dist)} away)` : 'Orbit the nearest planet',
      attached: any ? `Attached to ${any.name} (${fmt(any.dist)} away)` : 'Attached to the nearest body',
    };
  }

  // ---------------------------------------------------------------------------
  // Saving, editing

  private quickText = '';

  /** A pin where your ship is, with whatever you typed: for notes taken mid-flight (no placing, shapes or movement to choose) */
  private quickNote(): void {
    const text = this.quickText.trim();
    if (!text) { this.message = { ok: false, text: 'Type the note first' }; this.render(); return; }
    const me = this.deps.state.entities.get(this.deps.state.playerId);
    if (!me) { this.message = { ok: false, text: 'No ship to pin it to' }; this.render(); return; }
    const title = text.slice(0, NOTE_LIMITS.title).replace(/\s+/g, ' ').trim();
    this.deps.send({ type: 'contrib', op: 'create', note: { system: this.deps.state.systemId, title, text: text.slice(0, NOTE_LIMITS.text), sizeHint: '', color: this.color, shape: { kind: 'point' }, anchor: { kind: 'fixed', x: Math.round(me.renderX), y: Math.round(me.renderY) } } });
    this.quickText = '';
    this.message = { ok: true, text: 'Noted' };
    this.render();
  }

  private save(): void {
    this.readForm();
    if (!this.form.title.trim()) { this.message = { ok: false, text: 'Give it a title' }; this.render(); return; }
    if (!this.draft && !this.editing) { this.message = { ok: false, text: 'Place it first: pick a shape and click on the map' }; this.render(); return; }
    const shape = this.draft?.shape ?? this.editing!.shape;
    const anchor = this.anchorFor() ?? this.editing?.anchor;
    if (!anchor) { this.message = { ok: false, text: 'How does it move?' }; this.render(); return; }
    const note: NoteDraft = { system: this.editing?.system ?? this.system, title: this.form.title, text: this.form.text, sizeHint: this.form.sizeHint, color: this.color, shape, anchor };
    this.saving = true;
    if (this.editing) this.deps.send({ type: 'contrib', op: 'update', id: this.editing.id, note });
    else this.deps.send({ type: 'contrib', op: 'create', note });
  }

  private edit(n: ContributorNote): void {
    this.detail = null;
    this.editing = n;
    this.form = { title: n.title, text: n.text, sizeHint: n.sizeHint ?? '' };
    this.color = n.color;
    this.shape = n.shape.kind;
    const at = noteAnchorPosition(n.anchor, systemBodies(n.system), this.deps.state.getRawServerTick());
    this.draft = at ? { at, shape: n.shape } : null;
    this.movement = 'keep';
    if (n.anchor.kind === 'orbit') { this.period = n.anchor.periodMinutes; this.direction = n.anchor.direction; }
    this.message = null;
    this.render();
  }

  private clearForm(): void {
    this.editing = null;
    this.draft = null;
    this.form = { title: '', text: '', sizeHint: '' };
    this.movement = 'orbit-centre';
    // (render() reads the inputs back first)
    this.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-k="title"], [data-k="text"], [data-k="hint"]').forEach((el) => { el.value = ''; });
  }

  private mayEdit(n: ContributorNote): boolean {
    return noteControls(n, this.viewer()).edit;
  }

  private readForm(): void {
    const v = (k: string) => (this.body.querySelector(`[data-k="${k}"]`) as HTMLInputElement | HTMLTextAreaElement | null)?.value;
    this.form = { title: v('title') ?? this.form.title, text: v('text') ?? this.form.text, sizeHint: v('hint') ?? this.form.sizeHint };
  }

  // ---------------------------------------------------------------------------
  // Keys and the camera

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (e.code === 'F6') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) this.setOverlay(!this.overlay); else this.toggle();
      return;
    }
    if (typing) return;
    if (this.placing && (e.code === 'Enter' || e.code === 'NumpadEnter') && this.shape === 'polygon' && this.placing.poly.length >= 3) {
      e.preventDefault(); e.stopPropagation();
      this.finishPolygon();
      return;
    }
    if ((e.code === 'Delete' || e.code === 'Backspace') && this.isOpen && !this.placing && this.editing && !this.detail) {
      e.preventDefault(); e.stopPropagation();
      this.deleteNote(this.editing);
      return;
    }
    if (e.code === 'Escape' && (this.placing || this.looking)) {
      e.preventDefault(); e.stopPropagation();
      if (this.placing) { this.endPlacing(); this.render(); } else this.stopLooking();
    }
  }

  private look(n: ContributorNote): void {
    if (this.looking === n.id) { this.stopLooking(); return; }
    this.looking = n.id;
    this.deps.setCamera(() => {
      const m = this.notes.get(this.looking ?? '');
      return m && m.system === this.deps.state.systemId ? noteAnchorPosition(m.anchor, systemBodies(m.system), this.deps.state.getRawServerTick()) : null;
    });
    this.banner.textContent = `Looking at "${n.title}" · Esc: back to your ship`;
    this.banner.classList.add('on');
    this.renderList();
  }

  private stopLooking(): void {
    if (!this.looking) return;
    this.looking = null;
    this.deps.setCamera(null);
    if (!this.placing) this.banner.classList.remove('on');
    this.renderList();
  }

  // ---------------------------------------------------------------------------
  // The panel

  private render(): void {
    if (!this.isOpen) return;
    // (Keep what's typed across re-renders)
    if (this.body.querySelector('[data-k="title"]')) this.readForm();
    if (this.detail) {
      if (this.notes.has(this.detail)) { this.renderDetail(); return; }
      this.detail = null;
    }
    const sys = SYSTEMS.find((s) => s.id === this.system);
    const labels = this.movementLabels();
    const moves: Movement[] = [...(this.editing ? ['keep' as const] : []), 'fixed', 'orbit-centre', 'orbit-body', 'attached'];
    const orbiting = this.movement === 'orbit-centre' || this.movement === 'orbit-body';
    const shape = this.draft?.shape;
    this.body.innerHTML = `
      <div class="ctb-row">
        <button class="ctb-btn${this.overlay ? ' on' : ''}" data-a="overlay" title="Shift+F6">${this.overlay ? '◉ Overlay on' : '○ Overlay off'}</button>
        <span class="ctb-hint">${esc(sys?.name ?? this.system)}</span>
      </div>
      <div class="ctb-sec">Quick note</div>
      <textarea class="ctb-in" data-k="quick" maxlength="${NOTE_LIMITS.text}" placeholder="Jot something while you play: pinned where your ship is now. Ctrl+Enter adds it.">${esc(this.quickText)}</textarea>
      <div class="ctb-row"><button class="ctb-btn" data-a="quick">Add note here</button><span class="ctb-hint">title = first words; it can be read back later</span></div>
      <div class="ctb-sec">${this.editing ? `Editing “${esc(this.editing.title)}”` : 'New note'}
        ${this.editing ? `<button class="ctb-btn sm" data-a="cancel" title="Stop editing (right-click in space too)">Cancel</button><button class="ctb-btn sm bad" data-a="delete-edit">${this.armed === this.editing.id ? 'Sure? Delete' : 'Delete'}</button>`
          : this.draft || this.placing ? '<button class="ctb-btn sm" data-a="cancel" title="Throw this one away">Discard</button>' : ''}</div>
      <div class="ctb-row">${SHAPES.map((s) => `<button class="ctb-btn shape${this.shape === s.kind ? ' on' : ''}" data-shape="${s.kind}" title="${esc(s.tip)}">${s.label}</button>`).join('')}</div>
      <div class="ctb-row">
        <button class="ctb-btn${this.placing ? ' on' : ''}" data-a="place">${this.placing ? 'Click to place… (Esc)' : this.draft ? (this.editing ? 'Re-place it' : 'Place again') : 'Place it…'}</button>
        <span class="ctb-hint">${this.draft ? `at ${fmt(this.draft.at.x)}, ${fmt(this.draft.at.y)}` : `in space or on the map (${esc(boundKeyName('map', settings.data.bindings))})`}</span>
      </div>
      ${shape ? this.sizeFields(shape) : ''}
      ${this.draft || this.editing ? `
      <div class="ctb-row"><select class="ctb-in ctb-grow" data-k="move">${moves.map((m) => `<option value="${m}"${m === this.movement ? ' selected' : ''}>${esc(labels[m])}</option>`).join('')}</select></div>
      ${orbiting ? `<div class="ctb-row">
        <span class="ctb-hint">Period</span><input class="ctb-in n" data-k="period" value="${this.period}" title="Minutes per revolution (0: still)"><span class="ctb-hint">min</span>
        <select class="ctb-in" data-k="dir"><option value="1"${this.direction === 1 ? ' selected' : ''}>↻ clockwise</option><option value="-1"${this.direction === -1 ? ' selected' : ''}>↺ anticlockwise</option></select>
        <button class="ctb-btn sm" data-a="match" title="The period of what's there">Match</button>
      </div>` : ''}` : ''}
      <div class="ctb-row"><input class="ctb-in ctb-grow" data-k="title" maxlength="${NOTE_LIMITS.title}" placeholder="Title" value="${esc(this.form.title)}"></div>
      <textarea class="ctb-in" data-k="text" maxlength="${NOTE_LIMITS.text}" placeholder="The note: what should go here, how big, what it's like…">${esc(this.form.text)}</textarea>
      <div class="ctb-row"><input class="ctb-in ctb-grow" data-k="hint" maxlength="${NOTE_LIMITS.sizeHint}" placeholder="Size hint (e.g. match circle size)" value="${esc(this.form.sizeHint)}"></div>
      <div class="ctb-row">${COLORS.map((c) => `<span class="ctb-sw${c === this.color ? ' on' : ''}" data-color="${c}" style="background:${c}"></span>`).join('')}
        <input type="color" class="ctb-in" data-k="color" value="${this.color}" style="width:34px;padding:0;height:20px">
        <span class="sp ctb-grow"></span><button class="ctb-btn" data-a="save">${this.editing ? 'Save changes' : 'Save note'}</button></div>
      <div class="ctb-msg ${this.message?.ok ? 'ok' : 'bad'}">${esc(this.message?.text ?? '')}</div>
      <div class="ctb-sec">Notes</div>
      <div class="ctb-row">
        <select class="ctb-in ctb-grow" data-k="author" title="Whose notes"></select>
        <select class="ctb-in" data-k="status">${(['open', 'done', 'wontdo', 'all'] as const).map((s) => `<option value="${s}"${s === this.filterStatus ? ' selected' : ''}>${s === 'all' ? 'Any status' : STATUS_WORD[s]}</option>`).join('')}</select>
      </div>
      <div class="ctb-row">
        <select class="ctb-in ctb-grow" data-k="scope"><option value="here"${this.scope === 'here' ? ' selected' : ''}>This system</option><option value="all"${this.scope === 'all' ? ' selected' : ''}>Every system</option></select>
        <select class="ctb-in" data-k="sort"><option value="newest"${this.sort === 'newest' ? ' selected' : ''}>Newest first</option><option value="liked"${this.sort === 'liked' ? ' selected' : ''}>Most liked first</option></select>
      </div>
      <div class="ctb-list"></div>
      <div class="ctb-row ctb-bulk"></div>`;
    this.listKey = '';
    this.wire();
    this.renderList();
  }

  private sizeFields(s: NoteShape): string {
    const f = (k: string, v: number, label: string) => `<span class="ctb-hint">${label}</span><input class="ctb-in n" data-size="${k}" value="${Math.round(v)}">`;
    switch (s.kind) {
      case 'point': return '';
      case 'circle': return `<div class="ctb-row">${f('radius', s.radius, 'Radius')}<span class="ctb-hint">u</span></div>`;
      case 'ring': return `<div class="ctb-row">${f('inner', s.inner, 'Inner')}${f('outer', s.outer, 'Outer')}</div>`;
      case 'rect': return `<div class="ctb-row">${f('w', s.w, 'W')}${f('h', s.h, 'H')}${f('rotationDeg', s.rotationDeg, '°')}</div>`;
      case 'line': case 'arrow': return `<div class="ctb-row">${f('dx', s.dx, 'dx')}${f('dy', s.dy, 'dy')}</div>`;
      case 'polygon': return `<div class="ctb-row"><span class="ctb-hint">${s.points.length} corners</span></div>`;
    }
  }

  private wire(): void {
    const q = <T extends HTMLElement>(sel: string) => this.body.querySelector<T>(sel);
    q('[data-a="overlay"]')?.addEventListener('click', () => { this.setOverlay(!this.overlay); this.render(); });
    q('[data-a="cancel"]')?.addEventListener('click', () => { this.clearForm(); this.endPlacing(); this.armed = null; this.message = null; this.render(); });
    q('[data-a="delete-edit"]')?.addEventListener('click', () => { if (this.editing) this.deleteNote(this.editing); });
    q('[data-a="place"]')?.addEventListener('click', () => { if (this.placing) { this.endPlacing(); this.render(); } else this.startPlacing(); });
    q('[data-a="save"]')?.addEventListener('click', () => this.save());
    q('[data-a="quick"]')?.addEventListener('click', () => this.quickNote());
    q('[data-k="quick"]')?.addEventListener('input', (e) => { this.quickText = (e.target as HTMLTextAreaElement).value; });
    q('[data-k="quick"]')?.addEventListener('keydown', (e) => { const k = e as KeyboardEvent; if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) { k.preventDefault(); this.quickNote(); } });
    q('[data-a="match"]')?.addEventListener('click', () => { this.period = this.matchPeriod(this.movement); this.render(); });
    this.body.querySelectorAll<HTMLElement>('[data-shape]').forEach((b) => b.addEventListener('click', () => {
      this.shape = b.dataset.shape as NoteShapeKind;
      this.startPlacing();
    }));
    this.body.querySelectorAll<HTMLElement>('[data-color]').forEach((b) => b.addEventListener('click', () => { this.color = b.dataset.color!; this.render(); }));
    q<HTMLInputElement>('[data-k="color"]')?.addEventListener('change', (e) => { this.color = (e.target as HTMLInputElement).value; this.render(); });
    q<HTMLSelectElement>('[data-k="move"]')?.addEventListener('change', (e) => {
      this.movement = (e.target as HTMLSelectElement).value as Movement;
      if (this.movement === 'orbit-centre' || this.movement === 'orbit-body') this.period = this.matchPeriod(this.movement);
      this.render();
    });
    q<HTMLInputElement>('[data-k="period"]')?.addEventListener('change', (e) => { const v = Number((e.target as HTMLInputElement).value); this.period = Number.isFinite(v) && v >= 0 ? v : 0; if (this.movement === 'keep') this.movement = 'orbit-centre'; });
    q<HTMLSelectElement>('[data-k="dir"]')?.addEventListener('change', (e) => { this.direction = (e.target as HTMLSelectElement).value === '-1' ? -1 : 1; });
    this.body.querySelectorAll<HTMLInputElement>('[data-size]').forEach((inp) => inp.addEventListener('change', () => {
      if (!this.draft) return;
      const v = Number(inp.value);
      if (!Number.isFinite(v)) return;
      this.draft.shape = { ...this.draft.shape, [inp.dataset.size!]: v } as NoteShape;
    }));
    q<HTMLSelectElement>('[data-k="author"]')?.addEventListener('change', (e) => { this.filterAuthor = (e.target as HTMLSelectElement).value; this.renderList(); });
    q<HTMLSelectElement>('[data-k="status"]')?.addEventListener('change', (e) => { this.filterStatus = (e.target as HTMLSelectElement).value as NoteStatus | 'all'; this.renderList(); });
    q<HTMLSelectElement>('[data-k="sort"]')?.addEventListener('change', (e) => { this.sort = (e.target as HTMLSelectElement).value === 'liked' ? 'liked' : 'newest'; this.renderList(); });
    q<HTMLSelectElement>('[data-k="scope"]')?.addEventListener('change', (e) => {
      this.scope = (e.target as HTMLSelectElement).value === 'all' ? 'all' : 'here';
      // (Every system's notes are asked for once; changes to any note come anyway while the overlay is on)
      if (this.scope === 'all' && this.overlay) this.deps.send({ type: 'contrib', op: 'list', system: '*' });
      this.renderList();
    });
  }

  // ---------------------------------------------------------------------------
  // The detail view: a note in full, its votes and its comments

  private openDetail(id: string): void {
    if (this.detail !== id) { this.commentText = ''; this.posting = false; }
    this.detail = id;
    this.focus = id;
    this.armed = null;
    this.message = null;
    this.render();
  }

  private renderDetail(): void {
    const n = this.notes.get(this.detail ?? '');
    if (!n) { this.detail = null; this.render(); return; }
    // (What's typed, the caret and the scroll survive a redraw: other people's comments and votes arrive while you write)
    const was = this.body.querySelector<HTMLTextAreaElement>('[data-k="comment"]');
    const caret = was && document.activeElement === was ? [was.selectionStart, was.selectionEnd] : null;
    const top = this.body.querySelector('.ctb-detail') ? this.body.scrollTop : 0;
    this.body.innerHTML = detailHtml(n, {
      viewer: this.viewer(), now: Date.now(), systemName: SYSTEMS.find((s) => s.id === n.system)?.name ?? n.system, here: n.system === this.system,
      canWarp: this.deps.canWarp ? this.deps.canWarp() : this.deps.isAdmin(), looking: this.looking === n.id, armed: this.armed, commentText: this.commentText, message: this.message,
    });
    this.listKey = '';
    this.wireDetail(n);
    this.body.scrollTop = top;
    const box = this.body.querySelector<HTMLTextAreaElement>('[data-k="comment"]');
    if (caret && box) { box.focus(); box.setSelectionRange(caret[0], caret[1]); }
  }

  private wireDetail(n: ContributorNote): void {
    const post = () => {
      const text = this.commentText.trim();
      if (!text) { this.message = { ok: false, text: 'Type a comment first' }; this.renderDetail(); return; }
      this.posting = true;
      this.deps.send({ type: 'contrib', op: 'comment', id: n.id, text: text.slice(0, NOTE_FEEDBACK_LIMITS.comment) });
    };
    const box = this.body.querySelector<HTMLTextAreaElement>('[data-k="comment"]');
    box?.addEventListener('input', () => { this.commentText = box.value; });
    box?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); } });
    this.body.querySelectorAll<HTMLElement>('[data-d]').forEach((b) => {
      const act = b.dataset.d;
      if (act === 'status') { b.addEventListener('change', () => this.sendStatus(n, (b as HTMLSelectElement).value as NoteStatus)); return; }
      b.addEventListener('click', () => {
        const at = noteAnchorPosition(n.anchor, systemBodies(n.system), this.deps.state.getRawServerTick());
        if (act === 'back') { this.detail = null; this.armed = null; this.message = null; this.render(); }
        else if (act === 'up' || act === 'down') this.deps.send({ type: 'contrib', op: 'vote', id: n.id, value: nextVote(n.votes?.mine, act === 'up' ? 1 : -1) });
        else if (act === 'fly' && at) this.deps.flyTo({ kind: 'point', system: n.system, x: at.x, y: at.y, name: n.title });
        else if (act === 'look') this.look(n);
        else if (act === 'warp' && at) this.deps.warp(n.system, Math.round(at.x + 600), Math.round(at.y));
        else if (act === 'edit') this.edit(n);
        else if (act === 'delete') this.deleteNote(n);
        else if (act === 'post') post();
        else if (act === 'uncomment') {
          const cid = b.closest<HTMLElement>('[data-cid]')?.dataset.cid;
          if (!cid) return;
          if (this.armed !== cid) { this.armed = cid; this.renderDetail(); return; }
          this.armed = null;
          this.deps.send({ type: 'contrib', op: 'commentDelete', id: n.id, commentId: cid });
        }
      });
    });
  }

  private sendStatus(n: ContributorNote, status: NoteStatus): void {
    const resolution = status === 'open' ? '' : (prompt(status === 'done' ? 'What was done? (optional)' : "Why won't it be done? (optional)", n.resolution ?? '') ?? '');
    this.deps.send({ type: 'contrib', op: 'status', id: n.id, status, resolution: resolution.slice(0, NOTE_LIMITS.resolution) });
  }

  private renderList(): void {
    if (!this.isOpen) return;
    if (this.detail) { this.renderDetail(); return; }
    const box = this.body.querySelector<HTMLElement>('.ctb-list');
    const authorSel = this.body.querySelector<HTMLSelectElement>('[data-k="author"]');
    if (!box || !authorSel) return;
    const where = { system: this.system, scope: this.scope };
    const total = this.scope === 'all' ? this.notes.size : this.here().length;
    const authors = noteAuthors(this.notes.values(), where);
    const list = listNotes(this.notes.values(), { ...where, author: this.filterAuthor, status: this.filterStatus, sort: this.sort }, this.viewer());
    const now = Date.now();
    const key = JSON.stringify([list.map((n) => [n.id, n.updatedAt, noteCounts(n), rowMeta(n, now)]), authors, this.filterAuthor, this.filterStatus, this.scope, this.sort, this.focus, this.looking, this.overlay, this.armed]);
    if (key === this.listKey) return;
    this.listKey = key;
    authorSel.innerHTML = `<option value="">Everyone's</option><option value="${MINE}"${this.filterAuthor === MINE ? ' selected' : ''}>Mine</option>`
      + authors.map((a) => `<option value="${esc(a)}"${a === this.filterAuthor ? ' selected' : ''}>${esc(a)}</option>`).join('');
    const bulk = this.body.querySelector<HTMLElement>('.ctb-bulk');
    const deletable = list.filter((n) => this.mayEdit(n));
    if (bulk) {
      bulk.innerHTML = this.overlay && deletable.length > 1
        ? `<span class="sp ctb-grow"></span><button class="ctb-btn sm bad" data-a="bulk" title="Every note the filters show that you may delete, at once">${this.armed === '*' ? `Sure? Delete ${deletable.length}` : `Delete all shown (${deletable.length})`}</button>`
        : '';
      bulk.querySelector('[data-a="bulk"]')?.addEventListener('click', () => {
        if (this.armed !== '*') { this.armed = '*'; this.renderList(); return; }
        this.armed = null;
        this.deps.send({ type: 'contrib', op: 'deleteMany', ids: deletable.map((n) => n.id) });
      });
    }
    if (!this.overlay) { box.innerHTML = '<div class="ctb-hint">Turn the overlay on to see the notes.</div>'; return; }
    if (!list.length) { box.innerHTML = `<div class="ctb-hint">${total ? 'None match the filter.' : this.scope === 'all' ? 'No notes yet.' : 'No notes in this system yet.'}</div>`; return; }
    // (The warp is a dev tool: the server gives it to the owner, or anyone on a dev server)
    const canWarp = this.deps.canWarp ? this.deps.canWarp() : this.deps.isAdmin();
    const viewer = this.viewer();
    box.innerHTML = list.map((n) => {
      const can = noteControls(n, viewer);
      const mine = can.edit;
      const cnt = noteCounts(n);
      const elsewhere = n.system !== this.system;
      return `<div class="ctb-note${n.status !== 'open' ? ' dim' : ''}${this.focus === n.id ? ' focus' : ''}" data-id="${esc(n.id)}" data-mine="${can.mine ? 1 : 0}" title="Open it: votes and comments">
        <div class="t"><i style="background:${esc(n.color)}"></i>${esc(n.title)} <span class="ctb-tag${n.status !== 'open' ? ` ${n.status}` : ''}">${STATUS_WORD[n.status]}</span>${can.mine ? '<span class="ctb-tag you">yours</span>' : ''}
          <span class="cnt" title="Thumbs up, thumbs down, comments">👍 ${cnt.up} · 👎 ${cnt.down} · 💬 ${cnt.comments}</span></div>
        <div class="sub">${esc(rowMeta(n, now, elsewhere || this.scope === 'all' ? SYSTEMS.find((s) => s.id === n.system)?.name ?? n.system : undefined))} · ${esc(n.shape.kind)}${n.resolution ? ` · ${esc(n.resolution)}` : ''}</div>
        <div class="acts">
          <button class="ctb-btn sm" data-n="open" title="The note in full, its votes and comments">Open</button>
          <button class="ctb-btn sm" data-n="fly" title="Autopilot there">Fly</button>
          ${elsewhere ? '' : `<button class="ctb-btn sm${this.looking === n.id ? ' on' : ''}" data-n="look" title="Camera to it (Esc: back)">Look</button>`}
          ${canWarp ? '<button class="ctb-btn sm" data-n="warp" title="Warp there (dev tool)">Warp</button>' : ''}
          ${mine ? `<button class="ctb-btn sm" data-n="edit">Edit</button>
            <select class="ctb-in" data-n="status" style="font-size:11px;padding:0 2px">${(['open', 'done', 'wontdo'] as const).map((s) => `<option value="${s}"${s === n.status ? ' selected' : ''}>${STATUS_WORD[s]}</option>`).join('')}</select>
            <button class="ctb-btn sm bad" data-n="delete">${this.armed === n.id ? 'Sure?' : 'Delete'}</button>` : ''}
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll<HTMLElement>('.ctb-note').forEach((row) => {
      const n = this.notes.get(row.dataset.id!);
      if (!n) return;
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button, select')) return;
        this.openDetail(n.id);
      });
      row.querySelectorAll<HTMLElement>('[data-n]').forEach((b) => {
        const act = b.dataset.n;
        if (act === 'status') {
          b.addEventListener('change', () => this.sendStatus(n, (b as HTMLSelectElement).value as NoteStatus));
          return;
        }
        b.addEventListener('click', () => {
          const at = noteAnchorPosition(n.anchor, systemBodies(n.system), this.deps.state.getRawServerTick());
          if (act === 'open') this.openDetail(n.id);
          else if (act === 'fly' && at) this.deps.flyTo({ kind: 'point', system: n.system, x: at.x, y: at.y, name: n.title });
          else if (act === 'look') this.look(n);
          else if (act === 'warp' && at) this.deps.warp(n.system, Math.round(at.x + 600), Math.round(at.y));
          else if (act === 'edit') this.edit(n);
          else if (act === 'delete') this.deleteNote(n);
        });
      });
    });
  }

  /** Drag the panel by its header */
  private dragging(): void {
    const head = this.root.querySelector<HTMLElement>('.ctb-head')!;
    head.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const r = this.root.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (m: MouseEvent) => {
        this.root.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, m.clientX - ox))}px`;
        this.root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, m.clientY - oy))}px`;
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }
}
