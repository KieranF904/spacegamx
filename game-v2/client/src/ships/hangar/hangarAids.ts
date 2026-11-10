/**
 * @contract client.hangar.aids
 * owns:       the hangar's undo / redo history and symmetry mode: what a step is (the parts and the saved wiring), the toolbar buttons,
 *             the mirrored half of a place / remove / turn, and the axis line
 * needs:      npm: @space-game/common; HangarHost (bp, deps, refresh, status), build/history, build/symmetry, build/symmetryTurn, build/buildKeys, hangar/hangarWidgets
 * invariants: one place, remove or turn (with its mirror), and one whole held drag, is one undo step — client/src/ships/build/history.test.ts
 *             the mirrored half follows the shared mirror rules — client/src/ships/build/symmetry.test.ts
 * extend:     a new kind of hangar edit runs inside aids.edit() so it is undoable (and mirrored if it asks for the mirror)
 */

import { nextFreeUid } from '@space-game/common';
import type { PlacedPart, Vec2 } from '@space-game/common';
import type { HangarHost } from './host';
import { History } from '../build/history';
import { axisOf, mirrorPart, mirrorPoint, onAxis } from '../build/symmetry';
import { mirrorFollow } from '../build/symmetryTurn';
import { button } from './hangarWidgets';

/** A step: the parts and the saved wiring as JSON (a private copy by nature) */
type Snap = string;

export class HangarAids {
  readonly history = new History<Snap>((a, b) => a === b);
  symmetry = false;
  /** Edits inside edits (a remove and its mirror) are one step */
  private depth = 0;
  readonly undoBtn: HTMLButtonElement;
  readonly redoBtn: HTMLButtonElement;
  readonly symBtn: HTMLButtonElement;

  constructor(private host: HangarHost) {
    this.undoBtn = button('Undo', () => this.undo());
    this.undoBtn.title = 'Undo the last edit (Ctrl+Z)';
    this.redoBtn = button('Redo', () => this.redo());
    this.redoBtn.title = 'Redo (Ctrl+Y or Ctrl+Shift+Z)';
    this.symBtn = button('Mirror', () => this.toggleSymmetry());
    this.symBtn.title = 'Symmetry (M): every place, remove and turn is repeated on the other side of the ship\'s centre line';
    this.sync();
  }

  private snap(): Snap {
    return JSON.stringify({ parts: this.host.bp.parts });
  }

  /** Run one edit as an undo step (inside a held drag it is part of the drag's step) */
  edit(fn: () => void): void {
    if (this.history.grouping || this.depth > 0) return fn();
    const before = this.snap();
    this.depth++;
    try { fn(); } finally { this.depth--; }
    this.history.record(before, this.snap());
    this.sync();
  }

  /** A held drag starts / ends: all its edits are one step */
  beginDrag(): void { this.history.begin(this.snap()); }
  endDrag(): void { this.history.end(this.snap()); this.sync(); }

  /** A different design is now in the editor (a slot, a load, New): the steps no longer apply */
  reset(): void { this.history.clear(); this.sync(); }

  undo(): void { this.go(this.history.undo(this.snap()), 'Undone'); }
  redo(): void { this.go(this.history.redo(this.snap()), 'Redone'); }

  private go(s: Snap | null, said: string): void {
    const h = this.host;
    if (s === null) { h.status(said === 'Undone' ? 'Nothing to undo' : 'Nothing to redo'); return; }
    const d = JSON.parse(s) as { parts: PlacedPart[] };
    h.bp.parts = d.parts;
    h.status(said);
    this.sync();
    h.refresh();
  }

  toggleSymmetry(): void {
    this.symmetry = !this.symmetry;
    this.host.status(this.symmetry ? (this.axis2() === null ? 'Symmetry on (the design has no core to mirror across)' : 'Symmetry on: edits are mirrored across the centre line') : 'Symmetry off');
    this.sync();
    this.host.draw();
  }

  /** Buttons follow the history and the mode */
  sync(): void {
    this.undoBtn.disabled = !this.history.canUndo;
    this.redoBtn.disabled = !this.history.canRedo;
    for (const b of [this.undoBtn, this.redoBtn]) b.style.opacity = b.disabled ? '0.4' : '1';
    this.symBtn.style.background = this.symmetry ? '#24406b' : '#1a2540';
    this.symBtn.style.borderColor = this.symmetry ? '#5fd4c4' : '#2a3a5a';
    this.symBtn.textContent = this.symmetry ? 'Mirror: on' : 'Mirror';
  }

  // ---- symmetry

  /** Twice the axis x, when symmetry is on and the design has a core (else null) */
  axis2(): number | null {
    return this.symmetry ? axisOf(this.host.deps.catalog, this.host.bp.parts) : null;
  }

  /** The axis line's x in grid units, for drawing (null: off) */
  axisX(): number | null {
    const a = this.axis2();
    return a === null ? null : a / 2;
  }

  /** The cell across the axis from a grid point (null: symmetry off) */
  mirrorOf(g: Vec2): Vec2 | null {
    const a = this.axis2();
    return a === null ? null : mirrorPoint(g, a);
  }

  /** `p` was just placed (and the editor refreshed): place its mirror too, or say it is blocked */
  placeMirror(p: PlacedPart): void {
    const h = this.host, axis2 = this.axis2();
    if (axis2 === null || onAxis(h.deps.catalog, p, axis2)) return;
    const m = mirrorPart(h.deps.catalog, p, axis2);
    const uid = nextFreeUid(h.bp);
    if (!m || uid < 0) return h.status('mirror side blocked');
    m.uid = uid;
    const problem = h.placementProblem(m);
    if (problem) return h.status(`mirror side blocked: ${problem}`);
    h.bp.parts.push(m);
    h.refresh();
  }

  /** Part `i` was just turned at `at` (its new state is in the design): the part across follows. Returns a note for the status line ('' if none) */
  followTurn(i: number, at: Vec2): string {
    const h = this.host, axis2 = this.axis2();
    if (axis2 === null) return '';
    const f = mirrorFollow(h.deps.catalog, h.bp.parts, i, at, axis2);
    if (!f) return '';
    if ('skip' in f) return ` (${f.skip})`;
    h.bp.parts[f.j] = f.part;
    return ' (both sides)';
  }
}
