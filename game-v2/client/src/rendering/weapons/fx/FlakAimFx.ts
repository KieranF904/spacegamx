/**
 * @contract client.weapon-fx.flak-aim
 * owns:       the burst markers of your flak guns: a faint dashed circle of the burst's radius at the point each shell will
 *             burst along its turret's aim, with a small ring at its middle
 * needs:      FxField (line, ringAt), an aimMarks hook set by the Renderer (ships/render/flakAim.ts fills the marks)
 * invariants: a mark's dashes are evenly spaced round its circle and turn with the clock — client/src/rendering/weapons/fx/FlakAimFx.test.ts
 *             nothing is allocated per frame — none pinned
 * extend:     a new look for the marker is one change to draw below
 */

import type { FxField } from './FxField';

/** Where one flak shell will burst, and how far its fragments reach (`firing`: 1 while the trigger is held, else 0) */
export interface AimMark { x: number; y: number; r: number; firing: number }

/** Most marks drawn a frame (turrets past this show none) */
export const MAX_AIM_MARKS = 12;

export interface AimMarkHost {
  /** Fills `out` with your flak guns' marks and returns how many, or 0 */
  readonly aimMarks: ((out: AimMark[]) => number) | null;
}

const TAU = Math.PI * 2;
const COLOR = 0xffc070;

/** How many dashes a circle of radius `r` gets */
export function dashCount(r: number): number {
  return Math.max(10, Math.min(28, Math.round(r / 12)));
}

/**
 * Dash `i` of `n` round a circle of radius `r` about (x, y), turned by `phase`: its two ends written into `out` as
 * [x0, y0, x1, y1]. A dash covers half of its slot of the circle.
 */
export function dashEnds(x: number, y: number, r: number, n: number, i: number, phase: number, out: number[]): void {
  const slot = TAU / n, a0 = phase + i * slot, a1 = a0 + slot * 0.5;
  out[0] = x + Math.cos(a0) * r; out[1] = y + Math.sin(a0) * r;
  out[2] = x + Math.cos(a1) * r; out[3] = y + Math.sin(a1) * r;
}

export class FlakAimFx {
  private readonly marks: AimMark[] = Array.from({ length: MAX_AIM_MARKS }, () => ({ x: 0, y: 0, r: 0, firing: 0 }));
  private readonly d = [0, 0, 0, 0];

  constructor(private readonly f: FxField, private readonly host: AimMarkHost) {}

  /** This frame's markers (`clock`: frames since start) */
  draw(clock: number): void {
    const n = this.host.aimMarks ? Math.min(MAX_AIM_MARKS, this.host.aimMarks(this.marks)) : 0;
    for (let k = 0; k < n; k++) {
      const m = this.marks[k];
      if (!(m.r > 0)) continue;
      const alpha = 0.16 + 0.2 * m.firing, count = dashCount(m.r), phase = clock * 0.004;
      for (let i = 0; i < count; i++) {
        dashEnds(m.x, m.y, m.r, count, i, phase, this.d);
        this.f.line(this.d[0], this.d[1], this.d[2], this.d[3], 1.6, COLOR, alpha);
      }
      this.f.ringAt(m.x, m.y, 6, COLOR, alpha * 1.6);
    }
  }
}
