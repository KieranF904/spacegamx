/**
 * @contract client.ui.tutorial.store
 * owns:       this pilot's tutorial state as the server last sent it (`tutorialState`), and sending the two tutorial
 *             messages (leave, report); the lesson's UI reads and writes only through here
 * needs:      common ServerTutorialStateMessage, TutorialData (data/tutorial.json, bundled)
 * invariants: none beyond the message's own — client/src/app/serverMessages.test.ts
 * extend:     the lesson's card and markers (client/src/ui/tutorial/*) subscribe with `onTutorial`
 */

import type { ClientTutorialReportMessage, TutorialPanel, ServerTutorialStateMessage, TutorialData, TutorialObjectDef, TutorialStepDef } from '@space-game/common';
import tutorialJson from '../../../../data/tutorial.json';
import { isGhosted } from './tutorialModel';

/** The lesson's data, as the server runs it (steps, objects with positions, the yard) */
export const tutorialData = tutorialJson as unknown as TutorialData;

type Listener = (s: ServerTutorialStateMessage) => void;

let current: ServerTutorialStateMessage | null = null;
const listeners = new Set<Listener>();

/** The message handler's one call */
export function setTutorialState(m: ServerTutorialStateMessage): void {
  current = m;
  for (const fn of listeners) fn(m);
}

/** The latest state, or null before the server has sent one */
export function getTutorialState(): ServerTutorialStateMessage | null { return current; }

/** In the tutorial now (a state arrived and the pilot has not left) */
export function inTutorialNow(): boolean { return !!current && !current.left; }

/** Hear every change (the latest is passed at once if there is one); returns the way to stop */
export function onTutorial(fn: Listener): () => void {
  listeners.add(fn);
  if (current) fn(current);
  return () => listeners.delete(fn);
}

/** The current step's data, if in the tutorial */
export function currentStep(): TutorialStepDef | undefined {
  return current && !current.left ? tutorialData.steps.find((s) => s.id === current!.step) : undefined;
}

/** Should this training object be drawn ghosted for this pilot (its step done, or broken by them)? */
export function ghosted(o: TutorialObjectDef): boolean {
  return isGhosted(o, current);
}

/** Fresh client state on a new connection */
export function resetTutorial(): void { current = null; }

/** The two client messages, sent through whatever the Game sends with */
export function leaveMessage(): { type: 'tutorialLeave' } { return { type: 'tutorialLeave' }; }
export function reportMessage(kind: 'ack' | 'panel', extra: { step?: string; panel?: TutorialPanel } = {}): ClientTutorialReportMessage {
  return { type: 'tutorialReport', kind, ...extra };
}
