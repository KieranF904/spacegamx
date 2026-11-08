/**
 * @contract client.systemMap.marks
 * owns:       labels (queued, placed so they make way for each other), your ship's marker and the jump drive's reach
 * needs:      MapHost (labelQueue, state, jump, jumpAim)
 * invariants: label priority decides who keeps a spot — none pinned
 * extend:     a new kind of mark is one function here
 */

import type { MapHost } from './host';
import { HAZARD_RULES, JUMP, LANDING_HOSTILE_RADIUS, fmtDist } from './mapConsts';

/** The jump drive: its reach round you, and while lining up, where you'd land (red if that's somewhere bad) */
export function drawJump(host: MapHost, ctx: CanvasRenderingContext2D, me: { renderX: number; renderY: number }, sx: (x: number) => number, sy: (y: number) => number, S: number, time: number): void {
  const j = host.jump?.();
  if (!j || j.reach <= 0) return;
  const x = sx(me.renderX), y = sy(me.renderY);
  const ready = j.phase === 'ready' || j.phase === 'charging';
  const ring = j.reach * S;
  ctx.save();
  ctx.strokeStyle = ready ? `rgba(103, 232, 249, ${j.aiming ? 0.75 : 0.4})` : 'rgba(148, 163, 184, 0.25)';
  ctx.lineWidth = j.aiming ? 1.6 : 1.2;
  ctx.setLineDash([8, 6]);
  ctx.lineDashOffset = -time * 8;
  ctx.beginPath(); ctx.arc(x, y, ring, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  if (ring > 40) host.label(ctx, ready ? `JUMP RANGE ${fmtDist(j.reach)}` : 'JUMP DRIVE COOLING', x, y - ring - 6, ready ? '#a5f3fc' : '#94a3b8', 2, y - ring);
  const aim = host.jumpAim;
  if (!j.aiming || !aim) return;
  const d = Math.min(aim.dist, j.reach);
  const lx = me.renderX + Math.cos(aim.angle) * d, ly = me.renderY + Math.sin(aim.angle) * d;
  const danger = host.landingDanger(lx, ly);
  const col = danger ? '#f87171' : '#67e8f9';
  const px = sx(lx), py = sy(ly);
  ctx.save();
  ctx.strokeStyle = col;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 1.6;
  ctx.setLineDash([4, 5]);
  ctx.lineDashOffset = -time * 30;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(px, py); ctx.stroke();
  ctx.setLineDash([]);
  // The landing reticle
  const pulse = 0.5 + 0.5 * Math.sin(time * (j.phase === 'charging' ? 9 : 4));
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(px, py, 8 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    ctx.beginPath(); ctx.moveTo(px + Math.cos(a) * 5, py + Math.sin(a) * 5); ctx.lineTo(px + Math.cos(a) * 15, py + Math.sin(a) * 15); ctx.stroke();
  }
  ctx.restore();
  const what = aim.label ? `→ ${aim.label}` : `jump ${fmtDist(d)}`;
  host.label(ctx, danger ? `${what} · ⚠ ${danger}` : what, px, py - 20, danger ? '#fca5a5' : '#cffafe', 10, py);
}

/** What's wrong with landing a jump here (null: nothing): a star's or black hole's hazard margin, the horizon, hostiles close by */
export function landingDanger(host: MapHost, x: number, y: number): string | null {
  const sys = host.byId.get(host.state.systemId);
  const cb = host.central() ?? { type: 'sun' };
  const d = Math.hypot(x, y);
  if (!sys?.surface) {
    const r = cb.radius ?? sys?.starRadius ?? 0;
    const near = cb.type === 'black_hole' ? HAZARD_RULES.nearBlackHole : cb.type === 'none' ? undefined : HAZARD_RULES.nearStar;
    const horizon = ((sys?.centralBody as any)?.gravity as { horizon?: number } | undefined)?.horizon ?? 0;
    if (horizon && d < horizon) return 'inside the horizon';
    if (near && r > 0 && d < (near.margin !== undefined ? r + near.margin : (near.radii ?? 0) * r)) return cb.type === 'black_hole' ? 'in the well' : 'too close to the star';
  }
  let n = 0;
  for (const e of host.mapShips()) {
    if (e.data?.[0] !== 3 || e.data?.[9] === 1) continue;
    if (Math.hypot(e.renderX - x, e.renderY - y) < LANDING_HOSTILE_RADIUS) n++;
  }
  return n ? `${n} hostile${n > 1 ? 's' : ''} close by` : null;
}

export function drawYou(host: MapHost, ctx: CanvasRenderingContext2D, me: { renderAngle: number; vx: number; vy: number; renderX: number; renderY: number }, x: number, y: number, time: number, w: number, h: number): void {
  const m = 26;
  if (x < m || y < m || x > w - m || y > h - m) {
    // Off the map: an arrow on the edge pointing at you, with the distance from the view centre
    const cx = w / 2, cy = h / 2, dx = x - cx, dy = y - cy;
    const k = Math.min((cx - m) / Math.max(1e-6, Math.abs(dx)), (cy - m - 30) / Math.max(1e-6, Math.abs(dy)));
    const ex = cx + dx * k, ey = cy + dy * k;
    const cam = host.cam();
    const dist = Math.hypot(me.renderX - cam.x, me.renderY - cam.y);
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.fillStyle = '#4ade80';
    ctx.shadowColor = 'rgba(74, 222, 128, 0.9)';
    ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, 10); ctx.lineTo(-3, 0); ctx.lineTo(-8, -10); ctx.closePath(); ctx.fill();
    ctx.restore();
    host.label(ctx, `YOU · ${fmtDist(dist)} · press C`, ex - Math.sign(dx) * 40, ey + (dy > 0 ? -16 : 22), '#86efac');
    return;
  }
  // Sweeping pulse rings
  for (let k = 0; k < 2; k++) {
    const p = (time * 0.7 + k * 0.5) % 1;
    ctx.strokeStyle = `rgba(74, 222, 128, ${0.7 * (1 - p)})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 10 + p * 34, 0, Math.PI * 2); ctx.stroke();
  }
  // Crosshair brackets
  ctx.strokeStyle = 'rgba(134, 239, 172, 0.9)';
  ctx.lineWidth = 2;
  const r = 18, b = 6;
  for (const [sxn, syn] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ctx.beginPath();
    ctx.moveTo(x + sxn * r, y + syn * (r - b)); ctx.lineTo(x + sxn * r, y + syn * r); ctx.lineTo(x + sxn * (r - b), y + syn * r);
    ctx.stroke();
  }
  // Velocity line, then the ship arrow with a dark outline so it reads on anything
  const sp = Math.hypot(me.vx, me.vy);
  if (sp > 0.2) {
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.75)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (me.vx / sp) * Math.min(80, 20 + sp * 4), y + (me.vy / sp) * Math.min(80, 20 + sp * 4)); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(me.renderAngle);
  ctx.shadowColor = 'rgba(74, 222, 128, 0.9)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#4ade80';
  ctx.strokeStyle = '#03140a';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(13, 0); ctx.lineTo(-9, 9); ctx.lineTo(-4, 0); ctx.lineTo(-9, -9); ctx.closePath();
  ctx.stroke(); ctx.fill();
  ctx.restore();
  ctx.font = '700 12px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(3, 20, 10, 0.75)';
  const tw = ctx.measureText('YOU').width + 12;
  ctx.fillRect(x - tw / 2, y - 44, tw, 17);
  ctx.fillStyle = '#86efac';
  ctx.fillText('YOU', x, y - 31);
}

/**
 * A name by a marker at height `my`. In the system view it's queued: the
 * more important names are placed first, a name that would overlap one
 * already placed tries the other side of its marker, and if that's taken
 * too it's left out (hovering the marker still names it in the tooltip).
 */
export function label(host: MapHost, ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, pri = 5, my = y): void {
  if (host.labelQueue) { host.labelQueue.push({ text, x, y, color, pri, my }); return; }
  host.drawLabel(ctx, text, x, y, color);
}

export function placeLabels(host: MapHost, ctx: CanvasRenderingContext2D, you: { x: number; y: number } | null): void {
  const queue = host.labelQueue ?? [];
  host.labelQueue = null;
  ctx.font = '600 11px "Segoe UI", sans-serif';
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  // Your beacon and its YOU tag stay clear
  if (you) placed.push({ x0: you.x - 24, y0: you.y - 46, x1: you.x + 24, y1: you.y + 20 });
  const hover = host.hover;
  queue.sort((a, b) => b.pri - a.pri);
  for (const l of queue) {
    let w = host.labelWidths.get(l.text);
    if (w === undefined) { w = ctx.measureText(l.text).width; host.labelWidths.set(l.text, w); }
    const hovered = !!hover && Math.abs(hover.sx - l.x) < 1 && Math.abs(hover.sy - l.my) < 1;
    // Its usual spot, then mirrored to the other side of the marker
    for (const y of [l.y, 2 * l.my - l.y + 7]) {
      const box = { x0: l.x - w / 2 - 3, y0: y - 11, x1: l.x + w / 2 + 3, y1: y + 3 };
      if (!hovered && placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) continue;
      placed.push(box);
      host.drawLabel(ctx, l.text, l.x, y, l.color);
      break;
    }
  }
}

export function drawLabel(host: MapHost, ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.font = '600 11px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(2, 4, 12, 0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
