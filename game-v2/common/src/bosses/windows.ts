/**
 * Weak-point windows (docs/bosses/rework-2026-11.md 2.1): the recovery a boss shows after a signature move. Inside
 * one it takes WINDOW.inside of a hit, up to the window's cap (damage counted after armour and multipliers); filling
 * the cap early ends the window with a crack: a bonus of WINDOW.crack of the cap at once, and a stagger for the rest of
 * the window's time (taken at the outside rate). Outside windows it takes WINDOW.outside. The first WINDOW.rest ticks of
 * a window are a rest beat: no personal attack starts in them (bosses/personal.ts).
 *
 * The rule lives once, here, so the boss bar's meter, the server's damage and the dev tools agree tick for tick.
 * Pure: plain numbers, no Math transcendentals.
 */

export const WINDOW = {
  /** Damage taken inside a window, up to its cap */
  inside: 2,
  /** Damage taken outside windows (and in a stagger) */
  outside: 0.35,
  /** The crack's bonus, as a share of the cap */
  crack: 0.1,
  /** Ticks at a window's start with no personal attack (nor a boss's harassing shot) starting: a short beat (1 s, 2026-11-05 playtest: 2 s left it idle) */
  rest: 60,
  /** The meter's steps on the wire (fill in 1/steps) */
  steps: 32,
} as const;

/** A signature move's window: how long it stays open, and how much it takes before it cracks */
export interface WindowSpec { ticks: number; cap: number }

export interface WindowState {
  /** The tick it opened */
  at: number;
  ticks: number;
  cap: number;
  /** Damage it has taken so far (after the window's multiplier) */
  filled: number;
  /** The tick it cracked (-1: not cracked) */
  crackAt: number;
}

export function openWindow(spec: WindowSpec, tick: number): WindowState {
  return { at: tick, ticks: Math.max(1, Math.round(spec.ticks)), cap: Math.max(1, spec.cap), filled: 0, crackAt: -1 };
}

/** The tick its time runs out (open or staggered until then) */
export const windowEnd = (w: WindowState) => w.at + w.ticks;

/** Is it open (taking WINDOW.inside) at this tick */
export function windowOpen(w: WindowState | null | undefined, tick: number): boolean {
  return !!w && w.crackAt < 0 && tick >= w.at && tick < windowEnd(w);
}

/** Cracked, and still within its time: the boss holds still and harmless */
export function staggered(w: WindowState | null | undefined, tick: number): boolean {
  return !!w && w.crackAt >= 0 && tick < windowEnd(w);
}

/** Over: its time ran out (cracked or not) */
export function windowOver(w: WindowState | null | undefined, tick: number): boolean {
  return !w || tick >= windowEnd(w);
}

/** In its rest beat: no personal attack starts */
export function restBeat(w: WindowState | null | undefined, tick: number): boolean {
  return !!w && tick >= w.at && tick < w.at + WINDOW.rest && tick < windowEnd(w);
}

/** The share of a hit the boss takes at this tick (a windowed boss: with no window, the outside rate) */
export function windowTaken(w: WindowState | null | undefined, tick: number): number {
  return windowOpen(w, tick) ? WINDOW.inside : WINDOW.outside;
}

/**
 * Damage landed (as taken, after the multiplier): counted into an open window. Returns the crack's bonus when this
 * hit fills the cap (it cracks once), else 0
 */
export function noteWindowDamage(w: WindowState | null | undefined, amount: number, tick: number): number {
  if (!w || !windowOpen(w, tick) || !(amount > 0)) return 0;
  w.filled = Math.min(w.cap, w.filled + amount);
  if (w.filled < w.cap) return 0;
  w.crackAt = tick;
  return Math.round(w.cap * WINDOW.crack);
}

/** The meter (0..1) */
export function windowFill(w: WindowState | null | undefined): number {
  return w ? Math.min(1, w.filled / w.cap) : 0;
}

/** The meter on the wire, in whole steps (WINDOW.steps) */
export function windowFillStep(w: WindowState | null | undefined): number {
  return Math.floor(windowFill(w) * WINDOW.steps);
}
