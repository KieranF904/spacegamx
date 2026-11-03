/**
 * The sign-in screen's two small bodies (loginBody.ts): the star in its top corner and one small planet or moon high in
 * the other. They orbit the central body together, at the same angular speed and very slowly (the tuning is all here;
 * the rest is geometry). A star or body that has crossed the screen and left is replaced.
 *
 * The view: the central body is a huge disc centred below the screen with its top quarter showing (cx, cy, radius R).
 * Each small body runs on an ellipse round that centre, through the spot it has always been drawn at, seen from above
 * the plane: the near half is the arc across the top of the screen (the only part ever in view). Both move the same way,
 * away from the star's corner: the star moves inward from its corner, across the sky, and the planet leaves at the far
 * edge. A body that has left is replaced by a new one entering at the star's corner side, as if the old one had gone
 * round the back; the star itself comes back at the same place (it is the light and stays the star).
 */

export const LOGIN_ORBITS = {
  /** Seconds for a full turn, the star's and the planet's alike: only the arc across the screen shows, a tenth or so of
   *  it, so a crossing takes the better part of ten minutes. (Both ellipses are stepped by the same angle, so they keep
   *  step in angle, not in pixels.) */
  period: 3600,
  /** How far each ellipse's apex rises above the spot it passes through, as a fraction of the screen's height */
  lift: { sun: 0.045, body: 0.03 },
  /** The small body's radius as a fraction of min(width, 1.6 · height): what it has always been (a moon beside a planet,
   *  a planet beside a moon), whatever Sol body is there now */
  size: { aroundPlanet: 0.026, aroundMoon: 0.05 },
  /** A ringed planet's disc is drawn at this fraction of that (its rings reach far past it) */
  ringedScale: 1,
  /** A planet with no moon to float beside it still gets a small body (a Sol body at random) */
  floaterWithoutMoon: true,
  /** Seconds between one leaving and the next coming in (picked between the two) */
  gap: [3, 14] as [number, number],
  /** The last few bodies that left aren't brought straight back */
  recent: 4,
  /** Never the small body (the star is the light and is drawn as the star) */
  exclude: ['sun'] as string[],
  /** A body doesn't come in while the star is this many of their radii from its entry */
  entryClear: 2.5,
  /** The light's glide when the star comes back at its corner: seconds for most of the way */
  lightGlide: 5,
  /** Longest frame (s) the orbit advances by, so a stalled tab doesn't jump them */
  maxDt: 0.1,
};

export interface OrbitView { cx: number; cy: number; R: number; w: number; h: number }

/** An ellipse about the central body's centre: a wide, b high */
export interface OrbitPath { a: number; b: number }

/** The ellipse through (x, y) whose apex is `lift` px higher than it (so (x, y) isn't the apex) */
export function pathThrough(x: number, y: number, v: OrbitView, lift: number): OrbitPath {
  const dy = Math.max(1, v.cy - y), dx = Math.max(1, Math.abs(x - v.cx));
  const b = dy + Math.max(1, lift);
  return { b, a: dx / Math.sqrt(1 - (dy / b) ** 2) };
}

/** The angle on the path of the point (x, y) (the apex at pi/2, left of it above, right of it below) */
export function pathAngle(p: OrbitPath, x: number, y: number, v: OrbitView): number {
  return Math.atan2((v.cy - y) / p.b, (x - v.cx) / p.a);
}

export function pathPoint(p: OrbitPath, v: OrbitView, theta: number): { x: number; y: number } {
  return { x: v.cx + p.a * Math.cos(theta), y: v.cy - p.b * Math.sin(theta) };
}

/** Whether a body of radius r at (x, y) is wholly off the screen */
export function offScreen(x: number, y: number, r: number, v: OrbitView): boolean {
  return x < -r * 1.5 || x > v.w + r * 1.5 || y > v.h + r * 1.5 || y < -r * 3;
}

/**
 * The angles where the path comes onto the screen and leaves it, for a body of radius r that moves toward the side
 * opposite `side` (side -1: it comes in at the left edge and goes at the right; the angle then falls as it moves).
 */
export function pathWindow(p: OrbitPath, v: OrbitView, r: number, side: number): { enter: number; exit: number } {
  const step = 0.002, apex = Math.PI / 2;
  const walk = (dir: number) => {
    let t = apex;
    for (let i = 0; i < Math.PI / step; i++) {
      const q = pathPoint(p, v, t);
      if (offScreen(q.x, q.y, r, v)) break;
      t += dir * step;
    }
    return t;
  };
  return { enter: walk(-side), exit: walk(side) };
}

/** Where a small body of Sol sits at first: the star high in one corner (side -1 left, 1 right), the planet in the other */
export function startSpots(side: number, w: number, h: number, aroundMoon: boolean): { sun: { x: number; y: number; r: number }; body: { x: number; y: number; r: number } } {
  const sr = Math.max(28, Math.min(w, h * 1.6) * 0.06);
  const size = aroundMoon ? LOGIN_ORBITS.size.aroundMoon : LOGIN_ORBITS.size.aroundPlanet;
  return {
    sun: { x: w / 2 + side * (w / 2 - sr * 0.15), y: h * 0.17, r: sr },
    body: { x: w / 2 - side * w * (aroundMoon ? 0.4 : 0.36), y: h * 0.2, r: Math.max(10, Math.min(w, h * 1.6) * size) },
  };
}

/**
 * The next body to float: a weighted pick among `ids` that aren't excluded, already on screen (`taken`: also the central
 * one) or lately gone (`recent`; ignored if that would leave nothing). Null if there's nothing at all.
 */
export function pickFloater(
  ids: string[], taken: Set<string>, recent: string[], weight: (id: string) => number,
  rnd: () => number = Math.random, cfg = LOGIN_ORBITS,
): string | null {
  const free = ids.filter((id) => !cfg.exclude.includes(id) && !taken.has(id));
  const fresh = free.filter((id) => !recent.includes(id));
  const pool = fresh.length ? fresh : free;
  if (!pool.length) return null;
  const total = pool.reduce((s, id) => s + weight(id), 0);
  let r = rnd() * total;
  for (const id of pool) if ((r -= weight(id)) < 0) return id;
  return pool[pool.length - 1];
}
