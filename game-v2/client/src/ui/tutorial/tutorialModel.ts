/**
 * @contract client.ui.tutorial.model
 * owns:       the lesson UI's decisions, as pure functions of the server's tutorialState and data/tutorial.json: what the
 *             instruction panel shows, which training objects are drawn ghosted (and how), which markers light up, where
 *             a screen-edge arrow sits, the leave-confirm flow, the step-done toast, the graduate screen's pack list
 * needs:      common ServerTutorialStateMessage, TutorialData and the object defs (types only)
 * invariants: no DOM, no store, no renderer: every function runs from a state — client/src/ui/tutorial/tutorialModel.test.ts
 * extend:     a new thing the lesson shows is a function here (tested), drawn by TutorialPanel / TutorialMarkers
 */

import type { ServerTutorialStateMessage, TutorialData, TutorialObjectDef, TutorialStepDef } from '@space-game/common';
import { esc } from '../escape';

type State = Pick<ServerTutorialStateMessage, 'step' | 'done' | 'left' | 'broken'>;

/** How the renderer draws a training body: a live practice drone, or a ghost (faded, grey) of a drone or rock */
export type TrainingLook = 'drone' | 'droneGhost' | 'rockGhost';

/** Done for this pilot: its step is done, or they broke it (it still collides; it is drawn ghosted) */
export function isGhosted(o: TutorialObjectDef, s: State | null): boolean {
  return !!s && !s.left && (s.done.includes(o.step) || s.broken.includes(o.id));
}

/** The look of a training body for this pilot; null: the normal rock (and for markers, which are not bodies) */
export function lookFor(o: TutorialObjectDef, s: State | null): TrainingLook | null {
  if (o.kind === 'drone') return isGhosted(o, s) ? 'droneGhost' : 'drone';
  if (o.kind === 'rock') return isGhosted(o, s) ? 'rockGhost' : null;
  return null;
}

/** active: this step's target; upcoming: a later step's (faint); null: not drawn (its step is done) */
export type MarkerStyle = 'active' | 'upcoming' | null;

export function markerStyle(o: TutorialObjectDef, s: State | null, step: TutorialStepDef | undefined): MarkerStyle {
  if (!s || s.left || (o.kind !== 'ring' && o.kind !== 'zone' && o.kind !== 'exit')) return null;
  if (s.done.includes(o.step)) return null;
  return step?.targets?.includes(o.id) ? 'active' : 'upcoming';
}

/** The objects the current step points at that are still live for this pilot (the arrow's targets) */
export function arrowTargets(data: TutorialData, s: State | null, step: TutorialStepDef | undefined): TutorialObjectDef[] {
  if (!s || s.left || !step?.targets) return [];
  const out: TutorialObjectDef[] = [];
  for (const id of step.targets) {
    const o = data.objects.find((x) => x.id === id);
    if (o && !isGhosted(o, s)) out.push(o);
  }
  return out;
}

/** Key names the lines may use that are not bindable actions */
const FIXED_KEYS: Record<string, string> = { powerFlow: 'U' };

/** A line with `{action}` filled in as key caps from the pilot's bindings; everything else escaped */
export function fillKeys(line: string, keyOf: (action: string) => string): string {
  return esc(line).replace(/\{([a-zA-Z0-9]+)\}/g, (_m, a: string) => `<kbd>${esc(FIXED_KEYS[a] ?? keyOf(a))}</kbd>`);
}

export interface PanelModel {
  stepId: string;
  /** 1-based, of the whole list */
  n: number;
  total: number;
  title: string;
  /** HTML (escaped, key caps in <kbd>) */
  lines: string[];
  /** Done steps over all steps, 0..1 */
  progress: number;
  /** The welcome card's Continue button */
  canContinue: boolean;
  /** The last step: the graduate screen instead of the card */
  graduate: boolean;
}

/** What the card shows, or null when it is not shown (not in the lesson, or a step the data does not know) */
export function panelModel(s: State | null, data: TutorialData, keyOf: (action: string) => string): PanelModel | null {
  if (!s || s.left) return null;
  const i = data.steps.findIndex((x) => x.id === s.step);
  if (i < 0) return null;
  const st = data.steps[i];
  return {
    stepId: st.id,
    n: i + 1,
    total: data.steps.length,
    title: st.title,
    lines: st.lines.map((l) => fillKeys(l, keyOf)),
    progress: Math.min(1, s.done.length / Math.max(1, data.steps.length)),
    canContinue: st.trigger.kind === 'ack',
    graduate: st.trigger.kind === 'graduate',
  };
}

/** Titles of the steps newly done between two states (for the "step done" toast), in order */
export function newlyDone(prev: State | null, next: State, data: TutorialData): string[] {
  if (!prev || next.left) return [];
  return next.done.filter((id) => !prev.done.includes(id)).map((id) => data.steps.find((x) => x.id === id)?.title ?? id);
}

/** The starter pack as lines for the graduate screen: credits first, then each item */
export function packLines(data: TutorialData, itemName: (id: string) => string): string[] {
  const p = data.starterPack;
  const out: string[] = [];
  if (p.credits > 0) out.push(`${p.credits.toLocaleString('en-US')} credits`);
  for (const [id, n] of Object.entries(p.items)) out.push(`${n} × ${itemName(id)}`);
  return out;
}

/**
 * Leaving: the button asks, the pilot confirms, only then is `tutorialLeave` sent (once). The graduate screen's
 * "Enter Sol" goes straight (`enter`): graduating needs no warning
 */
export class LeaveFlow {
  phase: 'idle' | 'confirm' | 'sent' = 'idle';
  constructor(private send: () => void) {}
  ask(): void { if (this.phase === 'idle') this.phase = 'confirm'; }
  cancel(): void { if (this.phase === 'confirm') this.phase = 'idle'; }
  confirm(): void { if (this.phase === 'confirm') { this.phase = 'sent'; this.send(); } }
  enter(): void { if (this.phase !== 'sent') { this.phase = 'sent'; this.send(); } }
  /** The connection starts over, or the server answered: ready again */
  reset(): void { this.phase = 'idle'; }
}

/** Where a world point is relative to the screen: on it, or the point on the edge (inset by `margin`) towards it, and the angle to point at */
export function edgeArrow(sx: number, sy: number, w: number, h: number, margin: number): { onScreen: boolean; x: number; y: number; angle: number } {
  const cx = w / 2, cy = h / 2;
  const on = sx >= margin && sx <= w - margin && sy >= margin && sy <= h - margin;
  const dx = sx - cx, dy = sy - cy;
  const angle = Math.atan2(dy, dx);
  if (on) return { onScreen: true, x: sx, y: sy, angle };
  const hx = cx - margin, hy = cy - margin;
  const t = Math.min(dx === 0 ? Infinity : hx / Math.abs(dx), dy === 0 ? Infinity : hy / Math.abs(dy));
  return { onScreen: false, x: cx + dx * t, y: cy + dy * t, angle };
}

/** Panels that are open now and were not before: the ones to report */
export function risingPanels(prev: Record<string, boolean>, now: Record<string, boolean>): string[] {
  return Object.keys(now).filter((p) => now[p] && !prev[p]);
}
