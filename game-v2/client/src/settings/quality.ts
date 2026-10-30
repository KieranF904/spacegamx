/**
 * Graphics quality: the tiers behind the Display setting (Low, Medium, High, or Auto, which starts at High and
 * steps down while the frame rate stays poor), and what each one changes. High is how the game has always drawn.
 */

export type QualitySetting = 'auto' | 'low' | 'medium' | 'high';
export type QualityTier = 'low' | 'medium' | 'high';
/** Frame-rate cap choices (0: none) */
export const FPS_CAPS = [0, 30, 60, 120, 144] as const;

export interface QualityProfile {
  /** Multisampled canvas (read once, when the game starts: the context can't change after) */
  msaa: boolean;
  /** Most pixels per CSS pixel to render at (the Render resolution setting scales whatever this allows) */
  maxDpr: number;
  /** The glow texture's size as a fraction of the screen's, and how many blur passes it gets */
  bloomScale: number;
  bloomQuality: number;
  /** Which of the sky's six star layers are drawn, near to far */
  starLayers: readonly boolean[];
  /** The sky haze texture's size as a fraction of the screen's */
  hazeScale: number;
  /** Share of the small effect particles (sparks, debris) spawned */
  particles: number;
  /** The cold's frost texture, pixels wide (0: a gradient tint only: ui/FrostVignette.ts) */
  frostTexture: number;
}

export const PROFILES: Record<QualityTier, QualityProfile> = {
  high: { msaa: true, maxDpr: 2, bloomScale: 0.25, bloomQuality: 2, starLayers: [true, true, true, true, true, true], hazeScale: 1 / 2, particles: 1, frostTexture: 1024 },
  medium: { msaa: true, maxDpr: 1.5, bloomScale: 0.2, bloomQuality: 2, starLayers: [true, true, true, false, true, true], hazeScale: 0.4, particles: 0.7, frostTexture: 640 },
  low: { msaa: false, maxDpr: 1, bloomScale: 0.125, bloomQuality: 1, starLayers: [true, false, true, false, true, true], hazeScale: 1 / 3, particles: 0.4, frostTexture: 0 },
};

const ORDER: QualityTier[] = ['high', 'medium', 'low'];

/** Auto: steps down a tier when the frames come in slower than the target for a few seconds on end (never back up by itself) */
export class AutoQuality {
  tier: QualityTier = 'high';
  private sum = 0;
  private count = 0;
  private since = 0;
  private lastDrop = 0;

  reset(): void {
    this.tier = 'high';
    this.sum = this.count = 0;
    this.since = 0;
    this.lastDrop = 0;
  }

  /**
   * One frame's interval (ms) at time `now`. `capMs` is the frame cap's interval (0: none).
   * Returns true when the tier just dropped.
   */
  sample(frameMs: number, now: number, capMs: number): boolean {
    // (A stall, or a tab coming back, isn't the machine being slow)
    if (frameMs > 250 || frameMs <= 0) return false;
    if (!this.since) this.since = now;
    this.sum += frameMs;
    this.count++;
    if (now - this.since < 3000) return false;
    const avg = this.sum / this.count;
    this.sum = this.count = 0;
    this.since = now;
    // Slower than a 60 Hz screen (or the cap) should be, by a third
    const target = Math.max(capMs, 1000 / 60);
    if (avg < target * 1.35 || this.tier === 'low' || now - this.lastDrop < 6000) return false;
    this.tier = ORDER[ORDER.indexOf(this.tier) + 1];
    this.lastDrop = now;
    return true;
  }
}
