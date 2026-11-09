/**
 * @contract client.ui.tutorial.model
 * owns:       the lesson UI's decisions, as pure functions of the server's tutorialState and data/tutorial.json: what the
 *             instruction panel shows, which training objects are drawn ghosted (and how), which markers light up, where
 *             a screen-edge arrow sits, the leave-confirm flow, the step-done toast, the graduate screen's pack list
 * needs:      common ServerTutorialStateMessage, TutorialData and the object defs (types only)
 * invariants: no DOM, no store, no renderer: every function runs from a state — client/src/ui/tutorial/tutorialModel.test.ts
 * extend:     a new thing the lesson shows is a function here (tested), drawn by TutorialPanel / TutorialMarkers
 */

import type { ServerTutorialStateMessage, TutorialData, TutorialLine, TutorialObjectDef, TutorialStepDef } from '@space-game/common';
import { esc } from '../escape';

type State = Pick<ServerTutorialStateMessage, 'step' | 'done' | 'left' | 'broken'> & { passed?: string[] };

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

/** active: the target to go for now; passed: a ring of this step already flown through (green, ticked); upcoming: a later target or step's (faint); null: not drawn (its step is done) */
export type MarkerStyle = 'active' | 'passed' | 'upcoming' | null;

/** Which of the step's targets are done: rings the server counted as passed, drones broken (a hit-to-break step has no other progress) */
export function doneTargets(s: State | null, step: TutorialStepDef | undefined): string[] {
  if (!s || s.left || !step) return [];
  const objs = step.trigger.objects ?? [];
  if (step.trigger.kind === 'rings') return objs.filter((id) => s.passed?.includes(id));
  if (step.trigger.kind === 'objectsBroken') return objs.filter((id) => s.broken.includes(id));
  return [];
}

/** The next ring to fly through: the first of the step's targets not yet passed (rings go in the order the data lists them) */
function nextRing(s: State, step: TutorialStepDef): string | undefined {
  return (step.targets ?? []).find((id) => !s.passed?.includes(id));
}

export function markerStyle(o: TutorialObjectDef, s: State | null, step: TutorialStepDef | undefined): MarkerStyle {
  if (!s || s.left || (o.kind !== 'ring' && o.kind !== 'zone' && o.kind !== 'exit')) return null;
  if (s.done.includes(o.step)) return null;
  if (!step?.targets?.includes(o.id)) return 'upcoming';
  if (step.trigger.kind !== 'rings') return 'active';
  if (s.passed?.includes(o.id)) return 'passed';
  return nextRing(s, step) === o.id ? 'active' : 'upcoming';
}

/** The card's counter for a multi-target step ("Rings 2/3"), or null for a step without one */
export function counterOf(s: State | null, step: TutorialStepDef | undefined): { label: string; done: number; total: number } | null {
  if (!step?.counter) return null;
  const total = step.trigger.objects?.length ?? 0;
  return total > 1 ? { label: step.counter, done: doneTargets(s, step).length, total } : null;
}

/** Did the pilot just get one more target done on the same step (the chime and burst; a finished step has its own toast)? */
export function targetGained(prev: State | null, next: State, data: TutorialData): boolean {
  if (!prev || prev.step !== next.step || next.left) return false;
  const step = data.steps.find((x) => x.id === next.step);
  return doneTargets(next, step).length > doneTargets(prev, step).length;
}

/** Does this step point at the yard station (the dock step: the station is no training object, so the data has no target for it)? */
export function pointsAtStation(step: TutorialStepDef | undefined): boolean {
  return step?.trigger.kind === 'docked';
}

/** The objects the current step points at that are still live for this pilot (the arrow's targets) */
export function arrowTargets(data: TutorialData, s: State | null, step: TutorialStepDef | undefined): TutorialObjectDef[] {
  if (!s || s.left || !step?.targets) return [];
  const out: TutorialObjectDef[] = [];
  // A ring step points at the next ring only; the others point at everything still to do
  const rings = step.trigger.kind === 'rings', only = rings ? nextRing(s, step) : undefined;
  for (const id of step.targets) {
    if (rings && id !== only) continue;
    const o = data.objects.find((x) => x.id === id);
    if (o && !isGhosted(o, s)) out.push(o);
  }
  return out;
}

/** Key names the lines may use that are not bindable actions */
const FIXED_KEYS: Record<string, string> = { powerFlow: 'U' };
/** One placeholder standing for several key caps: the four move keys */
const KEY_GROUPS: Record<string, string[]> = { wasd: ['forward', 'left', 'backward', 'right'] };

/** A line with `{action}` filled in as key caps from the pilot's bindings; everything else escaped */
export function fillKeys(line: string, keyOf: (action: string) => string): string {
  const cap = (a: string) => `<kbd>${esc(FIXED_KEYS[a] ?? keyOf(a))}</kbd>`;
  return esc(line).replace(/\{([a-zA-Z0-9]+)\}/g, (_m, a: string) => (KEY_GROUPS[a] ? KEY_GROUPS[a].map(cap).join('') : cap(a)));
}

/** The text of a line for the pilot's control mode (`helm`: the nose-relative controls; otherwise mouse-steer) */
export function lineText(line: TutorialLine, helm: boolean): string {
  return typeof line === 'string' ? line : helm ? line.helm : line.screen;
}

export interface PanelModel {
  stepId: string;
  /** 1-based, of the whole list */
  n: number;
  total: number;
  title: string;
  /** HTML (escaped, key caps in <kbd>) */
  lines: string[];
  /** "Rings 2/3" for a multi-target step */
  counter: { label: string; done: number; total: number } | null;
  /** Done steps over all steps, 0..1 */
  progress: number;
  /** The welcome card's Continue button */
  canContinue: boolean;
  /** The last step: the graduate screen instead of the card */
  graduate: boolean;
}

/** What the card shows, or null when it is not shown (not in the lesson, or a step the data does not know) */
export function panelModel(s: State | null, data: TutorialData, keyOf: (action: string) => string, helm = false): PanelModel | null {
  if (!s || s.left) return null;
  const i = data.steps.findIndex((x) => x.id === s.step);
  if (i < 0) return null;
  const st = data.steps[i];
  return {
    stepId: st.id,
    n: i + 1,
    total: data.steps.length,
    title: st.title,
    lines: st.lines.map((l) => fillKeys(lineText(l, helm), keyOf)),
    counter: counterOf(s, st),
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
