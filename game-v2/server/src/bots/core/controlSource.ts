/**
 * A bot's orders as an InputSource (sim foundation, section D). Both drivers produce what they fly through this: the NPC
 * driver (a pilotless ship, flown by a controller) and the client driver (a simulated player, sending input messages)
 * share it, so a bot's held Controls become the same SimInput whichever way it is flown. `decided`: the task worked it out.
 */
import { simAimQ, controlBits, quantizeCursorDist, controlsOfInput, simAim } from '@space-game/common';
import type { InputSource, SimInput } from '@space-game/common';
import type { Controls } from './types.js';

/** A bot's held controls as one tick's input: the move keys and boost as bits, the aim on the grid, the mining laser as the secondary */
export function inputOfBotControls(c: Controls): SimInput {
  return {
    bits: controlBits({ forward: c.forward, backward: c.backward, left: c.left, right: c.right, boost: c.boost }),
    q: simAimQ(c.aim), jumpDist: -1, fire: false, fireAlt: c.mine, aimDist: quantizeCursorDist(c.aimDist),
  };
}

export class BotInputSource implements InputSource {
  readonly knowledge = 'decided' as const;
  private answered = -Infinity;
  /** `controls`: what the bot holds now (the driver's, with a berthed ship's idle applied) */
  constructor(private readonly controls: () => Controls) {}

  inputAt(t: number): SimInput {
    if (t > this.answered) this.answered = t;
    return inputOfBotControls(this.controls());
  }

  confirmedThrough(): number { return this.answered; }
}

/** The four move keys and boost of a SimInput (what a driver puts in a message or an order) */
export function keysOfInput(input: Readonly<SimInput>): { forward: boolean; backward: boolean; left: boolean; right: boolean; boost: boolean; targetAngle: number } {
  const c = controlsOfInput(input, { angle: 0 });
  return { forward: c.forward, backward: c.backward, left: c.left, right: c.right, boost: c.boost, targetAngle: simAim(input.q) };
}
