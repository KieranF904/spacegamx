/**
 * @contract client.hangar.overlays
 * owns:       the hangar grid's canvas marks: turret windows, mounting rules, facing arrows
 * needs:      HangarHost (geoms, derived, view, ctx, deps); npm: @space-game/common
 * invariants: marks only draw, never change the design — client/src/ships/hangar/marksPure.test.ts
 * extend:     a new grid mark is one function here, called from hangarDraw.ts draw()
 */

import { isWeaponFn, PlacedGeom, Side, SIDE_NORMAL, facingEdges, TurretWindow, mountingOf, weaponSides, clearCells, type MountingProblem } from '@space-game/common';
import type { HangarHost } from './host';

/** Turret window as wedges: open sectors green, sectors its own hull blocks red. */
export function drawWindow(host: HangarHost, w: TurretWindow, sx: (x: number) => number, sy: (y: number) => number, alpha: number, ctx = host.ctx): void {
  const r = 2.0 * host.view.px;
  const X = sx(w.pivot[0]), Y = sy(w.pivot[1]);
  const wedge = (lo: number, hi: number, fill: string) => {
    ctx.beginPath();
    ctx.moveTo(X, Y);
    ctx.arc(X, Y, r, w.center + lo, w.center + hi);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  ctx.globalAlpha = alpha;
  wedge(-w.half, w.half, 'rgba(239, 68, 68, 0.16)');
  for (const [lo, hi] of w.open) wedge(lo, hi, 'rgba(74, 222, 128, 0.28)');
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.8)';
  ctx.lineWidth = 1;
  for (const [lo, hi] of w.open) {
    for (const a of [lo, hi]) {
      ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X + Math.cos(w.center + a) * r, Y + Math.sin(w.center + a) * r); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * A gun's mounting rules on the grid: the edge it bolts on at (green when it does, red when it must and doesn't) and
 * the cells its barrel needs clear (shaded; red where something's in the way). `all`: everything (the part in hand);
 * else only what's broken.
 */
export function drawMounting(host: HangarHost, g: PlacedGeom, broken: MountingProblem[], sx: (x: number) => number, sy: (y: number) => number, all: boolean): void {
  const { catalog } = host.deps, ctx = host.ctx, px = host.view.px;
  // An engine's blocked exhaust: the first cell in the way on each blocked lane, in red
  for (const [x, y] of broken.find((b) => b.rule === 'exhaust')?.cells ?? []) {
    ctx.fillStyle = 'rgba(248, 113, 113, 0.35)';
    ctx.fillRect(sx(x) + 2, sy(y) + 2, px - 4, px - 4);
    ctx.strokeStyle = '#f87171';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(sx(x) + 2, sy(y) + 2, px - 4, px - 4);
    ctx.setLineDash([]);
  }
  const m = mountingOf(catalog, g.part.fn, undefined, g.part.mount);
  const sides = weaponSides(catalog, g.part);
  if (!m || !sides) return;
  const attachBad = broken.some((b) => b.rule === 'attach' || b.rule === 'angle');
  if ((all && m.rules) || attachBad) {
    const n = SIDE_NORMAL[sides.attach];
    ctx.strokeStyle = attachBad ? '#f87171' : m.attach === 'back' ? '#4ade80' : 'rgba(74, 222, 128, 0.45)';
    ctx.lineWidth = Math.max(3, px * 0.12);
    ctx.lineCap = 'round';
    const edges = facingEdges(g, sides.attach);
    for (const [a, b] of edges) {
      // (Just inside the part, so the hull it bolts to stays visible)
      const ix = -n[0] * 0.08, iy = -n[1] * 0.08;
      ctx.beginPath(); ctx.moveTo(sx(a[0] + ix), sy(a[1] + iy)); ctx.lineTo(sx(b[0] + ix), sy(b[1] + iy)); ctx.stroke();
    }
    // No straight edge there at all: a red ring where it would be
    if (!edges.length && attachBad) {
      const c = g.centroid;
      ctx.beginPath(); ctx.arc(sx(c[0] + n[0] * 0.45), sy(c[1] + n[1] * 0.45), 4, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }
  const blocked = new Set((broken.find((b) => b.rule === 'clear')?.cells ?? []).map((c) => `${c[0]},${c[1]}`));
  if (all || blocked.size) {
    for (const [x, y] of clearCells(catalog, g)) {
      const bad = blocked.has(`${x},${y}`);
      if (!all && !bad) continue;
      ctx.fillStyle = bad ? 'rgba(248, 113, 113, 0.35)' : 'rgba(253, 224, 71, 0.13)';
      ctx.fillRect(sx(x) + 2, sy(y) + 2, px - 4, px - 4);
      ctx.strokeStyle = bad ? '#f87171' : 'rgba(253, 224, 71, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(sx(x) + 2, sy(y) + 2, px - 4, px - 4);
      ctx.setLineDash([]);
    }
  }
}

export function drawFacing(host: HangarHost, g: PlacedGeom, side: Side, sx: (x: number) => number, sy: (y: number) => number): void {
  const ctx = host.ctx;
  const n = SIDE_NORMAL[side];
  ctx.fillStyle = isWeaponFn(g.part.fn) ? '#ffb4a8' : '#9fd0ff';
  for (const [a, b] of facingEdges(g, side)) {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const tx = -n[1] * 0.25, ty = n[0] * 0.25;
    ctx.beginPath();
    ctx.moveTo(sx(mx + tx), sy(my + ty));
    ctx.lineTo(sx(mx - tx), sy(my - ty));
    ctx.lineTo(sx(mx + n[0] * 0.35), sy(my + n[1] * 0.35));
    ctx.closePath();
    ctx.fill();
  }
}
