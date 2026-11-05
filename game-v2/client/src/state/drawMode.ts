/**
 * The prediction-mode hook (GameState.drawMode): which tick things are drawn at, and a last say on where another ship
 * is drawn. Null (the default, and always in a production build) leaves today's behaviour exactly as it is: mode A.
 * Only the dev Sim tools set it (client dev/predict: modes B, C1, C2, C3, switched live from the F7 panel). Every
 * member is optional; the server and the tick layer (hits, checks, the own ship's step) never read it: drawing only.
 */
import type { InterpolatedEntity } from './GameState';

export interface DrawModeHook {
  /** Start of a frame's interpolate (before any ship is placed): a mode's per-frame work (C2/C3: step the PT layer, check ST) */
  frame?(now: number): void;
  /** The tick the own ship and its shells are drawn at, given the default (the timeline's ownDraw) */
  own?(tick: number): number;
  /** The tick another replicated ship is placed at, given the default (the interpolated render tick) */
  ship?(e: InterpolatedEntity, renderTick: number): number;
  /** After another ship was placed (its replica pose): the mode may move where it is drawn (C2/C3: its PT pose, lerped) */
  placed?(e: InterpolatedEntity): void;
  /** The tick a shell is drawn at, given its owner and the frame's own-shell (present) and render ticks */
  shot?(owner: number, present: number, render: number): number;
}
