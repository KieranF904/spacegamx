/**
 * Draws contributor notes (common/src/world/contributorNotes.ts) on a 2D
 * canvas: the flight overlay (ContributorPanel's canvas over the world) and
 * the system map share it. Each note's outline is built once as a Path2D in
 * world units about its anchor (cached by id and update time), so a frame is
 * just: where's the anchor now, translate, scale, stroke. Labels and the pin
 * are drawn at screen size. Your own notes have a white dot in the pin and
 * "you" under it; other people's a dark dot and their name, with the note's
 * score (thumbs up minus down) when it has one.
 */

import { noteAnchorPosition, noteScore, noteShapeReach, type ContributorNote, type NoteBodies, type NoteShape } from '@space-game/common';

interface Cached { key: string; path: Path2D | null; closed: boolean }
const cache = new Map<string, Cached>();

/** A shape's outline about (0, 0), world units (null: a point has none) */
export function shapePath(s: NoteShape): { path: Path2D | null; closed: boolean } {
  const p = new Path2D();
  switch (s.kind) {
    case 'point': return { path: null, closed: false };
    case 'circle': p.arc(0, 0, s.radius, 0, Math.PI * 2); return { path: p, closed: true };
    case 'ring':
      p.arc(0, 0, s.outer, 0, Math.PI * 2);
      p.moveTo(s.inner, 0);
      p.arc(0, 0, s.inner, 0, Math.PI * 2, true);
      return { path: p, closed: true };
    case 'rect': {
      const a = (s.rotationDeg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => [(x * s.w) / 2, (y * s.h) / 2]);
      corners.forEach(([x, y], i) => (i ? p.lineTo : p.moveTo).call(p, x * c - y * sn, x * sn + y * c));
      p.closePath();
      return { path: p, closed: true };
    }
    case 'line': case 'arrow': {
      p.moveTo(0, 0);
      p.lineTo(s.dx, s.dy);
      if (s.kind === 'arrow') {
        const len = Math.hypot(s.dx, s.dy), head = Math.min(len * 0.25, Math.max(len * 0.08, 200));
        const a = Math.atan2(s.dy, s.dx);
        for (const d of [-0.45, 0.45]) {
          p.moveTo(s.dx, s.dy);
          p.lineTo(s.dx - Math.cos(a + d) * head, s.dy - Math.sin(a + d) * head);
        }
      }
      return { path: p, closed: false };
    }
    case 'polygon':
      s.points.forEach(([x, y], i) => (i ? p.lineTo : p.moveTo).call(p, x, y));
      p.closePath();
      return { path: p, closed: true };
  }
}

function cached(n: ContributorNote): Cached {
  const key = `${n.updatedAt}|${JSON.stringify(n.shape)}`;
  let c = cache.get(n.id);
  if (!c || c.key !== key) {
    const s = shapePath(n.shape);
    c = { key, ...s };
    cache.set(n.id, c);
    if (cache.size > 3000) cache.clear();
  }
  return c;
}

export interface NoteView {
  /** World point to the canvas's current coordinates */
  toScreen(x: number, y: number): { x: number; y: number };
  /** World units to screen pixels */
  scale: number;
  /** The canvas's size in its coordinates (for culling) */
  w: number;
  h: number;
  tick: number;
  bodies: NoteBodies;
  /** Highlighted (being edited, or picked in the list) */
  focus?: string | null;
  /** Is this note the viewer's own (drawn apart from other people's) */
  mine?(n: ContributorNote): boolean;
}

/** Where each drawn note's pin is on screen (for clicks and tooltips) */
export type NotePins = { id: string; x: number; y: number }[];

export function drawNotes(ctx: CanvasRenderingContext2D, notes: Iterable<ContributorNote>, v: NoteView): NotePins {
  const pins: NotePins = [];
  ctx.save();
  ctx.font = '600 11px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  for (const n of notes) {
    const at = noteAnchorPosition(n.anchor, v.bodies, v.tick);
    if (!at) continue;
    const s = v.toScreen(at.x, at.y);
    const reach = noteShapeReach(n.shape) * v.scale + 120;
    if (s.x < -reach || s.y < -reach || s.x > v.w + reach || s.y > v.h + reach) continue;
    const dim = n.status !== 'open';
    const focus = v.focus === n.id;
    ctx.globalAlpha = dim ? 0.35 : 1;
    const c = cached(n);
    if (c.path) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.scale(v.scale, v.scale);
      ctx.lineWidth = (focus ? 3 : 1.8) / v.scale;
      ctx.setLineDash(dim ? [6 / v.scale, 6 / v.scale] : []);
      if (c.closed) {
        ctx.fillStyle = n.color;
        ctx.globalAlpha = (dim ? 0.35 : 1) * 0.1;
        ctx.fill(c.path, 'evenodd');
        ctx.globalAlpha = dim ? 0.35 : 1;
      }
      ctx.strokeStyle = n.color;
      ctx.stroke(c.path);
      ctx.restore();
    }
    // The pin: a teardrop with its point on the anchor
    ctx.fillStyle = n.color;
    ctx.strokeStyle = focus ? '#ffffff' : 'rgba(0,0,0,0.6)';
    ctx.lineWidth = focus ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.bezierCurveTo(s.x - 9, s.y - 9, s.x - 7, s.y - 19, s.x, s.y - 19);
    ctx.bezierCurveTo(s.x + 7, s.y - 19, s.x + 9, s.y - 9, s.x, s.y);
    ctx.fill();
    ctx.stroke();
    const own = !!v.mine?.(n);
    ctx.fillStyle = own ? '#ffffff' : 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.arc(s.x, s.y - 13, own ? 3 : 2.6, 0, Math.PI * 2); ctx.fill();
    // Title, and who left it
    const label = `${n.status === 'done' ? '✓ ' : n.status === 'wontdo' ? '✗ ' : ''}${n.title}`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(2, 6, 16, 0.85)';
    ctx.strokeText(label, s.x, s.y - 25);
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(label, s.x, s.y - 25);
    ctx.font = '10px "Segoe UI", sans-serif';
    const score = noteScore(n);
    const who = `${own ? 'you' : n.author}${score ? ` · ${score > 0 ? '+' : ''}${score}` : ''}`;
    ctx.strokeText(who, s.x, s.y + 13);
    ctx.fillStyle = own ? '#f1f5f9' : n.color;
    ctx.fillText(who, s.x, s.y + 13);
    ctx.font = '600 11px "Segoe UI", sans-serif';
    pins.push({ id: n.id, x: s.x, y: s.y - 10 });
  }
  ctx.restore();
  return pins;
}

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * The note under a screen point (contributor tools' clicks): a pin first, then
 * a shape's outline (within a few pixels), then the smallest closed shape the
 * point is inside. Null: nothing there.
 */
export function noteAt(notes: Iterable<ContributorNote>, px: number, py: number, v: Pick<NoteView, 'toScreen' | 'scale' | 'tick' | 'bodies'>): ContributorNote | null {
  if (probe === undefined) probe = document.createElement('canvas').getContext('2d');
  let edge: ContributorNote | null = null, inside: ContributorNote | null = null, smallest = Infinity;
  for (const n of notes) {
    const at = noteAnchorPosition(n.anchor, v.bodies, v.tick);
    if (!at) continue;
    const s = v.toScreen(at.x, at.y);
    if (Math.hypot(px - s.x, py - (s.y - 10)) < 13) return n;
    const c = cached(n);
    if (!c.path || !probe || edge) continue;
    const lx = (px - s.x) / v.scale, ly = (py - s.y) / v.scale;
    probe.lineWidth = 10 / v.scale;
    if (probe.isPointInStroke(c.path, lx, ly)) { edge = n; continue; }
    const reach = noteShapeReach(n.shape);
    if (c.closed && reach < smallest && probe.isPointInPath(c.path, lx, ly, 'evenodd')) { inside = n; smallest = reach; }
  }
  return edge ?? inside;
}

/** The shape being placed (dashed, no label) */
export function drawDraft(ctx: CanvasRenderingContext2D, shape: NoteShape, at: { x: number; y: number }, color: string, scale: number, extra?: [number, number][]): void {
  const { path } = shapePath(shape);
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 / scale;
  ctx.setLineDash([8 / scale, 6 / scale]);
  if (path) ctx.stroke(path);
  if (extra?.length) {
    // A polygon being clicked out: the corners so far
    ctx.beginPath();
    extra.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(at.x, at.y, 4, 0, Math.PI * 2); ctx.fill();
}
