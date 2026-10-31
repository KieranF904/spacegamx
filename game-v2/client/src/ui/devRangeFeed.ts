/**
 * The weapons range's readout (dev only): the server's `rangeState` messages go to whichever panel listens (the F10
 * DevRangePanel, made only in a Vite dev build). In a deployed build nobody listens and the message never arrives.
 */
import type { ServerRangeStateMessage } from '@space-game/common';

let sink: ((m: ServerRangeStateMessage) => void) | null = null;

export function setRangeSink(f: ((m: ServerRangeStateMessage) => void) | null): void {
  sink = f;
}

export function rangeFeed(m: ServerRangeStateMessage): void {
  sink?.(m);
}
