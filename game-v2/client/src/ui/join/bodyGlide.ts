/**
 * @contract client.ui.join.body-glide
 * owns:       how the sign-in screen's bodies (the star, the planet, the small one) leave for the join screen, which has
 *             the sky alone, and come back for the sign-in form: ONE camera move that every body is drawn through, by
 *             one progress value (0 in place, 1 gone) stepped by time (LoginUI holds it). The camera tilts, so everything
 *             moves down the screen with the big body, and pushes in about a point a little above the screen's centre,
 *             so everything grows and the bodies at the sides edge off them. How far it tilts and pushes in is worked
 *             out from the bodies on screen (glideCamera): the gentlest tilt that, with the push-in, has every body's
 *             whole drawing (rings and atmosphere too) out of the frame at the end. The star is carried by its disc; its
 *             plasma and glow that may still be in frame fade over the last part (glideFade: a safety net). The sky
 *             pans and pushes in with them by a smaller amount: the same camera move, farther off
 * needs:      nothing (pure)
 * invariants: at progress 1 every body's whole box, at the size it has grown to, is outside the view, whatever the
 *             view's shape, the bodies' places or the kind of visit (a planet or the sun as the big body), and the
 *             star's disc is out by the time its fade starts (GLIDE_MOVE) — client/src/ui/join/bodyGlide.test.ts
 *             every body only ever moves down the screen and away from the centre line as the progress grows — client/src/ui/join/bodyGlide.test.ts
 *             the star's fade only falls, from 1 to exactly 0 at progress 1: nothing of a body is drawn then — client/src/ui/join/bodyGlide.test.ts
 *             at progress 0 nothing is moved, grown or faded; place, zoom, fade and pan are functions of the progress
 *             alone, so turning back mid-glide retraces the same path with no jump — client/src/ui/join/bodyGlide.test.ts
 *             the push-in is 1 at 0, only grows and stays within GLIDE_ZOOM_MIN..GLIDE_ZOOM_MAX at the end — client/src/ui/join/bodyGlide.test.ts
 *             the progress moves by time, not frames, and stops at 0 and 1 — client/src/ui/join/bodyGlide.test.ts
 *             the sky's pan is zero at 0, only grows, and at its fastest is under the speed at which the sky's stars
 *             would streak (SKY_STREAK_PX) — client/src/ui/join/bodyGlide.test.ts
 * extend:     another body is one more box in glideCamera's list, drawn through glidePlace like the rest
 */

/** A body as drawn: its centre and the half-size of the square all of it is drawn in (rings and atmosphere too), in px */
export interface GlideBox { x: number; y: number; half: number }
/** ...and whether it is the star: boxed by its disc alone (its plasma is left to the fade), which is to be out of the
 *  frame by the time that fade starts */
export interface GlideBody extends GlideBox { star?: boolean }
/** The camera move's end: how far everything has moved down the screen (px) and how much it has grown */
export interface GlideCam { pan: number; zoom: number }

/** Seconds the whole of it takes, out or back */
export const GLIDE_S = 10;
/** The share of it after which the star's leftover plasma fades (the last 3 s) */
export const GLIDE_MOVE = 0.7;
/** Seconds of the plain fade that stands in for it all when the pilot asks for reduced motion */
export const GLIDE_FADE_S = 0.25;
/** The ease's top speed, as a multiple of its average */
export const GLIDE_EASE_PEAK = 1.875;

/** The push-in at the end: at least (so it always reads as a push-in), at most, and the steps tried between */
export const GLIDE_ZOOM_MIN = 1.4;
export const GLIDE_ZOOM_MAX = 2.6;
const ZOOM_STEP = 0.02;
/** Where the push-in is centred, as a share of the view's height from its top (a little above the centre) */
export const GLIDE_CENTRE_Y = 0.4;
/** Px added round every body in working the camera out (they orbit on, slowly, while it moves) */
export const GLIDE_MARGIN = 24;

/** The speed (px a 60th of a second, of its nearest stars) from which SkyRenderer draws its stars as streaks */
export const SKY_STREAK_PX = 2.5;
/** The sky's pan at its fastest, as a share of that speed (its push-in and its own slow drift come on top) */
export const SKY_PAN_PEAK = 0.3;
/** The sky's pan: how far its nearest stars travel down the screen, as a share of the view's height, and at most (px:
 *  what the top speed above allows over the glide: 240; the farther layers and the nebula move less, by their depth) */
export const SKY_PAN_SHARE = 0.3;
export const SKY_PAN_MAX_PX = Math.floor(SKY_PAN_PEAK * SKY_STREAK_PX * 60 * GLIDE_S / GLIDE_EASE_PEAK);
/** The sky's push-in: how much its camera has zoomed in at the end (far less than the bodies: it is far off) */
export const SKY_ZOOM_END = 1.16;

/** Ease in and out (smootherstep): 0 at 0, 1 at 1, no speed at either end */
export function glideEase(p: number): number {
  const t = Math.max(0, Math.min(1, p));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** The tilt a body needs, by the time the camera is k of the way (pushed in to `zoom` at its end), to be out of a
 *  w x h view: none if the push-in alone has taken it off a side by then, else enough to take it off the bottom */
function tiltFor(b: GlideBox, w: number, h: number, zoom: number, k: number): number {
  const s = 1 + (zoom - 1) * k, half = (b.half + GLIDE_MARGIN) * s;
  const x = w / 2 + s * (b.x - w / 2);
  if (x - half >= w || x + half <= 0) return 0;
  const zy = h * GLIDE_CENTRE_Y;
  return Math.max(0, h - (zy + s * (b.y - zy) - half)) / k;
}

/**
 * The camera move for these bodies in a w x h view: the push-in (GLIDE_ZOOM_MIN to GLIDE_ZOOM_MAX) that needs the least
 * tilt, and that tilt: just enough that every body's box is out of the frame at the end (off a side by the push-in, or
 * off the bottom), the star's disc already by the time its fade starts, and that nothing ever moves up the screen.
 */
export function glideCamera(bodies: readonly GlideBody[], w: number, h: number): GlideCam {
  const zy = h * GLIDE_CENTRE_Y, kStar = glideEase(GLIDE_MOVE);
  let best: GlideCam = { pan: Infinity, zoom: GLIDE_ZOOM_MIN };
  const steps = Math.round((GLIDE_ZOOM_MAX - GLIDE_ZOOM_MIN) / ZOOM_STEP);
  for (let i = 0; i <= steps; i++) {
    const zoom = GLIDE_ZOOM_MIN + i * ZOOM_STEP;
    let pan = 0;
    for (const b of bodies) {
      pan = Math.max(pan, tiltFor(b, w, h, zoom, 1), b.star ? tiltFor(b, w, h, zoom, kStar) : 0);
      // (a body above the push-in's centre is pushed up by it: the tilt at least makes up for that)
      pan = Math.max(pan, (zoom - 1) * (zy - b.y));
    }
    // (the least tilt; between near equals, within a px, the smaller push-in)
    if (pan < best.pan - 1) best = { pan, zoom };
  }
  return best;
}

/**
 * Where the camera move has a point of the screen at progress p, as an offset, and the scale things are drawn at there:
 * pushed away from the centre (w/2, GLIDE_CENTRE_Y h) by the zoom so far, and down by the tilt so far.
 */
export function glidePlace(x: number, y: number, cam: GlideCam, w: number, h: number, p: number): { dx: number; dy: number; scale: number } {
  const k = glideEase(p), s = 1 + (cam.zoom - 1) * k;
  if (k <= 0) return { dx: 0, dy: 0, scale: 1 };
  return { dx: (s - 1) * (x - w / 2), dy: (s - 1) * (y - h * GLIDE_CENTRE_Y) + cam.pan * k, scale: s };
}

/** How much of the star shows at progress p: all of it till GLIDE_MOVE, then fading (eased) to nothing at 1 */
export function glideFade(p: number): number {
  return 1 - glideEase((p - GLIDE_MOVE) / (1 - GLIDE_MOVE));
}

/**
 * How far down the screen (px) the sky's nearest stars have panned at progress p, in a view h high: over the whole
 * glide, by the same ease, so it reads as the one camera move; LoginUI turns it into the sky's camera travel.
 */
export function skyPan(h: number, p: number): number {
  return Math.min(SKY_PAN_MAX_PX, Math.max(0, h) * SKY_PAN_SHARE) * glideEase(p);
}

/** How much the sky's camera has zoomed in at progress p (a multiple of its zoom): by the same ease */
export function skyZoom(p: number): number {
  return 1 + (SKY_ZOOM_END - 1) * glideEase(p);
}

/** The progress after dt seconds on its way out (to 1) or back (to 0), the whole of it taking `seconds` */
export function glideStep(p: number, out: boolean, dt: number, seconds = GLIDE_S): number {
  const step = Math.max(0, dt) / Math.max(1e-3, seconds);
  return Math.max(0, Math.min(1, p + (out ? step : -step)));
}
