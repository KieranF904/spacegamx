/**
 * @contract client.hangar.draw
 * owns:       one redraw of the hangar grid: the grid layer, the ship's marks and the part-in-hand ghost
 * needs:      HangarHost, hangarOverlays, hangarMarks; npm: @space-game/common
 * invariants: layer order is grid, turret arcs, parts, mounting, groups, overlays, ghost — none pinned
 * extend:     a new overlay is one block in draw() and one toggle in HangarHost.overlays
 */

import { Side, Vec2, placeGeometry, computeJoins, connectorEndpoints, computeTurretWindow, mountingOf } from '@space-game/common';
import { CONNECTOR_COLOR, numToCss } from '../shipColors';
import { drawHangarGroups } from '../weaponGroups/editor';
import { weaponMount } from '../modelCards';
import { gradeGlow, partColors } from '../hullPreview2d';
import { HangarLitView } from '../HangarLitView';
import { drawDecor2d } from '../partDecor';
import { drawPlacedMarks, drawHandMarks, drawHoverCover } from './hangarMarks';
import type { HangarHost } from './host';

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - 5 * Math.cos(a - 0.4), y1 - 5 * Math.sin(a - 0.4));
  ctx.lineTo(x1 - 5 * Math.cos(a + 0.4), y1 - 5 * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
}

export function draw(host: HangarHost): void {
  if (!host.isOpen) return;
  const c = host.canvas;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const { px, cx, cy } = host.view;
  host.lit.setView(px, cx, cy, w, h);
  // The grid layer: background, grid lines, turret arcs (under the ship)
  const gc = host.grid;
  if (gc.width !== w * dpr || gc.height !== h * dpr) { gc.width = w * dpr; gc.height = h * dpr; }
  let ctx = gc.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, w, h);
  const sx = (x: number) => (x - cx) * px + w / 2;
  const sy = (y: number) => (y - cy) * px + h / 2;

  // Grid
  ctx.lineWidth = 1;
  for (let gx = Math.floor(cx - w / 2 / px); gx <= cx + w / 2 / px; gx++) {
    ctx.strokeStyle = gx === 0 ? '#22314f' : '#121b2e';
    ctx.beginPath(); ctx.moveTo(sx(gx), 0); ctx.lineTo(sx(gx), h); ctx.stroke();
  }
  for (let gy = Math.floor(cy - h / 2 / px); gy <= cy + h / 2 / px; gy++) {
    ctx.strokeStyle = gy === 0 ? '#22314f' : '#121b2e';
    ctx.beginPath(); ctx.moveTo(0, sy(gy)); ctx.lineTo(w, sy(gy)); ctx.stroke();
  }
  ctx.fillStyle = '#3b4c6e';
  ctx.font = '11px sans-serif';
  ctx.fillText('▲ forward', sx(cx) - 26, 16);

  const path = (poly: Vec2[]) => {
    ctx.beginPath();
    poly.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
    ctx.closePath();
  };
  const bad = new Set(host.errors.flatMap((e) => e.uids));

  // Turret windows sit under the parts so the hull stays readable
  if (host.derived && host.overlays.arcs) {
    for (const w of host.derived.weapons) if (w.window) host.drawWindow(w.window, sx, sy, 1, ctx);
  }
  // The marks layer (over the ship)
  ctx = host.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Parts (ghosts: not built yet, drawn faint and dashed; new since the last save: dashed amber)
  const { ghosts, fresh } = host.grantAll ? { ghosts: new Set<number>(), fresh: new Set<number>() } : host.ghostInfo();
  const wrecked = new Set(host.deps.hangarState()?.slots[host.slot]?.wrecked ?? []);
  host.geoms.forEach((g) => {
    const p = g.part;
    const ghost = ghosts.has(p.uid) && !fresh.has(p.uid);
    const isNew = fresh.has(p.uid) && host.deps.hangarState() !== null;
    path(g.polygon);
    const look = partColors(host.deps.catalog, p.fn, p.material, host.bp.paint ? parseInt(host.bp.paint.slice(1), 16) : undefined);
    // Built parts are drawn lit, as in flight (HangarLitView); a ghost (not built yet) is a faint flat shape
    if (ghost) {
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = numToCss(look.fill);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // Its outline only when it says something: a problem, new since the last save, or a ghost
    if (ghost || isNew || bad.has(p.uid)) {
      ctx.setLineDash(ghost || isNew ? [5, 4] : []);
      ctx.strokeStyle = bad.has(p.uid) ? '#ef4444' : isNew ? '#fbbf24' : '#7dd3fc';
      ctx.lineWidth = bad.has(p.uid) || isNew ? 2 : 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Guns' barrels (the hull draws the rest of its hardware); a ghost's all of it, faint
    drawDecor2d(ctx, g, (x, y) => [sx(x), sy(y)], px, ghost ? 0.35 : 1, gradeGlow(look.grade), !ghost);
  });
  drawPlacedMarks(host, sx, sy);
  // Guns that break their mounting rules (a ship fitted before a rule changed), engines with a blocked exhaust: what's wrong, in red
  host.geoms.forEach((g, i) => {
    const broken = host.mountingBroken.get(i);
    if (broken) host.drawMounting(g, broken, sx, sy, false);
  });
  drawHangarGroups(ctx, host.bp, host.geoms, host.derived, sx, sy, px);

  const d = host.derived;
  if (host.overlays.connectors) {
    ctx.strokeStyle = numToCss(CONNECTOR_COLOR);
    ctx.lineWidth = 2;
    for (const g of host.geoms) {
      for (const con of g.connectors) {
        const [a, b] = connectorEndpoints(con);
        ctx.setLineDash('diag' in con ? [4, 3] : []);
        // Pull edges slightly inside the part so both sides of a join stay visible
        const k = 0.08;
        const mx = g.centroid[0], my = g.centroid[1];
        ctx.beginPath();
        ctx.moveTo(sx(a[0] + (mx - a[0]) * k), sy(a[1] + (my - a[1]) * k));
        ctx.lineTo(sx(b[0] + (mx - b[0]) * k), sy(b[1] + (my - b[1]) * k));
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }
  if (host.overlays.joins) {
    ctx.strokeStyle = '#e5ecf7';
    ctx.lineWidth = 1;
    for (const [a, b] of computeJoins(host.geoms)) {
      const A = host.geoms[a].centroid, B = host.geoms[b].centroid;
      ctx.beginPath(); ctx.moveTo(sx(A[0]), sy(A[1])); ctx.lineTo(sx(B[0]), sy(B[1])); ctx.stroke();
      ctx.fillStyle = '#e5ecf7';
      ctx.beginPath(); ctx.arc(sx((A[0] + B[0]) / 2), sy((A[1] + B[1]) / 2), 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  // Power: generators, batteries and what lacks power, each network its own colour
  if (d && !d.ports && host.overlays.power) host.drawPower(d, sx, sy);
  // Energy (a ports design): ports, links with their flow, stores' fill, what the load test left short (portsGrid.ts)
  if (d?.ports && host.overlays.energy) host.ports.draw(ctx, d, host.geoms, { px, cx, cy, w, h, dpr });
  if (d && host.overlays.thrust) {
    ctx.strokeStyle = '#7dd3fc';
    ctx.fillStyle = '#7dd3fc';
    ctx.lineWidth = 1.25;
    ctx.globalAlpha = 0.4;
    for (const t of d.thrusters) {
      const [x0, y0] = t.pos;
      const x1 = x0 + t.force[0] * 0.6, y1 = y0 + t.force[1] * 0.6;
      arrow(ctx, sx(x0), sy(y0), sx(x1), sy(y1));
    }
    ctx.globalAlpha = 1;
  }
if (d && host.overlays.com && d.mass > 0) {
    const X = sx(d.com[0]), Y = sy(d.com[1]);
    ctx.strokeStyle = '#f472b6';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X, Y, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X - 11, Y); ctx.lineTo(X + 11, Y); ctx.moveTo(X, Y - 11); ctx.lineTo(X, Y + 11); ctx.stroke();
  }

  drawHoverCover(host, sx, sy);
  // Ghost
  if (host.mouse && !host.ports.hovering) {
    const cand = host.candidate(host.mouse);
    if (cand) {
      const g = placeGeometry(host.deps.catalog, cand);
      const problem = host.placementProblem(cand);
      path(g.polygon);
      ctx.fillStyle = problem ? 'rgba(239, 68, 68, 0.35)' : 'rgba(95, 212, 196, 0.35)';
      ctx.fill();
      ctx.strokeStyle = problem ? '#ef4444' : '#5fd4c4';
      ctx.lineWidth = 2;
      ctx.stroke();
      drawHandMarks(host, cand, g, sx, sy, !!problem);
      // Its mounting rules: the edge it bolts on at, the cells its barrel needs clear
      if (cand.facing) host.drawMounting(g, host.candidateMounting(cand, g), sx, sy, true);
      if (cand.facing && host.overlays.arcs && weaponMount(host.deps.catalog, cand) === 'turret') {
        // Preview where the new turret could fire (its own arc), given everything already placed
        const all = [...host.geoms, g];
        const arc = mountingOf(host.deps.catalog, cand.fn, host.deps.tuning)?.arc;
        host.drawWindow(computeTurretWindow(all, all.map(() => true), all.length - 1, cand.facing, host.deps.tuning, arc), sx, sy, problem ? 0.4 : 0.8);
      }
      // Its ports, turned and flipped as it would go, and the parts they would link to (portsGrid.ts)
      if (!d || d.ports) host.ports.drawGhost(ctx, d, host.geoms, cand, g, host.deps.catalog, { px, cx, cy, w, h, dpr }, !problem, (i) => host.partName(i));
      if (problem) {
        ctx.fillStyle = '#fca5a5';
        ctx.font = '12px sans-serif';
        ctx.fillText(problem, sx(g.bbox.maxX) + 6, sy(g.bbox.minY) + 12);
      } else host.drawFeedPreview(cand, g, sx, sy);
    }
  }
}
