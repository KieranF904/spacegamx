/**
 * A look drawn late by the PT timeline (predict/kinds/movesKind.ts): how many ticks after its tick it is handed to the
 * drawing, so a telegraph or beam drawn late starts that far into its run (BossFx), as if it had been drawn on time.
 * Kept beside the message (not on it: the wire's message types stay as they are)
 */
const LATE = new WeakMap<object, number>();

export function setLate(m: object, ticks: number): void {
  if (ticks > 0) LATE.set(m, ticks);
}

/** Ticks it is drawn after its tick (0: on time, or not from the PT timeline) */
export function lateOf(m: object): number {
  return LATE.get(m) ?? 0;
}
