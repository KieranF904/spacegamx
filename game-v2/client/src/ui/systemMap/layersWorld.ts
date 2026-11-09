/**
 * @contract client.system-map.layers-world
 * owns:       the system view's fixed scenery layers: rings, danger bands, belts, gravity, central body, zones, planets, structures, lodestones, pockets, nests, comets
 * needs:      MapHost (state, hits, label), MapScene; npm: @space-game/common
 * invariants: layers push hits in draw order, so later ones win ties — none pinned
 * extend:     a new scenery layer is one function here, called from SystemMapUI.drawSystem
 */

import { planetPosition, moonOffset, cometPosition, solarRingRadius } from '@space-game/common';
import { lodestonePosition, lodestoneLabel, lodestoneSize, lodestoneLive, lodestoneFieldRadius } from '@space-game/common';
import { nestPosition, pocketsFrom } from '@space-game/common';
import { drawStructure } from '../mapStructures';
import { settings } from '../../settings/Settings';
import { boundKeyName } from '../../input/keybindings';
import type { MapHost, MapScene } from './host';
import { JUMP, LODE_COLOR, LODE_DEAD, FACTIONS, REGION_STYLE, PLANET_COLORS, hash, niceStep, fmtDist } from './mapConsts';

export function drawRings(_host: MapHost, sc: MapScene): void {
  const { ctx, cam, S, w, h, ox, oy } = sc;
  // Distance rings from the central body
  const step = niceStep(160 / S);
  const far = Math.hypot(Math.max(Math.abs(cam.x - w / 2 / S), Math.abs(cam.x + w / 2 / S)), Math.max(Math.abs(cam.y - h / 2 / S), Math.abs(cam.y + h / 2 / S)));
  ctx.lineWidth = 1;
  ctx.font = '10px "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  for (let r = step; r < far && r / step < 200; r += step) {
    ctx.strokeStyle = 'rgba(90, 120, 180, 0.12)';
    ctx.beginPath(); ctx.arc(ox, oy, r * S, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(120, 150, 200, 0.4)';
    ctx.fillText(fmtDist(r), ox + r * S + 3, oy - 3);
  }
}

export function drawRegions(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, S, ox, oy, sys } = sc;
  // Danger bands: a faint wash per band, its edge a ring, name and danger under it
  const mdx = host.mouse.x - ox, mdy = host.mouse.y - oy, md = Math.hypot(mdx, mdy) || 1;
  (sys?.regions ?? []).forEach((g, i, list) => {
    const st = REGION_STYLE[g.danger] ?? REGION_STYLE.contested;
    const inner = i > 0 ? list[i - 1].outer : 0;
    ctx.save();
    ctx.globalAlpha = g.danger === 'safe' ? 0.025 : 0.035;
    ctx.fillStyle = st.color;
    ctx.beginPath();
    ctx.arc(ox, oy, g.outer * S, 0, Math.PI * 2);
    if (inner > 0) ctx.arc(ox, oy, inner * S, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(ox, oy, g.outer * S, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    const ly = oy + g.outer * S + 14;
    host.label(ctx, `${g.name.toUpperCase()} · ${st.word.toUpperCase()}`, ox, ly, st.color, 3, oy + g.outer * S);
    host.hits.push({ kind: 'region', region: g, inner, sx: ox, sy: ly - 4 });
    // Hovering its edge anywhere round
    if (Math.abs(md - g.outer * S) < 8) host.hits.push({ kind: 'region', region: g, inner, sx: ox + (mdx / md) * g.outer * S, sy: oy + (mdy / md) * g.outer * S });
  });
}

export function drawBelts(host: MapHost, sc: MapScene): void {
  const { ctx, S, w, h, ox, oy, sys } = sc;
  // Asteroid belts: a faint band with scattered rocks (the extra belts sparser)
  const belt = host.belt ?? (sys?.asteroidBelt ? { inner: sys.asteroidBelt.innerRadius, outer: sys.asteroidBelt.outerRadius } : null);
  const belts = [
    ...(belt ? [{ ...belt, dots: 450, alpha: 0.045 }] : []),
    ...(sys?.asteroidBelt?.extra ?? []).map((b) => ({ inner: b.innerRadius, outer: b.outerRadius, dots: Math.max(60, Math.round(b.count * 1.2)), alpha: 0.025 })),
  ];
  belts.forEach((b, k) => {
    ctx.fillStyle = `rgba(160, 150, 135, ${b.alpha})`;
    ctx.beginPath();
    ctx.arc(ox, oy, b.outer * S, 0, Math.PI * 2);
    ctx.arc(ox, oy, b.inner * S, 0, Math.PI * 2, true);
    ctx.fill();
    // (positions worked out once per system; all of a belt's rocks in one fill)
    const dots = host.beltDotsFor(`${host.state.systemId}:${k}:${b.inner}:${b.outer}`, hash(host.state.systemId) + k, b.inner, b.outer, b.dots);
    ctx.fillStyle = 'rgba(190, 180, 165, 0.45)';
    ctx.beginPath();
    for (let i = 0; i < dots.length; i += 3) {
      const px = ox + dots[i] * S, py = oy + dots[i + 1] * S;
      if (px < -5 || py < -5 || px > w + 5 || py > h + 5) continue;
      ctx.rect(px, py, dots[i + 2], dots[i + 2]);
    }
    ctx.fill();
  });
}

export function drawGravity(host: MapHost, sc: MapScene): void {
  const { ctx, S, ox, oy, sys } = sc;
  // Gravity: the horizon, and where the pull out-muscles a starter ship
  const grav = (sys?.centralBody as any)?.gravity as { strength: number; horizon?: number } | undefined;
  if (grav) {
    const noReturn = Math.sqrt(grav.strength / 0.167);
    ctx.setLineDash([5, 6]);
    ctx.strokeStyle = 'rgba(255, 150, 60, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(ox, oy, noReturn * S, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    host.label(ctx, 'pull exceeds starter thrust', ox, oy - noReturn * S - 6, 'rgba(255, 170, 90, 0.85)', 2, oy - noReturn * S);
    if (grav.horizon) {
      ctx.strokeStyle = 'rgba(255, 70, 70, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(ox, oy, grav.horizon * S, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

export function drawChargingRing(host: MapHost, sc: MapScene): void {
  const { ctx, S, ox, oy, sys, cb } = sc;
  // A star's charging ring: jump drives recharge faster and reach further inside it
  if (cb.type !== 'black_hole' && cb.type !== 'none') {
    const ring = solarRingRadius(cb.radius ?? sys?.starRadius ?? 1000) * S;
    ctx.save();
    ctx.strokeStyle = 'rgba(252, 211, 77, 0.45)';
    ctx.setLineDash([3, 7]);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(ox, oy, ring, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(252, 211, 77, 0.035)';
    ctx.beginPath(); ctx.arc(ox, oy, ring, 0, Math.PI * 2); ctx.fill();
    if (ring > 40) {
      host.label(ctx, '☀ JUMP CHARGING RING', ox, oy - ring - 6, 'rgba(252, 211, 77, 0.85)', 2, oy - ring);
    }
    ctx.restore();
  }
}

export function drawCentral(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, S, time, ox, oy, sys, cb } = sc;
  // Central body (true size when zoomed in, a glyph when far out)
  const bodyR = Math.max(9, (cb.radius ?? sys?.starRadius ?? 1000) * S);
  if (sys?.surface) {
    // A planet's surface: the edge of the map (climb past it to orbit) and its city
    const s = sys.surface;
    ctx.save();
    ctx.strokeStyle = 'rgba(232, 244, 255, 0.45)';
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ox, oy, s.radius * S, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    host.label(ctx, 'Edge of the atmosphere: fly out to return to orbit', ox, oy - s.radius * S - 14, '#cfe6ff', 2);
    if (s.city) {
      const cx = sx(s.city.x), cy = sy(s.city.y);
      ctx.fillStyle = 'rgba(141, 147, 155, 0.35)';
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(6, s.city.radius * S), 0, Math.PI * 2); ctx.fill();
      for (const p of s.city.pylons) {
        ctx.fillStyle = '#7dd3fc';
        ctx.beginPath(); ctx.arc(sx(s.city.x + p.x), sy(s.city.y + p.y), 4, 0, Math.PI * 2); ctx.fill();
      }
      host.label(ctx, s.city.name, cx, cy + Math.max(6, s.city.radius * S) + 14, '#e6edf6', 8);
    }
  } else if (sys?.pocket) {
    // A pocket: the edge of the map (fly past it to leave)
    ctx.save();
    ctx.strokeStyle = 'rgba(232, 244, 255, 0.45)';
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ox, oy, sys.pocket.radius * S, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    host.label(ctx, `Edge of ${sys.pocket.entrance.name}: fly out to leave`, ox, oy - sys.pocket.radius * S - 14, '#cfe6ff', 2);
  } else if (cb.type !== 'none') {
    // (A system with no central body, the training yard, has nothing at the middle)
    host.drawBodyGlyph(ctx, cb, sys?.starColor, ox, oy, bodyR, time);
  }
}

export function drawZones(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, S, ox, oy, sys } = sc;
  // Named rings (the Drift): a faint band, edges dashed, the name along the top.
  // A zone with a spot of its own (the Graveyard) is a disc there instead.
  for (const z of sys?.zones ?? []) {
    const col = z.color ?? '#c9a46a';
    const spot = z.x !== undefined && z.y !== undefined;
    const zx = spot ? sx(z.x!) : ox, zy = spot ? sy(z.y!) : oy;
    ctx.save();
    ctx.globalAlpha = spot ? 0.1 : 0.07;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(zx, zy, z.outer * S, 0, Math.PI * 2);
    if (z.inner > 0) ctx.arc(zx, zy, z.inner * S, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.globalAlpha = spot ? 0.55 : 0.35;
    ctx.strokeStyle = col;
    ctx.setLineDash([6, 8]);
    for (const r of [z.inner, z.outer]) if (r > 0) { ctx.beginPath(); ctx.arc(zx, zy, Math.max(spot ? 4 : 0, r * S), 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
    if (spot) {
      const ly = zy - Math.max(4, z.outer * S) - 6;
      host.label(ctx, z.name, zx, ly, col, 4, zy);
      host.hits.push({ kind: 'zone', zone: z, sx: zx, sy: zy });
    } else {
      const mid = ((z.inner + z.outer) / 2) * S;
      host.label(ctx, z.name, ox, oy - mid, col, 3);
      host.hits.push({ kind: 'zone', zone: z, sx: ox, sy: oy - mid - 4 });
    }
  }
}

export function drawPlanets(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, S, ox, oy, sys } = sc;
  // Planets on their orbits (with rings and moons at true size when zoomed in)
  for (const pl of sys?.planets ?? []) {
    const pos = planetPosition(pl, host.state.getRawServerTick());
    ctx.strokeStyle = 'rgba(200, 210, 225, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ox, oy, pl.orbit.radius * S, 0, Math.PI * 2); ctx.stroke();
    const x = sx(pos.x), y = sy(pos.y);
    const pr = Math.max(4, pl.radius * S);
    const col = PLANET_COLORS[pl.kind] ?? '#cccccc';
    if (pl.rings) {
      ctx.strokeStyle = 'rgba(220, 205, 170, 0.35)';
      ctx.lineWidth = Math.max(1, (pl.rings.outer - pl.rings.inner) * pl.radius * S * 0.6);
      ctx.beginPath(); ctx.arc(x, y, Math.max(pr + 3, ((pl.rings.inner + pl.rings.outer) / 2) * pl.radius * S), 0, Math.PI * 2); ctx.stroke();
    }
    // Lit towards the centre: a two-tone disc
    const d = Math.hypot(pos.x, pos.y) || 1;
    const g = ctx.createRadialGradient(x - (pos.x / d) * pr * 0.5, y - (pos.y / d) * pr * 0.5, pr * 0.1, x, y, pr);
    g.addColorStop(0, col);
    g.addColorStop(1, 'rgba(10, 14, 24, 1)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, pr, 0, Math.PI * 2); ctx.fill();
    (pl.moons ?? []).forEach((m, i) => {
      const o = moonOffset(pl, i, host.state.getRawServerTick());
      const mx = sx(pos.x + o.x), my = sy(pos.y + o.y);
      ctx.fillStyle = m.surface ? 'rgba(253, 230, 138, 0.9)' : 'rgba(200, 200, 210, 0.7)';
      ctx.beginPath(); ctx.arc(mx, my, Math.max(m.surface ? 3 : 1.5, m.radius * S), 0, Math.PI * 2); ctx.fill();
      // Siege moons: named, with what their nights rate
      if (!m.surface) return;
      ctx.strokeStyle = 'rgba(253, 230, 138, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(mx, my, Math.max(6, m.radius * S + 3), 0, Math.PI * 2); ctx.stroke();
      const threat = host.state.threats[m.surface];
      host.label(ctx, `${m.name ?? 'Moon'} · siege${threat ? ` ◆${threat}` : ''}`, mx, my - 10, '#fde68a', 4, my);
      host.hits.push({ kind: 'moon', name: m.name ?? 'Moon', surface: m.surface, planet: pl, radius: m.radius, x: pos.x + o.x, y: pos.y + o.y, sx: mx, sy: my });
    });
    host.label(ctx, pl.name, x, y + pr + 14, '#c8d2e0', 5, y);
    host.hits.push({ kind: 'planet', planet: pl, x: pos.x, y: pos.y, sx: x, sy: y });
  }
}

export function drawStructures(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, S, ox, oy, sys } = sc;
  // Built structures (a ring about the star)
  for (const st of sys?.structures ?? []) {
    drawStructure(ctx, st, ox, oy, S, host.state.getRawServerTick());
    const lx = ox, ly = oy - st.radius * S;
    host.label(ctx, st.name, lx, ly - 10, '#f0d99a', 3, ly);
    host.hits.push({ kind: 'structure', structure: st, x: 0, y: -st.radius, sx: lx, sy: ly });
  }
}

export function drawLodestones(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, S, sys } = sc;
  // Stillstones: the stone and its charging field (to scale; none round a dead or shattered one), a glyph and the name
  for (const l of sys?.lodestones ?? []) {
    const pos = lodestonePosition(l, host.state.getRawServerTick());
    const live = lodestoneLive(l), col = live ? LODE_COLOR : LODE_DEAD;
    const x = sx(pos.x), y = sy(pos.y), fr = lodestoneFieldRadius(l, JUMP) * S, br = lodestoneSize(l, JUMP) * S;
    ctx.save();
    if (fr > 3) {
      ctx.fillStyle = l.state === 'scarred' ? 'rgba(163, 194, 207, 0.05)' : 'rgba(163, 194, 207, 0.08)';
      ctx.beginPath(); ctx.arc(x, y, fr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(163, 194, 207, 0.6)';
      ctx.setLineDash(l.state === 'scarred' ? [2, 6] : [3, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, fr, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    // The stone itself, once it's bigger than the glyph (a shattered one: a scatter of pieces)
    if (br > 7) {
      ctx.fillStyle = live ? 'rgba(120, 128, 138, 0.55)' : 'rgba(80, 84, 92, 0.5)';
      if (l.state === 'shattered') {
        for (let k = 0; k < 9; k++) { const a = k * 2.4, d = br * (0.45 + 0.4 * ((k * 7) % 5) / 5); ctx.beginPath(); ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.max(1, br * 0.1), 0, Math.PI * 2); ctx.fill(); }
      } else { ctx.beginPath(); ctx.arc(x, y, br, 0, Math.PI * 2); ctx.fill(); }
    }
    // A diamond in a ring
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(x, y - 3.5); ctx.lineTo(x + 3.5, y); ctx.lineTo(x, y + 3.5); ctx.lineTo(x - 3.5, y); ctx.closePath(); ctx.fill();
    ctx.restore();
    host.label(ctx, lodestoneLabel(l, JUMP), x, y - Math.max(8, fr, br) - 6, col, 4, y);
    host.hits.push({ kind: 'lodestone', lodestone: l, x: pos.x, y: pos.y, sx: x, sy: y });
  }
}

export function drawPocketWays(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, S } = sc;
  // Ways into pockets (a boss's nest): a ring round a dark mouth, and how to go in
  for (const pk of pocketsFrom([...host.byId.values()], host.state.systemId)) {
    const e = pk.pocket!.entrance, x = sx(e.x), y = sy(e.y), col = FACTIONS[e.look?.faction ?? '']?.color ?? '#fbbf24';
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, Math.max(8, e.radius * S), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(10, 10, 14, 0.85)';
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    host.label(ctx, `Way into ${e.name} (${boundKeyName('interact', settings.data.bindings)})`, x, y - Math.max(8, e.radius * S) - 8, col, 6, y);
    host.hits.push({ kind: 'wayin', pocket: pk, x: e.x, y: e.y, sx: x, sy: y });
  }
}

export function drawNests(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, sys } = sc;
  // Hostile nests: a triangle in a ring in their faction's colour, and the name (not a den's hidden posts)
  for (const n of sys?.nests ?? []) {
    if (n.hidden) continue;
    const pos = nestPosition(n, sys?.planets, host.state.getRawServerTick());
    const x = sx(pos.x), y = sy(pos.y), col = FACTIONS[n.faction]?.color ?? '#f87171';
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 3.6, y + 2.6); ctx.lineTo(x - 3.6, y + 2.6); ctx.closePath(); ctx.fill();
    ctx.restore();
    host.label(ctx, n.name, x, y - 12, col, 4, y);
    host.hits.push({ kind: 'nest', nest: n, x: pos.x, y: pos.y, sx: x, sy: y });
  }
}

export function drawComets(host: MapHost, sc: MapScene): void {
  const { ctx, sx, sy, S, ox, oy, sys } = sc;
  // Comets: the orbit ellipse, the comet and a stub of tail pointing away from the star
  for (const c of sys?.comets ?? []) {
    const { a, e, argP } = c.orbit;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.rotate(argP);
    ctx.strokeStyle = 'rgba(191, 230, 255, 0.18)';
    ctx.setLineDash([2, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(-a * e * S, 0, a * S, a * Math.sqrt(1 - e * e) * S, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    const pos = cometPosition(c, host.state.getRawServerTick());
    const x = sx(pos.x), y = sy(pos.y);
    const d = Math.hypot(pos.x, pos.y) || 1;
    const tail = 14 + 40 * Math.min(1, 9000 / d);
    const grad = ctx.createLinearGradient(x, y, x + (pos.x / d) * tail, y + (pos.y / d) * tail);
    grad.addColorStop(0, 'rgba(191, 230, 255, 0.9)');
    grad.addColorStop(1, 'rgba(191, 230, 255, 0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (pos.x / d) * tail, y + (pos.y / d) * tail); ctx.stroke();
    ctx.fillStyle = '#e8f6ff';
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    host.label(ctx, c.name, x, y - 10, '#cfeaff', 3, y);
    host.hits.push({ kind: 'comet', comet: c, x: pos.x, y: pos.y, sx: x, sy: y });
  }
}
