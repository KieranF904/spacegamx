/**
 * @contract client.hangar.marks
 * owns:       the hangar's build marks on its 2d canvas: facing arrows and power-port marks (the part in hand always, placed parts
 *             faint and bright under the mouse) and shaped-shield cover (in hand, hovered in the parts list, fitted ones faint)
 * needs:      HangarHost (geoms, ctx, mouse, view, paletteHover, handTurn), ships/build/buildMarks and portMarks geometry; npm: @space-game/common
 * invariants: the cover drawn is the one shaped.ts derives — client/src/ships/build/buildMarks.test.ts
 *             marks only draw, never change the design — none pinned
 * extend:     a new kind of mark is one function here, called from hangarDraw.ts draw()
 */

import { placeGeometry, facingEdges, isWeaponFn, type PlacedPart, type PlacedGeom, type Side, type Vec2 } from '@space-game/common';
import { facingMark, shieldCover, coverPolyline, COVER_COLOR, COVER_DEEP_COLOR, FACING_COLOR, GUN_FACING_COLOR } from '../build/buildMarks';
import { portMarks, PORT_COLOR } from '../build/portMarks';
import type { HangarHost } from './host';

type Px = (x: number) => number;
const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function arrow(host: HangarHost, p: PlacedPart, g: PlacedGeom, sx: Px, sy: Px, alpha: number): void {
  const mk = facingMark(p, g);
  if (!mk) return;
  const ctx = host.ctx;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = css(isWeaponFn(p.fn) ? GUN_FACING_COLOR : FACING_COLOR);
  ctx.strokeStyle = 'rgba(7, 11, 20, 0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  mk.tri.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** A part's power ports: OUT arrows pointing out, IN notches pointing in, feed diamonds */
function ports(host: HangarHost, p: PlacedPart, g: PlacedGeom, sx: Px, sy: Px, alpha: number): void {
  const marks = portMarks(p, g);
  if (!marks.length) return;
  const ctx = host.ctx;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = 'rgba(7, 11, 20, 0.7)';
  ctx.lineWidth = 1;
  for (const m of marks) {
    ctx.fillStyle = css(PORT_COLOR[m.kind]);
    ctx.beginPath();
    m.poly.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function cover(host: HangarHost, p: PlacedPart, g: PlacedGeom, sx: Px, sy: Px, alpha: number): void {
  const s = shieldCover(p, g);
  if (!s) return;
  const ctx = host.ctx, pts: Vec2[] = coverPolyline(s);
  const trace = () => { ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y)))); };
  ctx.save();
  ctx.strokeStyle = css(s.deep ? COVER_DEEP_COLOR : COVER_COLOR);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = alpha * 0.25; ctx.lineWidth = 9; trace(); ctx.stroke();
  ctx.globalAlpha = alpha; ctx.lineWidth = 3; trace(); ctx.stroke();
  ctx.restore();
}

/** Placed parts: every directional part a faint arrow, every fitted shield a faint cover, the one under the mouse brighter */
export function drawPlacedMarks(host: HangarHost, sx: Px, sy: Px): void {
  const under = host.mouse && !host.ports.hovering ? host.partAt(host.mouse) : -1;
  host.geoms.forEach((g, i) => {
    const hot = i === under;
    arrow(host, g.part, g, sx, sy, hot ? 1 : 0.4);
    ports(host, g.part, g, sx, sy, hot ? 0.95 : 0.35);
    cover(host, g.part, g, sx, sy, hot ? 0.7 : 0.2);
  });
}

/** The part in hand, placed where the mouse is (R turns it): its arrow and, for a shield, the cover it would put up */
export function drawHandMarks(host: HangarHost, cand: PlacedPart, g: PlacedGeom, sx: Px, sy: Px, blocked: boolean): void {
  arrow(host, cand, g, sx, sy, 1);
  ports(host, cand, g, sx, sy, 1);
  cover(host, cand, g, sx, sy, blocked ? 0.35 : 0.8);
}

/** A shield hovered in the parts list, with the mouse off the grid: shown in the middle of the view, turned as the hand is */
export function drawHoverCover(host: HangarHost, sx: Px, sy: Px): void {
  const h = host.paletteHover;
  if (!h || host.mouse) return;
  const turn = host.handTurn();
  const base: PlacedPart = { uid: -1, piece: h.piece, fn: h.fn, material: h.material, x: Math.floor(host.view.cx), y: Math.floor(host.view.cy), rot: turn.rot, flip: turn.flip };
  const g0 = placeGeometry(host.deps.catalog, base);
  const facing = (['N', 'E', 'S', 'W'] as Side[]).find((s) => facingEdges(g0, s).length > 0);
  if (!facing) return;
  const p: PlacedPart = { ...base, facing };
  const g = placeGeometry(host.deps.catalog, p);
  host.ctx.save();
  host.ctx.fillStyle = 'rgba(95, 212, 196, 0.2)';
  host.ctx.beginPath();
  g.polygon.forEach(([x, y], k) => (k ? host.ctx.lineTo(sx(x), sy(y)) : host.ctx.moveTo(sx(x), sy(y))));
  host.ctx.closePath();
  host.ctx.fill();
  host.ctx.restore();
  arrow(host, p, g, sx, sy, 1);
  ports(host, p, g, sx, sy, 1);
  cover(host, p, g, sx, sy, 0.8);
}
