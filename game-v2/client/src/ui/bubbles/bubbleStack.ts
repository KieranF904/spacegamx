/**
 * Chat bubbles, with no DOM: each pilot's stack of what they said (oldest on top, the newest at the bottom), how long
 * each one stays, how see-through it is, where it sits in its stack (the older ones glide up as a new one arrives) and
 * where the stack is anchored in the world (a live ship's place as drawn, or a far one's, sampled now and then and
 * eased: BubbleOrigin). ChatBubbles.ts draws what this hands back. Times are seconds, sizes CSS pixels.
 */

export const BUBBLE = {
  /** Fade in and out (s) */
  fadeIn: 0.2,
  fadeOut: 0.5,
  /** How long one stays before it fades: a short line a few seconds, longer ones longer (s) */
  baseLife: 4.5,
  perChar: 0.06,
  maxLife: 11,
  /** A stack holds this many; a new one past it sends the oldest on its way (fading) */
  perPilot: 4,
  /** ...and no more than this many on screen in all (the oldest anywhere goes first) */
  total: 36,
  /** Space between stacked bubbles (px) */
  gap: 5,
  /** How quickly a bubble glides to its place in the stack (1/s: exponential approach) */
  glide: 12,
  /** A new bubble rises this far into place as it fades in (px) */
  rise: 10,
  /** Longest text a bubble shows (characters; past it the text is cut at a word and ends with …) */
  maxChars: 160,
} as const;

/** A far pilot's bubble origin is sampled this often (s): the map feed's ring tier (MAP_DOTS_TICKS, 60 ticks) */
export const ORIGIN_REFRESH = 1;
/** ...and eased to the new place over this long (s) */
export const ORIGIN_EASE = 0.35;

export interface Bubble {
  pilot: number;
  text: string;
  /** When it was said, and when it starts to fade out (s) */
  born: number;
  fades: number;
  /** Its drawn height (px: measured when it's made) */
  height: number;
  /** Where it is in its stack: px above the anchor to its bottom edge, and where it's going */
  y: number;
  target: number;
  /** The drawing side's element for it (-1: none yet) */
  slot: number;
}

/** Where a stack is anchored in the world */
export interface BubbleOrigin {
  x: number;
  y: number;
  /** A far one's ease: from, to, and when it started (s) */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  t0: number;
  /** When it was last sampled (s) */
  sampled: number;
  /** Following a live ship (its drawn place every frame), or a far one's sampled place */
  live: boolean;
  /** Has a place at all */
  known: boolean;
}

export interface BubbleStack {
  pilot: number;
  name: string;
  /** Oldest first: the last one is at the bottom, by the ship */
  bubbles: Bubble[];
  origin: BubbleOrigin;
}

/** How long a line stays up before it starts to fade (s) */
export function lifeFor(text: string): number {
  return Math.min(BUBBLE.maxLife, BUBBLE.baseLife + text.length * BUBBLE.perChar);
}

/** A line cut to fit a bubble: whitespace runs folded, cut at a word near the limit (or mid-word if there's none), … */
export function clipText(text: string, max: number = BUBBLE.maxChars): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  // (A word boundary in the last quarter: cut there; a long unbroken run is cut where it is)
  const at = space >= max * 0.75 ? space : cut.length;
  return cut.slice(0, at).replace(/[\s,.;:!?-]+$/, '') + '…';
}

/** How opaque a bubble is at `now` (0..1): fading in, held, fading out */
export function bubbleAlpha(b: Bubble, now: number): number {
  const a = (now - b.born) / BUBBLE.fadeIn;
  const z = 1 - (now - b.fades) / BUBBLE.fadeOut;
  return Math.max(0, Math.min(1, a, z));
}

/** Gone: faded out all the way */
export function bubbleDone(b: Bubble, now: number): boolean {
  return now >= b.fades + BUBBLE.fadeOut;
}

/** Exponential approach of `cur` to `target` at `rate` (1/s) over `dt` (frame-rate independent) */
export function approach(cur: number, target: number, rate: number, dt: number): number {
  const d = target - cur;
  if (Math.abs(d) < 0.05) return target;
  return cur + d * (1 - Math.exp(-rate * dt));
}

/** Smoothstep 0..1 */
function smooth(k: number): number {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
}

export function newOrigin(): BubbleOrigin {
  return { x: 0, y: 0, fromX: 0, fromY: 0, toX: 0, toY: 0, t0: 0, sampled: -Infinity, live: false, known: false };
}

/** A live ship's place (drawn this frame): the origin is that */
export function originLive(o: BubbleOrigin, x: number, y: number, now: number): void {
  o.x = o.fromX = o.toX = x;
  o.y = o.fromY = o.toY = y;
  o.t0 = o.sampled = now;
  o.live = o.known = true;
}

/** A far ship: is a fresh sample due (it's never had one, it was live till now, or the refresh is up) */
export function originDue(o: BubbleOrigin, now: number): boolean {
  return !o.known || o.live || now - o.sampled >= ORIGIN_REFRESH;
}

/** A far ship's fresh sample: eased to from where the origin is now (straight there if it had none) */
export function originSample(o: BubbleOrigin, x: number, y: number, now: number): void {
  if (!o.known) { originLive(o, x, y, now); o.live = false; return; }
  o.fromX = o.x; o.fromY = o.y;
  o.toX = x; o.toY = y;
  o.t0 = o.sampled = now;
  o.live = false;
}

/** A far origin's eased place at `now` (a live one is already where it is) */
export function originStep(o: BubbleOrigin, now: number): void {
  if (o.live || !o.known) return;
  const k = smooth((now - o.t0) / ORIGIN_EASE);
  o.x = o.fromX + (o.toX - o.fromX) * k;
  o.y = o.fromY + (o.toY - o.fromY) * k;
}

/**
 * Every pilot's stack. `say` adds a line (capped per pilot and in all), `step` moves time on: the faded ones go (handed
 * to `release`, so the drawing side can take their elements back) and the rest glide to their places in their stacks.
 */
export class BubbleBoard {
  readonly stacks = new Map<number, BubbleStack>();
  private count = 0;
  /** Bubbles let go of (the drawing side reuses them: no garbage per line) */
  private spare: Bubble[] = [];

  constructor(private release: (b: Bubble) => void = () => {}) {}

  get size(): number {
    return this.count;
  }

  /** A line said. `height`: its drawn height (px), which the drawing side can set after it's made it */
  say(pilot: number, name: string, text: string, now: number, height = 0): Bubble {
    let s = this.stacks.get(pilot);
    if (!s) { s = { pilot, name, bubbles: [], origin: newOrigin() }; this.stacks.set(pilot, s); }
    s.name = name;
    const clipped = clipText(text);
    // (Past the cap: the oldest still up starts to fade, and one already fading goes at once)
    this.capStack(s, now);
    if (this.count >= BUBBLE.total) this.dropOldest();
    // (That may have been this stack's last one)
    if (!this.stacks.has(pilot)) this.stacks.set(pilot, s);
    const b = this.spare.pop() ?? { pilot, text: '', born: 0, fades: 0, height: 0, y: 0, target: 0, slot: -1 };
    b.pilot = pilot; b.text = clipped; b.born = now; b.fades = now + lifeFor(clipped);
    b.height = height; b.y = -BUBBLE.rise; b.target = 0; b.slot = -1;
    s.bubbles.push(b);
    this.count++;
    this.layout(s);
    return b;
  }

  /** Move on to `now` (`dt`: since the last step, s) */
  step(now: number, dt: number): void {
    for (const s of this.stacks.values()) {
      let gone = 0;
      for (let i = 0; i < s.bubbles.length; i++) {
        const b = s.bubbles[i];
        if (bubbleDone(b, now)) { this.free(b); gone++; } else if (gone) s.bubbles[i - gone] = b;
      }
      if (gone) s.bubbles.length -= gone;
      if (!s.bubbles.length) { this.stacks.delete(s.pilot); continue; }
      if (gone) this.layout(s);
      for (const b of s.bubbles) b.y = approach(b.y, b.target, BUBBLE.glide, dt);
      originStep(s.origin, now);
    }
  }

  /** A bubble's drawn height, once the drawing side has measured it: its stack is laid out again */
  setHeight(b: Bubble, height: number): void {
    b.height = height;
    const s = this.stacks.get(b.pilot);
    if (s) this.layout(s);
  }

  /** Everything gone at once (another system, signed out) */
  clear(): void {
    for (const s of this.stacks.values()) for (const b of s.bubbles) this.free(b);
    this.stacks.clear();
  }

  /** Each bubble's place: the newest at the bottom (0), each older one above the ones after it */
  layout(s: BubbleStack): void {
    let y = 0;
    for (let i = s.bubbles.length - 1; i >= 0; i--) {
      const b = s.bubbles[i];
      b.target = y;
      y += b.height + BUBBLE.gap;
    }
  }

  private capStack(s: BubbleStack, now: number): void {
    let up = 0;
    for (const b of s.bubbles) if (b.fades > now) up++;
    for (let i = 0; up >= BUBBLE.perPilot && i < s.bubbles.length; i++) {
      const b = s.bubbles[i];
      if (b.fades > now) { b.fades = now; up--; }
    }
    // (A burst: one already fading at the top goes straight away, so a stack is never more than one over)
    while (s.bubbles.length >= BUBBLE.perPilot + 1) { this.free(s.bubbles[0]); s.bubbles.shift(); }
  }

  /** The oldest bubble anywhere goes at once (the total's full) */
  private dropOldest(): void {
    let from: BubbleStack | null = null;
    for (const s of this.stacks.values()) if (s.bubbles.length && (!from || s.bubbles[0].born < from.bubbles[0].born)) from = s;
    if (!from) return;
    this.free(from.bubbles[0]);
    from.bubbles.shift();
    if (!from.bubbles.length) this.stacks.delete(from.pilot);
    else this.layout(from);
  }

  private free(b: Bubble): void {
    this.count--;
    this.release(b);
    b.slot = -1;
    this.spare.push(b);
  }
}
