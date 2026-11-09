/**
 * @contract server.game.tutorial.steps
 * owns:       the step engine: which event advances which step, what a step grants when it starts, and the graduation
 * needs:      Tutorial (completeStep, leave, data, grant); npm: @space-game/common
 * invariants: a step only advances on an event of the pilot's own current step, and only by what its trigger in data/tutorial.json asks;
 *             a client report only ever completes an "opened" or acknowledge step, never anything that pays;
 *             the graduate step leaves on its own after a few seconds if the client does not acknowledge — server/src/game/tutorial/steps.test.ts
 * extend:     a new trigger kind is a member of TutorialTriggerKind (common/src/tutorial/types.ts) plus a case in `satisfied`;
 *             per-step setup (a grant, objects reset) is in `entered`; counting that must survive a reconnect belongs in the
 *             profile, the rest (rings passed, ore taken, panels seen) is per visit and starts over when the pilot logs back in
 */

import { objectBroken, TICK_RATE } from '@space-game/common';
import type { TutorialEvent, TutorialStepDef, TutorialTrigger } from '@space-game/common';
import type { PilotConn } from '../Pilots.js';
import type { Tutorial } from './Tutorial.js';

/** The graduate card waits this long for an acknowledgement before the pilot is sent on anyway */
const GRADUATE_AFTER_TICKS = TICK_RATE * 20;

/** What a pilot has done toward the current step so far this visit */
interface Progress { step: string; seen: Set<string>; n: number }

export class TutorialSteps {
  private readonly progress = new Map<number, Progress>();
  /** Pilot entity -> the tick at which the graduate step sends them on */
  private readonly graduateAt = new Map<number, number>();

  constructor(private readonly tutorial: Tutorial) {}

  private prog(pid: number, step: string): Progress {
    let p = this.progress.get(pid);
    if (!p || p.step !== step) this.progress.set(pid, (p = { step, seen: new Set(), n: 0 }));
    return p;
  }

  /** The rings of `step` this pilot has passed this visit (for the tutorialState counter) */
  passedOf(pid: number, step: string): string[] {
    const p = this.progress.get(pid);
    const tr = this.tutorial.data.steps.find((s) => s.id === step)?.trigger;
    return p && p.step === step && tr?.kind === 'rings' ? [...p.seen] : [];
  }

  /** The pilot (entity `pid`) in the tutorial caused `ev`: advance their step if it is what the step waits for */
  advance(pid: number, ev: TutorialEvent): void {
    const conn = this.tutorial.pilotOf(pid);
    const t = conn && this.tutorial.stateOf(conn);
    if (!conn || !t || t.left) return;
    const step = this.tutorial.data.steps.find((s) => s.id === t.step);
    if (!step) return;
    if (ev.kind === 'graduate') {
      if (step.trigger.kind === 'graduate') this.tutorial.leave(conn);
      return;
    }
    if (!this.satisfied(conn, step, ev)) return;
    if (step.trigger.kind === 'graduate') this.tutorial.leave(conn);
    else this.tutorial.completeStep(conn, step.id);
  }

  /** Does `ev` finish the pilot's current step? */
  private satisfied(conn: PilotConn, step: TutorialStepDef, ev: TutorialEvent): boolean {
    const tr: TutorialTrigger = step.trigger;
    const objects = tr.objects ?? [];
    const p = this.prog(conn.playerId, step.id);
    switch (tr.kind) {
      case 'ack':
        return ev.kind === 'ack' && ev.step === step.id;
      case 'graduate':
        // (the card's Finish button; the timer in `tick` covers a client that never sends it)
        return ev.kind === 'ack' && ev.step === step.id;
      case 'rings':
        if (ev.kind !== 'ringPassed' || !objects.includes(ev.ring)) return false;
        p.seen.add(ev.ring);
        if (!objects.every((o) => p.seen.has(o))) { this.tutorial.sendState(conn); return false; }
        return true;
      case 'zoneStop':
        return ev.kind === 'zoneStopped' && ev.zone === objects[0];
      case 'objectsBroken': {
        if (ev.kind !== 'objectBroken' || !objects.includes(ev.object)) return false;
        const t = this.tutorial.stateOf(conn);
        return !!t && objects.every((id) => { const def = this.tutorial.def(id); return !!def && objectBroken(t, def); });
      }
      case 'collect':
        if (ev.kind !== 'collected' || (tr.items && !tr.items.includes(ev.item))) return false;
        p.n += ev.n;
        return p.n >= (tr.count ?? 1);
      case 'panel': {
        if (ev.kind !== 'panelOpened') return false;
        const want = tr.panels ?? (tr.panel ? [tr.panel] : []);
        if (!want.includes(ev.panel)) return false;
        p.seen.add(ev.panel);
        return want.every((w) => p.seen.has(w));
      }
      case 'docked':
        return ev.kind === 'docked' && ev.station === this.tutorial.data.yard.station;
      case 'refined':
        return ev.kind === 'refined' && (!tr.item || ev.item === tr.item);
      case 'partPlaced':
        return ev.kind === 'partPlaced';
      case 'powered':
        return ev.kind === 'powered';
      case 'jumped':
        return ev.kind === 'jumped' && !!ev.exit && objects.includes(ev.exit);
      default:
        return false;
    }
  }

  /**
   * The pilot has come to `stepId` (they finished the one before it, or they have just logged in at it):
   * start its counting over, give what it hands out (on finishing the step before: not again after a reconnect),
   * and re-arm the markers so one they stand in counts again.
   */
  entered(conn: PilotConn, stepId: string, fresh: boolean): void {
    const pid = conn.playerId;
    this.progress.delete(pid);
    this.graduateAt.delete(pid);
    this.tutorial.rearm(pid);
    const step = this.tutorial.data.steps.find((s) => s.id === stepId);
    if (!step) return;
    this.tutorial.resetObjects(conn, stepId);
    if (fresh && step.grant) this.tutorial.grant(conn, step.grant);
    if (step.trigger.kind === 'graduate') this.graduateAt.set(pid, this.tutorial.nowTick() + GRADUATE_AFTER_TICKS);
  }

  /** Once a tick: the graduate card's timer */
  tick(): void {
    if (!this.graduateAt.size) return;
    const now = this.tutorial.nowTick();
    for (const [pid, at] of [...this.graduateAt]) {
      if (now < at) continue;
      this.graduateAt.delete(pid);
      const conn = this.tutorial.pilotOf(pid);
      if (conn) this.tutorial.leave(conn);
    }
  }

  /** A pilot's connection ended */
  forget(pid: number): void {
    this.progress.delete(pid);
    this.graduateAt.delete(pid);
  }
}
