/**
 * An impact rides what it hit: one anchor per hit (WeaponFx, PulseFx, DamageFx), following its target's drawn pose.
 * Once a frame it is stepped with the target's pose (one entity lookup, AnchorList.step), and works out how far the
 * target moved and turned since the last frame.
 *
 *   surface-bound parts (core, glow, fireball, scorch, light, streaks, rings) are moved by that whole motion (`move`),
 *                  so they stay on the hull or the rock as it moves and turns
 *   free parts     (sparks, sprays, embers, fragments, smoke) fly in the target's frame (`rideStep`): their own velocity
 *                  is relative to the target and drags towards rest on it, and each frame they are carried by how far the
 *                  hit point moved (`dx, dy`: the target's motion and its spin at that point, not swung round its centre).
 *                  So nothing smears round an orbiting rock or behind a ship that turns or brakes: what flies off it
 *                  carries the target's motion, whatever that motion does, as the target is drawn (asteroids step by the
 *                  whole tick, so a frame-rate velocity estimate would be 0 one frame and double the next)
 *
 * When the target is gone the anchor coasts on its last velocity and spin (smoothed over the last few moves, slowing a
 * little), so what's on it carries on along the target's path. An anchor lives as long as what rides it (`hold`).
 */

/** A target's drawn pose */
export interface AnchorPose { x: number; y: number; angle: number }

/** What anchors look their targets up in (GameState.entities): the drawn pose of an entity by id */
export interface PoseSource { get(id: number): { renderX: number; renderY: number; renderAngle: number } | undefined }

/** A free particle riding an anchor: position and velocity (world units a frame, relative to its target) */
export interface Rider { x: number; y: number; vx: number; vy: number }

/** How much of each frame's motion goes into the smoothed velocity (about the last 2 to 3 frames) */
const SMOOTH = 0.5;
/** A gone target's last motion slows by this each frame */
const COAST_DRAG = 0.985;
/** Frames without a move after which the target counts as still (its velocity eases to rest), not just between ticks */
const STILL_FRAMES = 4;

export class ImpactAnchor {
  /** Its target's pose as of the last step */
  x: number; y: number; angle: number;
  /** Its velocity (world units a frame) and spin (radians a frame), smoothed */
  vx = 0; vy = 0; spin = 0;
  /** The target is gone: it coasts */
  gone = false;
  /** This step's motion: a turn of `turn` about the old centre (ox, oy), the centre moved to (x, y) */
  turn = 0;
  /** The point it was hit at, riding the target, and how far that moved this step (what its free parts are carried by) */
  hx: number; hy: number; dx = 0; dy = 0;
  /** Frames it still has to ride (the longest life left of what's on it: `hold`) */
  left = 0;
  private ox = 0; private oy = 0; private c = 1; private s = 0;
  /** Frames since the target last moved (a rock moves only when the tick does) */
  private idle = 0;
  /** Steps that saw it move (its velocity is known after the first) */
  steps = 0;

  constructor(readonly id: number, pose: AnchorPose, hx = pose.x, hy = pose.y) {
    this.x = this.ox = pose.x; this.y = this.oy = pose.y; this.angle = pose.angle;
    this.hx = hx; this.hy = hy;
  }

  /** Keeps it riding at least `frames` more frames (a part with that much life left was put on it) */
  hold(frames: number): void {
    if (frames > this.left) this.left = frames;
  }

  /** One frame (`frames` long): the target's pose now, or null if it's gone (then it coasts) */
  step(pose: AnchorPose | null, frames: number): void {
    this.ox = this.x; this.oy = this.y;
    if (!pose) this.gone = true;
    if (frames <= 0) { this.still(); return; }
    if (this.gone) {
      const k = Math.pow(COAST_DRAG, frames);
      this.vx *= k; this.vy *= k; this.spin *= k;
      this.turn = this.spin * frames;
      this.x += this.vx * frames; this.y += this.vy * frames;
      this.angle += this.turn;
    } else {
      const d = pose!.angle - this.angle;
      this.turn = Math.atan2(Math.sin(d), Math.cos(d));
      const mx = pose!.x - this.x, my = pose!.y - this.y;
      if (mx !== 0 || my !== 0 || this.turn !== 0) {
        // (its velocity: this move over the frames since the last one, so a rock stepped once a tick reads steady)
        const span = this.idle + frames;
        const a = this.steps === 0 ? 1 : 1 - Math.pow(1 - SMOOTH, frames);
        this.vx += (mx / span - this.vx) * a; this.vy += (my / span - this.vy) * a; this.spin += (this.turn / span - this.spin) * a;
        this.idle = 0;
        this.steps++;
      } else {
        this.idle += frames;
        if (this.idle > STILL_FRAMES && this.steps > 0) {
          const a = 1 - Math.pow(1 - SMOOTH, frames);
          this.vx -= this.vx * a; this.vy -= this.vy * a; this.spin -= this.spin * a;
        }
      }
      this.x = pose!.x; this.y = pose!.y; this.angle = pose!.angle;
    }
    this.c = Math.cos(this.turn); this.s = Math.sin(this.turn);
    const px = this.hx, py = this.hy, rx = px - this.ox, ry = py - this.oy;
    this.hx = this.x + rx * this.c - ry * this.s;
    this.hy = this.y + rx * this.s + ry * this.c;
    this.dx = this.hx - px; this.dy = this.hy - py;
  }

  /** No motion this frame: `move` leaves points where they are and riders aren't carried */
  still(): void {
    this.ox = this.x; this.oy = this.y;
    this.turn = 0; this.c = 1; this.s = 0; this.dx = 0; this.dy = 0;
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

/**
 * One frame of a free particle (`frames` long): its own velocity (relative to what it came off) slowed by `drag` a frame,
 * then it moves by that and, riding an anchor, by how far the hit point moved this frame. Without an anchor it's a plain
 * world-space particle slowing to rest.
 */
export function rideStep(p: Rider, anc: ImpactAnchor | undefined, drag: number, frames: number): void {
  const k = Math.pow(drag, frames);
  p.vx *= k; p.vy *= k;
  p.x += p.vx * frames; p.y += p.vy * frames;
  if (anc) { p.x += anc.dx; p.y += anc.dy; }
}

/** The live anchors of one effects system: opened as hits land, stepped once a frame, dropped when nothing rides them */
export class AnchorList {
  readonly live: ImpactAnchor[] = [];
  private readonly pose: AnchorPose = { x: 0, y: 0, angle: 0 };

  /** A new anchor riding entity `id` (at its drawn pose now) from a hit at (hx, hy); null if there's no such entity */
  open(src: PoseSource | null | undefined, id: number, hx: number, hy: number): ImpactAnchor | null {
    const e = id >= 0 && src ? src.get(id) : undefined;
    if (!e) return null;
    const p = this.pose;
    p.x = e.renderX; p.y = e.renderY; p.angle = e.renderAngle;
    const a = new ImpactAnchor(id, p, hx, hy);
    a.hold(2);
    this.live.push(a);
    return a;
  }

  /**
   * Once a frame (`frames` long), before what rides them moves: each anchor follows its target's drawn pose (one lookup)
   * or coasts on if it's gone; one that has nothing left on it is dropped (and stops carrying anything)
   */
  step(src: PoseSource | null | undefined, frames: number): void {
    const L = this.live, p = this.pose;
    for (let i = L.length - 1; i >= 0; i--) {
      const a = L[i];
      a.left -= frames;
      if (a.left < 0) { a.still(); L[i] = L[L.length - 1]; L.pop(); continue; }
      const e = a.gone || !src ? undefined : src.get(a.id);
      if (e) { p.x = e.renderX; p.y = e.renderY; p.angle = e.renderAngle; }
      a.step(e ? p : null, frames);
    }
  }
}
