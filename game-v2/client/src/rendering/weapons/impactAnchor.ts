/**
 * An impact rides what it hit: one anchor per hit (WeaponFx), following its target's drawn pose. Once a frame it is
 * stepped with the target's pose (one entity lookup), and works out how far the target moved and turned since the last
 * frame; the impact's surface-bound parts (its core, glow, fireball, scorch, light, streaks) are moved by that
 * (`move`), so they stay on the hull or the rock. Its free-flying parts (fragments, embers, sprays, smoke) aren't locked
 * on: they are given the velocity of the hit point once (`pointVelocity`: the target's velocity plus its spin times the
 * offset) and fly on with the target's momentum. When the target is gone the anchor coasts on its last velocity and
 * spin (smoothed over the last few frames, slowing a little), so what's on it carries on along the target's path.
 */

/** A target's drawn pose */
export interface AnchorPose { x: number; y: number; angle: number }

/** How much of each frame's motion goes into the smoothed velocity (about the last 2 to 3 frames) */
const SMOOTH = 0.5;
/** A gone target's last motion slows by this each frame */
const COAST_DRAG = 0.985;

export class ImpactAnchor {
  /** Its target's pose as of the last step */
  x: number; y: number; angle: number;
  /** Its velocity (world units a frame) and spin (radians a frame), smoothed */
  vx = 0; vy = 0; spin = 0;
  /** The target is gone: it coasts */
  gone = false;
  /** This step's motion: a turn of `turn` about the old centre (ox, oy), the centre moved to (x, y) */
  turn = 0;
  private ox = 0; private oy = 0; private c = 1; private s = 0;
  /** Steps that saw it move (its velocity is known after the first) */
  steps = 0;

  constructor(readonly id: number, pose: AnchorPose) {
    this.x = this.ox = pose.x; this.y = this.oy = pose.y; this.angle = pose.angle;
  }

  /** One frame (`frames` long): the target's pose now, or null if it's gone (then it coasts) */
  step(pose: AnchorPose | null, frames: number): void {
    this.ox = this.x; this.oy = this.y;
    if (!pose) this.gone = true;
    if (frames <= 0) { this.turn = 0; this.c = 1; this.s = 0; return; }
    if (this.gone) {
      const k = Math.pow(COAST_DRAG, frames);
      this.vx *= k; this.vy *= k; this.spin *= k;
      this.turn = this.spin * frames;
      this.x += this.vx * frames; this.y += this.vy * frames;
    } else {
      const d = pose!.angle - this.angle;
      this.turn = Math.atan2(Math.sin(d), Math.cos(d));
      const fx = (pose!.x - this.x) / frames, fy = (pose!.y - this.y) / frames, fw = this.turn / frames;
      // (the first step's motion is the velocity; after that, smoothed over the last few)
      const a = this.steps === 0 ? 1 : SMOOTH;
      this.vx += (fx - this.vx) * a; this.vy += (fy - this.vy) * a; this.spin += (fw - this.spin) * a;
      this.x = pose!.x; this.y = pose!.y; this.angle = pose!.angle;
      this.steps++;
    }
    this.angle += this.gone ? this.turn : 0;
    this.c = Math.cos(this.turn); this.s = Math.sin(this.turn);
  }

  /** Moves a point riding the target by this step's motion (turned about the old centre, carried to the new) */
  move(p: { x: number; y: number }): void {
    const rx = p.x - this.ox, ry = p.y - this.oy;
    p.x = this.x + rx * this.c - ry * this.s;
    p.y = this.y + rx * this.s + ry * this.c;
  }

  /** The velocity (world units a frame) of a point riding the target at (px, py): its velocity plus its spin times the offset */
  pointVelocity(px: number, py: number, out: { vx: number; vy: number }): { vx: number; vy: number } {
    const rx = px - this.x, ry = py - this.y;
    out.vx = this.vx - this.spin * ry;
    out.vy = this.vy + this.spin * rx;
    return out;
  }
}
