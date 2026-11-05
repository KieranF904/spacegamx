/**
 * The sim overlay's input: a small interface the overlay reads each frame, so it knows nothing about GameState or ShipClient.
 * gameStateSource.ts fills it from what exists today; Stage 3 (C) and Stage 4 (modes C2/C3) fill in the rest through the same
 * optional members. Everything is optional except the camera and the ship list: a member a source doesn't have draws as a dash.
 */

export interface PoseXY { x: number; y: number; angle: number }

/** One ship as the overlay draws it */
export interface OverlayShip {
  id: number;
  own: boolean;
  /** PT: where the client's own stepper has the ship now (the predicted timeline; for the own ship, the prediction) */
  pt: PoseXY | null;
  /** ST: the ghost of the confirmed timeline (what the server has said / the lagging stepper) */
  st: PoseXY | null;
  /** Where it is drawn this frame (after smoothing / lerp) */
  drawn: PoseXY | null;
}

/** A correction just applied: the ship moved `from` -> `to` in one go (a re-step landing somewhere else, or a snap) */
export interface CorrectionVector { id: number; from: { x: number; y: number }; to: { x: number; y: number }; at: number }

export interface OverlayCounters {
  /** Corrections applied a second */
  correctionsPerSec: number;
  /** Ticks re-stepped a second (a roll-back and re-step of N ticks counts N) */
  restepsPerSec: number;
  /** Server head-hash disagreements a second (Stage 3 C) */
  hashMissesPerSec: number;
  /** Size of the corrections in world units, over the window */
  meanCorrection: number;
  maxCorrection: number;
  /** Time spent in prediction a frame, ms (mean over the window) */
  predictionCpuMs: number;
  /** Hits drawn locally a second, and hits the server told a second */
  drawnHitsPerSec: number;
  realHitsPerSec: number;
  /** Input-to-screen estimate, ms */
  inputToScreenMs: number;
}

export interface SimOverlaySource {
  /** Where the camera is, for placing world points on screen */
  camera(): { x: number; y: number; zoom: number; angle: number; width: number; height: number };
  ships(): OverlayShip[];
  counters(): Partial<OverlayCounters>;
  /** Corrections applied since last asked (drawn as vectors that fade) */
  corrections?(): CorrectionVector[];
  /**
   * Hooks for the demo modes (Stage 4: A, B, C1, C2, C3): the mode's name, and extra counter rows it wants shown
   * (e.g. re-step depth, touch-register window, lerp time). Plain label -> text.
   */
  mode?(): string;
  extras?(): Record<string, string | number>;
}
