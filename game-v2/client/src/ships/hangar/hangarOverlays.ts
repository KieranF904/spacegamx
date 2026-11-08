/**
 * @contract client.hangar.overlays
 * owns:       the hangar grid's canvas marks: turret windows, power and bank overlay, mounting rules, facing arrows, feed preview
 * needs:      HangarHost (geoms, derived, view, ctx, deps)
 * invariants: marks only draw, never change the design — none pinned
 * extend:     a new grid mark is one function here, called from hangarDraw.ts draw()
 */

import { isWeaponFn, PlacedPart, PlacedGeom, Side, ShipDerived, SIDE_NORMAL, facingEdges, createShipState, TurretWindow, mountingOf, weaponSides, clearCells, type MountingProblem } from '@space-game/common';
import { bankKind, BROWNOUT } from '@space-game/common';
import { DEAD_NET } from '../wireEdit';
import type { HangarHost } from './host';

/**
 * What a bank part in hand would feed (rework 2026-11 §2.4): the design with it added, run through the same power
 * layout. A Capacitor's bank (with the ones it joins) feeds guns, a Drive Cell's engines and strafers, a Pulse Dynamo
 * charges the banks it touches. Cached per candidate
 */
export function feedPreview(host: HangarHost, cand: PlacedPart): { feeds: number[]; hint: string } | null {
  const { catalog, tuning } = host.deps, fn = catalog.functions.get(cand.fn);
  if (!fn) return null;
  const kind = bankKind(fn), dynamo = (fn.dynamo ?? 0) > 0;
  if (!kind && !dynamo) return null;
  const key = JSON.stringify(cand);
  if (key === host.feedPreviewKey && host.derived === host.feedPreviewFor) return host.feedPreviewVal;
  host.feedPreviewKey = key;
  host.feedPreviewFor = host.derived;
  host.feedPreviewVal = null;
  try {
    const L = createShipState(catalog, tuning, 0, { ...host.bp, parts: [...host.bp.parts, cand] }, 0).derived.power;
    const at = host.bp.parts.length;
    if (!L) return null;
    const feeds = new Set<number>();
    if (kind) { const B = L.banks[L.bankOf[at]]; if (B) { for (const j of B.feeds) feeds.add(j); for (const j of B.shields) feeds.add(j); } }
    else for (const B of L.banks) if (B.dynamos.includes(at)) for (const i of B.parts) feeds.add(i);
    host.feedPreviewVal = {
      feeds: [...feeds].filter((j) => j < at),
      hint: kind === 'drive' ? 'feeds nothing: it must touch an engine or strafer' : kind === 'cap' ? 'feeds nothing: it must touch a gun, beam, miner or Flash Screen' : 'feeds nothing: it must touch a Capacitor or Drive Cell',
    };
  } catch { /* (a candidate the rebuild refuses: no preview) */ }
  return host.feedPreviewVal;
}

/** Cyan glow on the parts the part in hand would feed, or a grey "feeds nothing" tag */
export function drawFeedPreview(host: HangarHost, cand: PlacedPart, g: PlacedGeom, sx: (x: number) => number, sy: (y: number) => number): void {
  const pv = host.feedPreview(cand), ctx = host.ctx;
  if (!pv) return;
  if (!pv.feeds.length) {
    const fs = 11;
    ctx.font = `600 ${fs}px 'Segoe UI', sans-serif`;
    const tw = ctx.measureText(pv.hint).width + 10, bx = sx(g.bbox.minX), by = sy(g.bbox.maxY) + 18;
    ctx.fillStyle = 'rgba(30, 36, 48, 0.9)'; ctx.fillRect(bx, by - 12, tw, 17);
    ctx.fillStyle = '#9aa7bb'; ctx.fillText(pv.hint, bx + 5, by);
    return;
  }
  for (const j of pv.feeds) {
    const q = host.geoms[j];
    if (!q) continue;
    ctx.beginPath();
    q.polygon.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
    ctx.closePath();
    ctx.fillStyle = 'rgba(34, 211, 238, 0.28)'; ctx.fill();
    ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2.5; ctx.stroke();
  }
}

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
 * The power overlay: generators ringed and batteries barred in their
 * network's colour; what's left without power outlined red (short of it,
 * amber). No wires: they're retired, and not drawn.
 */
export function drawPower(host: HangarHost, d: ShipDerived, sx: (x: number) => number, sy: (y: number) => number): void {
  const ctx = host.ctx, px = host.view.px, rep = host.power;
  if (!rep) return;
  // Parts: what makes and stores power, in its network's colour; what lacks it
  const ring = Math.max(4, px * 0.26);
  host.geoms.forEach((g, i) => {
    const fn = host.deps.catalog.functions.get(g.part.fn);
    if (!fn) return;
    const net = rep.nets[d.network[i]], col = net?.color ?? DEAD_NET;
    const cx = sx(g.centroid[0]), cy = sy(g.centroid[1]);
    const st = rep.part[i];
    if (st === 'unpowered' || st === 'stranded' || st === 'short') {
      ctx.beginPath();
      g.polygon.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
      ctx.closePath();
      ctx.fillStyle = st === 'short' ? 'rgba(251, 191, 36, 0.12)' : 'rgba(239, 68, 68, 0.18)';
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = st === 'short' ? '#fbbf24' : '#ef4444';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      // (a struck-through bolt: no power)
      if (st !== 'short') {
        ctx.fillStyle = '#fca5a5';
        ctx.font = `700 ${Math.max(10, Math.round(px * 0.42))}px 'Segoe UI', sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('⚡', cx, cy);
        ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx - ring * 0.7, cy + ring * 0.7); ctx.lineTo(cx + ring * 0.7, cy - ring * 0.7); ctx.stroke();
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
      }
    }
    if ((fn.produce ?? 0) > 0) {
      ctx.strokeStyle = 'rgba(3, 5, 10, 0.8)'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(cx, cy, ring, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy, ring, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(cx - ring * 0.5, cy - 1.5, ring, 3); ctx.fillRect(cx - 1.5, cy - ring * 0.5, 3, ring);
    } else if ((fn.store ?? 0) > 0) {
      const bw = ring * 1.5, bh = ring * 0.9;
      ctx.fillStyle = 'rgba(3, 5, 10, 0.75)';
      ctx.fillRect(cx - bw / 2 - 2, cy - bh / 2 - 2, bw + 4, bh + 4);
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.strokeRect(cx - bw / 2, cy - bh / 2, bw, bh);
      ctx.fillStyle = col;
      ctx.fillRect(cx + bw / 2, cy - bh * 0.2, 3, bh * 0.4);
      ctx.fillRect(cx - bw / 2 + 3, cy - bh / 2 + 3, (bw - 6) * (net?.powered ? 0.7 : 0.15), bh - 6);
    }
  });
  host.drawBanks(d, sx, sy, ring);
}

/**
 * The banks on the overlay (circuits.ts): each bank's members outlined (amber Capacitors, blue Drive Cells; grey one that
 * never refills), a short strap to each part it feeds, and its number; after a load test, each part that browned out with
 * its share
 */
export function drawBanks(host: HangarHost, d: ShipDerived, sx: (x: number) => number, sy: (y: number) => number, ring: number): void {
  const ctx = host.ctx, L = d.power;
  if (!L) return;
  const outline = (i: number, color: string, dash: number[]) => {
    const g = host.geoms[i];
    if (!g) return;
    ctx.beginPath();
    g.polygon.forEach(([x, y], k) => (k ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
    ctx.closePath();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const font = Math.max(10, Math.round(ring * 1.2));
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  L.banks.forEach((B, k) => {
    const col = !B.refills && B.dynamo <= 0 ? '#94a3b8' : B.kind === 'drive' ? '#60a5fa' : '#fbbf24';
    for (const i of B.parts) outline(i, col, []);
    // (A glowing strap to every part it feeds, and a bolt on that part)
    for (let n = 0, nn = B.feeds.length + B.shields.length; n < nn; n++) {
      const j = n < B.feeds.length ? B.feeds[n] : B.shields[n - B.feeds.length];
      const q = host.geoms[j];
      if (!q) continue;
      let from = host.geoms[B.parts[0]], best = Infinity;
      for (const i of B.parts) { const g = host.geoms[i]; if (!g) continue; const dd = Math.hypot(g.centroid[0] - q.centroid[0], g.centroid[1] - q.centroid[1]); if (dd < best) { best = dd; from = g; } }
      if (!from) continue;
      ctx.lineCap = 'round';
      ctx.strokeStyle = col; ctx.globalAlpha = 0.28; ctx.lineWidth = 8;
      ctx.beginPath(); ctx.moveTo(sx(from.centroid[0]), sy(from.centroid[1])); ctx.lineTo(sx(q.centroid[0]), sy(q.centroid[1])); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(sx(from.centroid[0]), sy(from.centroid[1])); ctx.lineTo(sx(q.centroid[0]), sy(q.centroid[1])); ctx.stroke();
      ctx.lineCap = 'butt';
      host.boltGlyph(sx(q.centroid[0]) + ring * 0.85, sy(q.centroid[1]) - ring * 0.85, ring * 0.55, col);
    }
    // (Its label: "Bank 1 · holds 320 · gives 4,000/s", at its first member)
    const at = host.geoms[B.parts[0]];
    if (at) {
      const n0 = (v: number) => Math.round(v).toLocaleString();
      const text = `Bank ${k + 1} · holds ${n0(B.cap)} · gives ${n0(B.rate)}/s${!B.refills && B.dynamo <= 0 ? ' · never refills' : ''}`;
      const fs = Math.max(10, Math.round(font * 0.8));
      ctx.font = `700 ${fs}px 'Segoe UI', sans-serif`;
      const tw = ctx.measureText(text).width + 10, bx = sx(at.centroid[0]), by = sy(at.centroid[1]) - ring * 1.7 - k * 0;
      ctx.fillStyle = 'rgba(3, 5, 10, 0.85)'; ctx.fillRect(bx - tw / 2, by - fs * 0.7, tw, fs * 1.4);
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(bx - tw / 2, by - fs * 0.7, tw, fs * 1.4);
      ctx.fillStyle = col; ctx.fillText(text, bx, by + 0.5);
    }
  });
  // The load test: what browned out, by how much
  const lt = host.overlays.power ? host.bothTest() : null;
  if (lt) {
    lt.part.forEach((v, i) => {
      if (v >= BROWNOUT || !host.geoms[i]) return;
      outline(i, v < 0.5 ? '#ef4444' : '#fb923c', []);
      const g = host.geoms[i];
      ctx.font = `700 ${Math.max(9, Math.round(font * 0.75))}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = 'rgba(3, 5, 10, 0.75)';
      const tx = sx(g.centroid[0]), ty = sy(g.centroid[1]) + ring * 1.1;
      ctx.fillRect(tx - font * 1.1, ty - font * 0.45, font * 2.2, font * 0.9);
      ctx.fillStyle = v < 0.5 ? '#fca5a5' : '#fdba74';
      ctx.fillText(`${Math.round(v * 100)}%`, tx, ty);
    });
  }
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}

/** A small lightning bolt (fed parts, the power view) */
export function boltGlyph(host: HangarHost, cx: number, cy: number, r: number, color: string): void {
  const ctx = host.ctx;
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.25, cy - r); ctx.lineTo(cx - r * 0.55, cy + r * 0.1); ctx.lineTo(cx - r * 0.05, cy + r * 0.1);
  ctx.lineTo(cx - r * 0.25, cy + r); ctx.lineTo(cx + r * 0.55, cy - r * 0.2); ctx.lineTo(cx + r * 0.05, cy - r * 0.2);
  ctx.closePath();
  ctx.fillStyle = color; ctx.strokeStyle = 'rgba(3, 5, 10, 0.9)'; ctx.lineWidth = 1;
  ctx.fill(); ctx.stroke();
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
