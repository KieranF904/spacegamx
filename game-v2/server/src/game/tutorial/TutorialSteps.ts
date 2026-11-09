/**
 * @contract server.game.tutorial.steps
 * owns:       the step engine: which event advances which step (a STUB: only the welcome acknowledgement and graduating)
 * needs:      Tutorial (completeStep, leave, data); npm: @space-game/common
 * invariants: a step only advances on an event of the pilot's own current step; the order is data/tutorial.json's — server/src/game/tutorial/tutorial.test.ts
 * extend:     a case in `advance` per trigger kind in common/src/tutorial/types.ts (TutorialTriggerKind): read the pilot's
 *             current step's `trigger` from data, check the event satisfies it (counting where it takes several: rings,
 *             objectsBroken, collect), then `tutorial.completeStep(conn, step)`. Entering a step is `completeStep` of the
 *             one before it; give the step's `grant` and call `resetObjects` there if the step needs them
 */

import type { TutorialEvent } from '@space-game/common';
import type { Tutorial } from './Tutorial.js';

export class TutorialSteps {
  constructor(private readonly tutorial: Tutorial) {}

  /** The pilot (entity `pid`) in the tutorial caused `ev`: advance their step if it is what the step waits for */
  advance(pid: number, ev: TutorialEvent): void {
    const conn = this.tutorial.pilotOf(pid);
    const t = conn && this.tutorial.stateOf(conn);
    if (!conn || !t || t.left) return;
    const step = this.tutorial.data.steps.find((s) => s.id === t.step);
    if (!step) return;
    switch (ev.kind) {
      case 'ack':
        if (step.trigger.kind === 'ack' && ev.step === step.id) this.tutorial.completeStep(conn, step.id);
        return;
      case 'graduate':
        if (step.trigger.kind === 'graduate') this.tutorial.leave(conn);
        return;
      default:
        // (the other events are for the next stage of the engine)
        return;
    }
  }
}
