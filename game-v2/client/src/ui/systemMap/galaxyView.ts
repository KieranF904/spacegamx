/**
 * @contract client.systemMap.galaxyView
 * owns:       the galaxy view and the central-body glyph: systems, links, sectors, your pin
 * needs:      MapHost (systems, byId, hits, state), mapConsts
 * invariants: one hit per system, pushed as it is drawn — none pinned
 * extend:     a new galaxy mark is one block in drawGalaxy
 */

import { StarSystemData, threatLevel } from '@space-game/common';
import { THREAT_COLOR } from '../threat';
import type { MapHost } from './host';
import { dangerColor, hexToHue, niceStep } from './mapConsts';
import type { Camera } from './types';

export function drawGalaxy(host: MapHost, ctx: CanvasRenderingContext2D, sx: (x: number) => number, sy: (y: number) => number, cam: Camera, time: number): void {
  const S = cam.scale;

  // Grid
  const step = niceStep(140 / S);
  ctx.strokeStyle = 'rgba(80, 110, 170, 0.08)';
  ctx.lineWidth = 1;
  const w = host.canvas.clientWidth, h = host.canvas.clientHeight;
  const x0 = Math.floor((cam.x - w / 2 / S) / step) * step, y0 = Math.floor((cam.y - h / 2 / S) / step) * step;
  for (let x = x0; x < cam.x + w / 2 / S; x += step) { ctx.beginPath(); ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), h); ctx.stroke(); }
  for (let y = y0; y < cam.y + h / 2 / S; y += step) { ctx.beginPath(); ctx.moveTo(0, sy(y)); ctx.lineTo(w, sy(y)); ctx.stroke(); }

  // Sector regions: a soft glow around each member system, the name over the group
  const sectors = new Map<string, StarSystemData[]>();
  for (const s of host.systems) sectors.set(s.sector ?? '', [...(sectors.get(s.sector ?? '') ?? []), s]);
  for (const [sector, list] of sectors) {
    const color = host.sectorColor.get(sector)!;
    for (const s of list) {
      const r = Math.max(70, 30000 * S);
      const g = ctx.createRadialGradient(sx(s.position.x), sy(s.position.y), 0, sx(s.position.x), sy(s.position.y), r);
      g.addColorStop(0, color + '30');
      g.addColorStop(1, color + '00');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx(s.position.x), sy(s.position.y), r, 0, Math.PI * 2); ctx.fill();
    }
    if (sector) {
      const cx = list.reduce((a, s) => a + s.position.x, 0) / list.length;
      const top = Math.min(...list.map((s) => s.position.y));
      ctx.fillStyle = color + 'aa';
      ctx.font = '600 12px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(sector.replace(/_/g, ' ').toUpperCase().split('').join(' '), sx(cx), sy(top) - Math.max(60, 26000 * S));
    }
  }

  // Jump-gate links: two-way solid with travelling pulses, one-way dashed with an arrow
  const pairs = new Map<string, { a: StarSystemData; b: StarSystemData; ab: boolean; ba: boolean }>();
  for (const s of host.systems) {
    for (const p of s.portals) {
      const t = host.byId.get(p.targetSystem);
      // (Gates to somewhere off the map, like your own station, aren't links)
      if (!t || t.private || t.surface) continue;
      const [a, b] = s.id < t.id ? [s, t] : [t, s];
      const key = `${a.id}|${b.id}`;
      const e = pairs.get(key) ?? { a, b, ab: false, ba: false };
      if (s === a) e.ab = true; else e.ba = true;
      pairs.set(key, e);
    }
  }
  for (const { a, b, ab, ba } of pairs.values()) {
    const ax = sx(a.position.x), ay = sy(a.position.y), bx = sx(b.position.x), by = sy(b.position.y);
    const two = ab && ba;
    ctx.strokeStyle = two ? 'rgba(140, 190, 255, 0.5)' : 'rgba(140, 190, 255, 0.35)';
    ctx.lineWidth = two ? 1.6 : 1.2;
    ctx.setLineDash(two ? [] : [6, 6]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
    const n = 3;
    for (let k = 0; k < n; k++) {
      const t = ((time * 0.12 + k / n) % 1);
      const [fx, fy, tx, ty] = !two && ba && !ab ? [bx, by, ax, ay] : [ax, ay, bx, by];
      ctx.fillStyle = 'rgba(170, 215, 255, 0.8)';
      ctx.beginPath(); ctx.arc(fx + (tx - fx) * t, fy + (ty - fy) * t, 1.6, 0, Math.PI * 2); ctx.fill();
    }
    if (!two) {
      const [fx, fy, tx, ty] = ab ? [ax, ay, bx, by] : [bx, by, ax, ay];
      const mx = (fx + tx) / 2, my = (fy + ty) / 2, ang = Math.atan2(ty - fy, tx - fx);
      ctx.fillStyle = 'rgba(140, 190, 255, 0.7)';
      ctx.beginPath();
      ctx.moveTo(mx + Math.cos(ang) * 7, my + Math.sin(ang) * 7);
      ctx.lineTo(mx + Math.cos(ang + 2.5) * 6, my + Math.sin(ang + 2.5) * 6);
      ctx.lineTo(mx + Math.cos(ang - 2.5) * 6, my + Math.sin(ang - 2.5) * 6);
      ctx.fill();
    }
  }

  // Rift routes: curved violet dots
  for (const s of host.systems) {
    for (const rift of s.rifts ?? []) {
      const t = host.byId.get(rift.destination.system);
      if (!t || t === s || t.private || t.surface) continue;
      const ax = sx(s.position.x), ay = sy(s.position.y), bx = sx(t.position.x), by = sy(t.position.y);
      const mx = (ax + bx) / 2, my = (ay + by) / 2, len = Math.hypot(bx - ax, by - ay);
      const cx = mx + ((ay - by) / len) * len * 0.22, cy = my + ((bx - ax) / len) * len * 0.22;
      ctx.strokeStyle = 'rgba(200, 120, 255, 0.55)';
      ctx.setLineDash([2, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by); ctx.stroke();
      ctx.setLineDash([]);
      // vortex mark at the bend
      const vx = 0.25 * ax + 0.5 * cx + 0.25 * bx, vy = 0.25 * ay + 0.5 * cy + 0.25 * by;
      ctx.strokeStyle = 'rgba(220, 150, 255, 0.85)';
      ctx.lineWidth = 1.4;
      for (let k = 0; k < 2; k++) {
        ctx.beginPath(); ctx.arc(vx, vy, 4 + k * 3, time * 2 + k * 2, time * 2 + k * 2 + 4.2); ctx.stroke();
      }
    }
  }

  // Systems
  for (const s of host.systems) {
    const x = sx(s.position.x), y = sy(s.position.y);
    const here = s.id === host.state.systemId;
    const hovered = host.hover?.kind === 'system' && host.hover.sys === s;
    host.drawBodyGlyph(ctx, s.centralBody ?? { type: 'sun' }, s.starColor, x, y, 9, time);
    const lock = host.locked?.(s.id) ?? null;
    if (lock) drawPadlock(ctx, x + 13, y - 13);
    if (here) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 3);
      ctx.strokeStyle = `rgba(74, 222, 128, ${0.5 + 0.4 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 18 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
    }
    if (hovered) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 23, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = here ? '#86efac' : lock ? '#9aa6b8' : '#e5ecf7';
    ctx.font = `${here || hovered ? 700 : 600} 13px "Segoe UI", sans-serif`;
    ctx.fillText(s.name, x, y + 34);
    ctx.fillStyle = lock ? 'rgba(251, 191, 36, 0.85)' : 'rgba(160, 180, 210, 0.75)';
    ctx.font = '11px "Segoe UI", sans-serif';
    const info = here ? 'YOU ARE HERE' : lock ? `🔒 ${lock.name} needed` : `${s.stations.length ? `${s.stations.length} station${s.stations.length > 1 ? 's' : ''}` : 'no stations'}${s.hazards.length ? ` · ⚠ ${s.hazards.length}` : ''}`;
    ctx.fillText(info, x, y + 49);
    const d = s.danger ?? 1;
    ctx.fillStyle = dangerColor(d);
    ctx.font = '600 10px "Segoe UI", sans-serif';
    ctx.fillText(`${'●'.repeat(d)}${'○'.repeat(7 - d)}${s.pvp ? '  PVP' : ''}`, x, y + 63);
    // What its hostiles rate, against your ship
    const threat = host.state.threats[s.id];
    if (threat) {
      const mine = host.myRating?.() ?? 0;
      ctx.fillStyle = mine ? THREAT_COLOR[threatLevel(mine, threat)] : 'rgba(160, 180, 210, 0.75)';
      ctx.fillText(`◆ ${threat}`, x, y + 76);
    }
    if (here) host.drawGalaxyPin(ctx, x, y, time);
    host.hits.push({ kind: 'system', sys: s, sx: x, sy: y });
  }
  // Your party: a green pip and name beside each member's system
  const partyByStar = new Map<string, string[]>();
  for (const m of host.party?.() ?? []) if (m.system) partyByStar.set(m.system, [...(partyByStar.get(m.system) ?? []), m.name]);
  for (const [id, names] of partyByStar) {
    const sys = host.byId.get(id);
    if (!sys) continue;
    const x = sx(sys.position.x) + 14, y = sy(sys.position.y) - 14;
    ctx.fillStyle = '#4ade80';
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.font = '600 11px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#bbf7d0';
    ctx.fillText(names.join(', '), x + 7, y + 4);
  }
}

/** Galaxy view: a bobbing pin above your system holding your ship, pointing the way you face */
export function drawGalaxyPin(host: MapHost, ctx: CanvasRenderingContext2D, x: number, y: number, time: number): void {
  const me = host.state.entities.get(host.state.playerId);
  const bob = Math.sin(time * 2.4) * 3;
  const py = y - 46 + bob;
  ctx.save();
  ctx.shadowColor = 'rgba(74, 222, 128, 0.8)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#4ade80';
  ctx.beginPath();
  ctx.arc(x, py, 13, Math.PI * 0.85, Math.PI * 2.15);
  ctx.lineTo(x, py + 22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#062012';
  ctx.beginPath(); ctx.arc(x, py, 9, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.translate(x, py);
  ctx.rotate(me?.renderAngle ?? -Math.PI / 2);
  ctx.fillStyle = '#86efac';
  ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, 4); ctx.lineTo(-2, 0); ctx.lineTo(-4, -4); ctx.closePath(); ctx.fill();
  ctx.restore();
}

/** Central body glyph: sun (glow in its colour), black hole (disk + horizon) or pulsar (sweeping beams). */
export function drawBodyGlyph(host: MapHost, ctx: CanvasRenderingContext2D, cb: { type: string; hue?: number; diskHue?: number; beamHue?: number }, starColor: string | undefined, x: number, y: number, r: number, time: number): void {
  if (cb.type === 'black_hole') {
    const hue = cb.diskHue ?? 30;
    const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 2.6);
    g.addColorStop(0, `hsla(${hue}, 95%, 65%, 0.95)`);
    g.addColorStop(0.45, `hsla(${hue}, 90%, 50%, 0.45)`);
    g.addColorStop(1, `hsla(${hue}, 90%, 40%, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = `hsla(${hue + 20}, 100%, 85%, 0.95)`;
    ctx.lineWidth = Math.max(1.2, r * 0.18);
    ctx.beginPath(); ctx.arc(x, y, r * 0.95, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, Math.PI * 2); ctx.fill();
    return;
  }
  if (cb.type === 'pulsar') {
    const hue = cb.beamHue ?? 190;
    const a = time * 1.4;
    for (const off of [0, Math.PI]) {
      const g = ctx.createLinearGradient(x, y, x + Math.cos(a + off) * r * 4, y + Math.sin(a + off) * r * 4);
      g.addColorStop(0, `hsla(${hue}, 90%, 75%, 0.9)`);
      g.addColorStop(1, `hsla(${hue}, 90%, 75%, 0)`);
      ctx.strokeStyle = g;
      ctx.lineWidth = Math.max(1.5, r * 0.3);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a + off) * r * 4, y + Math.sin(a + off) * r * 4); ctx.stroke();
    }
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.8);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.3, `hsla(${hue}, 90%, 80%, 0.7)`);
    g.addColorStop(1, `hsla(${hue}, 90%, 70%, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 1.8, 0, Math.PI * 2); ctx.fill();
    return;
  }
  if (cb.type === 'brown_dwarf') {
    // A dull banded ball in a faint smoulder
    const hue = cb.hue ?? 14;
    const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 2);
    g.addColorStop(0, `hsla(${hue}, 85%, 40%, 0.5)`);
    g.addColorStop(1, `hsla(${hue}, 85%, 30%, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 2, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
    for (let k = -3; k <= 3; k++) {
      ctx.fillStyle = `hsl(${hue + (k % 2 ? 10 : 0)}, 55%, ${k % 2 ? 36 : 24}%)`;
      ctx.fillRect(x - r, y + (k - 0.5) * (r / 3.5), r * 2, r / 3.5 + 0.5);
    }
    ctx.restore();
    return;
  }
  const hue = cb.hue ?? (starColor ? hexToHue(starColor) : 40);
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.8);
  g.addColorStop(0, `hsla(${hue}, 100%, 92%, 1)`);
  g.addColorStop(0.3, `hsla(${hue}, 95%, 65%, 0.85)`);
  g.addColorStop(0.6, `hsla(${hue}, 90%, 55%, 0.25)`);
  g.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r * 2.8, 0, Math.PI * 2); ctx.fill();
}

/** A small padlock (locked systems on the galaxy map) */
function drawPadlock(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.save();
  ctx.strokeStyle = '#fbbf24';
  ctx.fillStyle = 'rgba(30, 22, 6, 0.9)';
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(x, y - 3, 3.6, Math.PI, 0); ctx.stroke();
  ctx.beginPath(); ctx.rect(x - 5, y - 3, 10, 8); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fbbf24';
  ctx.fillRect(x - 0.8, y, 1.6, 2.6);
  ctx.restore();
}
