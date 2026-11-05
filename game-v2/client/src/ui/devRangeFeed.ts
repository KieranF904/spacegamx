/**
 * The weapons range's readout (dev only): the server sends `rangeHead` (switches, guns, the dummies' labels) when it
 * changes and a `rangeRow` per dummy whose numbers moved; this keeps the whole readout and hands it to whichever panel
 * listens (the F10 DevRangePanel, made only in a Vite dev build). In a deployed build nobody listens and the messages
 * never arrive.
 */
import type { ServerRangeStateMessage, ServerRangeHeadMessage, ServerRangeRowMessage } from '@space-game/common';

let sink: ((m: ServerRangeStateMessage) => void) | null = null;
let state: ServerRangeStateMessage | null = null;

/** Listen for the readout; a listener gets the current one at once, if there is one */
export function setRangeSink(f: ((m: ServerRangeStateMessage) => void) | null): void {
  sink = f;
  if (f && state) f(state);
}

/** The latest readout (null before the first head) */
export function rangeState(): ServerRangeStateMessage | null {
  return state;
}

export function rangeHead(m: ServerRangeHeadMessage): void {
  state = {
    type: 'rangeState', moving: m.moving, ideal: m.ideal, guns: m.guns,
    // Numbers come in rows (the server sends every row after a head)
    dummies: m.dummies.map((d) => ({ ...d, dead: false, hull: 1, shield: 1, dmg5: 0, dps: 0, fight: 0, ttk: null, total: 0 })),
  };
  sink?.(state);
}

export function rangeRow(m: ServerRangeRowMessage): void {
  const d = state?.dummies[m.i];
  if (!d) return;
  d.dead = m.dead; d.hull = m.hull; d.shield = m.shield; d.dmg5 = m.dmg5; d.dps = m.dps; d.fight = m.fight; d.total = m.total;
  d.ttk = m.ttk ?? null;
  sink?.(state!);
}
