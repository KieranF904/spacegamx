/**
 * @contract client.state.screen-shake
 * owns:       camera shake: trauma that hits add to and time drains, read as a smooth-noise offset and roll
 * needs:      nothing (pure functions over a ScreenShake)
 * invariants: shake is trauma squared, so small knocks stay small — none pinned
 *             the offset follows time-based noise, the same at any frame rate — none pinned
 * extend:     none (tune SHAKE_* below)
 */

export interface ScreenShake {
  /** 0..1: hits add to it, it drains away; the shake is trauma² (small knocks stay small) */
  trauma: number;
  /** Seconds, for the noise */
  time: number;
  /** This frame's offset (screen pixels) and roll (radians) */
  offsetX: number;
  offsetY: number;
  rotation: number;
}

/** Smooth 1D value noise, -1..1 (one lattice value per unit of t) */
function shakeNoise(t: number, seed: number): number {
  const h = (n: number) => { const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
  const i = Math.floor(t), f = t - i;
  const a = h(i);
  return a + (h(i + 1) - a) * f * f * (3 - 2 * f);
}

/** Screen shake at full trauma: offset (px), roll (rad), noise rate (Hz), and how fast trauma drains (per second) */
const SHAKE_PX = 24;
const SHAKE_ROLL = 0.01;
const SHAKE_HZ = 25;
const SHAKE_DECAY = 1.2;

/**
 * A knock: `intensity` (about px, 2 a nudge .. 18 a capital ship going up) and
 * `duration` (s) add trauma, so a strong hit on top of a weak one shakes harder
 * rather than replacing it.
 */
export function triggerScreenShake(s: ScreenShake, intensity: number, duration: number): void {
  s.trauma = Math.min(1, s.trauma + Math.sqrt(Math.max(0, Math.min(1, intensity / 18))) * Math.min(1, 0.45 + duration));
}

/** Each frame (seconds): trauma drains; the offset follows smooth noise, the same at any frame rate */
export function updateScreenShake(s: ScreenShake, delta: number): void {
  s.trauma = Math.max(0, s.trauma - Math.min(0.1, delta) * SHAKE_DECAY);
  s.time += delta;
  const k = s.trauma * s.trauma, t = s.time * SHAKE_HZ;
  s.offsetX = k ? SHAKE_PX * k * shakeNoise(t, 1) : 0;
  s.offsetY = k ? SHAKE_PX * k * shakeNoise(t, 2) : 0;
  s.rotation = k ? SHAKE_ROLL * k * shakeNoise(t, 3) : 0;
}