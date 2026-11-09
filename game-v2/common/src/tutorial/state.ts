/**
 * @contract common.tutorial.state
 * owns:       a pilot's saved tutorial progress: a fresh one, a tolerant copy of a saved one, and "is this object live for
 *             them"
 * needs:      types (TutorialProfile, TutorialObjectDef, TutorialData)
 * invariants: an existing profile (one saved before the tutorial) is always `left` — common/src/tutorial/tutorial.test.ts
 * extend:     a new per-pilot field goes in TutorialProfile, cleanTutorial and (if the client shows it) the tutorialState message
 */

import { TUTORIAL_FIRST_STEP, type TutorialData, type TutorialObjectDef, type TutorialProfile } from './types.js';

/** A new pilot's progress: at the first step, nothing done */
export function newTutorial(): TutorialProfile {
  return { step: TUTORIAL_FIRST_STEP, done: [], left: false };
}

/** Left for good (an existing pilot, or one who skipped or graduated) */
export function leftTutorial(done: string[] = []): TutorialProfile {
  return { step: '', done, left: true };
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * A saved tutorial block made safe. Absent (a profile from before the tutorial): the pilot has left, so existing
 * pilots never enter the yard. Junk: the same.
 */
export function cleanTutorial(v: unknown): TutorialProfile {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return leftTutorial();
  const r = rec(v);
  const done = [...new Set(Array.isArray(r.done) ? r.done.filter((x): x is string => typeof x === 'string') : [])];
  if (r.left !== false) return leftTutorial(done);
  const hits: Record<string, number> = {};
  for (const [k, n] of Object.entries(rec(r.hits))) if (typeof n === 'number' && Number.isFinite(n) && n > 0) hits[k] = n;
  return { step: typeof r.step === 'string' && r.step ? r.step : TUTORIAL_FIRST_STEP, done, left: false, ...(Object.keys(hits).length ? { hits } : {}) };
}

/** The pilot is in the tutorial now */
export function inTutorial(t: TutorialProfile | undefined): boolean {
  return !!t && !t.left;
}

/** This pilot has broken the object (their counter reached its hp) */
export function objectBroken(t: TutorialProfile, o: TutorialObjectDef): boolean {
  return (o.hp ?? 0) > 0 && (t.hits?.[o.id] ?? 0) >= (o.hp ?? 0);
}

/**
 * Does this object still react to this pilot? An object whose step they have done, or that they have broken, is inert
 * for them: no damage, no drops (it still collides, and the client draws it ghosted). Objects of the current and later
 * steps are live. A pilot who has left sees nothing live.
 */
export function objectLive(t: TutorialProfile | undefined, o: TutorialObjectDef): boolean {
  if (!t || t.left) return false;
  return !t.done.includes(o.step) && !objectBroken(t, o);
}

/** The ids of the objects this pilot has broken (sent in tutorialState so the client can ghost them) */
export function brokenIds(t: TutorialProfile, data: TutorialData): string[] {
  return data.objects.filter((o) => objectBroken(t, o)).map((o) => o.id);
}

/** World position of a training object (the yard's centre plus its offset) */
export function objectPos(data: TutorialData, o: TutorialObjectDef): { x: number; y: number } {
  return { x: data.yard.center.x + o.at.x, y: data.yard.center.y + o.at.y };
}

/** Step ids in order */
export function stepIds(data: TutorialData): string[] {
  return data.steps.map((s) => s.id);
}

/** The step after `id` (none after the last) */
export function nextStep(data: TutorialData, id: string): string | undefined {
  const i = data.steps.findIndex((s) => s.id === id);
  return i >= 0 ? data.steps[i + 1]?.id : undefined;
}
