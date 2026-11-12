import { describe, expect, it } from 'vitest';
import {
  GLIDE_CENTRE_Y, GLIDE_EASE_PEAK, GLIDE_FADE_S, GLIDE_MOVE, GLIDE_S, GLIDE_ZOOM_MAX, GLIDE_ZOOM_MIN,
  SKY_PAN_MAX_PX, SKY_PAN_PEAK, SKY_PAN_SHARE, SKY_STREAK_PX, SKY_ZOOM_END,
  glideCamera, glideEase, glideFade, glidePlace, glideStep, skyPan, skyZoom, type GlideBody, type GlideCam,
} from './bodyGlide';

/** A small seeded generator (the cases are the same every run) */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const VIEWS: [number, number][] = [[1280, 800], [800, 1100], [1920, 1080], [3440, 1440], [360, 780], [500, 500], [2560, 1080]];

/** A body through the camera move at progress p: where its box is and how big */
function placed(b: GlideBody, cam: GlideCam, w: number, h: number, p: number): { x: number; y: number; half: number } {
  const o = glidePlace(b.x, b.y, cam, w, h, p);
  return { x: b.x + o.dx, y: b.y + o.dy, half: b.half * o.scale };
}
const outside = (b: { x: number; y: number; half: number }, w: number, h: number) =>
  b.x - b.half >= w || b.x + b.half <= 0 || b.y - b.half >= h || b.y + b.half <= 0;

/** The sign-in screen's big body: centred below the view, its top quarter showing (LoginUI) */
const bigBody = (w: number, h: number) => { const R = w / (4 * Math.sqrt(0.25 * 0.75)); return { R, cy: h + 0.5 * R }; };

/** A planet visit's bodies: the planet (its drawing `extent` radii: 1.3 bare, to 2.1 ringed), the star small at a top
 *  corner and a small body somewhere along the top (they orbit: anywhere across) */
function planetVisit(w: number, h: number, extent: number, r: () => number): GlideBody[] {
  const { R, cy } = bigBody(w, h), side = r() < 0.5 ? -1 : 1;
  const starR = (0.05 + 0.04 * r()) * h, smallR = (0.03 + 0.03 * r()) * h;
  return [
    { x: w / 2, y: cy, half: R * extent },
    { x: w / 2 + side * (0.2 + 0.32 * r()) * w, y: (0.05 + 0.3 * r()) * h, half: starR * 1.15, star: true },
    { x: r() * w, y: (0.05 + 0.3 * r()) * h, half: smallR * (r() < 0.3 ? 2.1 : 1.3) },
  ];
}
/** A sun visit: the star itself as the big body */
function sunVisit(w: number, h: number): GlideBody[] {
  const { R, cy } = bigBody(w, h);
  return [{ x: w / 2, y: cy, half: R * 1.15, star: true }];
}

function visits(): { w: number; h: number; bodies: GlideBody[]; kind: string }[] {
  const r = rng(11), all: { w: number; h: number; bodies: GlideBody[]; kind: string }[] = [];
  for (const [w, h] of VIEWS) {
    all.push({ w, h, bodies: sunVisit(w, h), kind: 'sun' });
    for (let i = 0; i < 60; i++) for (const extent of [1.3, 2.0, 2.1]) all.push({ w, h, bodies: planetVisit(w, h, extent, r), kind: `planet ${extent}` });
  }
  return all;
}

describe('the camera move that takes the sign-in screen\'s bodies out for the join screen', () => {
  it('takes ten seconds; the star\'s leftover plasma fades over the last 3', () => {
    expect(GLIDE_S).toBe(10);
    expect((1 - GLIDE_MOVE) * GLIDE_S).toBeCloseTo(3);
  });

  it('has every body\'s whole drawing outside the view at the end, for every view shape and both kinds of visit, by the move alone', () => {
    for (const { w, h, bodies, kind } of visits()) {
      const cam = glideCamera(bodies, w, h);
      for (const b of bodies) expect(outside(placed(b, cam, w, h, 1), w, h), JSON.stringify({ w, h, kind, b, cam })).toBe(true);
    }
  });

  it('has the star\'s disc out by the time its fade starts', () => {
    for (const { w, h, bodies, kind } of visits()) {
      const cam = glideCamera(bodies, w, h);
      for (const b of bodies) if (b.star) expect(outside(placed(b, cam, w, h, GLIDE_MOVE), w, h), JSON.stringify({ w, h, kind, b, cam })).toBe(true);
    }
  });

  it('is one move for all: every body only ever goes down the screen and away from the centre line, growing as it goes', () => {
    for (const { w, h, bodies } of visits()) {
      const cam = glideCamera(bodies, w, h);
      for (const b of bodies) {
        let last = { dx: 0, dy: 0, scale: 1 };
        for (let i = 1; i <= 50; i++) {
          const o = glidePlace(b.x, b.y, cam, w, h, i / 50);
          expect(o.dy).toBeGreaterThanOrEqual(last.dy - 1e-9);
          expect(o.dx * Math.sign(b.x - w / 2)).toBeGreaterThanOrEqual(last.dx * Math.sign(b.x - w / 2) - 1e-9);
          expect(o.scale).toBeGreaterThanOrEqual(last.scale);
          last = o;
        }
        // (the same scale for every body: it is the camera's)
        expect(last.scale).toBeCloseTo(cam.zoom, 9);
      }
    }
  });

  it('pushes in from 1 to between its least and most, and tilts no more than the bodies need', () => {
    for (const { w, h, bodies, kind } of visits()) {
      const cam = glideCamera(bodies, w, h);
      expect(cam.zoom).toBeGreaterThanOrEqual(GLIDE_ZOOM_MIN);
      expect(cam.zoom).toBeLessThanOrEqual(GLIDE_ZOOM_MAX + 1e-9);
      expect(cam.pan).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(cam.pan)).toBe(true);
      // (and no more than carrying its biggest box straight down the whole view and its own height would take)
      const big = Math.max(...bodies.map((x) => x.half));
      expect(cam.pan, JSON.stringify({ w, h, kind, cam })).toBeLessThanOrEqual((h + 2 * (big + 24) * GLIDE_ZOOM_MAX) / glideEase(GLIDE_MOVE));
    }
    expect(glidePlace(100, 100, { pan: 500, zoom: 1.5 }, 1280, 800, 0)).toEqual({ dx: 0, dy: 0, scale: 1 });
    // (the push-in is at least 1.4 on any visit, and never more than 2.6)
    expect(GLIDE_ZOOM_MIN).toBeGreaterThanOrEqual(1.4);
    expect(GLIDE_ZOOM_MAX).toBeLessThanOrEqual(2.6);
  });

  it('pushes in about a point a little above the centre: a body there only moves down', () => {
    const cam = { pan: 400, zoom: 1.5 }, o = glidePlace(640, 800 * GLIDE_CENTRE_Y, cam, 1280, 800, 1);
    expect(o.dx).toBeCloseTo(0);
    expect(o.dy).toBeCloseTo(400);
    expect(GLIDE_CENTRE_Y).toBeLessThan(0.5);
    // Off to the sides they edge outward as well
    expect(glidePlace(100, 300, cam, 1280, 800, 1).dx).toBeLessThan(0);
    expect(glidePlace(1200, 300, cam, 1280, 800, 1).dx).toBeGreaterThan(0);
  });

  it('fades the star\'s leftover: all there till the fade starts, then only ever less, to exactly nothing at the end', () => {
    expect(glideFade(0)).toBe(1);
    expect(glideFade(GLIDE_MOVE)).toBe(1);
    expect(glideFade(1)).toBe(0);
    expect(glideFade(2)).toBe(0);
    let last = 1;
    for (let i = 0; i <= 500; i++) {
      const a = glideFade(i / 500);
      expect(a).toBeLessThanOrEqual(last);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(last - a).toBeLessThan(0.02);
      last = a;
    }
    expect(glideFade((1 + GLIDE_MOVE) / 2)).toBeCloseTo(0.5, 6);
  });

  it('is one path either way: place and fade depend on the progress alone, with no jump', () => {
    const cam = { pan: 700, zoom: 1.4 };
    let p = 0;
    for (let i = 0; i < 180; i++) p = glideStep(p, true, 1 / 60, 5);
    expect(p).toBeCloseTo(0.6, 6);
    for (let i = 0; i < 60; i++) p = glideStep(p, false, 1 / 60, 5);
    expect(p).toBeCloseTo(0.4, 6);
    const a = glidePlace(200, 150, cam, 1280, 800, p), b = glidePlace(200, 150, cam, 1280, 800, 0.4);
    expect(a.dx).toBeCloseTo(b.dx, 4);
    expect(a.dy).toBeCloseTo(b.dy, 4);
    expect(a.scale).toBeCloseTo(b.scale, 6);
    let q = 0.9;
    for (let i = 0; i < 30; i++) q = glideStep(q, false, 1 / 60, 5);
    expect(glideFade(q)).toBeCloseTo(glideFade(0.8), 6);
    // (no jump: a frame never moves a point more than the ease's top speed allows)
    let last = 0;
    for (let i = 0; i <= 300; i++) {
      const d = glidePlace(640, 1000, cam, 1280, 800, i / 300).dy;
      expect(d - last).toBeLessThanOrEqual((700 + 0.4 * (1000 - 320)) * GLIDE_EASE_PEAK / 300 + 1e-6);
      last = d;
    }
  });

  it('eases in and out, never faster than its stated top speed', () => {
    expect(glideEase(0)).toBe(0);
    expect(glideEase(1)).toBe(1);
    expect(glideEase(0.5)).toBeCloseTo(0.5);
    expect(glideEase(0.05)).toBeLessThan(0.005);
    expect(glideEase(0.95)).toBeGreaterThan(0.995);
    expect(glideEase(-1)).toBe(0);
    expect(glideEase(2)).toBe(1);
    let top = 0;
    for (let i = 0; i < 2000; i++) top = Math.max(top, (glideEase((i + 1) / 2000) - glideEase(i / 2000)) * 2000);
    expect(top).toBeLessThanOrEqual(GLIDE_EASE_PEAK + 1e-9);
    expect(top).toBeGreaterThan(GLIDE_EASE_PEAK - 0.001);
  });

  it('runs on time, not frames, and stops at both ends', () => {
    let a = 0, b = 0;
    for (let i = 0; i < 30; i++) a = glideStep(a, true, 1 / 60);
    for (let i = 0; i < 72; i++) b = glideStep(b, true, 1 / 144);
    expect(a).toBeCloseTo(0.5 / GLIDE_S, 6);
    expect(b).toBeCloseTo(a, 6);
    expect(glideStep(0.9, true, 50)).toBe(1);
    expect(glideStep(0.1, false, 50)).toBe(0);
    expect(glideStep(0.3, true, -1)).toBe(0.3);
    // (reduced motion: the fade that stands in is far quicker)
    expect(GLIDE_FADE_S).toBeLessThan(GLIDE_S);
    expect(glideStep(0, true, GLIDE_FADE_S, GLIDE_FADE_S)).toBe(1);
  });

  it('takes the sky along from farther off: its pan nothing at 0, only ever further, and never fast enough to streak its stars', () => {
    expect(SKY_PAN_MAX_PX).toBe(240);
    for (const h of [500, 780, 800, 1080, 1100, 1440, 2160]) {
      expect(skyPan(h, 0)).toBe(0);
      const full = skyPan(h, 1);
      expect(full).toBeGreaterThan(0);
      expect(full).toBeLessThanOrEqual(SKY_PAN_MAX_PX);
      expect(full).toBeLessThanOrEqual(h * SKY_PAN_SHARE + 1e-9);
      // Its fastest, in px a 60th of a second, measured frame by frame over the glide's ten seconds
      let last = 0, top = 0;
      const frames = GLIDE_S * 60;
      for (let i = 0; i <= frames; i++) {
        const d = skyPan(h, i / frames);
        expect(d).toBeGreaterThanOrEqual(last);
        top = Math.max(top, d - last);
        last = d;
      }
      expect(top).toBeLessThanOrEqual(SKY_PAN_PEAK * SKY_STREAK_PX + 1e-6);
      // (with room for the sky's own slow drift on top: about 0.15 px)
      expect(top + 0.2).toBeLessThan(SKY_STREAK_PX);
      expect(skyPan(h, 0.5)).toBeCloseTo(full / 2, 6);
      expect(skyPan(h, 2)).toBe(full);
    }
    expect(skyPan(0, 1)).toBe(0);
  });

  it('pushes the sky in a little too: 1 at 0, only ever more, far less than the bodies', () => {
    expect(skyZoom(0)).toBe(1);
    expect(skyZoom(1)).toBeCloseTo(SKY_ZOOM_END);
    expect(SKY_ZOOM_END).toBeLessThan(GLIDE_ZOOM_MIN);
    let last = 1;
    for (let i = 0; i <= 100; i++) { const z = skyZoom(i / 100); expect(z).toBeGreaterThanOrEqual(last); last = z; }
    // Its nearest stars at a wide view's corner, by the push-in (their scale 1 / (1 / zoom + 2), the sky's zoom 0.35), at
    // its fastest: with the pan's fastest still under the streak speed
    const scale = (z: number) => 1 / (1 / z + 2), grow = scale(0.35 * SKY_ZOOM_END) / scale(0.35) - 1;
    const corner = Math.hypot(1920, 1080) / 2;
    const zoomPeak = grow * corner * GLIDE_EASE_PEAK / (GLIDE_S * 60);
    expect(zoomPeak + SKY_PAN_PEAK * SKY_STREAK_PX + 0.2).toBeLessThan(SKY_STREAK_PX);
  });
});
