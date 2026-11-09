/**
 * @contract client.field.aids
 * owns:       the world build view's undo / redo history and symmetry mode: a step is the pilot's pending edits (plan.ts BuildEdits),
 *             the mirrored half of a place / remove / turn, and the axis
 * needs:      plan.ts (BuildEdits, addPart, replacePart, freeUid), build/history, build/symmetry, build/symmetryTurn
 * invariants: one place, remove or turn (with its mirror), and one whole held drag, is one undo step — client/src/ships/field/fieldAids.test.ts
 *             an undone edit comes back whole on redo — client/src/ships/field/fieldAids.test.ts
 *             a step the live ship has since made moot falls away (the history is dropped when edits settle) — none pinned
 * extend:     a new kind of edit in the view runs inside aids.edit() so it is undoable
 */

import { nextFreeUid } from '@space-game/common';
import type { Blueprint, Catalog, PlacedPart, Vec2 } from '@space-game/common';
import { History } from '../build/history';
import { axisOf, mirrorPart, mirrorPoint, onAxis } from '../build/symmetry';
import { mirrorFollow } from '../build/symmetryTurn';
import { partUnder } from '../build/editPlaced';
import { addPart, replacePart, type BuildEdits, type LiveDesign, type WorkingDesign } from './plan';

/** A step: the pending edits as JSON (a private copy by nature) */
export type EditsSnap = string;

export const snapEdits = (e: BuildEdits): EditsSnap =>
  JSON.stringify({ added: e.added, dropped: [...e.dropped], mark: [...e.mark], unmark: [...e.unmark] });

export function editsOf(s: EditsSnap): BuildEdits {
  const d = JSON.parse(s) as { added: PlacedPart[]; dropped: number[]; mark: number[]; unmark: number[] };
  return { added: d.added, dropped: new Set(d.dropped), mark: new Set(d.mark), unmark: new Set(d.unmark) };
}

/** What the aids use of the view */
export interface FieldAidsHost {
  catalog: Catalog;
  edits(): BuildEdits;
  setEdits(e: BuildEdits): void;
  /** The edits changed: redraw and re-check */
  changed(): void;
  say(text: string, bad?: boolean): void;
  /** The working design now (null: none) */
  view(): { live: LiveDesign; w: WorkingDesign } | null;
  /** Why a part can't be placed (the view's rules and licences), or null */
  problemFor(p: PlacedPart): string | null;
}

export class FieldAids {
  readonly history = new History<EditsSnap>((a, b) => a === b);
  symmetry = false;
  private depth = 0;
  private btns: { undo?: HTMLButtonElement; redo?: HTMLButtonElement; sym?: HTMLButtonElement } = {};

  constructor(private host: FieldAidsHost) {}

  bind(undo: HTMLButtonElement, redo: HTMLButtonElement, sym: HTMLButtonElement): void {
    this.btns = { undo, redo, sym };
    this.sync();
  }

  /** Run one edit as an undo step (inside a held drag, or another edit, it is part of that step) */
  edit(fn: () => void): void {
    if (this.history.grouping || this.depth > 0) return fn();
    const before = snapEdits(this.host.edits());
    this.depth++;
    try { fn(); } finally { this.depth--; }
    this.history.record(before, snapEdits(this.host.edits()));
    this.sync();
  }

  beginDrag(): void { this.history.begin(snapEdits(this.host.edits())); }
  endDrag(): void { this.history.end(snapEdits(this.host.edits())); this.sync(); }

  /** The view closed, or the live ship took the edits in (a save applied): the steps no longer apply */
  reset(): void { this.history.clear(); this.sync(); }

  undo(): void { this.go(this.history.undo(snapEdits(this.host.edits())), 'Undone.', 'Nothing to undo.'); }
  redo(): void { this.go(this.history.redo(snapEdits(this.host.edits())), 'Redone.', 'Nothing to redo.'); }

  private go(s: EditsSnap | null, said: string, none: string): void {
    if (s === null) { this.host.say(none); return; }
    this.host.setEdits(editsOf(s));
    this.host.changed();
    this.host.say(said);
    this.sync();
  }

  toggleSymmetry(): void {
    this.symmetry = !this.symmetry;
    this.host.say(this.symmetry ? (this.axis2() === null ? 'Symmetry on (no core to mirror across).' : 'Symmetry on: edits are mirrored across the centre line.') : 'Symmetry off.');
    this.sync();
  }

  sync(): void {
    const { undo, redo, sym } = this.btns;
    if (undo) undo.disabled = !this.history.canUndo;
    if (redo) redo.disabled = !this.history.canRedo;
    if (sym) { sym.classList.toggle('on', this.symmetry); sym.textContent = this.symmetry ? 'Mirror: on' : 'Mirror'; }
  }

  // ---- symmetry

  /** Twice the axis x, when symmetry is on and the design has a core (else null) */
  axis2(): number | null {
    const v = this.host.view();
    return this.symmetry && v ? axisOf(this.host.catalog, v.w.bp.parts) : null;
  }

  mirrorOf(g: Vec2): Vec2 | null {
    const a = this.axis2();
    return a === null ? null : mirrorPoint(g, a);
  }

  /** `p` was just placed: place its mirror too, or say it is blocked */
  placeMirror(p: PlacedPart): void {
    const axis2 = this.axis2(), v = this.host.view();
    if (axis2 === null || !v || onAxis(this.host.catalog, p, axis2)) return;
    const m = mirrorPart(this.host.catalog, p, axis2);
    const uid = nextFreeUid({ ...v.live.bp, parts: [...v.w.bp.parts, ...v.live.bp.parts] } as Blueprint);
    if (!m || uid < 0) return this.host.say('Mirror side blocked.', true);
    m.uid = uid;
    const why = this.host.problemFor(m);
    if (why) return this.host.say(`Mirror side blocked: ${why}.`, true);
    addPart(this.host.edits(), m);
    this.host.changed();
  }

  /** The turned part now stands at `at` (the view is up to date): the part across follows. A note for the line ('' if none) */
  followTurn(at: Vec2): string {
    const axis2 = this.axis2(), v = this.host.view();
    if (axis2 === null || !v) return '';
    const parts = v.w.bp.parts;
    const i = partUnder(this.host.catalog, parts, at);
    if (i < 0) return '';
    const f = mirrorFollow(this.host.catalog, parts, i, at, axis2);
    if (!f) return '';
    if ('skip' in f) return ` (${f.skip})`;
    if (v.w.standing[f.j]) return ' (the mirror side is built: it stays as it is)';
    if (!replacePart(v.live, this.host.edits(), v.w, f.j, f.part)) return ' (the design is full)';
    this.host.changed();
    return ' (both sides)';
  }
}
